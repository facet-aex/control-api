import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "node:process";

import { eq, inArray } from "drizzle-orm";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { readConfig } from "../src/config.js";
import { createDatabase } from "../src/db/client.js";
import {
  apiSources,
  apiSourceVersions,
  auditEvents,
  facets,
  facetVersions,
  importOperationCandidates,
  openApiImportJobs,
  outboxEvents,
  providers,
  users,
} from "../src/db/schema.js";
import { FacetDraftService } from "../src/facets/facet-draft-service.js";
import { PostgresFacetDraftStore } from "../src/facets/postgres-facet-draft-store.js";
import { ImportService } from "../src/imports/import-service.js";
import type { ImporterClient } from "../src/imports/importer-client.js";
import { ImportWorker } from "../src/imports/import-worker.js";
import { PostgresImportWorkerStore } from "../src/imports/postgres-import-worker-store.js";
import { PostgresImportStore } from "../src/imports/postgres-import-store.js";
import { PostgresProviderStore } from "../src/providers/postgres-provider-store.js";
import { ProviderService } from "../src/providers/provider-service.js";
import { LocalObjectStore } from "../src/storage/local-object-store.js";

loadEnvFile();
process.env.NODE_ENV = "test";
const config = readConfig();
if (config.FACET_ENV !== "local") {
  throw new Error("db:smoke is permitted only when FACET_ENV=local");
}

const database = createDatabase(config.DATABASE_URL);
const objectRoot = await mkdtemp(join(tmpdir(), "facet-db-smoke-"));
const providerStore = new PostgresProviderStore(database.db);
const app = await buildApp({
  checkDatabase: () => database.check(),
  environment: config.FACET_ENV,
  webOrigin: config.WEB_ORIGIN,
  providerRoutes: {
    authenticator: new LocalAuthenticator(),
    service: new ProviderService(providerStore),
  },
  importRoutes: {
    authenticator: new LocalAuthenticator(),
    service: new ImportService(
      providerStore,
      new PostgresImportStore(database.db),
      new LocalObjectStore(objectRoot),
      {
        maxDocumentBytes: config.FACET_IMPORT_MAX_DOCUMENT_BYTES,
        maxYamlAliases: config.FACET_IMPORT_MAX_YAML_ALIASES,
        maxRedirects: config.FACET_IMPORT_MAX_REDIRECTS,
        maxReferenceDepth: config.FACET_IMPORT_MAX_REFERENCE_DEPTH,
        maxReferenceCount: config.FACET_IMPORT_MAX_REFERENCE_COUNT,
        maxOperationCount: config.FACET_IMPORT_MAX_OPERATION_COUNT,
        timeoutMs: config.FACET_IMPORT_TIMEOUT_MS,
      },
    ),
    maxDocumentBytes: config.FACET_IMPORT_MAX_DOCUMENT_BYTES,
  },
  facetDraftRoutes: {
    authenticator: new LocalAuthenticator(),
    service: new FacetDraftService(
      providerStore,
      new PostgresFacetDraftStore(database.db),
    ),
  },
});

const suffix = randomUUID();
const alice = `db-smoke-alice-${suffix}`;
const bob = `db-smoke-bob-${suffix}`;
let providerId: string | undefined;
const importJobIds: string[] = [];
const apiSourceIds: string[] = [];
const facetIds: string[] = [];

function requireStatus(
  actual: number,
  expected: number,
  context: string,
): void {
  if (actual !== expected) {
    throw new Error(`${context}: expected ${expected}, received ${actual}`);
  }
}

