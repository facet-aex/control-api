export type EndpointAuthKind =
  "none" | "api_key_header" | "api_key_query" | "bearer";

export interface FacetVersionEndpointContext {
  facetVersionId: string;
  providerId: string;
  provider: string;
  facetName: string;
  version: string;
  status: "draft" | "valid" | "published" | "disabled";
  revision: number;
  method: string;
  pathTemplate: string;
}

export interface EndpointConfigRecord {
  provider: string;
  facetName: string;
  version: string;
  facetVersionRevision: number;
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
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EndpointConfigStore {
  getContextByName(
    provider: string,
    facetName: string,
    version: string,
  ): Promise<FacetVersionEndpointContext | undefined>;
  configure(input: {
    actorUserId: string;
    providerId: string;
    facetVersionId: string;
    expectedRevision: number;
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
