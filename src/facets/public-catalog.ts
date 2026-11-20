import { and, desc, eq, notInArray } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { facets, facetVersions, users } from "../db/schema.js";
import type { FacetType, PricingModel } from "../identifiers.js";
import {
  AVALANCHE_FUJI_CHAIN_ID,
  DEFAULT_ERC8004_REGISTRY,
  DEMO_LOCAL_PAY_TO,
  hydratePricingOptions,
} from "./actor-agent-service.js";
import type { FacetPricingOption } from "./actor-agent-types.js";
import {
  ALL_NAMED_CATEGORY_SLUGS,
  NAMED_CATEGORY_SLUGS_BY_TYPE,
} from "./categories.js";

export type { FacetPricingOption, FacetType, PricingModel };

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiMeta {
  method: HttpMethod;
  pathTemplate: string;
  datasetPath?: string;
  staticHeaderNames?: string[];
  registryTxHash?: string;
  registryVerified?: boolean;
}

export interface PublicCatalogRow {
  facet: {
    type: FacetType;
    facetName: string;
    facetDisplayName: string;
    description: string;
    category: string;
    tags: string[];
  };
  version: {
    version: string;
    manifest: unknown;
    imageDigest: string | null;
    pricingModel: string;
    priceAtomic: string;
    pricingOptions?: unknown;
    maxItemsCap?: number | null;
    payTo: string | null;
    erc8004Registry: string | null;
    erc8004TokenId: string | null;
    registryVerified: boolean;
    registryTxHash: string | null;
    publishedAt: Date | null;
  };
  user: {
    username: string;
    walletAddress: string | null;
  };
}

export interface PublicFacet {
  provider: string;
  facetName: string;
  facetDisplayName: string;
  version: string;
  facetType: FacetType;
  summary?: string;
  description: string;
  category: string;
  tags: string[];
  method: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  pricing: FacetPricingOption;
  pricingOptions: FacetPricingOption[];
  apiMeta?: ApiMeta;
  actorMeta?: {
    runtime: string;
    imageDigest: string;
    runnerOciDigest?: string;
    registryTxHash?: string;
    registryVerified?: boolean;
  };
  agentMeta?: {
    erc8004ChainId: 43113;
    erc8004Registry: string;
    erc8004TokenId: string;
    taskKind: string;
    registryTxHash?: string;
    registryVerified?: boolean;
  };
  publishedAt: string;
}

export interface CatalogListFilters {
  type?: FacetType | undefined;
  category?: string | undefined;
}

export interface PublicCatalog {
  list(
    query: string,
    limit: number,
    filters?: CatalogListFilters,
  ): Promise<PublicFacet[]>;
  getByName(
    provider: string,
    facetName: string,
    version?: string,
  ): Promise<PublicFacet | undefined>;
}

const ignoredWords = new Set([
  "facet",
  "marketplace",
  "tool",
  "api",
  "find",
  "search",
  "use",
  "get",
  "the",
  "for",
  "and",
  "dung",
  "tim",
  "phu",
  "hop",
  "phan",
  "tich",
  "cua",
  "trong",
  "gan",
  "day",
  "mot",
]);
const synonyms: Record<string, string> = {
  btc: "bitcoin",
  gia: "price",
  vang: "gold",
  ty: "fx",
  tin: "news",
  tuc: "news",
  thi: "market",
  truong: "market",
  duong: "chart",
  lich: "historical",
  su: "historical",
  thang: "month",
  ngan: "short",
  han: "term",
};

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/đ/gu, "d")
    .toLowerCase();
}

export function searchTerms(query: string): string[] {
  return [
    ...new Set(
      normalizeSearchText(query)
        .match(/[a-z0-9]{2,}/gu)
        ?.map((word) => synonyms[word] ?? word)
        .filter((word) => !ignoredWords.has(word)) ?? [],
    ),
  ];
}

