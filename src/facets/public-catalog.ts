import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { facets, facetVersions, providers } from "../db/schema.js";

export interface PublicFacet {
  id: string;
  versionId: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  provider: { id: string; name: string; slug: string };
  displayVersion: string;
  method: string;
  inputSchema: unknown;
  outputSchema: unknown;
  publishedAt: string;
}

export interface PublicCatalog {
  list(query: string, limit: number): Promise<PublicFacet[]>;
  get(id: string): Promise<PublicFacet | undefined>;
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

  private visible() {
    return and(
      eq(facets.status, "published"),
      eq(facets.visibility, "public"),
      eq(facetVersions.status, "published"),
      eq(providers.status, "active"),
    );
  }

  private map(
    row: Awaited<
      ReturnType<ReturnType<PostgresPublicCatalog["base"]>["limit"]>
    >[number],
  ): PublicFacet {
    const operation = row.version.operation as { method?: string };
    return {
      id: row.facet.id,
      versionId: row.version.id,
      slug: row.facet.slug,
      name: row.facet.name,
      description: row.facet.description,
      category: row.facet.category,
      tags: row.facet.tags,
      provider: {
        id: row.provider.id,
        name: row.provider.name,
        slug: row.provider.slug,
      },
      displayVersion: row.version.displayVersion,
      method: operation.method ?? "GET",
      inputSchema: row.version.inputSchema,
      outputSchema: row.version.outputSchema,
      publishedAt: row.version.publishedAt!.toISOString(),
    };
  }

  async list(query: string, limit: number): Promise<PublicFacet[]> {
    const terms = searchTerms(query.trim());
    const rows = await this.base()
      .where(this.visible())
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
}
