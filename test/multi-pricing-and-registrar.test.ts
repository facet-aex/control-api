import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  parseAbi,
  parseTransaction,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { readConfig } from "../src/config.js";
import { AppError } from "../src/errors.js";
import {
  ActorAgentService,
  computeActorImageDigest,
} from "../src/facets/actor-agent-service.js";
import type {
  ActorAgentStore,
  FacetPricingOption,
  PublishedActorRecord,
  PublishedAgentFacetRecord,
  PublishedFacetRegistryContext,
} from "../src/facets/actor-agent-types.js";
import {
  ActorRegistrationWorker,
  matchesRegistration,
  type ActorRegistrationJob,
} from "../src/facets/actor-registration-worker.js";
import { FujiActorRegistrar } from "../src/facets/fuji-actor-registrar.js";
import { uuidToFacetKey } from "../src/facets/fuji-registry-verifier.js";
import { toMyFacetStatus } from "../src/facets/postgres-actor-agent-store.js";
import { PostgresActorRegistrationStore } from "../src/facets/postgres-actor-registration-store.js";
import {
  PostgresPublicCatalog,
  type PublicCatalogRow,
} from "../src/facets/public-catalog.js";
import { ProviderService } from "../src/providers/provider-service.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

const registryAbi = parseAbi([
  "function owner() view returns (address)",
  "function registerFacet(bytes32 facetId, (uint8 facetType, bytes32 imageDigest, string schemaURI, uint8 pricingModel, uint256 priceAtomic, address payTo, uint256 erc8004TokenId, bool active) registration)",
]);

const SIGNER_KEY =
  "0x1111111111111111111111111111111111111111111111111111111111111111";
const REGISTRY_ADDRESS = "0xc37c12bcd53a4ba5fd33870cecc74a4ba601e3a2";

interface CapturedActorPublish {
  command: Parameters<ActorAgentStore["publishActor"]>[0]["command"];
  manifest: Record<string, unknown>;
  pricingOptions?: FacetPricingOption[] | undefined;
  maxItemsCap?: number | null | undefined;
  payTo: string;
  pending?: boolean | undefined;
  idempotencyKey?: string | undefined;
  requestFingerprint?: string | undefined;
  record: PublishedActorRecord;
}

class RecordingActorStore implements ActorAgentStore {
  readonly published: CapturedActorPublish[] = [];
  private readonly idempotency = new Map<
    string,
    { fingerprint: string; record: PublishedActorRecord }
  >();

  async listMyActors() {
    return [];
  }

  async listMyFacets() {
    return [];
  }

  async getActorPublishStatus() {
    return undefined;
  }

  async publishActor(
    input: Parameters<ActorAgentStore["publishActor"]>[0],
  ): Promise<PublishedActorRecord> {
    if (input.pending && input.idempotencyKey) {
      const key = `${input.actorUserId}:${input.idempotencyKey}`;
      const existing = this.idempotency.get(key);
      if (existing) {
        if (existing.fingerprint !== input.requestFingerprint) {
          throw new AppError(
            "IDEMPOTENCY_CONFLICT",
            "Idempotency key was reused with different Actor pricing or content.",
            409,
          );
        }
        return existing.record;
      }
    }

    const version = input.command.version ?? "1.0.0";
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
      ...(input.pending
        ? {}
        : { publishedAt: new Date("2026-11-20T00:00:00.000Z") }),
    };

    this.published.push({
      command: input.command,
      manifest: input.manifest,
      pricingOptions: input.pricingOptions,
      maxItemsCap: input.maxItemsCap,
      payTo: input.payTo,
      pending: input.pending,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      record,
    });

    if (input.pending && input.idempotencyKey) {
      this.idempotency.set(`${input.actorUserId}:${input.idempotencyKey}`, {
        fingerprint: input.requestFingerprint ?? "",
        record,
      });
    }

