import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "node:process";

import { eq, inArray } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { readConfig } from "../src/config.js";
import { createDatabase } from "../src/db/client.js";
import {
  apiSources,
  apiSourceVersions,
  auditEvents,
  endpointConfigs,
  facets,
  facetVersions,
  importOperationCandidates,
  openApiImportJobs,
  outboxEvents,
  providers,
  secretRefs,
  users,
} from "../src/db/schema.js";
import { EndpointConfigService } from "../src/facets/endpoint-config-service.js";
import { FacetDraftService } from "../src/facets/facet-draft-service.js";
import { FacetPublicationService } from "../src/facets/facet-publication-service.js";
import { FacetValidationService } from "../src/facets/facet-validation-service.js";
import { PostgresActorPreviewQuota } from "../src/facets/postgres-actor-preview-quota.js";
import { PostgresEndpointConfigStore } from "../src/facets/postgres-endpoint-config-store.js";
import { PostgresFacetDraftStore } from "../src/facets/postgres-facet-draft-store.js";
import { PostgresFacetPublicationStore } from "../src/facets/postgres-facet-publication-store.js";
import { PostgresFacetValidationStore } from "../src/facets/postgres-facet-validation-store.js";
import { PostgresPublicCatalog } from "../src/facets/public-catalog.js";
import { ImportService } from "../src/imports/import-service.js";
import type { ImporterClient } from "../src/imports/importer-client.js";
import { ImportWorker } from "../src/imports/import-worker.js";
import { PostgresImportWorkerStore } from "../src/imports/postgres-import-worker-store.js";
import { PostgresImportStore } from "../src/imports/postgres-import-store.js";
import { PostgresProviderStore } from "../src/providers/postgres-provider-store.js";
import { ProviderService } from "../src/providers/provider-service.js";
import { LocalSecretValueStore } from "../src/secrets/local-secret-value-store.js";
import { PostgresSecretStore } from "../src/secrets/postgres-secret-store.js";
import { SecretService } from "../src/secrets/secret-service.js";
import { LocalObjectStore } from "../src/storage/local-object-store.js";

loadEnvFile();
process.env.NODE_ENV =
  process.env.FACET_SMOKE_DEBUG === "1" ? "development" : "test";
const config = readConfig();
if (config.FACET_ENV !== "local") {
  throw new Error("db:smoke is permitted only when FACET_ENV=local");
}

