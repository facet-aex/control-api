import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { AppError } from "../src/errors.js";
import {
  ActorAgentService,
  computeActorImageDigest,
} from "../src/facets/actor-agent-service.js";
import type {
  ActorAgentStore,
  PublishedActorRecord,
  PublishedAgentFacetRecord,
} from "../src/facets/actor-agent-types.js";
import { ProviderService } from "../src/providers/provider-service.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

class MemoryActorAgentStore implements ActorAgentStore {
  readonly actors: PublishedActorRecord[] = [];
  readonly agents: PublishedAgentFacetRecord[] = [];
  private readonly slugs = new Set<string>();

  async publishActor(
    input: Parameters<ActorAgentStore["publishActor"]>[0],
  ): Promise<PublishedActorRecord> {
    const key = `${input.command.providerId}:${input.command.slug}`;
    if (this.slugs.has(key)) {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "A Facet with this slug already exists.",
        409,
      );
    }
    this.slugs.add(key);
    const record: PublishedActorRecord = {
      id: randomUUID(),
      versionId: randomUUID(),
      slug: input.command.slug,
      facetType: "HOSTED_ACTOR",
      imageDigest: input.imageDigest,
      status: "PUBLISHED",
      visibility: "PUBLIC",
      publishedAt: new Date("2026-11-16T12:00:00.000Z"),
    };
    this.actors.push(record);
    return record;
  }

  async publishAgentFacet(
    input: Parameters<ActorAgentStore["publishAgentFacet"]>[0],
  ): Promise<PublishedAgentFacetRecord> {
    const key = `${input.command.providerId}:${input.command.slug}`;
    if (this.slugs.has(key)) {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "A Facet with this slug already exists.",
        409,
      );
    }
    this.slugs.add(key);
    const record: PublishedAgentFacetRecord = {
      id: randomUUID(),
      versionId: randomUUID(),
      slug: input.command.slug,
      facetType: "AUTONOMOUS_AGENT",
      erc8004TokenId: input.command.erc8004TokenId,
      erc8004Registry: input.erc8004Registry,
      status: "PUBLISHED",
      visibility: "PUBLIC",
      publishedAt: new Date("2026-11-16T12:00:00.000Z"),
    };
    this.agents.push(record);
    return record;
  }
}

let app: FastifyInstance;
let store: MemoryActorAgentStore;

beforeEach(async () => {
  const providers = new InMemoryProviderStore();
  store = new MemoryActorAgentStore();
  const authenticator = new LocalAuthenticator();
  app = await buildApp({
    checkDatabase: async () => undefined,
    environment: "local",
    webOrigin: "http://localhost:3000",
    providerRoutes: {
      authenticator,
      service: new ProviderService(providers),
    },
    actorAgentRoutes: {
      authenticator,
      service: new ActorAgentService(providers, store),
    },
  });
});

afterEach(async () => app.close());

async function createProvider(user = "alice"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/providers",
    headers: { "x-facet-dev-user": user },
    payload: { slug: `${user}-provider`, name: `${user} Provider` },
  });
  return response.json().provider.id as string;
}

describe("1-step Hosted Actor and ERC-8004 A2A Agent publishing", () => {
  it("publishes a minimalist HOSTED_ACTOR with deterministic imageDigest", async () => {
    const providerId = await createProvider();
    const code =
      "export default async function run(input) { return [{ brand: input.brand ?? 'SJC', price: 89000000 }]; }";

    const response = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        providerId,
        name: "VN Gold & FX Scraper",
        slug: "vn-gold-fx-actor",
        description: "Vietnamese gold and FX rate scraper.",
        category: "vietnamese-data",
        tags: ["vietnam", "gold"],
        inputSchema: {
          type: "object",
          properties: {
            brand: { type: "string", enum: ["ALL", "SJC"] },
          },
        },
        code,
        pricingModel: "PAY_PER_RUN",
        priceAtomic: "1000",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      facet: {
        slug: "vn-gold-fx-actor",
        facetType: "HOSTED_ACTOR",
        imageDigest: computeActorImageDigest(code),
        status: "PUBLISHED",
        visibility: "PUBLIC",
      },
    });
    expect(store.actors).toHaveLength(1);
  });

  it("rejects actor code missing an exported entrypoint", async () => {
    const providerId = await createProvider();
    const response = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        providerId,
        name: "Invalid Actor",
        slug: "invalid-actor",
        description: "Missing export",
        category: "vietnamese-data",
        inputSchema: { type: "object" },
        code: "function helper() { return []; }",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INPUT_INVALID" },
    });
    expect(store.actors).toHaveLength(0);
  });

  it("publishes an ERC-8004 bound AUTONOMOUS_AGENT facet", async () => {
    const providerId = await createProvider();
    const response = await app.inject({
      method: "POST",
      url: "/v1/agent-facets",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        providerId,
        name: "VN Market Analyst Agent",
        slug: "vn-market-analyst-agent",
        description: "ERC-8004 autonomous A2A market analyst.",
        category: "a2a-agents",
        erc8004TokenId: "42",
        taskKind: "vn-market-analysis",
        inputSchema: {
          type: "object",
          required: ["question"],
          properties: { question: { type: "string" } },
        },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      facet: {
        slug: "vn-market-analyst-agent",
        facetType: "AUTONOMOUS_AGENT",
        erc8004TokenId: "42",
        erc8004Registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
        status: "PUBLISHED",
        visibility: "PUBLIC",
      },
    });
    expect(store.agents).toHaveLength(1);
  });

  it("blocks unauthorized users from publishing on another provider", async () => {
    const providerId = await createProvider("alice");
    const response = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "mallory" },
      payload: {
        providerId,
        name: "Unauthorized Actor",
        slug: "unauth-actor",
        description: "Should be denied",
        category: "vietnamese-data",
        inputSchema: { type: "object" },
        code: "export default async function run() { return []; }",
      },
    });

    expect(response.statusCode).toBe(403);
  });
});
