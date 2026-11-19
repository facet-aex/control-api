import { createHash } from "node:crypto";

import type { AuthenticatedIdentity } from "../auth/types.js";
import { AppError } from "../errors.js";
import {
  isValidFacetName,
  isValidSemver,
  isValidUsername,
} from "../identifiers.js";
import type { ProviderStore } from "../providers/provider-types.js";
import { hashFacetManifest } from "./facet-manifest.js";
import type { RegistryVerifier } from "./fuji-registry-verifier.js";
import type {
  ActorAgentStore,
  PublishActorCommand,
  PublishAgentFacetCommand,
} from "./actor-agent-types.js";

export const FUSD_ADDRESS = "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f";
export const DEMO_LOCAL_PAY_TO = "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf";
export const DEFAULT_ERC8004_REGISTRY =
  "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const AVALANCHE_FUJI_CHAIN_ID = 43113;

export const ACTOR_RUNNER_IMAGE = "facet/node-actor-runner:1.0";

export function computeActorImageDigest(code: string): string {
  const hash = createHash("sha256")
    .update(`${ACTOR_RUNNER_IMAGE}\n${code.trim()}`)
    .digest("hex");
  return `sha256:${hash}`;
}

export function validateActorCode(code: string): void {
  if (!/export\s+default\s+(?:async\s+)?function(?:\s+run)?\s*\(/u.test(code)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Actor code must export default async function run(input).",
      400,
    );
  }
}

