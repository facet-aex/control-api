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
      inputSchema: {},
      outputSchema: {},
      errorSchema: {},
      sideEffectClass: input.selection.sideEffectClass,
    },
    executionPolicy: {
      timeoutMs: 15_000,
      maxResponseBytes: 1_048_576,
      redirectPolicy: "DENY" as const,
    },
    upstreamAuth: {
      kind: "UNCONFIGURED" as const,
      configured: false,
    },
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
