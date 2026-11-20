import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { createDatabase } from "../src/db/client.js";
import { facetVersions, facets, users } from "../src/db/schema.js";
import { PostgresDemoPayerAllowance } from "../src/facets/demo-payer-authorization.js";
import { hashFacetManifest } from "../src/facets/facet-manifest.js";
import { PostgresActorAgentStore } from "../src/facets/postgres-actor-agent-store.js";
import { PostgresActorRegistrationStore } from "../src/facets/postgres-actor-registration-store.js";
import { PostgresPublicCatalog } from "../src/facets/public-catalog.js";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const database = createDatabase(process.env.DATABASE_URL);
try {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 6);
  const username = `smoke-${suffix}`;
  const [user] = await database.db
    .insert(users)
    .values({
      clerkId: `user_smoke_${suffix}`,
      username,
    })
    .returning();
  assert(user);

  const store = new PostgresActorAgentStore(database.db);
  const facetName = `actor-${suffix}`;
  const facetDisplayName = `Smoke Actor ${suffix}`;
  const version = "1.0.0";
  const command = {
    facetName,
    facetDisplayName,
    version,
    description: "Registration smoke",
    category: "test",
    inputSchema: { type: "object" },
    code: "export default async function run(input) { return [input]; }",
  };
  const manifest = {
    schemaVersion: "facet.manifest/v1",
    providerId: user.id,
    provider: username,
    facetName,
    facetDisplayName,
    version,
    type: "ACTOR",
    summary: "Registration smoke",
    description: "Registration smoke",
    category: "test",
    tags: [],
    visibility: "PRIVATE",
    operation: {
      operationId: "run",
      method: "POST",
      publicPathTemplate: `/v1/facets/${username}/${facetName}/versions/${version}/invoke`,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      errorSchema: { type: "object" },
      sideEffectClass: "READ_ONLY",
    },
    executionPolicy: {
      timeoutMs: 15_000,
      maxResponseBytes: 1_048_576,
      redirectPolicy: "DENY",
    },
    upstreamAuth: { kind: "NONE", configured: true },
    actorConfig: {
      runtime: "node-22-esm",
      entrypoint: "run",
      imageDigest: `sha256:${"a".repeat(64)}`,
    },
    provenance: {
      sourceType: "ACTOR_TEMPLATE",
      sourceOperationPointer: "#/run",
    },
  };
  const input = {
    actorUserId: user.id,
    providerUsername: username,
    command,
    manifest,
    contentHash: hashFacetManifest(manifest),
    imageDigest: `sha256:${"a".repeat(64)}`,
    payTo: "0x0000000000000000000000000000000000000001",
    registryVerified: false,
    requestId: randomUUID(),
    pending: true,
    idempotencyKey: `smoke-${suffix}`,
    requestFingerprint: "fingerprint",
    schemaUri: `https://facet.example/v1/catalog/facets/${username}/${facetName}/versions/${version}`,
  };
  const [first, replay] = await Promise.all([
    store.publishActor(input),
    store.publishActor(input),
  ]);
  assert.equal(first.facetName, replay.facetName);
  assert.equal(first.version, replay.version);
  assert.equal(first.status, "REGISTRATION_PENDING");
  assert.equal(
    (await store.listMyActors(user.id))[0]?.status,
    "REGISTRATION_PENDING",
  );

  const dbRow = (
    await database.db
      .select({ versionId: facetVersions.id })
      .from(facetVersions)
      .innerJoin(facets, eq(facets.id, facetVersions.facetId))
      .where(
        and(
          eq(facets.providerId, user.id),
          eq(facets.facetName, facetName),
          eq(facetVersions.version, version),
        ),
      )
      .limit(1)
  )[0];
  assert(dbRow);

  const catalog = new PostgresPublicCatalog(database.db);
  assert.equal(
    (await catalog.list(facetDisplayName, 20)).some(
      (facet) => facet.provider === username && facet.facetName === facetName,
    ),
    false,
  );
  const outbox = new PostgresActorRegistrationStore(database.pool);
  const job = await outbox.next();
  assert(job);
  assert.equal(job.versionId, dbRow.versionId);
  assert.equal(job.facetType, "ACTOR");
  assert.equal(job.digest, input.imageDigest);
  assert.equal(job.pricingModel, "PAY_PER_RUN");
  assert.equal(await outbox.next(), null);
  const signed = { hash: `0x${"c".repeat(64)}`, raw: "0x1234" };
  await outbox.saveSigned(job.versionId, signed);
  await outbox.promote({ ...job, txHash: signed.hash, signedRaw: signed.raw });
  assert.equal(
    (await store.getActorPublishStatus(username, facetName, version))?.status,
    "PUBLISHED",
  );
  assert.equal(
    (await catalog.list(facetDisplayName, 20)).some(
      (facet) => facet.provider === username && facet.facetName === facetName,
    ),
    true,
  );
  const catalogFacet = await catalog.getByName(username, facetName);
  assert.equal(catalogFacet?.facetName, facetName);
  assert.equal(catalogFacet?.pricing.model, "PAY_PER_RUN");
  assert.equal(catalogFacet?.pricing.maxAmountAtomic, "1000");
  assert.equal(catalogFacet?.pricing.isPrimary, true);
  assert.equal(catalogFacet?.pricingOptions.length, 1);
  assert.equal((await store.listMyActors(user.id))[0]?.status, "PUBLISHED");
  assert.equal(
    (await store.listMyFacets(user.id))[0]?.pricingOptions?.length,
    1,
  );
  const allowance = new PostgresDemoPayerAllowance(database.pool);
  const now = new Date("2026-11-18T00:00:00.000Z");
  const target = { provider: username, facetName, version };
  const attempts = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) =>
      allowance.authorize(user.id, target, `buy-${index}`, now),
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
  const paidReplay = await allowance.authorize(user.id, target, "buy-0", now);
  assert.equal(paidReplay.amountAtomic, "1000");
  assert.equal(paidReplay.remainingToday, 0);
  process.stdout.write(
    "Actor registration, catalog and bounded demo payer smoke passed.\n",
  );
} finally {
  await database.close();
}
