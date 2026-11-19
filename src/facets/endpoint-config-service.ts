import type { AuthenticatedIdentity } from "../auth/types.js";
import { AppError } from "../errors.js";
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
      provider: record.provider,
      facetName: record.facetName,
      version: record.version,
      facetVersionRevision: record.facetVersionRevision,
      baseUrlConfigured: true as const,
      method: record.method,
      pathTemplate: record.pathTemplate,
      authKind: record.authKind.toUpperCase() as PublicAuthKind,
      secretConfigured: record.secretRefId !== null,
      timeoutMs: record.timeoutMs,
      maxResponseBytes: record.maxResponseBytes,
      redirectPolicy: record.redirectPolicy.toUpperCase() as
        "DENY" | "SAME_ORIGIN",
      revision: record.revision,
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
      provider: string;
      facetName: string;
      version: string;
      revision: number;
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
    const actor = await this.providers.upsertUser(identity);
    if (actor.username !== input.provider) {
      throw new AppError(
        "AUTHORIZATION_DENIED",
        "The authenticated user is not authorized for this provider.",
        403,
      );
    }
    const context = await this.endpoints.getContextByName(
      input.provider,
      input.facetName,
      input.version,
    );
    if (!context || context.providerId !== actor.id) {
      throw new AppError("RESOURCE_NOT_FOUND", "Facet version not found.", 404);
    }
    if (context.status !== "draft") {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "Only a draft Facet Version can be configured.",
        409,
      );
    }

    const record = await this.endpoints.configure({
      actorUserId: actor.id,
      providerId: actor.id,
      facetVersionId: context.facetVersionId,
      expectedRevision: input.revision,
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
