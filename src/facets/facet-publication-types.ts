import type { FacetType } from "../identifiers.js";

export type PublishedVisibility = "public" | "unlisted";

export interface FacetPublicationContext {
  facetId: string;
  facetVersionId: string;
  providerId: string;
  provider: string;
  facetName: string;
  facetDisplayName: string;
  facetType: FacetType;
  version: string;
  facetStatus: "draft" | "published" | "disabled" | "deprecated";
  facetVersionStatus: "draft" | "valid" | "published" | "disabled";
  revision: number;
  manifest: Record<string, unknown>;
  validationStatus: "pending" | "invalid" | "valid";
  endpointConfigured: boolean;
}

export interface PublishedFacetVersion {
  provider: string;
  facetName: string;
  facetDisplayName: string;
  facetType: FacetType;
  version: string;
  visibility: PublishedVisibility;
  contentHash: string;
  publishedAt: string;
  facetVersionRevision: number;
  facetRevision: number;
}

export interface FacetPublicationStore {
  getContextByName(
    provider: string,
    facetName: string,
    version: string,
  ): Promise<FacetPublicationContext | undefined>;
  publish(input: {
    actorUserId: string;
    providerId: string;
    facetVersionId: string;
    expectedRevision: number;
    visibility: PublishedVisibility;
    requestId: string;
  }): Promise<PublishedFacetVersion | undefined>;
}
