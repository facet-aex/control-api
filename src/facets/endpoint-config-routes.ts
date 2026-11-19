import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { IdentityAuthenticator } from "../auth/types.js";
import {
  isValidFacetName,
  isValidSemver,
  isValidUsername,
} from "../identifiers.js";
import type { EndpointConfigService } from "./endpoint-config-service.js";

const idSchema = z.string().uuid();
const paramsSchema = z.object({
  provider: z
    .string()
    .refine(
      isValidUsername,
      "provider must be 8-16 character lowercase kebab-case.",
    ),
  facetName: z
    .string()
    .refine(
      isValidFacetName,
      "facetName must be 4-32 character lowercase kebab-case.",
    ),
  version: z
    .string()
    .refine(isValidSemver, "version must be strict SemVer MAJOR.MINOR.PATCH."),
});

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
    revision: z.number().int().positive(),
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
  const handleConfigure = async (request: FastifyRequest) => {
    const params = paramsSchema.parse(request.params);
    const payload = configSchema.parse(request.body);
    const identity = await authenticate(request, dependencies.authenticator);
    return dependencies.service.configure(
      identity,
      { ...params, ...payload },
      request.id,
    );
  };

  app.put(
    "/v1/facets/:provider/:facetName/versions/:version/endpoint-config",
    handleConfigure,
  );
  app.post(
    "/v1/facets/:provider/:facetName/versions/:version/endpoint-config",
    handleConfigure,
  );
}
