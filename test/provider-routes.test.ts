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

async function getCurrentUser(user: string): Promise<{ id: string }> {
  const response = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { "x-facet-dev-user": user },
  });
  expect(response.statusCode).toBe(200);
  return response.json().user as { id: string };
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

  it("lets owners add, change, list, and remove members with audit events", async () => {
    const created = await createProvider();
    const providerId = created.json().provider.id as string;
    const bob = await getCurrentUser("bob");

    const added = await app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/members/${bob.id}`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { role: "developer" },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({
      membership: { user: { id: bob.id }, role: "developer" },
    });

    const changed = await app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/members/${bob.id}`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { role: "viewer" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ membership: { role: "viewer" } });

    const listed = await app.inject({
      method: "GET",
      url: `/v1/providers/${providerId}/members`,
      headers: { "x-facet-dev-user": "bob" },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().memberships).toHaveLength(2);
    expect(listed.body).not.toContain("externalSubject");
    expect(listed.body).not.toContain("local:bob");

    const removed = await app.inject({
      method: "DELETE",
      url: `/v1/providers/${providerId}/members/${bob.id}`,
      headers: { "x-facet-dev-user": "alice" },
    });
    expect(removed.statusCode).toBe(204);
    expect(store.auditEvents.map((event) => event.eventType)).toEqual([
      "provider.created",
      "provider.membership.created",
      "provider.membership.role_changed",
      "provider.membership.removed",
    ]);
  });

  it("rejects removal or demotion of the final owner", async () => {
    const created = await createProvider();
    const providerId = created.json().provider.id as string;
    const alice = await getCurrentUser("alice");

    const demotion = await app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/members/${alice.id}`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { role: "admin" },
    });
    expect(demotion.statusCode).toBe(409);
    expect(demotion.json()).toMatchObject({
      error: { code: "FINAL_OWNER_REQUIRED" },
    });

    const removal = await app.inject({
      method: "DELETE",
      url: `/v1/providers/${providerId}/members/${alice.id}`,
      headers: { "x-facet-dev-user": "alice" },
    });
    expect(removal.statusCode).toBe(409);
    expect(removal.json()).toMatchObject({
      error: { code: "FINAL_OWNER_REQUIRED" },
    });
  });

  it("does not let admins grant or mutate owner membership", async () => {
    const created = await createProvider();
    const providerId = created.json().provider.id as string;
    const bob = await getCurrentUser("bob");
    const carol = await getCurrentUser("carol");

    await app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/members/${bob.id}`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { role: "admin" },
    });

    const grantOwner = await app.inject({
      method: "PUT",
      url: `/v1/providers/${providerId}/members/${carol.id}`,
      headers: { "x-facet-dev-user": "bob" },
      payload: { role: "owner" },
    });
    expect(grantOwner.statusCode).toBe(403);

    const alice = await getCurrentUser("alice");
    const removeOwner = await app.inject({
      method: "DELETE",
      url: `/v1/providers/${providerId}/members/${alice.id}`,
      headers: { "x-facet-dev-user": "bob" },
    });
    expect(removeOwner.statusCode).toBe(403);
  });

  it("denies cross-provider membership access", async () => {
    const created = await createProvider();
    const providerId = created.json().provider.id as string;

    const response = await app.inject({
      method: "GET",
      url: `/v1/providers/${providerId}/members`,
      headers: { "x-facet-dev-user": "mallory" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: { code: "AUTHORIZATION_DENIED" },
    });
  });
});
