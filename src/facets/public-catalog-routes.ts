import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PublicCatalog } from "./public-catalog.js";

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  type: z
    .enum(["EXTERNAL_HTTP_API", "HOSTED_ACTOR", "AUTONOMOUS_AGENT"])
    .optional(),
  category: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const idParams = z.object({ facetId: z.string().uuid() });
const nameParams = z.object({
  username: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  facetName: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
});

export async function registerPublicCatalogRoutes(
  app: FastifyInstance,
  catalog: PublicCatalog,
): Promise<void> {
  app.get("/v1/catalog/facets", async (request) => {
    const { q, type, category, limit } = listQuery.parse(request.query);
    const filters =
      type !== undefined || category !== undefined
        ? { type, category }
        : undefined;
    return {
      facets: await catalog.list(q ?? "", limit, filters),
    };
  });
  app.get("/v1/catalog/facets/:facetId", async (request, reply) => {
    const { facetId } = idParams.parse(request.params);
    const facet = await catalog.get(facetId);
    return facet
      ? { facet }
      : reply.code(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Facet not found.",
            requestId: request.id,
          },
        });
  });
  app.get("/v1/catalog/facets/:username/:facetName", async (request, reply) => {
    const { username, facetName } = nameParams.parse(request.params);
    const facet = await catalog.getByName(username, facetName);
    return facet
      ? { facet }
      : reply.code(404).send({
          error: {
            code: "NOT_FOUND",
            message: "Facet not found.",
            requestId: request.id,
          },
        });
  });
}
