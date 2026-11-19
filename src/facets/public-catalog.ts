import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { facets, facetVersions, users } from "../db/schema.js";
import type { FacetType, PricingModel } from "../identifiers.js";
import {
  AVALANCHE_FUJI_CHAIN_ID,
  DEFAULT_ERC8004_REGISTRY,
  DEMO_LOCAL_PAY_TO,
  FUSD_ADDRESS,
} from "./actor-agent-service.js";

export type { FacetType, PricingModel };

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
  pricing: {
    model: PricingModel;
    priceAtomic: string;
    assetAddress: string;
    chainId: 43113;
    payTo: string;
  };
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

export function searchTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/gu, "")
        .replace(/đ/gu, "d")
        .toLowerCase()
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
  >,
  terms: string[],
): number {
  const haystack =
    `${facet.facetDisplayName} ${facet.description} ${facet.category} ${facet.tags.join(" ")}`.toLowerCase();
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
      conditions.push(eq(facets.category, filters.category));
    }
    return and(...conditions);
  }

  private map(
    row: Awaited<
      ReturnType<ReturnType<PostgresPublicCatalog["baseLatest"]>["limit"]>
    >[number],
  ): PublicFacet {
    const manifest = (row.version.manifest ?? {}) as {
      operation?: {
        method?: string;
        inputSchema?: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
      };
      actorConfig?: {
        runtime?: string;
      };
      agentConfig?: {
        taskKind?: string;
      };
    };
    const mappedType: FacetType = row.facet.type;
    const pricingModel: PricingModel =
      row.version.pricingModel === "PAY_PER_RESULT"
        ? "PAY_PER_RESULT"
        : "PAY_PER_RUN";
    const payTo =
      row.version.payTo ?? row.user.walletAddress ?? DEMO_LOCAL_PAY_TO;

    return {
      provider: row.user.username,
      facetName: row.facet.facetName,
      facetDisplayName: row.facet.facetDisplayName,
      version: row.version.version,
      facetType: mappedType,
      description: row.facet.description,
      category: row.facet.category,
      tags: row.facet.tags,
      method:
        manifest.operation?.method ?? (mappedType === "API" ? "GET" : "POST"),
      inputSchema: manifest.operation?.inputSchema ?? { type: "object" },
      outputSchema: manifest.operation?.outputSchema ?? { type: "object" },
      pricing: {
        model: pricingModel,
        priceAtomic: row.version.priceAtomic,
        assetAddress: FUSD_ADDRESS,
        chainId: AVALANCHE_FUJI_CHAIN_ID,
        payTo,
      },
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
      publishedAt: row.version.publishedAt!.toISOString(),
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
