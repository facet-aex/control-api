import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { AppError } from "../src/errors.js";
import { EndpointConfigService } from "../src/facets/endpoint-config-service.js";
import type {
  EndpointConfigRecord,
  EndpointConfigStore,
  FacetVersionEndpointContext,
} from "../src/facets/endpoint-config-types.js";
import { ProviderService } from "../src/providers/provider-service.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

class MemoryEndpointConfigStore implements EndpointConfigStore {
  readonly contexts = new Map<string, FacetVersionEndpointContext>();
  readonly configs = new Map<string, EndpointConfigRecord>();
  readonly secrets = new Map<
    string,
    {
      providerId: string;
      kind: "api_key" | "bearer_token";
      status: "active" | "revoked";
    }
  >();

  seedVersion(providerId: string, status: "draft" | "published" = "draft") {
    const versionId = randomUUID();
    this.contexts.set(versionId, {
      facetVersionId: versionId,
      providerId,
      status,
      version: 1,
      method: "GET",
      pathTemplate: "/repos/{owner}/{repo}",
    });
    return versionId;
  }

  seedSecret(providerId: string, kind: "api_key" | "bearer_token") {
    const id = randomUUID();
    this.secrets.set(id, { providerId, kind, status: "active" });
    return id;
  }

  async getContext(versionId: string) {
    return this.contexts.get(versionId);
  }

  async configure(input: Parameters<EndpointConfigStore["configure"]>[0]) {
    const context = this.contexts.get(input.facetVersionId);
    if (!context || context.providerId !== input.providerId) return undefined;
    if (context.status !== "draft") {
      throw new AppError("RESOURCE_CONFLICT", "Version is immutable.", 409);
    }
    if (context.version !== input.expectedVersion) {
      throw new AppError(
        "VERSION_PRECONDITION_FAILED",
        "Version conflict.",
        412,
      );
    }
    if (input.secretRefId) {
      const secret = this.secrets.get(input.secretRefId);
      if (
        !secret ||
        secret.providerId !== input.providerId ||
        secret.status !== "active"
      ) {
        throw new AppError("RESOURCE_NOT_FOUND", "Secret not found.", 404);
      }
      const expectedKind =
        input.authKind === "bearer" ? "bearer_token" : "api_key";
      if (secret.kind !== expectedKind) {
        throw new AppError("RESOURCE_CONFLICT", "Secret kind mismatch.", 409);
      }
    }
    const now = new Date("2026-11-10T00:00:00.000Z");
    const previous = this.configs.get(input.facetVersionId);
    const record: EndpointConfigRecord = {
      id: previous?.id ?? randomUUID(),
      facetVersionId: input.facetVersionId,
      facetVersionVersion: context.version + 1,
      providerId: input.providerId,
      protectedBaseUrl: input.baseUrl,
      method: context.method,
      pathTemplate: context.pathTemplate,
      authKind: input.authKind,
      authTemplate: input.authTemplate,
      secretRefId: input.secretRefId,
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
      redirectPolicy: input.redirectPolicy,
      version: (previous?.version ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.configs.set(input.facetVersionId, record);
    this.contexts.set(input.facetVersionId, {
      ...context,
      version: record.facetVersionVersion,
    });
    return record;
  }
}

let app: FastifyInstance;
let providers: InMemoryProviderStore;
let endpoints: MemoryEndpointConfigStore;

beforeEach(async () => {
  providers = new InMemoryProviderStore();
  endpoints = new MemoryEndpointConfigStore();
  const authenticator = new LocalAuthenticator();
  app = await buildApp({
    checkDatabase: async () => undefined,
    environment: "local",
    webOrigin: "http://localhost:3000",
    providerRoutes: {
      authenticator,
      service: new ProviderService(providers, { environment: "local" }),
    },
    endpointConfigRoutes: {
      authenticator,
      service: new EndpointConfigService(providers, endpoints),
    },
  });
});

afterEach(async () => app.close());

async function createProvider(user = "alice"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/providers",
    headers: { "x-facet-dev-user": user },
    payload: { slug: `${user}-endpoints`, name: `${user} Endpoints` },
  });
  return response.json().provider.id as string;
}

describe("draft endpoint configuration", () => {
  it("configures API-key auth without exposing the protected base URL", async () => {
    const providerId = await createProvider();
    const versionId = endpoints.seedVersion(providerId);
    const secretRefId = endpoints.seedSecret(providerId, "api_key");

    const response = await app.inject({
      method: "PUT",
      url: `/v1/facet-versions/${versionId}/endpoint-config`,
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        version: 1,
        baseUrl: "https://api.github.com",
        auth: {
          kind: "API_KEY_HEADER",
          secretRefId,
          parameterName: "X-Api-Key",
        },
        timeoutMs: 15_000,
        maxResponseBytes: 1_048_576,
        redirectPolicy: "DENY",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      endpointConfig: {
        facetVersionId: versionId,
        facetVersionVersion: 2,
        baseUrlConfigured: true,
        method: "GET",
        pathTemplate: "/repos/{owner}/{repo}",
        authKind: "API_KEY_HEADER",
        secretRefId,
        version: 1,
      },
    });
    expect(response.body).not.toContain("api.github.com");
    expect(endpoints.configs.get(versionId)?.protectedBaseUrl).toBe(
      "https://api.github.com/",
    );
  });

  it("rejects invalid auth mappings, stale versions, and published versions", async () => {
    const providerId = await createProvider();
    const versionId = endpoints.seedVersion(providerId);
    const bearerSecret = endpoints.seedSecret(providerId, "bearer_token");

    const wrongKind = await app.inject({
      method: "PUT",
      url: `/v1/facet-versions/${versionId}/endpoint-config`,
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        version: 1,
        baseUrl: "https://api.example.com",
        auth: {
          kind: "API_KEY_QUERY",
          secretRefId: bearerSecret,
          parameterName: "key",
        },
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        redirectPolicy: "SAME_ORIGIN",
      },
    });
    expect(wrongKind.statusCode).toBe(409);

    const stale = await app.inject({
      method: "PUT",
      url: `/v1/facet-versions/${versionId}/endpoint-config`,
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        version: 99,
        baseUrl: "https://api.example.com",
        auth: { kind: "NONE" },
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        redirectPolicy: "DENY",
      },
    });
    expect(stale.statusCode).toBe(412);

    const publishedId = endpoints.seedVersion(providerId, "published");
    const published = await app.inject({
      method: "PUT",
      url: `/v1/facet-versions/${publishedId}/endpoint-config`,
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        version: 1,
        baseUrl: "https://api.example.com",
        auth: { kind: "NONE" },
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        redirectPolicy: "DENY",
      },
    });
    expect(published.statusCode).toBe(409);
  });

  it("denies another provider and rejects secret fields for no-auth", async () => {
    const providerId = await createProvider();
    const versionId = endpoints.seedVersion(providerId);
    const denied = await app.inject({
      method: "PUT",
      url: `/v1/facet-versions/${versionId}/endpoint-config`,
      headers: { "x-facet-dev-user": "mallory" },
      payload: {
        version: 1,
        baseUrl: "https://api.example.com",
        auth: { kind: "NONE" },
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        redirectPolicy: "DENY",
      },
    });
    expect(denied.statusCode).toBe(403);

    const invalid = await app.inject({
      method: "PUT",
      url: `/v1/facet-versions/${versionId}/endpoint-config`,
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        version: 1,
        baseUrl: "https://api.example.com",
        auth: { kind: "NONE", parameterName: "X-Key" },
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        redirectPolicy: "DENY",
      },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
