import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  auditEvents,
  endpointConfigs,
  facetVersions,
  facets,
} from "../db/schema.js";
import { AppError } from "../errors.js";
import type {
  FacetValidationContext,
  FacetValidationStore,
  StoredFacetValidation,
  StoredWarningAcknowledgement,
} from "./facet-validation-types.js";

type Db = Database["db"];

function warningsFrom(
  value: unknown,
): Array<{ code: string; message: string }> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("warnings" in value) ||
    !Array.isArray(value.warnings)
  ) {
    return [];
  }
  return value.warnings.flatMap((warning) =>
    typeof warning === "object" &&
    warning !== null &&
    "code" in warning &&
    typeof warning.code === "string" &&
    "message" in warning &&
    typeof warning.message === "string"
      ? [{ code: warning.code, message: warning.message }]
      : [],
  );
}

function acknowledgementsFrom(value: unknown): StoredWarningAcknowledgement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("warningId" in item) ||
      typeof item.warningId !== "string" ||
      !("acknowledgedAt" in item) ||
      typeof item.acknowledgedAt !== "string" ||
      !("acknowledgedBy" in item) ||
      typeof item.acknowledgedBy !== "string"
    ) {
      return [];
    }
    return [
      {
        warningId: item.warningId,
        ...("reason" in item && typeof item.reason === "string"
          ? { reason: item.reason }
          : {}),
        acknowledgedAt: item.acknowledgedAt,
        acknowledgedBy: item.acknowledgedBy,
      },
    ];
  });
}

export class PostgresFacetValidationStore implements FacetValidationStore {
  constructor(private readonly db: Db) {}

  async getContext(
    facetVersionId: string,
  ): Promise<FacetValidationContext | undefined> {
    const row = (
      await this.db
        .select({
          id: facetVersions.id,
          providerId: facets.providerId,
          status: facetVersions.status,
          version: facetVersions.version,
          manifest: facetVersions.manifest,
          validationResult: facetVersions.validationResult,
          warningAcknowledgements: facetVersions.warningAcknowledgements,
          endpointAuthKind: endpointConfigs.authKind,
          endpointSecretRefId: endpointConfigs.secretRefId,
        })
        .from(facetVersions)
        .innerJoin(facets, eq(facets.id, facetVersions.facetId))
        .leftJoin(
          endpointConfigs,
          eq(endpointConfigs.id, facetVersions.endpointConfigId),
        )
        .where(eq(facetVersions.id, facetVersionId))
        .limit(1)
    )[0];
    if (!row) return undefined;
    return {
      facetVersionId: row.id,
      providerId: row.providerId,
      status: row.status,
      version: row.version,
      manifest: row.manifest,
      endpointConfig: row.endpointAuthKind
        ? {
            authKind: row.endpointAuthKind,
            secretRefId: row.endpointSecretRefId,
          }
        : null,
      warnings: warningsFrom(row.validationResult),
      warningAcknowledgements: acknowledgementsFrom(
        row.warningAcknowledgements,
      ),
    };
  }

  async saveValidation(
    input: Parameters<FacetValidationStore["saveValidation"]>[0],
  ) {
    return this.db.transaction(async (transaction) => {
      const current = (
        await transaction
          .select({
            id: facetVersions.id,
            providerId: facets.providerId,
            status: facetVersions.status,
            version: facetVersions.version,
          })
          .from(facetVersions)
          .innerJoin(facets, eq(facets.id, facetVersions.facetId))
          .where(
            and(
              eq(facetVersions.id, input.facetVersionId),
              eq(facets.providerId, input.providerId),
            ),
          )
          .for("update", { of: facetVersions })
          .limit(1)
      )[0];
      if (!current) return undefined;
      if (current.status === "published" || current.status === "disabled") {
        throw new AppError(
          "RESOURCE_CONFLICT",
          "Published or disabled Facet Versions cannot be revalidated.",
          409,
        );
      }
      if (current.version !== input.expectedVersion) {
        throw new AppError(
          "VERSION_PRECONDITION_FAILED",
          "The Facet Version changed; reload it before retrying.",
          412,
        );
      }
      const updated = (
        await transaction
          .update(facetVersions)
          .set({
            status: input.status,
            validationResult: input.validation,
            warningAcknowledgements: input.warningAcknowledgements,
            version: sql`${facetVersions.version} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(facetVersions.id, input.facetVersionId),
              eq(facetVersions.version, input.expectedVersion),
            ),
          )
          .returning({
            id: facetVersions.id,
            status: facetVersions.status,
            version: facetVersions.version,
            validationResult: facetVersions.validationResult,
            warningAcknowledgements: facetVersions.warningAcknowledgements,
          })
      )[0];
      if (!updated) {
        throw new AppError(
          "VERSION_PRECONDITION_FAILED",
          "The Facet Version changed; reload it before retrying.",
          412,
        );
      }
      await transaction.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        providerId: input.providerId,
        eventType: "facet.version_validated",
        subjectType: "facet_version",
        subjectId: input.facetVersionId,
        requestId: input.requestId,
        metadata: {
          status: input.validation.status,
          errorCount: input.validation.errors.length,
          warningCount: input.validation.warnings.length,
          acknowledgedWarningCount: input.warningAcknowledgements.length,
        },
      });
      return {
        facetVersionId: updated.id,
        status: updated.status as "draft" | "valid",
        version: updated.version,
        validation:
          updated.validationResult as StoredFacetValidation["validation"],
        warningAcknowledgements: acknowledgementsFrom(
          updated.warningAcknowledgements,
        ),
      };
    });
  }
}
