import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ImporterClientError,
  type ImporterClient,
  type ImporterResult,
} from "../src/imports/importer-client.js";
import { ImportWorker } from "../src/imports/import-worker.js";
import type {
  ClaimedImportEvent,
  CompletedImport,
  ImportWorkerStore,
  ImportWorkItem,
} from "../src/imports/import-worker-types.js";
import type {
  ImmutableObject,
  ObjectStore,
} from "../src/storage/object-store.js";

const content =
  '{"openapi":"3.1.0","info":{"title":"Test","version":"1"},"paths":{"/x":{"get":{}}}}';
const hash = createHash("sha256").update(content).digest("hex");
const limits = {
  maxDocumentBytes: 1_000,
  maxYamlAliases: 20,
  maxRedirects: 3,
  maxReferenceDepth: 16,
  maxReferenceCount: 256,
  maxOperationCount: 500,
  timeoutMs: 10_000,
};

function importerResult(kind: "paste" | "upload" | "url"): ImporterResult {
  return {
    document: { openapi: "3.1.0", title: "Test", version: "1" },
    candidates: [
      {
        candidateId: "GET /x",
        jsonPointer: "#/paths/~1x/get",
        method: "GET",
        path: "/x",
        tags: [],
        normalized: {
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
          },
          outputSchema: { type: "string" },
          errorSchema: {},
          servers: [],
          authAlternatives: [],
          responseMetadata: {
            successStatusCode: "200",
            successMediaType: "application/json",
            errorStatusCodes: [],
          },
        },
        warnings: [],
      },
    ],
    warnings: [],
    source: {
      kind,
      sha256: hash,
      byteLength: Buffer.byteLength(content),
      ...(kind === "url" ? { mediaType: "application/json" } : {}),
    },
    snapshot: { content },
    limits,
  };
}

class FakeObjectStore implements ObjectStore {
  readonly values = new Map<string, Uint8Array>();

  async putImmutable(value: Uint8Array): Promise<ImmutableObject> {
    const valueHash = createHash("sha256").update(value).digest("hex");
    const objectKey = `sha256/${valueHash.slice(0, 2)}/${valueHash}`;
    this.values.set(objectKey, value);
    return { objectKey, sha256: valueHash, byteLength: value.byteLength };
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const value = this.values.get(objectKey);
    if (!value) throw new Error("missing object");
    return value;
  }

  async delete(objectKey: string): Promise<void> {
    this.values.delete(objectKey);
  }
}

class FakeStore implements ImportWorkerStore {
  readonly claim: ClaimedImportEvent = {
    eventId: "event-1",
    claimToken: "claim-1",
    importJobId: "job-1",
    attemptCount: 1,
  };
  completed?: CompletedImport;
  retried?: { availableAt: Date; errorSummary: string };
  failed?: { errorCode: string; errorSummary: string };

  constructor(readonly work: ImportWorkItem) {}

  async claimNext(): Promise<ClaimedImportEvent | undefined> {
    return this.claim;
  }

  async loadWork(): Promise<ImportWorkItem> {
    return this.work;
  }

  async complete(
    _claim: ClaimedImportEvent,
    _work: ImportWorkItem,
    completed: CompletedImport,
  ): Promise<void> {
    this.completed = completed;
  }

  async retry(
    _claim: ClaimedImportEvent,
    _jobId: string,
    availableAt: Date,
    errorSummary: string,
  ): Promise<void> {
    this.retried = { availableAt, errorSummary };
  }

  async fail(
    _claim: ClaimedImportEvent,
    _jobId: string,
    errorCode: string,
    errorSummary: string,
  ): Promise<void> {
    this.failed = { errorCode, errorSummary };
  }
}

function workItem(kind: "paste" | "upload" | "url"): ImportWorkItem {
  return {
    importJobId: "job-1",
    providerId: "provider-1",
    apiSourceId: "source-1",
    sourceVersionId: kind === "url" ? null : "version-1",
    sourceKind: kind,
    sourceUrl: kind === "url" ? "https://example.com/openapi.json" : null,
    objectKey: kind === "url" ? null : `sha256/${hash.slice(0, 2)}/${hash}`,
    sourceSha256: kind === "url" ? null : hash,
    sourceMediaType: kind === "url" ? null : "application/json",
    createdBy: "user-1",
    limits,
  };
}

function worker(
  store: FakeStore,
  objects: FakeObjectStore,
  importer: ImporterClient,
) {
  return new ImportWorker(store, objects, importer, {
    leaseMs: 30_000,
    maxAttempts: 3,
    retryBaseMs: 100,
  });
}

describe("OpenAPI import worker", () => {
  it("snapshots and completes a URL import", async () => {
    const store = new FakeStore(workItem("url"));
    const objects = new FakeObjectStore();
    const result = await worker(store, objects, {
      parse: async () => importerResult("url"),
    }).runOnce();

    expect(result).toBe("completed");
    expect(store.completed).toMatchObject({
      sha256: hash,
      mediaType: "application/json",
    });
    expect(objects.values.size).toBe(1);
  });

  it("reuses and verifies the queued paste snapshot", async () => {
    const work = workItem("paste");
    const store = new FakeStore(work);
    const objects = new FakeObjectStore();
    objects.values.set(work.objectKey!, Buffer.from(content));
    const result = await worker(store, objects, {
      parse: async (source) => {
        expect(source).toEqual({ kind: "paste", content });
        return importerResult("paste");
      },
    }).runOnce();

    expect(result).toBe("completed");
    expect(store.completed?.objectKey).toBe(work.objectKey);
    expect(objects.values.size).toBe(1);
  });

  it("retries transient importer errors", async () => {
    const store = new FakeStore(workItem("url"));
    const result = await worker(store, new FakeObjectStore(), {
      parse: async () => {
        throw new ImporterClientError("IMPORTER_UNAVAILABLE", "offline", true);
      },
    }).runOnce();

    expect(result).toBe("retried");
    expect(store.retried?.errorSummary).toBe("offline");
    expect(store.failed).toBeUndefined();
  });

  it("fails a transient error after the maximum attempt", async () => {
    const store = new FakeStore(workItem("url"));
    store.claim.attemptCount = 3;
    const result = await worker(store, new FakeObjectStore(), {
      parse: async () => {
        throw new ImporterClientError("IMPORTER_UNAVAILABLE", "offline", true);
      },
    }).runOnce();

    expect(result).toBe("failed");
    expect(store.failed?.errorCode).toBe("IMPORTER_UNAVAILABLE");
    expect(store.retried).toBeUndefined();
  });

  it("fails terminal importer and snapshot-integrity errors", async () => {
    const terminalStore = new FakeStore(workItem("url"));
    expect(
      await worker(terminalStore, new FakeObjectStore(), {
        parse: async () => {
          throw new ImporterClientError("INVALID_OPENAPI", "invalid", false);
        },
      }).runOnce(),
    ).toBe("failed");
    expect(terminalStore.failed?.errorCode).toBe("INVALID_OPENAPI");

    const integrityStore = new FakeStore(workItem("url"));
    expect(
      await worker(integrityStore, new FakeObjectStore(), {
        parse: async () => ({
          ...importerResult("url"),
          source: { ...importerResult("url").source, sha256: "a".repeat(64) },
        }),
      }).runOnce(),
    ).toBe("failed");
    expect(integrityStore.failed?.errorCode).toBe(
      "IMPORTER_SNAPSHOT_INTEGRITY_FAILED",
    );
  });
});
