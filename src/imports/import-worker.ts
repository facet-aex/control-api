import { createHash } from "node:crypto";

import type { ObjectStore } from "../storage/object-store.js";
import {
  ImporterClientError,
  type ImporterClient,
  type ImporterResult,
} from "./importer-client.js";
import type {
  ImportWorkerStore,
  ImportWorkItem,
} from "./import-worker-types.js";
import { ImportWorkerTerminalError } from "./import-worker-types.js";

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function safeErrorSummary(error: unknown): string {
  return error instanceof ImporterClientError ||
    error instanceof ImportWorkerTerminalError
    ? error.message.slice(0, 500)
    : "The import worker failed unexpectedly.";
}

function verifyResult(
  work: ImportWorkItem,
  result: ImporterResult,
): Uint8Array {
  if (result.source.kind !== work.sourceKind) {
    throw new ImporterClientError(
      "IMPORTER_SOURCE_KIND_MISMATCH",
      "The importer returned a different source kind.",
      false,
    );
  }
  const bytes = Buffer.from(result.snapshot.content, "utf8");
  if (
    bytes.byteLength !== result.source.byteLength ||
    sha256(bytes) !== result.source.sha256
  ) {
    throw new ImporterClientError(
      "IMPORTER_SNAPSHOT_INTEGRITY_FAILED",
      "The importer snapshot did not match its provenance.",
      false,
    );
  }
  if (work.sourceSha256 && work.sourceSha256 !== result.source.sha256) {
    throw new ImporterClientError(
      "IMPORTER_SOURCE_CHANGED",
      "The importer result did not match the queued source snapshot.",
      false,
    );
  }
  return bytes;
}

export class ImportWorker {
  constructor(
    private readonly store: ImportWorkerStore,
    private readonly objects: ObjectStore,
    private readonly importer: ImporterClient,
    private readonly settings: {
      leaseMs: number;
      maxAttempts: number;
      retryBaseMs: number;
    },
  ) {}

  async runOnce(): Promise<"idle" | "completed" | "retried" | "failed"> {
    const claim = await this.store.claimNext(this.settings.leaseMs);
    if (!claim) return "idle";

    let work: ImportWorkItem | undefined;
    try {
      work = await this.store.loadWork(claim);
      const source = await this.loadSource(work);
      const result = await this.importer.parse(
        source,
        work.limits,
        claim.eventId,
      );
      const snapshotBytes = verifyResult(work, result);
      const stored = work.objectKey
        ? {
            objectKey: work.objectKey,
            sha256: work.sourceSha256 ?? sha256(snapshotBytes),
          }
        : await this.objects.putImmutable(snapshotBytes);
      if (stored.sha256 !== result.source.sha256) {
        throw new ImporterClientError(
          "OBJECT_SNAPSHOT_MISMATCH",
          "The stored source snapshot did not match importer provenance.",
          false,
        );
      }
      await this.store.complete(claim, work, {
        result,
        objectKey: stored.objectKey,
        sha256: stored.sha256,
        mediaType: result.source.mediaType ?? work.sourceMediaType,
      });
      return "completed";
    } catch (error) {
      const jobId = work?.importJobId ?? claim.importJobId;
      const retryable =
        error instanceof ImporterClientError
          ? error.retryable
          : !(error instanceof ImportWorkerTerminalError);
      const summary = safeErrorSummary(error);
      if (retryable && claim.attemptCount < this.settings.maxAttempts) {
        const delay =
          this.settings.retryBaseMs * 2 ** Math.max(claim.attemptCount - 1, 0);
        await this.store.retry(
          claim,
          jobId,
          new Date(Date.now() + delay),
          summary,
        );
        return "retried";
      }
      await this.store.fail(
        claim,
        jobId,
        error instanceof ImporterClientError
          ? error.code
          : error instanceof ImportWorkerTerminalError
            ? error.code
            : "IMPORT_WORKER_FAILED",
        summary,
      );
      return "failed";
    }
  }

  private async loadSource(work: ImportWorkItem) {
    if (work.sourceKind === "url") {
      if (!work.sourceUrl) {
        throw new ImporterClientError(
          "IMPORT_SOURCE_MISSING",
          "The queued URL source is missing.",
          false,
        );
      }
      return { kind: "url" as const, url: work.sourceUrl };
    }
    if (!work.objectKey) {
      throw new ImporterClientError(
        "IMPORT_SOURCE_MISSING",
        "The queued source snapshot is missing.",
        false,
      );
    }
    const content = Buffer.from(
      await this.objects.get(work.objectKey),
    ).toString("utf8");
    return { kind: work.sourceKind, content };
  }
}
