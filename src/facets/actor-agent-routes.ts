import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { IdentityAuthenticator } from "../auth/types.js";
import {
  FACET_NAME_REGEX,
  PRICING_MODELS,
  SEMVER_REGEX,
  USERNAME_REGEX,
} from "../identifiers.js";
import type { ActorAgentService } from "./actor-agent-service.js";

const actorParamsSchema = z
  .object({
    provider: z.string().regex(USERNAME_REGEX),
    facetName: z.string().regex(FACET_NAME_REGEX),
    version: z.string().regex(SEMVER_REGEX),
  })
  .strict();

const createActorBodySchema = z
  .object({
    facetName: z.string().regex(FACET_NAME_REGEX),
    facetDisplayName: z.string().min(1).max(120),
    version: z.string().regex(SEMVER_REGEX).optional(),
    summary: z.string().max(280).optional(),
    description: z.string().min(1).max(10_000),
    category: z.string().min(1).max(80),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    code: z.string().min(1).max(65_536),
    pricingModel: z.enum(PRICING_MODELS).optional(),
    priceAtomic: z
      .string()
      .regex(/^[0-9]+$/u)
      .optional(),
    payTo: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/u)
      .optional(),
    registryTxHash: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/u)
      .optional(),
  })
  .strict();

const createAgentFacetBodySchema = z
  .object({
    facetName: z.string().regex(FACET_NAME_REGEX),
    facetDisplayName: z.string().min(1).max(120),
    version: z.string().regex(SEMVER_REGEX).optional(),
    summary: z.string().max(280).optional(),
    description: z.string().min(1).max(10_000),
    category: z.string().min(1).max(80),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    erc8004TokenId: z.string().regex(/^[0-9]+$/u),
    erc8004Registry: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/u)
      .optional(),
    taskKind: z.string().min(1).max(80),
    pricingModel: z.enum(PRICING_MODELS).optional(),
    priceAtomic: z
      .string()
      .regex(/^[0-9]+$/u)
      .optional(),
    payTo: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/u)
      .optional(),
    registryTxHash: z
      .string()
      .regex(/^0x[a-fA-F0-9]{64}$/u)
      .optional(),
  })
  .strict();

const verifyRegistryBodySchema = z
  .object({
    registryTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/u),
  })
  .strict();

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

export interface ActorAgentRouteDependencies {
  authenticator: IdentityAuthenticator;
  service: ActorAgentService;
}

export async function registerActorAgentRoutes(
  app: FastifyInstance,
  dependencies: ActorAgentRouteDependencies,
): Promise<void> {
  app.get("/v1/actors/mine", async (request) => {
    const identity = await authenticate(request, dependencies.authenticator);
    return dependencies.service.listMyActors(identity);
  });

  app.get("/v1/facets/mine", async (request) => {
    const identity = await authenticate(request, dependencies.authenticator);
    return dependencies.service.listMyFacets(identity);
  });

  app.get(
    "/v1/actors/:provider/:facetName/versions/:version/publish-status",
    async (request) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const { provider, facetName, version } = actorParamsSchema.parse(
        request.params,
      );
      return dependencies.service.getActorPublishStatus(
        identity,
        provider,
        facetName,
        version,
      );
    },
  );

  app.post("/v1/actors", async (request, reply) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const body = createActorBodySchema.parse(request.body);
    const idempotencyHeader = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(idempotencyHeader)
      ? idempotencyHeader[0]
      : idempotencyHeader;
    const outcome = await dependencies.service.publishActor(
      identity,
      body,
      request.id,
      idempotencyKey,
    );
    return reply.status(outcome.statusCode).send(outcome.body);
  });

  app.post("/v1/agent-facets", async (request, reply) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const body = createAgentFacetBodySchema.parse(request.body);
    const result = await dependencies.service.publishAgentFacet(
      identity,
      body,
      request.id,
    );
    return reply.status(201).send(result);
  });

  app.post(
    "/v1/facets/:provider/:facetName/versions/:version/verify-registry",
    async (request) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const { provider, facetName, version } = actorParamsSchema.parse(
        request.params,
      );
      const { registryTxHash } = verifyRegistryBodySchema.parse(request.body);
      return dependencies.service.verifyRegistry(
        identity,
        { provider, facetName, version, registryTxHash },
        request.id,
      );
    },
  );
}
