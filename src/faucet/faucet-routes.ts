import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { AppError } from "../errors.js";
import type { FaucetService } from "./faucet-service.js";

export interface FaucetRouteDependencies {
  service: FaucetService;
}

const claimBodySchema = z
  .object({
    address: z.string().trim().min(1),
  })
  .strict();

function extractClientIp(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim().length > 0) {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const rightmost = parts.at(-1);
    if (rightmost) return rightmost;
  }
  const realIp = request.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim().length > 0) {
    return realIp.trim();
  }
  return request.ip || "unknown";
}

export async function registerFaucetRoutes(
  app: FastifyInstance,
  dependencies: FaucetRouteDependencies,
): Promise<void> {
  app.get("/v1/faucet/status", async () => {
    return dependencies.service.getStatus();
  });

  app.post("/v1/faucet/claim", async (request) => {
    const parsed = claimBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Request body must contain a valid 0x wallet address.",
        400,
      );
    }
    return dependencies.service.claim(
      parsed.data.address,
      extractClientIp(request),
    );
  });
}
