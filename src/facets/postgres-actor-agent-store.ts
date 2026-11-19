import { createHash, randomUUID } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  actorRegistrationJobs,
  apiSources,
  apiSourceVersions,
  auditEvents,
  facetVersions,
  facets,
  users,
} from "../db/schema.js";
import { AppError } from "../errors.js";
import type { FacetType, PricingModel } from "../identifiers.js";
import type {
  ActorAgentStore,
  ActorPublishStatus,
  MyActorSummary,
  MyFacetStatus,
  MyFacetSummary,
  PublishedActorRecord,
  PublishedAgentFacetRecord,
  PublishedFacetRegistryContext,
} from "./actor-agent-types.js";
import { hashFacetManifest } from "./facet-manifest.js";

type Db = Database["db"];
type ActorJobStatus = "pending" | "submitted" | "confirmed" | "failed" | null;

function toActorPublishStatus(
  versionStatus: "draft" | "valid" | "published" | "disabled",
  jobStatus: ActorJobStatus,
): ActorPublishStatus {
  if (versionStatus === "published" || jobStatus === "confirmed") {
    return "PUBLISHED";
  }
  if (jobStatus === "failed" || versionStatus === "disabled") {
    return "FAILED";
  }
  return "REGISTRATION_PENDING";
}

function toMyFacetStatus(
  facetType: FacetType,
  versionStatus: "draft" | "valid" | "published" | "disabled",
  jobStatus: ActorJobStatus,
): MyFacetStatus {
  if (facetType === "ACTOR") {
    if (versionStatus === "published" || jobStatus === "confirmed") {
      return "PUBLISHED";
    }
    if (jobStatus === "failed") {
      return "FAILED";
    }
    if (versionStatus === "disabled") {
      return "DISABLED";
    }
    return "REGISTRATION_PENDING";
  }
  if (versionStatus === "published") return "PUBLISHED";
  if (versionStatus === "valid") return "VALID";
  if (versionStatus === "disabled") return "DISABLED";
  return "DRAFT";
}

function enrichManifestIds(
  manifest: Record<string, unknown>,
  ids: { facetId: string; versionId: string; sourceVersionId: string },
) {
  const provenance = (manifest.provenance ?? {}) as Record<string, unknown>;
  const enriched: Record<string, unknown> = {
    ...manifest,
    facetId: ids.facetId,
    versionId: ids.versionId,
    provenance: {
      ...provenance,
      sourceVersionId: ids.sourceVersionId,
    },
  };
  return {
    manifest: enriched,
    contentHash: hashFacetManifest(enriched),
  };
}

export class PostgresActorAgentStore implements ActorAgentStore {
  constructor(private readonly db: Db) {}

  async listMyActors(userId: string): Promise<MyActorSummary[]> {
    const rows = await this.db
      .select({
        provider: users.username,
        facetName: facets.facetName,
        facetDisplayName: facets.facetDisplayName,
        version: facetVersions.version,
        versionStatus: facetVersions.status,
        versionTxHash: facetVersions.registryTxHash,
        jobStatus: actorRegistrationJobs.status,
        jobTxHash: actorRegistrationJobs.txHash,
      })
      .from(facetVersions)
      .innerJoin(facets, eq(facets.id, facetVersions.facetId))
      .innerJoin(users, eq(users.id, facets.providerId))
      .leftJoin(
        actorRegistrationJobs,
        eq(actorRegistrationJobs.versionId, facetVersions.id),
      )
      .where(and(eq(facets.providerId, userId), eq(facets.type, "ACTOR")))
      .orderBy(desc(facetVersions.createdAt));

    return rows.map((row) => ({
      provider: row.provider,
      facetName: row.facetName,
      facetDisplayName: row.facetDisplayName,
      version: row.version,
      status: toActorPublishStatus(
        row.versionStatus,
        (row.jobStatus ?? null) as ActorJobStatus,
      ),
      registryTxHash: row.versionTxHash ?? row.jobTxHash ?? null,
    }));
  }

