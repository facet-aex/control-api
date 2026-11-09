import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import type {
  ClaimedImportEvent,
  CompletedImport,
  ImportWorkerStore,
  ImportWorkItem,
} from "./import-worker-types.js";
import { ImportWorkerTerminalError } from "./import-worker-types.js";

const limitsSchema = z.object({
  maxDocumentBytes: z.number().int().positive(),
  maxYamlAliases: z.number().int().min(0),
  maxRedirects: z.number().int().min(0),
  maxReferenceDepth: z.number().int().positive(),
  maxReferenceCount: z.number().int().positive(),
  maxOperationCount: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});

interface ClaimedRow {
  id: string;
  aggregate_id: string;
  claim_token: string;
  attempt_count: number;
}

interface WorkRow {
  import_job_id: string;
  provider_id: string;
  api_source_id: string;
  source_version_id: string | null;
  source_kind: "paste" | "upload" | "url";
  source_url: string | null;
  object_key: string | null;
  source_sha256: string | null;
  source_media_type: string | null;
  created_by: string;
  limits_snapshot: unknown;
  status: string;
}

async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function lockClaim(
  client: PoolClient,
  claim: ClaimedImportEvent,
): Promise<void> {
  const locked = await client.query(
    `select id
       from outbox_events
      where id = $1::uuid
        and claim_token = $2::uuid
        and processed_at is null
      for update`,
    [claim.eventId, claim.claimToken],
  );
  if (locked.rowCount !== 1) {
    throw new Error("The import worker claim is stale or no longer active.");
  }
}

export class PostgresImportWorkerStore implements ImportWorkerStore {
  constructor(private readonly pool: Pool) {}

  async claimNext(leaseMs: number): Promise<ClaimedImportEvent | undefined> {
    const claimToken = randomUUID();
    const result = await this.pool.query<ClaimedRow>(
      `with next_event as (
         select id
           from outbox_events
          where topic = 'openapi.import.requests'
            and processed_at is null
            and available_at <= now()
            and (lease_expires_at is null or lease_expires_at <= now())
          order by created_at, id
          for update skip locked
          limit 1
       )
       update outbox_events as event
          set claim_token = $1::uuid,
              lease_expires_at = now() + ($2::double precision * interval '1 millisecond'),
              attempt_count = event.attempt_count + 1,
              last_error = null
         from next_event
        where event.id = next_event.id
       returning event.id::text,
                 event.aggregate_id,
                 event.claim_token::text,
                 event.attempt_count`,
      [claimToken, leaseMs],
    );
    const row = result.rows[0];
    return row
      ? {
          eventId: row.id,
          claimToken: row.claim_token,
          importJobId: row.aggregate_id,
          attemptCount: row.attempt_count,
        }
      : undefined;
  }

