import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import type { DemoPayerAllowance } from "../src/facets/demo-payer-authorization.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("demo-payer retirement", () => {
  it("returns 410 DEMO_PAYER_RETIRED unconditionally and never invokes allowance.authorize", async () => {
    let authorizeCalls = 0;
    const allowance: DemoPayerAllowance = {
      async authorize() {
        authorizeCalls += 1;
        return {
          amountAtomic: "1000",
          providerPayTo: "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf",
          remainingToday: 2,
        };
      },
    };
    const app = await buildApp({
      checkDatabase: async () => undefined,
      environment: "local",
      webOrigin: "http://localhost:3000",
      demoPayerRoutes: {
        authenticator: new LocalAuthenticator(),
        providers: new InMemoryProviderStore(),
        allowance,
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/demo-payer/authorize",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        provider: "vn-data-studio",
        facetName: "vn-gold-fx-actor",
        version: "1.0.0",
        idempotencyKey: "demo-run-1",
      },
    });

    expect(response.statusCode).toBe(410);
    const body = response.json() as {
      error: { code: string; message: string; requestId: string };
    };
    expect(body.error.code).toBe("DEMO_PAYER_RETIRED");
    expect(body.error.message).toContain("Avalanche");
    expect(body.error.message).not.toMatch(/\bfuji\b/iu);
    expect(body.error.requestId).toBeTruthy();
    expect(authorizeCalls).toBe(0);

    const unauthenticated = await app.inject({
      method: "POST",
      url: "/v1/demo-payer/authorize",
      payload: {},
    });
    expect(unauthenticated.statusCode).toBe(410);
    expect(unauthenticated.json()).toMatchObject({
      error: { code: "DEMO_PAYER_RETIRED" },
    });
    expect(authorizeCalls).toBe(0);
  });
});