  async listMyFacets(userId: string): Promise<MyFacetSummary[]> {
    const rows = await this.db
      .select({
        provider: users.username,
        facetName: facets.facetName,
        facetDisplayName: facets.facetDisplayName,
        facetType: facets.type,
        version: facetVersions.version,
        category: facets.category,
        visibility: facets.visibility,
        versionStatus: facetVersions.status,
        pricingModel: facetVersions.pricingModel,
        priceAtomic: facetVersions.priceAtomic,
        registryVerified: facetVersions.registryVerified,
        versionTxHash: facetVersions.registryTxHash,
        jobStatus: actorRegistrationJobs.status,
        jobTxHash: actorRegistrationJobs.txHash,
        errorCode: actorRegistrationJobs.errorCode,
        createdAt: facetVersions.createdAt,
        publishedAt: facetVersions.publishedAt,
      })
      .from(facetVersions)
      .innerJoin(facets, eq(facets.id, facetVersions.facetId))
      .innerJoin(users, eq(users.id, facets.providerId))
      .leftJoin(
        actorRegistrationJobs,
        eq(actorRegistrationJobs.versionId, facetVersions.id),
      )
      .where(eq(facets.providerId, userId))
      .orderBy(desc(facetVersions.createdAt));

    return rows.map((row) => ({
      provider: row.provider,
      facetName: row.facetName,
      facetDisplayName: row.facetDisplayName,
      facetType: row.facetType,
      version: row.version,
      category: row.category,
      visibility: row.visibility.toUpperCase() as
        "PRIVATE" | "PUBLIC" | "UNLISTED",
      status: toMyFacetStatus(
        row.facetType,
        row.versionStatus,
        (row.jobStatus ?? null) as ActorJobStatus,
      ),
      pricingModel:
        row.pricingModel === "PAY_PER_RESULT"
          ? "PAY_PER_RESULT"
          : ("PAY_PER_RUN" as PricingModel),
      priceAtomic: row.priceAtomic,
      registryVerified: row.registryVerified,
      registryTxHash: row.versionTxHash ?? row.jobTxHash ?? null,
      errorCode: row.errorCode ?? null,
      createdAt: row.createdAt.toISOString(),
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    }));
  }

  async getActorPublishStatus(
    provider: string,
    facetName: string,
    version: string,
  ) {
    const row = (
      await this.db
        .select({
          providerId: facets.providerId,
          provider: users.username,
          facetName: facets.facetName,
          version: facetVersions.version,
          versionStatus: facetVersions.status,
          versionTxHash: facetVersions.registryTxHash,
          jobStatus: actorRegistrationJobs.status,
          jobTxHash: actorRegistrationJobs.txHash,
          errorCode: actorRegistrationJobs.errorCode,
        })
        .from(facetVersions)
        .innerJoin(facets, eq(facets.id, facetVersions.facetId))
        .innerJoin(users, eq(users.id, facets.providerId))
        .leftJoin(
          actorRegistrationJobs,
          eq(actorRegistrationJobs.versionId, facetVersions.id),
        )
        .where(
          and(
            eq(users.username, provider),
            eq(facets.facetName, facetName),
            eq(facets.type, "ACTOR"),
            eq(facetVersions.version, version),
          ),
        )
        .limit(1)
    )[0];

    if (!row) return undefined;
    return {
      providerId: row.providerId,
      provider: row.provider,
      facetName: row.facetName,
      version: row.version,
      status: toActorPublishStatus(
        row.versionStatus,
        (row.jobStatus ?? null) as ActorJobStatus,
      ),
      registryTxHash: row.versionTxHash ?? row.jobTxHash ?? null,
      errorCode: row.errorCode ?? null,
    };
  }

