export type PricingModel = "PAY_PER_RUN" | "PAY_PER_RESULT";

export const FUSD_ASSET_ADDRESS = "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f";
export const FUJI_CHAIN_ID = 43113 as const;
export const DEFAULT_PAY_TO = "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf";
export const DEFAULT_ERC8004_REGISTRY =
  "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const ACTOR_RUNNER_IMAGE = "facet/node-actor-runner:1.0";
export const ACTOR_RUNTIME_NAME = "nodejs22-alpine-v1";

export interface CreateActorCommand {
  id?: string | undefined;
  providerId: string;
  name: string;
  slug: string;
  displayVersion?: string | undefined;
  summary?: string | undefined;
  description: string;
  category: string;
  tags?: string[] | undefined;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
  code: string;
  pricingModel?: PricingModel | undefined;
  priceAtomic?: string | undefined;
  payTo?: string | undefined;
  registryTxHash?: string | undefined;
}

export interface PublishedActorRecord {
  id: string;
  versionId: string;
  slug: string;
  facetType: "HOSTED_ACTOR";
  imageDigest: string;
  registryVerified: boolean;
  status: "PUBLISHED" | "REGISTRATION_PENDING";
  visibility: "PUBLIC" | "PRIVATE";
  publishedAt?: Date | undefined;
}

export interface CreateAgentFacetCommand {
  id?: string | undefined;
  providerId: string;
  name: string;
  slug: string;
  summary?: string | undefined;
  description: string;
  category: string;
  tags?: string[] | undefined;
  erc8004TokenId: string;
  erc8004Registry?: string | undefined;
  taskKind: string;
  code?: string | undefined;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
  pricingModel?: PricingModel | undefined;
  priceAtomic?: string | undefined;
  payTo?: string | undefined;
  registryTxHash?: string | undefined;
}

export interface PublishedAgentFacetRecord {
  id: string;
  versionId: string;
  slug: string;
  facetType: "AUTONOMOUS_AGENT";
  erc8004TokenId: string;
  erc8004Registry: string;
  registryVerified: boolean;
  status: "PUBLISHED";
  visibility: "PUBLIC";
  publishedAt: Date;
}

export interface PublishedFacetRegistryContext {
  facetId: string;
  providerId: string;
  versionId: string;
  facetType: "EXTERNAL_HTTP_API" | "HOSTED_ACTOR" | "AUTONOMOUS_AGENT";
  imageDigest: string | null;
  pricingModel: PricingModel;
  priceAtomic: string;
  payTo: string;
  erc8004TokenId: string | null;
}

export interface ActorAgentStore {
  getActorPublishStatus(facetId: string): Promise<
    | {
        providerId: string;
        facetId: string;
        versionId: string;
        status: "REGISTRATION_PENDING" | "PUBLISHED" | "REGISTRATION_FAILED";
        registryTxHash: string | null;
        errorCode: string | null;
      }
    | undefined
  >;
  publishActor(input: {
    actorUserId: string;
    command: CreateActorCommand;
    imageDigest: string;
    codeSha256: string;
    payTo: string;
    registryVerified: boolean;
    requestId: string;
    pending?: boolean;
    idempotencyKey?: string;
    requestFingerprint?: string;
    publicBaseUrl?: string;
  }): Promise<PublishedActorRecord>;
  publishAgentFacet(input: {
    actorUserId: string;
    command: CreateAgentFacetCommand;
    erc8004Registry: string;
    codeSha256: string;
    payTo: string;
    registryVerified: boolean;
    requestId: string;
  }): Promise<PublishedAgentFacetRecord>;
  getPublishedRegistryContext(
    facetId: string,
  ): Promise<PublishedFacetRegistryContext | undefined>;
  markRegistryVerified(input: {
    actorUserId: string;
    facetId: string;
    versionId: string;
    providerId: string;
    registryTxHash: string;
    requestId: string;
  }): Promise<void>;
}
