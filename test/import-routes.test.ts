import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { ImportService } from "../src/imports/import-service.js";
import type {
  ImportJobRecord,
  ImportStore,
} from "../src/imports/import-types.js";
import { ProviderService } from "../src/providers/provider-service.js";
import type {
  ImmutableObject,
  ObjectStore,
} from "../src/storage/object-store.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();

  async putImmutable(content: Uint8Array): Promise<ImmutableObject> {
    const hash = createHash("sha256").update(content).digest("hex");
    const objectKey = `sha256/${hash.slice(0, 2)}/${hash}`;
    this.objects.set(objectKey, content);
    return { objectKey, sha256: hash, byteLength: content.byteLength };
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const content = this.objects.get(objectKey);
    if (!content) throw new Error("not found");
    return content;
  }

  async delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }
}

class MemoryImportStore implements ImportStore {
  readonly jobs = new Map<string, ImportJobRecord>();

  async createImport(
    input: Parameters<ImportStore["createImport"]>[0],
  ): Promise<ImportJobRecord> {
    const job: ImportJobRecord = {
      id: randomUUID(),
      providerId: input.providerId,
      apiSourceId: randomUUID(),
      sourceVersionId: input.snapshot ? randomUUID() : null,
      status: "queued",
      warnings: [],
      errorCode: null,
      errorSummary: null,
      createdAt: new Date("2026-11-09T00:00:00.000Z"),
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async getImport(jobId: string): Promise<ImportJobRecord | undefined> {
    return this.jobs.get(jobId);
  }

  async listCandidates(jobId: string) {
    return this.jobs.has(jobId)
      ? [
          {
            id: randomUUID(),
            importJobId: jobId,
            jsonPointer: "#/paths/~1status/get",
            operationId: "getStatus",
            method: "GET",
            pathTemplate: "/status",
            summary: "Read status",
            normalizedCandidate: {
              candidateId: "getStatus",
              jsonPointer: "#/paths/~1status/get",
              method: "GET",
              path: "/status",
              tags: [],
            },
            warnings: [],
          },
        ]
      : [];
  }
}

const limits = {
  maxDocumentBytes: 1_000,
  maxYamlAliases: 20,
  maxRedirects: 3,
  maxReferenceDepth: 16,
  maxReferenceCount: 256,
  maxOperationCount: 500,
  timeoutMs: 10_000,
};

let app: FastifyInstance;
let objects: MemoryObjectStore;

beforeEach(async () => {
  const providers = new InMemoryProviderStore();
  const imports = new MemoryImportStore();
  objects = new MemoryObjectStore();
  const authenticator = new LocalAuthenticator();
  app = await buildApp({
    checkDatabase: async () => undefined,
    environment: "local",
    webOrigin: "http://localhost:3000",
    providerRoutes: {
      authenticator,
      service: new ProviderService(providers, { environment: "local" }),
    },
    importRoutes: {
      authenticator,
      service: new ImportService(providers, imports, objects, limits),
      maxDocumentBytes: limits.maxDocumentBytes,
    },
  });
});

afterEach(async () => app.close());

async function createProvider(): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/providers",
    headers: { "x-facet-dev-user": "alice" },
    payload: { slug: "import-provider", name: "Import Provider" },
  });
  return (response.json().provider as { id: string }).id;
}

