import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { facets, facetVersions, providers } from "../db/schema.js";
import {
  ACTOR_RUNTIME_NAME,
  DEFAULT_ERC8004_REGISTRY,
  DEFAULT_PAY_TO,
  FUJI_CHAIN_ID,
  FUSD_ASSET_ADDRESS,
  type PricingModel,
} from "./actor-agent-types.js";

export type FacetType =
  "EXTERNAL_HTTP_API" | "HOSTED_ACTOR" | "AUTONOMOUS_AGENT";

export interface PublicFacet {
  id: string;
  fullName?: string;
  versionId: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  facetType?: FacetType;
  provider: { id: string; name: string; slug: string };
  displayVersion: string;
  method: string;
  inputSchema: unknown;
  outputSchema: unknown;
  pricing?: {
    model: PricingModel;
    priceAtomic: string;
    assetAddress: string;
    chainId: 43113;
    payTo: string;
  };
  actorMeta?: {
    runtime: string;
    imageDigest: string;
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
  get(id: string): Promise<PublicFacet | undefined>;
  getByName(
    username: string,
    facetName: string,
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
  facet: Pick<PublicFacet, "name" | "description" | "category" | "tags">,
  terms: string[],
): number {
  const haystack =
    `${facet.name} ${facet.description} ${facet.category} ${facet.tags.join(" ")}`.toLowerCase();
  return terms.reduce(
    (score, term) => score + (haystack.includes(term) ? 1 : 0),
    0,
  );
}

function toPublicFacetType(dbType: string): FacetType {
  if (dbType === "hosted_actor") return "HOSTED_ACTOR";
  if (dbType === "autonomous_agent") return "AUTONOMOUS_AGENT";
  return "EXTERNAL_HTTP_API";
}

function toDbFacetType(
  facetType: FacetType,
): "external_http_api" | "hosted_actor" | "autonomous_agent" {
  if (facetType === "HOSTED_ACTOR") return "hosted_actor";
  if (facetType === "AUTONOMOUS_AGENT") return "autonomous_agent";
  return "external_http_api";
}

export class PostgresPublicCatalog implements PublicCatalog {
  constructor(private readonly db: Database["db"]) {}

  private base() {
    return this.db
      .select({ facet: facets, version: facetVersions, provider: providers })
      .from(facets)
      .innerJoin(
        facetVersions,
        eq(facets.currentPublishedVersionId, facetVersions.id),
      )
      .innerJoin(providers, eq(facets.providerId, providers.id));
  }

  private visible(filters?: CatalogListFilters) {
    const conditions = [
      eq(facets.status, "published"),
      eq(facets.visibility, "public"),
      eq(facetVersions.status, "published"),
      eq(providers.status, "active"),
    ];
    if (filters?.type) {
      conditions.push(eq(facets.type, toDbFacetType(filters.type)));
    }
    if (filters?.category) {
      conditions.push(eq(facets.category, filters.category));
    }
    return and(...conditions);
  }

  private map(
    row: Awaited<
      ReturnType<ReturnType<PostgresPublicCatalog["base"]>["limit"]>
    >[number],
  ): PublicFacet {
    const operation = row.version.operation as { method?: string };
    const mappedType = toPublicFacetType(row.facet.type);
    const pricingModel: PricingModel =
      row.version.pricingModel === "PAY_PER_RESULT"
        ? "PAY_PER_RESULT"
        : "PAY_PER_RUN";
    const payTo =
      row.version.payTo ?? row.provider.walletAddress ?? DEFAULT_PAY_TO;

    return {
      id: row.facet.id,
      fullName: `${row.provider.slug}/${row.facet.slug}`,
      versionId: row.version.id,
      slug: row.facet.slug,
      name: row.facet.name,
      description: row.facet.description,
      category: row.facet.category,
      tags: row.facet.tags,
      facetType: mappedType,
      provider: {
        id: row.provider.id,
        name: row.provider.name,
        slug: row.provider.slug,
      },
      displayVersion: row.version.displayVersion,
      method:
        operation.method ??
        (mappedType === "EXTERNAL_HTTP_API" ? "GET" : "POST"),
      inputSchema: row.version.inputSchema,
      outputSchema: row.version.outputSchema,
      pricing: {
        model: pricingModel,
        priceAtomic: row.version.priceAtomic,
        assetAddress: FUSD_ASSET_ADDRESS,
        chainId: FUJI_CHAIN_ID,
        payTo,
      },
      ...(mappedType === "HOSTED_ACTOR" && row.version.imageDigest
        ? {
            actorMeta: {
              runtime: ACTOR_RUNTIME_NAME,
              imageDigest: row.version.imageDigest,
              registryVerified: row.version.registryVerified,
              ...(row.version.registryTxHash
                ? { registryTxHash: row.version.registryTxHash }
                : {}),
            },
          }
        : {}),
      ...(mappedType === "AUTONOMOUS_AGENT" && row.version.erc8004TokenId
        ? {
            agentMeta: {
              erc8004ChainId: FUJI_CHAIN_ID,
              erc8004Registry:
                row.version.erc8004Registry ?? DEFAULT_ERC8004_REGISTRY,
              erc8004TokenId: row.version.erc8004TokenId,
              taskKind: row.version.agentTaskKind ?? "a2a-task",
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
    query: string,
    limit: number,
    filters?: CatalogListFilters,
  ): Promise<PublicFacet[]> {
    const terms = searchTerms(query.trim());
    const rows = await this.base()
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

  async get(id: string): Promise<PublicFacet | undefined> {
    const rows = await this.base()
      .where(and(this.visible(), eq(facets.id, id)))
      .limit(1);
    return rows[0] ? this.map(rows[0]) : undefined;
  }

  async getByName(
    username: string,
    facetName: string,
  ): Promise<PublicFacet | undefined> {
    const rows = await this.base()
      .where(
        and(
          this.visible(),
          eq(providers.slug, username),
          eq(facets.slug, facetName),
        ),
      )
      .limit(1);
    return rows[0] ? this.map(rows[0]) : undefined;
  }
}
