import { and, eq, gt, isNull } from "drizzle-orm";

import type { AuthenticatedIdentity } from "../auth/types.js";
import type { Database } from "../db/client.js";
import { auditEvents, users, walletLinkChallenges } from "../db/schema.js";
import { AppError } from "../errors.js";
import { isValidUsername } from "../identifiers.js";
import type {
  ClerkWebhookUserEvent,
  ProviderStore,
  UserRecord,
  WalletLinkChallenge,
} from "./provider-types.js";

function requiredRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Database did not return ${context}`);
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && (error as { code?: unknown }).code === "23505") {
    return true;
  }
  return (
    "cause" in error && isUniqueViolation((error as { cause?: unknown }).cause)
  );
}

export class PostgresProviderStore implements ProviderStore {
  constructor(private readonly database: Database["db"]) {}

  async findUserByClerkId(clerkId: string): Promise<UserRecord | undefined> {
    const rows = await this.database
      .select()
      .from(users)
      .where(eq(users.clerkId, clerkId))
      .limit(1);
    return rows[0];
  }

  async findUserByUsername(username: string): Promise<UserRecord | undefined> {
    const rows = await this.database
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    return rows[0];
  }

  async upsertUser(identity: AuthenticatedIdentity): Promise<UserRecord> {
    const existing = await this.findUserByClerkId(identity.subject);
    if (existing) {
      if (existing.status === "disabled") {
        throw new AppError(
          "AUTHORIZATION_DENIED",
          "This FACET user is disabled.",
          403,
        );
      }
      if (identity.username && identity.username !== existing.username) {
        if (!isValidUsername(identity.username)) {
          throw new AppError(
            "USERNAME_REQUIRED",
            "Set an 8-16 character lowercase kebab-case username.",
            409,
          );
        }
        try {
          const updated = requiredRow(
            await this.database
              .update(users)
              .set({ username: identity.username, updatedAt: new Date() })
              .where(eq(users.id, existing.id))
              .returning(),
            "an updated user",
          );
          return updated;
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new AppError(
              "RESOURCE_CONFLICT",
              "A user with this username already exists.",
              409,
            );
          }
          throw error;
        }
      }
      return existing;
    }

    if (!identity.username || !isValidUsername(identity.username)) {
      throw new AppError(
        "USERNAME_REQUIRED",
        "Set an 8-16 character lowercase kebab-case username.",
        409,
      );
    }

    try {
      const user = requiredRow(
        await this.database
          .insert(users)
          .values({
            clerkId: identity.subject,
            username: identity.username,
          })
          .onConflictDoUpdate({
            target: users.clerkId,
            set: {
              username: identity.username,
              updatedAt: new Date(),
            },
          })
          .returning(),
        "an upserted user",
      );
      if (user.status === "disabled") {
        throw new AppError(
          "AUTHORIZATION_DENIED",
          "This FACET user is disabled.",
          403,
        );
      }
      return user;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(
          "RESOURCE_CONFLICT",
          "A user with this username already exists.",
          409,
        );
      }
      throw error;
    }
  }

  async applyClerkWebhook(
    event: ClerkWebhookUserEvent,
    requestId = "webhook:clerk",
  ): Promise<void> {
    if (event.type === "user.deleted") {
      await this.database.transaction(async (transaction) => {
        const updated = await transaction
          .update(users)
          .set({ status: "disabled", updatedAt: new Date() })
          .where(eq(users.clerkId, event.data.id))
          .returning({ id: users.id });
        const user = updated[0];
        if (!user) return;
        await transaction.insert(auditEvents).values({
          actorUserId: user.id,
          providerId: user.id,
          eventType: "user.webhook.deleted",
          subjectType: "user",
          subjectId: user.id,
          requestId,
          metadata: { clerkId: event.data.id },
        });
      });
      return;
    }

    const username = event.data.username;
    if (!isValidUsername(username)) {
      throw new AppError(
        "INVALID_USERNAME",
        "Clerk webhook user must have an 8-16 character lowercase hyphenated kebab-case username.",
        422,
      );
    }

    try {
      await this.database.transaction(async (transaction) => {
        const now = new Date();
        const user = requiredRow(
          await transaction
            .insert(users)
            .values({
              clerkId: event.data.id,
              username,
              status: "active",
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: users.clerkId,
              set: {
                username,
                status: "active",
                updatedAt: now,
              },
            })
            .returning(),
          "a webhook-synced user",
        );

        await transaction.insert(auditEvents).values({
          actorUserId: user.id,
          providerId: user.id,
          eventType:
            event.type === "user.created"
              ? "user.webhook.created"
              : "user.webhook.updated",
          subjectType: "user",
          subjectId: user.id,
          requestId,
          metadata: { clerkId: event.data.id, username },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(
          "RESOURCE_CONFLICT",
          "A user with this username already exists.",
          409,
        );
      }
      throw error;
    }
  }

  async createWalletLinkChallenge(
    input: Omit<WalletLinkChallenge, "consumedAt">,
  ): Promise<void> {
    await this.database.insert(walletLinkChallenges).values({
      id: input.id,
      userId: input.userId,
      message: input.message,
      nonceHash: input.nonceHash,
      expiresAt: input.expiresAt,
    });
  }

  async getWalletLinkChallenge(
    challengeId: string,
  ): Promise<WalletLinkChallenge | undefined> {
    const rows = await this.database
      .select()
      .from(walletLinkChallenges)
      .where(eq(walletLinkChallenges.id, challengeId))
      .limit(1);
    return rows[0];
  }

  async consumeWalletLinkChallenge(
    input: Parameters<ProviderStore["consumeWalletLinkChallenge"]>[0],
  ): Promise<UserRecord | undefined> {
    return this.database.transaction(async (transaction) => {
      const consumed = await transaction
        .update(walletLinkChallenges)
        .set({ consumedAt: input.now })
        .where(
          and(
            eq(walletLinkChallenges.id, input.challengeId),
            eq(walletLinkChallenges.userId, input.userId),
            isNull(walletLinkChallenges.consumedAt),
            gt(walletLinkChallenges.expiresAt, input.now),
          ),
        )
        .returning({ id: walletLinkChallenges.id });
      if (consumed.length !== 1) return undefined;

      const user = (
        await transaction
          .update(users)
          .set({
            walletAddress: input.walletAddress,
            walletVerifiedAt: input.now,
            updatedAt: input.now,
          })
          .where(and(eq(users.id, input.userId), eq(users.status, "active")))
          .returning()
      )[0];
      if (!user) {
        throw new AppError("RESOURCE_NOT_FOUND", "User not found.", 404);
      }
      await transaction.insert(auditEvents).values({
        actorUserId: input.userId,
        providerId: input.userId,
        eventType: "provider.wallet.linked",
        subjectType: "user",
        subjectId: input.userId,
        requestId: input.requestId,
        metadata: { walletAddress: input.walletAddress },
      });
      return user;
    });
  }
}