try {
  const created = await app.inject({
    method: "POST",
    url: "/v1/providers",
    headers: { "x-facet-dev-user": alice },
    payload: {
      slug: `db-smoke-${suffix}`,
      name: "FACET database smoke provider",
    },
  });
  requireStatus(created.statusCode, 201, "create provider");
  providerId = (created.json().provider as { id: string }).id;

  const aliceProfile = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { "x-facet-dev-user": alice },
  });
  const aliceId = (aliceProfile.json().user as { id: string }).id;
  const finalOwnerRemoval = await app.inject({
    method: "DELETE",
    url: `/v1/providers/${providerId}/members/${aliceId}`,
    headers: { "x-facet-dev-user": alice },
  });
  requireStatus(finalOwnerRemoval.statusCode, 409, "protect final owner");

  const bobProfile = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { "x-facet-dev-user": bob },
  });
  const bobId = (bobProfile.json().user as { id: string }).id;
  const addOwner = await app.inject({
    method: "PUT",
    url: `/v1/providers/${providerId}/members/${bobId}`,
    headers: { "x-facet-dev-user": alice },
    payload: { role: "owner" },
  });
  requireStatus(addOwner.statusCode, 200, "add second owner");

  const removeFirstOwner = await app.inject({
    method: "DELETE",
    url: `/v1/providers/${providerId}/members/${aliceId}`,
    headers: { "x-facet-dev-user": bob },
  });
  requireStatus(removeFirstOwner.statusCode, 204, "remove first owner");

  const members = await app.inject({
    method: "GET",
    url: `/v1/providers/${providerId}/members`,
    headers: { "x-facet-dev-user": bob },
  });
  requireStatus(members.statusCode, 200, "list memberships");
  if ((members.json().memberships as unknown[]).length !== 1) {
    throw new Error("membership smoke result did not retain exactly one owner");
  }

  const pasteContent =
    "openapi: 3.1.0\ninfo:\n  title: Smoke API\n  version: 1.0.0\npaths:\n  /status:\n    get: {}\n  /health:\n    get: {}\n";
  const queuedImport = await app.inject({
    method: "POST",
    url: "/v1/openapi-imports",
    headers: { "x-facet-dev-user": bob },
    payload: {
      providerId,
      name: "FACET database smoke OpenAPI",
      source: {
        kind: "paste",
        mediaType: "application/yaml",
        content: pasteContent,
      },
    },
  });
  requireStatus(queuedImport.statusCode, 202, "queue OpenAPI import");
  const queuedJob = queuedImport.json().job as {
    id: string;
    apiSourceId: string;
    sourceVersionId: string | null;
    status: string;
  };
  importJobIds.push(queuedJob.id);
  apiSourceIds.push(queuedJob.apiSourceId);
  if (queuedJob.status !== "queued" || !queuedJob.sourceVersionId) {
    throw new Error("import smoke result did not create a source snapshot");
  }

  const queuedUrlImport = await app.inject({
    method: "POST",
    url: "/v1/openapi-imports",
    headers: { "x-facet-dev-user": bob },
    payload: {
      providerId,
      name: "FACET database smoke URL OpenAPI",
      source: {
        kind: "url",
        url: "https://api.example.com/openapi.json",
      },
    },
  });
  requireStatus(queuedUrlImport.statusCode, 202, "queue URL OpenAPI import");
  const queuedUrlJob = queuedUrlImport.json().job as {
    id: string;
    apiSourceId: string;
    sourceVersionId: string | null;
  };
  importJobIds.push(queuedUrlJob.id);
  apiSourceIds.push(queuedUrlJob.apiSourceId);
  if (queuedUrlJob.sourceVersionId !== null) {
    throw new Error("URL import claimed a snapshot before worker fetch");
  }

  const urlContent =
    '{"openapi":"3.0.3","info":{"title":"URL Smoke","version":"1"},"paths":{"/token":{"get":{}}}}';
  const importer: ImporterClient = {
    parse: async (source, limits) => {
      const sourceContent = source.kind === "url" ? urlContent : source.content;
      return {
        document: {
          openapi: source.kind === "url" ? "3.0.3" : "3.1.0",
          title: source.kind === "url" ? "URL Smoke" : "Smoke API",
          version: "1",
        },
        candidates:
          source.kind === "url"
            ? [
                {
                  candidateId: "GET /token",
                  jsonPointer: "#/paths/~1token/get",
                  method: "GET" as const,
                  path: "/token",
                  tags: [],
                },
              ]
            : [
                {
                  candidateId: "GET /status",
                  jsonPointer: "#/paths/~1status/get",
                  method: "GET" as const,
                  path: "/status",
                  tags: [],
                },
                {
                  candidateId: "GET /health",
                  jsonPointer: "#/paths/~1health/get",
                  method: "GET" as const,
                  path: "/health",
                  tags: [],
                },
              ],
        warnings: [],
        source: {
          kind: source.kind,
          sha256: createHash("sha256").update(sourceContent).digest("hex"),
          byteLength: Buffer.byteLength(sourceContent),
          ...(source.kind === "url"
            ? {
                mediaType: "application/json",
                finalUrl: source.url,
                redirectCount: 0,
              }
            : {}),
        },
        snapshot: { content: sourceContent },
        limits,
      };
    },
  };
  const worker = new ImportWorker(
    new PostgresImportWorkerStore(database.pool),
    new LocalObjectStore(objectRoot),
    importer,
    { leaseMs: 30_000, maxAttempts: 3, retryBaseMs: 100 },
  );
  for (let index = 0; index < importJobIds.length; index += 1) {
    if ((await worker.runOnce()) !== "completed") {
      throw new Error("database smoke worker did not complete an import");
    }
  }

  const fetchedImport = await app.inject({
    method: "GET",
    url: `/v1/openapi-imports/${queuedJob.id}`,
    headers: { "x-facet-dev-user": bob },
  });
  requireStatus(fetchedImport.statusCode, 200, "read OpenAPI import");
  if (
    fetchedImport.json().job.id !== queuedJob.id ||
    fetchedImport.json().job.status !== "ready"
  ) {
    throw new Error("paste import smoke result was not ready");
  }
  const fetchedUrlImport = await app.inject({
    method: "GET",
    url: `/v1/openapi-imports/${queuedUrlJob.id}`,
    headers: { "x-facet-dev-user": bob },
  });
  requireStatus(fetchedUrlImport.statusCode, 200, "read URL OpenAPI import");
  if (
    fetchedUrlImport.json().job.status !== "ready" ||
    !fetchedUrlImport.json().job.sourceVersionId
  ) {
    throw new Error("URL import smoke result did not persist its snapshot");
  }
  let pasteOperations: Array<{ id: string }> = [];
  for (const importJobId of importJobIds) {
    const operations = await app.inject({
      method: "GET",
      url: `/v1/openapi-imports/${importJobId}/operations`,
      headers: { "x-facet-dev-user": bob },
    });
    requireStatus(operations.statusCode, 200, "read import operations");
    const importedOperations = operations.json().operations as Array<{
      id: string;
    }>;
    const expectedCount = importJobId === queuedJob.id ? 2 : 1;
    if (importedOperations.length !== expectedCount) {
      throw new Error("import smoke API returned the wrong candidate count");
    }
    if (importJobId === queuedJob.id) pasteOperations = importedOperations;
  }

  const createdDrafts = await app.inject({
    method: "POST",
    url: "/v1/facets",
    headers: { "x-facet-dev-user": bob },
    payload: {
      providerId,
      importJobId: queuedJob.id,
      selections: pasteOperations.map((operation, index) => ({
        operationCandidateId: operation.id,
        slug: `db-smoke-${index}-${suffix}`,
        name: `Database smoke Facet ${index}`,
        category: "testing",
        tags: ["db-smoke"],
        sideEffectClass: "READ_ONLY",
      })),
    },
  });
  requireStatus(createdDrafts.statusCode, 201, "create Facet drafts");
  const createdFacets = createdDrafts.json().facets as Array<{
    id: string;
    draftVersion: { sourceVersionId: string };
  }>;
  if (
    createdFacets.length !== 2 ||
    createdFacets.some(
      (facet) =>
        facet.draftVersion.sourceVersionId !== queuedJob.sourceVersionId,
    )
  ) {
    throw new Error("Facet draft smoke result lost import provenance");
  }
  facetIds.push(...createdFacets.map((facet) => facet.id));

  console.log(
    "FACET provider, OpenAPI worker, and Facet draft database smoke test passed.",
  );
} finally {
  if (facetIds.length > 0) {
    await database.db
      .delete(facetVersions)
      .where(inArray(facetVersions.facetId, facetIds));
    await database.db.delete(facets).where(inArray(facets.id, facetIds));
  }
  for (const importJobId of importJobIds) {
    await database.db
      .delete(importOperationCandidates)
      .where(eq(importOperationCandidates.importJobId, importJobId));
    await database.db
      .delete(outboxEvents)
      .where(eq(outboxEvents.aggregateId, importJobId));
    await database.db
      .delete(openApiImportJobs)
      .where(eq(openApiImportJobs.id, importJobId));
  }
  for (const apiSourceId of apiSourceIds) {
    await database.db
      .delete(apiSourceVersions)
      .where(eq(apiSourceVersions.apiSourceId, apiSourceId));
    await database.db.delete(apiSources).where(eq(apiSources.id, apiSourceId));
  }
  if (providerId) {
    await database.db
      .delete(auditEvents)
      .where(eq(auditEvents.providerId, providerId));
    await database.db
      .delete(outboxEvents)
      .where(eq(outboxEvents.aggregateId, providerId));
    await database.db.delete(providers).where(eq(providers.id, providerId));
  }
  await database.db
    .delete(users)
    .where(inArray(users.externalSubject, [`local:${alice}`, `local:${bob}`]));
  await app.close();
  await database.close();
  await rm(objectRoot, { recursive: true, force: true });
}
