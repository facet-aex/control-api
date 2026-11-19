import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { AppError } from "../src/errors.js";
import { FacetValidationService } from "../src/facets/facet-validation-service.js";
import type {
  FacetValidationContext,
  FacetValidationStore,
  StoredFacetValidation,
} from "../src/facets/facet-validation-types.js";
import { ProviderService } from "../src/providers/provider-service.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

function manifest(providerId: string, provider = "alice-labs") {
  const facetId = randomUUID();
  const versionId = randomUUID();
  return {
    schemaVersion: "facet.manifest/v1",
    facetId,
    versionId,
    providerId,
    provider,
    facetName: "weather-now",
    facetDisplayName: "Weather",
    version: "0.1.0",
    type: "API",
    summary: "Weather",
    description: "",
    category: "weather",
    tags: ["weather"],
    visibility: "PRIVATE",
    operation: {
      operationId: "getWeather",
      method: "GET",
      publicPathTemplate: "/weather",
      inputSchema: {
        type: "object",
        properties: { query: { type: "object" } },
      },
      outputSchema: { type: "object" } as Record<string, unknown>,
      errorSchema: {},
      sideEffectClass: "READ_ONLY",
    },
    executionPolicy: {
      timeoutMs: 15_000,
      maxResponseBytes: 1_048_576,
      redirectPolicy: "DENY",
    },
    upstreamAuth: { kind: "NONE", configured: true },
    provenance: {
      sourceType: "OPENAPI",
      sourceVersionId: randomUUID(),
      sourceOperationPointer: "#/paths/~1weather/get",
    },
  };
}

class MemoryFacetValidationStore implements FacetValidationStore {
  readonly contexts = new Map<string, FacetValidationContext>();

  private key(provider: string, facetName: string, version: string) {
    return `${provider}/${facetName}@${version}`;
  }

  seed(
    providerId: string,
    options: {
      provider?: string;
      facetName?: string;
      version?: string;
      endpointConfigured?: boolean;
      warnings?: Array<{ code: string; message: string }>;
    } = {},
  ) {
    const provider = options.provider ?? "alice-labs";
    const value = manifest(providerId, provider);
    if (options.facetName) value.facetName = options.facetName;
    if (options.version) value.version = options.version;
    const id = value.versionId;
    this.contexts.set(this.key(provider, value.facetName, value.version), {
      facetVersionId: id,
      providerId,
      provider,
      facetName: value.facetName,
      version: value.version,
      status: "draft",
      revision: 1,
      manifest: value,
      endpointConfig: options.endpointConfigured
        ? { authKind: "none", secretRefId: null }
        : null,
      warnings: options.warnings ?? [],
      warningAcknowledgements: [],
    });
    return id;
  }

  async getContextByName(provider: string, facetName: string, version: string) {
    return this.contexts.get(this.key(provider, facetName, version));
  }

  async saveValidation(
    input: Parameters<FacetValidationStore["saveValidation"]>[0],
  ) {
    const current = [...this.contexts.values()].find(
      (item) => item.facetVersionId === input.facetVersionId,
    );
    if (!current || current.providerId !== input.providerId) return undefined;
    if (current.revision !== input.expectedRevision) {
      throw new AppError(
        "VERSION_PRECONDITION_FAILED",
        "Version conflict.",
        412,
      );
    }
    const saved: StoredFacetValidation = {
      facetVersionId: current.facetVersionId,
      version: current.version,
      status: input.status,
      revision: current.revision + 1,
      validation: input.validation,
      warningAcknowledgements: input.warningAcknowledgements,
    };
    this.contexts.set(
      this.key(current.provider, current.facetName, current.version),
      {
        ...current,
        status: input.status,
        revision: saved.revision,
        warningAcknowledgements: input.warningAcknowledgements,
      },
    );
    return saved;
  }
}

let app: FastifyInstance;
let providers: InMemoryProviderStore;
let validations: MemoryFacetValidationStore;

