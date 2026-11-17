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
  PublishedFacetRegistryContext,
} from "../src/facets/actor-agent-types.js";
import {
  registrationMatches,
  uuidToFacetKey,
  type ExpectedFacetRegistration,
  type RegistryVerifier,
} from "../src/facets/fuji-registry-verifier.js";
import { ProviderService } from "../src/providers/provider-service.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

class MemoryActorAgentStore implements ActorAgentStore {
  readonly actors: PublishedActorRecord[] = [];
  readonly agents: PublishedAgentFacetRecord[] = [];
  readonly contexts = new Map<string, PublishedFacetRegistryContext>();
  readonly verifiedTxs = new Map<string, string>();
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
    const facetId = input.command.id ?? randomUUID();
    const versionId = randomUUID();
    const record: PublishedActorRecord = {
      id: facetId,
      versionId,
      slug: input.command.slug,
      facetType: "HOSTED_ACTOR",
      imageDigest: input.imageDigest,
      registryVerified: input.registryVerified,
      status: "PUBLISHED",
      visibility: "PUBLIC",
      publishedAt: new Date("2026-11-16T12:00:00.000Z"),
    };
    this.actors.push(record);
    this.contexts.set(facetId, {
      facetId,
      providerId: input.command.providerId,
      versionId,
      facetType: "HOSTED_ACTOR",
      imageDigest: input.imageDigest,
      pricingModel: input.command.pricingModel ?? "PAY_PER_RUN",
      priceAtomic: input.command.priceAtomic ?? "1000",
      payTo: input.payTo,
      erc8004TokenId: null,
    });
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
    const facetId = input.command.id ?? randomUUID();
    const versionId = randomUUID();
    const record: PublishedAgentFacetRecord = {
      id: facetId,
      versionId,
      slug: input.command.slug,
      facetType: "AUTONOMOUS_AGENT",
      erc8004TokenId: input.command.erc8004TokenId,
      erc8004Registry: input.erc8004Registry,
      registryVerified: input.registryVerified,
      status: "PUBLISHED",
      visibility: "PUBLIC",
      publishedAt: new Date("2026-11-16T12:00:00.000Z"),
    };
    this.agents.push(record);
    this.contexts.set(facetId, {
      facetId,
      providerId: input.command.providerId,
      versionId,
      facetType: "AUTONOMOUS_AGENT",
      imageDigest: null,
      pricingModel: input.command.pricingModel ?? "PAY_PER_RUN",
      priceAtomic: input.command.priceAtomic ?? "1000",
      payTo: input.payTo,
      erc8004TokenId: input.command.erc8004TokenId,
    });
    return record;
  }

  async getPublishedRegistryContext(
    facetId: string,
  ): Promise<PublishedFacetRegistryContext | undefined> {
    return this.contexts.get(facetId);
  }

  async markRegistryVerified(input: {
    actorUserId: string;
    facetId: string;
    versionId: string;
    providerId: string;
    registryTxHash: string;
    requestId: string;
  }): Promise<void> {
    this.verifiedTxs.set(input.facetId, input.registryTxHash);
  }
}

class StubRegistryVerifier implements RegistryVerifier {
  validHash = `0x${"a".repeat(64)}`;
  lastExpected: ExpectedFacetRegistration | null = null;

  async verifyRegistration(
    registryTxHash: string,
    expected: ExpectedFacetRegistration,
  ) {
    this.lastExpected = expected;
    if (registryTxHash === this.validHash) {
      return { verified: true };
    }
    return {
      verified: false,
      reason: "On-chain imageDigest does not match the published Actor code.",
    };
  }
}

let app: FastifyInstance;
let store: MemoryActorAgentStore;
let verifier: StubRegistryVerifier;

beforeEach(async () => {
  const providers = new InMemoryProviderStore();
  store = new MemoryActorAgentStore();
  verifier = new StubRegistryVerifier();
  const authenticator = new LocalAuthenticator();
  app = await buildApp({
    checkDatabase: async () => undefined,
    environment: "local",
    webOrigin: "http://localhost:3000",
    providerRoutes: {
      authenticator,
      service: new ProviderService(providers, { environment: "local" }),
    },
    actorAgentRoutes: {
      authenticator,
      service: new ActorAgentService(providers, store, verifier),
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
        registryVerified: false,
        status: "PUBLISHED",
        visibility: "PUBLIC",
      },
    });
    expect(store.actors).toHaveLength(1);
  });

  it("verifies on-chain FacetActorRegistry transactions at publish and post-publish", async () => {
    const providerId = await createProvider();
    const facetId = randomUUID();
    const code =
      "export default async function run() { return [{ ok: true }]; }";

    const invalidPublish = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        id: facetId,
        providerId,
        name: "Bad Tx Actor",
        slug: "bad-tx-actor",
        description: "Should fail verification",
        category: "vietnamese-data",
        inputSchema: { type: "object" },
        code,
        registryTxHash: `0x${"b".repeat(64)}`,
      },
    });
    expect(invalidPublish.statusCode).toBe(400);
    expect(invalidPublish.json()).toMatchObject({
      error: { code: "REGISTRY_VERIFICATION_FAILED" },
    });

    const published = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        id: facetId,
        providerId,
        name: "Verified Actor",
        slug: "verified-actor",
        description: "Verified on Fuji",
        category: "vietnamese-data",
        inputSchema: { type: "object" },
        code,
      },
    });
    expect(published.statusCode).toBe(201);
    expect(published.json().facet.registryVerified).toBe(false);

    const verifyRes = await app.inject({
      method: "POST",
      url: `/v1/facets/${facetId}/verify-registry`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { registryTxHash: verifier.validHash },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json()).toMatchObject({
      facetId,
      registryTxHash: verifier.validHash,
      registryVerified: true,
    });
    expect(verifier.lastExpected?.imageDigest).toBe(
      computeActorImageDigest(code),
    );
    expect(store.verifiedTxs.get(facetId)).toBe(verifier.validHash);
  });

  it("matches Fuji FacetActorRegistry event/state strictly against published metadata", () => {
    const facetId = "019a6d2f-7b14-7000-8000-000000000001";
    const code = "export default async function run() { return []; }";
    const imageDigest = computeActorImageDigest(code);
    const hexDigest = `0x${imageDigest.slice(7)}` as `0x${string}`;
    const payTo = "0x9265c1c87fc5fb3c72dc68b4d3a005de1e22c3cf";

    expect(
      registrationMatches(
        {
          facetId: uuidToFacetKey(facetId),
          facetType: 1,
          imageDigest: hexDigest,
          pricingModel: 0,
          priceAtomic: 1000n,
          payTo,
          erc8004TokenId: 0n,
          active: true,
        },
        {
          facetId,
          facetType: "HOSTED_ACTOR",
          imageDigest,
          pricingModel: "PAY_PER_RUN",
          priceAtomic: "1000",
          payTo,
        },
      ),
    ).toEqual({ verified: true });

    expect(
      registrationMatches(
        {
          facetId: uuidToFacetKey(facetId),
          facetType: 1,
          imageDigest: `0x${"0".repeat(64)}`,
          pricingModel: 0,
          priceAtomic: 1000n,
          payTo,
          erc8004TokenId: 0n,
          active: true,
        },
        {
          facetId,
          facetType: "HOSTED_ACTOR",
          imageDigest,
          pricingModel: "PAY_PER_RUN",
          priceAtomic: "1000",
          payTo,
        },
      ).verified,
    ).toBe(false);
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
