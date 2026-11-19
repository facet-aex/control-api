import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type {
  CatalogListFilters,
  PublicCatalog,
  PublicFacet,
} from "../src/facets/public-catalog.js";

const facetV1: PublicFacet = {
  provider: "example-co",
  facetName: "weather-now",
  facetDisplayName: "Weather Now",
  version: "1.0.0",
  facetType: "API",
  description: "Current weather",
  category: "Data",
  tags: ["weather"],
  method: "GET",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  pricing: {
    model: "PAY_PER_RUN",
    priceAtomic: "1000",
    assetAddress: "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
    chainId: 43113,
    payTo: "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf",
  },
  publishedAt: "2026-11-18T00:00:00.000Z",
};

const facetV2: PublicFacet = {
  ...facetV1,
  version: "1.0.1",
  publishedAt: "2026-11-18T01:00:00.000Z",
};

const catalog: PublicCatalog = {
  async list(query, limit, filters) {
    if (filters?.type && filters.type !== facetV2.facetType) return [];
    if (
      filters?.category &&
      filters.category !== "data" &&
      filters.category !== "others"
    ) {
      return [];
    }
    return query === "Weather" && limit === 1 ? [facetV2] : [];
  },
  async getByName(provider, facetName, version) {
    if (provider !== "example-co" || facetName !== "weather-now") {
      return undefined;
    }
    if (version === undefined || version === "1.0.1") return facetV2;
    if (version === "1.0.0") return facetV1;
    return undefined;
  },
};

describe("public catalog Option B routes", () => {
  it("lists and retrieves published facets by natural keys without leaking UUIDs or legacy names", async () => {
    const app = await buildApp({
      checkDatabase: async () => {},
      environment: "local",
      webOrigin: "http://localhost:3000",
      publicCatalog: catalog,
    });

    const list = await app.inject({
      method: "GET",
      url: "/v1/catalog/facets?q=Weather&limit=1&type=API",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ facets: [facetV2] });

    const seenFilters: Array<CatalogListFilters | undefined> = [];
    const categorySpyCatalog: PublicCatalog = {
      async list(_query, _limit, filters) {
        seenFilters.push(filters);
        return [facetV2];
      },
      getByName: catalog.getByName,
    };
    const spyApp = await buildApp({
      checkDatabase: async () => {},
      environment: "local",
      webOrigin: "http://localhost:3000",
      publicCatalog: categorySpyCatalog,
    });
    const byCategory = await spyApp.inject({
      method: "GET",
      url: "/v1/catalog/facets?q=Weather&limit=1&type=API&category=data",
    });
    expect(byCategory.statusCode).toBe(200);
    const byOthers = await spyApp.inject({
      method: "GET",
      url: "/v1/catalog/facets?type=ACTOR&category=others",
    });
    expect(byOthers.statusCode).toBe(200);
    expect(seenFilters).toEqual([
      { type: "API", category: "data" },
      { type: "ACTOR", category: "others" },
    ]);
    await spyApp.close();

    const latestDetail = await app.inject({
      method: "GET",
      url: "/v1/catalog/facets/example-co/weather-now",
    });
    expect(latestDetail.statusCode).toBe(200);
    expect(latestDetail.json()).toEqual({ facet: facetV2 });

    const pinnedVersion = await app.inject({
      method: "GET",
      url: "/v1/catalog/facets/example-co/weather-now/versions/1.0.0",
    });
    expect(pinnedVersion.statusCode).toBe(200);
    expect(pinnedVersion.json()).toEqual({ facet: facetV1 });

    expect(JSON.stringify(latestDetail.json())).not.toMatch(
      /protectedBaseUrl|secretRefId|vaultReference|facetId|versionId|fullName|displayVersion|creator/iu,
    );
    await app.close();
  });

  it("rejects UUID lookup, invalid SemVer versions, and legacy facetType query values", async () => {
    const app = await buildApp({
      checkDatabase: async () => {},
      environment: "local",
      webOrigin: "http://localhost:3000",
      publicCatalog: catalog,
    });

    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/catalog/facets/019a6d2f-7b14-7000-8000-000000000001",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/catalog/facets?type=EXTERNAL_HTTP_API",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/catalog/facets/example-co/weather-now/versions/v1",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/catalog/facets/example-co/missing-one",
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
  });
});
