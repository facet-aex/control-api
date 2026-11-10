export type EndpointAuthKind =
  "none" | "api_key_header" | "api_key_query" | "bearer";

export interface FacetVersionEndpointContext {
  facetVersionId: string;
  providerId: string;
  status: "draft" | "valid" | "published" | "disabled";
  version: number;
  method: string;
  pathTemplate: string;
}

export interface EndpointConfigRecord {
  id: string;
  facetVersionId: string;
  facetVersionVersion: number;
  providerId: string;
  protectedBaseUrl: string;
  method: string;
  pathTemplate: string;
  authKind: EndpointAuthKind;
  authTemplate: Record<string, unknown>;
  secretRefId: string | null;
  timeoutMs: number;
  maxResponseBytes: number;
  redirectPolicy: "deny" | "same_origin";
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EndpointConfigStore {
  getContext(
    facetVersionId: string,
  ): Promise<FacetVersionEndpointContext | undefined>;
  configure(input: {
    actorUserId: string;
    providerId: string;
    facetVersionId: string;
    expectedVersion: number;
    baseUrl: string;
    authKind: EndpointAuthKind;
    authTemplate: Record<string, unknown>;
    secretRefId: string | null;
    timeoutMs: number;
    maxResponseBytes: number;
    redirectPolicy: "deny" | "same_origin";
    egressPolicyId: string;
    requestId: string;
  }): Promise<EndpointConfigRecord | undefined>;
}
