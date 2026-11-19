import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import {
  registerClerkWebhookRoutes,
  type ClerkWebhookRouteDependencies,
} from "./auth/clerk-webhook.js";
import type { IdentityAuthenticator } from "./auth/types.js";
import { AppError } from "./errors.js";
import {
  registerActorAgentRoutes,
  type ActorAgentRouteDependencies,
} from "./facets/actor-agent-routes.js";
import {
  registerActorPreviewRoutes,
  type ActorPreviewRouteDependencies,
} from "./facets/actor-preview.js";
import {
  registerDemoPayerRoutes,
  type DemoPayerAllowance,
} from "./facets/demo-payer-authorization.js";
import {
  registerEndpointConfigRoutes,
  type EndpointConfigRouteDependencies,
} from "./facets/endpoint-config-routes.js";
import {
  registerFacetDraftRoutes,
  type FacetDraftRouteDependencies,
} from "./facets/facet-draft-routes.js";
import {
  registerFacetPublicationRoutes,
  type FacetPublicationRouteDependencies,
} from "./facets/facet-publication-routes.js";
import {
  registerFacetValidationRoutes,
  type FacetValidationRouteDependencies,
} from "./facets/facet-validation-routes.js";
import { registerPublicCatalogRoutes } from "./facets/public-catalog-routes.js";
import type { PublicCatalog } from "./facets/public-catalog.js";
import {
  registerImportRoutes,
  type ImportRouteDependencies,
} from "./imports/import-routes.js";
import {
  registerProviderRoutes,
  type ProviderRouteDependencies,
} from "./providers/provider-routes.js";
import type { ProviderStore } from "./providers/provider-types.js";
import {
  registerSecretRoutes,
  type SecretRouteDependencies,
} from "./secrets/secret-routes.js";

export interface AppDependencies {
  checkDatabase: () => Promise<void>;
  environment: "local" | "preview" | "production";
  webOrigin: string;
  clerkWebhook?: ClerkWebhookRouteDependencies;
  providerRoutes?: ProviderRouteDependencies;
  actorPreviewRoutes?: ActorPreviewRouteDependencies;
  demoPayerRoutes?: {
    authenticator: IdentityAuthenticator;
    providers: ProviderStore;
    allowance: DemoPayerAllowance;
  };
  importRoutes?: ImportRouteDependencies;
  facetDraftRoutes?: FacetDraftRouteDependencies;
  actorAgentRoutes?: ActorAgentRouteDependencies;
  secretRoutes?: SecretRouteDependencies;
  endpointConfigRoutes?: EndpointConfigRouteDependencies;
  facetValidationRoutes?: FacetValidationRouteDependencies;
  facetPublicationRoutes?: FacetPublicationRouteDependencies;
  publicCatalog?: PublicCatalog;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
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

    if (hasErrorCode(error, "FST_ERR_CTP_BODY_TOO_LARGE")) {
      return reply.code(413).send({
        error: {
          code: "IMPORT_TOO_LARGE",
          message: "The request body exceeds the configured limit.",
          requestId: request.id,
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

  if (dependencies.clerkWebhook) {
    await registerClerkWebhookRoutes(app, dependencies.clerkWebhook);
  }
  if (dependencies.providerRoutes) {
    await registerProviderRoutes(app, dependencies.providerRoutes);
  }
  if (dependencies.actorPreviewRoutes) {
    await registerActorPreviewRoutes(app, dependencies.actorPreviewRoutes);
  }
  if (dependencies.demoPayerRoutes) {
    await registerDemoPayerRoutes(app, dependencies.demoPayerRoutes);
  }
  if (dependencies.importRoutes) {
    await registerImportRoutes(app, dependencies.importRoutes);
  }
  if (dependencies.facetDraftRoutes) {
    await registerFacetDraftRoutes(app, dependencies.facetDraftRoutes);
  }
  if (dependencies.actorAgentRoutes) {
    await registerActorAgentRoutes(app, dependencies.actorAgentRoutes);
  }
  if (dependencies.secretRoutes) {
    await registerSecretRoutes(app, dependencies.secretRoutes);
  }
  if (dependencies.endpointConfigRoutes) {
    await registerEndpointConfigRoutes(app, dependencies.endpointConfigRoutes);
  }
  if (dependencies.facetValidationRoutes) {
    await registerFacetValidationRoutes(
      app,
      dependencies.facetValidationRoutes,
    );
  }
  if (dependencies.facetPublicationRoutes) {
    await registerFacetPublicationRoutes(
      app,
      dependencies.facetPublicationRoutes,
    );
  }
  if (dependencies.publicCatalog) {
    await registerPublicCatalogRoutes(app, dependencies.publicCatalog);
  }

  return app;
}
