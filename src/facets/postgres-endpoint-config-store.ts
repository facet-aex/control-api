import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import {
  auditEvents,
  endpointConfigs,
  facetVersions,
  facets,
  secretRefs,
  users,
} from "../db/schema.js";
import { AppError } from "../errors.js";
import type {
  EndpointAuthKind,
  EndpointConfigRecord,
  EndpointConfigStore,
  FacetVersionEndpointContext,
} from "./endpoint-config-types.js";
import { hashFacetManifest } from "./facet-manifest.js";

type Db = Database["db"];
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOperation(manifest: unknown): { method: string; path: string } {
  if (!isObject(manifest) || !isObject(manifest.operation)) {
    throw new AppError(
      "RESOURCE_CONFLICT",
      "The Facet Version manifest has no operation configuration.",
      409,
    );
  }
  const method = manifest.operation.method;
  const path = manifest.operation.publicPathTemplate;
  if (typeof method !== "string" || typeof path !== "string") {
    throw new AppError(
      "RESOURCE_CONFLICT",
      "The Facet Version operation is invalid.",
      409,
    );
  }
  return { method, path };
}

function publicAuthKind(kind: EndpointAuthKind): string {
  return kind.toUpperCase();
}

function configuredManifest(
  manifest: unknown,
  input: Parameters<EndpointConfigStore["configure"]>[0],
): JsonObject {
  if (!isObject(manifest)) {
    throw new AppError(
      "RESOURCE_CONFLICT",
      "The Facet Version manifest is invalid.",
      409,
    );
  }
  return {
    ...manifest,
    executionPolicy: {
      timeoutMs: input.timeoutMs,
      maxResponseBytes: input.maxResponseBytes,
      redirectPolicy: input.redirectPolicy.toUpperCase(),
    },
    upstreamAuth: {
      kind: publicAuthKind(input.authKind),
      configured: true,
    },
  };
}

export class PostgresEndpointConfigStore implements EndpointConfigStore {
  constructor(private readonly db: Db) {}

  async getContextByName(
    provider: string,
    facetName: string,
    version: string,
  ): Promise<FacetVersionEndpointContext | undefined> {
    const row = (
      await this.db
        .select({
          id: facetVersions.id,
          providerId: facets.providerId,
          provider: users.username,
          facetName: facets.facetName,
          version: facetVersions.version,
          status: facetVersions.status,
          revision: facetVersions.revision,
          manifest: facetVersions.manifest,
        })
        .from(facetVersions)
        .innerJoin(facets, eq(facets.id, facetVersions.facetId))
        .innerJoin(users, eq(users.id, facets.providerId))
        .where(
          and(
            eq(users.username, provider),
            eq(facets.facetName, facetName),
            eq(facetVersions.version, version),
          ),
        )
        .limit(1)
    )[0];
    if (!row) return undefined;
    const operation = readOperation(row.manifest);
    return {
      facetVersionId: row.id,
      providerId: row.providerId,
      provider: row.provider,
      facetName: row.facetName,
      version: row.version,
      status: row.status,
      revision: row.revision,
      method: operation.method,
      pathTemplate: operation.path,
    };
  }

