import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { ProviderService } from "../src/providers/provider-service.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

let app: FastifyInstance;
let store: InMemoryProviderStore;

beforeEach(async () => {
  store = new InMemoryProviderStore();
  app = await buildApp({
    checkDatabase: async () => undefined,
    environment: "local",
    webOrigin: "http://localhost:3000",
    providerRoutes: {
      authenticator: new LocalAuthenticator(),
      service: new ProviderService(store, { environment: "local" }),
    },
  });
});

afterEach(async () => {
  await app.close();
});

describe("unified user & public provider routes", () => {
  it("exposes CurrentUser on GET /v1/me without internal UUIDs and validates 8-16 kebab-case usernames", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { "x-facet-dev-user": "alice-labs" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({
      user: {
        clerkId: "local:alice-labs",
        username: "alice-labs",
        walletAddress: null,
        walletVerifiedAt: null,
        status: "active",
      },
    });
    expect(Object.keys(body.user).sort()).toEqual([
      "clerkId",
      "status",
      "username",
      "walletAddress",
      "walletVerifiedAt",
    ]);

    const shortUser = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { "x-facet-dev-user": "alice" },
    });
    expect(shortUser.statusCode).toBe(409);
    expect(shortUser.json()).toMatchObject({
      error: { code: "USERNAME_REQUIRED" },
    });
  });

  it("serves PublicProvider by natural :provider username without removed legacy fields or UUIDs", async () => {
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { "x-facet-dev-user": "north-labs" },
    });
    expect(me.statusCode).toBe(200);

    const response = await app.inject({
      method: "GET",
      url: "/v1/providers/north-labs",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body.provider).sort()).toEqual([
      "createdAt",
      "provider",
      "status",
      "updatedAt",
      "walletAddress",
      "walletVerifiedAt",
    ]);
    expect(body.provider).toMatchObject({
      provider: "north-labs",
      walletAddress: null,
      walletVerifiedAt: null,
      status: "active",
    });
    expect(response.body).not.toContain("local:north-labs");

    const invalidParam = await app.inject({
      method: "GET",
      url: "/v1/providers/short",
    });
    expect(invalidParam.statusCode).toBe(400);
  });

  it("hides disabled users from GET /v1/providers/:provider and rejects disabled users on GET /v1/me", async () => {
    await store.applyClerkWebhook({
      type: "user.created",
      data: { id: "local:bob-studio", username: "bob-studio" },
    });
    expect(
      (await app.inject({ method: "GET", url: "/v1/providers/bob-studio" }))
        .statusCode,
    ).toBe(200);

    await store.applyClerkWebhook({
      type: "user.deleted",
      data: { id: "local:bob-studio", deleted: true },
    });
    expect(
      (await app.inject({ method: "GET", url: "/v1/providers/bob-studio" }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/me",
          headers: { "x-facet-dev-user": "bob-studio" },
        })
      ).statusCode,
    ).toBe(403);
  });

  it("removes legacy POST /v1/providers, GET /v1/me/providers, PATCH /v1/providers/:provider, and membership routes", async () => {
    const removed = await Promise.all([
      app.inject({
        method: "POST",
        url: "/v1/providers",
        headers: { "x-facet-dev-user": "alice-labs" },
        payload: { slug: "northstar", name: "Northstar" },
      }),
      app.inject({
        method: "GET",
        url: "/v1/me/providers",
        headers: { "x-facet-dev-user": "alice-labs" },
      }),
      app.inject({
        method: "PATCH",
        url: "/v1/providers/alice-labs",
        headers: { "x-facet-dev-user": "alice-labs" },
        payload: { description: "legacy" },
      }),
      app.inject({
        method: "GET",
        url: "/v1/providers/alice-labs/members",
        headers: { "x-facet-dev-user": "alice-labs" },
      }),
    ]);

    for (const res of removed) {
      expect(res.statusCode).toBe(404);
    }
  });
});
