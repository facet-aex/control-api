import { createHash } from "node:crypto";

import { Ajv2020 } from "ajv/dist/2020.js";

import { facetManifestSchema } from "./facet-manifest-schema.js";
import type {
  FacetValidationContext,
  FacetValidationIssue,
  FacetValidationWarning,
} from "./facet-validation-types.js";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const manifestAjv = new Ajv2020({ allErrors: true, strict: true });
manifestAjv.addFormat(
  "uuid",
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
);
const validateManifest = manifestAjv.compile(facetManifestSchema);

export function warningId(warning: { code: string; message: string }): string {
  return `sha256:${createHash("sha256")
    .update(`${warning.code}\n${warning.message}`, "utf8")
    .digest("hex")}`;
}

function manifestIssues(manifest: unknown): FacetValidationIssue[] {
  if (validateManifest(manifest)) return [];
  return (validateManifest.errors ?? []).map((error) => ({
    code: "MANIFEST_INVALID",
    message: `Manifest validation failed for ${error.keyword}.`,
    ...(error.instancePath ? { path: error.instancePath } : {}),
  }));
}

function schemaIssue(
  schema: unknown,
  code: string,
  path: string,
): FacetValidationIssue | undefined {
  if (typeof schema !== "boolean" && !isObject(schema)) {
    return {
      code,
      message: "The normalized schema is not an object or boolean.",
      path,
    };
  }
  try {
    const ajv = new Ajv2020({
      allErrors: true,
      allowUnionTypes: true,
      strict: true,
      validateFormats: false,
    });
    ajv.compile(schema);
    return undefined;
  } catch {
    return {
      code,
      message: "The normalized schema is not valid JSON Schema 2020-12.",
      path,
    };
  }
}

function endpointIssues(
  context: FacetValidationContext,
): FacetValidationIssue[] {
  if (!context.endpointConfig) {
    return [
      {
        code: "ENDPOINT_CONFIG_REQUIRED",
        message:
          "A protected endpoint configuration is required before publication.",
      },
    ];
  }
  if (!isObject(context.manifest) || !isObject(context.manifest.upstreamAuth)) {
    return [];
  }
  const manifestKind = context.manifest.upstreamAuth.kind;
  const configured = context.manifest.upstreamAuth.configured;
  if (configured !== true || manifestKind === "UNCONFIGURED") {
    return [
      {
        code: "UPSTREAM_AUTH_NOT_CONFIGURED",
        message: "A supported upstream authentication mapping is required.",
      },
    ];
  }
  if (manifestKind !== context.endpointConfig.authKind.toUpperCase()) {
    return [
      {
        code: "ENDPOINT_AUTH_MISMATCH",
        message:
          "The private endpoint auth mapping does not match the manifest.",
      },
    ];
  }
  if (
    context.endpointConfig.authKind !== "none" &&
    !context.endpointConfig.secretRefId
  ) {
    return [
      {
        code: "SECRET_REF_REQUIRED",
        message: "The endpoint auth mapping requires an active SecretRef.",
      },
    ];
  }
  return [];
}

export function validateFacetContext(
  context: FacetValidationContext,
  acknowledgedIds: ReadonlySet<string>,
): {
  errors: FacetValidationIssue[];
  warnings: FacetValidationWarning[];
} {
  const errors = [
    ...manifestIssues(context.manifest),
    ...endpointIssues(context),
  ];
  if (isObject(context.manifest) && isObject(context.manifest.operation)) {
    const schemas = [
      [
        context.manifest.operation.inputSchema,
        "INPUT_SCHEMA_INVALID",
        "/operation/inputSchema",
      ],
      [
        context.manifest.operation.outputSchema,
        "OUTPUT_SCHEMA_INVALID",
        "/operation/outputSchema",
      ],
      [
        context.manifest.operation.errorSchema,
        "ERROR_SCHEMA_INVALID",
        "/operation/errorSchema",
      ],
    ] as const;
    for (const [schema, code, path] of schemas) {
      const issue = schemaIssue(schema, code, path);
      if (issue) errors.push(issue);
    }
  }
  const warnings = context.warnings.map((warning) => {
    const id = warningId(warning);
    return { ...warning, warningId: id, acknowledged: acknowledgedIds.has(id) };
  });
  return { errors, warnings };
}
