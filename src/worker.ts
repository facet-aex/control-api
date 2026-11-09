import { loadEnvFile } from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { readConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
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
    if (result === "idle") {
      await delay(config.FACET_IMPORT_WORKER_POLL_MS);
    }
  }
} finally {
  await database.close();
}