export function relevance(
  facet: Pick<
    PublicFacet,
    "facetDisplayName" | "description" | "category" | "tags"
  > &
    Partial<Pick<PublicFacet, "provider" | "facetName">>,
  terms: string[],
): number {
  const haystack = normalizeSearchText(
    [
      facet.provider ?? "",
      facet.facetName ?? "",
      facet.facetDisplayName,
      facet.description,
      facet.category,
      facet.tags.join(" "),
    ].join(" "),
  );
  return terms.reduce(
    (score, term) => score + (haystack.includes(term) ? 1 : 0),
    0,
  );
}

export class PostgresPublicCatalog implements PublicCatalog {
  constructor(
    private readonly db: Database["db"],
    private readonly runnerOciDigest?: string,
  ) {}

  private baseLatest() {
    return this.db
      .select({ facet: facets, version: facetVersions, user: users })
      .from(facets)
      .innerJoin(
        facetVersions,
        eq(facets.currentPublishedVersionId, facetVersions.id),
      )
      .innerJoin(users, eq(facets.providerId, users.id));
  }

  private baseByVersion() {
    return this.db
      .select({ facet: facets, version: facetVersions, user: users })
      .from(facets)
      .innerJoin(facetVersions, eq(facets.id, facetVersions.facetId))
      .innerJoin(users, eq(facets.providerId, users.id));
  }

  private visible(filters?: CatalogListFilters) {
    const conditions = [
      eq(facets.status, "published"),
      eq(facets.visibility, "public"),
      eq(facetVersions.status, "published"),
      eq(users.status, "active"),
    ];
    if (filters?.type) {
      conditions.push(eq(facets.type, filters.type));
    }
    if (filters?.category) {
      if (filters.category === "others") {
        const excluded = filters.type
          ? NAMED_CATEGORY_SLUGS_BY_TYPE[filters.type]
          : ALL_NAMED_CATEGORY_SLUGS;
        conditions.push(notInArray(facets.category, [...excluded]));
      } else {
        conditions.push(eq(facets.category, filters.category));
      }
    }
    return and(...conditions);
  }

