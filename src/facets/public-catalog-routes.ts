import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  FACET_NAME_REGEX,
  FACET_TYPES,
  SEMVER_REGEX,
  USERNAME_REGEX,
} from "../identifiers.js";
import type { PublicCatalog } from "./public-catalog.js";

const listQuerySchema = z.object({
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  type: z.enum(FACET_TYPES).optional(),
  category: z.string().trim().min(1).max(80).optional(),
});

const facetParamsSchema = z
  .object({
    provider: z.string().regex(USERNAME_REGEX),
    facetName: z.string().regex(FACET_NAME_REGEX),
  })
  .strict();

const facetVersionParamsSchema = z
  .object({
    provider: z.string().regex(USERNAME_REGEX),
    facetName: z.string().regex(FACET_NAME_REGEX),
    version: z.string().regex(SEMVER_REGEX),
  })
  .strict();

export async function registerPublicCatalogRoutes(
  app: FastifyInstance,
  catalog: PublicCatalog,
): Promise<void> {
  app.get("/v1/catalog/facets", async (request) => {
    const { q, limit, type, category } = listQuerySchema.parse(request.query);
    const filters = {
      ...(type ? { type } : {}),
      ...(category ? { category } : {}),
    };
    return {
      facets: await catalog.list(
        q ?? "",
        limit ?? 20,
        Object.keys(filters).length > 0 ? filters : undefined,
      ),
    };
  });

  app.get("/v1/catalog/facets/:provider/:facetName", async (request, reply) => {
    const parsed = facetParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_FAILED",
          message: "Invalid provider or facetName.",
          requestId: request.id,
        },
      });
    }
    const facet = await catalog.getByName(
      parsed.data.provider,
      parsed.data.facetName,
    );
    if (!facet) {
      return reply.status(404).send({
        error: {
          code: "RESOURCE_NOT_FOUND",
          message: "Facet not found.",
          requestId: request.id,
        },
      });
    }
    return { facet };
  });

  app.get(
    "/v1/catalog/facets/:provider/:facetName/versions/:version",
    async (request, reply) => {
      const parsed = facetVersionParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: "VALIDATION_FAILED",
            message: "Invalid provider, facetName, or version.",
            requestId: request.id,
          },
        });
      }
      const facet = await catalog.getByName(
        parsed.data.provider,
        parsed.data.facetName,
        parsed.data.version,
      );
      if (!facet) {
        return reply.status(404).send({
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "Facet version not found.",
            requestId: request.id,
          },
        });
      }
      return { facet };
    },
  );
}
