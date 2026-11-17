import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { ProviderService } from "../src/providers/provider-service.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

const wallet = "0x0000000000000000000000000000000000000001";
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

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
      }),
    },
  });
  apps.push(app);
  return app;
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
});
