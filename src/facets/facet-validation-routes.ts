import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { IdentityAuthenticator } from "../auth/types.js";
import type { FacetValidationService } from "./facet-validation-service.js";

const idSchema = z.string().uuid();
const requestSchema = z
  .object({
    version: z.number().int().positive(),
    warningAcknowledgements: z
      .array(
        z
          .object({
            warningId: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
            reason: z.string().trim().min(1).max(500).optional(),
          })
          .strict(),
      )
      .max(200),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    for (const acknowledgement of value.warningAcknowledgements) {
      if (ids.has(acknowledgement.warningId)) {
        context.addIssue({
          code: "custom",
          path: ["warningAcknowledgements"],
          message: "Warning acknowledgements must be unique.",
        });
      }
      ids.add(acknowledgement.warningId);
    }
  });

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

export interface FacetValidationRouteDependencies {
  authenticator: IdentityAuthenticator;
  service: FacetValidationService;
}

export async function registerFacetValidationRoutes(
  app: FastifyInstance,
  dependencies: FacetValidationRouteDependencies,
): Promise<void> {
  app.post("/v1/facet-versions/:versionId/validate", async (request) => {
    const { versionId } = z
      .object({ versionId: idSchema })
      .parse(request.params);
    const payload = requestSchema.parse(request.body);
    const identity = await authenticate(request, dependencies.authenticator);
    return dependencies.service.validate(
      identity,
      { facetVersionId: versionId, ...payload },
      request.id,
    );
  });
}
