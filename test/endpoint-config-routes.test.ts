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

  private key(provider: string, facetName: string, version: string) {
    return `${provider}/${facetName}@${version}`;
  }

  seedVersion(
    providerId: string,
    provider = "alice-labs",
    facetName = "github-repo",
    version = "0.1.0",
    status: "draft" | "published" = "draft",
  ) {
    const facetVersionId = randomUUID();
    this.contexts.set(this.key(provider, facetName, version), {
      facetVersionId,
      providerId,
      provider,
      facetName,
      version,
      status,
      revision: 1,
      method: "GET",
      pathTemplate: "/repos/{owner}/{repo}",
    });
    return facetVersionId;
  }

  seedSecret(providerId: string, kind: "api_key" | "bearer_token") {
    const id = randomUUID();
    this.secrets.set(id, { providerId, kind, status: "active" });
    return id;
  }

  async getContextByName(provider: string, facetName: string, version: string) {
    return this.contexts.get(this.key(provider, facetName, version));
  }

  async configure(input: Parameters<EndpointConfigStore["configure"]>[0]) {
    const context = [...this.contexts.values()].find(
      (item) => item.facetVersionId === input.facetVersionId,
    );
    if (!context || context.providerId !== input.providerId) return undefined;
    if (context.status !== "draft") {
      throw new AppError("RESOURCE_CONFLICT", "Version is immutable.", 409);
    }
    if (context.revision !== input.expectedRevision) {
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
      provider: context.provider,
      facetName: context.facetName,
      version: context.version,
      facetVersionRevision: context.revision + 1,
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
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.configs.set(input.facetVersionId, record);
    this.contexts.set(
      this.key(context.provider, context.facetName, context.version),
      {
        ...context,
        revision: record.facetVersionRevision,
      },
    );
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

async function ensureUserId(username = "alice-labs"): Promise<string> {
  const user = await providers.upsertUser({
    subject: `local:${username}`,
    username,
  });
  return user.id;
}

describe("draft endpoint configuration (Option B + revision)", () => {
  it("configures API-key auth by natural keys without exposing protected base URL or UUIDs", async () => {
    const providerId = await ensureUserId("alice-labs");
    const versionId = endpoints.seedVersion(providerId);
    const secretRefId = endpoints.seedSecret(providerId, "api_key");

    const response = await app.inject({
      method: "PUT",
      url: "/v1/facets/alice-labs/github-repo/versions/0.1.0/endpoint-config",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        revision: 1,
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
    expect(response.json()).toEqual({
      endpointConfig: {
        provider: "alice-labs",
        facetName: "github-repo",
        version: "0.1.0",
        facetVersionRevision: 2,
        baseUrlConfigured: true,
        method: "GET",
        pathTemplate: "/repos/{owner}/{repo}",
        authKind: "API_KEY_HEADER",
        secretConfigured: true,
        timeoutMs: 15_000,
        maxResponseBytes: 1_048_576,
        redirectPolicy: "DENY",
        revision: 1,
        createdAt: "2026-11-10T00:00:00.000Z",
        updatedAt: "2026-11-10T00:00:00.000Z",
      },
    });
    expect(response.body).not.toContain("api.github.com");
    expect(response.body).not.toContain(secretRefId);
    expect(endpoints.configs.get(versionId)?.protectedBaseUrl).toBe(
      "https://api.github.com/",
    );
  });

  it("supports POST alias and rejects stale revisions, wrong secret kind, and published versions", async () => {
    const providerId = await ensureUserId("alice-labs");
    endpoints.seedVersion(providerId, "alice-labs", "github-repo", "0.1.0");
    const bearerSecret = endpoints.seedSecret(providerId, "bearer_token");

    const wrongKind = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/github-repo/versions/0.1.0/endpoint-config",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        revision: 1,
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
      url: "/v1/facets/alice-labs/github-repo/versions/0.1.0/endpoint-config",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        revision: 99,
        baseUrl: "https://api.example.com",
        auth: { kind: "NONE" },
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        redirectPolicy: "DENY",
      },
    });
    expect(stale.statusCode).toBe(412);

    endpoints.seedVersion(
      providerId,
      "alice-labs",
      "published-api",
      "1.0.0",
      "published",
    );
    const published = await app.inject({
      method: "PUT",
      url: "/v1/facets/alice-labs/published-api/versions/1.0.0/endpoint-config",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        revision: 1,
        baseUrl: "https://api.example.com",
        auth: { kind: "NONE" },
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        redirectPolicy: "DENY",
      },
    });
    expect(published.statusCode).toBe(409);
  });

  it("denies another user and rejects legacy `version` integer payload", async () => {
    const providerId = await ensureUserId("alice-labs");
    endpoints.seedVersion(providerId);

    const denied = await app.inject({
      method: "PUT",
      url: "/v1/facets/alice-labs/github-repo/versions/0.1.0/endpoint-config",
      headers: { "x-facet-dev-user": "mallory-x" },
      payload: {
        revision: 1,
        baseUrl: "https://api.example.com",
        auth: { kind: "NONE" },
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        redirectPolicy: "DENY",
      },
    });
    expect(denied.statusCode).toBe(403);

    const legacyField = await app.inject({
      method: "PUT",
      url: "/v1/facets/alice-labs/github-repo/versions/0.1.0/endpoint-config",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        version: 1,
        baseUrl: "https://api.example.com",
        auth: { kind: "NONE" },
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        redirectPolicy: "DENY",
      },
    });
    expect(legacyField.statusCode).toBe(400);
  });
});
