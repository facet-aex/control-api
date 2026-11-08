import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

export interface AppDependencies {
  checkDatabase: () => Promise<void>;
  environment: "local" | "preview" | "production";
  webOrigin: string;
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
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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

  app.setErrorHandler((error, request, reply) => {
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
