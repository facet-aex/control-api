import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { auditEvents, endpointConfigs, secretRefs } from "../db/schema.js";
import { AppError } from "../errors.js";
import type { SecretRecord, SecretStore } from "./secret-types.js";

type Db = Database["db"];

function requiredRow<T>(rows: T[], description: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Expected ${description}.`);
  return row;
}

function toRecord(
  row: typeof secretRefs.$inferSelect,
  usageCount: number,
): SecretRecord {
  return { ...row, usageCount };
}

export class PostgresSecretStore implements SecretStore {
  constructor(private readonly db: Db) {}

  async createSecret(input: Parameters<SecretStore["createSecret"]>[0]) {
    return this.db.transaction(async (transaction) => {
      const record = requiredRow(
        await transaction
          .insert(secretRefs)
          .values({
            providerId: input.providerId,
            kind: input.kind,
            label: input.label,
            vaultProvider: input.vaultProvider,
            vaultReference: input.vaultReference,
          })
          .returning(),
        "a secret reference",
      );
      await transaction.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        providerId: input.providerId,
        eventType: "secret.created",
        subjectType: "secret_ref",
        subjectId: record.id,
        requestId: input.requestId,
        metadata: { kind: input.kind, label: input.label },
      });
      return toRecord(record, 0);
    });
  }

  async rotateSecret(input: Parameters<SecretStore["rotateSecret"]>[0]) {
    return this.db.transaction(async (transaction) => {
      const current = (
        await transaction
          .select()
          .from(secretRefs)
          .where(
            and(
              eq(secretRefs.id, input.secretId),
              eq(secretRefs.providerId, input.providerId),
            ),
          )
          .for("update")
          .limit(1)
      )[0];
      if (!current) return undefined;
      if (current.status !== "active") {
        throw new AppError("RESOURCE_CONFLICT", "Secret is revoked.", 409);
      }
      const record = requiredRow(
        await transaction
          .update(secretRefs)
          .set({
            vaultProvider: input.vaultProvider,
            vaultReference: input.vaultReference,
            rotatedAt: new Date(),
          })
          .where(
            and(
              eq(secretRefs.id, input.secretId),
              eq(secretRefs.providerId, input.providerId),
            ),
          )
          .returning(),
        "a rotated secret reference",
      );
      const usage = await transaction
        .select({ count: sql<number>`count(*)::int` })
        .from(endpointConfigs)
        .where(eq(endpointConfigs.secretRefId, record.id));
      await transaction.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        providerId: input.providerId,
        eventType: "secret.rotated",
        subjectType: "secret_ref",
        subjectId: record.id,
        requestId: input.requestId,
        metadata: { kind: record.kind },
      });
      return {
        record: toRecord(record, usage[0]?.count ?? 0),
        previousReference: current.vaultReference,
      };
    });
  }

  async revokeSecret(input: Parameters<SecretStore["revokeSecret"]>[0]) {
    return this.db.transaction(async (transaction) => {
      const current = (
        await transaction
          .select()
          .from(secretRefs)
          .where(
            and(
              eq(secretRefs.id, input.secretId),
              eq(secretRefs.providerId, input.providerId),
            ),
          )
          .for("update")
          .limit(1)
      )[0];
      if (!current) return undefined;
      const usage = await transaction
        .select({ count: sql<number>`count(*)::int` })
        .from(endpointConfigs)
        .where(eq(endpointConfigs.secretRefId, current.id));
      if ((usage[0]?.count ?? 0) > 0) {
        throw new AppError(
          "RESOURCE_CONFLICT",
          "Secret is still used by an endpoint configuration.",
          409,
        );
      }
      if (current.status !== "active") {
        throw new AppError("RESOURCE_CONFLICT", "Secret is revoked.", 409);
      }
      const record = requiredRow(
        await transaction
          .update(secretRefs)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(eq(secretRefs.id, current.id))
          .returning(),
        "a revoked secret reference",
      );
      await transaction.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        providerId: input.providerId,
        eventType: "secret.revoked",
        subjectType: "secret_ref",
        subjectId: record.id,
        requestId: input.requestId,
        metadata: { kind: record.kind },
      });
      return {
        record: toRecord(record, 0),
        revokedReference: current.vaultReference,
      };
    });
  }
}
