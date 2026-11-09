import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { AppError } from "./errors.js";
import {
  registerProviderRoutes,
  type ProviderRouteDependencies,
} from "./providers/provider-routes.js";

export interface AppDependencies {
  checkDatabase: () => Promise<void>;
  environment: "local" | "preview" | "production";
  webOrigin: string;
  providerRoutes?: ProviderRouteDependencies;
}

export async function buildApp(
  dependencies: AppDependencies,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: process.env.NODE_ENV !== "test",
    requestIdHeader: "x-request-id",
  });

  await app.register(cors, {
    origin: dependencies.webOrigin,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  app.get("/health/live", async () => ({
    service: "control-api",
    status: "ok" as const,
    environment: dependencies.environment,
    timestamp: new Date().toISOString(),
  }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      await dependencies.checkDatabase();
      return {
        service: "control-api",
        status: "ok" as const,
        environment: dependencies.environment,
        timestamp: new Date().toISOString(),
      };
    } catch {
      return reply.code(503).send({
        service: "control-api",
        status: "degraded" as const,
        environment: dependencies.environment,
        timestamp: new Date().toISOString(),
      });
    }
  });

  if (dependencies.providerRoutes) {
    await registerProviderRoutes(app, dependencies.providerRoutes);
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "INPUT_INVALID",
          message: "The request payload is invalid.",
          requestId: request.id,
          details: {
            issues: error.issues.map((issue) => ({
              path: issue.path.join("/"),
              code: issue.code,
              message: issue.message,
            })),
          },
        },
      });
    }

    request.log.error({ err: error, requestId: request.id }, "request failed");
    void reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
        requestId: request.id,
      },
    });
  });

  return app;
}
