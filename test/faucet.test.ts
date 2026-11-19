import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { FujiFusdMinter } from "../src/faucet/faucet-minter.js";
import { FaucetService } from "../src/faucet/faucet-service.js";
import type {
  FaucetClaimInput,
  FaucetClaimRecord,
  FaucetMinter,
  FaucetStore,
} from "../src/faucet/faucet-types.js";

const VALID_ADDRESS = "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf";
const SECOND_ADDRESS = "0x1111111111111111111111111111111111111111";
const THIRD_ADDRESS = "0x2222222222222222222222222222222222222222";
const TEST_MINTER_KEY = `0x${"1".repeat(64)}` as `0x${string}`;
const TX_HASH_1 = `0x${"a".repeat(64)}` as `0x${string}`;
const TX_HASH_2 = `0x${"b".repeat(64)}` as `0x${string}`;

class InMemoryFaucetStore implements FaucetStore {
  readonly records: FaucetClaimRecord[] = [];
  lockCalls = 0;

  async withMintLock<T>(fn: (tx: FaucetStore) => Promise<T>): Promise<T> {
    this.lockCalls += 1;
    return fn(this);
  }

  async findLatestClaimByRecipient(
    recipientAddress: string,
  ): Promise<FaucetClaimRecord | null> {
    const normalized = recipientAddress.toLowerCase();
    const matches = this.records
      .filter((row) => row.recipientAddress === normalized)
      .sort((a, b) => b.claimedAt.getTime() - a.claimedAt.getTime());
    return matches[0] ?? null;
  }

  async listRecentClaimsByIpHash(
    ipHash: string,
    since: Date,
  ): Promise<FaucetClaimRecord[]> {
    return this.records
      .filter(
        (row) =>
          row.ipHash === ipHash && row.claimedAt.getTime() >= since.getTime(),
      )
      .sort((a, b) => a.claimedAt.getTime() - b.claimedAt.getTime());
  }

