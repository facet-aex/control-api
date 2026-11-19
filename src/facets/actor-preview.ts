import { randomUUID } from "node:crypto";

import { Ajv } from "ajv";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { IdentityAuthenticator } from "../auth/types.js";
import type { Database } from "../db/client.js";
import { actorPreviewUsage } from "../db/schema.js";
import { AppError } from "../errors.js";
import type { ProviderStore } from "../providers/provider-types.js";
import {
  computeActorImageDigest,
  validateActorCode,
  validateInputSchema,
} from "./actor-agent-service.js";

const ajv = new Ajv({ allErrors: true });
const MAX_PREVIEW_REQUEST_BYTES = 16_384;
const MAX_PREVIEW_OUTPUT_BYTES = 65_536;
const DAILY_PREVIEW_QUOTA = 20;

const previewSchema = z
  .object({
    code: z.string().min(1).max(16_384),
    inputSchema: z.record(z.string(), z.unknown()),
    input: z.record(z.string(), z.unknown()),
  })
  .strict();

export interface PreviewExecutionRequest {
  runId: string;
  facetId: string;
  facetType: "ACTOR";
  input: Record<string, unknown>;
  timeoutMs: number;
  actorBundle: {
    code: string;
    entrypoint: "run";
    imageDigest: string;
  };
}

export interface PreviewExecutionResponse {
  status: string;
  result?: unknown;
  dataset?: unknown[];
  logs?: string[];
  usage?: {
    itemCount?: number;
    durationMs?: number;
    outputHash?: string;
    runnerSignature?: string;
  };
}

export interface ActorPreviewRouteDependencies {
  authenticator: IdentityAuthenticator;
  providers: ProviderStore;
  consumeQuota: (userId: string, now: Date) => Promise<boolean>;
  execute: (
    request: PreviewExecutionRequest,
  ) => Promise<PreviewExecutionResponse>;
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
    ...(first(request.headers["x-facet-dev-username"])
      ? { devUsername: first(request.headers["x-facet-dev-username"]) }
      : {}),
    ...(first(request.headers["x-facet-dev-email"])
      ? { devEmail: first(request.headers["x-facet-dev-email"]) }
      : {}),
    ...(first(request.headers["x-facet-dev-display-name"])
      ? { devDisplayName: first(request.headers["x-facet-dev-display-name"]) }
      : {}),
  });
}

export class PostgresActorPreviewQuota {
  constructor(private readonly db: Database["db"]) {}

  async consume(userId: string, now: Date): Promise<boolean> {
    const dayUtc = now.toISOString().slice(0, 10);
    return this.db.transaction(async (transaction) => {
      await transaction
        .insert(actorPreviewUsage)
        .values({
          userId,
          dayUtc,
          count: 0,
        })
        .onConflictDoNothing();

      const updated = await transaction
        .update(actorPreviewUsage)
        .set({
          count: sql`${actorPreviewUsage.count} + 1`,
        })
        .where(
          and(
            eq(actorPreviewUsage.userId, userId),
            eq(actorPreviewUsage.dayUtc, dayUtc),
            sql`${actorPreviewUsage.count} < ${DAILY_PREVIEW_QUOTA}`,
          ),
        )
        .returning({ count: actorPreviewUsage.count });

      return updated.length > 0;
    });
  }
}

export async function registerActorPreviewRoutes(
  app: FastifyInstance,
  dependencies: ActorPreviewRouteDependencies,
): Promise<void> {
  app.post("/v1/actors/preview", async (request) => {
    const payloadBytes = Buffer.byteLength(
      JSON.stringify(request.body ?? {}),
      "utf8",
    );
    if (payloadBytes > MAX_PREVIEW_REQUEST_BYTES) {
      throw new AppError(
        "PAYLOAD_TOO_LARGE",
        "Actor preview request exceeds maximum allowed size.",
        413,
      );
    }

    const identity = await authenticate(request, dependencies.authenticator);
    const actor = await dependencies.providers.upsertUser(identity);
    if (actor.status !== "active") {
      throw new AppError("FORBIDDEN", "User account is disabled.", 403);
    }

    const body = previewSchema.parse(request.body);
    validateInputSchema(body.inputSchema);
    validateActorCode(body.code);

    let validate: ReturnType<typeof ajv.compile>;
    try {
      validate = ajv.compile(body.inputSchema);
    } catch {
      throw new AppError(
        "VALIDATION_FAILED",
        "Invalid Actor inputSchema.",
        400,
      );
    }
    if (!validate(body.input)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Actor input failed inputSchema validation.",
        400,
      );
    }

    const allowed = await dependencies.consumeQuota(actor.id, new Date());
    if (!allowed) {
      throw new AppError(
        "RATE_LIMIT_EXCEEDED",
        "Daily Actor preview quota exceeded.",
        429,
      );
    }

    const imageDigest = computeActorImageDigest(body.code);
    let outcome: PreviewExecutionResponse;
    try {
      outcome = await dependencies.execute({
        runId: randomUUID(),
        facetId: randomUUID(),
        facetType: "ACTOR",
        input: body.input,
        timeoutMs: 15_000,
        actorBundle: {
          code: body.code,
          entrypoint: "run",
          imageDigest,
        },
      });
    } catch (error) {
      if (error instanceof AppError && error.statusCode < 500) {
        throw error;
      }
      throw new AppError("UPSTREAM_ERROR", "Actor preview failed.", 502);
    }

    if (outcome.status !== "SUCCEEDED") {
      throw new AppError("UPSTREAM_ERROR", "Actor preview failed.", 502);
    }
    if (
      Buffer.byteLength(JSON.stringify(outcome), "utf8") >
      MAX_PREVIEW_OUTPUT_BYTES
    ) {
      throw new AppError(
        "UPSTREAM_ERROR",
        "Actor preview output too large.",
        502,
      );
    }

    return outcome;
  });
}
