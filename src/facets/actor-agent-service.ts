import { createHash } from "node:crypto";

import { Ajv2020 } from "ajv/dist/2020.js";

import type { AuthenticatedIdentity } from "../auth/types.js";
import { AppError } from "../errors.js";
import { requireProviderPermission } from "../providers/provider-rbac.js";
import type { ProviderStore } from "../providers/provider-types.js";
import {
  ACTOR_RUNNER_IMAGE,
  DEFAULT_ERC8004_REGISTRY,
  DEFAULT_PAY_TO,
  type ActorAgentStore,
  type CreateActorCommand,
  type CreateAgentFacetCommand,
} from "./actor-agent-types.js";
import type { RegistryVerifier } from "./fuji-registry-verifier.js";

const schemaAjv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
  validateFormats: false,
});

export function computeActorImageDigest(code: string): string {
  const hex = createHash("sha256")
    .update(`${ACTOR_RUNNER_IMAGE}\n${code.trim()}`, "utf8")
    .digest("hex");
  return `sha256:${hex}`;
}

function assertValidJsonSchema(
  schema: Record<string, unknown>,
  label: string,
): void {
  try {
    schemaAjv.compile(schema);
  } catch {
    throw new AppError(
      "INPUT_INVALID",
      `${label} is not a valid JSON Schema 2020-12 object.`,
      400,
    );
  }
}

function assertValidActorCode(code: string): void {
  const trimmed = code.trim();
  if (
    !/(export\s+default\b|export\s+(?:async\s+)?function\s+run\b)/u.test(
      trimmed,
    )
  ) {
    throw new AppError(
      "INPUT_INVALID",
      "Actor code must export a default function or a named `run(input)` function.",
      400,
    );
  }
}

export class ActorAgentService {
  constructor(
    private readonly providers: ProviderStore,
    private readonly store: ActorAgentStore,
    private readonly registryVerifier?: RegistryVerifier,
  ) {}

  async publishActor(
    identity: AuthenticatedIdentity,
    command: CreateActorCommand,
    requestId: string,
  ) {
    assertValidJsonSchema(command.inputSchema, "inputSchema");
    if (command.outputSchema) {
      assertValidJsonSchema(command.outputSchema, "outputSchema");
    }
    assertValidActorCode(command.code);

    const actor = await this.providers.upsertUser(identity);
    const role = await this.providers.getMembershipRole(
      command.providerId,
      actor.id,
    );
    requireProviderPermission(role, "facet:write");

    const provider = await this.providers.getProvider(command.providerId);
    if (!provider) {
      throw new AppError("RESOURCE_NOT_FOUND", "Provider not found.", 404);
    }

    const payTo = command.payTo ?? provider.walletAddress ?? DEFAULT_PAY_TO;
    const imageDigest = computeActorImageDigest(command.code);
    const codeSha256 = createHash("sha256")
      .update(command.code.trim(), "utf8")
      .digest("hex");

    let registryVerified = false;
    if (command.registryTxHash) {
      if (!command.id) {
        throw new AppError(
          "INPUT_INVALID",
          "Supplying registryTxHash at publish time requires explicit facet `id` matching the on-chain FacetActorRegistry key, or call POST /v1/facets/:facetId/verify-registry after publishing.",
          400,
        );
      }
      if (this.registryVerifier) {
        const result = await this.registryVerifier.verifyRegistration(
          command.registryTxHash,
          {
            facetId: command.id,
            facetType: "HOSTED_ACTOR",
            imageDigest,
            pricingModel: command.pricingModel ?? "PAY_PER_RUN",
            priceAtomic: command.priceAtomic ?? "1000",
            payTo,
          },
        );
        if (!result.verified) {
          throw new AppError(
            "REGISTRY_VERIFICATION_FAILED",
            result.reason ?? "On-chain FacetActorRegistry verification failed.",
            400,
          );
        }
        registryVerified = true;
      }
    }

    const published = await this.store.publishActor({
      actorUserId: actor.id,
      command,
      imageDigest,
      codeSha256,
      payTo,
      registryVerified,
      requestId,
    });

    return {
      ...published,
      publishedAt: published.publishedAt.toISOString(),
    };
  }

