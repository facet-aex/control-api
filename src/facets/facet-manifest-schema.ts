import {
  FACET_NAME_PATTERN,
  FACET_TYPES,
  PRICING_MODELS,
  SEMVER_PATTERN,
  USERNAME_PATTERN,
} from "../identifiers.js";

export const FACET_MANIFEST_SCHEMA_ID =
  "https://facet.local/schemas/facet-manifest.v1.json";

export const facetManifestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: FACET_MANIFEST_SCHEMA_ID,
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "facetId",
    "versionId",
    "providerId",
    "provider",
    "facetName",
    "facetDisplayName",
    "version",
    "type",
    "summary",
    "description",
    "category",
    "tags",
    "visibility",
    "operation",
    "executionPolicy",
    "upstreamAuth",
    "provenance",
  ],
  properties: {
    schemaVersion: { const: "facet.manifest/v1" },
    facetId: { type: "string", format: "uuid" },
    versionId: { type: "string", format: "uuid" },
    providerId: { type: "string", format: "uuid" },
    provider: {
      type: "string",
      minLength: 8,
      maxLength: 16,
      pattern: USERNAME_PATTERN,
    },
    facetName: {
      type: "string",
      minLength: 4,
      maxLength: 32,
      pattern: FACET_NAME_PATTERN,
    },
    facetDisplayName: { type: "string", minLength: 1, maxLength: 120 },
    version: {
      type: "string",
      pattern: SEMVER_PATTERN,
    },
    type: {
      enum: [...FACET_TYPES],
    },
    summary: { type: "string", maxLength: 280 },
    description: { type: "string", maxLength: 10_000 },
    category: { type: "string", minLength: 1, maxLength: 80 },
    tags: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 40 },
    },
    visibility: { enum: ["PRIVATE", "UNLISTED", "PUBLIC"] },
    operation: {
      type: "object",
      additionalProperties: false,
      required: [
        "operationId",
        "method",
        "publicPathTemplate",
        "inputSchema",
        "outputSchema",
        "errorSchema",
        "sideEffectClass",
      ],
      properties: {
        operationId: { type: "string", minLength: 1 },
        method: {
          enum: [
            "GET",
            "PUT",
            "POST",
            "DELETE",
            "OPTIONS",
            "HEAD",
            "PATCH",
            "TRACE",
          ],
        },
        publicPathTemplate: { type: "string", pattern: "^/" },
        inputSchema: { anyOf: [{ type: "boolean" }, { type: "object" }] },
        outputSchema: { anyOf: [{ type: "boolean" }, { type: "object" }] },
        errorSchema: { anyOf: [{ type: "boolean" }, { type: "object" }] },
        sideEffectClass: {
          enum: [
            "READ_ONLY",
            "IDEMPOTENT_WRITE",
            "NON_IDEMPOTENT_WRITE",
            "UNKNOWN",
          ],
        },
      },
    },
    executionPolicy: {
      type: "object",
      additionalProperties: false,
      required: ["timeoutMs", "maxResponseBytes", "redirectPolicy"],
      properties: {
        timeoutMs: { type: "integer", minimum: 100, maximum: 60_000 },
        maxResponseBytes: {
          type: "integer",
          minimum: 1024,
          maximum: 10_485_760,
        },
        redirectPolicy: { enum: ["DENY", "SAME_ORIGIN"] },
      },
    },
    upstreamAuth: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "configured"],
      properties: {
        kind: {
          enum: [
            "NONE",
            "API_KEY_HEADER",
            "API_KEY_QUERY",
            "BEARER",
            "UNCONFIGURED",
          ],
        },
        configured: { type: "boolean" },
      },
    },
    pricing: {
      type: "object",
      additionalProperties: false,
      required: ["model", "priceAtomic", "assetAddress", "chainId", "payTo"],
      properties: {
        model: { enum: [...PRICING_MODELS] },
        priceAtomic: { type: "string", pattern: "^[0-9]+$" },
        assetAddress: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
        },
        chainId: { const: 43113 },
        payTo: { type: "string", pattern: "^0x[a-fA-F0-9]{40}$" },
      },
    },
    actorConfig: {
      type: "object",
      additionalProperties: false,
      required: ["runtime", "entrypoint", "imageDigest"],
      properties: {
        runtime: { type: "string", minLength: 1 },
        entrypoint: { type: "string", minLength: 1 },
        imageDigest: {
          type: "string",
          pattern: "^sha256:[a-f0-9]{64}$",
        },
      },
    },
    agentConfig: {
      type: "object",
      additionalProperties: false,
      required: [
        "erc8004ChainId",
        "erc8004Registry",
        "erc8004TokenId",
        "a2aProtocolVersion",
        "taskKind",
      ],
      properties: {
        erc8004ChainId: { const: 43113 },
        erc8004Registry: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
        },
        erc8004TokenId: { type: "string", pattern: "^[0-9]+$" },
        a2aProtocolVersion: { type: "string", minLength: 1 },
        taskKind: { type: "string", minLength: 1 },
      },
    },
    provenance: {
      type: "object",
      additionalProperties: false,
      required: ["sourceType", "sourceVersionId", "sourceOperationPointer"],
      properties: {
        sourceType: {
          enum: ["OPENAPI", "ACTOR_TEMPLATE", "A2A_AGENT_CARD"],
        },
        sourceVersionId: { type: "string", format: "uuid" },
        sourceOperationPointer: { type: "string", pattern: "^#/" },
      },
    },
    contentHash: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    publishedAt: { type: "string", format: "date-time" },
  },
} as const;