const database = createDatabase(config.DATABASE_URL);
const objectRoot = await mkdtemp(join(tmpdir(), "facet-db-smoke-"));
const secretRoot = await mkdtemp(join(tmpdir(), "facet-secret-smoke-"));
const providerStore = new PostgresProviderStore(database.db);
const app = await buildApp({
  publicCatalog: new PostgresPublicCatalog(database.db),
  checkDatabase: () => database.check(),
  environment: config.FACET_ENV,
  webOrigin: config.WEB_ORIGIN,
  providerRoutes: {
    authenticator: new LocalAuthenticator(),
    service: new ProviderService(providerStore, { environment: "local" }),
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
  secretRoutes: {
    authenticator: new LocalAuthenticator(),
    service: new SecretService(
      providerStore,
      new PostgresSecretStore(database.db),
      new LocalSecretValueStore(secretRoot),
    ),
  },
  endpointConfigRoutes: {
    authenticator: new LocalAuthenticator(),
    service: new EndpointConfigService(
      providerStore,
      new PostgresEndpointConfigStore(database.db),
    ),
  },
  facetValidationRoutes: {
    authenticator: new LocalAuthenticator(),
    service: new FacetValidationService(
      providerStore,
      new PostgresFacetValidationStore(database.db),
    ),
  },
  facetPublicationRoutes: {
    authenticator: new LocalAuthenticator(),
    service: new FacetPublicationService(
      providerStore,
      new PostgresFacetPublicationStore(database.db),
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
const endpointConfigIds: string[] = [];
const secretRefIds: string[] = [];

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

  const payoutAccount = privateKeyToAccount(
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  );
  const challengeResponse = await app.inject({
    method: "POST",
    url: `/v1/providers/${providerId}/wallet-link-challenges`,
    headers: { "x-facet-dev-user": alice },
    payload: {},
  });
  requireStatus(challengeResponse.statusCode, 201, "create wallet challenge");
  const { challengeId, message } = challengeResponse.json() as {
    challengeId: string;
    message: string;
  };
  const walletPayload = {
    challengeId,
    address: payoutAccount.address,
    signature: await payoutAccount.signMessage({ message }),
  };
  const [walletLinked, walletReplayed] = await Promise.all([
    app.inject({
      method: "POST",
      url: `/v1/providers/${providerId}/wallet-link`,
      headers: { "x-facet-dev-user": alice },
      payload: walletPayload,
    }),
    app.inject({
      method: "POST",
      url: `/v1/providers/${providerId}/wallet-link`,
      headers: { "x-facet-dev-user": alice },
      payload: walletPayload,
    }),
  ]);
  const walletStatuses = [
    walletLinked.statusCode,
    walletReplayed.statusCode,
  ].sort();
  if (walletStatuses[0] !== 200 || walletStatuses[1] !== 409) {
    throw new Error(
      `concurrent wallet challenge consumption: ${walletStatuses.join(",")}`,
    );
  }
  const verifiedProvider = await providerStore.getProvider(providerId);
  if (
    verifiedProvider?.walletAddress !== payoutAccount.address ||
    !verifiedProvider.walletVerifiedAt
  ) {
    throw new Error("wallet proof was not persisted");
  }

  const aliceProfile = await app.inject({
    method: "GET",
    url: "/v1/me",
    headers: { "x-facet-dev-user": alice },
  });
  const aliceId = (aliceProfile.json().user as { id: string }).id;
  const previewQuota = new PostgresActorPreviewQuota(database.db);
  const quotaResults = await Promise.all(
    Array.from({ length: 12 }, () =>
      previewQuota.consume(aliceId, new Date("2026-11-17T12:00:00.000Z")),
    ),
  );
  if (quotaResults.filter(Boolean).length !== 10) {
    throw new Error("concurrent Actor preview quota exceeded its daily cap");
  }
  if (
    !(await previewQuota.consume(aliceId, new Date("2026-11-18T00:00:00.000Z")))
  ) {
    throw new Error("Actor preview quota did not reset on the next UTC day");
  }
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
                  normalized: {
                    inputSchema: {
                      type: "object",
                      additionalProperties: false,
                      properties: {},
                    },
                    outputSchema: { type: "object" },
                    errorSchema: {},
                    servers: [
                      { url: "https://api.example.com", variables: {} },
                    ],
                    authAlternatives: [],
                    responseMetadata: {
                      successStatusCode: "200",
                      successMediaType: "application/json",
                      errorStatusCodes: [],
                    },
                  },
                  warnings: [],
                },
              ]
            : [
                {
                  candidateId: "GET /status",
                  jsonPointer: "#/paths/~1status/get",
                  method: "GET" as const,
                  path: "/status",
                  tags: [],
                  normalized: {
                    inputSchema: {
                      type: "object",
                      additionalProperties: false,
                      properties: {},
                    },
                    outputSchema: { type: "object" },
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
                {
                  candidateId: "GET /health",
                  jsonPointer: "#/paths/~1health/get",
                  method: "GET" as const,
                  path: "/health",
                  tags: [],
                  normalized: {
                    inputSchema: {
                      type: "object",
                      additionalProperties: false,
                      properties: {},
                    },
                    outputSchema: {},
                    errorSchema: {},
                    servers: [],
                    authAlternatives: [],
                    responseMetadata: {
                      successStatusCode: "204",
                      errorStatusCodes: [],
                    },
                  },
                  warnings: [
                    {
                      code: "MISSING_SUCCESS_RESPONSE_SCHEMA",
                      message: "The operation has no success schema.",
                    },
                  ],
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
  if (createdDrafts.statusCode !== 201) {
    throw new Error(
      `create Facet drafts: expected 201, received ${createdDrafts.statusCode}; ${createdDrafts.body}`,
    );
  }
  const createdFacets = createdDrafts.json().facets as Array<{
    id: string;
    draftVersion: {
      id: string;
      version: number;
      sourceVersionId: string;
      validation: { warnings: Array<{ code: string }> };
    };
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
  if (
    !createdFacets.some((facet) =>
      facet.draftVersion.validation.warnings.some(
        (warning) => warning.code === "MISSING_SUCCESS_RESPONSE_SCHEMA",
      ),
    )
  ) {
    throw new Error("Facet draft smoke result lost operation warnings");
  }
  facetIds.push(...createdFacets.map((facet) => facet.id));

  const createdSecret = await app.inject({
    method: "POST",
    url: `/v1/providers/${providerId}/secrets`,
    headers: { "x-facet-dev-user": bob },
    payload: {
      kind: "API_KEY",
      label: "Database smoke key",
      value: `db-smoke-secret-${suffix}`,
    },
  });
  requireStatus(createdSecret.statusCode, 201, "create secret reference");
  if (createdSecret.body.includes(`db-smoke-secret-${suffix}`)) {
    throw new Error("secret smoke response leaked the secret value");
  }
  const secretRefId = (createdSecret.json().secret as { id: string }).id;
  secretRefIds.push(secretRefId);
  const rotatedSecret = await app.inject({
    method: "POST",
    url: `/v1/providers/${providerId}/secrets/${secretRefId}/rotate`,
    headers: { "x-facet-dev-user": bob },
    payload: { value: `db-smoke-rotated-${suffix}` },
  });
  requireStatus(rotatedSecret.statusCode, 200, "rotate secret reference");
  if (rotatedSecret.body.includes(`db-smoke-rotated-${suffix}`)) {
    throw new Error("secret rotation response leaked the secret value");
  }
  const storedSecret = (
    await database.db
      .select()
      .from(secretRefs)
      .where(eq(secretRefs.id, secretRefId))
      .limit(1)
  )[0];
  if (
    !storedSecret ||
    JSON.stringify(storedSecret).includes("db-smoke-secret") ||
    JSON.stringify(storedSecret).includes("db-smoke-rotated")
  ) {
    throw new Error("secret smoke value reached the application database");
  }
  if ((await readdir(secretRoot)).length !== 1) {
    throw new Error(
      "secret rotation did not remove the superseded local value",
    );
  }

  const configuredEndpoint = await app.inject({
    method: "PUT",
    url: `/v1/facet-versions/${createdFacets[0]!.draftVersion.id}/endpoint-config`,
    headers: { "x-facet-dev-user": bob },
    payload: {
      version: createdFacets[0]!.draftVersion.version,
      baseUrl: "https://api.example.com",
      auth: {
        kind: "API_KEY_HEADER",
        secretRefId,
        parameterName: "X-Api-Key",
      },
      timeoutMs: 15_000,
      maxResponseBytes: 1_048_576,
      redirectPolicy: "DENY",
    },
  });
  requireStatus(configuredEndpoint.statusCode, 200, "configure endpoint");
  if (configuredEndpoint.body.includes("api.example.com")) {
    throw new Error("endpoint smoke response leaked the protected base URL");
  }
  endpointConfigIds.push(
    (configuredEndpoint.json().endpointConfig as { id: string }).id,
  );
  const configuredRevision = (
    configuredEndpoint.json().endpointConfig as { facetVersionVersion: number }
  ).facetVersionVersion;
  const validatedDraft = await app.inject({
    method: "POST",
    url: `/v1/facet-versions/${createdFacets[0]!.draftVersion.id}/validate`,
    headers: { "x-facet-dev-user": bob },
    payload: {
      version: configuredRevision,
      warningAcknowledgements: [],
    },
  });
  requireStatus(validatedDraft.statusCode, 200, "validate configured draft");
  const firstValidation = validatedDraft.json().facetVersion as {
    status: "DRAFT" | "VALID";
    version: number;
    validation: { warnings: Array<{ warningId: string }> };
  };
  let finalValidation = firstValidation;
  if (firstValidation.status === "DRAFT") {
    const warningIds = firstValidation.validation.warnings.map(
      (warning) => warning.warningId,
    );
    if (warningIds.length === 0) {
      throw new Error("configured Facet draft stayed invalid without warnings");
    }
    const acknowledgedDraft = await app.inject({
      method: "POST",
      url: `/v1/facet-versions/${createdFacets[0]!.draftVersion.id}/validate`,
      headers: { "x-facet-dev-user": bob },
      payload: {
        version: firstValidation.version,
        warningAcknowledgements: warningIds.map((warningId) => ({
          warningId,
          reason: "Accepted for the Phase 1 database smoke fixture.",
        })),
      },
    });
    requireStatus(
      acknowledgedDraft.statusCode,
      200,
      "acknowledge validation warnings",
    );
    finalValidation = acknowledgedDraft.json()
      .facetVersion as typeof firstValidation;
  }
  if (finalValidation.status !== "VALID") {
    throw new Error(
      "configured and acknowledged Facet draft did not become valid",
    );
  }

  const publishedDraft = await app.inject({
    method: "POST",
    url: `/v1/facet-versions/${createdFacets[0]!.draftVersion.id}/publish`,
    headers: { "x-facet-dev-user": bob },
    payload: {
      version: finalValidation.version,
      visibility: "PUBLIC",
    },
  });
  requireStatus(publishedDraft.statusCode, 200, "publish valid Facet version");
  const publication = publishedDraft.json() as {
    facet: {
      id: string;
      status: string;
      visibility: string;
      currentPublishedVersionId: string;
    };
    facetVersion: { id: string; status: string; contentHash: string };
  };
  if (
    publication.facet.id !== createdFacets[0]!.id ||
    publication.facet.status !== "PUBLISHED" ||
    publication.facet.visibility !== "PUBLIC" ||
    publication.facet.currentPublishedVersionId !==
      createdFacets[0]!.draftVersion.id ||
    publication.facetVersion.status !== "PUBLISHED" ||
    !publication.facetVersion.contentHash.startsWith("sha256:")
  ) {
    throw new Error("publication did not atomically advance the Facet pointer");
  }
  const catalogList = await app.inject({
    method: "GET",
    url: "/v1/catalog/facets?limit=20",
  });
  requireStatus(catalogList.statusCode, 200, "list published public Facets");
  const publicItems = (catalogList.json() as { facets: Array<{ id: string }> })
    .facets;
  if (!publicItems.some((item) => item.id === publication.facet.id)) {
    throw new Error("published public Facet is missing from catalog");
  }
  const intentSearch = await app.inject({
    method: "GET",
    url: "/v1/catalog/facets?q=find%20database%20smoke%20tool",
  });
  requireStatus(intentSearch.statusCode, 200, "search by intent words");
  if (
    !(intentSearch.json() as { facets: Array<{ id: string }> }).facets.some(
      (item) => item.id === publication.facet.id,
    )
  )
    throw new Error("intent search did not find the published Facet");
  const catalogDetail = await app.inject({
    method: "GET",
    url: `/v1/catalog/facets/${publication.facet.id}`,
  });
  requireStatus(catalogDetail.statusCode, 200, "read published public Facet");
  if (
    /protectedBaseUrl|secretRefId|vaultReference/iu.test(catalogDetail.body)
  ) {
    throw new Error("private endpoint or secret reference leaked into catalog");
  }
  const repeatedPublication = await app.inject({
    method: "POST",
    url: `/v1/facet-versions/${createdFacets[0]!.draftVersion.id}/publish`,
    headers: { "x-facet-dev-user": bob },
    payload: {
      version: finalValidation.version + 1,
      visibility: "PUBLIC",
    },
  });
  requireStatus(
    repeatedPublication.statusCode,
    409,
    "reject repeated publication",
  );
  const publishedRevision = finalValidation.version + 1;
  const publishedRevalidation = await app.inject({
    method: "POST",
    url: `/v1/facet-versions/${createdFacets[0]!.draftVersion.id}/validate`,
    headers: { "x-facet-dev-user": bob },
    payload: {
      version: publishedRevision,
      warningAcknowledgements: [],
    },
  });
  requireStatus(
    publishedRevalidation.statusCode,
    409,
    "protect published validation state",
  );
  const publishedReconfiguration = await app.inject({
    method: "PUT",
    url: `/v1/facet-versions/${createdFacets[0]!.draftVersion.id}/endpoint-config`,
    headers: { "x-facet-dev-user": bob },
    payload: {
      version: publishedRevision,
      baseUrl: "https://changed.example.com",
      auth: { kind: "NONE" },
      timeoutMs: 15_000,
      maxResponseBytes: 1_048_576,
      redirectPolicy: "DENY",
    },
  });
  requireStatus(
    publishedReconfiguration.statusCode,
    409,
    "protect published endpoint configuration",
  );

  const usedSecretRevoke = await app.inject({
    method: "DELETE",
    url: `/v1/providers/${providerId}/secrets/${secretRefId}`,
    headers: { "x-facet-dev-user": bob },
  });
  requireStatus(
    usedSecretRevoke.statusCode,
    409,
    "protect an endpoint-configured secret",
  );
  const safeAuditRows = await database.db
    .select({
      eventType: auditEvents.eventType,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .where(eq(auditEvents.providerId, providerId));
  const serializedAudit = JSON.stringify(safeAuditRows);
  if (
    serializedAudit.includes("db-smoke-secret") ||
    serializedAudit.includes("db-smoke-rotated") ||
    serializedAudit.includes("api.example.com")
  ) {
    throw new Error("secret or protected endpoint data reached audit metadata");
  }

  console.log(
    "FACET provider, OpenAPI worker, Facet draft, secret, endpoint, validation, and publication database smoke test passed.",
  );
} finally {
  if (facetIds.length > 0) {
    await database.db
      .update(facets)
      .set({ currentPublishedVersionId: null })
      .where(inArray(facets.id, facetIds));
    await database.db
      .delete(facetVersions)
      .where(inArray(facetVersions.facetId, facetIds));
    await database.db.delete(facets).where(inArray(facets.id, facetIds));
  }
  if (endpointConfigIds.length > 0) {
    await database.db
      .delete(endpointConfigs)
      .where(inArray(endpointConfigs.id, endpointConfigIds));
  }
  if (secretRefIds.length > 0) {
    await database.db
      .delete(secretRefs)
      .where(inArray(secretRefs.id, secretRefIds));
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
  await rm(secretRoot, { recursive: true, force: true });
}