  async publishActor(
    input: Parameters<ActorAgentStore["publishActor"]>[0],
  ): Promise<PublishedActorRecord> {
    const version = input.command.version ?? "1.0.0";
    return this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${input.actorUserId}:actor:${input.command.facetName}`}, 0))`,
      );
      if (input.pending && input.idempotencyKey) {
        const existingJob = (
          await transaction
            .select({
              requestFingerprint: actorRegistrationJobs.requestFingerprint,
              jobStatus: actorRegistrationJobs.status,
              imageDigest: facetVersions.imageDigest,
              provider: users.username,
              facetName: facets.facetName,
              facetDisplayName: facets.facetDisplayName,
              version: facetVersions.version,
              versionStatus: facetVersions.status,
              visibility: facets.visibility,
              publishedAt: facetVersions.publishedAt,
              registryVerified: facetVersions.registryVerified,
            })
            .from(actorRegistrationJobs)
            .innerJoin(
              facetVersions,
              eq(facetVersions.id, actorRegistrationJobs.versionId),
            )
            .innerJoin(facets, eq(facets.id, facetVersions.facetId))
            .innerJoin(users, eq(users.id, facets.providerId))
            .where(
              and(
                eq(actorRegistrationJobs.providerId, input.actorUserId),
                eq(actorRegistrationJobs.idempotencyKey, input.idempotencyKey),
              ),
            )
            .limit(1)
        )[0];

        if (existingJob) {
          if (
            input.requestFingerprint &&
            existingJob.requestFingerprint !== input.requestFingerprint
          ) {
            throw new AppError(
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key was reused with different Actor content.",
              409,
            );
          }
          const status = toActorPublishStatus(
            existingJob.versionStatus,
            existingJob.jobStatus as ActorJobStatus,
          );
          return {
            provider: existingJob.provider,
            facetName: existingJob.facetName,
            facetDisplayName: existingJob.facetDisplayName,
            version: existingJob.version,
            facetType: "ACTOR",
            imageDigest: existingJob.imageDigest ?? input.imageDigest,
            registryVerified: existingJob.registryVerified,
            status,
            visibility:
              existingJob.visibility === "public" ? "PUBLIC" : "PRIVATE",
            ...(existingJob.publishedAt
              ? { publishedAt: existingJob.publishedAt }
              : {}),
          };
        }
      }

      const existingFacet = (
        await transaction
          .select({
            id: facets.id,
            type: facets.type,
            revision: facets.revision,
          })
          .from(facets)
          .where(
            and(
              eq(facets.providerId, input.actorUserId),
              eq(facets.facetName, input.command.facetName),
            ),
          )
          .limit(1)
      )[0];

      if (existingFacet && existingFacet.type !== "ACTOR") {
        throw new AppError(
          "RESOURCE_CONFLICT",
          "A non-ACTOR Facet already uses this facetName.",
          409,
        );
      }

      if (existingFacet) {
        const versionConflict = (
          await transaction
            .select({ id: facetVersions.id })
            .from(facetVersions)
            .where(
              and(
                eq(facetVersions.facetId, existingFacet.id),
                eq(facetVersions.version, version),
              ),
            )
            .limit(1)
        )[0];
        if (versionConflict) {
          throw new AppError(
            "RESOURCE_CONFLICT",
            "An Actor with this facetName and version already exists.",
            409,
          );
        }
      }

      const now = new Date();
      const pending = input.pending === true;
      const sourceSha = createHash("sha256")
        .update(input.command.code)
        .digest("hex");

      const [sourceRow] = await transaction
        .insert(apiSources)
        .values({
          providerId: input.actorUserId,
          name: `actor:${input.command.facetName}@${version}`,
          sourceKind: "paste",
          status: "active",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: apiSources.id });
      const [sourceVersionRow] = await transaction
        .insert(apiSourceVersions)
        .values({
          apiSourceId: sourceRow!.id,
          mediaType: "application/javascript",
          objectKey: `inline://actors/${input.providerUsername}/${input.command.facetName}/${version}.mjs`,
          sha256: sourceSha,
          createdBy: input.actorUserId,
          createdAt: now,
        })
        .returning({ id: apiSourceVersions.id });

      const facetId = existingFacet?.id ?? randomUUID();
      const versionId = randomUUID();
      const sourceVersionId = sourceVersionRow!.id;
      const { manifest, contentHash } = enrichManifestIds(input.manifest, {
        facetId,
        versionId,
        sourceVersionId,
      });

