import { describe, expect, it } from "vitest";
import { relevance, searchTerms } from "../src/facets/public-catalog.js";

describe("catalog intent search", () => {
  const facet = {
    facetDisplayName: "Bitcoin historical price chart",
    description: "Returns the past month of BTC prices in USD",
    category: "market-data",
    tags: ["crypto", "price", "history"],
  };

  it("finds a relevant Facet from a Vietnamese agent request", () => {
    const terms = searchTerms(
      "dùng FACET marketplace tìm tool phù hợp phân tích lịch sử giá của BTC trong 1 tháng gần đây",
    );
    expect(terms).toContain("bitcoin");
    expect(terms).toContain("price");
    expect(relevance(facet, terms)).toBeGreaterThan(1);
  });

  it("accepts a short intent without a named tool", () => {
    expect(
      relevance(facet, searchTerms("phân tích đường giá BTC trong ngắn hạn")),
    ).toBeGreaterThan(1);
  });

  it("matches provider, facetName, and normalized Vietnamese text", () => {
    const customActor = {
      provider: "brian-gemini",
      facetName: "ye-ye-ye",
      facetDisplayName: "brian test",
      description: "Actor phân tích dữ liệu chứng khoán Việt Nam",
      category: "data-processing",
      tags: ["actor"],
    };

    expect(relevance(customActor, searchTerms("ye"))).toBeGreaterThan(0);
    expect(relevance(customActor, searchTerms("ye-ye-ye"))).toBeGreaterThan(0);
    expect(
      relevance(
        { ...customActor, facetDisplayName: "Custom Actor" },
        searchTerms("brian-gemini"),
      ),
    ).toBeGreaterThan(0);
    expect(
      relevance(
        { ...customActor, facetDisplayName: "Custom Actor" },
        searchTerms("brian-gemini/ye-ye-ye"),
      ),
    ).toBeGreaterThan(0);
    expect(
      relevance(customActor, searchTerms("chung khoan viet nam")),
    ).toBeGreaterThan(0);
    expect(
      relevance(customActor, searchTerms("dữ liệu chứng khoán")),
    ).toBeGreaterThan(0);
  });
});
