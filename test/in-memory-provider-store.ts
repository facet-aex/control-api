import { randomUUID } from "node:crypto";

import { AppError } from "../src/errors.js";
import type {
  ProviderMembershipRecord,
  ProviderRecord,
  ProviderRole,
  ProviderStore,
  UserRecord,
} from "../src/providers/provider-types.js";

export class InMemoryProviderStore implements ProviderStore {
  readonly auditEvents: Array<{
    eventType: string;
    providerId: string;
    requestId: string;
  }> = [];
  private readonly memberships = new Map<string, ProviderRole>();
  private readonly providers = new Map<string, ProviderRecord>();
  private readonly users = new Map<string, UserRecord>();
  private readonly usersById = new Map<string, UserRecord>();

  async upsertUser(
    identity: Parameters<ProviderStore["upsertUser"]>[0],
  ): Promise<UserRecord> {
    const existing = this.users.get(identity.subject);
    if (existing) return existing;
    const user: UserRecord = {
      id: randomUUID(),
      externalSubject: identity.subject,
      email: identity.email ?? null,
      displayName: identity.displayName ?? null,
      status: "active",
    };
    this.users.set(identity.subject, user);
    this.usersById.set(user.id, user);
    return user;
  }

  async createProvider(
    input: Parameters<ProviderStore["createProvider"]>[0],
  ): Promise<ProviderRecord> {
    if (
      [...this.providers.values()].some(
        (provider) => provider.slug === input.provider.slug,
      )
    ) {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "A provider with this slug already exists.",
        409,
      );
    }
    const now = new Date("2026-11-09T00:00:00.000Z");
    const provider: ProviderRecord = {
      id: randomUUID(),
      slug: input.provider.slug,
      name: input.provider.name,
      description: input.provider.description,
      websiteUrl: input.provider.websiteUrl ?? null,
      contact: input.provider.contact ?? null,
      walletAddress: input.provider.walletAddress ?? null,
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.providers.set(provider.id, provider);
    this.memberships.set(`${provider.id}:${input.actorUserId}`, "owner");
    this.auditEvents.push({
      eventType: "provider.created",
      providerId: provider.id,
      requestId: input.requestId,
    });
    return provider;
  }

  async getProvider(providerId: string): Promise<ProviderRecord | undefined> {
    return this.providers.get(providerId);
  }

  async getMembershipRole(
    providerId: string,
    userId: string,
  ): Promise<ProviderRole | undefined> {
    return this.memberships.get(`${providerId}:${userId}`);
  }

