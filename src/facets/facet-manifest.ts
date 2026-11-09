import { createHash } from "node:crypto";

import type { FacetDraftSelection } from "./facet-draft-types.js";

export interface StoredOperationCandidate {
  candidateId: string;
  jsonPointer: string;
  method: string;
  path: string;
  operationId?: string | undefined;
  summary?: string | undefined;
  tags: string[];
  normalized: {
    inputSchema: boolean | Record<string, unknown>;
    outputSchema: boolean | Record<string, unknown>;
    errorSchema: boolean | Record<string, unknown>;
    servers: Array<{
      url: string;
      description?: string | undefined;
      variables: Record<string, string>;
    }>;
    authAlternatives: Array<{
      schemes: Array<{
        schemeName: string;
        kind: "API_KEY_HEADER" | "API_KEY_QUERY" | "BEARER" | "UNSUPPORTED";
        parameterName?: string | undefined;
        sourceType?: string | undefined;
      }>;
    }>;
    responseMetadata: {
      successStatusCode?: string | undefined;
      successMediaType?: string | undefined;
      errorStatusCodes: string[];
    };
  };
  warnings: Array<{ code: string; message: string }>;
}

interface BuildFacetDraftManifestInput {
  facetId: string;
  versionId: string;
  providerId: string;
  sourceVersionId: string;
  displayVersion: string;
  sourceOperationPointer: string;
  selection: FacetDraftSelection;
  candidate: StoredOperationCandidate;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function toUpstreamAuth(candidate: StoredOperationCandidate) {
  const alternatives = candidate.normalized.authAlternatives;
  if (
    alternatives.length === 0 ||
    alternatives.some((alternative) => alternative.schemes.length === 0)
  ) {
    return { kind: "NONE" as const, configured: true };
  }
  if (alternatives.length === 1 && alternatives[0]?.schemes.length === 1) {
    const scheme = alternatives[0].schemes[0];
    if (scheme && scheme.kind !== "UNSUPPORTED") {
      return { kind: scheme.kind, configured: false };
    }
  }
  return { kind: "UNCONFIGURED" as const, configured: false };
}

export function buildFacetDraftManifest(input: BuildFacetDraftManifestInput) {
  const manifest = {
    schemaVersion: "facet.manifest/v1" as const,
    facetId: input.facetId,
    versionId: input.versionId,
    displayVersion: input.displayVersion,
    providerId: input.providerId,
    type: "EXTERNAL_HTTP_API" as const,
    name: input.selection.name,
    slug: input.selection.slug,
    summary:
      input.selection.summary ??
      input.candidate.summary ??
      input.selection.name,
    description: input.selection.description ?? "",
    category: input.selection.category,
    tags: [...new Set(input.selection.tags)].sort(),
    visibility: "PRIVATE" as const,
    operation: {
      operationId: input.candidate.operationId ?? input.candidate.candidateId,
      method: input.candidate.method,
      publicPathTemplate: input.candidate.path,
      inputSchema: input.candidate.normalized.inputSchema,
      outputSchema: input.candidate.normalized.outputSchema,
      errorSchema: input.candidate.normalized.errorSchema,
      sideEffectClass: input.selection.sideEffectClass,
    },
    executionPolicy: {
      timeoutMs: 15_000,
      maxResponseBytes: 1_048_576,
      redirectPolicy: "DENY" as const,
    },
    upstreamAuth: toUpstreamAuth(input.candidate),
    provenance: {
      sourceType: "OPENAPI" as const,
      sourceVersionId: input.sourceVersionId,
      sourceOperationPointer: input.sourceOperationPointer,
    },
  };
  const serialized = JSON.stringify(canonicalize(manifest));
  const contentHash = `sha256:${createHash("sha256")
    .update(serialized)
    .digest("hex")}`;

  return { manifest, contentHash };
}
