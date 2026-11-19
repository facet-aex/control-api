import { Buffer } from "node:buffer";

import type { AuthenticatedIdentity } from "../auth/types.js";
import { AppError } from "../errors.js";
import type { ProviderStore } from "../providers/provider-types.js";
import type { ObjectStore } from "../storage/object-store.js";
import type {
  ImportJobRecord,
  ImportLimitsSnapshot,
  ImportSourceInput,
  ImportStore,
} from "./import-types.js";

function toImportJob(job: ImportJobRecord) {
  return {
    id: job.id,
    providerId: job.providerId,
    apiSourceId: job.apiSourceId,
    sourceVersionId: job.sourceVersionId,
    status: job.status,
    warnings: Array.isArray(job.warnings) ? job.warnings : [],
    errorCode: job.errorCode,
    errorSummary: job.errorSummary,
    createdAt: job.createdAt.toISOString(),
  };
}

function toOperationCandidate(
  candidate: Awaited<ReturnType<ImportStore["listCandidates"]>>[number],
) {
  return {
    id: candidate.id,
    jsonPointer: candidate.jsonPointer,
    operationId: candidate.operationId,
    method: candidate.method,
    path: candidate.pathTemplate,
    summary: candidate.summary,
    normalizedCandidate: candidate.normalizedCandidate,
    warnings: Array.isArray(candidate.warnings) ? candidate.warnings : [],
  };
}

export class ImportService {
  constructor(
    private readonly providers: ProviderStore,
    private readonly imports: ImportStore,
    private readonly objects: ObjectStore,
    private readonly limits: ImportLimitsSnapshot,
  ) {}

  private requireJobOwner(actorUserId: string, job: ImportJobRecord): void {
    if (job.providerId !== actorUserId) {
      throw new AppError(
        "AUTHORIZATION_DENIED",
        "The authenticated user is not authorized for this import job.",
        403,
      );
    }
  }

  async create(
    identity: AuthenticatedIdentity,
    input: { name: string; source: ImportSourceInput },
    requestId: string,
  ) {
    const actor = await this.providers.upsertUser(identity);

    if (
      input.source.kind !== "url" &&
      Buffer.byteLength(input.source.content, "utf8") >
        this.limits.maxDocumentBytes
    ) {
      throw new AppError(
        "IMPORT_TOO_LARGE",
        "The OpenAPI source exceeds the configured byte limit.",
        413,
      );
    }

    const snapshot =
      input.source.kind === "url"
        ? undefined
        : await this.objects.putImmutable(
            Buffer.from(input.source.content, "utf8"),
          );
    const job = await this.imports.createImport({
      actorUserId: actor.id,
      providerId: actor.id,
      name: input.name,
      source: input.source,
      ...(snapshot
        ? {
            snapshot: {
              objectKey: snapshot.objectKey,
              sha256: snapshot.sha256,
              mediaType:
                input.source.kind === "url"
                  ? null
                  : (input.source.mediaType ?? null),
            },
          }
        : {}),
      limits: this.limits,
      requestId,
    });
    return toImportJob(job);
  }

  async get(identity: AuthenticatedIdentity, jobId: string) {
    const actor = await this.providers.upsertUser(identity);
    const job = await this.imports.getImport(jobId);
    if (!job) {
      throw new AppError("RESOURCE_NOT_FOUND", "Import job not found.", 404);
    }
    this.requireJobOwner(actor.id, job);
    return toImportJob(job);
  }

  async listCandidates(identity: AuthenticatedIdentity, jobId: string) {
    const actor = await this.providers.upsertUser(identity);
    const job = await this.imports.getImport(jobId);
    if (!job) {
      throw new AppError("RESOURCE_NOT_FOUND", "Import job not found.", 404);
    }
    this.requireJobOwner(actor.id, job);
    return (await this.imports.listCandidates(jobId)).map(toOperationCandidate);
  }
}