  async publishAgentFacet(
    identity: AuthenticatedIdentity,
    command: CreateAgentFacetCommand,
    requestId: string,
  ) {
    assertValidJsonSchema(command.inputSchema, "inputSchema");
    if (command.outputSchema) {
      assertValidJsonSchema(command.outputSchema, "outputSchema");
    }

    const actor = await this.providers.upsertUser(identity);
    const role = await this.providers.getMembershipRole(
      command.providerId,
      actor.id,
    );
    requireProviderPermission(role, "facet:write");

    const provider = await this.providers.getProvider(command.providerId);
    if (!provider) {
      throw new AppError("RESOURCE_NOT_FOUND", "Provider not found.", 404);
    }

    const payTo = command.payTo ?? provider.walletAddress ?? DEFAULT_PAY_TO;
    const erc8004Registry = command.erc8004Registry ?? DEFAULT_ERC8004_REGISTRY;
    const codeSha256 = createHash("sha256")
      .update(
        (
          command.code ?? `${command.taskKind}:${command.erc8004TokenId}`
        ).trim(),
        "utf8",
      )
      .digest("hex");

    let registryVerified = false;
    if (command.registryTxHash) {
      if (!command.id) {
        throw new AppError(
          "INPUT_INVALID",
          "Supplying registryTxHash at publish time requires explicit facet `id` matching the on-chain FacetActorRegistry key, or call POST /v1/facets/:facetId/verify-registry after publishing.",
          400,
        );
      }
      if (this.registryVerifier) {
        const result = await this.registryVerifier.verifyRegistration(
          command.registryTxHash,
          {
            facetId: command.id,
            facetType: "AUTONOMOUS_AGENT",
            pricingModel: command.pricingModel ?? "PAY_PER_RUN",
            priceAtomic: command.priceAtomic ?? "1000",
            payTo,
            erc8004TokenId: command.erc8004TokenId,
          },
        );
        if (!result.verified) {
          throw new AppError(
            "REGISTRY_VERIFICATION_FAILED",
            result.reason ?? "On-chain FacetActorRegistry verification failed.",
            400,
          );
        }
        registryVerified = true;
      }
    }

    const published = await this.store.publishAgentFacet({
      actorUserId: actor.id,
      command,
      erc8004Registry,
      codeSha256,
      payTo,
      registryVerified,
      requestId,
    });

    return {
      ...published,
      publishedAt: published.publishedAt.toISOString(),
    };
  }

  async verifyRegistry(
    identity: AuthenticatedIdentity,
    facetId: string,
    registryTxHash: string,
    requestId: string,
  ) {
    if (!this.registryVerifier) {
      throw new AppError(
        "REGISTRY_VERIFIER_UNCONFIGURED",
        "Fuji FacetActorRegistry verification is not configured on this Control API instance.",
        503,
      );
    }

    const actor = await this.providers.upsertUser(identity);
    const context = await this.store.getPublishedRegistryContext(facetId);
    if (!context) {
      throw new AppError(
        "RESOURCE_NOT_FOUND",
        "Published Facet not found.",
        404,
      );
    }

    const role = await this.providers.getMembershipRole(
      context.providerId,
      actor.id,
    );
    requireProviderPermission(role, "facet:write");

    const verification = await this.registryVerifier.verifyRegistration(
      registryTxHash,
      {
        facetId: context.facetId,
        facetType: context.facetType,
        imageDigest: context.imageDigest,
        pricingModel: context.pricingModel,
        priceAtomic: context.priceAtomic,
        payTo: context.payTo,
        erc8004TokenId: context.erc8004TokenId,
      },
    );

    if (!verification.verified) {
      throw new AppError(
        "REGISTRY_VERIFICATION_FAILED",
        verification.reason ??
          "On-chain FacetActorRegistry verification failed.",
        400,
      );
    }

    await this.store.markRegistryVerified({
      actorUserId: actor.id,
      facetId: context.facetId,
      versionId: context.versionId,
      providerId: context.providerId,
      registryTxHash,
      requestId,
    });

    return {
      facetId: context.facetId,
      versionId: context.versionId,
      registryTxHash,
      registryVerified: true,
    };
  }
}