  async loadWork(claim: ClaimedImportEvent): Promise<ImportWorkItem> {
    return withTransaction(this.pool, async (client) => {
      await lockClaim(client, claim);
      const result = await client.query<WorkRow>(
        `select job.id::text as import_job_id,
                job.provider_id::text,
                job.api_source_id::text,
                job.source_version_id::text,
                job.created_by::text,
                job.limits_snapshot,
                job.status::text,
                source.source_kind::text,
                source.source_url,
                version.object_key,
                version.sha256 as source_sha256,
                version.media_type as source_media_type
           from openapi_import_jobs as job
           join api_sources as source on source.id = job.api_source_id
           left join api_source_versions as version
             on version.id = job.source_version_id
          where job.id = $1::uuid
          for update of job`,
        [claim.importJobId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ImportWorkerTerminalError(
          "IMPORT_JOB_MISSING",
          "The queued import job no longer exists.",
        );
      }
      if (!["queued", "fetching"].includes(row.status)) {
        throw new ImportWorkerTerminalError(
          "IMPORT_JOB_NOT_PROCESSABLE",
          "The import job is not in a processable state.",
        );
      }
      const limits = limitsSchema.safeParse(row.limits_snapshot);
      if (!limits.success) {
        throw new ImportWorkerTerminalError(
          "IMPORT_LIMITS_INVALID",
          "The import job limits snapshot is invalid.",
        );
      }
      await client.query(
        `update openapi_import_jobs
            set status = 'fetching',
                started_at = coalesce(started_at, now()),
                error_code = null,
                error_summary = null
          where id = $1::uuid`,
        [claim.importJobId],
      );
      return {
        importJobId: row.import_job_id,
        providerId: row.provider_id,
        apiSourceId: row.api_source_id,
        sourceVersionId: row.source_version_id,
        sourceKind: row.source_kind,
        sourceUrl: row.source_url,
        objectKey: row.object_key,
        sourceSha256: row.source_sha256,
        sourceMediaType: row.source_media_type,
        createdBy: row.created_by,
        limits: limits.data,
      };
    });
  }

  async complete(
    claim: ClaimedImportEvent,
    work: ImportWorkItem,
    completed: CompletedImport,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await lockClaim(client, claim);
      let sourceVersionId = work.sourceVersionId;
      if (!sourceVersionId) {
        const inserted = await client.query<{ id: string }>(
          `insert into api_source_versions
             (api_source_id, media_type, object_key, sha256, openapi_version, created_by)
           values ($1::uuid, $2, $3, $4, $5, $6::uuid)
           on conflict (api_source_id, sha256) do update
             set openapi_version = excluded.openapi_version
           returning id::text`,
          [
            work.apiSourceId,
            completed.mediaType,
            completed.objectKey,
            completed.sha256,
            completed.result.document.openapi,
            work.createdBy,
          ],
        );
        sourceVersionId = inserted.rows[0]?.id ?? null;
      } else {
        await client.query(
          `update api_source_versions
              set openapi_version = $2
            where id = $1::uuid`,
          [sourceVersionId, completed.result.document.openapi],
        );
      }
      if (!sourceVersionId) {
        throw new Error("The completed import has no source version.");
      }

      await client.query(
        "delete from import_operation_candidates where import_job_id = $1::uuid",
        [work.importJobId],
      );
      for (const candidate of completed.result.candidates) {
        await client.query(
          `insert into import_operation_candidates
             (import_job_id, json_pointer, operation_id, method, path_template, summary, normalized_candidate, warnings)
           values ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
          [
            work.importJobId,
            candidate.jsonPointer,
            candidate.operationId ?? null,
            candidate.method,
            candidate.path,
            candidate.summary ?? null,
            JSON.stringify(candidate),
            JSON.stringify(candidate.warnings),
          ],
        );
      }
      await client.query(
        `update openapi_import_jobs
            set source_version_id = $2::uuid,
                status = 'ready',
                warnings = $3::jsonb,
                error_code = null,
                error_summary = null,
                completed_at = now()
          where id = $1::uuid`,
        [
          work.importJobId,
          sourceVersionId,
          JSON.stringify(completed.result.warnings),
        ],
      );
      await client.query(
        `insert into audit_events
           (actor_user_id, provider_id, event_type, subject_type, subject_id, request_id, metadata)
         values ($1::uuid, $2::uuid, 'openapi_import.ready', 'openapi_import_job', $3, $4, $5::jsonb)`,
        [
          work.createdBy,
          work.providerId,
          work.importJobId,
          claim.eventId,
          JSON.stringify({
            candidateCount: completed.result.candidates.length,
            sourceVersionId,
          }),
        ],
      );
      await client.query(
        `update outbox_events
            set processed_at = now(),
                lease_expires_at = null,
                claim_token = null,
                last_error = null
          where id = $1::uuid and claim_token = $2::uuid`,
        [claim.eventId, claim.claimToken],
      );
    });
  }

  async retry(
    claim: ClaimedImportEvent,
    importJobId: string,
    availableAt: Date,
    errorSummary: string,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await lockClaim(client, claim);
      await client.query(
        `update openapi_import_jobs
            set status = 'queued', error_summary = $2
          where id = $1::uuid and status not in ('ready', 'failed', 'expired')`,
        [importJobId, errorSummary],
      );
      await client.query(
        `update outbox_events
            set available_at = $3,
                lease_expires_at = null,
                claim_token = null,
                last_error = $4
          where id = $1::uuid and claim_token = $2::uuid`,
        [claim.eventId, claim.claimToken, availableAt, errorSummary],
      );
    });
  }

  async fail(
    claim: ClaimedImportEvent,
    importJobId: string,
    errorCode: string,
    errorSummary: string,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await lockClaim(client, claim);
      const job = await client.query<{
        provider_id: string;
        created_by: string;
      }>(
        `update openapi_import_jobs
            set status = 'failed',
                error_code = $2,
                error_summary = $3,
                completed_at = now()
          where id = $1::uuid
            and status not in ('ready', 'expired')
          returning provider_id::text, created_by::text`,
        [importJobId, errorCode, errorSummary],
      );
      const row = job.rows[0];
      if (row) {
        await client.query(
          `insert into audit_events
             (actor_user_id, provider_id, event_type, subject_type, subject_id, request_id, metadata)
           values ($1::uuid, $2::uuid, 'openapi_import.failed', 'openapi_import_job', $3, $4, $5::jsonb)`,
          [
            row.created_by,
            row.provider_id,
            importJobId,
            claim.eventId,
            JSON.stringify({ errorCode }),
          ],
        );
      }
      await client.query(
        `update outbox_events
            set processed_at = now(),
                lease_expires_at = null,
                claim_token = null,
                last_error = $3
          where id = $1::uuid and claim_token = $2::uuid`,
        [claim.eventId, claim.claimToken, errorSummary],
      );
    });
  }
}
