export type SideEffectClass =
  "READ_ONLY" | "IDEMPOTENT_WRITE" | "NON_IDEMPOTENT_WRITE" | "UNKNOWN";

export interface FacetDraftSelection {
  operationCandidateId: string;
  slug: string;
  name: string;
  summary?: string | undefined;
  description?: string | undefined;
  category: string;
  tags: string[];
  sideEffectClass: SideEffectClass;
}

export interface FacetDraftRecord {
  facetId: string;
  providerId: string;
  slug: string;
  facetStatus: "draft";
  visibility: "private";
  facetRevision: number;
  createdAt: Date;
  facetVersionId: string;
  displayVersion: string;
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
    importJobId: string;
    selections: FacetDraftSelection[];
    requestId: string;
  }): Promise<FacetDraftRecord[]>;
}
