import { expect, test } from "vitest";

import {
  ActorRegistrationWorker,
  type ActorRegistrationJob,
} from "../src/facets/actor-registration-worker.js";
import { uuidToFacetKey } from "../src/facets/fuji-registry-verifier.js";

const job: ActorRegistrationJob = {
  facetId: "00000000-0000-4000-8000-000000000001",
  versionId: "00000000-0000-4000-8000-000000000002",
  facetType: "ACTOR",
  digest: `sha256:${"a".repeat(64)}`,
  pricingModel: "PAY_PER_RUN",
  priceAtomic: "1000",
  payTo: "0x0000000000000000000000000000000000000001",
  schemaURI:
    "https://facet.example/v1/catalog/facets/alice-labs/weather-actor/versions/1.0.0",
  signedRaw: null,
  txHash: null,
};

test("uses versionId as the on-chain FacetActorRegistry key and persists signed tx for retries", async () => {
  const events: string[] = [];
  const readKeys: string[] = [];
  const current = { ...job };
  let prepareCount = 0;
  let broadcastCount = 0;
  const worker = new ActorRegistrationWorker(
    {
      next: async () => current,
      saveSigned: async (_versionId, signed) => {
        events.push("saved");
        current.signedRaw = signed.raw;
        current.txHash = signed.hash;
      },
      promote: async () => {
        events.push("promoted");
      },
      fail: async () => {
        events.push("failed");
      },
    },
    {
      readRegistration: async (registryKeyId) => {
        readKeys.push(registryKeyId);
        return null;
      },
      prepare: async (preparedJob) => {
        expect(preparedJob.versionId).toBe(job.versionId);
        prepareCount += 1;
        return { hash: `0x${"b".repeat(64)}`, raw: "0x1234" };
      },
      broadcast: async () => {
        broadcastCount += 1;
        events.push("broadcast");
        throw new Error("RPC timeout after send");
      },
      transactionStatus: async () => "unknown",
    },
  );

  expect(await worker.runOnce()).toBe("pending");
  expect(await worker.runOnce()).toBe("pending");
  expect(prepareCount).toBe(1);
  expect(broadcastCount).toBe(2);
  expect(events).toEqual(["saved", "broadcast", "broadcast"]);
  expect(readKeys).toEqual([job.versionId, job.versionId]);
  expect(uuidToFacetKey(job.versionId)).not.toBe(uuidToFacetKey(job.facetId));
});

test("promotes only a confirmed registration matching the immutable version", async () => {
  const events: string[] = [];
  const signed = { ...job, signedRaw: "0x1234", txHash: `0x${"b".repeat(64)}` };
  let observed = {
    facetType: 1,
    imageDigest: `0x${"a".repeat(64)}`,
    pricingModel: 0,
    priceAtomic: job.priceAtomic,
    payTo: job.payTo,
    schemaURI: job.schemaURI,
    active: true,
  };
  const store = {
    next: async () => signed,
    saveSigned: async () => {
      throw new Error("must not sign twice");
    },
    promote: async () => {
      events.push("promoted");
    },
    fail: async () => {
      events.push("failed");
    },
  };
  const worker = new ActorRegistrationWorker(store, {
    readRegistration: async (registryKeyId) => {
      expect(registryKeyId).toBe(job.versionId);
      return observed;
    },
    prepare: async () => {
      throw new Error("must not prepare twice");
    },
    broadcast: async () => {
      throw new Error("must not broadcast after confirmation");
    },
    transactionStatus: async () => "confirmed",
  });
  expect(await worker.runOnce()).toBe("published");
  expect(events).toEqual(["promoted"]);

  events.length = 0;
  observed = {
    ...observed,
    payTo: "0x0000000000000000000000000000000000000002",
  };
  expect(await worker.runOnce()).toBe("failed");
  expect(events).toEqual(["failed"]);
});
