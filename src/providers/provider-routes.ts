import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { IdentityAuthenticator } from "../auth/types.js";
import type { ProviderService } from "./provider-service.js";
import { PROVIDER_ROLES } from "./provider-types.js";

const providerIdSchema = z.string().uuid();
const userIdSchema = z.string().uuid();
const optionalUrl = z.union([z.string().url().max(2_048), z.literal("")]);
const optionalWallet = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/u, "Expected an EVM address");

const createProviderSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "Use lowercase kebab-case"),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).default(""),
  websiteUrl: optionalUrl.optional(),
  contact: z.string().trim().max(320).optional(),
  walletAddress: optionalWallet.optional(),
});

const updateProviderSchema = z
  .object({
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2_000).optional(),
    websiteUrl: optionalUrl.nullable().optional(),
    contact: z.string().trim().max(320).nullable().optional(),
    walletAddress: optionalWallet.nullable().optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== "version"),
    "At least one provider field must be supplied.",
  );

const updateMembershipSchema = z.object({
  role: z.enum(PROVIDER_ROLES),
});
const confirmWalletLinkSchema = z.object({
  challengeId: z.string().uuid(),
  address: optionalWallet,
  signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/u),
});

function routeIds(params: unknown): { providerId: string; userId: string } {
  const values = params as { providerId?: unknown; userId?: unknown };
  return {
    providerId: providerIdSchema.parse(values.providerId),
    userId: userIdSchema.parse(values.userId),
  };
}

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
    ...(firstHeader(request.headers["x-facet-dev-email"])
      ? { devEmail: firstHeader(request.headers["x-facet-dev-email"]) }
      : {}),
    ...(firstHeader(request.headers["x-facet-dev-display-name"])
      ? {
          devDisplayName: firstHeader(
            request.headers["x-facet-dev-display-name"],
          ),
        }
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

  app.post("/v1/providers", async (request, reply) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const provider = await dependencies.service.create(
      identity,
      createProviderSchema.parse(request.body),
      request.id,
    );
    return reply
      .code(201)
      .header("etag", `"${provider.version}"`)
      .send({ provider });
  });

  app.get("/v1/providers/:providerId", async (request, reply) => {
    const providerId = providerIdSchema.parse(
      (request.params as { providerId?: unknown }).providerId,
    );
    const provider = await dependencies.service.getPublic(providerId);
    return reply.header("etag", `"${provider.version}"`).send({ provider });
  });

  app.get("/v1/me/providers", async (request) => {
    const identity = await authenticate(request, dependencies.authenticator);
    return { memberships: await dependencies.service.listMine(identity) };
  });

  app.post(
    "/v1/providers/:providerId/wallet-link-challenges",
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const providerId = providerIdSchema.parse(
        (request.params as { providerId?: unknown }).providerId,
      );
      const challenge = await dependencies.service.createWalletLinkChallenge(
        identity,
        providerId,
      );
      return reply.code(201).send(challenge);
    },
  );

  app.post("/v1/providers/:providerId/wallet-link", async (request) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const providerId = providerIdSchema.parse(
      (request.params as { providerId?: unknown }).providerId,
    );
    const body = confirmWalletLinkSchema.parse(request.body);
    return dependencies.service.confirmWalletLink(
      identity,
      providerId,
      body.challengeId,
      body.address,
      body.signature as `0x${string}`,
      request.id,
    );
  });

  app.get("/v1/providers/:providerId/members", async (request) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const providerId = providerIdSchema.parse(
      (request.params as { providerId?: unknown }).providerId,
    );
    return {
      memberships: await dependencies.service.listMembers(identity, providerId),
    };
  });

  app.put("/v1/providers/:providerId/members/:userId", async (request) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const { providerId, userId } = routeIds(request.params);
    const { role } = updateMembershipSchema.parse(request.body);
    return {
      membership: await dependencies.service.setMember(
        identity,
        providerId,
        userId,
        role,
        request.id,
      ),
    };
  });

  app.delete(
    "/v1/providers/:providerId/members/:userId",
    async (request, reply) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const { providerId, userId } = routeIds(request.params);
      await dependencies.service.removeMember(
        identity,
        providerId,
        userId,
        request.id,
      );
      return reply.code(204).send();
    },
  );

  app.patch("/v1/providers/:providerId", async (request, reply) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const providerId = providerIdSchema.parse(
      (request.params as { providerId?: unknown }).providerId,
    );
    const provider = await dependencies.service.update(
      identity,
      providerId,
      updateProviderSchema.parse(request.body),
      request.id,
    );
    return reply.header("etag", `"${provider.version}"`).send({ provider });
  });
}
