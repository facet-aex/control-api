import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { IdentityAuthenticator } from "../auth/types.js";
import type { SecretService } from "./secret-service.js";

const idSchema = z.string().uuid();
const createSchema = z
  .object({
    kind: z.enum(["API_KEY", "BEARER_TOKEN"]),
    label: z.string().trim().min(1).max(120),
    value: z.string().min(1).max(16_384),
  })
  .strict();
const rotateSchema = z
  .object({ value: z.string().min(1).max(16_384) })
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

export interface SecretRouteDependencies {
  authenticator: IdentityAuthenticator;
  service: SecretService;
}

export async function registerSecretRoutes(
  app: FastifyInstance,
  dependencies: SecretRouteDependencies,
): Promise<void> {
  app.post("/v1/providers/:providerId/secrets", async (request, reply) => {
    const { providerId } = z
      .object({ providerId: idSchema })
      .parse(request.params);
    const payload = createSchema.parse(request.body);
    const identity = await authenticate(request, dependencies.authenticator);
    const result = await dependencies.service.create(
      identity,
      { providerId, ...payload },
      request.id,
    );
    return reply.code(201).send(result);
  });

  app.post(
    "/v1/providers/:providerId/secrets/:secretId/rotate",
    async (request) => {
      const { providerId, secretId } = z
        .object({ providerId: idSchema, secretId: idSchema })
        .parse(request.params);
      const payload = rotateSchema.parse(request.body);
      const identity = await authenticate(request, dependencies.authenticator);
      return dependencies.service.rotate(
        identity,
        { providerId, secretId, value: payload.value },
        request.id,
      );
    },
  );

  app.delete(
    "/v1/providers/:providerId/secrets/:secretId",
    async (request, reply) => {
      const { providerId, secretId } = z
        .object({ providerId: idSchema, secretId: idSchema })
        .parse(request.params);
      const identity = await authenticate(request, dependencies.authenticator);
      await dependencies.service.revoke(
        identity,
        { providerId, secretId },
        request.id,
      );
      return reply.code(204).send();
    },
  );
}
