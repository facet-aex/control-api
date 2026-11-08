import { loadEnvFile } from "node:process";

import { buildApp } from "./app.js";
import { createAuthenticator } from "./auth/create-authenticator.js";
import { readConfig } from "./config.js";
import { createDatabase } from "./db/client.js";
import { PostgresProviderStore } from "./providers/postgres-provider-store.js";
import { ProviderService } from "./providers/provider-service.js";

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
const app = await buildApp({
  checkDatabase: () => database.check(),
  environment: config.FACET_ENV,
  webOrigin: config.WEB_ORIGIN,
  providerRoutes: {
    authenticator: createAuthenticator(config),
    service: providerService,
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
