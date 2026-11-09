import type { AuthenticatedIdentity } from "../auth/types.js";
import { AppError } from "../errors.js";
import { requireProviderPermission } from "../providers/provider-rbac.js";
import type { ProviderStore } from "../providers/provider-types.js";
import type {
  FacetDraftRecord,
  FacetDraftSelection,
  FacetDraftStore,
} from "./facet-draft-types.js";

function ensureUniqueSelections(selections: FacetDraftSelection[]): void {
  const candidateIds = new Set<string>();
  const slugs = new Set<string>();
  for (const selection of selections) {
    if (candidateIds.has(selection.operationCandidateId)) {
      throw new AppError(
        "INPUT_INVALID",
        "Each operation candidate may be selected only once per batch.",
        400,
      );
    }
    if (slugs.has(selection.slug)) {
      throw new AppError(
        "INPUT_INVALID",
        "Each Facet slug must be unique within the batch.",
        400,
      );
    }
    candidateIds.add(selection.operationCandidateId);
    slugs.add(selection.slug);
  }
}

function toFacetDraft(record: FacetDraftRecord) {
  return {
    id: record.facetId,
    providerId: record.providerId,
    slug: record.slug,
    type: "EXTERNAL_HTTP_API" as const,
    status: "DRAFT" as const,
    visibility: "PRIVATE" as const,
    version: record.facetRevision,
    createdAt: record.createdAt.toISOString(),
    draftVersion: {
      id: record.facetVersionId,
      displayVersion: record.displayVersion,
      status: "DRAFT" as const,
      sourceVersionId: record.sourceVersionId,
      sourceOperationPointer: record.sourceOperationPointer,
      contentHash: record.contentHash,
      version: record.facetVersionRevision,
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
      providerId: string;
      importJobId: string;
      selections: FacetDraftSelection[];
    },
    requestId: string,
  ) {
    ensureUniqueSelections(input.selections);
    const actor = await this.providers.upsertUser(identity);
    const role = await this.providers.getMembershipRole(
      input.providerId,
      actor.id,
    );
    requireProviderPermission(role, "facet:write");

    const records = await this.drafts.createDrafts({
      actorUserId: actor.id,
      providerId: input.providerId,
      importJobId: input.importJobId,
      selections: input.selections,
      requestId,
    });
    return records.map(toFacetDraft);
  }
}
