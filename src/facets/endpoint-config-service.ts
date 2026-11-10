import type { AuthenticatedIdentity } from "../auth/types.js";
import { AppError } from "../errors.js";
import { requireProviderPermission } from "../providers/provider-rbac.js";
import type { ProviderStore } from "../providers/provider-types.js";
import type {
  EndpointAuthKind,
  EndpointConfigRecord,
  EndpointConfigStore,
} from "./endpoint-config-types.js";

type PublicAuthKind = "NONE" | "API_KEY_HEADER" | "API_KEY_QUERY" | "BEARER";

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new AppError(
      "INPUT_INVALID",
      "The endpoint base URL must be HTTPS and cannot contain credentials, query, or fragment components.",
      400,
    );
  }
  return url.toString();
}

function toInternalAuth(kind: PublicAuthKind): EndpointAuthKind {
  return kind.toLowerCase() as EndpointAuthKind;
}

function toPublic(record: EndpointConfigRecord) {
  return {
    endpointConfig: {
      id: record.id,
      facetVersionId: record.facetVersionId,
      facetVersionVersion: record.facetVersionVersion,
      baseUrlConfigured: true as const,
      method: record.method,
      pathTemplate: record.pathTemplate,
      authKind: record.authKind.toUpperCase() as PublicAuthKind,
      secretRefId: record.secretRefId,
      timeoutMs: record.timeoutMs,
      maxResponseBytes: record.maxResponseBytes,
      redirectPolicy: record.redirectPolicy.toUpperCase() as
        "DENY" | "SAME_ORIGIN",
      version: record.version,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    },
  };
}

export class EndpointConfigService {
  constructor(
    private readonly providers: ProviderStore,
    private readonly endpoints: EndpointConfigStore,
  ) {}

  async configure(
    identity: AuthenticatedIdentity,
    input: {
      facetVersionId: string;
      version: number;
      baseUrl: string;
      auth:
        | { kind: "NONE" }
        | { kind: "BEARER"; secretRefId: string }
        | {
            kind: "API_KEY_HEADER" | "API_KEY_QUERY";
            secretRefId: string;
            parameterName: string;
          };
      timeoutMs: number;
      maxResponseBytes: number;
      redirectPolicy: "DENY" | "SAME_ORIGIN";
    },
    requestId: string,
  ) {
    const context = await this.endpoints.getContext(input.facetVersionId);
    if (!context) {
      throw new AppError("RESOURCE_NOT_FOUND", "Facet version not found.", 404);
    }
    const actor = await this.providers.upsertUser(identity);
    const role = await this.providers.getMembershipRole(
      context.providerId,
      actor.id,
    );
    requireProviderPermission(role, "facet:write");
    if (context.status !== "draft") {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "Only a draft Facet Version can be configured.",
        409,
      );
    }

    const record = await this.endpoints.configure({
      actorUserId: actor.id,
      providerId: context.providerId,
      facetVersionId: input.facetVersionId,
      expectedVersion: input.version,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      authKind: toInternalAuth(input.auth.kind),
      authTemplate:
        "parameterName" in input.auth
          ? { parameterName: input.auth.parameterName }
          : {},
      secretRefId: "secretRefId" in input.auth ? input.auth.secretRefId : null,
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
      redirectPolicy: input.redirectPolicy.toLowerCase() as
        "deny" | "same_origin",
      egressPolicyId: "phase1-unverified",
      requestId,
    });
    if (!record) {
      throw new AppError("RESOURCE_NOT_FOUND", "Facet version not found.", 404);
    }
    return toPublic(record);
  }
}
