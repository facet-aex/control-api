import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { IdentityAuthenticator } from "../auth/types.js";
import {
  FACET_NAME_REGEX,
  SEMVER_REGEX,
  USERNAME_REGEX,
} from "../identifiers.js";
import type { FacetPublicationService } from "./facet-publication-service.js";

const paramsSchema = z
  .object({
    provider: z.string().regex(USERNAME_REGEX),
    facetName: z.string().regex(FACET_NAME_REGEX),
    version: z.string().regex(SEMVER_REGEX),
  })
  .strict();

const publishSchema = z
  .object({
    revision: z.number().int().positive(),
    visibility: z.enum(["UNLISTED", "PUBLIC"]),
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

export interface FacetPublicationRouteDependencies {
  authenticator: IdentityAuthenticator;
  service: FacetPublicationService;
}

export async function registerFacetPublicationRoutes(
  app: FastifyInstance,
  dependencies: FacetPublicationRouteDependencies,
): Promise<void> {
  app.post(
    "/v1/facets/:provider/:facetName/versions/:version/publish",
    async (request) => {
      const identity = await authenticate(request, dependencies.authenticator);
      const { provider, facetName, version } = paramsSchema.parse(
        request.params,
      );
      const input = publishSchema.parse(request.body);
      return dependencies.service.publish(
        identity,
        {
          provider,
          facetName,
          version,
          revision: input.revision,
          visibility: input.visibility.toLowerCase() as "public" | "unlisted",
        },
        request.id,
      );
    },
  );
}
