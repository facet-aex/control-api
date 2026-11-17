import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { ProviderService } from "../src/providers/provider-service.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

const wallet = "0x0000000000000000000000000000000000000001";
const account = privateKeyToAccount(
  "0x1111111111111111111111111111111111111111111111111111111111111111",
);
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
let now = new Date("2026-11-17T00:00:00.000Z");

beforeEach(() => {
  now = new Date("2026-11-17T00:00:00.000Z");
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function productionApp() {
  const app = await buildApp({
    checkDatabase: async () => undefined,
    environment: "production",
    webOrigin: "https://facet.example",
    providerRoutes: {
      authenticator: new LocalAuthenticator(),
      service: new ProviderService(new InMemoryProviderStore(), {
        environment: "production",
        challengeDomain: "https://facet.example",
        now: () => now,
      }),
    },
  });
  apps.push(app);
  return app;
}

async function localApp() {
  const app = await buildApp({
    checkDatabase: async () => undefined,
    environment: "local",
    webOrigin: "http://localhost:3000",
    providerRoutes: {
      authenticator: new LocalAuthenticator(),
      service: new ProviderService(new InMemoryProviderStore(), {
        environment: "local",
        now: () => now,
      }),
    },
  });
  apps.push(app);
  return app;
}

async function createProvider(
  app: Awaited<ReturnType<typeof buildApp>>,
  slug = "alice-studio",
) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/providers",
    headers: { "x-facet-dev-user": "alice" },
    payload: { slug, name: slug },
  });
  expect(response.statusCode).toBe(201);
  return response.json().provider.id as string;
}

async function challenge(
  app: Awaited<ReturnType<typeof buildApp>>,
  providerId: string,
  user = "alice",
) {
  const response = await app.inject({
    method: "POST",
    url: `/v1/providers/${providerId}/wallet-link-challenges`,
    headers: { "x-facet-dev-user": user },
    payload: {},
  });
  return response;
}

async function confirm(
  app: Awaited<ReturnType<typeof buildApp>>,
  providerId: string,
  challengeId: string,
  message: string,
  address = account.address,
  user = "alice",
) {
  return app.inject({
    method: "POST",
    url: `/v1/providers/${providerId}/wallet-link`,
    headers: { "x-facet-dev-user": user },
    payload: {
      challengeId,
      address,
      signature: await account.signMessage({ message }),
    },
  });
}

describe("production provider payout proof boundary", () => {
  it("rejects a wallet address supplied during provider creation", async () => {
    const app = await productionApp();
    const response = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        slug: "alice-studio",
        name: "Alice Studio",
        walletAddress: wallet,
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "WALLET_PROOF_REQUIRED" },
    });
  });

  it("rejects a direct wallet PATCH even for the provider owner", async () => {
    const app = await productionApp();
    const created = await app.inject({
      method: "POST",
      url: "/v1/providers",
      headers: { "x-facet-dev-user": "alice" },
      payload: { slug: "alice-studio", name: "Alice Studio" },
    });
    expect(created.statusCode).toBe(201);
    const { id, version } = created.json().provider as {
      id: string;
      version: number;
    };

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/providers/${id}`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { version, walletAddress: wallet },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "WALLET_PROOF_REQUIRED" },
    });
  });

  it("links a wallet once from a five-minute domain-bound challenge", async () => {
    const app = await productionApp();
    const providerId = await createProvider(app);
    const issued = await challenge(app, providerId);
    expect(issued.statusCode).toBe(201);
    const { challengeId, message, expiresAt } = issued.json() as {
      challengeId: string;
      message: string;
      expiresAt: string;
    };
    expect(message).toContain("https://facet.example");
    expect(message).toContain(providerId);
    expect(message).toContain("43113");
    expect(new Date(expiresAt).getTime() - now.getTime()).toBe(300_000);

    const linked = await confirm(app, providerId, challengeId, message);
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toMatchObject({ walletAddress: account.address });

    const replay = await confirm(app, providerId, challengeId, message);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({
      error: { code: "WALLET_CHALLENGE_USED" },
    });
  });

  it("rejects another member, provider, signer, domain and chain", async () => {
    const app = await productionApp();
    const providerId = await createProvider(app);
    const otherId = await createProvider(app, "other-studio");
    const issued = await challenge(app, providerId);
    const { challengeId, message } = issued.json() as {
      challengeId: string;
      message: string;
    };

    expect((await challenge(app, providerId, "bob")).statusCode).toBe(403);
    expect(
      (
        await confirm(
          app,
          providerId,
          challengeId,
          message,
          account.address,
          "bob",
        )
      ).statusCode,
    ).toBe(403);
    expect((await confirm(app, otherId, challengeId, message)).statusCode).toBe(
      403,
    );
    expect(
      (await confirm(app, providerId, challengeId, message, wallet)).statusCode,
    ).toBe(403);
    expect(
      (
        await confirm(
          app,
          providerId,
          challengeId,
          message.replace("https://facet.example", "https://evil.example"),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await confirm(
          app,
          providerId,
          challengeId,
          message.replace("43113", "1"),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await confirm(app, providerId, challengeId, message)).statusCode,
    ).toBe(200);
  });

  it("rejects an expired challenge", async () => {
    now = new Date("2026-11-17T00:00:00.000Z");
    const app = await productionApp();
    const providerId = await createProvider(app);
    const issued = await challenge(app, providerId);
    const { challengeId, message } = issued.json() as {
      challengeId: string;
      message: string;
    };
    now = new Date("2026-11-17T00:05:00.001Z");

    const response = await confirm(app, providerId, challengeId, message);
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({
      error: { code: "WALLET_CHALLENGE_EXPIRED" },
    });
  });

  it("clears wallet proof when a local fixture directly changes its address", async () => {
    const app = await localApp();
    const providerId = await createProvider(app);
    const issued = await challenge(app, providerId);
    const { challengeId, message } = issued.json() as {
      challengeId: string;
      message: string;
    };
    expect(
      (await confirm(app, providerId, challengeId, message)).statusCode,
    ).toBe(200);

    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/providers/${providerId}`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { version: 2, walletAddress: wallet },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({
      provider: { walletAddress: wallet, walletVerifiedAt: null },
    });
  });
});
