import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { IdentityAuthenticator } from "../auth/types.js";
import type { FacetPublicationService } from "./facet-publication-service.js";

const idSchema = z.string().uuid();
const publishSchema = z
  .object({
    version: z.number().int().positive(),
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
  app.post("/v1/facet-versions/:versionId/publish", async (request) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const { versionId } = z
      .object({ versionId: idSchema })
      .parse(request.params);
    const input = publishSchema.parse(request.body);
    return dependencies.service.publish(
      identity,
      {
        facetVersionId: versionId,
        version: input.version,
        visibility: input.visibility.toLowerCase() as "public" | "unlisted",
      },
      request.id,
    );
  });
}
