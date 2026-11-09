import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { IdentityAuthenticator } from "../auth/types.js";
import type { ImportService } from "./import-service.js";

const idSchema = z.string().uuid();
const httpsUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => new URL(value).protocol === "https:", {
    message: "OpenAPI URL imports require HTTPS.",
  });
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["paste", "upload"]),
    content: z.string().min(1),
    mediaType: z.string().trim().min(1).max(200).optional(),
  }),
  z.object({ kind: z.literal("url"), url: httpsUrlSchema }),
]);
const createImportSchema = z.object({
  providerId: idSchema,
  name: z.string().trim().min(1).max(160),
  source: sourceSchema,
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
    ...(first(request.headers["x-facet-dev-email"])
      ? { devEmail: first(request.headers["x-facet-dev-email"]) }
      : {}),
    ...(first(request.headers["x-facet-dev-display-name"])
      ? { devDisplayName: first(request.headers["x-facet-dev-display-name"]) }
      : {}),
  });
}

export interface ImportRouteDependencies {
  authenticator: IdentityAuthenticator;
  service: ImportService;
}

export async function registerImportRoutes(
  app: FastifyInstance,
  dependencies: ImportRouteDependencies,
): Promise<void> {
  app.post("/v1/openapi-imports", async (request, reply) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const input = createImportSchema.parse(request.body);
    const job = await dependencies.service.create(identity, input, request.id);
    return reply.code(202).send({ job });
  });

  app.get("/v1/openapi-imports/:jobId", async (request) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const jobId = idSchema.parse((request.params as { jobId?: unknown }).jobId);
    return { job: await dependencies.service.get(identity, jobId) };
  });

  app.get("/v1/openapi-imports/:jobId/operations", async (request) => {
    const identity = await authenticate(request, dependencies.authenticator);
    const jobId = idSchema.parse((request.params as { jobId?: unknown }).jobId);
    return {
      operations: await dependencies.service.listCandidates(identity, jobId),
    };
  });
}
