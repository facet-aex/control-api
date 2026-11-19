import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";

import { AppError } from "../errors.js";
import type { FaucetMintResult, FaucetMinter } from "./faucet-types.js";

const FUSD_ABI = parseAbi([
  "function mint(address to, uint256 amount) external",
  "function balanceOf(address account) view returns (uint256)",
]);

const NONCE_RETRY_PATTERN =
  /nonce too low|replacement transaction underpriced|already known/iu;

export interface FaucetRpcAdapter {
  getPendingNonce(): Promise<number>;
  sendMint(params: {
    recipient: Address;
    amountAtomic: bigint;
    nonce: number;
  }): Promise<Hex>;
  waitForReceipt(txHash: Hex): Promise<{ status: "success" | "reverted" }>;
  readBalance(recipient: Address): Promise<bigint>;
}

export class FujiFusdMinter implements FaucetMinter {
  private readonly rpc: FaucetRpcAdapter;

  constructor(
    rpcUrl: string,
    fusdAddress: string,
    privateKey: string,
    adapter?: FaucetRpcAdapter,
  ) {
    if (!/^0x[a-f0-9]{40}$/iu.test(fusdAddress)) {
      throw new Error("Invalid FACET_USD_ADDRESS");
    }
    if (!/^0x[a-f0-9]{64}$/iu.test(privateKey)) {
      throw new Error("Invalid FACET_FUSD_MINTER_PRIVATE_KEY");
    }

    if (adapter) {
      this.rpc = adapter;
      return;
    }

    const account = privateKeyToAccount(privateKey as Hex);
    const tokenAddress = fusdAddress as Address;
    const publicClient = createPublicClient({
      chain: avalancheFuji,
      transport: http(rpcUrl, { timeout: 20_000 }),
    });
    const walletClient = createWalletClient({
      account,
      chain: avalancheFuji,
      transport: http(rpcUrl, { timeout: 20_000 }),
    });

    this.rpc = {
      getPendingNonce: async () =>
        publicClient.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        }),
      sendMint: async ({ recipient, amountAtomic, nonce }) =>
        walletClient.writeContract({
          address: tokenAddress,
          abi: FUSD_ABI,
          functionName: "mint",
          args: [recipient, amountAtomic],
          nonce,
          account,
        }),
      waitForReceipt: async (txHash) => {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          timeout: 60_000,
        });
        return {
          status: receipt.status === "success" ? "success" : "reverted",
        };
      },
      readBalance: async (recipient) =>
        publicClient.readContract({
          address: tokenAddress,
          abi: FUSD_ABI,
          functionName: "balanceOf",
          args: [recipient],
        }),
    };
  }

  async mint(
    recipientAddress: string,
    amountAtomic: bigint,
  ): Promise<FaucetMintResult> {
    const recipient = recipientAddress as Address;

    let txHash: Hex | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const nonce = await this.rpc.getPendingNonce();
      try {
        txHash = await this.rpc.sendMint({ recipient, amountAtomic, nonce });
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 0 && NONCE_RETRY_PATTERN.test(message)) {
          continue;
        }
        throw new AppError(
          "FAUCET_MINT_FAILED",
          "Unable to submit test fUSD mint transaction.",
          502,
        );
      }
    }

    if (!txHash) {
      throw new AppError(
        "FAUCET_MINT_FAILED",
        lastError instanceof Error
          ? "Unable to submit test fUSD mint transaction."
          : "Faucet mint failed.",
        502,
      );
    }

    const receipt = await this.rpc.waitForReceipt(txHash);
    if (receipt.status !== "success") {
      throw new AppError(
        "FAUCET_MINT_FAILED",
        "Faucet mint transaction reverted on Avalanche.",
        502,
      );
    }

    const balanceAtomic = await this.rpc.readBalance(recipient);
    return {
      txHash,
      balanceAtomic: balanceAtomic.toString(),
    };
  }
}
