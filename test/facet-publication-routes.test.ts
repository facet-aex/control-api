import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { AppError } from "../src/errors.js";
import { FacetPublicationService } from "../src/facets/facet-publication-service.js";
import type {
  FacetPublicationContext,
  FacetPublicationStore,
  PublishedFacetVersion,
} from "../src/facets/facet-publication-types.js";
import { hashFacetManifest } from "../src/facets/facet-manifest.js";
import { ProviderService } from "../src/providers/provider-service.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

class MemoryPublicationStore implements FacetPublicationStore {
  readonly contexts = new Map<string, FacetPublicationContext>();

  private key(provider: string, facetName: string, version: string) {
    return `${provider}/${facetName}@${version}`;
  }

  seed(
    providerId: string,
    options: {
      provider?: string;
      facetName?: string;
      version?: string;
      status?: "draft" | "valid";
    } = {},
  ) {
    const provider = options.provider ?? "alice-labs";
    const facetName = options.facetName ?? "weather-now";
    const version = options.version ?? "0.1.0";
    const status = options.status ?? "valid";
    const facetId = randomUUID();
    const facetVersionId = randomUUID();
    const manifest = {
      schemaVersion: "facet.manifest/v1",
      facetId,
      versionId: facetVersionId,
      providerId,
      provider,
      facetName,
      facetDisplayName: "Weather",
      version,
      type: "API",
      summary: "Weather",
      description: "",
      category: "weather",
      tags: [],
      visibility: "PRIVATE",
      operation: {
        operationId: "getWeather",
        method: "GET",
        publicPathTemplate: "/weather",
        inputSchema: {},
        outputSchema: {},
        errorSchema: {},
        sideEffectClass: "READ_ONLY",
      },
      executionPolicy: {
        timeoutMs: 15_000,
        maxResponseBytes: 1_048_576,
        redirectPolicy: "DENY",
      },
      upstreamAuth: { kind: "NONE", configured: true },
      provenance: {
        sourceType: "OPENAPI",
        sourceVersionId: randomUUID(),
        sourceOperationPointer: "#/paths/~1weather/get",
      },
    };
    this.contexts.set(this.key(provider, facetName, version), {
      facetId,
      facetVersionId,
      providerId,
      provider,
      facetName,
      facetDisplayName: "Weather",
      facetType: "API",
      version,
      facetStatus: "draft",
      facetVersionStatus: status,
      revision: 3,
      manifest,
      validationStatus: status === "valid" ? "valid" : "invalid",
      endpointConfigured: true,
    });
    return facetVersionId;
  }

  async getContextByName(provider: string, facetName: string, version: string) {
    return this.contexts.get(this.key(provider, facetName, version));
  }

  async publish(input: Parameters<FacetPublicationStore["publish"]>[0]) {
    const current = [...this.contexts.values()].find(
      (item) => item.facetVersionId === input.facetVersionId,
    );
    if (!current) return undefined;
    if (current.revision !== input.expectedRevision) {
      throw new AppError(
        "VERSION_PRECONDITION_FAILED",
        "Facet version changed before publication.",
        412,
      );
    }
    if (
      current.facetVersionStatus !== "valid" ||
      current.validationStatus !== "valid" ||
      !current.endpointConfigured
    ) {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "Only a valid configured Facet Version can be published.",
        409,
      );
    }
    const publishedAt = new Date().toISOString();
    const manifest = { ...current.manifest, visibility: input.visibility };
    const saved: PublishedFacetVersion = {
      provider: current.provider,
      facetName: current.facetName,
      facetDisplayName: current.facetDisplayName,
      facetType: current.facetType,
      version: current.version,
      visibility: input.visibility,
      contentHash: hashFacetManifest(manifest),
      publishedAt,
      facetVersionRevision: current.revision + 1,
      facetRevision: 2,
    };
    this.contexts.set(
      this.key(current.provider, current.facetName, current.version),
      {
        ...current,
        facetStatus: "published",
        facetVersionStatus: "published",
        revision: saved.facetVersionRevision,
        manifest,
      },
    );
    return saved;
  }
}

let app: FastifyInstance;
let providers: InMemoryProviderStore;
let publications: MemoryPublicationStore;

beforeEach(async () => {
  providers = new InMemoryProviderStore();
  publications = new MemoryPublicationStore();
  const authenticator = new LocalAuthenticator();
  app = await buildApp({
    checkDatabase: async () => undefined,
    environment: "local",
    webOrigin: "http://localhost:3000",
    providerRoutes: {
      authenticator,
      service: new ProviderService(providers, { environment: "local" }),
    },
    facetPublicationRoutes: {
      authenticator,
      service: new FacetPublicationService(providers, publications),
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

describe("Facet publication (Option B)", () => {
  it("publishes one valid version and returns PublishFacetVersionResponse v0.15 without UUIDs", async () => {
    const providerId = await ensureUserId("alice-labs");
    publications.seed(providerId);

    const response = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/weather-now/versions/0.1.0/publish",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: { revision: 3, visibility: "PUBLIC" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      facet: {
        provider: "alice-labs",
        facetName: "weather-now",
        facetDisplayName: "Weather",
        facetType: "API",
        status: "PUBLISHED",
        visibility: "PUBLIC",
        currentPublishedVersion: "0.1.0",
        revision: 2,
      },
      facetVersion: {
        provider: "alice-labs",
        facetName: "weather-now",
        version: "0.1.0",
        status: "PUBLISHED",
        visibility: "PUBLIC",
        contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        publishedAt: expect.any(String),
        revision: 4,
      },
    });
  });

  it("rejects invalid, stale, repeated and cross-provider publication", async () => {
    const providerId = await ensureUserId("alice-labs");
    publications.seed(providerId, {
      facetName: "draft-api",
      status: "draft",
    });
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/draft-api/versions/0.1.0/publish",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: { revision: 3, visibility: "PUBLIC" },
    });
    expect(invalid.statusCode).toBe(409);

    publications.seed(providerId, { facetName: "valid-api" });
    const stale = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/valid-api/versions/0.1.0/publish",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: { revision: 2, visibility: "PUBLIC" },
    });
    expect(stale.statusCode).toBe(412);

    const first = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/valid-api/versions/0.1.0/publish",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: { revision: 3, visibility: "UNLISTED" },
    });
    expect(first.statusCode).toBe(200);
    const repeated = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/valid-api/versions/0.1.0/publish",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: { revision: 4, visibility: "PUBLIC" },
    });
    expect(repeated.statusCode).toBe(409);

    publications.seed(providerId, { facetName: "other-api" });
    const forbidden = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/other-api/versions/0.1.0/publish",
      headers: { "x-facet-dev-user": "mallory-x" },
      payload: { revision: 3, visibility: "PUBLIC" },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
