import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createDatabase } from "../src/db/client.js";
import { providers, users } from "../src/db/schema.js";
import { PostgresActorAgentStore } from "../src/facets/postgres-actor-agent-store.js";
import { PostgresActorRegistrationStore } from "../src/facets/postgres-actor-registration-store.js";
import { PostgresDemoPayerAllowance } from "../src/facets/demo-payer-authorization.js";
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
  const allowance = new PostgresDemoPayerAllowance(database.pool);
  const now = new Date("2026-11-18T00:00:00.000Z");
  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) =>
      allowance.authorize(user.id, first.versionId, `buy-${index}`, now),
    ),
  );
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    3,
  );
  assert.equal(
    attempts.filter((result) => result.status === "rejected").length,
    2,
  );
  const paidReplay = await allowance.authorize(
    user.id,
    first.versionId,
    "buy-0",
    now,
  );
  assert.equal(paidReplay.amountAtomic, "1000");
  assert.equal(paidReplay.remainingToday, 0);
  process.stdout.write(
    "Actor registration, catalog and bounded demo payer smoke passed.\n",
  );
} finally {
  await database.close();
}
