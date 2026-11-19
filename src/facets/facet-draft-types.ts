export type SideEffectClass =
  "READ_ONLY" | "IDEMPOTENT_WRITE" | "NON_IDEMPOTENT_WRITE" | "UNKNOWN";

export interface FacetDraftSelection {
  operationCandidateId: string;
  facetName: string;
  facetDisplayName: string;
  version?: string | undefined;
  summary?: string | undefined;
  description?: string | undefined;
  category: string;
  tags: string[];
  sideEffectClass: SideEffectClass;
}

export interface FacetDraftRecord {
  facetId: string;
  providerId: string;
  provider: string;
  facetName: string;
  facetDisplayName: string;
  facetStatus: "draft";
  visibility: "private";
  facetRevision: number;
  createdAt: Date;
  facetVersionId: string;
  version: string;
  facetVersionStatus: "draft";
  sourceVersionId: string;
  sourceOperationPointer: string;
  contentHash: string;
  facetVersionRevision: number;
  validationResult: {
    status: "pending";
    errors: unknown[];
    warnings: unknown[];
  };
}

export interface FacetDraftStore {
  createDrafts(input: {
    actorUserId: string;
    providerId: string;
    providerUsername: string;
    importJobId: string;
    selections: FacetDraftSelection[];
    requestId: string;
  }): Promise<FacetDraftRecord[]>;
}
