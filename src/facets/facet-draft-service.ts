import type { AuthenticatedIdentity } from "../auth/types.js";
import { AppError } from "../errors.js";
import type { ProviderStore } from "../providers/provider-types.js";
import type {
  FacetDraftRecord,
  FacetDraftSelection,
  FacetDraftStore,
} from "./facet-draft-types.js";

function ensureUniqueSelections(selections: FacetDraftSelection[]): void {
  const candidateIds = new Set<string>();
  const facetNames = new Set<string>();
  for (const selection of selections) {
    if (candidateIds.has(selection.operationCandidateId)) {
      throw new AppError(
        "INPUT_INVALID",
        "Each operation candidate may be selected only once per batch.",
        400,
      );
    }
    if (facetNames.has(selection.facetName)) {
      throw new AppError(
        "INPUT_INVALID",
        "Each facetName must be unique within the batch.",
        400,
      );
    }
    candidateIds.add(selection.operationCandidateId);
    facetNames.add(selection.facetName);
  }
}

function toFacetDraft(record: FacetDraftRecord) {
  return {
    provider: record.provider,
    facetName: record.facetName,
    facetDisplayName: record.facetDisplayName,
    type: "API" as const,
    status: "DRAFT" as const,
    visibility: "PRIVATE" as const,
    revision: record.facetRevision,
    createdAt: record.createdAt.toISOString(),
    draftVersion: {
      version: record.version,
      status: "DRAFT" as const,
      sourceVersionId: record.sourceVersionId,
      sourceOperationPointer: record.sourceOperationPointer,
      contentHash: record.contentHash,
      revision: record.facetVersionRevision,
      validation: {
        status: "PENDING" as const,
        errors: record.validationResult.errors,
        warnings: record.validationResult.warnings,
      },
    },
  };
}

export class FacetDraftService {
  constructor(
    private readonly providers: ProviderStore,
    private readonly drafts: FacetDraftStore,
  ) {}

  async create(
    identity: AuthenticatedIdentity,
    input: {
      importJobId: string;
      selections: FacetDraftSelection[];
    },
    requestId: string,
  ) {
    ensureUniqueSelections(input.selections);
    const actor = await this.providers.upsertUser(identity);

    const records = await this.drafts.createDrafts({
      actorUserId: actor.id,
      providerId: actor.id,
      providerUsername: actor.username,
      importJobId: input.importJobId,
      selections: input.selections,
      requestId,
    });
    return records.map(toFacetDraft);
  }
}
