import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getAddress, recoverMessageAddress, type Hex } from "viem";

import { AppError } from "../errors.js";
import type { WalletLinkChallenge } from "./provider-types.js";

export function newWalletLinkChallenge(input: {
  userId: string;
  provider: string;
  domain: string;
  now: Date;
}): Omit<WalletLinkChallenge, "consumedAt"> {
  const nonce = randomBytes(32).toString("hex");
  const expiresAt = new Date(input.now.getTime() + 300_000);
  const message = [
    "FACET payout wallet link",
    `Domain: ${input.domain}`,
    "Chain ID: 43113",
    `Provider: ${input.provider}`,
    `Nonce: ${nonce}`,
    `Expires At: ${expiresAt.toISOString()}`,
  ].join("\n");
  return {
    id: randomUUID(),
    userId: input.userId,
    message,
    nonceHash: createHash("sha256").update(nonce).digest("hex"),
    expiresAt,
  };
}

export async function verifyWalletLinkSignature(input: {
  message: string;
  address: string;
  signature: Hex;
}): Promise<string> {
  try {
    const expected = getAddress(input.address);
    const recovered = await recoverMessageAddress({
      message: input.message,
      signature: input.signature,
    });
    if (recovered !== expected) throw new Error("Signer mismatch");
    return expected;
  } catch {
    throw new AppError(
      "WALLET_SIGNATURE_INVALID",
      "The wallet signature does not match the challenge.",
      403,
    );
  }
}
