import { describe, expect, it } from "vitest";

import { buildFacetDraftManifest } from "../src/facets/facet-manifest.js";

const identifiers = {
  facetId: "019a6d2f-7b14-7000-8000-000000000001",
  versionId: "019a6d2f-7b14-7000-8000-000000000002",
  providerId: "019a6d2f-7b14-7000-8000-000000000003",
  sourceVersionId: "019a6d2f-7b14-7000-8000-000000000004",
};

describe("buildFacetDraftManifest", () => {
  it("builds a provider-private draft contract with immutable provenance", () => {
    const result = buildFacetDraftManifest({
      ...identifiers,
      displayVersion: "0.1.0",
      sourceOperationPointer: "#/paths/~1weather/get",
      selection: {
        operationCandidateId: "019a6d2f-7b14-7000-8000-000000000005",
        slug: "weather-now",
        name: "Weather now",
        summary: "Read current weather.",
        description: "Weather observations from the provider.",
        category: "weather",
        tags: ["forecast", "weather"],
        sideEffectClass: "READ_ONLY",
      },
      candidate: {
        candidateId: "getWeather",
        jsonPointer: "#/paths/~1weather/get",
        method: "GET",
        path: "/weather",
        operationId: "getWeather",
        summary: "Read current weather.",
        tags: ["weather"],
      },
    });

    expect(result.manifest).toEqual({
      schemaVersion: "facet.manifest/v1",
      facetId: identifiers.facetId,
      versionId: identifiers.versionId,
      displayVersion: "0.1.0",
      providerId: identifiers.providerId,
      type: "EXTERNAL_HTTP_API",
      name: "Weather now",
      slug: "weather-now",
      summary: "Read current weather.",
      description: "Weather observations from the provider.",
      category: "weather",
      tags: ["forecast", "weather"],
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
      upstreamAuth: { kind: "UNCONFIGURED", configured: false },
      provenance: {
        sourceType: "OPENAPI",
        sourceVersionId: identifiers.sourceVersionId,
        sourceOperationPointer: "#/paths/~1weather/get",
      },
    });
    expect(result.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(result)).not.toMatch(
      /baseUrl|secretRef|credential|apiKey|bearerToken/iu,
    );
  });

  it("produces the same content hash for semantically identical candidate key order", () => {
    const base = {
      ...identifiers,
      displayVersion: "0.1.0",
      sourceOperationPointer: "#/paths/~1weather/get",
      selection: {
        operationCandidateId: "019a6d2f-7b14-7000-8000-000000000005",
        slug: "weather-now",
        name: "Weather now",
        category: "weather",
        tags: ["weather"],
        sideEffectClass: "READ_ONLY" as const,
      },
    };
    const first = buildFacetDraftManifest({
      ...base,
      candidate: {
        candidateId: "getWeather",
        jsonPointer: "#/paths/~1weather/get",
        method: "GET",
        path: "/weather",
        tags: ["weather"],
      },
    });
    const second = buildFacetDraftManifest({
      ...base,
      candidate: {
        tags: ["weather"],
        path: "/weather",
        method: "GET",
        jsonPointer: "#/paths/~1weather/get",
        candidateId: "getWeather",
      },
    });

    expect(second.contentHash).toBe(first.contentHash);
  });
});
