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
      service: new ProviderService(store),
    },
  });
});

afterEach(async () => {
  await app.close();
});

async function createProvider(user = "alice") {
  return app.inject({
    method: "POST",
    url: "/v1/providers",
    headers: { "x-facet-dev-user": user },
    payload: {
      slug: "northstar-labs",
      name: "Northstar Labs",
      description: "External data capabilities.",
      websiteUrl: "https://northstar.example",
      walletAddress: "0x0000000000000000000000000000000000000001",
    },
  });
}

describe("provider routes", () => {
  it("creates a provider and owner membership atomically", async () => {
    const response = await createProvider();

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.provider).toMatchObject({
      slug: "northstar-labs",
      name: "Northstar Labs",
      version: 1,
    });
    expect(response.headers.etag).toBe('"1"');
    expect(store.auditEvents).toEqual([
      expect.objectContaining({
        eventType: "provider.created",
        providerId: body.provider.id,
      }),
    ]);

    const memberships = await app.inject({
      method: "GET",
      url: "/v1/me/providers",
      headers: { "x-facet-dev-user": "alice" },
    });
    expect(memberships.json()).toMatchObject({
      memberships: [{ role: "owner", provider: { id: body.provider.id } }],
    });
  });

  it("returns only approved public provider fields", async () => {
    const created = await createProvider();
    const providerId = created.json().provider.id as string;

    const response = await app.inject({
      method: "GET",
      url: `/v1/providers/${providerId}`,
    });
    const serialized = response.body;

    expect(response.statusCode).toBe(200);
    expect(serialized).not.toContain("externalSubject");
    expect(serialized).not.toContain("local:alice");
    expect(serialized).not.toContain("actorUserId");
  });

  it("denies cross-provider profile updates", async () => {
    const created = await createProvider();
    const provider = created.json().provider as { id: string; version: number };

    const response = await app.inject({
      method: "PATCH",
      url: `/v1/providers/${provider.id}`,
      headers: { "x-facet-dev-user": "bob" },
      payload: { version: provider.version, name: "Unauthorized rename" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "AUTHORIZATION_DENIED" },
    });
    expect(store.auditEvents).toHaveLength(1);
  });

  it("updates with optimistic concurrency and rejects a stale retry", async () => {
    const created = await createProvider();
    const provider = created.json().provider as { id: string; version: number };

    const update = await app.inject({
      method: "PATCH",
      url: `/v1/providers/${provider.id}`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { version: provider.version, description: "Updated once." },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({
      provider: { version: 2, description: "Updated once." },
    });

    const stale = await app.inject({
      method: "PATCH",
      url: `/v1/providers/${provider.id}`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { version: provider.version, description: "Stale overwrite." },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({
      error: { code: "VERSION_PRECONDITION_FAILED" },
    });
  });

  it("requires authentication for provider mutations", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/providers",
      payload: { slug: "missing-auth", name: "Missing auth" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" },
    });
  });
});
