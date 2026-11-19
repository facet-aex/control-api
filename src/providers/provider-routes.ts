import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { IdentityAuthenticator } from "../auth/types.js";
import { isValidUsername } from "../identifiers.js";
import type { ProviderService } from "./provider-service.js";

const providerParamSchema = z
  .string()
  .refine(
    isValidUsername,
    "Provider username must be 8-16 character lowercase kebab-case.",
  );

const walletAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/u, "Expected an EVM address");

const confirmWalletLinkSchema = z
  .object({
    challengeId: z.string().uuid(),
    address: walletAddressSchema,
    signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/u),
  })
  .strict();

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function authenticate(
  request: FastifyRequest,
  authenticator: IdentityAuthenticator,
) {
  return authenticator.authenticate({
    ...(request.headers.authorization
      ? { authorization: request.headers.authorization }
      : {}),
    ...(firstHeader(request.headers["x-facet-dev-user"])
      ? { devUser: firstHeader(request.headers["x-facet-dev-user"]) }
      : {}),
  });
}

export interface ProviderRouteDependencies {
  authenticator: IdentityAuthenticator;
  service: ProviderService;
}

export async function registerProviderRoutes(
  app: FastifyInstance,
  dependencies: ProviderRouteDependencies,
): Promise<void> {
  app.get("/v1/me", async (request) => {
    const identity = await authenticate(request, dependencies.authenticator);
    return { user: await dependencies.service.getCurrentUser(identity) };
  });

  app.get("/v1/providers/:provider", async (request) => {
    const provider = providerParamSchema.parse(
      (request.params as { provider?: unknown }).provider,
    );
    return { provider: await dependencies.service.getPublic(provider) };
  });

  app.post(
    "/v1/providers/:provider/wallet-link-challenges",
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const provider = providerParamSchema.parse(
        (request.params as { provider?: unknown }).provider,
      );
      const challenge = await dependencies.service.createWalletLinkChallenge(
        identity,
        provider,
      );
      return reply.code(201).send(challenge);
    },
  );

  app.post("/v1/providers/:provider/wallet-link", async (request) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const provider = providerParamSchema.parse(
      (request.params as { provider?: unknown }).provider,
    );
    const body = confirmWalletLinkSchema.parse(request.body);
    return dependencies.service.confirmWalletLink(
      identity,
      provider,
      body.challengeId,
      body.address,
      body.signature as `0x${string}`,
      request.id,
    );
  });
}
