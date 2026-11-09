import { describe, expect, it, vi } from "vitest";

import {
  HttpImporterClient,
  ImporterClientError,
} from "../src/imports/importer-client.js";

const limits = {
  maxDocumentBytes: 1_000,
  maxYamlAliases: 20,
  maxRedirects: 3,
  maxReferenceDepth: 16,
  maxReferenceCount: 256,
  maxOperationCount: 500,
  timeoutMs: 10_000,
};

function validResponse() {
  const content =
    '{"openapi":"3.1.0","info":{"title":"Test","version":"1"},"paths":{"/x":{"get":{}}}}';
  return {
    document: { openapi: "3.1.0", title: "Test", version: "1" },
    candidates: [
      {
        candidateId: "GET /x",
        jsonPointer: "#/paths/~1x/get",
        method: "GET",
        path: "/x",
        tags: [],
        normalized: {
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
          },
          outputSchema: { type: "string" },
          errorSchema: {},
          servers: [{ url: "https://api.example", variables: {} }],
          authAlternatives: [],
          responseMetadata: {
            successStatusCode: "200",
            successMediaType: "application/json",
            errorStatusCodes: [],
          },
        },
        warnings: [],
      },
    ],
    warnings: [],
    source: {
      kind: "paste",
      sha256:
        "b2fa9c184c032540731d60a106139c5724b6a2e80f6124ce4090a33dd832a54f",
      byteLength: Buffer.byteLength(content),
    },
    snapshot: { content },
    limits,
  };
}

describe("HTTP importer client", () => {
  it("validates a v0.6 response and forwards the request ID", async () => {
    const fetchImplementation = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get("x-request-id")).toBe("event-1");
      return new Response(JSON.stringify(validResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new HttpImporterClient(
      new URL("http://127.0.0.1:4010"),
      fetchImplementation as typeof fetch,
    );

    const result = await client.parse(
      { kind: "paste", content: validResponse().snapshot.content },
      limits,
      "event-1",
    );
    expect(result.candidates[0]?.jsonPointer).toBe("#/paths/~1x/get");
    expect(result.candidates[0]?.normalized.outputSchema).toEqual({
      type: "string",
    });
  });

  it("rejects a legacy candidate without normalized schemas", async () => {
    const legacy = validResponse();
    const candidate = legacy.candidates[0] as Record<string, unknown>;
    delete candidate.normalized;
    delete candidate.warnings;
    const client = new HttpImporterClient(
      new URL("http://127.0.0.1:4010"),
      (async () =>
        new Response(JSON.stringify(legacy), { status: 200 })) as typeof fetch,
    );

    await expect(
      client.parse(
        { kind: "paste", content: legacy.snapshot.content },
        limits,
        "event-legacy",
      ),
    ).rejects.toMatchObject<Partial<ImporterClientError>>({
      code: "IMPORTER_RESPONSE_INVALID",
      retryable: false,
    });
  });

  it("classifies structured 4xx errors as terminal", async () => {
    const client = new HttpImporterClient(
      new URL("http://127.0.0.1:4010"),
      (async () =>
        new Response(
          JSON.stringify({
            error: { code: "INVALID_OPENAPI", message: "Invalid document" },
          }),
          { status: 400 },
        )) as typeof fetch,
    );

    await expect(
      client.parse({ kind: "paste", content: "bad" }, limits, "event-2"),
    ).rejects.toMatchObject<Partial<ImporterClientError>>({
      code: "INVALID_OPENAPI",
      retryable: false,
    });
  });

  it("classifies network failures as retryable", async () => {
    const client = new HttpImporterClient(
      new URL("http://127.0.0.1:4010"),
      (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    );

    await expect(
      client.parse({ kind: "paste", content: "test" }, limits, "event-3"),
    ).rejects.toMatchObject<Partial<ImporterClientError>>({
      code: "IMPORTER_UNAVAILABLE",
      retryable: true,
    });
  });
});
