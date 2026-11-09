import { randomUUID } from "node:crypto";
import { loadEnvFile } from "node:process";

import { eq, inArray } from "drizzle-orm";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { readConfig } from "../src/config.js";
import { createDatabase } from "../src/db/client.js";
import {
  auditEvents,
  outboxEvents,
  providers,
  users,
} from "../src/db/schema.js";
import { PostgresProviderStore } from "../src/providers/postgres-provider-store.js";
import { ProviderService } from "../src/providers/provider-service.js";

loadEnvFile();
process.env.NODE_ENV = "test";
const config = readConfig();
if (config.FACET_ENV !== "local") {
  throw new Error("db:smoke is permitted only when FACET_ENV=local");
}

const database = createDatabase(config.DATABASE_URL);
const app = await buildApp({
  checkDatabase: () => database.check(),
  environment: config.FACET_ENV,
  webOrigin: config.WEB_ORIGIN,
  providerRoutes: {
    authenticator: new LocalAuthenticator(),
    service: new ProviderService(new PostgresProviderStore(database.db)),
  },
});

const suffix = randomUUID();
const alice = `db-smoke-alice-${suffix}`;
const bob = `db-smoke-bob-${suffix}`;
let providerId: string | undefined;

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

  console.log("FACET local database smoke test passed.");
} finally {
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
}
