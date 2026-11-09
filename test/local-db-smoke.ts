import { randomUUID } from "node:crypto";
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
  importOperationCandidates,
  openApiImportJobs,
  outboxEvents,
  providers,
  users,
} from "../src/db/schema.js";
import { ImportService } from "../src/imports/import-service.js";
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
  },
});

const suffix = randomUUID();
const alice = `db-smoke-alice-${suffix}`;
const bob = `db-smoke-bob-${suffix}`;
let providerId: string | undefined;
let importJobId: string | undefined;
let apiSourceId: string | undefined;

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
        content:
          "openapi: 3.1.0\ninfo:\n  title: Smoke API\n  version: 1.0.0\npaths: {}\n",
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
  importJobId = queuedJob.id;
  apiSourceId = queuedJob.apiSourceId;
  if (queuedJob.status !== "queued" || !queuedJob.sourceVersionId) {
    throw new Error("import smoke result did not create a source snapshot");
  }

  const fetchedImport = await app.inject({
    method: "GET",
    url: `/v1/openapi-imports/${importJobId}`,
    headers: { "x-facet-dev-user": bob },
  });
  requireStatus(fetchedImport.statusCode, 200, "read OpenAPI import");
  if (fetchedImport.json().job.id !== importJobId) {
    throw new Error("import smoke result returned a different job");
  }

  console.log("FACET provider and OpenAPI import database smoke test passed.");
} finally {
  if (importJobId) {
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
  if (apiSourceId) {
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
