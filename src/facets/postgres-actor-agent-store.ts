import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  apiSources,
  apiSourceVersions,
  auditEvents,
  facets,
  facetVersions,
} from "../db/schema.js";
import { AppError } from "../errors.js";
import { hashFacetManifest } from "./facet-manifest.js";
import {
  ACTOR_RUNTIME_NAME,
  FUJI_CHAIN_ID,
  FUSD_ASSET_ADDRESS,
  type ActorAgentStore,
  type PublishedActorRecord,
  type PublishedAgentFacetRecord,
} from "./actor-agent-types.js";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function requiredRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Database did not return ${context}`);
  return row;
}

export class PostgresActorAgentStore implements ActorAgentStore {
  constructor(private readonly database: Database["db"]) {}

  async publishActor(
    input: Parameters<ActorAgentStore["publishActor"]>[0],
  ): Promise<PublishedActorRecord> {
    const { command } = input;
    try {
      return await this.database.transaction(async (transaction) => {
        const existing = await transaction
          .select({ id: facets.id })
          .from(facets)
          .where(
            and(
              eq(facets.providerId, command.providerId),
              eq(facets.slug, command.slug),
            ),
          )
          .limit(1);
        if (existing.length > 0) {
          throw new AppError(
            "RESOURCE_CONFLICT",
            "A Facet with this slug already exists for the provider.",
            409,
          );
        }

        const ids = requiredRow(
          (
            await transaction.execute<{
              source_id: string;
              source_version_id: string;
              facet_id: string;
              version_id: string;
            }>(
              sql`select uuidv7()::text as source_id, uuidv7()::text as source_version_id, uuidv7()::text as facet_id, uuidv7()::text as version_id`,
            )
          ).rows,
          "Actor identifiers",
        );

        await transaction.insert(apiSources).values({
          id: ids.source_id,
          providerId: command.providerId,
          name: `actor:${command.slug}`,
          sourceKind: "paste",
        });

        await transaction.insert(apiSourceVersions).values({
          id: ids.source_version_id,
          apiSourceId: ids.source_id,
          mediaType: "application/javascript",
          objectKey: `inline://actors/${command.slug}`,
          sha256: input.codeSha256,
          createdBy: input.actorUserId,
        });

        const pricingModel = command.pricingModel ?? "PAY_PER_RUN";
        const priceAtomic = command.priceAtomic ?? "1000";
        const outputSchema = command.outputSchema ?? {
          type: "array",
          items: { type: "object" },
        };
        const tags = [...new Set(command.tags ?? ["actor"])].sort();
        const operation = {
          operationId: "runActor",
          method: "POST",
          publicPathTemplate: `/v1/actors/${command.slug}/run`,
          inputSchema: command.inputSchema,
          outputSchema,
          errorSchema: { type: "object" },
          sideEffectClass: "READ_ONLY" as const,
        };
        const manifest = {
          schemaVersion: "facet.manifest/v1" as const,
          facetId: ids.facet_id,
          versionId: ids.version_id,
          displayVersion: "1.0.0",
          providerId: command.providerId,
          type: "HOSTED_ACTOR" as const,
          name: command.name,
          slug: command.slug,
          summary: command.summary ?? command.name,
          description: command.description,
          category: command.category,
          tags,
          visibility: "PUBLIC" as const,
          operation,
          executionPolicy: {
            timeoutMs: 15_000,
            maxResponseBytes: 1_048_576,
            redirectPolicy: "DENY" as const,
          },
          upstreamAuth: {
            kind: "NONE" as const,
            configured: true,
          },
          pricing: {
            model: pricingModel,
            priceAtomic,
            assetAddress: FUSD_ASSET_ADDRESS,
            chainId: FUJI_CHAIN_ID,
            payTo: input.payTo,
          },
          actorConfig: {
            runtime: ACTOR_RUNTIME_NAME,
            entrypoint: "main.mjs",
            imageDigest: input.imageDigest,
          },
          provenance: {
            sourceType: "ACTOR_TEMPLATE" as const,
            sourceVersionId: ids.source_version_id,
            sourceOperationPointer: "#/actor/run",
          },
        };
        const contentHash = hashFacetManifest(manifest);
        const now = new Date();

        await transaction.insert(facets).values({
          id: ids.facet_id,
          providerId: command.providerId,
          type: "hosted_actor",
          slug: command.slug,
          name: command.name,
          description: command.description,
          category: command.category,
          tags,
          status: "published",
          visibility: "public",
        });

        await transaction.insert(facetVersions).values({
          id: ids.version_id,
          facetId: ids.facet_id,
          displayVersion: "1.0.0",
          status: "published",
          sourceVersionId: ids.source_version_id,
          sourceOperationPointer: "#/actor/run",
          manifest,
          contentHash,
          validationResult: { status: "valid", errors: [], warnings: [] },
          warningAcknowledgements: [],
          operation,
          inputSchema: command.inputSchema,
          outputSchema,
          actorCode: command.code.trim(),
          imageDigest: input.imageDigest,
          pricingModel,
          priceAtomic,
          payTo: input.payTo,
          registryTxHash: command.registryTxHash ?? null,
          createdBy: input.actorUserId,
          publishedAt: now,
          publishedBy: input.actorUserId,
        });

        await transaction
          .update(facets)
          .set({ currentPublishedVersionId: ids.version_id, updatedAt: now })
          .where(eq(facets.id, ids.facet_id));

        await transaction.insert(auditEvents).values({
          actorUserId: input.actorUserId,
          providerId: command.providerId,
          eventType: "actor.published",
          subjectType: "facet",
          subjectId: ids.facet_id,
          requestId: input.requestId,
          metadata: {
            facetVersionId: ids.version_id,
            imageDigest: input.imageDigest,
            pricingModel,
            priceAtomic,
          },
        });

        return {
          id: ids.facet_id,
          versionId: ids.version_id,
          slug: command.slug,
          facetType: "HOSTED_ACTOR",
          imageDigest: input.imageDigest,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          publishedAt: now,
        };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isUniqueViolation(error)) {
        throw new AppError(
          "RESOURCE_CONFLICT",
          "An Actor with this slug already exists.",
          409,
        );
      }
      throw error;
    }
  }

  async publishAgentFacet(
    input: Parameters<ActorAgentStore["publishAgentFacet"]>[0],
  ): Promise<PublishedAgentFacetRecord> {
    const { command } = input;
    try {
      return await this.database.transaction(async (transaction) => {
        const existing = await transaction
          .select({ id: facets.id })
          .from(facets)
          .where(
            and(
              eq(facets.providerId, command.providerId),
              eq(facets.slug, command.slug),
            ),
          )
          .limit(1);
        if (existing.length > 0) {
          throw new AppError(
            "RESOURCE_CONFLICT",
            "A Facet with this slug already exists for the provider.",
            409,
          );
        }

        const ids = requiredRow(
          (
            await transaction.execute<{
              source_id: string;
              source_version_id: string;
              facet_id: string;
              version_id: string;
            }>(
              sql`select uuidv7()::text as source_id, uuidv7()::text as source_version_id, uuidv7()::text as facet_id, uuidv7()::text as version_id`,
            )
          ).rows,
          "Agent Facet identifiers",
        );

        await transaction.insert(apiSources).values({
          id: ids.source_id,
          providerId: command.providerId,
          name: `agent:${command.slug}`,
          sourceKind: "paste",
        });

        await transaction.insert(apiSourceVersions).values({
          id: ids.source_version_id,
          apiSourceId: ids.source_id,
          mediaType: "application/json",
          objectKey: `inline://agents/${command.slug}`,
          sha256: input.codeSha256,
          createdBy: input.actorUserId,
        });

        const pricingModel = command.pricingModel ?? "PAY_PER_RUN";
        const priceAtomic = command.priceAtomic ?? "1000";
        const outputSchema = command.outputSchema ?? { type: "object" };
        const tags = [...new Set(command.tags ?? ["a2a", "erc8004"])].sort();
        const operation = {
          operationId: "delegateAgentTask",
          method: "POST",
          publicPathTemplate: `/v1/agents/${command.slug}/tasks`,
          inputSchema: command.inputSchema,
          outputSchema,
          errorSchema: { type: "object" },
          sideEffectClass: "READ_ONLY" as const,
        };
        const manifest = {
          schemaVersion: "facet.manifest/v1" as const,
          facetId: ids.facet_id,
          versionId: ids.version_id,
          displayVersion: "1.0.0",
          providerId: command.providerId,
          type: "AUTONOMOUS_AGENT" as const,
          name: command.name,
          slug: command.slug,
          summary: command.summary ?? command.name,
          description: command.description,
          category: command.category,
          tags,
          visibility: "PUBLIC" as const,
          operation,
          executionPolicy: {
            timeoutMs: 30_000,
            maxResponseBytes: 1_048_576,
            redirectPolicy: "DENY" as const,
          },
          upstreamAuth: {
            kind: "NONE" as const,
            configured: true,
          },
          pricing: {
            model: pricingModel,
            priceAtomic,
            assetAddress: FUSD_ASSET_ADDRESS,
            chainId: FUJI_CHAIN_ID,
            payTo: input.payTo,
          },
          agentConfig: {
            erc8004ChainId: FUJI_CHAIN_ID,
            erc8004Registry: input.erc8004Registry,
            erc8004TokenId: command.erc8004TokenId,
            a2aProtocolVersion: "1.0",
            taskKind: command.taskKind,
          },
          provenance: {
            sourceType: "A2A_AGENT_CARD" as const,
            sourceVersionId: ids.source_version_id,
            sourceOperationPointer: "#/agent/tasks",
          },
        };
        const contentHash = hashFacetManifest(manifest);
        const now = new Date();

        await transaction.insert(facets).values({
          id: ids.facet_id,
          providerId: command.providerId,
          type: "autonomous_agent",
          slug: command.slug,
          name: command.name,
          description: command.description,
          category: command.category,
          tags,
          status: "published",
          visibility: "public",
        });

        await transaction.insert(facetVersions).values({
          id: ids.version_id,
          facetId: ids.facet_id,
          displayVersion: "1.0.0",
          status: "published",
          sourceVersionId: ids.source_version_id,
          sourceOperationPointer: "#/agent/tasks",
          manifest,
          contentHash,
          validationResult: { status: "valid", errors: [], warnings: [] },
          warningAcknowledgements: [],
          operation,
          inputSchema: command.inputSchema,
          outputSchema,
          actorCode: command.code?.trim() ?? null,
          pricingModel,
          priceAtomic,
          payTo: input.payTo,
          erc8004TokenId: command.erc8004TokenId,
          erc8004Registry: input.erc8004Registry,
          agentTaskKind: command.taskKind,
          registryTxHash: command.registryTxHash ?? null,
          createdBy: input.actorUserId,
          publishedAt: now,
          publishedBy: input.actorUserId,
        });

        await transaction
          .update(facets)
          .set({ currentPublishedVersionId: ids.version_id, updatedAt: now })
          .where(eq(facets.id, ids.facet_id));

        await transaction.insert(auditEvents).values({
          actorUserId: input.actorUserId,
          providerId: command.providerId,
          eventType: "agent_facet.published",
          subjectType: "facet",
          subjectId: ids.facet_id,
          requestId: input.requestId,
          metadata: {
            facetVersionId: ids.version_id,
            erc8004TokenId: command.erc8004TokenId,
            erc8004Registry: input.erc8004Registry,
            taskKind: command.taskKind,
          },
        });

        return {
          id: ids.facet_id,
          versionId: ids.version_id,
          slug: command.slug,
          facetType: "AUTONOMOUS_AGENT",
          erc8004TokenId: command.erc8004TokenId,
          erc8004Registry: input.erc8004Registry,
          status: "PUBLISHED",
          visibility: "PUBLIC",
          publishedAt: now,
        };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isUniqueViolation(error)) {
        throw new AppError(
          "RESOURCE_CONFLICT",
          "An Agent Facet with this slug already exists.",
          409,
        );
      }
      throw error;
    }
  }
}
