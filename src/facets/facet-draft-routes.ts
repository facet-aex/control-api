import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { IdentityAuthenticator } from "../auth/types.js";
import type { FacetDraftService } from "./facet-draft-service.js";

const idSchema = z.string().uuid();
const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const selectionSchema = z
  .object({
    operationCandidateId: idSchema,
    slug: slugSchema,
    name: z.string().trim().min(1).max(120),
    summary: z.string().trim().max(280).optional(),
    description: z.string().trim().max(10_000).optional(),
    category: z.string().trim().min(1).max(80),
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
    sideEffectClass: z.enum([
      "READ_ONLY",
      "IDEMPOTENT_WRITE",
      "NON_IDEMPOTENT_WRITE",
      "UNKNOWN",
    ]),
  })
  .strict();
const createFacetDraftsSchema = z
  .object({
    providerId: idSchema,
    importJobId: idSchema,
    selections: z.array(selectionSchema).min(1).max(200),
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
    ...(first(request.headers["x-facet-dev-email"])
      ? { devEmail: first(request.headers["x-facet-dev-email"]) }
      : {}),
    ...(first(request.headers["x-facet-dev-display-name"])
      ? { devDisplayName: first(request.headers["x-facet-dev-display-name"]) }
      : {}),
  });
}

export interface FacetDraftRouteDependencies {
  authenticator: IdentityAuthenticator;
  service: FacetDraftService;
}

export async function registerFacetDraftRoutes(
  app: FastifyInstance,
  dependencies: FacetDraftRouteDependencies,
): Promise<void> {
  app.post("/v1/facets", async (request, reply) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const input = createFacetDraftsSchema.parse(request.body);
    const facets = await dependencies.service.create(
      identity,
      input,
      request.id,
    );
    return reply.code(201).send({ facets });
  });
}
