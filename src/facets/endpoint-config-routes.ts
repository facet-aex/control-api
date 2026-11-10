import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { IdentityAuthenticator } from "../auth/types.js";
import type { EndpointConfigService } from "./endpoint-config-service.js";

const idSchema = z.string().uuid();
const authSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("NONE") }).strict(),
  z.object({ kind: z.literal("BEARER"), secretRefId: idSchema }).strict(),
  z
    .object({
      kind: z.enum(["API_KEY_HEADER", "API_KEY_QUERY"]),
      secretRefId: idSchema,
      parameterName: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .regex(/^[A-Za-z0-9._~-]+$/u),
    })
    .strict(),
]);
const configSchema = z
  .object({
    version: z.number().int().positive(),
    baseUrl: z.string().url().max(2048),
    auth: authSchema,
    timeoutMs: z.number().int().min(100).max(60_000),
    maxResponseBytes: z.number().int().min(1024).max(10_485_760),
    redirectPolicy: z.enum(["DENY", "SAME_ORIGIN"]),
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
  });
}

export interface EndpointConfigRouteDependencies {
  authenticator: IdentityAuthenticator;
  service: EndpointConfigService;
}

export async function registerEndpointConfigRoutes(
  app: FastifyInstance,
  dependencies: EndpointConfigRouteDependencies,
): Promise<void> {
  app.put("/v1/facet-versions/:versionId/endpoint-config", async (request) => {
    const { versionId } = z
      .object({ versionId: idSchema })
      .parse(request.params);
    const payload = configSchema.parse(request.body);
    const identity = await authenticate(request, dependencies.authenticator);
    return dependencies.service.configure(
      identity,
      { facetVersionId: versionId, ...payload },
      request.id,
    );
  });
}