  async recordClaim(input: FaucetClaimInput): Promise<FaucetClaimRecord> {
    const row: FaucetClaimRecord = {
      id: `claim-${this.records.length + 1}`,
      recipientAddress: input.recipientAddress.toLowerCase(),
      ipHash: input.ipHash,
      amountAtomic: input.amountAtomic,
      txHash: input.txHash,
      claimedAt: input.claimedAt,
    };
    this.records.push(row);
    return row;
  }
}

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("control-api fUSD faucet", () => {
  it("boots cleanly with default faucet settings when minter private key is unset", () => {
    const config = readConfig({
      FACET_ENV: "production",
      FACET_AUTH_MODE: "clerk",
      CLERK_SECRET_KEY: "test-key",
      DATABASE_URL: "postgresql://user:password@localhost:5432/facet",
      FACET_IMPORTER_URL: "http://openapi-importer:4010",
      FACET_IMPORTER_ALLOW_PRIVATE_HTTP: "1",
      FACET_EXECUTOR_TOKEN: "a".repeat(32),
      FACET_EXECUTOR_URL: "http://executor:4030",
      FACET_FUSD_MINTER_PRIVATE_KEY: "",
    });

    expect(config.FACET_FUSD_MINTER_PRIVATE_KEY).toBeUndefined();
    expect(config.FACET_FAUCET_DRIP_ATOMIC).toBe("1000000");
    expect(config.FACET_FAUCET_ADDRESS_COOLDOWN_SEC).toBe(86400);
    expect(config.FACET_FAUCET_IP_DAILY_LIMIT).toBe(10);
  });

  it("mints 1000000 atomic fUSD on valid 0x claim and records normalized claim", async () => {
    const store = new InMemoryFaucetStore();
    const now = new Date("2026-11-20T00:00:00.000Z");
    const minterCalls: Array<{ to: string; amountAtomic: bigint }> = [];
    const minter: FaucetMinter = {
      async mint(to, amountAtomic) {
        minterCalls.push({ to, amountAtomic });
        return {
          txHash: TX_HASH_1,
          balanceAtomic: "2500000",
        };
      },
    };
    const service = new FaucetService(store, minter, {
      dripAtomic: "1000000",
      addressCooldownSec: 86_400,
      ipDailyLimit: 10,
      ipHashSalt: "test-salt",
      now: () => now,
    });

    const app = await buildApp({
      checkDatabase: async () => undefined,
      environment: "local",
      webOrigin: "http://localhost:3000",
      faucetRoutes: { service },
    });
    apps.push(app);

    const status = await app.inject({
      method: "GET",
      url: "/v1/faucet/status",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      enabled: true,
      dripAtomic: "1000000",
      addressCooldownSec: 86_400,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/faucet/claim",
      headers: { "x-forwarded-for": "203.0.113.9" },
      payload: { address: VALID_ADDRESS.toLowerCase() },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      address: VALID_ADDRESS,
      amountAtomic: "1000000",
      balanceAtomic: "2500000",
      txHash: TX_HASH_1,
      explorerUrl: `https://testnet.snowtrace.io/tx/${TX_HASH_1}`,
      nextClaimAt: "2026-11-21T00:00:00.000Z",
    });
    expect(minterCalls).toEqual([
      { to: VALID_ADDRESS, amountAtomic: 1_000_000n },
    ]);
    expect(store.lockCalls).toBe(1);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]?.recipientAddress).toBe(
      VALID_ADDRESS.toLowerCase(),
    );
    expect(store.records[0]?.ipHash).not.toContain("203.0.113.9");
  });

  it("enforces case-insensitive per-address cooldown with 429 FAUCET_COOLDOWN", async () => {
    const store = new InMemoryFaucetStore();
    const minter: FaucetMinter = {
      async mint() {
        return { txHash: TX_HASH_1, balanceAtomic: "1000000" };
      },
    };
    const service = new FaucetService(store, minter, {
      dripAtomic: "1000000",
      addressCooldownSec: 3600,
      ipDailyLimit: 10,
      ipHashSalt: "test-salt",
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    const app = await buildApp({
      checkDatabase: async () => undefined,
      environment: "local",
      webOrigin: "http://localhost:3000",
      faucetRoutes: { service },
    });
    apps.push(app);

    const first = await app.inject({
      method: "POST",
      url: "/v1/faucet/claim",
      payload: { address: VALID_ADDRESS.toLowerCase() },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/v1/faucet/claim",
      payload: { address: VALID_ADDRESS },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({
      error: {
        code: "FAUCET_COOLDOWN",
        details: {
          nextClaimAt: "2026-11-20T01:00:00.000Z",
        },
      },
    });
    expect(store.records).toHaveLength(1);
  });

  it("enforces daily per-IP limit with 429 FAUCET_IP_LIMIT", async () => {
    const store = new InMemoryFaucetStore();
    const minter: FaucetMinter = {
      async mint() {
        return { txHash: TX_HASH_1, balanceAtomic: "1000000" };
      },
    };
    const service = new FaucetService(store, minter, {
      dripAtomic: "1000000",
      addressCooldownSec: 60,
      ipDailyLimit: 2,
      ipHashSalt: "test-salt",
      now: () => new Date("2026-11-20T00:00:00.000Z"),
    });
    const app = await buildApp({
      checkDatabase: async () => undefined,
      environment: "local",
      webOrigin: "http://localhost:3000",
      faucetRoutes: { service },
    });
    apps.push(app);

    const r1 = await app.inject({
      method: "POST",
      url: "/v1/faucet/claim",
      headers: { "x-forwarded-for": "198.51.100.7" },
      payload: { address: VALID_ADDRESS },
    });
    expect(r1.statusCode).toBe(200);

    const r2 = await app.inject({
      method: "POST",
      url: "/v1/faucet/claim",
      headers: { "x-forwarded-for": "198.51.100.7" },
      payload: { address: SECOND_ADDRESS },
    });
    expect(r2.statusCode).toBe(200);

    const r3 = await app.inject({
      method: "POST",
      url: "/v1/faucet/claim",
      headers: { "x-forwarded-for": "198.51.100.7" },
      payload: { address: THIRD_ADDRESS },
    });
    expect(r3.statusCode).toBe(429);
    expect(r3.json()).toMatchObject({
      error: {
        code: "FAUCET_IP_LIMIT",
        details: {
          nextClaimAt: "2026-11-21T00:00:00.000Z",
        },
      },
    });
  });

  it("rejects invalid addresses with 400 VALIDATION_FAILED", async () => {
    const store = new InMemoryFaucetStore();
    const minter: FaucetMinter = {
      async mint() {
        throw new Error("should not mint");
      },
    };
    const service = new FaucetService(store, minter, {
      dripAtomic: "1000000",
      addressCooldownSec: 86_400,
      ipDailyLimit: 10,
      ipHashSalt: "test-salt",
    });
    const app = await buildApp({
      checkDatabase: async () => undefined,
      environment: "local",
      webOrigin: "http://localhost:3000",
      faucetRoutes: { service },
    });
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/v1/faucet/claim",
      payload: { address: "not-an-evm-address" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
  });

  it("returns 503 FAUCET_NOT_CONFIGURED and enabled: false when minter key is missing", async () => {
    const store = new InMemoryFaucetStore();
    const service = new FaucetService(store, undefined, {
      dripAtomic: "1000000",
      addressCooldownSec: 86_400,
      ipDailyLimit: 10,
      ipHashSalt: "test-salt",
    });
    const app = await buildApp({
      checkDatabase: async () => undefined,
      environment: "local",
      webOrigin: "http://localhost:3000",
      faucetRoutes: { service },
    });
    apps.push(app);

    const status = await app.inject({
      method: "GET",
      url: "/v1/faucet/status",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({
      enabled: false,
      dripAtomic: "1000000",
      addressCooldownSec: 86_400,
    });

    const claim = await app.inject({
      method: "POST",
      url: "/v1/faucet/claim",
      payload: { address: VALID_ADDRESS },
    });
    expect(claim.statusCode).toBe(503);
    expect(claim.json()).toMatchObject({
      error: { code: "FAUCET_NOT_CONFIGURED" },
    });
  });

  it("retries once on nonce conflict in FujiFusdMinter and never records failed mints", async () => {
    const noncesSeen: number[] = [];
    let attempt = 0;
    const minter = new FujiFusdMinter(
      "https://api.avax-test.network/ext/bc/C/rpc",
      "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f",
      TEST_MINTER_KEY,
      {
        async getPendingNonce() {
          return attempt === 0 ? 7 : 8;
        },
        async sendMint({ nonce }) {
          noncesSeen.push(nonce);
          attempt += 1;
          if (attempt === 1) {
            throw new Error("nonce too low for tx");
          }
          return TX_HASH_2;
        },
        async waitForReceipt() {
          return { status: "success" as const };
        },
        async readBalance() {
          return 1_000_000n;
        },
      },
    );

    const result = await minter.mint(VALID_ADDRESS, 1_000_000n);
    expect(result).toEqual({
      txHash: TX_HASH_2,
      balanceAtomic: "1000000",
    });
    expect(noncesSeen).toEqual([7, 8]);

    const store = new InMemoryFaucetStore();
    const failingMinter: FaucetMinter = {
      async mint() {
        throw new Error("rpc timeout");
      },
    };
    const service = new FaucetService(store, failingMinter, {
      dripAtomic: "1000000",
      addressCooldownSec: 86_400,
      ipDailyLimit: 10,
      ipHashSalt: "test-salt",
    });
    await expect(
      service.claim(VALID_ADDRESS, "203.0.113.10"),
    ).rejects.toThrow();
    expect(store.records).toHaveLength(0);
  });
});