    return record;
  }

  async publishAgentFacet(): Promise<PublishedAgentFacetRecord> {
    throw new Error("not used");
  }

  async getPublishedRegistryContextByName(): Promise<
    PublishedFacetRegistryContext | undefined
  > {
    return undefined;
  }

  async markRegistryVerified(): Promise<void> {}
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function buildActorApp(options: {
  environment: "local" | "production";
  maxPaymentAtomic?: string;
}) {
  const providers = new InMemoryProviderStore();
  const store = new RecordingActorStore();
  const authenticator = new LocalAuthenticator();
  const app = await buildApp({
    checkDatabase: async () => undefined,
    environment: options.environment,
    webOrigin:
      options.environment === "production"
        ? "https://facet.example"
        : "http://localhost:3000",
    providerRoutes: {
      authenticator,
      service: new ProviderService(providers, {
        environment: options.environment,
        ...(options.environment === "production"
          ? { challengeDomain: "https://facet.example" }
          : {}),
      }),
    },
    actorAgentRoutes: {
      authenticator,
      service: new ActorAgentService(providers, store, undefined, {
        environment: options.environment,
        ...(options.environment === "production"
          ? { publicBaseUrl: "https://facet.example" }
          : {}),
        ...(options.maxPaymentAtomic
          ? { maxPaymentAtomic: options.maxPaymentAtomic }
          : {}),
      }),
    },
  });
  apps.push(app);
  return { app, store };
}

async function linkWallet(app: FastifyInstance) {
  const wallet = privateKeyToAccount(SIGNER_KEY);
  await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { "x-facet-dev-user": "alice-labs" },
  });
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
  await app.inject({
    method: "POST",
    url: "/v1/providers/alice-labs/wallet-link",
    headers: { "x-facet-dev-user": "alice-labs" },
    payload: {
      challengeId,
      address: wallet.address,
      signature: await wallet.signMessage({ message }),
    },
  });
  return wallet.address;
}

function stubFujiRpcFetch(signerAddress: `0x${string}`) {
  const ownerEncoded = encodeAbiParameters(
    [{ type: "address" }],
    [signerAddress],
  );
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as
      { id: number; method: string } | Array<{ id: number; method: string }>;
    const respond = (req: { id: number; method: string }) => {
      switch (req.method) {
        case "eth_chainId":
          return { jsonrpc: "2.0", id: req.id, result: "0xa869" };
        case "eth_call":
          return { jsonrpc: "2.0", id: req.id, result: ownerEncoded };
        case "eth_getTransactionCount":
          return { jsonrpc: "2.0", id: req.id, result: "0x1" };
        case "eth_getBlockByNumber":
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              number: "0x10",
              hash: `0x${"1".repeat(64)}`,
              baseFeePerGas: "0x3b9aca00",
              gasLimit: "0x1c9c380",
              timestamp: "0x67000000",
            },
          };
        case "eth_maxPriorityFeePerGas":
          return { jsonrpc: "2.0", id: req.id, result: "0x59682f00" };
        case "eth_gasPrice":
          return { jsonrpc: "2.0", id: req.id, result: "0x9502f900" };
        case "eth_feeHistory":
          return {
            jsonrpc: "2.0",
            id: req.id,
            result: {
              oldestBlock: "0x10",
              baseFeePerGas: ["0x3b9aca00", "0x3b9aca00"],
              gasUsedRatio: [0.5],
              reward: [["0x59682f00"]],
            },
          };
        case "eth_estimateGas":
          return { jsonrpc: "2.0", id: req.id, result: "0x30d40" };
        default:
          throw new Error(`Unexpected RPC method: ${req.method}`);
      }
    };
    const payload = Array.isArray(body) ? body.map(respond) : respond(body);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
}

