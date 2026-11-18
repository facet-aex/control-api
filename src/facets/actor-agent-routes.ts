import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { IdentityAuthenticator } from "../auth/types.js";
import type { ActorAgentService } from "./actor-agent-service.js";

const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const addressSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{40}$/u);
const txHashSchema = z
  .string()
  .trim()
  .regex(/^0x[a-fA-F0-9]{64}$/u);

const createActorSchema = z
  .object({
    id: z.string().uuid().optional(),
    providerId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    slug: slugSchema,
    displayVersion: z
      .string()
      .regex(/^v?[0-9]+(?:\.[0-9]+\.[0-9]+)?$/u)
      .optional(),
    summary: z.string().trim().max(280).optional(),
    description: z.string().trim().min(1).max(10_000),
    category: z.string().trim().min(1).max(80),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    code: z.string().min(10).max(131_072),
    pricingModel: z.enum(["PAY_PER_RUN", "PAY_PER_RESULT"]).optional(),
    priceAtomic: z
      .string()
      .regex(/^[0-9]+$/u)
      .optional(),
    payTo: addressSchema.optional(),
    registryTxHash: txHashSchema.optional(),
  })
  .strict();

const createAgentFacetSchema = z
  .object({
    id: z.string().uuid().optional(),
    providerId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    slug: slugSchema,
    summary: z.string().trim().max(280).optional(),
    description: z.string().trim().min(1).max(10_000),
    category: z.string().trim().min(1).max(80),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    erc8004TokenId: z.string().regex(/^[0-9]+$/u),
    erc8004Registry: addressSchema.optional(),
    taskKind: z.string().trim().min(1).max(80),
    code: z.string().max(131_072).optional(),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    pricingModel: z.enum(["PAY_PER_RUN", "PAY_PER_RESULT"]).optional(),
    priceAtomic: z
      .string()
      .regex(/^[0-9]+$/u)
      .optional(),
    payTo: addressSchema.optional(),
    registryTxHash: txHashSchema.optional(),
  })
  .strict();

const verifyRegistryParamsSchema = z.object({ facetId: z.string().uuid() });
const verifyRegistryBodySchema = z
  .object({ registryTxHash: txHashSchema })
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
  app.get("/v1/actors/:facetId/publish-status", async (request) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const { facetId } = verifyRegistryParamsSchema.parse(request.params);
    return dependencies.service.getActorPublishStatus(identity, facetId);
  });
  app.post("/v1/actors", async (request, reply) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const input = createActorSchema.parse(request.body);
    const facet = await dependencies.service.publishActor(
      identity,
      input,
      request.id,
      typeof request.headers["idempotency-key"] === "string"
        ? request.headers["idempotency-key"]
        : undefined,
    );
    if (facet.status === "REGISTRATION_PENDING") {
      return reply.code(202).send({
        facet: {
          id: facet.id,
          versionId: facet.versionId,
          slug: facet.slug,
          facetType: facet.facetType,
          status: facet.status,
          visibility: facet.visibility,
          imageDigest: facet.imageDigest,
        },
      });
    }
    return reply.code(201).send({ facet });
  });

  app.post("/v1/agent-facets", async (request, reply) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const input = createAgentFacetSchema.parse(request.body);
    const facet = await dependencies.service.publishAgentFacet(
      identity,
      input,
      request.id,
    );
    return reply.code(201).send({ facet });
  });

  app.post("/v1/facets/:facetId/verify-registry", async (request, reply) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const { facetId } = verifyRegistryParamsSchema.parse(request.params);
    const { registryTxHash } = verifyRegistryBodySchema.parse(request.body);
    const result = await dependencies.service.verifyRegistry(
      identity,
      facetId,
      registryTxHash,
      request.id,
    );
    return reply.code(200).send(result);
  });
}
