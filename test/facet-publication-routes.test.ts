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

  seed(providerId: string, status: "draft" | "valid" = "valid") {
    const facetId = randomUUID();
    const facetVersionId = randomUUID();
    const manifest = {
      schemaVersion: "facet.manifest/v1",
      facetId,
      versionId: facetVersionId,
      displayVersion: "0.1.0",
      providerId,
      type: "EXTERNAL_HTTP_API",
      name: "Weather",
      slug: "weather",
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
    this.contexts.set(facetVersionId, {
      facetId,
      facetVersionId,
      providerId,
      displayVersion: "0.1.0",
      facetStatus: "draft",
      facetVersionStatus: status,
      version: 3,
      manifest,
      validationStatus: status === "valid" ? "valid" : "invalid",
      endpointConfigured: true,
    });
    return facetVersionId;
  }

  async getContext(facetVersionId: string) {
    return this.contexts.get(facetVersionId);
  }

  async publish(input: Parameters<FacetPublicationStore["publish"]>[0]) {
    const current = this.contexts.get(input.facetVersionId);
    if (!current) return undefined;
    if (current.version !== input.expectedVersion) {
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
      facetId: current.facetId,
      facetVersionId: current.facetVersionId,
      displayVersion: current.displayVersion,
      visibility: input.visibility,
      contentHash: hashFacetManifest(manifest),
      publishedAt,
      facetVersion: current.version + 1,
      facetRevision: 2,
    };
    this.contexts.set(current.facetVersionId, {
      ...current,
      facetStatus: "published",
      facetVersionStatus: "published",
      version: saved.facetVersion,
      manifest,
    });
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
      service: new ProviderService(providers),
    },
    facetPublicationRoutes: {
      authenticator,
      service: new FacetPublicationService(providers, publications),
    },
  });
});

afterEach(async () => app.close());

async function createProvider(user = "alice") {
  const response = await app.inject({
    method: "POST",
    url: "/v1/providers",
    headers: { "x-facet-dev-user": user },
    payload: { slug: `${user}-publish`, name: `${user} Publish` },
  });
  return response.json().provider.id as string;
}

describe("Facet publication", () => {
  it("publishes one valid version and atomically advances the Facet pointer", async () => {
    const providerId = await createProvider();
    const versionId = publications.seed(providerId);

    const response = await app.inject({
      method: "POST",
      url: `/v1/facet-versions/${versionId}/publish`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { version: 3, visibility: "PUBLIC" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      facet: {
        status: "PUBLISHED",
        visibility: "PUBLIC",
        currentPublishedVersionId: versionId,
        version: 2,
      },
      facetVersion: {
        id: versionId,
        status: "PUBLISHED",
        visibility: "PUBLIC",
        version: 4,
        publishedAt: expect.any(String),
      },
    });
  });

  it("rejects invalid, stale, repeated and cross-provider publication", async () => {
    const providerId = await createProvider();
    const draftId = publications.seed(providerId, "draft");
    const invalid = await app.inject({
      method: "POST",
      url: `/v1/facet-versions/${draftId}/publish`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { version: 3, visibility: "PUBLIC" },
    });
    expect(invalid.statusCode).toBe(409);

    const validId = publications.seed(providerId);
    const stale = await app.inject({
      method: "POST",
      url: `/v1/facet-versions/${validId}/publish`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { version: 2, visibility: "PUBLIC" },
    });
    expect(stale.statusCode).toBe(412);

    const first = await app.inject({
      method: "POST",
      url: `/v1/facet-versions/${validId}/publish`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { version: 3, visibility: "UNLISTED" },
    });
    expect(first.statusCode).toBe(200);
    const repeated = await app.inject({
      method: "POST",
      url: `/v1/facet-versions/${validId}/publish`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { version: 4, visibility: "PUBLIC" },
    });
    expect(repeated.statusCode).toBe(409);

    const otherId = publications.seed(providerId);
    const forbidden = await app.inject({
      method: "POST",
      url: `/v1/facet-versions/${otherId}/publish`,
      headers: { "x-facet-dev-user": "mallory" },
      payload: { version: 3, visibility: "PUBLIC" },
    });
    expect(forbidden.statusCode).toBe(403);
  });
});
