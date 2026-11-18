import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type {
  PublicCatalog,
  PublicFacet,
} from "../src/facets/public-catalog.js";

const facet: PublicFacet = {
  id: randomUUID(),
  versionId: randomUUID(),
  slug: "weather",
  fullName: "example/weather",
  name: "Weather",
  description: "Current weather",
  category: "Data",
  tags: [],
  facetType: "EXTERNAL_HTTP_API",
  provider: { id: randomUUID(), name: "Example", slug: "example" },
  displayVersion: "1.0.0",
  method: "GET",
  inputSchema: {},
  outputSchema: {},
  publishedAt: new Date().toISOString(),
};
const catalog: PublicCatalog = {
  async list(query, limit, filters) {
    if (filters?.type && filters.type !== facet.facetType) return [];
    return query === "Weather" && limit === 1 ? [facet] : [];
  },
  async get(id) {
    return id === facet.id ? facet : undefined;
  },
  async getByName(username, facetName) {
    return `${username}/${facetName}` === facet.fullName ? facet : undefined;
  },
};

describe("public catalog routes", () => {
  it("lists and retrieves published facets without authentication", async () => {
    const app = await buildApp({
      checkDatabase: async () => {},
      environment: "local",
      webOrigin: "http://localhost:3000",
      publicCatalog: catalog,
    });
    const list = await app.inject({
      method: "GET",
      url: "/v1/catalog/facets?q=Weather&limit=1&type=EXTERNAL_HTTP_API",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ facets: [facet] });
    const detail = await app.inject({
      method: "GET",
      url: `/v1/catalog/facets/${facet.id}`,
    });
    expect(detail.json()).toEqual({ facet });
    const namedDetail = await app.inject({
      method: "GET",
      url: "/v1/catalog/facets/example/weather",
    });
    expect(namedDetail.json()).toEqual({ facet });
    expect(JSON.stringify(detail.json())).not.toMatch(
      /protectedBaseUrl|secretRefId|vaultReference/iu,
    );
    await app.close();
  });

  it("bounds queries and returns 404 for missing facets", async () => {
    const app = await buildApp({
      checkDatabase: async () => {},
      environment: "local",
      webOrigin: "http://localhost:3000",
      publicCatalog: catalog,
    });
    expect(
      (await app.inject({ method: "GET", url: "/v1/catalog/facets?limit=51" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/catalog/facets?type=INVALID_TYPE",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/catalog/facets/${randomUUID()}`,
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });
});
