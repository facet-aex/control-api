import type { FacetType, PricingModel } from "../identifiers.js";

export type ActorPublishStatus =
  "REGISTRATION_PENDING" | "PUBLISHED" | "FAILED";

export type MyFacetStatus =
  | "REGISTRATION_PENDING"
  | "PUBLISHED"
  | "FAILED"
  | "DRAFT"
  | "VALID"
  | "DISABLED";

export interface PublishActorCommand {
  facetName: string;
  facetDisplayName: string;
  version?: string | undefined;
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

export interface PublishAgentFacetCommand {
  facetName: string;
  facetDisplayName: string;
  version?: string | undefined;
  summary?: string | undefined;
  description: string;
  category: string;
  tags?: string[] | undefined;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown> | undefined;
  erc8004TokenId: string;
  erc8004Registry?: string | undefined;
  taskKind: string;
  pricingModel?: PricingModel | undefined;
  priceAtomic?: string | undefined;
  payTo?: string | undefined;
  registryTxHash?: string | undefined;
}

export interface PublishedActorRecord {
  provider: string;
  facetName: string;
  facetDisplayName: string;
  version: string;
  facetType: "ACTOR";
  imageDigest: string;
  registryVerified: boolean;
  status: ActorPublishStatus;
  visibility: "PRIVATE" | "PUBLIC";
  publishedAt?: Date;
}

export interface MyActorSummary {
  provider: string;
  facetName: string;
  facetDisplayName: string;
  version: string;
  status: ActorPublishStatus;
  registryTxHash: string | null;
}

export interface MyFacetSummary {
  provider: string;
  facetName: string;
  facetDisplayName: string;
  facetType: FacetType;
  version: string;
  category: string;
  visibility: "PRIVATE" | "PUBLIC" | "UNLISTED";
  status: MyFacetStatus;
  pricingModel: PricingModel;
  priceAtomic: string;
  registryVerified: boolean;
  registryTxHash: string | null;
  errorCode: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface ActorPublishStatusRecord {
  providerId: string;
  provider: string;
  facetName: string;
  version: string;
  status: ActorPublishStatus;
  registryTxHash: string | null;
  errorCode: string | null;
}

export interface PublishedAgentFacetRecord {
  provider: string;
  facetName: string;
  facetDisplayName: string;
  version: string;
  facetType: "AGENT";
  erc8004TokenId: string;
  erc8004Registry: string;
  status: "PUBLISHED";
  visibility: "PUBLIC";
  publishedAt: Date;
}

export interface PublishedFacetRegistryContext {
  facetId: string;
  providerId: string;
  versionId: string;
  facetType: FacetType;
  imageDigest: string | null;
  pricingModel: PricingModel;
  priceAtomic: string;
  payTo: string | null;
  erc8004TokenId: string | null;
}

export interface ActorAgentStore {
  listMyActors(userId: string): Promise<MyActorSummary[]>;
  listMyFacets(userId: string): Promise<MyFacetSummary[]>;
  getActorPublishStatus(
    provider: string,
    facetName: string,
    version: string,
  ): Promise<ActorPublishStatusRecord | undefined>;
  publishActor(input: {
    actorUserId: string;
    providerUsername: string;
    command: PublishActorCommand;
    manifest: Record<string, unknown>;
    contentHash: string;
    imageDigest: string;
    payTo: string;
    registryVerified: boolean;
    pending?: boolean;
    idempotencyKey?: string;
    requestFingerprint?: string;
    schemaUri?: string;
    requestId: string;
  }): Promise<PublishedActorRecord>;
  publishAgentFacet(input: {
    actorUserId: string;
    providerUsername: string;
    command: PublishAgentFacetCommand;
    manifest: Record<string, unknown>;
    contentHash: string;
    erc8004Registry: string;
    payTo: string;
    registryVerified: boolean;
    requestId: string;
  }): Promise<PublishedAgentFacetRecord>;
  getPublishedRegistryContextByName(
    provider: string,
    facetName: string,
    version: string,
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
