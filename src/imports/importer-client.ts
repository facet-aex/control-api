import { z } from "zod";

import type {
  ImportLimitsSnapshot,
  ImportSourceInput,
} from "./import-types.js";

const warningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

const limitsSchema = z.object({
  maxDocumentBytes: z.number().int().positive(),
  maxYamlAliases: z.number().int().min(0),
  maxRedirects: z.number().int().min(0),
  maxReferenceDepth: z.number().int().positive(),
  maxReferenceCount: z.number().int().positive(),
  maxOperationCount: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});

const jsonSchema = z.union([z.boolean(), z.record(z.string(), z.unknown())]);
const authSchemeSchema = z.object({
  schemeName: z.string().min(1),
  kind: z.enum(["API_KEY_HEADER", "API_KEY_QUERY", "BEARER", "UNSUPPORTED"]),
  parameterName: z.string().min(1).optional(),
  sourceType: z.string().min(1).optional(),
});
const normalizedOperationSchema = z.object({
  description: z.string().optional(),
  inputSchema: jsonSchema,
  outputSchema: jsonSchema,
  errorSchema: jsonSchema,
  servers: z.array(
    z.object({
      url: z.string().min(1).max(2_048),
      description: z.string().optional(),
      variables: z.record(z.string(), z.string()),
    }),
  ),
  authAlternatives: z.array(z.object({ schemes: z.array(authSchemeSchema) })),
  responseMetadata: z.object({
    successStatusCode: z.string().min(1).optional(),
    successMediaType: z.string().min(1).optional(),
    errorStatusCodes: z.array(z.string().min(1)),
  }),
});

export const importerOperationCandidateSchema = z.object({
  candidateId: z.string().min(1),
  jsonPointer: z.string().startsWith("#/paths/"),
  method: z.enum([
    "GET",
    "PUT",
    "POST",
    "DELETE",
    "OPTIONS",
    "HEAD",
    "PATCH",
    "TRACE",
  ]),
  path: z.string().startsWith("/"),
  operationId: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  tags: z.array(z.string()),
  normalized: normalizedOperationSchema,
  warnings: z.array(warningSchema),
});

const responseSchema = z.object({
  document: z.object({
    openapi: z.string().regex(/^3\.(0|1)\./u),
    title: z.string().min(1),
    version: z.string().min(1),
  }),
  candidates: z.array(importerOperationCandidateSchema),
  warnings: z.array(warningSchema),
  source: z.object({
    kind: z.enum(["paste", "upload", "url"]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    byteLength: z.number().int().min(0),
    mediaType: z.string().min(1).optional(),
    finalUrl: z.string().url().optional(),
    redirectCount: z.number().int().min(0).optional(),
  }),
  snapshot: z.object({ content: z.string() }),
  limits: limitsSchema,
});

const errorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export type ImporterResult = z.infer<typeof responseSchema>;

export class ImporterClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ImporterClientError";
  }
}

export interface ImporterClient {
  parse(
    source: ImportSourceInput,
    limits: ImportLimitsSnapshot,
    requestId: string,
  ): Promise<ImporterResult>;
}

async function readBoundedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ImporterClientError(
      "IMPORTER_RESPONSE_TOO_LARGE",
      "The importer response exceeded the worker response limit.",
      false,
    );
  }
  if (!response.body) return undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel();
      throw new ImporterClientError(
        "IMPORTER_RESPONSE_TOO_LARGE",
        "The importer response exceeded the worker response limit.",
        false,
      );
    }
    chunks.push(result.value);
  }

  try {
    return JSON.parse(
      Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    ) as unknown;
  } catch {
    throw new ImporterClientError(
      "IMPORTER_RESPONSE_INVALID",
      "The importer returned invalid JSON.",
      response.status >= 500,
    );
  }
}

export class HttpImporterClient implements ImporterClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async parse(
    source: ImportSourceInput,
    limits: ImportLimitsSnapshot,
    requestId: string,
  ): Promise<ImporterResult> {
    let response: Response;
    try {
      response = await this.fetchImplementation(
        new URL("/v1/imports/parse", this.baseUrl),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
          },
          body: JSON.stringify({ source, limits }),
          signal: AbortSignal.timeout(limits.timeoutMs + 2_000),
        },
      );
    } catch {
      throw new ImporterClientError(
        "IMPORTER_UNAVAILABLE",
        "The OpenAPI importer could not be reached.",
        true,
      );
    }

    const payload = await readBoundedJson(
      response,
      limits.maxDocumentBytes * 8 + 1_048_576,
    );
    if (!response.ok) {
      const parsedError = errorSchema.safeParse(payload);
      throw new ImporterClientError(
        parsedError.success
          ? parsedError.data.error.code
          : "IMPORTER_REQUEST_FAILED",
        parsedError.success
          ? parsedError.data.error.message
          : "The importer rejected the document.",
        response.status >= 500,
      );
    }

    const parsed = responseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ImporterClientError(
        "IMPORTER_RESPONSE_INVALID",
        "The importer response did not match contract v0.6.",
        false,
      );
    }
    if (
      Object.keys(limits).some(
        (key) =>
          parsed.data.limits[key as keyof ImportLimitsSnapshot] !==
          limits[key as keyof ImportLimitsSnapshot],
      )
    ) {
      throw new ImporterClientError(
        "IMPORTER_LIMIT_MISMATCH",
        "The importer did not apply the import job limits snapshot.",
        false,
      );
    }
    return parsed.data;
  }
}
