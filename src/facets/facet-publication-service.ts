import type { AuthenticatedIdentity } from "../auth/types.js";
import { AppError } from "../errors.js";
import {
  isValidFacetName,
  isValidSemver,
  isValidUsername,
} from "../identifiers.js";
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
      provider: saved.provider,
      facetName: saved.facetName,
      facetDisplayName: saved.facetDisplayName,
      facetType: saved.facetType,
      status: "PUBLISHED" as const,
      visibility,
      currentPublishedVersion: saved.version,
      revision: saved.facetRevision,
    },
    facetVersion: {
      provider: saved.provider,
      facetName: saved.facetName,
      version: saved.version,
      status: "PUBLISHED" as const,
      visibility,
      contentHash: saved.contentHash,
      publishedAt: saved.publishedAt,
      revision: saved.facetVersionRevision,
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
      provider: string;
      facetName: string;
      version: string;
      revision: number;
      visibility: PublishedVisibility;
    },
    requestId: string,
  ) {
    if (
      !isValidUsername(input.provider) ||
      !isValidFacetName(input.facetName) ||
      !isValidSemver(input.version)
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Invalid provider, facetName, or version.",
        422,
      );
    }

    const actor = await this.providers.upsertUser(identity);
    if (actor.status !== "active") {
      throw new AppError("FORBIDDEN", "User account is disabled.", 403);
    }
    if (actor.username !== input.provider) {
      throw new AppError(
        "FORBIDDEN",
        "Authenticated user does not own this provider namespace.",
        403,
      );
    }

    const context = await this.publications.getContextByName(
      input.provider,
      input.facetName,
      input.version,
    );
    if (!context || context.providerId !== actor.id) {
      throw new AppError("RESOURCE_NOT_FOUND", "Facet version not found.", 404);
    }

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
      facetVersionId: context.facetVersionId,
      expectedRevision: input.revision,
      visibility: input.visibility,
      requestId,
    });
    if (!saved) {
      throw new AppError("RESOURCE_NOT_FOUND", "Facet version not found.", 404);
    }
    return toPublic(saved);
  }
}
