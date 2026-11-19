import { randomUUID } from "node:crypto";

import { AppError } from "../src/errors.js";
import { isValidUsername } from "../src/identifiers.js";
import type {
  ClerkWebhookUserEvent,
  ProviderStore,
  UserRecord,
  WalletLinkChallenge,
} from "../src/providers/provider-types.js";

export class InMemoryProviderStore implements ProviderStore {
  readonly auditEvents: Array<{
    eventType: string;
    providerId: string;
    requestId: string;
  }> = [];
  private readonly walletChallenges = new Map<string, WalletLinkChallenge>();
  private readonly usersByClerkId = new Map<string, UserRecord>();
  private readonly usersByUsername = new Map<string, UserRecord>();

  async findUserByClerkId(clerkId: string): Promise<UserRecord | undefined> {
    return this.usersByClerkId.get(clerkId);
  }

  async findUserByUsername(username: string): Promise<UserRecord | undefined> {
    return this.usersByUsername.get(username);
  }

  async upsertUser(
    identity: Parameters<ProviderStore["upsertUser"]>[0],
  ): Promise<UserRecord> {
    const existing = this.usersByClerkId.get(identity.subject);
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
        const conflict = this.usersByUsername.get(identity.username);
        if (conflict && conflict.id !== existing.id) {
          throw new AppError(
            "RESOURCE_CONFLICT",
            "A user with this username already exists.",
            409,
          );
        }
        this.usersByUsername.delete(existing.username);
        existing.username = identity.username;
        existing.updatedAt = new Date();
        this.usersByUsername.set(existing.username, existing);
      }
      if (!existing.walletAddress && identity.walletAddress) {
        const now = new Date();
        existing.walletAddress = identity.walletAddress;
        existing.walletVerifiedAt = now;
        existing.updatedAt = now;
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
    if (this.usersByUsername.has(identity.username)) {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "A user with this username already exists.",
        409,
      );
    }

    const now = new Date("2026-11-09T00:00:00.000Z");
    const user: UserRecord = {
      id: randomUUID(),
      clerkId: identity.subject,
      username: identity.username,
      walletAddress: identity.walletAddress ?? null,
      walletVerifiedAt: identity.walletAddress ? now : null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.usersByClerkId.set(user.clerkId, user);
    this.usersByUsername.set(user.username, user);
    return user;
  }

  async applyClerkWebhook(
    event: ClerkWebhookUserEvent,
    requestId = "webhook:clerk",
  ): Promise<void> {
    if (event.type === "user.deleted") {
      const existing = this.usersByClerkId.get(event.data.id);
      if (!existing) return;
      existing.status = "disabled";
      existing.updatedAt = new Date();
      this.auditEvents.push({
        eventType: "user.webhook.deleted",
        providerId: existing.id,
        requestId,
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
    const existing = this.usersByClerkId.get(event.data.id);
    const conflict = this.usersByUsername.get(username);
    if (conflict && conflict.id !== existing?.id) {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "A user with this username already exists.",
        409,
      );
    }

    const now = new Date();
    if (existing) {
      this.usersByUsername.delete(existing.username);
      existing.username = username;
      existing.status = "active";
      if (!existing.walletAddress && event.data.walletAddress) {
        existing.walletAddress = event.data.walletAddress;
        existing.walletVerifiedAt = now;
      }
      existing.updatedAt = now;
      this.usersByUsername.set(username, existing);
      this.auditEvents.push({
        eventType:
          event.type === "user.created"
            ? "user.webhook.created"
            : "user.webhook.updated",
        providerId: existing.id,
        requestId,
      });
      return;
    }

    const created: UserRecord = {
      id: randomUUID(),
      clerkId: event.data.id,
      username,
      walletAddress: event.data.walletAddress ?? null,
      walletVerifiedAt: event.data.walletAddress ? now : null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.usersByClerkId.set(created.clerkId, created);
    this.usersByUsername.set(created.username, created);
    this.auditEvents.push({
      eventType:
        event.type === "user.created"
          ? "user.webhook.created"
          : "user.webhook.updated",
      providerId: created.id,
      requestId,
    });
  }

  async createWalletLinkChallenge(
    input: Omit<WalletLinkChallenge, "consumedAt">,
  ): Promise<void> {
    this.walletChallenges.set(input.id, { ...input, consumedAt: null });
  }

  async getWalletLinkChallenge(
    challengeId: string,
  ): Promise<WalletLinkChallenge | undefined> {
    return this.walletChallenges.get(challengeId);
  }

  async consumeWalletLinkChallenge(
    input: Parameters<ProviderStore["consumeWalletLinkChallenge"]>[0],
  ): Promise<UserRecord | undefined> {
    const challenge = this.walletChallenges.get(input.challengeId);
    const user = [...this.usersByClerkId.values()].find(
      (candidate) => candidate.id === input.userId,
    );
    if (
      !challenge ||
      !user ||
      user.status !== "active" ||
      challenge.consumedAt ||
      challenge.userId !== input.userId ||
      challenge.expiresAt.getTime() <= input.now.getTime()
    ) {
      return undefined;
    }
    challenge.consumedAt = input.now;
    user.walletAddress = input.walletAddress;
    user.walletVerifiedAt = input.now;
    user.updatedAt = input.now;
    this.auditEvents.push({
      eventType: "provider.wallet.linked",
      providerId: user.id,
      requestId: input.requestId,
    });
    return user;
  }
}