describe("Task S1.2 multi-pricing, generalized registrar, and public catalog", () => {
  it("POST /v1/actors with both PAY_PER_RUN (1000) and PAY_PER_RESULT (500, cap 10) persists both options and anchors primary", async () => {
    const { app, store } = await buildActorApp({ environment: "local" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        facetName: "dual-pricing-actor",
        facetDisplayName: "Dual Pricing Actor",
        description: "Supports both per-run and per-result pricing.",
        category: "vietnamese-data",
        inputSchema: { type: "object" },
        code: "export default async function run(input) { return [input]; }",
        pricingOptions: [
          { model: "PAY_PER_RUN", priceAtomic: "1000" },
          { model: "PAY_PER_RESULT", priceAtomic: "500", maxItemsCap: 10 },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(store.published).toHaveLength(1);
    const entry = store.published[0]!;
    expect(entry.command.pricingModel).toBe("PAY_PER_RUN");
    expect(entry.command.priceAtomic).toBe("1000");
    expect(entry.maxItemsCap).toBe(10);
    expect(entry.pricingOptions).toEqual([
      {
        model: "PAY_PER_RUN",
        priceAtomic: "1000",
        maxAmountAtomic: "1000",
        assetAddress: "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
        chainId: 43113,
        payTo: entry.payTo,
        isPrimary: true,
      },
      {
        model: "PAY_PER_RESULT",
        priceAtomic: "500",
        maxItemsCap: 10,
        maxAmountAtomic: "5000",
        assetAddress: "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
        chainId: 43113,
        payTo: entry.payTo,
        isPrimary: false,
      },
    ]);
    expect(entry.manifest.pricing).toEqual(entry.pricingOptions![0]);
    expect(entry.manifest.pricingOptions).toEqual(entry.pricingOptions);
  });

  it("POST /v1/actors rejects duplicate models, priceAtomic='0', maxItemsCap=0/1001, and unitPrice * maxItemsCap > maxPaymentAtomic", async () => {
    const config = readConfig({
      DATABASE_URL: "postgresql://facet:facet@localhost:5432/facet",
    });
    expect(config.FACET_MAX_PAYMENT_ATOMIC).toBe("10000000");

    const { app } = await buildActorApp({
      environment: "local",
      maxPaymentAtomic: "10000000",
    });

    const basePayload = {
      facetName: "pricing-validation-actor",
      facetDisplayName: "Validation Actor",
      description: "Checks invalid pricing options.",
      category: "data-processing",
      inputSchema: { type: "object" },
      code: "export default async function run(input) { return [input]; }",
    };

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        ...basePayload,
        pricingOptions: [
          { model: "PAY_PER_RUN", priceAtomic: "1000" },
          { model: "PAY_PER_RUN", priceAtomic: "2000" },
        ],
      },
    });
    expect(duplicate.statusCode).toBe(400);

    const zeroPrice = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        ...basePayload,
        pricingOptions: [{ model: "PAY_PER_RUN", priceAtomic: "0" }],
      },
    });
    expect(zeroPrice.statusCode).toBe(400);

    for (const badCap of [0, 1001]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/actors",
        headers: { "x-facet-dev-user": "alice-labs" },
        payload: {
          ...basePayload,
          pricingOptions: [
            {
              model: "PAY_PER_RESULT",
              priceAtomic: "500",
              maxItemsCap: badCap,
            },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
    }

    const overCap = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        ...basePayload,
        pricingOptions: [
          {
            model: "PAY_PER_RESULT",
            priceAtomic: "100001",
            maxItemsCap: 100,
          },
        ],
      },
    });
    expect(overCap.statusCode).toBe(400);

    const twoPrimary = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        ...basePayload,
        pricingOptions: [
          { model: "PAY_PER_RUN", priceAtomic: "1000", isPrimary: true },
          {
            model: "PAY_PER_RESULT",
            priceAtomic: "500",
            maxItemsCap: 5,
            isPrimary: true,
          },
        ],
      },
    });
    expect(twoPrimary.statusCode).toBe(400);

    const runWithCap = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        ...basePayload,
        pricingOptions: [
          { model: "PAY_PER_RUN", priceAtomic: "1000", maxItemsCap: 10 },
        ],
      },
    });
    expect(runWithCap.statusCode).toBe(400);

    expect(
      readConfig({
        DATABASE_URL: "postgresql://facet:facet@localhost:5432/facet",
        FACET_MAX_PAYMENT_ATOMIC: "",
      }).FACET_MAX_PAYMENT_ATOMIC,
    ).toBe("10000000");
    expect(() =>
      readConfig({
        DATABASE_URL: "postgresql://facet:facet@localhost:5432/facet",
        FACET_MAX_PAYMENT_ATOMIC: "0",
      }),
    ).toThrow();
  });

  it("POST /v1/actors defaults primary to PAY_PER_RUN regardless of array order when omitted", async () => {
    const { app, store } = await buildActorApp({ environment: "local" });

    const response = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        facetName: "reversed-order-actor",
        facetDisplayName: "Reversed Order Actor",
        description: "Lists PAY_PER_RESULT first without isPrimary.",
        category: "vietnamese-data",
        inputSchema: { type: "object" },
        code: "export default async function run(input) { return [input]; }",
        pricingOptions: [
          { model: "PAY_PER_RESULT", priceAtomic: "500", maxItemsCap: 8 },
          { model: "PAY_PER_RUN", priceAtomic: "1000" },
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    const entry = store.published[0]!;
    expect(entry.command.pricingModel).toBe("PAY_PER_RUN");
    expect(entry.pricingOptions).toEqual([
      expect.objectContaining({
        model: "PAY_PER_RESULT",
        priceAtomic: "500",
        maxItemsCap: 8,
        maxAmountAtomic: "4000",
        isPrimary: false,
      }),
      expect.objectContaining({
        model: "PAY_PER_RUN",
        priceAtomic: "1000",
        maxAmountAtomic: "1000",
        isPrimary: true,
      }),
    ]);
  });

  it("POST /v1/actors with same Idempotency-Key and different pricingOptions returns 409 IDEMPOTENCY_CONFLICT", async () => {
    const { app } = await buildActorApp({ environment: "production" });
    await linkWallet(app);

    const basePayload = {
      facetName: "idem-pricing-actor",
      facetDisplayName: "Idem Pricing Actor",
      description: "Checks pricing idempotency conflict.",
      category: "web-scraping",
      inputSchema: { type: "object" },
      code: "export default async function run(input) { return [input]; }",
    };

    const first = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: {
        "x-facet-dev-user": "alice-labs",
        "idempotency-key": "actor-idem-pricing-1",
      },
      payload: {
        ...basePayload,
        pricingOptions: [
          { model: "PAY_PER_RESULT", priceAtomic: "500", maxItemsCap: 10 },
        ],
      },
    });
    expect(first.statusCode).toBe(202);

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: {
        "x-facet-dev-user": "alice-labs",
        "idempotency-key": "actor-idem-pricing-1",
      },
      payload: {
        ...basePayload,
        pricingOptions: [
          { model: "PAY_PER_RESULT", priceAtomic: "500", maxItemsCap: 20 },
        ],
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" },
    });
  });

  it("POST /v1/actors with PAY_PER_RESULT only enqueues pricingModel='PAY_PER_RESULT' and FujiActorRegistrar.prepare encodes pricingModel=1", async () => {
    const { app, store } = await buildActorApp({ environment: "production" });
    const payTo = await linkWallet(app);

    const res = await app.inject({
      method: "POST",
      url: "/v1/actors",
      headers: {
        "x-facet-dev-user": "alice-labs",
        "idempotency-key": "per-result-only",
      },
      payload: {
        facetName: "per-result-actor",
        facetDisplayName: "Per Result Actor",
        description: "Charges per result item.",
        category: "vietnamese-data",
        inputSchema: { type: "object" },
        code: "export default async function run(input) { return [input]; }",
        pricingOptions: [
          { model: "PAY_PER_RESULT", priceAtomic: "500", maxItemsCap: 15 },
        ],
      },
    });
    expect(res.statusCode).toBe(202);
    expect(store.published[0]?.command.pricingModel).toBe("PAY_PER_RESULT");
    expect(store.published[0]?.command.priceAtomic).toBe("500");

    const signer = privateKeyToAccount(SIGNER_KEY);
    stubFujiRpcFetch(signer.address);
    const registrar = new FujiActorRegistrar(
      "https://rpc.example",
      REGISTRY_ADDRESS,
      SIGNER_KEY,
    );
    const digest = computeActorImageDigest(
      "export default async function run(input) { return [input]; }",
    );
    const job: ActorRegistrationJob = {
      facetId: randomUUID(),
      versionId: randomUUID(),
      facetType: "ACTOR",
      digest,
      pricingModel: "PAY_PER_RESULT",
      priceAtomic: "500",
      payTo,
      schemaURI:
        "https://facet.example/v1/catalog/facets/alice-labs/per-result-actor/versions/1.0.0",
      signedRaw: null,
      txHash: null,
    };

    const prepared = await registrar.prepare(job);
    const parsedTx = parseTransaction(prepared.raw as `0x${string}`);
    const decoded = decodeFunctionData({
      abi: registryAbi,
      data: parsedTx.data!,
    });
    expect(decoded.functionName).toBe("registerFacet");
    const [keyArg, registrationArg] = decoded.args;
    expect(keyArg).toBe(uuidToFacetKey(job.versionId));
    expect(registrationArg).toBeDefined();
    if (!registrationArg) throw new Error("Expected registration argument");
    expect(registrationArg.facetType).toBe(1);
    expect(registrationArg.pricingModel).toBe(1);
    expect(registrationArg.priceAtomic).toBe(500n);
    expect(registrationArg.imageDigest).toBe(`0x${digest.slice(7)}`);

    const observed = {
      facetType: 1,
      imageDigest: `0x${digest.slice(7)}`,
      pricingModel: 1,
      priceAtomic: "500",
      payTo,
      schemaURI: job.schemaURI,
      active: true,
    };
    expect(matchesRegistration(job, observed)).toBe(true);
    expect(matchesRegistration(job, { ...observed, pricingModel: 0 })).toBe(
      false,
    );
  });

  it("FujiActorRegistrar, PostgresActorRegistrationStore, and ActorRegistrationWorker handle facetType='API' (facetType=0, digest=contentHash) cleanly", async () => {
    const signer = privateKeyToAccount(SIGNER_KEY);
    stubFujiRpcFetch(signer.address);
    const registrar = new FujiActorRegistrar(
      "https://rpc.example",
      REGISTRY_ADDRESS,
      SIGNER_KEY,
    );

    const contentHash = `sha256:${"d".repeat(64)}`;
    const apiJob: ActorRegistrationJob = {
      facetId: randomUUID(),
      versionId: randomUUID(),
      facetType: "API",
      digest: contentHash,
      pricingModel: "PAY_PER_RUN",
      priceAtomic: "1000",
      payTo: signer.address,
      schemaURI:
        "https://facet.example/v1/catalog/facets/alice-labs/weather-api/versions/1.0.0",
      signedRaw: null,
      txHash: null,
    };

    const prepared = await registrar.prepare(apiJob);
    const parsedTx = parseTransaction(prepared.raw as `0x${string}`);
    const decoded = decodeFunctionData({
      abi: registryAbi,
      data: parsedTx.data!,
    });
    const apiRegistrationArg = decoded.args[1];
    expect(apiRegistrationArg).toBeDefined();
    if (!apiRegistrationArg) {
      throw new Error("Expected API registration argument");
    }
    expect(apiRegistrationArg.facetType).toBe(0);
    expect(apiRegistrationArg.pricingModel).toBe(0);
    expect(apiRegistrationArg.imageDigest).toBe(`0x${"d".repeat(64)}`);

    const poolMock = {
      query: vi.fn(async () => ({
        rows: [
          {
            facet_id: apiJob.facetId,
            version_id: apiJob.versionId,
            facet_type: "API",
            image_digest: null,
            content_hash: contentHash,
            pricing_model: "PAY_PER_RESULT",
            price_atomic: "500",
            pay_to: signer.address,
            erc8004_token_id: null,
            schema_uri: apiJob.schemaURI,
            signed_raw: null,
            tx_hash: null,
          },
        ],
      })),
    };
    const pgStore = new PostgresActorRegistrationStore(poolMock as never);
    const fetched = await pgStore.next();
    expect(fetched).toEqual({
      facetId: apiJob.facetId,
      versionId: apiJob.versionId,
      facetType: "API",
      digest: contentHash,
      pricingModel: "PAY_PER_RESULT",
      priceAtomic: "500",
      payTo: signer.address,
      schemaURI: apiJob.schemaURI,
      erc8004TokenId: null,
      signedRaw: null,
      txHash: null,
    });

    const events: string[] = [];
    const current = { ...apiJob };
    const worker = new ActorRegistrationWorker(
      {
        next: async () => current,
        saveSigned: async (_versionId, signed) => {
          events.push("saved");
          current.signedRaw = signed.raw;
          current.txHash = signed.hash;
        },
        promote: async () => {
          events.push("promoted");
        },
        fail: async (_job, code) => {
          events.push(`failed:${code}`);
        },
      },
      {
        readRegistration: async () =>
          current.txHash
            ? {
                facetType: 0,
                imageDigest: `0x${"d".repeat(64)}`,
                pricingModel: 0,
                priceAtomic: apiJob.priceAtomic,
                payTo: apiJob.payTo,
                schemaURI: apiJob.schemaURI,
                active: true,
              }
            : null,
        prepare: async () => prepared,
        broadcast: async () => {
          events.push("broadcast");
        },
        transactionStatus: async () => "confirmed",
      },
    );

    expect(await worker.runOnce()).toBe("pending");
    expect(await worker.runOnce()).toBe("published");
    expect(events).toEqual(["saved", "broadcast", "promoted"]);

    expect(toMyFacetStatus("API", "valid", "pending")).toBe(
      "REGISTRATION_PENDING",
    );
    expect(toMyFacetStatus("API", "valid", "failed")).toBe("FAILED");
    expect(toMyFacetStatus("API", "valid", "published")).toBe("PUBLISHED");
    expect(toMyFacetStatus("API", "valid", null)).toBe("VALID");
  });

  it("PostgresPublicCatalog.map emits pricingOptions[], primary pricing, and apiMeta derived from manifest.operation + manifest.apiConfig", () => {
    const catalog = new PostgresPublicCatalog(null as never);
    const payTo = "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf";
    const txHash = `0x${"e".repeat(64)}`;

    const apiRow: PublicCatalogRow = {
      facet: {
        type: "API",
        facetName: "vn-orders-api",
        facetDisplayName: "VN Orders API",
        description: "Full HTTP API with datasetPath",
        category: "finance",
        tags: ["orders", "api"],
      },
      version: {
        version: "1.2.0",
        manifest: {
          operation: {
            method: "POST",
            publicPathTemplate: "/v1/orders/{region}",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
          },
          apiConfig: {
            datasetPath: "data.items",
            staticHeaderNames: ["X-Region"],
          },
        },
        imageDigest: null,
        pricingModel: "PAY_PER_RESULT",
        priceAtomic: "500",
        pricingOptions: [
          {
            model: "PAY_PER_RUN",
            priceAtomic: "1000",
            isPrimary: false,
          },
          {
            model: "PAY_PER_RESULT",
            priceAtomic: "500",
            maxItemsCap: 12,
            isPrimary: true,
          },
        ],
        maxItemsCap: 12,
        payTo,
        erc8004Registry: null,
        erc8004TokenId: null,
        registryVerified: true,
        registryTxHash: txHash,
        publishedAt: new Date("2026-11-20T01:00:00.000Z"),
      },
      user: {
        username: "alice-labs",
        walletAddress: payTo,
      },
    };

    const mapped = catalog.map(apiRow);
    expect(mapped.method).toBe("POST");
    expect(mapped.pricing).toEqual({
      model: "PAY_PER_RESULT",
      priceAtomic: "500",
      maxItemsCap: 12,
      maxAmountAtomic: "6000",
      assetAddress: "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
      chainId: 43113,
      payTo,
      isPrimary: true,
    });
    expect(mapped.pricingOptions).toEqual([
      {
        model: "PAY_PER_RUN",
        priceAtomic: "1000",
        maxAmountAtomic: "1000",
        assetAddress: "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
        chainId: 43113,
        payTo,
        isPrimary: false,
      },
      mapped.pricing,
    ]);
    expect(mapped.apiMeta).toEqual({
      method: "POST",
      pathTemplate: "/v1/orders/{region}",
      datasetPath: "data.items",
      staticHeaderNames: ["X-Region"],
      registryVerified: true,
      registryTxHash: txHash,
    });

    const backfilledRow: PublicCatalogRow = {
      facet: {
        type: "ACTOR",
        facetName: "backfill-actor",
        facetDisplayName: "Backfill Actor",
        description: "Hydrates 0016 backfilled pricing_options row",
        category: "vietnamese-data",
        tags: ["backfill"],
      },
      version: {
        version: "1.0.0",
        manifest: {
          operation: {
            method: "POST",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
          },
        },
        imageDigest: `sha256:${"a".repeat(64)}`,
        pricingModel: "PAY_PER_RESULT",
        priceAtomic: "500",
        pricingOptions: [
          {
            model: "PAY_PER_RESULT",
            priceAtomic: "500",
            maxItemsCap: 20,
            isPrimary: true,
          },
        ],
        maxItemsCap: 20,
        payTo: null,
        erc8004Registry: null,
        erc8004TokenId: null,
        registryVerified: true,
        registryTxHash: txHash,
        publishedAt: new Date("2026-11-20T01:00:00.000Z"),
      },
      user: {
        username: "alice-labs",
        walletAddress: payTo,
      },
    };
    const backfilled = catalog.map(backfilledRow);
    expect(backfilled.pricing).toEqual({
      model: "PAY_PER_RESULT",
      priceAtomic: "500",
      maxItemsCap: 20,
      maxAmountAtomic: "10000",
      assetAddress: "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
      chainId: 43113,
      payTo,
      isPrimary: true,
    });
    expect(backfilled.pricingOptions).toEqual([backfilled.pricing]);

    const legacyEmpty = catalog.map({
      ...backfilledRow,
      version: {
        ...backfilledRow.version,
        pricingModel: "PAY_PER_RUN",
        priceAtomic: "1000",
        pricingOptions: [],
        maxItemsCap: null,
      },
    });
    expect(legacyEmpty.pricing).toEqual({
      model: "PAY_PER_RUN",
      priceAtomic: "1000",
      maxAmountAtomic: "1000",
      assetAddress: "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
      chainId: 43113,
      payTo,
      isPrimary: true,
    });
    expect(legacyEmpty.pricingOptions).toEqual([legacyEmpty.pricing]);
  });

  it("FujiActorRegistrar.prepare and matchesRegistration encode facetType='AGENT' (2) and erc8004TokenId", async () => {
    const signer = privateKeyToAccount(SIGNER_KEY);
    stubFujiRpcFetch(signer.address);
    const registrar = new FujiActorRegistrar(
      "https://rpc.example",
      REGISTRY_ADDRESS,
      SIGNER_KEY,
    );

    const contentHash = `sha256:${"e".repeat(64)}`;
    const agentJob: ActorRegistrationJob = {
      facetId: randomUUID(),
      versionId: randomUUID(),
      facetType: "AGENT",
      digest: contentHash,
      pricingModel: "PAY_PER_RESULT",
      priceAtomic: "750",
      payTo: signer.address,
      schemaURI:
        "https://facet.example/v1/catalog/facets/alice-labs/market-agent/versions/1.0.0",
      erc8004TokenId: "42",
      signedRaw: null,
      txHash: null,
    };

    const prepared = await registrar.prepare(agentJob);
    const parsedTx = parseTransaction(prepared.raw as `0x${string}`);
    const decoded = decodeFunctionData({
      abi: registryAbi,
      data: parsedTx.data!,
    });
    const agentArg = decoded.args[1];
    expect(agentArg).toBeDefined();
    if (!agentArg) throw new Error("Expected AGENT registration argument");
    expect(agentArg.facetType).toBe(2);
    expect(agentArg.pricingModel).toBe(1);
    expect(agentArg.erc8004TokenId).toBe(42n);

    const observed = {
      facetType: 2,
      imageDigest: `0x${"e".repeat(64)}`,
      pricingModel: 1,
      priceAtomic: "750",
      payTo: signer.address,
      schemaURI: agentJob.schemaURI,
      erc8004TokenId: "42",
      active: true,
    };
    expect(matchesRegistration(agentJob, observed)).toBe(true);
    expect(
      matchesRegistration(agentJob, { ...observed, erc8004TokenId: "99" }),
    ).toBe(false);
  });
});
