export interface FaucetStatus {
  enabled: boolean;
  dripAtomic: string;
  addressCooldownSec: number;
}

export interface FaucetClaimRequest {
  address: string;
}

export interface FaucetClaimResponse {
  address: string;
  amountAtomic: string;
  balanceAtomic: string;
  txHash: string;
  explorerUrl: string;
  nextClaimAt: string;
}

export interface FaucetDispenseResult {
  txHash: string;
  balanceAtomic: string;
}

export interface FaucetDispenser {
  dispense(
    recipientAddress: string,
    amountAtomic: bigint,
  ): Promise<FaucetDispenseResult>;
}

export interface FaucetClaimRecord {
  id: string;
  recipientAddress: string;
  ipHash: string;
  amountAtomic: string;
  txHash: string;
  claimedAt: Date;
}

export interface FaucetClaimInput {
  recipientAddress: string;
  ipHash: string;
  amountAtomic: string;
  txHash: string;
  claimedAt: Date;
}

export interface FaucetStore {
  withMintLock<T>(fn: (tx: FaucetStore) => Promise<T>): Promise<T>;
  findLatestClaimByRecipient(
    recipientAddress: string,
  ): Promise<FaucetClaimRecord | null>;
  listRecentClaimsByIpHash(
    ipHash: string,
    since: Date,
  ): Promise<FaucetClaimRecord[]>;
  recordClaim(input: FaucetClaimInput): Promise<FaucetClaimRecord>;
}
