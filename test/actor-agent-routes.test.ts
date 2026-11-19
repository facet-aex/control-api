import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

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

interface StoredActorItem {
  providerId: string;
  provider: string;
  facetId: string;
  versionId: string;
  facetName: string;
  facetDisplayName: string;
  version: string;
  category: string;
  pricingModel: "PAY_PER_RUN" | "PAY_PER_RESULT";
  priceAtomic: string;
  record: PublishedActorRecord;
}

interface StoredAgentItem {
  providerId: string;
  versionId: string;
  category: string;
  pricingModel: "PAY_PER_RUN" | "PAY_PER_RESULT";
  priceAtomic: string;
  record: PublishedAgentFacetRecord;
}

class MemoryActorAgentStore implements ActorAgentStore {
  readonly actors: StoredActorItem[] = [];
  readonly agents: StoredAgentItem[] = [];
  readonly contexts = new Map<string, PublishedFacetRegistryContext>();
  readonly verifiedTxs = new Map<string, string>();
  private readonly versions = new Set<string>();
  private readonly idempotency = new Map<
    string,
    { fingerprint: string; record: PublishedActorRecord }
  >();

  async listMyActors(userId: string) {
    return this.actors
      .filter((item) => item.providerId === userId)
      .map((item) => ({
        provider: item.provider,
        facetName: item.facetName,
        facetDisplayName: item.facetDisplayName,
        version: item.version,
        status: item.record.status,
        registryTxHash: this.verifiedTxs.get(item.versionId) ?? null,
      }));
  }

  async listMyFacets(userId: string) {
    const actorItems = this.actors
      .filter((item) => item.providerId === userId)
      .map((item) => ({
        provider: item.provider,
        facetName: item.facetName,
        facetDisplayName: item.facetDisplayName,
        facetType: "ACTOR" as const,
        version: item.version,
        category: item.category,
        visibility: item.record.visibility,
        status: item.record.status,
        pricingModel: item.pricingModel,
        priceAtomic: item.priceAtomic,
        registryVerified:
          item.record.registryVerified || this.verifiedTxs.has(item.versionId),
        registryTxHash: this.verifiedTxs.get(item.versionId) ?? null,
        errorCode: null,
        createdAt: "2026-11-19T10:00:00.000Z",
        publishedAt: item.record.publishedAt
          ? item.record.publishedAt.toISOString()
          : null,
      }));

    const agentItems = this.agents
      .filter((item) => item.providerId === userId)
      .map((item) => ({
        provider: item.record.provider,
        facetName: item.record.facetName,
        facetDisplayName: item.record.facetDisplayName,
        facetType: "AGENT" as const,
        version: item.record.version,
        category: item.category,
        visibility: item.record.visibility,
        status: item.record.status,
        pricingModel: item.pricingModel,
        priceAtomic: item.priceAtomic,
        registryVerified: this.verifiedTxs.has(item.versionId),
        registryTxHash: this.verifiedTxs.get(item.versionId) ?? null,
        errorCode: null,
        createdAt: "2026-11-19T10:05:00.000Z",
        publishedAt: item.record.publishedAt.toISOString(),
      }));

    return [...actorItems, ...agentItems];
  }

  async getActorPublishStatus(
    provider: string,
    facetName: string,
    version: string,
  ) {
    const item = this.actors.find(
      (candidate) =>
        candidate.provider === provider &&
        candidate.facetName === facetName &&
        candidate.version === version,
    );
    if (!item) return undefined;
    return {
      providerId: item.providerId,
      provider: item.provider,
      facetName: item.facetName,
      version: item.version,
      status: item.record.status,
      registryTxHash: this.verifiedTxs.get(item.versionId) ?? null,
      errorCode: null,
    };
  }