      if (!existingFacet) {
        await transaction.insert(facets).values({
          id: facetId,
          providerId: input.actorUserId,
          type: "ACTOR",
          facetName: input.command.facetName,
          facetDisplayName: input.command.facetDisplayName,
          description: input.command.description,
          category: input.command.category,
          tags: input.command.tags ?? [],
          status: pending ? "draft" : "published",
          visibility: pending ? "private" : "public",
          currentPublishedVersionId: null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
      }

      await transaction.insert(facetVersions).values({
        id: versionId,
        facetId,
        version,
        status: pending ? "valid" : "published",
        sourceVersionId,
        sourceOperationPointer: "#/run",
        manifest,
        contentHash,
        operation: manifest.operation,
        inputSchema: input.command.inputSchema,
        outputSchema: input.command.outputSchema ?? { type: "object" },
        actorCode: input.command.code,
        imageDigest: input.imageDigest,
        pricingModel: input.command.pricingModel ?? "PAY_PER_RUN",
        priceAtomic: input.command.priceAtomic ?? "1000",
        payTo: input.payTo,
        registryVerified: input.registryVerified,
        createdBy: input.actorUserId,
        revision: 1,
        publishedAt: pending ? null : now,
        publishedBy: pending ? null : input.actorUserId,
        createdAt: now,
        updatedAt: now,
      });

      if (!pending) {
        await transaction
          .update(facets)
          .set({
            facetDisplayName: input.command.facetDisplayName,
            description: input.command.description,
            category: input.command.category,
            tags: input.command.tags ?? [],
            status: "published",
            visibility: "public",
            currentPublishedVersionId: versionId,
            revision: existingFacet ? existingFacet.revision + 1 : 1,
            updatedAt: now,
          })
          .where(eq(facets.id, facetId));
      }

      if (pending) {
        await transaction.insert(actorRegistrationJobs).values({
          versionId,
          facetId,
          providerId: input.actorUserId,
          idempotencyKey:
            input.idempotencyKey ??
            `actor:${input.providerUsername}:${input.command.facetName}:${version}`,
          requestFingerprint: input.requestFingerprint ?? "",
          schemaUri:
            input.schemaUri ??
            `https://facet.example/v1/catalog/facets/${encodeURIComponent(input.providerUsername)}/${encodeURIComponent(input.command.facetName)}/versions/${encodeURIComponent(version)}`,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        });
      }

      await transaction.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        providerId: input.actorUserId,
        eventType: pending ? "actor.registration_queued" : "actor.published",
        subjectType: "facet_version",
        subjectId: versionId,
        requestId: input.requestId,
        metadata: {
          facetId,
          provider: input.providerUsername,
          facetName: input.command.facetName,
          version,
          imageDigest: input.imageDigest,
        },
      });

