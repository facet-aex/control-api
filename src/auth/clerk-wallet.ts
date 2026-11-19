import { getAddress } from "viem";

export interface ClerkWeb3WalletLike {
  id?: string | null | undefined;
  web3Wallet?: string | null | undefined;
  web3_wallet?: string | null | undefined;
  verification?: { status?: string | null | undefined } | null | undefined;
}

const EVM_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/u;

/**
 * Extracts a checksummed EVM address from verified Clerk Web3 wallets,
 * preferring the primary wallet when verified and ignoring non-EVM entries.
 */
export function extractVerifiedClerkEvmWallet(input: {
  primaryId?: string | null | undefined;
  wallets?: readonly ClerkWeb3WalletLike[] | null | undefined;
}): string | undefined {
  const verified: Array<{ id?: string | null | undefined; address: string }> =
    [];

  for (const wallet of input.wallets ?? []) {
    if (wallet.verification?.status !== "verified") continue;
    const rawAddress = (wallet.web3Wallet ?? wallet.web3_wallet ?? "").trim();
    if (!EVM_ADDRESS_REGEX.test(rawAddress)) continue;
    verified.push({ id: wallet.id, address: getAddress(rawAddress) });
  }

  if (!verified.length) return undefined;
  if (input.primaryId) {
    const primary = verified.find((wallet) => wallet.id === input.primaryId);
    if (primary) return primary.address;
  }
  return verified[0]?.address;
}
