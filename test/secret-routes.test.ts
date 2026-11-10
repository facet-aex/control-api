import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { AppError } from "../src/errors.js";
import { ProviderService } from "../src/providers/provider-service.js";
import { SecretService } from "../src/secrets/secret-service.js";
import type {
  SecretRecord,
  SecretStore,
  SecretValueStore,
} from "../src/secrets/secret-types.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

class MemorySecretValueStore implements SecretValueStore {
  readonly values = new Map<string, string>();
  readonly failedDeletes = new Set<string>();

  async put(value: string) {
    const reference = `opaque/${randomUUID()}`;
    this.values.set(reference, value);
    return { provider: "memory", reference };
  }

  async get(reference: string) {
    const value = this.values.get(reference);
    if (value === undefined) throw new Error("missing secret");
    return value;
  }

  async delete(reference: string) {
    if (this.failedDeletes.delete(reference)) {
      throw new Error("simulated cleanup failure");
    }
    this.values.delete(reference);
  }
}

class MemorySecretStore implements SecretStore {
  readonly records = new Map<string, SecretRecord>();

  async createSecret(input: Parameters<SecretStore["createSecret"]>[0]) {
    const now = new Date("2026-11-09T00:00:00.000Z");
    const record: SecretRecord = {
      id: randomUUID(),
      providerId: input.providerId,
      kind: input.kind,
      label: input.label,
      vaultProvider: input.vaultProvider,
      vaultReference: input.vaultReference,
      status: "active",
      usageCount: 0,
      createdAt: now,
      rotatedAt: null,
      revokedAt: null,
    };
    this.records.set(record.id, record);
    return record;
  }

  async rotateSecret(input: Parameters<SecretStore["rotateSecret"]>[0]) {
    const current = this.records.get(input.secretId);
    if (!current || current.providerId !== input.providerId) return undefined;
    if (current.status !== "active") {
      throw new AppError("RESOURCE_CONFLICT", "Secret is revoked.", 409);
    }
    const updated = {
      ...current,
      vaultProvider: input.vaultProvider,
      vaultReference: input.vaultReference,
      rotatedAt: new Date("2026-11-09T01:00:00.000Z"),
    };
    this.records.set(updated.id, updated);
    return { record: updated, previousReference: current.vaultReference };
  }

  async revokeSecret(input: Parameters<SecretStore["revokeSecret"]>[0]) {
    const current = this.records.get(input.secretId);
    if (!current || current.providerId !== input.providerId) return undefined;
    if (current.usageCount > 0) {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "Secret is still used by an endpoint configuration.",
        409,
      );
    }
    const updated: SecretRecord = {
      ...current,
      status: "revoked",
      revokedAt: new Date("2026-11-09T02:00:00.000Z"),
    };
    this.records.set(updated.id, updated);
    return { record: updated, revokedReference: current.vaultReference };
  }
}

let app: FastifyInstance;
let secrets: MemorySecretStore;
let values: MemorySecretValueStore;

beforeEach(async () => {
  const providers = new InMemoryProviderStore();
  secrets = new MemorySecretStore();
  values = new MemorySecretValueStore();
  const authenticator = new LocalAuthenticator();
  app = await buildApp({
    checkDatabase: async () => undefined,
    environment: "local",
    webOrigin: "http://localhost:3000",
    providerRoutes: {
      authenticator,
      service: new ProviderService(providers),
    },
    secretRoutes: {
      authenticator,
      service: new SecretService(providers, secrets, values),
    },
  });
});

afterEach(async () => app.close());

async function createProvider(user = "alice"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/providers",
    headers: { "x-facet-dev-user": user },
    payload: { slug: `${user}-secrets`, name: `${user} Secrets` },
  });
  return response.json().provider.id as string;
}

describe("provider secret references", () => {
  it("creates and rotates write-only API key values without response leakage", async () => {
    const providerId = await createProvider();
    const created = await app.inject({
      method: "POST",
      url: `/v1/providers/${providerId}/secrets`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { kind: "API_KEY", label: "Demo key", value: "first-canary" },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      secret: {
        providerId,
        kind: "API_KEY",
        label: "Demo key",
        status: "ACTIVE",
        usageCount: 0,
        rotatedAt: null,
      },
    });
    expect(created.body).not.toMatch(/first-canary|vault|reference|opaque/iu);
    const secretId = created.json().secret.id as string;
    const firstReference = secrets.records.get(secretId)!.vaultReference;
    expect(await values.get(firstReference)).toBe("first-canary");

    const rotated = await app.inject({
      method: "POST",
      url: `/v1/providers/${providerId}/secrets/${secretId}/rotate`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { value: "second-canary" },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.body).not.toMatch(/second-canary|vault|reference|opaque/iu);
    const secondReference = secrets.records.get(secretId)!.vaultReference;
    expect(secondReference).not.toBe(firstReference);
    expect(values.values.has(firstReference)).toBe(false);
    expect(await values.get(secondReference)).toBe("second-canary");
  });

  it("denies cross-provider access and revokes an unused secret", async () => {
    const providerId = await createProvider();
    const created = await app.inject({
      method: "POST",
      url: `/v1/providers/${providerId}/secrets`,
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        kind: "BEARER_TOKEN",
        label: "GitHub token",
        value: "bearer-canary",
      },
    });
    const secretId = created.json().secret.id as string;
    const reference = secrets.records.get(secretId)!.vaultReference;

    const denied = await app.inject({
      method: "POST",
      url: `/v1/providers/${providerId}/secrets/${secretId}/rotate`,
      headers: { "x-facet-dev-user": "mallory" },
      payload: { value: "stolen" },
    });
    expect(denied.statusCode).toBe(403);
    expect(await values.get(reference)).toBe("bearer-canary");

    const revoked = await app.inject({
      method: "DELETE",
      url: `/v1/providers/${providerId}/secrets/${secretId}`,
      headers: { "x-facet-dev-user": "alice" },
    });
    expect(revoked.statusCode).toBe(204);
    expect(values.values.has(reference)).toBe(false);
    expect(secrets.records.get(secretId)?.status).toBe("revoked");
  });

  it("keeps the newly committed rotation usable when old-value cleanup fails", async () => {
    const providerId = await createProvider();
    const created = await app.inject({
      method: "POST",
      url: `/v1/providers/${providerId}/secrets`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { kind: "API_KEY", label: "Retry key", value: "old-value" },
    });
    const secretId = created.json().secret.id as string;
    const oldReference = secrets.records.get(secretId)!.vaultReference;
    values.failedDeletes.add(oldReference);

    const rotated = await app.inject({
      method: "POST",
      url: `/v1/providers/${providerId}/secrets/${secretId}/rotate`,
      headers: { "x-facet-dev-user": "alice" },
      payload: { value: "new-value" },
    });

    expect(rotated.statusCode).toBe(200);
    const newReference = secrets.records.get(secretId)!.vaultReference;
    expect(await values.get(newReference)).toBe("new-value");
    expect(await values.get(oldReference)).toBe("old-value");
  });
});
