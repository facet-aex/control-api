import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  apiSources,
  apiSourceVersions,
  actorRegistrationJobs,
  auditEvents,
  facets,
  facetVersions,
  providers,
} from "../db/schema.js";
import { AppError } from "../errors.js";
import { hashFacetManifest } from "./facet-manifest.js";
import {
  ACTOR_RUNTIME_NAME,
  DEFAULT_PAY_TO,
  FUJI_CHAIN_ID,
  FUSD_ASSET_ADDRESS,
  type ActorAgentStore,
  type PublishedActorRecord,
  type PublishedAgentFacetRecord,
  type PublishedFacetRegistryContext,
} from "./actor-agent-types.js";

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "23505") return true;
  return "cause" in error && isUniqueViolation(error.cause);
}

function requiredRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Database did not return ${context}`);
  return row;
}

export class PostgresActorAgentStore implements ActorAgentStore {
  constructor(private readonly database: Database["db"]) {}

  async getActorPublishStatus(facetId: string) {
    const row = (
      await this.database
        .select({ job: actorRegistrationJobs, version: facetVersions })
        .from(actorRegistrationJobs)
        .innerJoin(
          facetVersions,
          eq(actorRegistrationJobs.versionId, facetVersions.id),
        )
        .where(eq(actorRegistrationJobs.facetId, facetId))
        .limit(1)
    )[0];
    if (!row) return undefined;
    return {
      providerId: row.job.providerId,
      facetId: row.job.facetId,
      versionId: row.job.versionId,
      status:
        row.job.status === "published"
          ? ("PUBLISHED" as const)
          : row.job.status === "failed"
            ? ("REGISTRATION_FAILED" as const)
            : ("REGISTRATION_PENDING" as const),
      registryTxHash: row.version.registryTxHash,
      errorCode: row.job.errorCode,
    };
  }

  async publishActor(
    input: Parameters<ActorAgentStore["publishActor"]>[0],
  ): Promise<PublishedActorRecord> {
    const { command } = input;
    try {
      return await this.database.transaction(async (transaction) => {
        if (input.pending) {
          const previous = (
            await transaction
              .select({
                job: actorRegistrationJobs,
                version: facetVersions,
                facet: facets,
              })
              .from(actorRegistrationJobs)
              .innerJoin(
                facetVersions,
                eq(actorRegistrationJobs.versionId, facetVersions.id),
              )
              .innerJoin(facets, eq(actorRegistrationJobs.facetId, facets.id))
              .where(
                and(
                  eq(actorRegistrationJobs.providerId, command.providerId),
                  eq(
                    actorRegistrationJobs.idempotencyKey,
                    input.idempotencyKey!,
                  ),
                ),
              )
              .limit(1)
          )[0];
          if (previous) {
            if (previous.job.requestFingerprint !== input.requestFingerprint) {
              throw new AppError(
                "IDEMPOTENCY_CONFLICT",
                "Idempotency key has different Actor content.",
                409,
              );
            }
            return {
              id: previous.facet.id,
              versionId: previous.version.id,
              slug: previous.facet.slug,
              facetType: "HOSTED_ACTOR" as const,
              imageDigest: previous.version.imageDigest!,
              registryVerified: previous.version.registryVerified,
              status:
                previous.job.status === "published"
                  ? ("PUBLISHED" as const)
                  : ("REGISTRATION_PENDING" as const),
              visibility:
                previous.job.status === "published"
                  ? ("PUBLIC" as const)
                  : ("PRIVATE" as const),
              ...(previous.version.publishedAt
                ? { publishedAt: previous.version.publishedAt }
                : {}),
            };
          }
        }
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
        const facetId = command.id ?? ids.facet_id;

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
          facetId,
          versionId: ids.version_id,
          displayVersion: command.displayVersion ?? "1.0.0",
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
          id: facetId,
          providerId: command.providerId,
          type: "hosted_actor",
          slug: command.slug,
          name: command.name,
          description: command.description,
          category: command.category,
          tags,
          status: input.pending ? "draft" : "published",
          visibility: input.pending ? "private" : "public",
        });

        await transaction.insert(facetVersions).values({
          id: ids.version_id,
          facetId,
          displayVersion: command.displayVersion ?? "1.0.0",
          status: input.pending ? "valid" : "published",
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
          registryVerified: input.registryVerified,
          createdBy: input.actorUserId,
          publishedAt: input.pending ? null : now,
          publishedBy: input.pending ? null : input.actorUserId,
        });

        if (!input.pending) {
          await transaction
            .update(facets)
            .set({ currentPublishedVersionId: ids.version_id, updatedAt: now })
            .where(eq(facets.id, facetId));
        } else {
          if (
            !input.publicBaseUrl ||
            !input.idempotencyKey ||
            !input.requestFingerprint
          ) {
            throw new Error(
              "Pending Actor registration requires public URL and idempotency metadata",
            );
          }
          await transaction.insert(actorRegistrationJobs).values({
            versionId: ids.version_id,
            facetId,
            providerId: command.providerId,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            schemaUri: `${new URL(input.publicBaseUrl).origin}/v1/catalog/facets/${facetId}`,
          });
        }

        await transaction.insert(auditEvents).values({
          actorUserId: input.actorUserId,
          providerId: command.providerId,
          eventType: input.pending
            ? "actor.registration_pending"
            : "actor.published",
          subjectType: "facet",
          subjectId: facetId,
          requestId: input.requestId,
          metadata: {
            facetVersionId: ids.version_id,
            imageDigest: input.imageDigest,
            pricingModel,
            priceAtomic,
            registryVerified: input.registryVerified,
          },
        });

        return {
          id: facetId,
          versionId: ids.version_id,
          slug: command.slug,
          facetType: "HOSTED_ACTOR",
          imageDigest: input.imageDigest,
          registryVerified: input.registryVerified,
          status: input.pending ? "REGISTRATION_PENDING" : "PUBLISHED",
          visibility: input.pending ? "PRIVATE" : "PUBLIC",
          ...(!input.pending ? { publishedAt: now } : {}),
        };
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (input.pending && isUniqueViolation(error) && input.idempotencyKey) {
        const previous = (
          await this.database
            .select({
              job: actorRegistrationJobs,
              version: facetVersions,
              facet: facets,
            })
            .from(actorRegistrationJobs)
            .innerJoin(
              facetVersions,
              eq(actorRegistrationJobs.versionId, facetVersions.id),
            )
            .innerJoin(facets, eq(actorRegistrationJobs.facetId, facets.id))
            .where(
              and(
                eq(actorRegistrationJobs.providerId, command.providerId),
                eq(actorRegistrationJobs.idempotencyKey, input.idempotencyKey),
              ),
            )
            .limit(1)
        )[0];
        if (previous) {
          if (previous.job.requestFingerprint !== input.requestFingerprint) {
            throw new AppError(
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key has different Actor content.",
              409,
            );
          }
          return {
            id: previous.facet.id,
            versionId: previous.version.id,
            slug: previous.facet.slug,
            facetType: "HOSTED_ACTOR",
            imageDigest: previous.version.imageDigest!,
            registryVerified: previous.version.registryVerified,
            status:
              previous.job.status === "published"
                ? "PUBLISHED"
                : "REGISTRATION_PENDING",
            visibility:
              previous.job.status === "published" ? "PUBLIC" : "PRIVATE",
            ...(previous.version.publishedAt
              ? { publishedAt: previous.version.publishedAt }
              : {}),
          };
        }
      }
      if (isUniqueViolation(error)) {
        throw new AppError(
          "RESOURCE_CONFLICT",
          "An Actor with this ID or slug already exists.",
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
        const facetId = command.id ?? ids.facet_id;

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
          facetId,
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
          id: facetId,
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
          facetId,
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
          registryVerified: input.registryVerified,
          createdBy: input.actorUserId,
          publishedAt: now,
          publishedBy: input.actorUserId,
        });

        await transaction
          .update(facets)
          .set({ currentPublishedVersionId: ids.version_id, updatedAt: now })
          .where(eq(facets.id, facetId));

        await transaction.insert(auditEvents).values({
          actorUserId: input.actorUserId,
          providerId: command.providerId,
          eventType: "agent_facet.published",
          subjectType: "facet",
          subjectId: facetId,
          requestId: input.requestId,
          metadata: {
            facetVersionId: ids.version_id,
            erc8004TokenId: command.erc8004TokenId,
            erc8004Registry: input.erc8004Registry,
            taskKind: command.taskKind,
            registryVerified: input.registryVerified,
          },
        });

        return {
          id: facetId,
          versionId: ids.version_id,
          slug: command.slug,
          facetType: "AUTONOMOUS_AGENT",
          erc8004TokenId: command.erc8004TokenId,
          erc8004Registry: input.erc8004Registry,
          registryVerified: input.registryVerified,
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
          "An Agent Facet with this ID or slug already exists.",
          409,
        );
      }
      throw error;
    }
  }

  async getPublishedRegistryContext(
    facetId: string,
  ): Promise<PublishedFacetRegistryContext | undefined> {
    const rows = await this.database
      .select({
        facetId: facets.id,
        providerId: facets.providerId,
        facetType: facets.type,
        versionId: facetVersions.id,
        imageDigest: facetVersions.imageDigest,
        pricingModel: facetVersions.pricingModel,
        priceAtomic: facetVersions.priceAtomic,
        payTo: facetVersions.payTo,
        providerWallet: providers.walletAddress,
        erc8004TokenId: facetVersions.erc8004TokenId,
      })
      .from(facets)
      .innerJoin(
        facetVersions,
        eq(facets.currentPublishedVersionId, facetVersions.id),
      )
      .innerJoin(providers, eq(facets.providerId, providers.id))
      .where(and(eq(facets.id, facetId), eq(facets.status, "published")))
      .limit(1);

    const row = rows[0];
    if (!row) return undefined;

    const mappedType =
      row.facetType === "hosted_actor"
        ? "HOSTED_ACTOR"
        : row.facetType === "autonomous_agent"
          ? "AUTONOMOUS_AGENT"
          : "EXTERNAL_HTTP_API";

    return {
      facetId: row.facetId,
      providerId: row.providerId,
      versionId: row.versionId,
      facetType: mappedType,
      imageDigest: row.imageDigest,
      pricingModel:
        row.pricingModel === "PAY_PER_RESULT"
          ? "PAY_PER_RESULT"
          : "PAY_PER_RUN",
      priceAtomic: row.priceAtomic,
      payTo: row.payTo ?? row.providerWallet ?? DEFAULT_PAY_TO,
      erc8004TokenId: row.erc8004TokenId,
    };
  }

  async markRegistryVerified(input: {
    actorUserId: string;
    facetId: string;
    versionId: string;
    providerId: string;
    registryTxHash: string;
    requestId: string;
  }): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(facetVersions)
        .set({
          registryTxHash: input.registryTxHash,
          registryVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(facetVersions.id, input.versionId));

      await transaction.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        providerId: input.providerId,
        eventType: "facet.registry_verified",
        subjectType: "facet",
        subjectId: input.facetId,
        requestId: input.requestId,
        metadata: {
          facetVersionId: input.versionId,
          registryTxHash: input.registryTxHash,
        },
      });
    });
  }
}