  async listMemberships(
    providerId: string,
  ): Promise<ProviderMembershipRecord[]> {
    const result: ProviderMembershipRecord[] = [];
    for (const [key, role] of this.memberships) {
      const [membershipProviderId, userId] = key.split(":");
      if (membershipProviderId !== providerId || !userId) continue;
      const user = this.usersById.get(userId);
      if (!user) continue;
      result.push({
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
        },
        role,
        createdAt: new Date("2026-11-09T00:00:00.000Z"),
        updatedAt: new Date("2026-11-09T00:00:00.000Z"),
      });
    }
    return result.sort((left, right) =>
      left.user.id.localeCompare(right.user.id),
    );
  }

  async setMembership(
    input: Parameters<ProviderStore["setMembership"]>[0],
  ): Promise<ProviderMembershipRecord> {
    if (!this.providers.has(input.providerId)) {
      throw new AppError("RESOURCE_NOT_FOUND", "Provider not found.", 404);
    }
    const actorRole = this.memberships.get(
      `${input.providerId}:${input.actorUserId}`,
    );
    if (actorRole !== "owner" && actorRole !== "admin") {
      throw new AppError(
        "AUTHORIZATION_DENIED",
        "The authenticated user is not authorized for this provider.",
        403,
      );
    }
    const targetUser = this.usersById.get(input.targetUserId);
    if (!targetUser) {
      throw new AppError("RESOURCE_NOT_FOUND", "User not found.", 404);
    }
    const key = `${input.providerId}:${input.targetUserId}`;
    const existingRole = this.memberships.get(key);
    if (
      actorRole !== "owner" &&
      (input.role === "owner" || existingRole === "owner")
    ) {
      throw new AppError(
        "AUTHORIZATION_DENIED",
        "Only an owner can add or change an owner membership.",
        403,
      );
    }
    if (existingRole === "owner" && input.role !== "owner") {
      const ownerCount = [...this.memberships.entries()].filter(
        ([membershipKey, role]) =>
          membershipKey.startsWith(`${input.providerId}:`) && role === "owner",
      ).length;
      if (ownerCount === 1) {
        throw new AppError(
          "FINAL_OWNER_REQUIRED",
          "A provider must retain at least one owner.",
          409,
        );
      }
    }
    if (existingRole !== input.role) {
      this.memberships.set(key, input.role);
      this.auditEvents.push({
        eventType: existingRole
          ? "provider.membership.role_changed"
          : "provider.membership.created",
        providerId: input.providerId,
        requestId: input.requestId,
      });
    }
    return {
      user: {
        id: targetUser.id,
        email: targetUser.email,
        displayName: targetUser.displayName,
      },
      role: input.role,
      createdAt: new Date("2026-11-09T00:00:00.000Z"),
      updatedAt: new Date("2026-11-09T00:01:00.000Z"),
    };
  }

  async removeMembership(
    input: Parameters<ProviderStore["removeMembership"]>[0],
  ): Promise<void> {
    if (!this.providers.has(input.providerId)) {
      throw new AppError("RESOURCE_NOT_FOUND", "Provider not found.", 404);
    }
    const actorRole = this.memberships.get(
      `${input.providerId}:${input.actorUserId}`,
    );
    if (actorRole !== "owner" && actorRole !== "admin") {
      throw new AppError(
        "AUTHORIZATION_DENIED",
        "The authenticated user is not authorized for this provider.",
        403,
      );
    }
    const key = `${input.providerId}:${input.targetUserId}`;
    const targetRole = this.memberships.get(key);
    if (!targetRole) {
      throw new AppError("RESOURCE_NOT_FOUND", "Membership not found.", 404);
    }
    if (actorRole !== "owner" && targetRole === "owner") {
      throw new AppError(
        "AUTHORIZATION_DENIED",
        "Only an owner can remove an owner membership.",
        403,
      );
    }
    if (targetRole === "owner") {
      const ownerCount = [...this.memberships.entries()].filter(
        ([membershipKey, role]) =>
          membershipKey.startsWith(`${input.providerId}:`) && role === "owner",
      ).length;
      if (ownerCount === 1) {
        throw new AppError(
          "FINAL_OWNER_REQUIRED",
          "A provider must retain at least one owner.",
          409,
        );
      }
    }
    this.memberships.delete(key);
    this.auditEvents.push({
      eventType: "provider.membership.removed",
      providerId: input.providerId,
      requestId: input.requestId,
    });
  }

  async listProvidersForUser(
    userId: string,
  ): Promise<Array<{ provider: ProviderRecord; role: ProviderRole }>> {
    const result: Array<{ provider: ProviderRecord; role: ProviderRole }> = [];
    for (const provider of this.providers.values()) {
      const role = this.memberships.get(`${provider.id}:${userId}`);
      if (role) result.push({ provider, role });
    }
    return result;
  }

  async updateProvider(
    input: Parameters<ProviderStore["updateProvider"]>[0],
  ): Promise<ProviderRecord | undefined> {
    const provider = this.providers.get(input.providerId);
    if (!provider || provider.version !== input.expectedVersion)
      return undefined;
    const updated: ProviderRecord = {
      ...provider,
      name: input.patch.name ?? provider.name,
      description: input.patch.description ?? provider.description,
      websiteUrl:
        input.patch.websiteUrl === undefined
          ? provider.websiteUrl
          : input.patch.websiteUrl,
      contact:
        input.patch.contact === undefined
          ? provider.contact
          : input.patch.contact,
      walletAddress:
        input.patch.walletAddress === undefined
          ? provider.walletAddress
          : input.patch.walletAddress,
      version: provider.version + 1,
      updatedAt: new Date("2026-11-09T00:01:00.000Z"),
    };
    this.providers.set(provider.id, updated);
    this.auditEvents.push({
      eventType: "provider.updated",
      providerId: provider.id,
      requestId: input.requestId,
    });
    return updated;
  }
}
