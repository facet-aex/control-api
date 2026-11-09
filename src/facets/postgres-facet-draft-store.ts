import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "../db/client.js";
import {
  auditEvents,
  facets,
  facetVersions,
  importOperationCandidates,
  openApiImportJobs,
} from "../db/schema.js";
import { AppError } from "../errors.js";
import { buildFacetDraftManifest } from "./facet-manifest.js";
import type { FacetDraftRecord, FacetDraftStore } from "./facet-draft-types.js";

const candidateSchema = z.object({
  candidateId: z.string().min(1),
  jsonPointer: z.string().startsWith("#/paths/"),
  method: z.string().min(1),
  path: z.string().startsWith("/"),
  operationId: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  tags: z.array(z.string()),
});

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

export class PostgresFacetDraftStore implements FacetDraftStore {
  constructor(private readonly database: Database["db"]) {}

  async createDrafts(
    input: Parameters<FacetDraftStore["createDrafts"]>[0],
  ): Promise<FacetDraftRecord[]> {
    try {
      return await this.database.transaction(async (transaction) => {
        const job = (
          await transaction
            .select({
              providerId: openApiImportJobs.providerId,
              sourceVersionId: openApiImportJobs.sourceVersionId,
              status: openApiImportJobs.status,
            })
            .from(openApiImportJobs)
            .where(
              and(
                eq(openApiImportJobs.id, input.importJobId),
                eq(openApiImportJobs.providerId, input.providerId),
              ),
            )
            .limit(1)
        )[0];
        if (!job) {
          throw new AppError(
            "RESOURCE_NOT_FOUND",
            "Import job not found.",
            404,
          );
        }
        if (job.status !== "ready" || !job.sourceVersionId) {
          throw new AppError(
            "RESOURCE_CONFLICT",
            "The import job is not ready for operation selection.",
            409,
          );
        }

        const selectionIds = input.selections.map(
          (selection) => selection.operationCandidateId,
        );
        const candidateRows = await transaction
          .select({
            id: importOperationCandidates.id,
            jsonPointer: importOperationCandidates.jsonPointer,
            normalizedCandidate: importOperationCandidates.normalizedCandidate,
          })
          .from(importOperationCandidates)
          .where(
            and(
              eq(importOperationCandidates.importJobId, input.importJobId),
              inArray(importOperationCandidates.id, selectionIds),
            ),
          );
        if (candidateRows.length !== input.selections.length) {
          throw new AppError(
            "RESOURCE_NOT_FOUND",
            "An operation candidate was not found in this import.",
            404,
          );
        }
        const candidatesById = new Map(
          candidateRows.map((candidate) => [candidate.id, candidate]),
        );

        const requestedSlugs = input.selections.map(
          (selection) => selection.slug,
        );
        const existing = await transaction
          .select({ id: facets.id })
          .from(facets)
          .where(
            and(
              eq(facets.providerId, input.providerId),
              inArray(facets.slug, requestedSlugs),
            ),
          )
          .limit(1);
        if (existing.length > 0) {
          throw new AppError(
            "RESOURCE_CONFLICT",
            "A Facet with one of these slugs already exists.",
            409,
          );
        }

        const records: FacetDraftRecord[] = [];
        for (const selection of input.selections) {
          const candidateRow = candidatesById.get(
            selection.operationCandidateId,
          );
          if (!candidateRow) {
            throw new AppError(
              "RESOURCE_NOT_FOUND",
              "An operation candidate was not found in this import.",
              404,
            );
          }
          const candidate = candidateSchema.safeParse(
            candidateRow.normalizedCandidate,
          );
          if (!candidate.success) {
            throw new AppError(
              "RESOURCE_CONFLICT",
              "The selected operation candidate is not normalizable.",
              409,
            );
          }
          if (candidate.data.jsonPointer !== candidateRow.jsonPointer) {
            throw new AppError(
              "RESOURCE_CONFLICT",
              "The selected operation candidate failed its provenance check.",
              409,
            );
          }

          const generated = await transaction.execute<{
            facet_id: string;
            version_id: string;
          }>(
            sql`select uuidv7()::text as facet_id, uuidv7()::text as version_id`,
          );
          const identifiers = requiredRow(generated.rows, "Facet identifiers");
          const built = buildFacetDraftManifest({
            facetId: identifiers.facet_id,
            versionId: identifiers.version_id,
            providerId: input.providerId,
            sourceVersionId: job.sourceVersionId,
            displayVersion: "0.1.0",
            sourceOperationPointer: candidateRow.jsonPointer,
            selection,
            candidate: candidate.data,
          });
          const createdFacet = requiredRow(
            await transaction
              .insert(facets)
              .values({
                id: identifiers.facet_id,
                providerId: input.providerId,
                type: "external_http_api",
                slug: selection.slug,
                name: selection.name,
                description: selection.description ?? "",
                category: selection.category,
                tags: [...new Set(selection.tags)].sort(),
                status: "draft",
                visibility: "private",
              })
              .returning({
                id: facets.id,
                providerId: facets.providerId,
                slug: facets.slug,
                status: facets.status,
                visibility: facets.visibility,
                version: facets.version,
                createdAt: facets.createdAt,
              }),
            "a Facet draft",
          );
          const validationResult = {
            status: "pending" as const,
            errors: [],
            warnings: [],
          };
          const createdVersion = requiredRow(
            await transaction
              .insert(facetVersions)
              .values({
                id: identifiers.version_id,
                facetId: createdFacet.id,
                displayVersion: "0.1.0",
                status: "draft",
                sourceVersionId: job.sourceVersionId,
                sourceOperationPointer: candidateRow.jsonPointer,
                manifest: built.manifest,
                contentHash: built.contentHash,
                validationResult,
                warningAcknowledgements: [],
                operation: built.manifest.operation,
                inputSchema: built.manifest.operation.inputSchema,
                outputSchema: built.manifest.operation.outputSchema,
                createdBy: input.actorUserId,
              })
              .returning({
                id: facetVersions.id,
                displayVersion: facetVersions.displayVersion,
                status: facetVersions.status,
                sourceVersionId: facetVersions.sourceVersionId,
                sourceOperationPointer: facetVersions.sourceOperationPointer,
                contentHash: facetVersions.contentHash,
                version: facetVersions.version,
              }),
            "a Facet draft version",
          );
          await transaction.insert(auditEvents).values({
            actorUserId: input.actorUserId,
            providerId: input.providerId,
            eventType: "facet.draft_created",
            subjectType: "facet",
            subjectId: createdFacet.id,
            requestId: input.requestId,
            metadata: {
              importJobId: input.importJobId,
              operationCandidateId: selection.operationCandidateId,
              sourceVersionId: job.sourceVersionId,
              sourceOperationPointer: candidateRow.jsonPointer,
              facetVersionId: createdVersion.id,
            },
          });
          records.push({
            facetId: createdFacet.id,
            providerId: createdFacet.providerId,
            slug: createdFacet.slug,
            facetStatus: "draft",
            visibility: "private",
            facetRevision: createdFacet.version,
            createdAt: createdFacet.createdAt,
            facetVersionId: createdVersion.id,
            displayVersion: createdVersion.displayVersion,
            facetVersionStatus: "draft",
            sourceVersionId: createdVersion.sourceVersionId,
            sourceOperationPointer: createdVersion.sourceOperationPointer,
            contentHash: createdVersion.contentHash,
            facetVersionRevision: createdVersion.version,
            validationResult,
          });
        }
        return records;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isUniqueViolation(error)) {
        throw new AppError(
          "RESOURCE_CONFLICT",
          "A Facet with one of these slugs or versions already exists.",
          409,
        );
      }
      throw error;
    }
  }
}
