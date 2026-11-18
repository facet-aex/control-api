import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createDatabase } from "../src/db/client.js";
import { providers, users } from "../src/db/schema.js";
import { PostgresActorAgentStore } from "../src/facets/postgres-actor-agent-store.js";
import { PostgresActorRegistrationStore } from "../src/facets/postgres-actor-registration-store.js";
import { PostgresPublicCatalog } from "../src/facets/public-catalog.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const database = createDatabase(process.env.DATABASE_URL);
try {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await database.db
    .insert(users)
    .values({ externalSubject: `smoke:${suffix}` })
    .returning();
  const [provider] = await database.db
    .insert(providers)
    .values({ slug: `smoke-${suffix}`, name: "Smoke" })
    .returning();
  assert(user && provider);
  const store = new PostgresActorAgentStore(database.db);
  const command = {
    providerId: provider.id,
    name: `Smoke Actor ${suffix}`,
    slug: `actor-${suffix}`,
    description: "Registration smoke",
    category: "test",
    inputSchema: { type: "object" },
    code: "export default async function run(input) { return [input]; }",
  };
  const input = {
    actorUserId: user.id,
    command,
    imageDigest: `sha256:${"a".repeat(64)}`,
    codeSha256: "b".repeat(64),
    payTo: "0x0000000000000000000000000000000000000001",
    registryVerified: false,
    requestId: randomUUID(),
    pending: true,
    idempotencyKey: `smoke-${suffix}`,
    requestFingerprint: "fingerprint",
    publicBaseUrl: "https://facet.example",
  };
  const [first, replay] = await Promise.all([
    store.publishActor(input),
    store.publishActor(input),
  ]);
  assert.equal(first.id, replay.id);
  assert.equal(first.status, "REGISTRATION_PENDING");
  const catalog = new PostgresPublicCatalog(database.db);
  assert.equal(
    (await catalog.list(command.name, 20)).some(
      (facet) => facet.id === first.id,
    ),
    false,
  );
  const outbox = new PostgresActorRegistrationStore(database.pool);
  const job = await outbox.next();
  assert(job);
  assert.equal(job.versionId, first.versionId);
  assert.equal(await outbox.next(), null);
  const signed = { hash: `0x${"c".repeat(64)}`, raw: "0x1234" };
  await outbox.saveSigned(job.versionId, signed);
  await outbox.promote({ ...job, txHash: signed.hash, signedRaw: signed.raw });
  assert.equal(
    (await store.getActorPublishStatus(first.id))?.status,
    "PUBLISHED",
  );
  assert.equal(
    (await catalog.list(command.name, 20)).some(
      (facet) => facet.id === first.id,
    ),
    true,
  );
  process.stdout.write(
    "Actor registration outbox, idempotency and catalog smoke passed.\n",
  );
} finally {
  await database.close();
}