describe("OpenAPI import commands", () => {
  it("snapshots pasted input and queues an import job", async () => {
    const providerId = await createProvider();
    const response = await app.inject({
      method: "POST",
      url: "/v1/openapi-imports",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        providerId,
        name: "Pasted API",
        source: { kind: "paste", content: "openapi: 3.1.0" },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      job: { providerId, status: "queued" },
    });
    expect(response.json().job.sourceVersionId).toEqual(expect.any(String));
    expect(objects.objects.size).toBe(1);
  });

  it("queues URL input without claiming a source snapshot exists", async () => {
    const providerId = await createProvider();
    const response = await app.inject({
      method: "POST",
      url: "/v1/openapi-imports",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        providerId,
        name: "Remote API",
        source: { kind: "url", url: "https://api.example.com/openapi.json" },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().job.sourceVersionId).toBeNull();
    expect(objects.objects.size).toBe(0);
  });

  it("rejects non-HTTPS URL imports before queueing work", async () => {
    const providerId = await createProvider();
    const response = await app.inject({
      method: "POST",
      url: "/v1/openapi-imports",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        providerId,
        name: "Insecure remote API",
        source: { kind: "url", url: "http://api.example.com/openapi.json" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INPUT_INVALID" },
    });
    expect(objects.objects.size).toBe(0);
  });

  it("denies cross-provider creation and enforces the byte limit", async () => {
    const providerId = await createProvider();
    const denied = await app.inject({
      method: "POST",
      url: "/v1/openapi-imports",
      headers: { "x-facet-dev-user": "mallory" },
      payload: {
        providerId,
        name: "Unauthorized",
        source: { kind: "paste", content: "openapi: 3.1.0" },
      },
    });
    expect(denied.statusCode).toBe(403);

    const oversized = await app.inject({
      method: "POST",
      url: "/v1/openapi-imports",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        providerId,
        name: "Too large",
        source: { kind: "upload", content: "x".repeat(1_001) },
      },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({
      error: { code: "IMPORT_TOO_LARGE" },
    });
  });

  it("accepts a document above Fastify's default 1 MiB when it is within the configured import limit", async () => {
    const providers = new InMemoryProviderStore();
    const imports = new MemoryImportStore();
    const largeObjects = new MemoryObjectStore();
    const authenticator = new LocalAuthenticator();
    const largeLimits = { ...limits, maxDocumentBytes: 1_100_000 };
    const largeApp = await buildApp({
      checkDatabase: async () => undefined,
      environment: "local",
      webOrigin: "http://localhost:3000",
      providerRoutes: {
        authenticator,
        service: new ProviderService(providers, { environment: "local" }),
      },
      importRoutes: {
        authenticator,
        service: new ImportService(
          providers,
          imports,
          largeObjects,
          largeLimits,
        ),
        maxDocumentBytes: largeLimits.maxDocumentBytes,
      },
    });

    try {
      const createdProvider = await largeApp.inject({
        method: "POST",
        url: "/v1/providers",
        headers: { "x-facet-dev-user": "large-owner" },
        payload: { slug: "large-import-provider", name: "Large Import" },
      });
      const providerId = createdProvider.json().provider.id as string;
      const response = await largeApp.inject({
        method: "POST",
        url: "/v1/openapi-imports",
        headers: { "x-facet-dev-user": "large-owner" },
        payload: {
          providerId,
          name: "Large valid transport",
          source: { kind: "paste", content: "x".repeat(1_060_000) },
        },
      });

      expect(response.statusCode).toBe(202);
      expect(largeObjects.objects.size).toBe(1);

      const tooLargeResponse = await largeApp.inject({
        method: "POST",
        url: "/v1/openapi-imports",
        headers: { "x-facet-dev-user": "large-owner" },
        payload: {
          providerId,
          name: "Transport too large",
          source: { kind: "paste", content: "x".repeat(2_300_000) },
        },
      });
      expect(tooLargeResponse.statusCode).toBe(413);
      expect(tooLargeResponse.json()).toMatchObject({
        error: { code: "IMPORT_TOO_LARGE" },
      });
    } finally {
      await largeApp.close();
    }
  });

  it("does not expose a provider import job to another user", async () => {
    const providerId = await createProvider();
    const created = await app.inject({
      method: "POST",
      url: "/v1/openapi-imports",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        providerId,
        name: "Private import",
        source: { kind: "paste", content: "openapi: 3.1.0" },
      },
    });
    const jobId = created.json().job.id as string;

    const denied = await app.inject({
      method: "GET",
      url: `/v1/openapi-imports/${jobId}`,
      headers: { "x-facet-dev-user": "mallory" },
    });

    expect(denied.statusCode).toBe(403);
  });

  it("returns normalized operation candidates only to provider members", async () => {
    const providerId = await createProvider();
    const created = await app.inject({
      method: "POST",
      url: "/v1/openapi-imports",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        providerId,
        name: "Candidate import",
        source: { kind: "paste", content: "openapi: 3.1.0" },
      },
    });
    const jobId = created.json().job.id as string;

    const allowed = await app.inject({
      method: "GET",
      url: `/v1/openapi-imports/${jobId}/operations`,
      headers: { "x-facet-dev-user": "alice" },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      operations: [
        {
          jsonPointer: "#/paths/~1status/get",
          method: "GET",
          path: "/status",
        },
      ],
    });
    expect(JSON.stringify(allowed.json())).not.toContain("objectKey");
    expect(JSON.stringify(allowed.json())).not.toContain("sourceUrl");

    const denied = await app.inject({
      method: "GET",
      url: `/v1/openapi-imports/${jobId}/operations`,
      headers: { "x-facet-dev-user": "mallory" },
    });
    expect(denied.statusCode).toBe(403);
  });
});
