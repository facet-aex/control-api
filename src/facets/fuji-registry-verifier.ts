import {
  createPublicClient,
  decodeEventLog,
  http,
  keccak256,
  parseAbi,
  toBytes,
  zeroHash,
  type Address,
  type Hex,
} from "viem";

const FUJI_CHAIN_ID = 43113;

const FACET_ACTOR_REGISTRY_ABI = parseAbi([
  "event FacetRegistered(bytes32 indexed facetId, uint8 facetType, bytes32 imageDigest, uint8 pricingModel, uint256 priceAtomic, address indexed payTo, uint256 erc8004TokenId)",
  "function getFacet(bytes32 facetId) external view returns ((uint8 facetType, bytes32 imageDigest, string schemaURI, uint8 pricingModel, uint256 priceAtomic, address payTo, uint256 erc8004TokenId, bool active))",
]);

export interface ExpectedFacetRegistration {
  facetId: string;
  facetType: "EXTERNAL_HTTP_API" | "HOSTED_ACTOR" | "AUTONOMOUS_AGENT";
  imageDigest?: string | null | undefined;
  pricingModel: "PAY_PER_RUN" | "PAY_PER_RESULT";
  priceAtomic: string;
  payTo: string;
  erc8004TokenId?: string | null | undefined;
}

export interface RegistryVerificationResult {
  verified: boolean;
  reason?: string;
}

export interface RegistryVerifier {
  verifyRegistration(
    registryTxHash: string,
    expected: ExpectedFacetRegistration,
  ): Promise<RegistryVerificationResult>;
}

function toFacetTypeCode(
  facetType: ExpectedFacetRegistration["facetType"],
): number {
  if (facetType === "HOSTED_ACTOR") return 1;
  if (facetType === "AUTONOMOUS_AGENT") return 2;
  return 0;
}

function toPricingModelCode(
  pricingModel: ExpectedFacetRegistration["pricingModel"],
): number {
  return pricingModel === "PAY_PER_RESULT" ? 1 : 0;
}

function toBytes32Digest(digest?: string | null): Hex {
  if (!digest) return zeroHash;
  if (/^sha256:[a-f0-9]{64}$/iu.test(digest)) {
    return `0x${digest.slice(7).toLowerCase()}` as Hex;
  }
  if (/^0x[a-f0-9]{64}$/iu.test(digest)) {
    return digest.toLowerCase() as Hex;
  }
  return zeroHash;
}

export function uuidToFacetKey(facetId: string): Hex {
  return keccak256(toBytes(facetId));
}

export function registrationMatches(
  observed: {
    facetId?: Hex;
    facetType: number;
    imageDigest: Hex;
    pricingModel: number;
    priceAtomic: bigint;
    payTo: Address;
    erc8004TokenId: bigint;
    active?: boolean;
  },
  expected: ExpectedFacetRegistration,
): RegistryVerificationResult {
  const expectedKey = uuidToFacetKey(expected.facetId);
  if (
    observed.facetId &&
    observed.facetId.toLowerCase() !== expectedKey.toLowerCase()
  ) {
    return {
      verified: false,
      reason: "On-chain facetId does not match the published Facet UUID.",
    };
  }
  if (observed.active === false) {
    return {
      verified: false,
      reason: "On-chain Facet registration is marked inactive.",
    };
  }
  if (Number(observed.facetType) !== toFacetTypeCode(expected.facetType)) {
    return {
      verified: false,
      reason: "On-chain facetType does not match.",
    };
  }
  if (
    expected.facetType === "HOSTED_ACTOR" &&
    observed.imageDigest.toLowerCase() !==
      toBytes32Digest(expected.imageDigest).toLowerCase()
  ) {
    return {
      verified: false,
      reason: "On-chain imageDigest does not match the published Actor code.",
    };
  }
  if (
    Number(observed.pricingModel) !== toPricingModelCode(expected.pricingModel)
  ) {
    return {
      verified: false,
      reason: "On-chain pricingModel does not match.",
    };
  }
  if (observed.priceAtomic !== BigInt(expected.priceAtomic)) {
    return {
      verified: false,
      reason: "On-chain priceAtomic does not match.",
    };
  }
  if (observed.payTo.toLowerCase() !== expected.payTo.toLowerCase()) {
    return {
      verified: false,
      reason: "On-chain payTo address does not match.",
    };
  }
  if (
    expected.facetType === "AUTONOMOUS_AGENT" &&
    observed.erc8004TokenId !== BigInt(expected.erc8004TokenId ?? "0")
  ) {
    return {
      verified: false,
      reason: "On-chain erc8004TokenId does not match.",
    };
  }
  return { verified: true };
}

