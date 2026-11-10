import type { AuthenticatedIdentity } from "../auth/types.js";
import { AppError } from "../errors.js";
import { requireProviderPermission } from "../providers/provider-rbac.js";
import type { ProviderStore } from "../providers/provider-types.js";
import type {
  FacetPublicationStore,
  PublishedFacetVersion,
  PublishedVisibility,
} from "./facet-publication-types.js";

function toPublic(saved: PublishedFacetVersion) {
  const visibility = saved.visibility.toUpperCase() as "UNLISTED" | "PUBLIC";
  return {
    facet: {
      id: saved.facetId,
      status: "PUBLISHED" as const,
      visibility,
      currentPublishedVersionId: saved.facetVersionId,
      version: saved.facetRevision,
    },
    facetVersion: {
      id: saved.facetVersionId,
      facetId: saved.facetId,
      displayVersion: saved.displayVersion,
      status: "PUBLISHED" as const,
      visibility,
      contentHash: saved.contentHash,
      publishedAt: saved.publishedAt,
      version: saved.facetVersion,
    },
  };
}

export class FacetPublicationService {
  constructor(
    private readonly providers: ProviderStore,
    private readonly publications: FacetPublicationStore,
  ) {}

  async publish(
    identity: AuthenticatedIdentity,
    input: {
      facetVersionId: string;
      version: number;
      visibility: PublishedVisibility;
    },
    requestId: string,
  ) {
    const context = await this.publications.getContext(input.facetVersionId);
    if (!context) {
      throw new AppError("RESOURCE_NOT_FOUND", "Facet version not found.", 404);
    }
    const actor = await this.providers.upsertUser(identity);
    const role = await this.providers.getMembershipRole(
      context.providerId,
      actor.id,
    );
    requireProviderPermission(role, "facet:write");

    if (
      context.facetStatus === "disabled" ||
      context.facetVersionStatus === "published" ||
      context.facetVersionStatus === "disabled"
    ) {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "This Facet Version cannot be published from its current state.",
        409,
      );
    }
    if (
      context.facetVersionStatus !== "valid" ||
      context.validationStatus !== "valid" ||
      !context.endpointConfigured
    ) {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "Only a valid configured Facet Version can be published.",
        409,
      );
    }

    const saved = await this.publications.publish({
      actorUserId: actor.id,
      providerId: context.providerId,
      facetVersionId: input.facetVersionId,
      expectedVersion: input.version,
      visibility: input.visibility,
      requestId,
    });
    if (!saved) {
      throw new AppError("RESOURCE_NOT_FOUND", "Facet version not found.", 404);
    }
    return toPublic(saved);
  }
}