export function validateInputSchema(schema: Record<string, unknown>): void {
  if (schema.type !== "object") {
    throw new AppError(
      "VALIDATION_FAILED",
      "Actor inputSchema must have type 'object'.",
      400,
    );
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  return `{${entries
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

function resolvePayout(
  environment: "local" | "preview" | "production",
  verifiedWalletAddress: string | null,
  requestedPayTo: string | undefined,
): string {
  if (environment === "local") {
    return requestedPayTo ?? verifiedWalletAddress ?? DEMO_LOCAL_PAY_TO;
  }
  if (!verifiedWalletAddress) {
    throw new AppError(
      "FORBIDDEN",
      "A verified payout wallet is required before publishing in this environment.",
      403,
    );
  }
  if (
    requestedPayTo &&
    requestedPayTo.toLowerCase() !== verifiedWalletAddress.toLowerCase()
  ) {
    throw new AppError(
      "FORBIDDEN",
      "payTo must match the authenticated user's verified payout wallet.",
      403,
    );
  }
  return verifiedWalletAddress;
}

export class ActorAgentService {
  constructor(
    private readonly providers: ProviderStore,
    private readonly store: ActorAgentStore,
    private readonly verifier: RegistryVerifier | undefined,
    private readonly options: {
      environment: "local" | "preview" | "production";
      publicBaseUrl?: string;
    } = { environment: "local" },
  ) {}

  async listMyActors(identity: AuthenticatedIdentity) {
    const actor = await this.providers.upsertUser(identity);
    if (actor.status !== "active") {
      throw new AppError("FORBIDDEN", "User account is disabled.", 403);
    }
    const actors = await this.store.listMyActors(actor.id);
    return { actors };
  }

  async listMyFacets(identity: AuthenticatedIdentity) {
    const actor = await this.providers.upsertUser(identity);
    if (actor.status !== "active") {
      throw new AppError("FORBIDDEN", "User account is disabled.", 403);
    }
    const facets = await this.store.listMyFacets(actor.id);
    return { facets };
  }

  async getActorPublishStatus(
    identity: AuthenticatedIdentity,
    provider: string,
    facetName: string,
    version: string,
  ) {
    if (
      !isValidUsername(provider) ||
      !isValidFacetName(facetName) ||
      !isValidSemver(version)
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Invalid provider, facetName, or version.",
        422,
      );
    }
    const actor = await this.providers.upsertUser(identity);
    if (actor.status !== "active") {
      throw new AppError("FORBIDDEN", "User account is disabled.", 403);
    }
    if (actor.username !== provider) {
      throw new AppError(
        "FORBIDDEN",
        "Authenticated user does not own this provider namespace.",
        403,
      );
    }
    const record = await this.store.getActorPublishStatus(
      provider,
      facetName,
      version,
    );
    if (!record || record.providerId !== actor.id) {
      throw new AppError("RESOURCE_NOT_FOUND", "Actor version not found.", 404);
    }
    return {
      provider: record.provider,
      facetName: record.facetName,
      version: record.version,
      status: record.status,
      ...(record.registryTxHash
        ? { registryTxHash: record.registryTxHash }
        : {}),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    };
  }

  async publishActor(
    identity: AuthenticatedIdentity,
    command: PublishActorCommand,
    requestId: string,
    idempotencyKey?: string,
  ) {
    const version = command.version ?? "1.0.0";
    if (!isValidFacetName(command.facetName) || !isValidSemver(version)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Invalid facetName or SemVer version.",
        400,
      );
    }
    validateInputSchema(command.inputSchema);
    validateActorCode(command.code);

    const actor = await this.providers.upsertUser(identity);
    if (actor.status !== "active") {
      throw new AppError("FORBIDDEN", "User account is disabled.", 403);
    }

    const payTo = resolvePayout(
      this.options.environment,
      actor.walletAddress,
      command.payTo,
    );
    const pricingModel = command.pricingModel ?? "PAY_PER_RUN";
    const priceAtomic = command.priceAtomic ?? "1000";
    const imageDigest = computeActorImageDigest(command.code);
    const pending = this.options.environment !== "local";
    const visibility = pending ? "PRIVATE" : "PUBLIC";

    const manifest = {
      schemaVersion: "facet.manifest/v1",
      providerId: actor.id,
      provider: actor.username,
      facetName: command.facetName,
      facetDisplayName: command.facetDisplayName,
      version,
      type: "ACTOR" as const,
      summary: command.summary ?? command.description.slice(0, 280),
      description: command.description,
      category: command.category,
      tags: command.tags ?? [],
      visibility,
      operation: {
        operationId: "run",
        method: "POST" as const,
        publicPathTemplate: `/v1/facets/${actor.username}/${command.facetName}/versions/${version}/invoke`,
        inputSchema: command.inputSchema,
        outputSchema: command.outputSchema ?? { type: "object" },
        errorSchema: { type: "object" },
        sideEffectClass: "READ_ONLY" as const,
      },
      executionPolicy: {
        timeoutMs: 15_000,
        maxResponseBytes: 1_048_576,
        redirectPolicy: "DENY" as const,
      },
      upstreamAuth: {
        kind: "NONE" as const,
        configured: true,
      },
      pricing: {
        model: pricingModel,
        priceAtomic,
        assetAddress: FUSD_ADDRESS,
        chainId: AVALANCHE_FUJI_CHAIN_ID,
        payTo,
      },
      actorConfig: {
        runtime: "node-22-esm",
        entrypoint: "run",
        imageDigest,
      },
      provenance: {
        sourceType: "ACTOR_TEMPLATE" as const,
        sourceOperationPointer: "#/run",
      },
    };

    const contentHash = hashFacetManifest(manifest);
    const publicOrigin = new URL(
      this.options.publicBaseUrl ?? "https://facet.example",
    ).origin;
    const schemaUri = `${publicOrigin}/v1/catalog/facets/${encodeURIComponent(actor.username)}/${encodeURIComponent(command.facetName)}/versions/${encodeURIComponent(version)}`;
    const requestFingerprint = createHash("sha256")
      .update(
        stableStringify({
          provider: actor.username,
          facetName: command.facetName,
          facetDisplayName: command.facetDisplayName,
          version,
          summary: command.summary ?? "",
          description: command.description,
          category: command.category,
          tags: command.tags ?? [],
          inputSchema: command.inputSchema,
          outputSchema: command.outputSchema ?? null,
          code: command.code,
          pricingModel,
          priceAtomic,
          payTo,
        }),
      )
      .digest("hex");

    const record = await this.store.publishActor({
      actorUserId: actor.id,
      providerUsername: actor.username,
      command: { ...command, version, pricingModel, priceAtomic },
      manifest,
      contentHash,
      imageDigest,
      payTo,
      registryVerified: false,
      pending,
      idempotencyKey:
        idempotencyKey ??
        `actor:${actor.username}:${command.facetName}:${version}`,
      requestFingerprint,
      schemaUri,
      requestId,
    });

    if (record.status === "REGISTRATION_PENDING") {
      return {
        statusCode: 202 as const,
        body: {
          facet: {
            provider: record.provider,
            facetName: record.facetName,
            facetDisplayName: record.facetDisplayName,
            version: record.version,
            facetType: record.facetType,
            status: "REGISTRATION_PENDING" as const,
            visibility: "PRIVATE" as const,
            imageDigest: record.imageDigest,
          },
        },
      };
    }

    return {
      statusCode: 201 as const,
      body: {
        facet: {
          provider: record.provider,
          facetName: record.facetName,
          facetDisplayName: record.facetDisplayName,
          version: record.version,
          facetType: record.facetType,
          imageDigest: record.imageDigest,
          status: "PUBLISHED" as const,
          visibility: record.visibility,
          publishedAt: (record.publishedAt ?? new Date()).toISOString(),
        },
      },
    };
  }

  async publishAgentFacet(
    identity: AuthenticatedIdentity,
    command: PublishAgentFacetCommand,
    requestId: string,
  ) {
    const version = command.version ?? "1.0.0";
    if (!isValidFacetName(command.facetName) || !isValidSemver(version)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Invalid facetName or SemVer version.",
        400,
      );
    }
    validateInputSchema(command.inputSchema);

    const actor = await this.providers.upsertUser(identity);
    if (actor.status !== "active") {
      throw new AppError("FORBIDDEN", "User account is disabled.", 403);
    }

    const payTo = resolvePayout(
      this.options.environment,
      actor.walletAddress,
      command.payTo,
    );
    const pricingModel = command.pricingModel ?? "PAY_PER_RUN";
    const priceAtomic = command.priceAtomic ?? "1000";
    const erc8004Registry = command.erc8004Registry ?? DEFAULT_ERC8004_REGISTRY;

    const manifest = {
      schemaVersion: "facet.manifest/v1",
      providerId: actor.id,
      provider: actor.username,
      facetName: command.facetName,
      facetDisplayName: command.facetDisplayName,
      version,
      type: "AGENT" as const,
      summary: command.summary ?? command.description.slice(0, 280),
      description: command.description,
      category: command.category,
      tags: command.tags ?? [],
      visibility: "PUBLIC" as const,
      operation: {
        operationId: "delegate",
        method: "POST" as const,
        publicPathTemplate: `/v1/facets/${actor.username}/${command.facetName}/versions/${version}/invoke`,
        inputSchema: command.inputSchema,
        outputSchema: command.outputSchema ?? { type: "object" },
        errorSchema: { type: "object" },
        sideEffectClass: "READ_ONLY" as const,
      },
      executionPolicy: {
        timeoutMs: 30_000,
        maxResponseBytes: 1_048_576,
        redirectPolicy: "DENY" as const,
      },
      upstreamAuth: {
        kind: "NONE" as const,
        configured: true,
      },
      pricing: {
        model: pricingModel,
        priceAtomic,
        assetAddress: FUSD_ADDRESS,
        chainId: AVALANCHE_FUJI_CHAIN_ID,
        payTo,
      },
      agentConfig: {
        erc8004ChainId: AVALANCHE_FUJI_CHAIN_ID,
        erc8004Registry,
        erc8004TokenId: command.erc8004TokenId,
        a2aProtocolVersion: "1.0",
        taskKind: command.taskKind,
      },
      provenance: {
        sourceType: "A2A_AGENT_CARD" as const,
        sourceOperationPointer: "#/delegate",
      },
    };

    const contentHash = hashFacetManifest(manifest);
    const record = await this.store.publishAgentFacet({
      actorUserId: actor.id,
      providerUsername: actor.username,
      command: { ...command, version, pricingModel, priceAtomic },
      manifest,
      contentHash,
      erc8004Registry,
      payTo,
      registryVerified: false,
      requestId,
    });

    return {
      facet: {
        provider: record.provider,
        facetName: record.facetName,
        facetDisplayName: record.facetDisplayName,
        version: record.version,
        facetType: record.facetType,
        erc8004TokenId: record.erc8004TokenId,
        erc8004Registry: record.erc8004Registry,
        status: record.status,
        visibility: record.visibility,
        publishedAt: record.publishedAt.toISOString(),
      },
    };
  }

  async verifyRegistry(
    identity: AuthenticatedIdentity,
    input: {
      provider: string;
      facetName: string;
      version: string;
      registryTxHash: string;
    },
    requestId: string,
  ) {
    if (
      !isValidUsername(input.provider) ||
      !isValidFacetName(input.facetName) ||
      !isValidSemver(input.version)
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Invalid provider, facetName, or version.",
        422,
      );
    }

    const actor = await this.providers.upsertUser(identity);
    if (actor.status !== "active") {
      throw new AppError("FORBIDDEN", "User account is disabled.", 403);
    }
    if (actor.username !== input.provider) {
      throw new AppError(
        "FORBIDDEN",
        "Authenticated user does not own this provider namespace.",
        403,
      );
    }

    const context = await this.store.getPublishedRegistryContextByName(
      input.provider,
      input.facetName,
      input.version,
    );
    if (!context || context.providerId !== actor.id) {
      throw new AppError("RESOURCE_NOT_FOUND", "Facet version not found.", 404);
    }

    if (!this.verifier) {
      throw new AppError(
        "SERVICE_UNAVAILABLE",
        "Registry verifier is not configured.",
        503,
      );
    }

    const verified = await this.verifier.verifyRegistration(
      input.registryTxHash,
      {
        facetId: context.facetId,
        versionId: context.versionId,
        facetType: context.facetType,
        ...(context.imageDigest ? { imageDigest: context.imageDigest } : {}),
        pricingModel: context.pricingModel,
        priceAtomic: context.priceAtomic,
        payTo: context.payTo ?? "",
        ...(context.erc8004TokenId
          ? { erc8004TokenId: context.erc8004TokenId }
          : {}),
      },
    );
    if (!verified.verified) {
      throw new AppError(
        "VALIDATION_FAILED",
        verified.reason ?? "Registry transaction verification failed.",
        400,
      );
    }

    await this.store.markRegistryVerified({
      actorUserId: actor.id,
      facetId: context.facetId,
      versionId: context.versionId,
      providerId: context.providerId,
      registryTxHash: input.registryTxHash,
      requestId,
    });

    return {
      provider: input.provider,
      facetName: input.facetName,
      version: input.version,
      registryTxHash: input.registryTxHash,
      registryVerified: true,
    };
  }
}
