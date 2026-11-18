import { expect, test } from "vitest";

import {
  ActorRegistrationWorker,
  type ActorRegistrationJob,
} from "../src/facets/actor-registration-worker.js";

const job: ActorRegistrationJob = {
  facetId: "00000000-0000-4000-8000-000000000001",
  versionId: "00000000-0000-4000-8000-000000000002",
  imageDigest: `sha256:${"a".repeat(64)}`,
  priceAtomic: "1000",
  payTo: "0x0000000000000000000000000000000000000001",
  schemaURI:
    "https://facet.example/v1/catalog/facets/00000000-0000-4000-8000-000000000001",
  signedRaw: null,
  txHash: null,
};

test("persists the signed transaction before broadcast and retries the same bytes", async () => {
  const events: string[] = [];
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
      readRegistration: async () => null,
      prepare: async () => {
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
    readRegistration: async () => observed,
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
