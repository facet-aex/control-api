import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { auditEvents, facetVersions, facets, users } from "../db/schema.js";
import { AppError } from "../errors.js";
import { hashFacetManifest } from "./facet-manifest.js";
import type {
  FacetPublicationContext,
  FacetPublicationStore,
} from "./facet-publication-types.js";

type Db = Database["db"];

function validationStatus(
  value: unknown,
): FacetPublicationContext["validationStatus"] {
  if (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    (value.status === "pending" ||
      value.status === "invalid" ||
      value.status === "valid")
  ) {
    return value.status;
  }
  return "pending";
}

export class PostgresFacetPublicationStore implements FacetPublicationStore {
  constructor(private readonly db: Db) {}

  async getContextByName(
    provider: string,
    facetName: string,
    version: string,
  ): Promise<FacetPublicationContext | undefined> {
    const row = (
      await this.db
        .select({
          facetId: facets.id,
          facetVersionId: facetVersions.id,
          providerId: facets.providerId,
          provider: users.username,
          facetName: facets.facetName,
          facetDisplayName: facets.facetDisplayName,
          facetType: facets.type,
          version: facetVersions.version,
          facetStatus: facets.status,
          facetVersionStatus: facetVersions.status,
          revision: facetVersions.revision,
          manifest: facetVersions.manifest,
          validationResult: facetVersions.validationResult,
          endpointConfigId: facetVersions.endpointConfigId,
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
      facetVersionId: row.facetVersionId,
      providerId: row.providerId,
      provider: row.provider,
      facetName: row.facetName,
      facetDisplayName: row.facetDisplayName,
      facetType: row.facetType,
      version: row.version,
      facetStatus: row.facetStatus,
      facetVersionStatus: row.facetVersionStatus,
      revision: row.revision,
      manifest: row.manifest as Record<string, unknown>,
      validationStatus: validationStatus(row.validationResult),
      endpointConfigured: row.endpointConfigId !== null,
    };
  }

  async publish(input: Parameters<FacetPublicationStore["publish"]>[0]) {
    return this.db.transaction(async (transaction) => {
      const current = (
        await transaction
          .select({
            facetId: facets.id,
            facetName: facets.facetName,
            facetDisplayName: facets.facetDisplayName,
            facetType: facets.type,
            facetRevision: facets.revision,
            providerId: facets.providerId,
            provider: users.username,
            facetStatus: facets.status,
            facetVersionId: facetVersions.id,
            facetVersionStatus: facetVersions.status,
            version: facetVersions.version,
            revision: facetVersions.revision,
            manifest: facetVersions.manifest,
            validationResult: facetVersions.validationResult,
            endpointConfigId: facetVersions.endpointConfigId,
          })
          .from(facetVersions)
          .innerJoin(facets, eq(facets.id, facetVersions.facetId))
          .innerJoin(users, eq(users.id, facets.providerId))
          .where(
            and(
              eq(facetVersions.id, input.facetVersionId),
              eq(facets.providerId, input.providerId),
            ),
          )
          .for("update")
          .limit(1)
      )[0];
      if (!current) return undefined;
      if (current.revision !== input.expectedRevision) {
        throw new AppError(
          "VERSION_PRECONDITION_FAILED",
          "The Facet Version changed; reload it before publishing.",
          412,
        );
      }
      if (
        current.facetStatus === "disabled" ||
        current.facetVersionStatus !== "valid" ||
        validationStatus(current.validationResult) !== "valid" ||
        current.endpointConfigId === null
      ) {
        throw new AppError(
          "RESOURCE_CONFLICT",
          "Only a valid configured Facet Version can be published.",
          409,
        );
      }

      const manifest = {
        ...(current.manifest as Record<string, unknown>),
        visibility: input.visibility.toUpperCase(),
      };
      const contentHash = hashFacetManifest(manifest);
      const publishedAt = new Date();
      const publishedVersion = (
        await transaction
          .update(facetVersions)
          .set({
            status: "published",
            manifest,
            contentHash,
            publishedAt,
            publishedBy: input.actorUserId,
            revision: sql`${facetVersions.revision} + 1`,
            updatedAt: publishedAt,
          })
          .where(
            and(
              eq(facetVersions.id, input.facetVersionId),
              eq(facetVersions.revision, input.expectedRevision),
              eq(facetVersions.status, "valid"),
            ),
          )
          .returning({
            id: facetVersions.id,
            revision: facetVersions.revision,
          })
      )[0];
      if (!publishedVersion) {
        throw new AppError(
          "VERSION_PRECONDITION_FAILED",
          "The Facet Version changed; reload it before publishing.",
          412,
        );
      }
      const publishedFacet = (
        await transaction
          .update(facets)
          .set({
            status: "published",
            visibility: input.visibility,
            currentPublishedVersionId: input.facetVersionId,
            revision: sql`${facets.revision} + 1`,
            updatedAt: publishedAt,
          })
          .where(eq(facets.id, current.facetId))
          .returning({ revision: facets.revision })
      )[0];
      if (!publishedFacet) {
        throw new AppError("RESOURCE_NOT_FOUND", "Facet not found.", 404);
      }
      await transaction.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        providerId: input.providerId,
        eventType: "facet.version_published",
        subjectType: "facet_version",
        subjectId: input.facetVersionId,
        requestId: input.requestId,
        metadata: {
          facetId: current.facetId,
          provider: current.provider,
          facetName: current.facetName,
          version: current.version,
          visibility: input.visibility,
          contentHash,
        },
      });
      return {
        provider: current.provider,
        facetName: current.facetName,
        facetDisplayName: current.facetDisplayName,
        facetType: current.facetType,
        version: current.version,
        visibility: input.visibility,
        contentHash,
        publishedAt: publishedAt.toISOString(),
        facetVersionRevision: publishedVersion.revision,
        facetRevision: publishedFacet.revision,
      };
    });
  }
}
