import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PublicCatalog } from "./public-catalog.js";

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const idParams = z.object({ facetId: z.string().uuid() });

export async function registerPublicCatalogRoutes(
  app: FastifyInstance,
  catalog: PublicCatalog,
): Promise<void> {
  app.get("/v1/catalog/facets", async (request) => {
    const { q, limit } = listQuery.parse(request.query);
    return { facets: await catalog.list(q ?? "", limit) };
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
}
