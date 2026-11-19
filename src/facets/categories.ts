import type { FacetType } from "../identifiers.js";

export const NAMED_CATEGORY_SLUGS_BY_TYPE: Record<
  FacetType,
  readonly string[]
> = {
  API: ["data", "social", "finance", "ai", "developer-tools"],
  ACTOR: [
    "web-scraping",
    "vietnamese-data",
    "data-processing",
    "ecommerce",
    "social",
  ],
  AGENT: ["a2a-agents", "market-analysis", "research", "defi", "automation"],
};

export const FACET_CATEGORY_SLUGS_BY_TYPE: Record<
  FacetType,
  readonly string[]
> = {
  API: [...NAMED_CATEGORY_SLUGS_BY_TYPE.API, "others"],
  ACTOR: [...NAMED_CATEGORY_SLUGS_BY_TYPE.ACTOR, "others"],
  AGENT: [...NAMED_CATEGORY_SLUGS_BY_TYPE.AGENT, "others"],
};

export const ALL_NAMED_CATEGORY_SLUGS: readonly string[] = [
  ...new Set(Object.values(NAMED_CATEGORY_SLUGS_BY_TYPE).flat()),
];
