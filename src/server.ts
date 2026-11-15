import { loadEnvFile } from "node:process";

import { buildApp } from "./app.js";
import { createAuthenticator } from "./auth/create-authenticator.js";
import { readConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { FacetDraftService } from "./facets/facet-draft-service.js";
import { FacetPublicationService } from "./facets/facet-publication-service.js";
import { FacetValidationService } from "./facets/facet-validation-service.js";
import { EndpointConfigService } from "./facets/endpoint-config-service.js";
import { PostgresEndpointConfigStore } from "./facets/postgres-endpoint-config-store.js";
import { PostgresFacetValidationStore } from "./facets/postgres-facet-validation-store.js";
import { PostgresFacetDraftStore } from "./facets/postgres-facet-draft-store.js";
import { PostgresFacetPublicationStore } from "./facets/postgres-facet-publication-store.js";
import { PostgresPublicCatalog } from "./facets/public-catalog.js";
import { ImportService } from "./imports/import-service.js";
import { PostgresImportStore } from "./imports/postgres-import-store.js";
import { PostgresProviderStore } from "./providers/postgres-provider-store.js";
import { ProviderService } from "./providers/provider-service.js";
import { LocalSecretValueStore } from "./secrets/local-secret-value-store.js";
import { PostgresSecretStore } from "./secrets/postgres-secret-store.js";
import { SecretService } from "./secrets/secret-service.js";
import { LocalObjectStore } from "./storage/local-object-store.js";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const config = readConfig();
const database = createDatabase(config.DATABASE_URL);
const providerService = new ProviderService(
  new PostgresProviderStore(database.db),
);
const authenticator = createAuthenticator(config);
const importService = new ImportService(
  new PostgresProviderStore(database.db),
  new PostgresImportStore(database.db),
  new LocalObjectStore(config.FACET_OBJECT_ROOT),
  {
    maxDocumentBytes: config.FACET_IMPORT_MAX_DOCUMENT_BYTES,
    maxYamlAliases: config.FACET_IMPORT_MAX_YAML_ALIASES,
    maxRedirects: config.FACET_IMPORT_MAX_REDIRECTS,
    maxReferenceDepth: config.FACET_IMPORT_MAX_REFERENCE_DEPTH,
    maxReferenceCount: config.FACET_IMPORT_MAX_REFERENCE_COUNT,
    maxOperationCount: config.FACET_IMPORT_MAX_OPERATION_COUNT,
    timeoutMs: config.FACET_IMPORT_TIMEOUT_MS,
  },
);
const facetDraftService = new FacetDraftService(
  new PostgresProviderStore(database.db),
  new PostgresFacetDraftStore(database.db),
);
const secretService = new SecretService(
  new PostgresProviderStore(database.db),
  new PostgresSecretStore(database.db),
  new LocalSecretValueStore(config.FACET_SECRET_ROOT),
);
const endpointConfigService = new EndpointConfigService(
  new PostgresProviderStore(database.db),
  new PostgresEndpointConfigStore(database.db),
);
const facetValidationService = new FacetValidationService(
  new PostgresProviderStore(database.db),
  new PostgresFacetValidationStore(database.db),
);
const facetPublicationService = new FacetPublicationService(
  new PostgresProviderStore(database.db),
  new PostgresFacetPublicationStore(database.db),
);
const app = await buildApp({
  checkDatabase: () => database.check(),
  environment: config.FACET_ENV,
  webOrigin: config.WEB_ORIGIN,
  providerRoutes: {
    authenticator,
    service: providerService,
  },
  importRoutes: {
    authenticator,
    service: importService,
    maxDocumentBytes: config.FACET_IMPORT_MAX_DOCUMENT_BYTES,
  },
  facetDraftRoutes: {
    authenticator,
    service: facetDraftService,
  },
  secretRoutes: {
    authenticator,
    service: secretService,
  },
  endpointConfigRoutes: {
    authenticator,
    service: endpointConfigService,
  },
  facetValidationRoutes: {
    authenticator,
    service: facetValidationService,
  },
  facetPublicationRoutes: {
    authenticator,
    service: facetPublicationService,
  },
  publicCatalog: new PostgresPublicCatalog(database.db),
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await database.close();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.HOST, port: config.PORT });
