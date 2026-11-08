import { and, eq, sql } from "drizzle-orm";

import type { AuthenticatedIdentity } from "../auth/types.js";
import type { Database } from "../db/client.js";
import {
  auditEvents,
  outboxEvents,
  providerMemberships,
  providers,
  users,
} from "../db/schema.js";
import { AppError } from "../errors.js";
import type {
  ProviderRecord,
  ProviderRole,
  ProviderStore,
  UserRecord,
} from "./provider-types.js";

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
