import { loadEnvFile } from "node:process";

import { buildApp } from "./app.js";
import { createAuthenticator } from "./auth/create-authenticator.js";
import { readConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { ActorAgentService } from "./facets/actor-agent-service.js";
import { createActorPreviewExecutor } from "./facets/actor-preview-client.js";
import { FacetDraftService } from "./facets/facet-draft-service.js";
import { FacetPublicationService } from "./facets/facet-publication-service.js";
import { FacetValidationService } from "./facets/facet-validation-service.js";
import { FujiRegistryVerifier } from "./facets/fuji-registry-verifier.js";
import { EndpointConfigService } from "./facets/endpoint-config-service.js";
import { PostgresActorAgentStore } from "./facets/postgres-actor-agent-store.js";
import { PostgresActorPreviewQuota } from "./facets/postgres-actor-preview-quota.js";
import { PostgresDemoPayerAllowance } from "./facets/demo-payer-authorization.js";
import { PostgresEndpointConfigStore } from "./facets/postgres-endpoint-config-store.js";
import { PostgresFacetValidationStore } from "./facets/postgres-facet-validation-store.js";
import { PostgresFacetDraftStore } from "./facets/postgres-facet-draft-store.js";
import { PostgresFacetPublicationStore } from "./facets/postgres-facet-publication-store.js";
import { PostgresPublicCatalog } from "./facets/public-catalog.js";
import { FujiFusdMinter } from "./faucet/faucet-minter.js";
import { FaucetService, PostgresFaucetStore } from "./faucet/faucet-service.js";
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
if (
  config.FACET_ENV === "production" &&
  config.FACET_AUTH_MODE === "clerk" &&
  !config.CLERK_WEBHOOK_SIGNING_SECRET
) {
  throw new Error(
    "Production Clerk server requires CLERK_WEBHOOK_SIGNING_SECRET",
  );
}
const database = createDatabase(config.DATABASE_URL);
const providerStore = new PostgresProviderStore(database.db);
const providerService = new ProviderService(providerStore, {
  environment: config.FACET_ENV,
  challengeDomain: config.WEB_ORIGIN,
});
const authenticator = createAuthenticator(config, (clerkId) =>
  providerStore.findUserByClerkId(clerkId),
);
const importService = new ImportService(
  providerStore,
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
  providerStore,
  new PostgresFacetDraftStore(database.db),
);
const registryVerifier = config.FACET_ACTOR_REGISTRY_ADDRESS
  ? new FujiRegistryVerifier(
      config.FACET_FUJI_RPC_URL,
      config.FACET_ACTOR_REGISTRY_ADDRESS,
    )
  : undefined;
const actorAgentService = new ActorAgentService(
  providerStore,
  new PostgresActorAgentStore(database.db),
  registryVerifier,
  { environment: config.FACET_ENV, publicBaseUrl: config.WEB_ORIGIN },
);
const secretService = new SecretService(
  providerStore,
  new PostgresSecretStore(database.db),
  new LocalSecretValueStore(config.FACET_SECRET_ROOT),
);
const endpointConfigService = new EndpointConfigService(
  providerStore,
  new PostgresEndpointConfigStore(database.db),
);
const facetValidationService = new FacetValidationService(
  providerStore,
  new PostgresFacetValidationStore(database.db),
);
const facetPublicationService = new FacetPublicationService(
  providerStore,
  new PostgresFacetPublicationStore(database.db),
);
const faucetMinter = config.FACET_FUSD_MINTER_PRIVATE_KEY
  ? new FujiFusdMinter(
      config.FACET_FUJI_RPC_URL,
      config.FACET_USD_ADDRESS,
      config.FACET_FUSD_MINTER_PRIVATE_KEY,
    )
  : undefined;
const faucetService = new FaucetService(
  new PostgresFaucetStore(database.pool),
  faucetMinter,
  {
    dripAtomic: config.FACET_FAUCET_DRIP_ATOMIC,
    addressCooldownSec: config.FACET_FAUCET_ADDRESS_COOLDOWN_SEC,
    ipDailyLimit: config.FACET_FAUCET_IP_DAILY_LIMIT,
    ipHashSalt: config.FACET_FAUCET_IP_HASH_SALT ?? "facet-faucet-v1",
  },
);
const app = await buildApp({
  checkDatabase: () => database.check(),
  environment: config.FACET_ENV,
  webOrigin: config.WEB_ORIGIN,
  ...(config.CLERK_WEBHOOK_SIGNING_SECRET
    ? {
        clerkWebhook: {
          signingSecret: config.CLERK_WEBHOOK_SIGNING_SECRET,
          store: providerStore,
        },
      }
    : {}),
  providerRoutes: {
    authenticator,
    service: providerService,
  },
  ...(config.FACET_EXECUTOR_TOKEN
    ? {
        actorPreviewRoutes: {
          authenticator,
          providers: providerStore,
          consumeQuota: (userId: string, now: Date) =>
            new PostgresActorPreviewQuota(database.db).consume(userId, now),
          execute: createActorPreviewExecutor(
            config.FACET_EXECUTOR_URL,
            config.FACET_EXECUTOR_TOKEN,
          ),
        },
      }
    : {}),
  importRoutes: {
    authenticator,
    service: importService,
    maxDocumentBytes: config.FACET_IMPORT_MAX_DOCUMENT_BYTES,
  },
  facetDraftRoutes: {
    authenticator,
    service: facetDraftService,
  },
  actorAgentRoutes: {
    authenticator,
    service: actorAgentService,
  },
  demoPayerRoutes: {
    authenticator,
    providers: providerStore,
    allowance: new PostgresDemoPayerAllowance(database.pool),
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
  publicCatalog: new PostgresPublicCatalog(
    database.db,
    config.FACET_RUNNER_OCI_DIGEST,
  ),
  faucetRoutes: {
    service: faucetService,
  },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await database.close();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ host: config.HOST, port: config.PORT });
