import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getAddress, isAddress } from "viem";

import { AppError } from "../errors.js";
import type {
  FaucetClaimInput,
  FaucetClaimRecord,
  FaucetClaimResponse,
  FaucetMinter,
  FaucetStatus,
  FaucetStore,
} from "./faucet-types.js";

const DAY_MS = 86_400 * 1000;
const SNOWTRACE_TX_PREFIX = "https://testnet.snowtrace.io/tx/";

export interface FaucetServiceOptions {
  dripAtomic: string;
  addressCooldownSec: number;
  ipDailyLimit: number;
  ipHashSalt: string;
  now?: () => Date;
}

interface ClaimRow {
  id: string;
  recipient_address: string;
  ip_hash: string;
  amount_atomic: string;
  tx_hash: string;
  claimed_at: Date;
}

function toRecord(row: ClaimRow): FaucetClaimRecord {
  return {
    id: row.id,
    recipientAddress: row.recipient_address,
    ipHash: row.ip_hash,
    amountAtomic: row.amount_atomic,
    txHash: row.tx_hash,
    claimedAt:
      row.claimed_at instanceof Date
        ? row.claimed_at
        : new Date(row.claimed_at),
  };
}

class PgTxFaucetStore implements FaucetStore {
  constructor(private readonly client: PoolClient) {}