  async publishActor(
    input: Parameters<ActorAgentStore["publishActor"]>[0],
  ): Promise<PublishedActorRecord> {
    const version = input.command.version ?? "1.0.0";
    if (input.pending) {
      const idemKey = `${input.actorUserId}:${input.idempotencyKey}`;
      const previous = this.idempotency.get(idemKey);
      if (previous) {
        if (previous.fingerprint !== input.requestFingerprint) {
          throw new AppError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key has different Actor content.",
            409,
          );
        }
        return previous.record;
      }
    }
    const versionKey = `${input.actorUserId}:${input.command.facetName}:${version}`;
    if (this.versions.has(versionKey)) {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "An Actor with this facetName and version already exists for this provider.",
        409,
      );
    }
    this.versions.add(versionKey);
    const existingFacet = this.actors.find(
      (a) =>
        a.providerId === input.actorUserId &&
        a.facetName === input.command.facetName,
    );
    const facetId = existingFacet?.facetId ?? randomUUID();
    const versionId = randomUUID();
    const record: PublishedActorRecord = {
      provider: input.providerUsername,
      facetName: input.command.facetName,
      facetDisplayName: input.command.facetDisplayName,
      version,
      facetType: "ACTOR",
      imageDigest: input.imageDigest,
      registryVerified: input.registryVerified,
      status: input.pending ? "REGISTRATION_PENDING" : "PUBLISHED",
      visibility: input.pending ? "PRIVATE" : "PUBLIC",
      ...(!input.pending
        ? { publishedAt: new Date("2026-11-16T12:00:00.000Z") }
        : {}),
    };
    this.actors.push({
      providerId: input.actorUserId,
      provider: input.providerUsername,
      facetId,
      versionId,
      facetName: input.command.facetName,
      facetDisplayName: input.command.facetDisplayName,
      version,
      category: input.command.category,
      pricingModel: input.command.pricingModel ?? "PAY_PER_RUN",
      priceAtomic: input.command.priceAtomic ?? "1000",
      record,
    });
    if (input.pending) {
      this.idempotency.set(`${input.actorUserId}:${input.idempotencyKey}`, {
        fingerprint: input.requestFingerprint ?? "",
        record,
      });
    }
    this.contexts.set(
      `${input.providerUsername}/${input.command.facetName}@${version}`,
      {
        facetId,
        providerId: input.actorUserId,
        versionId,
        facetType: "ACTOR",
        imageDigest: input.imageDigest,
        pricingModel: input.command.pricingModel ?? "PAY_PER_RUN",
        priceAtomic: input.command.priceAtomic ?? "1000",
        payTo: input.payTo,
        erc8004TokenId: null,
      },
    );
    return record;
  }

  async publishAgentFacet(
    input: Parameters<ActorAgentStore["publishAgentFacet"]>[0],
  ): Promise<PublishedAgentFacetRecord> {
    const version = input.command.version ?? "1.0.0";
    const key = `${input.actorUserId}:${input.command.facetName}:${version}`;
    if (this.versions.has(key)) {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "An Agent Facet with this facetName and version already exists.",
        409,
      );
    }
    this.versions.add(key);
    const facetId = randomUUID();
    const versionId = randomUUID();
    const record: PublishedAgentFacetRecord = {
      provider: input.providerUsername,
      facetName: input.command.facetName,
      facetDisplayName: input.command.facetDisplayName,
      version,
      facetType: "AGENT",
      erc8004TokenId: input.command.erc8004TokenId,
      erc8004Registry: input.erc8004Registry,
      status: "PUBLISHED",
      visibility: "PUBLIC",
      publishedAt: new Date("2026-11-16T12:00:00.000Z"),
    };
    this.agents.push({
      providerId: input.actorUserId,
      versionId,
      category: input.command.category,
      pricingModel: input.command.pricingModel ?? "PAY_PER_RUN",
      priceAtomic: input.command.priceAtomic ?? "1000",
      record,
    });
    this.contexts.set(
      `${input.providerUsername}/${input.command.facetName}@${version}`,
      {
        facetId,
        providerId: input.actorUserId,
        versionId,
        facetType: "AGENT",
        imageDigest: null,
        pricingModel: input.command.pricingModel ?? "PAY_PER_RUN",
        priceAtomic: input.command.priceAtomic ?? "1000",
        payTo: input.payTo,
        erc8004TokenId: input.command.erc8004TokenId,
      },
    );
    return record;
  }

  async getPublishedRegistryContextByName(
    provider: string,
    facetName: string,
    version: string,
  ): Promise<PublishedFacetRegistryContext | undefined> {
    return this.contexts.get(`${provider}/${facetName}@${version}`);
  }

  async markRegistryVerified(input: {
    actorUserId: string;
    facetId: string;
    versionId: string;
    providerId: string;
    registryTxHash: string;
    requestId: string;
  }): Promise<void> {
    this.verifiedTxs.set(input.versionId, input.registryTxHash);
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
      service: new ActorAgentService(providers, store, verifier, {
        environment: "local",
      }),
    },
  });
});

