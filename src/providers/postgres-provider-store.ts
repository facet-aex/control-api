import { and, eq, gt, isNull, sql } from "drizzle-orm";

import type { AuthenticatedIdentity } from "../auth/types.js";
import type { Database } from "../db/client.js";
import {
  auditEvents,
  outboxEvents,
  providerMemberships,
  providers,
  users,
  walletLinkChallenges,
} from "../db/schema.js";
import { AppError } from "../errors.js";
import type {
  ProviderMembershipRecord,
  ProviderRecord,
  ProviderRole,
  ProviderStore,
  UserRecord,
  WalletLinkChallenge,
} from "./provider-types.js";
import { requireProviderPermission } from "./provider-rbac.js";

function requiredRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Database did not return ${context}`);
  return row;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export class PostgresProviderStore implements ProviderStore {
  constructor(private readonly database: Database["db"]) {}

  async upsertUser(identity: AuthenticatedIdentity): Promise<UserRecord> {
    const rows = await this.database
      .insert(users)
      .values({
        externalSubject: identity.subject,
        email: identity.email ?? null,
        displayName: identity.displayName ?? null,
      })
      .onConflictDoUpdate({
        target: users.externalSubject,
        set: {
          email: identity.email ?? sql`${users.email}`,
          displayName: identity.displayName ?? sql`${users.displayName}`,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: users.id,
        externalSubject: users.externalSubject,
        email: users.email,
        displayName: users.displayName,
        status: users.status,
      });

    const user = requiredRow(rows, "an upserted user");
    if (user.status === "disabled") {
      throw new AppError(
        "AUTHORIZATION_DENIED",
        "This FACET user is disabled.",
        403,
      );
    }
    return user;
  }

  async createProvider(
    input: Parameters<ProviderStore["createProvider"]>[0],
  ): Promise<ProviderRecord> {
    try {
      return await this.database.transaction(async (transaction) => {
        const provider = requiredRow(
          await transaction
            .insert(providers)
            .values({
              slug: input.provider.slug,
              name: input.provider.name,
              description: input.provider.description,
              websiteUrl: input.provider.websiteUrl ?? null,
              contact: input.provider.contact ?? null,
              walletAddress: input.provider.walletAddress ?? null,
            })
            .returning(),
          "a created provider",
        );

        await transaction.insert(providerMemberships).values({
          providerId: provider.id,
          userId: input.actorUserId,
          role: "owner",
        });
        await transaction.insert(auditEvents).values({
          actorUserId: input.actorUserId,
          providerId: provider.id,
          eventType: "provider.created",
          subjectType: "provider",
          subjectId: provider.id,
          requestId: input.requestId,
          metadata: { initialRole: "owner" },
        });
        await transaction.insert(outboxEvents).values({
          topic: "provider.events",
          aggregateType: "provider",
          aggregateId: provider.id,
          eventType: "provider.created",
          payload: { providerId: provider.id, version: provider.version },
        });

        return provider;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(
          "RESOURCE_CONFLICT",
          "A provider with this slug already exists.",
          409,
        );
      }
      throw error;
    }
  }

  async getProvider(providerId: string): Promise<ProviderRecord | undefined> {
    const rows = await this.database
      .select()
      .from(providers)
      .where(eq(providers.id, providerId))
      .limit(1);
    return rows[0];
  }

  async createWalletLinkChallenge(
    input: Omit<WalletLinkChallenge, "consumedAt">,
  ): Promise<void> {
    await this.database.insert(walletLinkChallenges).values({
      id: input.id,
      providerId: input.providerId,
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
  ): Promise<ProviderRecord | undefined> {
    return this.database.transaction(async (transaction) => {
      const membership = (
        await transaction
          .select({ role: providerMemberships.role })
          .from(providerMemberships)
          .where(
            and(
              eq(providerMemberships.providerId, input.providerId),
              eq(providerMemberships.userId, input.userId),
            ),
          )
          .for("update")
      )[0];
      if (membership?.role !== "owner") {
        throw new AppError(
          "AUTHORIZATION_DENIED",
          "Only a provider owner may link its payout wallet.",
          403,
        );
      }
      const consumed = await transaction
        .update(walletLinkChallenges)
        .set({ consumedAt: input.now })
        .where(
          and(
            eq(walletLinkChallenges.id, input.challengeId),
            eq(walletLinkChallenges.providerId, input.providerId),
            eq(walletLinkChallenges.userId, input.userId),
            isNull(walletLinkChallenges.consumedAt),
            gt(walletLinkChallenges.expiresAt, input.now),
          ),
        )
        .returning({ id: walletLinkChallenges.id });
      if (consumed.length !== 1) return undefined;

      const provider = (
        await transaction
          .update(providers)
          .set({
            walletAddress: input.walletAddress,
            walletVerifiedAt: input.now,
            version: sql`${providers.version} + 1`,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(providers.id, input.providerId),
              eq(providers.status, "active"),
            ),
          )
          .returning()
      )[0];
      if (!provider) {
        throw new AppError("RESOURCE_NOT_FOUND", "Provider not found.", 404);
      }
      await transaction.insert(auditEvents).values({
        actorUserId: input.userId,
        providerId: input.providerId,
        eventType: "provider.wallet.linked",
        subjectType: "provider",
        subjectId: input.providerId,
        requestId: input.requestId,
        metadata: { walletAddress: input.walletAddress },
      });
      return provider;
    });
  }

  async getMembershipRole(
    providerId: string,
    userId: string,
  ): Promise<ProviderRole | undefined> {
    const rows = await this.database
      .select({ role: providerMemberships.role })
      .from(providerMemberships)
      .where(
        and(
          eq(providerMemberships.providerId, providerId),
          eq(providerMemberships.userId, userId),
        ),
      )
      .limit(1);
    return rows[0]?.role;
  }

  async listMemberships(
    providerId: string,
  ): Promise<ProviderMembershipRecord[]> {
    return this.database
      .select({
        user: {
          id: users.id,
          email: users.email,
          displayName: users.displayName,
        },
        role: providerMemberships.role,
        createdAt: providerMemberships.createdAt,
        updatedAt: providerMemberships.updatedAt,
      })
      .from(providerMemberships)
      .innerJoin(users, eq(users.id, providerMemberships.userId))
      .where(eq(providerMemberships.providerId, providerId))
      .orderBy(providerMemberships.createdAt, providerMemberships.userId);
  }

  async setMembership(
    input: Parameters<ProviderStore["setMembership"]>[0],
  ): Promise<ProviderMembershipRecord> {
    return this.database.transaction(async (transaction) => {
      const provider = (
        await transaction
          .select({ id: providers.id })
          .from(providers)
          .where(eq(providers.id, input.providerId))
          .for("update")
      )[0];
      if (!provider) {
        throw new AppError("RESOURCE_NOT_FOUND", "Provider not found.", 404);
      }

      const actorRole = (
        await transaction
          .select({ role: providerMemberships.role })
          .from(providerMemberships)
          .where(
            and(
              eq(providerMemberships.providerId, input.providerId),
              eq(providerMemberships.userId, input.actorUserId),
            ),
          )
          .limit(1)
      )[0]?.role;
      requireProviderPermission(actorRole, "membership:manage");

      const targetUser = (
        await transaction
          .select({
            id: users.id,
            email: users.email,
            displayName: users.displayName,
          })
          .from(users)
          .where(eq(users.id, input.targetUserId))
          .limit(1)
      )[0];
      if (!targetUser) {
        throw new AppError("RESOURCE_NOT_FOUND", "User not found.", 404);
      }

      const existing = (
        await transaction
          .select({
            role: providerMemberships.role,
            createdAt: providerMemberships.createdAt,
            updatedAt: providerMemberships.updatedAt,
          })
          .from(providerMemberships)
          .where(
            and(
              eq(providerMemberships.providerId, input.providerId),
              eq(providerMemberships.userId, input.targetUserId),
            ),
          )
          .limit(1)
      )[0];

      if (
        actorRole !== "owner" &&
        (input.role === "owner" || existing?.role === "owner")
      ) {
        throw new AppError(
          "AUTHORIZATION_DENIED",
          "Only an owner can add or change an owner membership.",
          403,
        );
      }

      if (existing?.role === input.role) {
        return { user: targetUser, ...existing };
      }

      if (existing?.role === "owner" && input.role !== "owner") {
        const owners = await transaction
          .select({ userId: providerMemberships.userId })
          .from(providerMemberships)
          .where(
            and(
              eq(providerMemberships.providerId, input.providerId),
              eq(providerMemberships.role, "owner"),
            ),
          );
        if (owners.length === 1) {
          throw new AppError(
            "FINAL_OWNER_REQUIRED",
            "A provider must retain at least one owner.",
            409,
          );
        }
      }

      const now = new Date();
      const membership = requiredRow(
        await transaction
          .insert(providerMemberships)
          .values({
            providerId: input.providerId,
            userId: input.targetUserId,
            role: input.role,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              providerMemberships.providerId,
              providerMemberships.userId,
            ],
            set: { role: input.role, updatedAt: now },
          })
          .returning({
            role: providerMemberships.role,
            createdAt: providerMemberships.createdAt,
            updatedAt: providerMemberships.updatedAt,
          }),
        "an updated provider membership",
      );

      const eventType = existing
        ? "provider.membership.role_changed"
        : "provider.membership.created";
      await transaction.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        providerId: input.providerId,
        eventType,
        subjectType: "provider_membership",
        subjectId: input.targetUserId,
        requestId: input.requestId,
        metadata: {
          targetUserId: input.targetUserId,
          previousRole: existing?.role ?? null,
          role: input.role,
        },
      });
      await transaction.insert(outboxEvents).values({
        topic: "provider.events",
        aggregateType: "provider",
        aggregateId: input.providerId,
        eventType,
        payload: {
          providerId: input.providerId,
          targetUserId: input.targetUserId,
          previousRole: existing?.role ?? null,
          role: input.role,
        },
      });

      return { user: targetUser, ...membership };
    });
  }

  async removeMembership(
    input: Parameters<ProviderStore["removeMembership"]>[0],
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const provider = (
        await transaction
          .select({ id: providers.id })
          .from(providers)
          .where(eq(providers.id, input.providerId))
          .for("update")
      )[0];
      if (!provider) {
        throw new AppError("RESOURCE_NOT_FOUND", "Provider not found.", 404);
      }

      const membershipRows = await transaction
        .select({
          userId: providerMemberships.userId,
          role: providerMemberships.role,
        })
        .from(providerMemberships)
        .where(eq(providerMemberships.providerId, input.providerId));
      const actorRole = membershipRows.find(
        (membership) => membership.userId === input.actorUserId,
      )?.role;
      requireProviderPermission(actorRole, "membership:manage");

      const target = membershipRows.find(
        (membership) => membership.userId === input.targetUserId,
      );
      if (!target) {
        throw new AppError("RESOURCE_NOT_FOUND", "Membership not found.", 404);
      }
      if (actorRole !== "owner" && target.role === "owner") {
        throw new AppError(
          "AUTHORIZATION_DENIED",
          "Only an owner can remove an owner membership.",
          403,
        );
      }
      if (
        target.role === "owner" &&
        membershipRows.filter((membership) => membership.role === "owner")
          .length === 1
      ) {
        throw new AppError(
          "FINAL_OWNER_REQUIRED",
          "A provider must retain at least one owner.",
          409,
        );
      }

      await transaction
        .delete(providerMemberships)
        .where(
          and(
            eq(providerMemberships.providerId, input.providerId),
            eq(providerMemberships.userId, input.targetUserId),
          ),
        );
      await transaction.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        providerId: input.providerId,
        eventType: "provider.membership.removed",
        subjectType: "provider_membership",
        subjectId: input.targetUserId,
        requestId: input.requestId,
        metadata: {
          targetUserId: input.targetUserId,
          previousRole: target.role,
        },
      });
      await transaction.insert(outboxEvents).values({
        topic: "provider.events",
        aggregateType: "provider",
        aggregateId: input.providerId,
        eventType: "provider.membership.removed",
        payload: {
          providerId: input.providerId,
          targetUserId: input.targetUserId,
          previousRole: target.role,
        },
      });
    });
  }

  async listProvidersForUser(
    userId: string,
  ): Promise<Array<{ provider: ProviderRecord; role: ProviderRole }>> {
    return this.database
      .select({ provider: providers, role: providerMemberships.role })
      .from(providerMemberships)
      .innerJoin(providers, eq(providers.id, providerMemberships.providerId))
      .where(eq(providerMemberships.userId, userId))
      .orderBy(providers.name, providers.id);
  }

  async updateProvider(
    input: Parameters<ProviderStore["updateProvider"]>[0],
  ): Promise<ProviderRecord | undefined> {
    const changes: Partial<typeof providers.$inferInsert> = {
      updatedAt: new Date(),
      version: input.expectedVersion + 1,
    };
    if (input.patch.name !== undefined) changes.name = input.patch.name;
    if (input.patch.description !== undefined)
      changes.description = input.patch.description;
    if (input.patch.websiteUrl !== undefined)
      changes.websiteUrl = input.patch.websiteUrl;
    if (input.patch.contact !== undefined)
      changes.contact = input.patch.contact;
    if (input.patch.walletAddress !== undefined)
      changes.walletAddress = input.patch.walletAddress;
    if (input.patch.walletAddress !== undefined)
      changes.walletVerifiedAt = null;

    return this.database.transaction(async (transaction) => {
      const updated = (
        await transaction
          .update(providers)
          .set(changes)
          .where(
            and(
              eq(providers.id, input.providerId),
              eq(providers.version, input.expectedVersion),
            ),
          )
          .returning()
      )[0];
      if (!updated) return undefined;

      const changedFields = Object.keys(input.patch).filter(
        (field) => input.patch[field as keyof typeof input.patch] !== undefined,
      );
      await transaction.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        providerId: updated.id,
        eventType: "provider.updated",
        subjectType: "provider",
        subjectId: updated.id,
        requestId: input.requestId,
        metadata: { changedFields, version: updated.version },
      });
      await transaction.insert(outboxEvents).values({
        topic: "provider.events",
        aggregateType: "provider",
        aggregateId: updated.id,
        eventType: "provider.updated",
        payload: {
          providerId: updated.id,
          version: updated.version,
          changedFields,
        },
      });

      return updated;
    });
  }
}