export class FujiRegistryVerifier implements RegistryVerifier {
  private readonly client;
  private readonly registryAddress: Address;

  constructor(rpcUrl: string, registryAddress: string) {
    this.registryAddress = registryAddress.toLowerCase() as Address;
    this.client = createPublicClient({
      transport: http(rpcUrl, { timeout: 15_000 }),
    });
  }

  async verifyRegistration(
    registryTxHash: string,
    expected: ExpectedFacetRegistration,
  ): Promise<RegistryVerificationResult> {
    if (!/^0x[a-f0-9]{64}$/iu.test(registryTxHash)) {
      return { verified: false, reason: "Invalid registryTxHash format." };
    }

    const chainId = await this.client.getChainId();
    if (chainId !== FUJI_CHAIN_ID) {
      return {
        verified: false,
        reason: `RPC chainId ${chainId} does not match Avalanche Fuji (${FUJI_CHAIN_ID}).`,
      };
    }

    const receipt = await this.client.getTransactionReceipt({
      hash: registryTxHash as Hex,
    });
    if (receipt.status !== "success") {
      return {
        verified: false,
        reason: "Registration transaction did not succeed on Fuji.",
      };
    }

    const expectedKey = uuidToFacetKey(expected.facetId);
    let matchedEvent: {
      facetId: Hex;
      facetType: number;
      imageDigest: Hex;
      pricingModel: number;
      priceAtomic: bigint;
      payTo: Address;
      erc8004TokenId: bigint;
    } | null = null;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== this.registryAddress) continue;
      try {
        const decoded = decodeEventLog({
          abi: FACET_ACTOR_REGISTRY_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "FacetRegistered") {
          const args = decoded.args;
          if (args.facetId.toLowerCase() === expectedKey.toLowerCase()) {
            matchedEvent = {
              facetId: args.facetId,
              facetType: Number(args.facetType),
              imageDigest: args.imageDigest,
              pricingModel: Number(args.pricingModel),
              priceAtomic: args.priceAtomic,
              payTo: args.payTo,
              erc8004TokenId: args.erc8004TokenId,
            };
            break;
          }
        }
      } catch {
        // Ignore unrelated log signatures
      }
    }

    if (!matchedEvent) {
      return {
        verified: false,
        reason:
          "No matching FacetRegistered event from FacetActorRegistry found in transaction.",
      };
    }

    const eventCheck = registrationMatches(matchedEvent, expected);
    if (!eventCheck.verified) return eventCheck;

    const onChainState = (await this.client.readContract({
      address: this.registryAddress,
      abi: FACET_ACTOR_REGISTRY_ABI,
      functionName: "getFacet",
      args: [expectedKey],
    })) as {
      facetType: number;
      imageDigest: Hex;
      schemaURI: string;
      pricingModel: number;
      priceAtomic: bigint;
      payTo: Address;
      erc8004TokenId: bigint;
      active: boolean;
    };

    return registrationMatches(
      {
        facetId: expectedKey,
        facetType: Number(onChainState.facetType),
        imageDigest: onChainState.imageDigest,
        pricingModel: Number(onChainState.pricingModel),
        priceAtomic: onChainState.priceAtomic,
        payTo: onChainState.payTo,
        erc8004TokenId: onChainState.erc8004TokenId,
        active: onChainState.active,
      },
      expected,
    );
  }
}