afterEach(async () => app.close());

describe("1-step Hosted Actor and ERC-8004 A2A Agent publishing under Option B", () => {
  it("requires a verified payout and rejects a different payTo in production", async () => {
    await app.close();
    const providers = new InMemoryProviderStore();
    store = new MemoryActorAgentStore();
    const authenticator = new LocalAuthenticator();
    app = await buildApp({
      checkDatabase: async () => undefined,
      environment: "production",
      webOrigin: "https://facet.example",
      providerRoutes: {
        authenticator,
        service: new ProviderService(providers, {
          environment: "production",
          challengeDomain: "https://facet.example",
        }),
      },
      actorAgentRoutes: {
        authenticator,
        service: new ActorAgentService(providers, store, verifier, {
          environment: "production",
          publicBaseUrl: "https://facet.example",
        }),
      },
    });
    await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { "x-facet-dev-user": "alice-labs" },
    });

    const payload = {
      facetName: "payout-test",
      facetDisplayName: "Payout Test",
      description: "Checks the provider payout.",
      category: "test",
      inputSchema: { type: "object" },
      code: "export default async function run(input) { return [input]; }",
    };
    const invoke = (payTo?: string) =>
      app.inject({
        method: "POST",
        url: "/v1/actors",
        headers: {
          "x-facet-dev-user": "alice-labs",
          "idempotency-key": "payout-check",
        },
        payload: { ...payload, ...(payTo ? { payTo } : {}) },
      });
    expect((await invoke()).statusCode).toBe(403);

    const wallet = privateKeyToAccount(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    );
    const issued = await app.inject({
      method: "POST",
      url: "/v1/providers/alice-labs/wallet-link-challenges",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {},
    });
    const { challengeId, message } = issued.json() as {
      challengeId: string;
      message: string;
    };
    const linked = await app.inject({
      method: "POST",
      url: "/v1/providers/alice-labs/wallet-link",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        challengeId,
        address: wallet.address,
        signature: await wallet.signMessage({ message }),
      },
    });
    expect(linked.statusCode).toBe(200);
    expect(
      (await invoke("0x0000000000000000000000000000000000000001")).statusCode,
    ).toBe(403);
    expect(store.actors).toHaveLength(0);

    const publish = (
      code = payload.code,
      version = "1.0.0",
      idem = "publish-one",
    ) =>
      app.inject({
        method: "POST",
        url: "/v1/actors",
        headers: {
          "x-facet-dev-user": "alice-labs",
          "idempotency-key": idem,
        },
        payload: { ...payload, version, code },
      });
    const first = await publish();
    expect(first.statusCode).toBe(202);
    expect(first.json()).toEqual({
      facet: {
        provider: "alice-labs",
        facetName: "payout-test",
        facetDisplayName: "Payout Test",
        version: "1.0.0",
        facetType: "ACTOR",
        status: "REGISTRATION_PENDING",
        visibility: "PRIVATE",
        imageDigest: computeActorImageDigest(payload.code),
      },
    });

    const status = await app.inject({
      method: "GET",
      url: "/v1/actors/alice-labs/payout-test/versions/1.0.0/publish-status",
      headers: { "x-facet-dev-user": "alice-labs" },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      provider: "alice-labs",
      facetName: "payout-test",
      version: "1.0.0",
      status: "REGISTRATION_PENDING",
    });

    const mine = await app.inject({
      method: "GET",
      url: "/v1/actors/mine",
      headers: { "x-facet-dev-user": "alice-labs" },
    });
    expect(mine.json()).toMatchObject({
      actors: [
        {
          provider: "alice-labs",
          facetName: "payout-test",
          facetDisplayName: "Payout Test",
          version: "1.0.0",
          status: "REGISTRATION_PENDING",
        },
      ],
    });
    expect(mine.body).not.toContain("versionId");

    const allMine = await app.inject({
      method: "GET",
      url: "/v1/facets/mine",
      headers: { "x-facet-dev-user": "alice-labs" },
    });
    expect(allMine.statusCode).toBe(200);
    expect(allMine.json()).toMatchObject({
      facets: [
        {
          provider: "alice-labs",
          facetName: "payout-test",
          facetDisplayName: "Payout Test",
          facetType: "ACTOR",
          version: "1.0.0",
          visibility: "PRIVATE",
          status: "REGISTRATION_PENDING",
        },
      ],
    });
    expect(allMine.body).not.toContain("versionId");
    expect(allMine.body).not.toContain("facetId");

    const forbidden = await app.inject({
      method: "GET",
      url: "/v1/actors/alice-labs/payout-test/versions/1.0.0/publish-status",
      headers: { "x-facet-dev-user": "bob-studio" },
    });
    expect(forbidden.statusCode).toBe(403);

    const replay = await publish();
    expect(replay.statusCode).toBe(202);
    const conflict = await publish(`${payload.code}\n// changed`);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });

    const v2 = await publish(
      `${payload.code}\n// v1.0.1`,
      "1.0.1",
      "publish-two",
    );
    expect(v2.statusCode).toBe(202);
    expect(v2.json().facet.version).toBe("1.0.1");
    expect(store.actors).toHaveLength(2);
  });

  it("rejects non-SemVer versions, invalid facetName, and legacy id/providerId fields on POST /v1/actors", async () => {
    for (const badVersion of ["v1", "01.0.0", "1.0", "latest"]) {
      const bad = await app.inject({
        method: "POST",
        url: "/v1/actors",
        headers: { "x-facet-dev-user": "alice-labs" },
        payload: {
          facetName: "valid-actor",
          facetDisplayName: "Valid Actor",
          version: badVersion,
          description: "Bad semver",
          category: "test",
          inputSchema: { type: "object" },
          code: "export default async function run() { return []; }",
        },
      });
      expect(bad.statusCode).toBe(400);
    }

    const legacyField = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        providerId: randomUUID(),
        facetName: "valid-actor",
        facetDisplayName: "Valid Actor",
        description: "Legacy providerId rejected",
        category: "test",
        inputSchema: { type: "object" },
        code: "export default async function run() { return []; }",
      },
    });
    expect(legacyField.statusCode).toBe(400);
  });

  it("publishes a minimalist ACTOR with deterministic imageDigest and Option B shape", async () => {
    const code =
      "export default async function run(input) { return [{ brand: input.brand ?? 'SJC', price: 89000000 }]; }";

    const response = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        facetName: "vn-gold-fx-actor",
        facetDisplayName: "VN Gold & FX Scraper",
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
    expect(response.json()).toEqual({
      facet: {
        provider: "alice-labs",
        facetName: "vn-gold-fx-actor",
        facetDisplayName: "VN Gold & FX Scraper",
        version: "1.0.0",
        facetType: "ACTOR",
        imageDigest: computeActorImageDigest(code),
        status: "PUBLISHED",
        visibility: "PUBLIC",
        publishedAt: expect.any(String),
      },
    });
    expect(store.actors).toHaveLength(1);
  });

  it("verifies on-chain FacetActorRegistry transactions using versionId or legacy facetId fallback", async () => {
    const code =
      "export default async function run() { return [{ ok: true }]; }";

    const published = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        facetName: "verified-actor",
        facetDisplayName: "Verified Actor",
        description: "Verified on Fuji",
        category: "vietnamese-data",
        inputSchema: { type: "object" },
        code,
      },
    });
    expect(published.statusCode).toBe(201);

    const badVerify = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/verified-actor/versions/1.0.0/verify-registry",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: { registryTxHash: `0x${"b".repeat(64)}` },
    });
    expect(badVerify.statusCode).toBe(400);

    const verifyRes = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/verified-actor/versions/1.0.0/verify-registry",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: { registryTxHash: verifier.validHash },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json()).toEqual({
      provider: "alice-labs",
      facetName: "verified-actor",
      version: "1.0.0",
      registryTxHash: verifier.validHash,
      registryVerified: true,
    });
    expect(verifier.lastExpected?.imageDigest).toBe(
      computeActorImageDigest(code),
    );
    expect(verifier.lastExpected?.facetType).toBe("ACTOR");
    expect(verifier.lastExpected?.versionId).toBe(store.actors[0]!.versionId);
  });

  it("matches Fuji FacetActorRegistry event/state against versionId primary key and legacy facetId fallback", () => {
    const facetId = "019a6d2f-7b14-7000-8000-000000000001";
    const versionId = "019a6d2f-7b14-7000-8000-000000000002";
    const code = "export default async function run() { return []; }";
    const imageDigest = computeActorImageDigest(code);
    const hexDigest = `0x${imageDigest.slice(7)}` as `0x${string}`;
    const payTo = "0x9265c1c87fc5fb3c72dc68b4d3a005de1e22c3cf";

    expect(
      registrationMatches(
        {
          facetId: uuidToFacetKey(versionId),
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
          versionId,
          facetType: "ACTOR",
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
          imageDigest: hexDigest,
          pricingModel: 0,
          priceAtomic: 1000n,
          payTo,
          erc8004TokenId: 0n,
          active: true,
        },
        {
          facetId,
          versionId,
          facetType: "ACTOR",
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
          facetId: uuidToFacetKey(versionId),
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
          versionId,
          facetType: "ACTOR",
          imageDigest,
          pricingModel: "PAY_PER_RUN",
          priceAtomic: "1000",
          payTo,
        },
      ).verified,
    ).toBe(false);
  });

  it("publishes an ERC-8004 bound AGENT facet", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/agent-facets",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        facetName: "vn-market-analyst-agent",
        facetDisplayName: "VN Market Analyst Agent",
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
    expect(response.json()).toEqual({
      facet: {
        provider: "alice-labs",
        facetName: "vn-market-analyst-agent",
        facetDisplayName: "VN Market Analyst Agent",
        version: "1.0.0",
        facetType: "AGENT",
        erc8004TokenId: "42",
        erc8004Registry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
        status: "PUBLISHED",
        visibility: "PUBLIC",
        publishedAt: expect.any(String),
      },
    });
    expect(store.agents).toHaveLength(1);
  });

  it("lists all owned Facet versions across modalities on GET /v1/facets/mine without UUIDs", async () => {
    const unauth = await app.inject({
      method: "GET",
      url: "/v1/facets/mine",
    });
    expect(unauth.statusCode).toBe(401);

    const preview = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: {
        "x-facet-dev-user": "alice-labs",
        "idempotency-key": "mine-actor-1",
      },
      payload: {
        facetName: "html-product-extractor",
        facetDisplayName: "HTML Product Extractor",
        version: "1.0.0",
        description: "Extracts normalized products.",
        category: "web-scraping",
        inputSchema: {
          type: "object",
          properties: { html: { type: "string" } },
        },
        code: "export default async function run(input) { return [{ title: 'ok' }]; }",
      },
    });
    expect(preview.statusCode).toBe(201);

    const agent = await app.inject({
      method: "POST",
      url: "/v1/agent-facets",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        facetName: "vn-market-analyst-agent",
        facetDisplayName: "VN Market Analyst Agent",
        version: "1.0.0",
        description: "Market agent.",
        category: "a2a-agents",
        erc8004TokenId: "42",
        taskKind: "vn-market-analysis",
        inputSchema: {
          type: "object",
          properties: { question: { type: "string" } },
        },
      },
    });
    expect(agent.statusCode).toBe(201);

    const mine = await app.inject({
      method: "GET",
      url: "/v1/facets/mine",
      headers: { "x-facet-dev-user": "alice-labs" },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toEqual({
      facets: [
        expect.objectContaining({
          provider: "alice-labs",
          facetName: "html-product-extractor",
          facetDisplayName: "HTML Product Extractor",
          facetType: "ACTOR",
          version: "1.0.0",
          category: "web-scraping",
          pricingModel: "PAY_PER_RUN",
          priceAtomic: "1000",
        }),
        expect.objectContaining({
          provider: "alice-labs",
          facetName: "vn-market-analyst-agent",
          facetDisplayName: "VN Market Analyst Agent",
          facetType: "AGENT",
          version: "1.0.0",
          category: "a2a-agents",
          status: "PUBLISHED",
          visibility: "PUBLIC",
        }),
      ],
    });
    expect(mine.body).not.toContain("facetId");
    expect(mine.body).not.toContain("versionId");
    expect(mine.body).not.toContain("userId");
  });
});
