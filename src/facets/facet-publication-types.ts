export type PublishedVisibility = "public" | "unlisted";

export interface FacetPublicationContext {
  facetId: string;
  facetVersionId: string;
  providerId: string;
  displayVersion: string;
  facetStatus: "draft" | "published" | "disabled" | "deprecated";
  facetVersionStatus: "draft" | "valid" | "published" | "disabled";
  version: number;
  manifest: Record<string, unknown>;
  validationStatus: "pending" | "invalid" | "valid";
  endpointConfigured: boolean;
}

export interface PublishedFacetVersion {
  facetId: string;
  facetVersionId: string;
  displayVersion: string;
  visibility: PublishedVisibility;
  contentHash: string;
  publishedAt: string;
  facetVersion: number;
  facetRevision: number;
}

export interface FacetPublicationStore {
  getContext(
    facetVersionId: string,
  ): Promise<FacetPublicationContext | undefined>;
  publish(input: {
    actorUserId: string;
    providerId: string;
    facetVersionId: string;
    expectedVersion: number;
    visibility: PublishedVisibility;
    requestId: string;
  }): Promise<PublishedFacetVersion | undefined>;
}
