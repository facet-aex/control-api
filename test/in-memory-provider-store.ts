import { randomUUID } from "node:crypto";

import { AppError } from "../src/errors.js";
import type {
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