  map(row: PublicCatalogRow): PublicFacet {
    const manifest = (row.version.manifest ?? {}) as {
      summary?: unknown;
      operation?: {
        method?: string;
        publicPathTemplate?: string;
        inputSchema?: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
      };
      apiConfig?: {
        datasetPath?: unknown;
        staticHeaderNames?: unknown;
      };
      actorConfig?: {
        runtime?: string;
      };
      agentConfig?: {
        taskKind?: string;
      };
    };
    const mappedType: FacetType = row.facet.type;
    const payTo =
      row.version.payTo ?? row.user.walletAddress ?? DEMO_LOCAL_PAY_TO;
    const { primary, options } = hydratePricingOptions({
      pricingOptions: row.version.pricingOptions,
      pricingModel: row.version.pricingModel,
      priceAtomic: row.version.priceAtomic,
      maxItemsCap: row.version.maxItemsCap,
      payTo,
    });

    const rawMethod = manifest.operation?.method?.toUpperCase();
    const apiMethod: HttpMethod =
      rawMethod === "POST" ||
      rawMethod === "PUT" ||
      rawMethod === "PATCH" ||
      rawMethod === "DELETE"
        ? rawMethod
        : "GET";
    const rawPathTemplate = manifest.operation?.publicPathTemplate;
    const pathTemplate =
      typeof rawPathTemplate === "string" && rawPathTemplate.length > 0
        ? rawPathTemplate.startsWith("/")
          ? rawPathTemplate
          : `/${rawPathTemplate}`
        : "/";
    const datasetPath =
      typeof manifest.apiConfig?.datasetPath === "string" &&
      manifest.apiConfig.datasetPath.length > 0
        ? manifest.apiConfig.datasetPath
        : undefined;
    const staticHeaderNames = Array.isArray(
      manifest.apiConfig?.staticHeaderNames,
    )
      ? manifest.apiConfig.staticHeaderNames.filter(
          (item): item is string => typeof item === "string" && item.length > 0,
        )
      : [];

    return {
      provider: row.user.username,
      facetName: row.facet.facetName,
      facetDisplayName: row.facet.facetDisplayName,
      version: row.version.version,
      facetType: mappedType,
      ...(typeof manifest.summary === "string" && manifest.summary.length > 0
        ? { summary: manifest.summary.slice(0, 280) }
        : {}),
      description: row.facet.description,
      category: row.facet.category,
      tags: row.facet.tags,
      method:
        manifest.operation?.method ?? (mappedType === "API" ? "GET" : "POST"),
      inputSchema: manifest.operation?.inputSchema ?? { type: "object" },
      outputSchema: manifest.operation?.outputSchema ?? { type: "object" },
      pricing: primary,
      pricingOptions: options,
      ...(mappedType === "API"
        ? {
            apiMeta: {
              method: apiMethod,
              pathTemplate,
              ...(datasetPath ? { datasetPath } : {}),
              ...(staticHeaderNames.length > 0 ? { staticHeaderNames } : {}),
              registryVerified: row.version.registryVerified,
              ...(row.version.registryTxHash
                ? { registryTxHash: row.version.registryTxHash }
                : {}),
            },
          }
        : {}),
      ...(mappedType === "ACTOR" && row.version.imageDigest
        ? {
            actorMeta: {
              runtime: manifest.actorConfig?.runtime ?? "node-22-esm",
              imageDigest: row.version.imageDigest,
              ...(this.runnerOciDigest
                ? { runnerOciDigest: this.runnerOciDigest }
                : {}),
              registryVerified: row.version.registryVerified,
              ...(row.version.registryTxHash
                ? { registryTxHash: row.version.registryTxHash }
                : {}),
            },
          }
        : {}),
      ...(mappedType === "AGENT" && row.version.erc8004TokenId
        ? {
            agentMeta: {
              erc8004ChainId: AVALANCHE_FUJI_CHAIN_ID,
              erc8004Registry:
                row.version.erc8004Registry ?? DEFAULT_ERC8004_REGISTRY,
              erc8004TokenId: row.version.erc8004TokenId,
              taskKind: manifest.agentConfig?.taskKind ?? "a2a-task",
              registryVerified: row.version.registryVerified,
              ...(row.version.registryTxHash
                ? { registryTxHash: row.version.registryTxHash }
                : {}),
            },
          }
        : {}),
      publishedAt: (row.version.publishedAt ?? new Date(0)).toISOString(),
    };
  }

  async list(
    query = "",
    limit = 20,
    filters?: CatalogListFilters,
  ): Promise<PublicFacet[]> {
    const terms = searchTerms(query.trim());
    const rows = await this.baseLatest()
      .where(this.visible(filters))
      .orderBy(desc(facetVersions.publishedAt), desc(facets.id))
      .limit(200);
    const matches = rows.map((row) => this.map(row));
    if (!terms.length) return matches.slice(0, limit);
    return matches
      .map((facet) => ({ facet, score: relevance(facet, terms) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ facet }) => facet);
  }

  async getByName(
    provider: string,
    facetName: string,
    version?: string,
  ): Promise<PublicFacet | undefined> {
    if (version !== undefined) {
      const rows = await this.baseByVersion()
        .where(
          and(
            this.visible(),
            eq(users.username, provider),
            eq(facets.facetName, facetName),
            eq(facetVersions.version, version),
          ),
        )
        .limit(1);
      return rows[0] ? this.map(rows[0]) : undefined;
    }
    const rows = await this.baseLatest()
      .where(
        and(
          this.visible(),
          eq(users.username, provider),
          eq(facets.facetName, facetName),
        ),
      )
      .limit(1);
    return rows[0] ? this.map(rows[0]) : undefined;
  }
}
