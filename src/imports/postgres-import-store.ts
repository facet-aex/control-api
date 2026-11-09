import { eq } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  apiSourceVersions,
  apiSources,
  auditEvents,
  openApiImportJobs,
  outboxEvents,
} from "../db/schema.js";
import type { ImportJobRecord, ImportStore } from "./import-types.js";

function requiredRow<T>(rows: T[], context: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Database did not return ${context}`);
  return row;
}

export class PostgresImportStore implements ImportStore {
  constructor(private readonly database: Database["db"]) {}

  async createImport(
    input: Parameters<ImportStore["createImport"]>[0],
  ): Promise<ImportJobRecord> {
    return this.database.transaction(async (transaction) => {
      const source = requiredRow(
        await transaction
          .insert(apiSources)
          .values({
            providerId: input.providerId,
            name: input.name,
            sourceKind: input.source.kind,
            sourceUrl: input.source.kind === "url" ? input.source.url : null,
          })
          .returning({ id: apiSources.id }),
        "a created API source",
      );

      const sourceVersion = input.snapshot
        ? requiredRow(
            await transaction
              .insert(apiSourceVersions)
              .values({
                apiSourceId: source.id,
                mediaType: input.snapshot.mediaType,
                objectKey: input.snapshot.objectKey,
                sha256: input.snapshot.sha256,
                createdBy: input.actorUserId,
              })
              .returning({ id: apiSourceVersions.id }),
            "a created API source version",
          )
        : undefined;

      const job = requiredRow(
        await transaction
          .insert(openApiImportJobs)
          .values({
            providerId: input.providerId,
            apiSourceId: source.id,
            sourceVersionId: sourceVersion?.id ?? null,
            limitsSnapshot: input.limits,
            createdBy: input.actorUserId,
          })
          .returning(),
        "a queued OpenAPI import job",
      );
      await transaction.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        providerId: input.providerId,
        eventType: "openapi_import.queued",
        subjectType: "openapi_import_job",
        subjectId: job.id,
        requestId: input.requestId,
        metadata: {
          sourceKind: input.source.kind,
          sourceVersionId: sourceVersion?.id ?? null,
        },
      });
      await transaction.insert(outboxEvents).values({
        topic: "openapi.import.requests",
        aggregateType: "openapi_import_job",
        aggregateId: job.id,
        eventType: "openapi_import.queued",
        payload: {
          importJobId: job.id,
          providerId: input.providerId,
          apiSourceId: source.id,
          sourceKind: input.source.kind,
          sourceVersionId: sourceVersion?.id ?? null,
        },
      });
      return job;
    });
  }

  async getImport(jobId: string): Promise<ImportJobRecord | undefined> {
    return (
      await this.database
        .select()
        .from(openApiImportJobs)
        .where(eq(openApiImportJobs.id, jobId))
        .limit(1)
    )[0];
  }
}
