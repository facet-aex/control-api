import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import type { DemoPayerAllowance } from "../src/facets/demo-payer-authorization.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("demo-payer Option B natural-key authorization", () => {
  it("authorizes by separated provider, facetName, and SemVer version and returns providerPayTo", async () => {
    const calls: Array<{
      userId: string;
      provider: string;
      facetName: string;
      version: string;
      idempotencyKey: string;
    }> = [];
    const allowance: DemoPayerAllowance = {
      async authorize(userId, target, idempotencyKey) {
        calls.push({ userId, ...target, idempotencyKey });
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

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      amountAtomic: "1000",
      providerPayTo: "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf",
      remainingToday: 2,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      provider: "vn-data-studio",
      facetName: "vn-gold-fx-actor",
      version: "1.0.0",
      idempotencyKey: "demo-run-1",
    });
  });

  it("rejects legacy UUID facetVersionId payloads and non-SemVer versions", async () => {
    const app = await buildApp({
      checkDatabase: async () => undefined,
      environment: "local",
      webOrigin: "http://localhost:3000",
      demoPayerRoutes: {
        authenticator: new LocalAuthenticator(),
        providers: new InMemoryProviderStore(),
        allowance: {
          async authorize() {
            throw new Error("should not reach store");
          },
        },
      },
    });
    apps.push(app);

    const legacyUuid = await app.inject({
      method: "POST",
      url: "/v1/demo-payer/authorize",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        facetVersionId: "019a6d2f-7b14-7000-8000-000000000002",
        idempotencyKey: "demo-run-2",
      },
    });
    expect(legacyUuid.statusCode).toBe(400);

    const badVersion = await app.inject({
      method: "POST",
      url: "/v1/demo-payer/authorize",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload: {
        provider: "vn-data-studio",
        facetName: "vn-gold-fx-actor",
        version: "v1",
        idempotencyKey: "demo-run-3",
      },
    });
    expect(badVersion.statusCode).toBe(400);
  });
});
