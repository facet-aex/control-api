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
  const store = new InMemoryProviderStore();
  const app = await buildApp({
    checkDatabase: async () => undefined,
    environment: "production",
    webOrigin: "https://facet.example",
    providerRoutes: {
      authenticator: new LocalAuthenticator(),
      service: new ProviderService(store, {
        environment: "production",
        challengeDomain: "https://facet.example",
        now: () => now,
      }),
    },
  });
  apps.push(app);
  return { app, store };
}

async function ensureUser(
  app: Awaited<ReturnType<typeof buildApp>>,
  username = "alice-labs",
) {
  const res = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { "x-facet-dev-user": username },
  });
  expect(res.statusCode).toBe(200);
}

async function challenge(
  app: Awaited<ReturnType<typeof buildApp>>,
  provider = "alice-labs",
  user = "alice-labs",
) {
  return app.inject({
    method: "POST",
    url: `/v1/providers/${provider}/wallet-link-challenges`,
    headers: { "x-facet-dev-user": user },
    payload: {},
  });
}

async function confirm(
  app: Awaited<ReturnType<typeof buildApp>>,
  provider: string,
  challengeId: string,
  message: string,
  address = account.address,
  user = "alice-labs",
) {
  return app.inject({
    method: "POST",
    url: `/v1/providers/${provider}/wallet-link`,
    headers: { "x-facet-dev-user": user },
    payload: {
      challengeId,
      address,
      signature: await account.signMessage({ message }),
    },
  });
}

describe("user-owned payout wallet proof boundary", () => {
  it("links a wallet once from a five-minute domain-bound challenge keyed by :provider username", async () => {
    const { app, store } = await productionApp();
    await ensureUser(app, "alice-labs");

    const issued = await challenge(app, "alice-labs");
    expect(issued.statusCode).toBe(201);
    const { challengeId, message, expiresAt } = issued.json() as {
      challengeId: string;
      message: string;
      expiresAt: string;
    };
    expect(message).toContain("https://facet.example");
    expect(message).toContain("Provider: alice-labs");
    expect(message).toContain("43113");
    expect(message).not.toContain("Provider ID");
    expect(message).not.toContain("User ID");
    expect(new Date(expiresAt).getTime() - now.getTime()).toBe(300_000);

    const linked = await confirm(app, "alice-labs", challengeId, message);
    expect(linked.statusCode).toBe(200);
    expect(linked.json()).toEqual({
      walletAddress: account.address,
      verifiedAt: now.toISOString(),
    });
    expect((await store.findUserByUsername("alice-labs"))?.walletAddress).toBe(
      account.address,
    );

    const replay = await confirm(app, "alice-labs", challengeId, message);
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({
      error: { code: "WALLET_CHALLENGE_USED" },
    });
  });

  it("rejects another user, mismatched :provider, wrong signer, modified domain, and wrong chain", async () => {
    const { app } = await productionApp();
    await ensureUser(app, "alice-labs");
    await ensureUser(app, "other-labs");

    const issued = await challenge(app, "alice-labs");
    const { challengeId, message } = issued.json() as {
      challengeId: string;
      message: string;
    };

    expect((await challenge(app, "alice-labs", "bob-studio")).statusCode).toBe(
      403,
    );
    expect(
      (
        await confirm(
          app,
          "alice-labs",
          challengeId,
          message,
          account.address,
          "bob-studio",
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await confirm(
          app,
          "other-labs",
          challengeId,
          message,
          account.address,
          "other-labs",
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await confirm(app, "alice-labs", challengeId, message, wallet))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await confirm(
          app,
          "alice-labs",
          challengeId,
          message.replace("https://facet.example", "https://evil.example"),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await confirm(
          app,
          "alice-labs",
          challengeId,
          message.replace("43113", "1"),
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await confirm(app, "alice-labs", challengeId, message)).statusCode,
    ).toBe(200);
  });

  it("rejects an expired challenge with 410", async () => {
    now = new Date("2026-11-17T00:00:00.000Z");
    const { app } = await productionApp();
    await ensureUser(app, "alice-labs");

    const issued = await challenge(app, "alice-labs");
    const { challengeId, message } = issued.json() as {
      challengeId: string;
      message: string;
    };
    now = new Date("2026-11-17T00:05:00.001Z");

    const response = await confirm(app, "alice-labs", challengeId, message);
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({
      error: { code: "WALLET_CHALLENGE_EXPIRED" },
    });
  });
});
