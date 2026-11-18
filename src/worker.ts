import { loadEnvFile } from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { readConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { ActorRegistrationWorker } from "./facets/actor-registration-worker.js";
import { FujiActorRegistrar } from "./facets/fuji-actor-registrar.js";
import { PostgresActorRegistrationStore } from "./facets/postgres-actor-registration-store.js";
import { HttpImporterClient } from "./imports/importer-client.js";
import { ImportWorker } from "./imports/import-worker.js";
import { PostgresImportWorkerStore } from "./imports/postgres-import-worker-store.js";
import { LocalObjectStore } from "./storage/local-object-store.js";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const config = readConfig();
const database = createDatabase(config.DATABASE_URL);
const worker = new ImportWorker(
  new PostgresImportWorkerStore(database.pool),
  new LocalObjectStore(config.FACET_OBJECT_ROOT),
  new HttpImporterClient(new URL(config.FACET_IMPORTER_URL)),
  {
    leaseMs: config.FACET_IMPORT_WORKER_LEASE_MS,
    maxAttempts: config.FACET_IMPORT_WORKER_MAX_ATTEMPTS,
    retryBaseMs: config.FACET_IMPORT_WORKER_RETRY_BASE_MS,
  },
);
if (
  config.FACET_ENV === "production" &&
  (!config.FACET_ACTOR_REGISTRY_ADDRESS ||
    !config.FACET_REGISTRY_OWNER_PRIVATE_KEY)
) {
  throw new Error(
    "Production registration worker requires a registry address and dedicated owner signer",
  );
}
const registrar =
  config.FACET_ACTOR_REGISTRY_ADDRESS && config.FACET_REGISTRY_OWNER_PRIVATE_KEY
    ? new FujiActorRegistrar(
        config.FACET_FUJI_RPC_URL,
        config.FACET_ACTOR_REGISTRY_ADDRESS,
        config.FACET_REGISTRY_OWNER_PRIVATE_KEY,
      )
    : undefined;
if (registrar) await registrar.assertReady();
const registrationWorker = registrar
  ? new ActorRegistrationWorker(
      new PostgresActorRegistrationStore(database.pool),
      registrar,
    )
  : undefined;

let stopping = false;
process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

try {
  while (!stopping) {
    const result = await worker.runOnce();
    const registrationResult = registrationWorker
      ? await registrationWorker.runOnce()
      : "idle";
    if (result === "idle" && registrationResult === "idle") {
      await delay(config.FACET_IMPORT_WORKER_POLL_MS);
    }
  }
} finally {
  await database.close();
}