  async configure(input: Parameters<EndpointConfigStore["configure"]>[0]) {
    return this.db.transaction(async (transaction) => {
      const current = (
        await transaction.execute<{
          id: string;
          facet_id: string;
          provider_id: string;
          provider: string;
          facet_name: string;
          version: string;
          status: "draft" | "valid" | "published" | "disabled";
          revision: number;
          endpoint_config_id: string | null;
          manifest: unknown;
        }>(sql`
          select fv.id, fv.facet_id, f.provider_id, u.username as provider,
                 f.facet_name, fv.version, fv.status,
                 fv.revision, fv.endpoint_config_id, fv.manifest
          from ${facetVersions} fv
          join ${facets} f on f.id = fv.facet_id
          join ${users} u on u.id = f.provider_id
          where fv.id = ${input.facetVersionId}::uuid
            and f.provider_id = ${input.providerId}::uuid
          for update of fv
        `)
      ).rows[0];
      if (!current) return undefined;
      if (current.status !== "draft") {
        throw new AppError(
          "RESOURCE_CONFLICT",
          "Only a draft Facet Version can be configured.",
          409,
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw new AppError(
          "VERSION_PRECONDITION_FAILED",
          "The Facet Version changed; reload it before retrying.",
          412,
        );
      }

      if (input.authKind === "none") {
        if (input.secretRefId !== null) {
          throw new AppError(
            "INPUT_INVALID",
            "No-auth endpoint configuration cannot reference a secret.",
            400,
          );
        }
      } else {
        if (!input.secretRefId) {
          throw new AppError(
            "INPUT_INVALID",
            "Authenticated endpoint configuration requires a secret reference.",
            400,
          );
        }
        const secret = (
          await transaction
            .select({ kind: secretRefs.kind, status: secretRefs.status })
            .from(secretRefs)
            .where(
              and(
                eq(secretRefs.id, input.secretRefId),
                eq(secretRefs.providerId, input.providerId),
              ),
            )
            .limit(1)
        )[0];
        if (!secret || secret.status !== "active") {
          throw new AppError("RESOURCE_NOT_FOUND", "Secret not found.", 404);
        }
        const expectedKind =
          input.authKind === "bearer" ? "bearer_token" : "api_key";
        if (secret.kind !== expectedKind) {
          throw new AppError(
            "RESOURCE_CONFLICT",
            "The secret kind does not match the endpoint auth template.",
            409,
          );
        }
      }

      const operation = readOperation(current.manifest);
      const values = {
        providerId: input.providerId,
        protectedBaseUrl: input.baseUrl,
        method: operation.method,
        pathTemplate: operation.path,
        authKind: input.authKind,
        authTemplate: input.authTemplate,
        secretRefId: input.secretRefId,
        timeoutMs: input.timeoutMs,
        maxResponseBytes: input.maxResponseBytes,
        redirectPolicy: input.redirectPolicy,
        egressPolicyId: input.egressPolicyId,
        updatedAt: new Date(),
      };
      const endpoint = current.endpoint_config_id
        ? (
            await transaction
              .update(endpointConfigs)
              .set({
                ...values,
                revision: sql`${endpointConfigs.revision} + 1`,
              })
              .where(
                and(
                  eq(endpointConfigs.id, current.endpoint_config_id),
                  eq(endpointConfigs.providerId, input.providerId),
                ),
              )
              .returning()
          )[0]
        : (
            await transaction.insert(endpointConfigs).values(values).returning()
          )[0];
      if (!endpoint) {
        throw new AppError(
          "RESOURCE_CONFLICT",
          "The endpoint configuration could not be updated.",
          409,
        );
      }

      const manifest = configuredManifest(current.manifest, input);
      const updatedVersion = (
        await transaction
          .update(facetVersions)
          .set({
            endpointConfigId: endpoint.id,
            manifest,
            contentHash: hashFacetManifest(manifest),
            revision: sql`${facetVersions.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(facetVersions.id, input.facetVersionId),
              eq(facetVersions.revision, input.expectedRevision),
            ),
          )
          .returning({ revision: facetVersions.revision })
      )[0];
      if (!updatedVersion) {
        throw new AppError(
          "VERSION_PRECONDITION_FAILED",
          "The Facet Version changed; reload it before retrying.",
          412,
        );
      }
      await transaction.insert(auditEvents).values({
        actorUserId: input.actorUserId,
        providerId: input.providerId,
        eventType: "facet.endpoint_configured",
        subjectType: "facet_version",
        subjectId: input.facetVersionId,
        requestId: input.requestId,
        metadata: {
          endpointConfigId: endpoint.id,
          authKind: input.authKind,
          secretConfigured: input.secretRefId !== null,
          endpointConfigRevision: endpoint.revision,
        },
      });

      return {
        provider: current.provider,
        facetName: current.facet_name,
        version: current.version,
        facetVersionRevision: updatedVersion.revision,
        providerId: endpoint.providerId,
        protectedBaseUrl: endpoint.protectedBaseUrl,
        method: endpoint.method,
        pathTemplate: endpoint.pathTemplate,
        authKind: endpoint.authKind,
        authTemplate: endpoint.authTemplate as Record<string, unknown>,
        secretRefId: endpoint.secretRefId,
        timeoutMs: endpoint.timeoutMs,
        maxResponseBytes: endpoint.maxResponseBytes,
        redirectPolicy: endpoint.redirectPolicy,
        revision: endpoint.revision,
        createdAt: endpoint.createdAt,
        updatedAt: endpoint.updatedAt,
      } satisfies EndpointConfigRecord;
    });
  }
}