      return {
        provider: input.providerUsername,
        facetName: input.command.facetName,
        facetDisplayName: input.command.facetDisplayName,
        version,
        facetType: "ACTOR",
        imageDigest: input.imageDigest,
        registryVerified: input.registryVerified,
        status: pending ? "REGISTRATION_PENDING" : "PUBLISHED",
        visibility: pending ? "PRIVATE" : "PUBLIC",
        ...(pending ? {} : { publishedAt: now }),
      };
    });
  }

  async publishAgentFacet(
    input: Parameters<ActorAgentStore["publishAgentFacet"]>[0],
  ): Promise<PublishedAgentFacetRecord> {
    const version = input.command.version ?? "1.0.0";
    return this.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${input.actorUserId}:agent:${input.command.facetName}`}, 0))`,
      );
      const existingFacet = (
        await transaction
          .select({
            id: facets.id,
            type: facets.type,
            revision: facets.revision,
          })
          .from(facets)
          .where(
            and(
              eq(facets.providerId, input.actorUserId),
              eq(facets.facetName, input.command.facetName),
            ),
          )
          .limit(1)
      )[0];

      if (existingFacet && existingFacet.type !== "AGENT") {
        throw new AppError(
          "RESOURCE_CONFLICT",
          "A non-AGENT Facet already uses this facetName.",
          409,
        );
      }
      if (existingFacet) {
        const versionConflict = (
          await transaction
            .select({ id: facetVersions.id })
            .from(facetVersions)
            .where(
              and(
                eq(facetVersions.facetId, existingFacet.id),
                eq(facetVersions.version, version),
              ),
            )
            .limit(1)
        )[0];
        if (versionConflict) {
          throw new AppError(
            "RESOURCE_CONFLICT",
            "An Agent Facet with this facetName and version already exists.",
            409,
          );
        }
      }

      const now = new Date();
      const sourceSha = createHash("sha256")
        .update(
          `${input.command.facetName}:${version}:${input.command.erc8004TokenId}`,
        )
        .digest("hex");

      const [sourceRow] = await transaction
        .insert(apiSources)
        .values({
          providerId: input.actorUserId,
          name: `agent:${input.command.facetName}@${version}`,
          sourceKind: "paste",
          status: "active",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: apiSources.id });
      const [sourceVersionRow] = await transaction
        .insert(apiSourceVersions)
        .values({
          apiSourceId: sourceRow!.id,
          mediaType: "application/json",
          objectKey: `inline://agents/${input.providerUsername}/${input.command.facetName}/${version}.json`,
          sha256: sourceSha,
          createdBy: input.actorUserId,
          createdAt: now,
        })
        .returning({ id: apiSourceVersions.id });

      const facetId = existingFacet?.id ?? randomUUID();
      const versionId = randomUUID();
      const sourceVersionId = sourceVersionRow!.id;
      const { manifest, contentHash } = enrichManifestIds(input.manifest, {
        facetId,
        versionId,
        sourceVersionId,
      });

      if (!existingFacet) {
        await transaction.insert(facets).values({
          id: facetId,
          providerId: input.actorUserId,
          type: "AGENT",
          facetName: input.command.facetName,
          facetDisplayName: input.command.facetDisplayName,
          description: input.command.description,
          category: input.command.category,
          tags: input.command.tags ?? [],
          status: "published",
          visibility: "public",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
      }

      await transaction.insert(facetVersions).values({
        id: versionId,
        facetId,
        version,
        status: "published",
        sourceVersionId,
        sourceOperationPointer: "#/delegate",
        manifest,
        contentHash,
        operation: manifest.operation,
        inputSchema: input.command.inputSchema,
        outputSchema: input.command.outputSchema ?? { type: "object" },
        pricingModel: input.command.pricingModel ?? "PAY_PER_RUN",
        priceAtomic: input.command.priceAtomic ?? "1000",
        payTo: input.payTo,
        erc8004TokenId: input.command.erc8004TokenId,
        erc8004Registry: input.erc8004Registry,
        agentTaskKind: input.command.taskKind,
        registryVerified: input.registryVerified,
        createdBy: input.actorUserId,
        revision: 1,
        publishedAt: now,
        publishedBy: input.actorUserId,
        createdAt: now,
        updatedAt: now,
      });

      await transaction
        .update(facets)
        .set({
          facetDisplayName: input.command.facetDisplayName,
          description: input.command.description,
          category: input.command.category,
          tags: input.command.tags ?? [],
          status: "published",
          visibility: "public",
          currentPublishedVersionId: versionId,
          revision: existingFacet ? existingFacet.revision + 1 : 1,
          updatedAt: now,
        })
        .where(eq(facets.id, facetId));

      await transaction.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        providerId: input.actorUserId,
        eventType: "agent_facet.published",
        subjectType: "facet_version",
        subjectId: versionId,
        requestId: input.requestId,
        metadata: {
          facetId,
          provider: input.providerUsername,
          facetName: input.command.facetName,
          version,
          erc8004TokenId: input.command.erc8004TokenId,
        },
      });

      return {
        provider: input.providerUsername,
        facetName: input.command.facetName,
        facetDisplayName: input.command.facetDisplayName,
        version,
        facetType: "AGENT",
        erc8004TokenId: input.command.erc8004TokenId,
        erc8004Registry: input.erc8004Registry,
        status: "PUBLISHED",
        visibility: "PUBLIC",
        publishedAt: now,
      };
    });
  }

  async getPublishedRegistryContextByName(
    provider: string,
    facetName: string,
    version: string,
  ): Promise<PublishedFacetRegistryContext | undefined> {
    const row = (
      await this.db
        .select({
          facetId: facets.id,
          providerId: facets.providerId,
          versionId: facetVersions.id,
          facetType: facets.type,
          imageDigest: facetVersions.imageDigest,
          pricingModel: facetVersions.pricingModel,
          priceAtomic: facetVersions.priceAtomic,
          payTo: facetVersions.payTo,
          erc8004TokenId: facetVersions.erc8004TokenId,
        })
        .from(facetVersions)
        .innerJoin(facets, eq(facets.id, facetVersions.facetId))
        .innerJoin(users, eq(users.id, facets.providerId))
        .where(
          and(
            eq(users.username, provider),
            eq(facets.facetName, facetName),
            eq(facetVersions.version, version),
          ),
        )
        .limit(1)
    )[0];

    if (!row) return undefined;
    return {
      facetId: row.facetId,
      providerId: row.providerId,
      versionId: row.versionId,
      facetType: row.facetType,
      imageDigest: row.imageDigest,
      pricingModel:
        row.pricingModel === "PAY_PER_RESULT"
          ? "PAY_PER_RESULT"
          : "PAY_PER_RUN",
      priceAtomic: row.priceAtomic,
      payTo: row.payTo,
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
    await this.db.transaction(async (transaction) => {
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
        subjectType: "facet_version",
        subjectId: input.versionId,
        requestId: input.requestId,
        metadata: {
          facetId: input.facetId,
          registryTxHash: input.registryTxHash,
        },
      });
    });
  }
}
