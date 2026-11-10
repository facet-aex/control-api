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

function manifest() {
  const facetId = randomUUID();
  const versionId = randomUUID();
  const providerId: string = randomUUID();
  return {
    schemaVersion: "facet.manifest/v1",
    facetId,
    versionId,
    displayVersion: "0.1.0",
    providerId,
    type: "EXTERNAL_HTTP_API",
    name: "Weather",
    slug: "weather",
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

  seed(
    providerId: string,
    options: {
      endpointConfigured?: boolean;
      warnings?: Array<{ code: string; message: string }>;
    } = {},
  ) {
    const value = manifest();
    value.providerId = providerId;
    const id = value.versionId;
    this.contexts.set(id, {
      facetVersionId: id,
      providerId,
      status: "draft",
      version: 1,
      manifest: value,
      endpointConfig: options.endpointConfigured
        ? { authKind: "none", secretRefId: null }
        : null,
      warnings: options.warnings ?? [],
      warningAcknowledgements: [],
    });
    return id;
  }

  async getContext(facetVersionId: string) {
    return this.contexts.get(facetVersionId);
  }

  async saveValidation(
    input: Parameters<FacetValidationStore["saveValidation"]>[0],
  ) {
    const current = this.contexts.get(input.facetVersionId);
    if (!current || current.providerId !== input.providerId) return undefined;
    if (current.version !== input.expectedVersion) {
      throw new AppError(
        "VERSION_PRECONDITION_FAILED",
        "Version conflict.",
        412,
      );
    }
    const saved: StoredFacetValidation = {
      facetVersionId: current.facetVersionId,
      status: input.status,
      version: current.version + 1,
      validation: input.validation,
      warningAcknowledgements: input.warningAcknowledgements,
    };
    this.contexts.set(current.facetVersionId, {
      ...current,
      status: input.status,
      version: saved.version,
      warningAcknowledgements: input.warningAcknowledgements,
    });
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
      service: new ProviderService(providers),
    },
    facetValidationRoutes: {
      authenticator,
      service: new FacetValidationService(providers, validations),
    },
  });
});

afterEach(async () => app.close());

async function createProvider(user = "alice"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/providers",
    headers: { "x-facet-dev-user": user },
    payload: { slug: `${user}-validation`, name: `${user} Validation` },
  });
  return response.json().provider.id as string;
}

async function validate(
  versionId: string,
  version: number,
  warningIds: string[] = [],
) {
  return app.inject({
    method: "POST",
    url: `/v1/facet-versions/${versionId}/validate`,
    headers: { "x-facet-dev-user": "alice" },
    payload: {
      version,
      warningAcknowledgements: warningIds.map((warningId) => ({ warningId })),
    },
  });
}

describe("Facet draft validation", () => {
  it("keeps a draft invalid until private endpoint configuration exists", async () => {
    const providerId = await createProvider();
    const versionId = validations.seed(providerId);

    const response = await validate(versionId, 1);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      facetVersion: {
        id: versionId,
        status: "DRAFT",
        version: 2,
        validation: {
          status: "INVALID",
          errors: [
            expect.objectContaining({ code: "ENDPOINT_CONFIG_REQUIRED" }),
          ],
        },
      },
    });
  });

  it("requires exact warning acknowledgement before becoming valid", async () => {
    const providerId = await createProvider();
    const versionId = validations.seed(providerId, {
      endpointConfigured: true,
      warnings: [
        {
          code: "MISSING_SUCCESS_RESPONSE_SCHEMA",
          message: "The operation has no success schema.",
        },
      ],
    });

    const first = await validate(versionId, 1);
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

    const accepted = await validate(versionId, 2, [warningId]);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().facetVersion).toMatchObject({
      status: "VALID",
      version: 3,
      validation: {
        status: "VALID",
        errors: [],
        warnings: [{ warningId, acknowledged: true }],
      },
      warningAcknowledgements: [
        { warningId, acknowledgedBy: expect.any(String) },
      ],
    });
  });

  it("reports invalid candidate schemas safely and rejects unknown acknowledgements", async () => {
    const providerId = await createProvider();
    const versionId = validations.seed(providerId, {
      endpointConfigured: true,
    });
    const context = validations.contexts.get(versionId)!;
    (context.manifest as ReturnType<typeof manifest>).operation.outputSchema = {
      type: "not-a-json-schema-type",
      secretExample: "must-not-echo",
    };

    const invalid = await validate(versionId, 1);
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json().facetVersion.validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "OUTPUT_SCHEMA_INVALID" }),
      ]),
    );
    expect(invalid.body).not.toContain("must-not-echo");

    const unknown = await validate(versionId, 2, [`sha256:${"a".repeat(64)}`]);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: { code: "INPUT_INVALID" } });
  });

  it("denies cross-provider validation", async () => {
    const providerId = await createProvider();
    const versionId = validations.seed(providerId, {
      endpointConfigured: true,
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/facet-versions/${versionId}/validate`,
      headers: { "x-facet-dev-user": "mallory" },
      payload: { version: 1, warningAcknowledgements: [] },
    });
    expect(response.statusCode).toBe(403);
  });
});
