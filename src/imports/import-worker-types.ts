import type { ImporterResult } from "./importer-client.js";
import type { ImportLimitsSnapshot } from "./import-types.js";

export class ImportWorkerTerminalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ImportWorkerTerminalError";
  }
}

export interface ClaimedImportEvent {
  eventId: string;
  claimToken: string;
  importJobId: string;
  attemptCount: number;
}

export interface ImportWorkItem {
  importJobId: string;
  providerId: string;
  apiSourceId: string;
  sourceVersionId: string | null;
  sourceKind: "paste" | "upload" | "url";
  sourceUrl: string | null;
  objectKey: string | null;
  sourceSha256: string | null;
  sourceMediaType: string | null;
  createdBy: string;
  limits: ImportLimitsSnapshot;
}

export interface CompletedImport {
  result: ImporterResult;
  objectKey: string;
  sha256: string;
  mediaType: string | null;
}

export interface ImportWorkerStore {
  claimNext(leaseMs: number): Promise<ClaimedImportEvent | undefined>;
  loadWork(claim: ClaimedImportEvent): Promise<ImportWorkItem>;
  complete(
    claim: ClaimedImportEvent,
    work: ImportWorkItem,
    completed: CompletedImport,
  ): Promise<void>;
  retry(
    claim: ClaimedImportEvent,
    importJobId: string,
    availableAt: Date,
    errorSummary: string,
  ): Promise<void>;
  fail(
    claim: ClaimedImportEvent,
    importJobId: string,
    errorCode: string,
    errorSummary: string,
  ): Promise<void>;
}
