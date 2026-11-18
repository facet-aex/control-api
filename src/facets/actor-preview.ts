import { randomUUID } from "node:crypto";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { IdentityAuthenticator } from "../auth/types.js";
import { AppError } from "../errors.js";
import { requireProviderPermission } from "../providers/provider-rbac.js";
import type { ProviderStore } from "../providers/provider-types.js";
import { computeActorImageDigest } from "./actor-agent-service.js";

const previewSchema = z
  .object({
    providerId: z.string().uuid(),
    code: z.string().min(10).max(131_072),
    inputSchema: z.record(z.string(), z.unknown()),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();

const MAX_INPUT_BYTES = 16 * 1024;
const MAX_SCHEMA_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface PreviewExecutionRequest {
  runId: string;
  facetId: string;
  facetVersionId: string;
  facetType: "HOSTED_ACTOR";
  input: Record<string, unknown>;
  timeoutMs: number;
  actorBundle: { code: string; imageDigest: string };
}

export interface ActorPreviewRouteDependencies {
  authenticator: IdentityAuthenticator;
  providers: ProviderStore;
  consumeQuota(userId: string, now: Date): Promise<boolean>;
  execute(request: PreviewExecutionRequest): Promise<unknown>;
}

async function authenticate(
  request: FastifyRequest,
  authenticator: IdentityAuthenticator,
) {
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;
  return authenticator.authenticate({
    ...(request.headers.authorization
      ? { authorization: request.headers.authorization }
      : {}),
    ...(first(request.headers["x-facet-dev-user"])
      ? { devUser: first(request.headers["x-facet-dev-user"]) }
      : {}),
  });
}

function validatePreview(
  code: string,
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
) {
  if (
    Buffer.byteLength(code, "utf8") > 131_072 ||
    Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_SCHEMA_BYTES ||
    Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_INPUT_BYTES
  ) {
    throw new AppError(
      "PREVIEW_TOO_LARGE",
      "Actor preview exceeds its size limit.",
      413,
    );
  }
  if (
    !/(export\s+default\b|export\s+(?:async\s+)?function\s+run\b)/u.test(code)
  ) {
    throw new AppError(
      "INPUT_INVALID",
      "Actor code must export run(input).",
      400,
    );
  }
  if (schema.type !== "object") {
    throw new AppError(
      "INPUT_INVALID",
      "Actor inputSchema must be an object schema.",
      400,
    );
  }
  try {
    const validator = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(schema);
    if (validator(input)) return;
  } catch {
    // Use the same client-facing error for malformed schemas and invalid inputs.
  }
  throw new AppError(
    "INPUT_INVALID",
    "Actor preview input does not match inputSchema.",
    400,
  );
}

function validResponse(value: unknown): value is {
  result: unknown;
  dataset: Record<string, unknown>[];
  logs: string[];
  usage: {
    itemCount: number;
    durationMs: number;
    outputHash?: string;
    runnerSignature?: string;
  };
} {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  if (
    response.status !== "SUCCEEDED" ||
    !("result" in response) ||
    !Array.isArray(response.dataset) ||
    !response.dataset.every(
      (item) =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    ) ||
    !Array.isArray(response.logs) ||
    !response.logs.every((item) => typeof item === "string") ||
    !response.usage ||
    typeof response.usage !== "object"
  )
    return false;
  const usage = response.usage as Record<string, unknown>;
  return (
    Number.isSafeInteger(usage.itemCount) &&
    usage.itemCount === response.dataset.length &&
    Number.isSafeInteger(usage.durationMs) &&
    (usage.durationMs as number) >= 0 &&
    typeof usage.outputHash === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(usage.outputHash) &&
    typeof usage.runnerSignature === "string" &&
    /^0x[a-fA-F0-9]+$/u.test(usage.runnerSignature)
  );
}

export async function registerActorPreviewRoutes(
  app: FastifyInstance,
  dependencies: ActorPreviewRouteDependencies,
): Promise<void> {
  app.post("/v1/actors/preview", async (request) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const command = previewSchema.parse(request.body);
    const actor = await dependencies.providers.upsertUser(identity);
    const provider = await dependencies.providers.getProvider(
      command.providerId,
    );
    if (!provider || provider.status !== "active") {
      throw new AppError("RESOURCE_NOT_FOUND", "Provider not found.", 404);
    }
    const role = await dependencies.providers.getMembershipRole(
      command.providerId,
      actor.id,
    );
    requireProviderPermission(role, "facet:write");
    validatePreview(command.code, command.inputSchema, command.input);
    if (!(await dependencies.consumeQuota(actor.id, new Date()))) {
      throw new AppError(
        "PREVIEW_QUOTA_EXCEEDED",
        "Daily Actor preview limit reached.",
        429,
      );
    }
    const execution: PreviewExecutionRequest = {
      runId: randomUUID(),
      facetId: randomUUID(),
      facetVersionId: randomUUID(),
      facetType: "HOSTED_ACTOR",
      input: command.input,
      timeoutMs: 15_000,
      actorBundle: {
        code: command.code,
        imageDigest: computeActorImageDigest(command.code),
      },
    };
    try {
      const output = await dependencies.execute(execution);
      if (
        !validResponse(output) ||
        Buffer.byteLength(JSON.stringify(output), "utf8") > MAX_RESPONSE_BYTES
      )
        throw new Error("Invalid executor output");
      return {
        result: output.result,
        dataset: output.dataset,
        logs: output.logs,
        usage: output.usage,
      };
    } catch {
      throw new AppError(
        "PREVIEW_EXECUTION_FAILED",
        "Actor preview failed in Docker.",
        502,
      );
    }
  });
}
