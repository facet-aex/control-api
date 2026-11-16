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

    const published = await this.store.publishActor({
      actorUserId: actor.id,
      command,
      imageDigest,
      codeSha256,
      payTo,
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

    const published = await this.store.publishAgentFacet({
      actorUserId: actor.id,
      command,
      erc8004Registry,
      codeSha256,
      payTo,
      requestId,
    });

    return {
      ...published,
      publishedAt: published.publishedAt.toISOString(),
    };
  }
}
