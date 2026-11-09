export type ImportSourceInput =
  | {
      kind: "paste" | "upload";
      content: string;
      mediaType?: string | undefined;
    }
  | { kind: "url"; url: string };

export interface ImportLimitsSnapshot {
  maxDocumentBytes: number;
  maxYamlAliases: number;
  maxRedirects: number;
  maxReferenceDepth: number;
  maxReferenceCount: number;
  maxOperationCount: number;
  timeoutMs: number;
}

export interface ImportSnapshotInput {
  objectKey: string;
  sha256: string;
  mediaType: string | null;
}

export interface ImportJobRecord {
  id: string;
  providerId: string;
  apiSourceId: string;
  sourceVersionId: string | null;
  status:
    | "queued"
    | "fetching"
    | "parsing"
    | "normalizing"
    | "ready"
    | "failed"
    | "expired";
  warnings: unknown;
  errorCode: string | null;
  errorSummary: string | null;
  createdAt: Date;
}

export interface ImportOperationCandidateRecord {
  id: string;
  importJobId: string;
  jsonPointer: string;
  operationId: string | null;
  method: string;
  pathTemplate: string;
  summary: string | null;
  normalizedCandidate: unknown;
  warnings: unknown;
}

export interface ImportStore {
  createImport(input: {
    actorUserId: string;
    providerId: string;
    name: string;
    source: ImportSourceInput;
    snapshot?: ImportSnapshotInput;
    limits: ImportLimitsSnapshot;
    requestId: string;
  }): Promise<ImportJobRecord>;
  getImport(jobId: string): Promise<ImportJobRecord | undefined>;
  listCandidates(jobId: string): Promise<ImportOperationCandidateRecord[]>;
}