  async withMintLock<T>(fn: (tx: FaucetStore) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async findLatestClaimByRecipient(
    recipientAddress: string,
  ): Promise<FaucetClaimRecord | null> {
    const result = await this.client.query<ClaimRow>(
      `select id, recipient_address, ip_hash, amount_atomic, tx_hash, claimed_at
         from faucet_claims
        where recipient_address = $1
        order by claimed_at desc
        limit 1`,
      [recipientAddress.toLowerCase()],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async listRecentClaimsByIpHash(
    ipHash: string,
    since: Date,
  ): Promise<FaucetClaimRecord[]> {
    const result = await this.client.query<ClaimRow>(
      `select id, recipient_address, ip_hash, amount_atomic, tx_hash, claimed_at
         from faucet_claims
        where ip_hash = $1
          and claimed_at >= $2
        order by claimed_at asc`,
      [ipHash, since],
    );
    return result.rows.map(toRecord);
  }

  async recordClaim(input: FaucetClaimInput): Promise<FaucetClaimRecord> {
    const result = await this.client.query<ClaimRow>(
      `insert into faucet_claims (
         recipient_address, ip_hash, amount_atomic, tx_hash, claimed_at
       ) values ($1, $2, $3, $4, $5)
       returning id, recipient_address, ip_hash, amount_atomic, tx_hash, claimed_at`,
      [
        input.recipientAddress.toLowerCase(),
        input.ipHash,
        input.amountAtomic,
        input.txHash,
        input.claimedAt,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to insert faucet claim");
    }
    return toRecord(row);
  }
}

export class PostgresFaucetStore implements FaucetStore {
  constructor(private readonly pool: Pool) {}

  async withMintLock<T>(fn: (tx: FaucetStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "select pg_advisory_xact_lock(hashtext('facet-faucet-mint'))",
      );
      const txStore = new PgTxFaucetStore(client);
      const result = await fn(txStore);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findLatestClaimByRecipient(
    recipientAddress: string,
  ): Promise<FaucetClaimRecord | null> {
    const result = await this.pool.query<ClaimRow>(
      `select id, recipient_address, ip_hash, amount_atomic, tx_hash, claimed_at
         from faucet_claims
        where recipient_address = $1
        order by claimed_at desc
        limit 1`,
      [recipientAddress.toLowerCase()],
    );
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async listRecentClaimsByIpHash(
    ipHash: string,
    since: Date,
  ): Promise<FaucetClaimRecord[]> {
    const result = await this.pool.query<ClaimRow>(
      `select id, recipient_address, ip_hash, amount_atomic, tx_hash, claimed_at
         from faucet_claims
        where ip_hash = $1
          and claimed_at >= $2
        order by claimed_at asc`,
      [ipHash, since],
    );
    return result.rows.map(toRecord);
  }

  async recordClaim(input: FaucetClaimInput): Promise<FaucetClaimRecord> {
    const result = await this.pool.query<ClaimRow>(
      `insert into faucet_claims (
         recipient_address, ip_hash, amount_atomic, tx_hash, claimed_at
       ) values ($1, $2, $3, $4, $5)
       returning id, recipient_address, ip_hash, amount_atomic, tx_hash, claimed_at`,
      [
        input.recipientAddress.toLowerCase(),
        input.ipHash,
        input.amountAtomic,
        input.txHash,
        input.claimedAt,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("Failed to insert faucet claim");
    }
    return toRecord(row);
  }
}

export class FaucetService {
  private readonly now: () => Date;

  constructor(
    private readonly store: FaucetStore,
    private readonly minter: FaucetMinter | undefined,
    private readonly options: FaucetServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  getStatus(): FaucetStatus {
    return {
      enabled: Boolean(this.minter),
      dripAtomic: this.options.dripAtomic,
      addressCooldownSec: this.options.addressCooldownSec,
    };
  }

  async claim(
    rawAddress: string,
    clientIp: string,
  ): Promise<FaucetClaimResponse> {
    const trimmed = rawAddress.trim();
    if (!/^0x[a-fA-F0-9]{40}$/u.test(trimmed) || !isAddress(trimmed)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Enter a valid Avalanche 0x wallet address.",
        400,
      );
    }
    if (!this.minter) {
      throw new AppError(
        "FAUCET_NOT_CONFIGURED",
        "Testnet fUSD faucet is not configured on this server.",
        503,
      );
    }

    const checksumAddress = getAddress(trimmed);
    const normalizedRecipient = checksumAddress.toLowerCase();
    const ipHash = createHash("sha256")
      .update(`${this.options.ipHashSalt}:${clientIp}`)
      .digest("hex");
    const minter = this.minter;

    return this.store.withMintLock(async (tx) => {
      const now = this.now();
      const cooldownMs = this.options.addressCooldownSec * 1000;

      const latest = await tx.findLatestClaimByRecipient(normalizedRecipient);
      if (latest) {
        const unlockAtMs = latest.claimedAt.getTime() + cooldownMs;
        if (unlockAtMs > now.getTime()) {
          throw new AppError(
            "FAUCET_COOLDOWN",
            "This wallet has already claimed test fUSD recently. Please wait for the cooldown to finish.",
            429,
            { nextClaimAt: new Date(unlockAtMs).toISOString() },
          );
        }
      }

      const dayStart = new Date(now.getTime() - DAY_MS);
      const recentIpClaims = await tx.listRecentClaimsByIpHash(
        ipHash,
        dayStart,
      );
      if (recentIpClaims.length >= this.options.ipDailyLimit) {
        const oldest = recentIpClaims[0]!;
        const resetAtMs = oldest.claimedAt.getTime() + DAY_MS;
        throw new AppError(
          "FAUCET_IP_LIMIT",
          "Daily faucet claim limit reached for this network address.",
          429,
          { nextClaimAt: new Date(resetAtMs).toISOString() },
        );
      }

      const minted = await minter.mint(
        checksumAddress,
        BigInt(this.options.dripAtomic),
      );

      await tx.recordClaim({
        recipientAddress: normalizedRecipient,
        ipHash,
        amountAtomic: this.options.dripAtomic,
        txHash: minted.txHash,
        claimedAt: now,
      });

      return {
        address: checksumAddress,
        amountAtomic: this.options.dripAtomic,
        balanceAtomic: minted.balanceAtomic,
        txHash: minted.txHash,
        explorerUrl: `${SNOWTRACE_TX_PREFIX}${minted.txHash}`,
        nextClaimAt: new Date(now.getTime() + cooldownMs).toISOString(),
      };
    });
  }
}