beforeEach(async () => {
  providers = new InMemoryProviderStore();
  validations = new MemoryFacetValidationStore();
  const authenticator = new LocalAuthenticator();
  app = await buildApp({
    checkDatabase: async () => undefined,
    environment: "local",
    webOrigin: "http://localhost:3000",
    providerRoutes: {
      authenticator,
      service: new ProviderService(providers, { environment: "local" }),
    },
    facetValidationRoutes: {
      authenticator,
      service: new FacetValidationService(providers, validations),
    },
  });
});

afterEach(async () => app.close());

async function ensureUserId(username = "alice-labs"): Promise<string> {
  const user = await providers.upsertUser({
    subject: `local:${username}`,
    username,
  });
  return user.id;
}

async function validate(
  facetName: string,
  revision: number,
  warningIds: string[] = [],
) {
  return app.inject({
    method: "POST",
    url: `/v1/facets/alice-labs/${facetName}/versions/0.1.0/validate`,
    headers: { "x-facet-dev-user": "alice-labs" },
    payload: {
      revision,
      warningAcknowledgements: warningIds.map((warningId) => ({ warningId })),
    },
  });
}

describe("Facet draft validation (Option B)", () => {
  it("keeps a draft invalid until private endpoint configuration exists", async () => {
    const providerId = await ensureUserId("alice-labs");
    validations.seed(providerId);

    const response = await validate("weather-now", 1);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      facetVersion: {
        version: "0.1.0",
        status: "DRAFT",
        revision: 2,
        validation: {
          status: "INVALID",
          errors: [
            expect.objectContaining({ code: "ENDPOINT_CONFIG_REQUIRED" }),
          ],
        },
      },
    });
    expect(response.body).not.toContain('"id"');
  });

  it("requires exact warning acknowledgement before becoming valid", async () => {
    const providerId = await ensureUserId("alice-labs");
    validations.seed(providerId, {
      endpointConfigured: true,
      warnings: [
        {
          code: "MISSING_SUCCESS_RESPONSE_SCHEMA",
          message: "The operation has no success schema.",
        },
      ],
    });

    const first = await validate("weather-now", 1);
    expect(first.statusCode).toBe(200);
    expect(first.json().facetVersion).toMatchObject({
      status: "DRAFT",
      validation: {
        status: "INVALID",
        errors: [],
        warnings: [
          {
            code: "MISSING_SUCCESS_RESPONSE_SCHEMA",
            acknowledged: false,
          },
        ],
      },
    });
    const warningId = first.json().facetVersion.validation.warnings[0]
      .warningId as string;
    expect(warningId).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const accepted = await validate("weather-now", 2, [warningId]);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().facetVersion).toMatchObject({
      version: "0.1.0",
      status: "VALID",
      revision: 3,
      validation: {
        status: "VALID",
        errors: [],
        warnings: [{ warningId, acknowledged: true }],
      },
      warningAcknowledgements: [{ warningId, acknowledgedBy: "alice-labs" }],
    });
  });

  it("reports invalid candidate schemas safely and rejects unknown acknowledgements", async () => {
    const providerId = await ensureUserId("alice-labs");
    validations.seed(providerId, {
      endpointConfigured: true,
    });
    const context = validations.contexts.get("alice-labs/weather-now@0.1.0")!;
    (context.manifest as ReturnType<typeof manifest>).operation.outputSchema = {
      type: "not-a-json-schema-type",
      secretExample: "must-not-echo",
    };

    const invalid = await validate("weather-now", 1);
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json().facetVersion.validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "OUTPUT_SCHEMA_INVALID" }),
      ]),
    );
    expect(invalid.body).not.toContain("must-not-echo");

    const unknown = await validate("weather-now", 2, [
      `sha256:${"a".repeat(64)}`,
    ]);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: { code: "INPUT_INVALID" } });
  });

  it("denies cross-provider validation", async () => {
    const providerId = await ensureUserId("alice-labs");
    validations.seed(providerId, {
      endpointConfigured: true,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/facets/alice-labs/weather-now/versions/0.1.0/validate",
      headers: { "x-facet-dev-user": "mallory-x" },
      payload: { revision: 1, warningAcknowledgements: [] },
    });
    expect(response.statusCode).toBe(403);
  });
});
