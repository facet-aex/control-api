import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { avalancheFuji } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import type {
  ActorRegistrationChain,
  ActorRegistrationJob,
  OnChainActorRegistration,
} from "./actor-registration-worker.js";
import { uuidToFacetKey } from "./fuji-registry-verifier.js";

const registryAbi = parseAbi([
  "function owner() view returns (address)",
  "function getFacet(bytes32 facetId) view returns ((uint8 facetType, bytes32 imageDigest, string schemaURI, uint8 pricingModel, uint256 priceAtomic, address payTo, uint256 erc8004TokenId, bool active))",
  "function registerFacet(bytes32 facetId, (uint8 facetType, bytes32 imageDigest, string schemaURI, uint8 pricingModel, uint256 priceAtomic, address payTo, uint256 erc8004TokenId, bool active) registration)",
]);

export class FujiActorRegistrar implements ActorRegistrationChain {
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;
  private readonly registryAddress: Address;

  constructor(rpcUrl: string, registryAddress: string, privateKey: string) {
    if (!/^0x[a-f0-9]{64}$/iu.test(privateKey))
      throw new Error("Invalid registry signer key");
    this.account = privateKeyToAccount(privateKey as Hex);
    this.registryAddress = registryAddress as Address;
    this.publicClient = createPublicClient({
      chain: avalancheFuji,
      transport: http(rpcUrl, { timeout: 15_000 }),
    });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: avalancheFuji,
      transport: http(rpcUrl, { timeout: 15_000 }),
    });
  }

  async assertReady(): Promise<void> {
    if ((await this.publicClient.getChainId()) !== 43113)
      throw new Error("Registry RPC is not Fuji");
    const owner = await this.publicClient.readContract({
      address: this.registryAddress,
      abi: registryAbi,
      functionName: "owner",
    });
    if (owner.toLowerCase() !== this.account.address.toLowerCase())
      throw new Error("Registry signer is not contract owner");
  }

  async readRegistration(
    facetId: string,
  ): Promise<OnChainActorRegistration | null> {
    try {
      const record = await this.publicClient.readContract({
        address: this.registryAddress,
        abi: registryAbi,
        functionName: "getFacet",
        args: [uuidToFacetKey(facetId)],
      });
      return {
        facetType: Number(record.facetType),
        imageDigest: record.imageDigest,
        pricingModel: Number(record.pricingModel),
        priceAtomic: record.priceAtomic.toString(),
        payTo: record.payTo,
        schemaURI: record.schemaURI,
        active: record.active,
      };
    } catch (error) {
      if (
        error instanceof BaseError &&
        error.walk((cause) => cause instanceof ContractFunctionRevertedError)
      )
        return null;
      throw error;
    }
  }

  async prepare(
    job: ActorRegistrationJob,
  ): Promise<{ hash: string; raw: string }> {
    await this.assertReady();
    const data = encodeFunctionData({
      abi: registryAbi,
      functionName: "registerFacet",
      args: [
        uuidToFacetKey(job.facetId),
        {
          facetType: 1,
          imageDigest: job.imageDigest.replace(/^sha256:/u, "0x") as Hex,
          schemaURI: job.schemaURI,
          pricingModel: 0,
          priceAtomic: BigInt(job.priceAtomic),
          payTo: job.payTo as Address,
          erc8004TokenId: 0n,
          active: true,
        },
      ],
    });
    const request = await this.walletClient.prepareTransactionRequest({
      to: this.registryAddress,
      data,
      value: 0n,
    });
    const raw = await this.walletClient.signTransaction(request);
    return { raw, hash: keccak256(raw) };
  }

  async broadcast(raw: string): Promise<void> {
    await this.publicClient.sendRawTransaction({
      serializedTransaction: raw as Hex,
    });
  }

  async transactionStatus(
    hash: string,
  ): Promise<"confirmed" | "reverted" | "unknown"> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: hash as Hex,
      });
      return receipt.status === "success" ? "confirmed" : "reverted";
    } catch (error) {
      if (
        error instanceof BaseError &&
        /not found|could not be found/iu.test(error.shortMessage)
      )
        return "unknown";
      throw error;
    }
  }
}
