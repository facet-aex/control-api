import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { AppError } from "../src/errors.js";
import { FacetDraftService } from "../src/facets/facet-draft-service.js";
import type {
  FacetDraftRecord,
  FacetDraftStore,
} from "../src/facets/facet-draft-types.js";
import { ProviderService } from "../src/providers/provider-service.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

class MemoryFacetDraftStore implements FacetDraftStore {
  readonly drafts: FacetDraftRecord[] = [];
  private readonly imports = new Map<
    string,
    {
      providerId: string;
      sourceVersionId: string;
      status: "ready" | "queued";
      candidates: Array<{ id: string; jsonPointer: string }>;
    }
  >();

  seedImport(providerId: string, status: "ready" | "queued" = "ready") {
    const importJobId = randomUUID();
    const sourceVersionId = randomUUID();
    const candidates = [
      { id: randomUUID(), jsonPointer: "#/paths/~1weather/get" },
      { id: randomUUID(), jsonPointer: "#/paths/~1alerts/get" },
    ];
    this.imports.set(importJobId, {
      providerId,
      sourceVersionId,
      status,
      candidates,
    });
    return { importJobId, sourceVersionId, candidates };
  }

  async createDrafts(
    input: Parameters<FacetDraftStore["createDrafts"]>[0],
  ): Promise<FacetDraftRecord[]> {
    const imported = this.imports.get(input.importJobId);
    if (!imported || imported.providerId !== input.providerId) {
      throw new AppError("RESOURCE_NOT_FOUND", "Import job not found.", 404);
    }
    if (imported.status !== "ready") {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "The import job is not ready for operation selection.",
        409,
      );
    }

    const selected = input.selections.map((selection) => {
      const candidate = imported.candidates.find(
        ({ id }) => id === selection.operationCandidateId,
      );
      if (!candidate) {
        throw new AppError(
          "RESOURCE_NOT_FOUND",
          "An operation candidate was not found in this import.",
          404,
        );
      }
      const facetId = randomUUID();
      const facetVersionId = randomUUID();
      const contentHash = `sha256:${createHash("sha256")
        .update(`${facetId}:${facetVersionId}:${candidate.jsonPointer}`)
        .digest("hex")}`;
      return {
        facetId,
        providerId: input.providerId,
        slug: selection.slug,
        facetStatus: "draft" as const,
        visibility: "private" as const,
        facetRevision: 1,
        createdAt: new Date("2026-11-09T00:00:00.000Z"),
        facetVersionId,
        displayVersion: "0.1.0",
        facetVersionStatus: "draft" as const,
        sourceVersionId: imported.sourceVersionId,
        sourceOperationPointer: candidate.jsonPointer,
        contentHash,
        facetVersionRevision: 1,
        validationResult: {
          status: "pending" as const,
          errors: [],
          warnings: [],
        },
      };
    });

    if (
      selected.some((draft) =>
        this.drafts.some(
          (existing) =>
            existing.providerId === draft.providerId &&
            existing.slug === draft.slug,
        ),
      )
    ) {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "A Facet with one of these slugs already exists.",
        409,
      );
    }
    this.drafts.push(...selected);
    return selected;
  }
}

let app: FastifyInstance;
let store: MemoryFacetDraftStore;

beforeEach(async () => {
  const providers = new InMemoryProviderStore();
  store = new MemoryFacetDraftStore();
  const authenticator = new LocalAuthenticator();
  app = await buildApp({
    checkDatabase: async () => undefined,
    environment: "local",
    webOrigin: "http://localhost:3000",
    providerRoutes: {
      authenticator,
      service: new ProviderService(providers),
    },
    facetDraftRoutes: {
      authenticator,
      service: new FacetDraftService(providers, store),
    },
  });
});

afterEach(async () => app.close());

async function createProvider(user = "alice"): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/providers",
    headers: { "x-facet-dev-user": user },
    payload: { slug: `${user}-facets`, name: `${user} Facets` },
  });
  return response.json().provider.id as string;
}

function selection(operationCandidateId: string, suffix: string) {
  return {
    operationCandidateId,
    slug: `${suffix}-weather`,
    name: `${suffix} weather`,
    summary: `Read ${suffix} weather`,
    description: "Provider-owned weather data.",
    category: "weather",
    tags: ["weather", suffix],
    sideEffectClass: "READ_ONLY",
  };
}

describe("Facet draft operation selection", () => {
  it("creates one private Facet draft per selected operation atomically", async () => {
    const providerId = await createProvider();
    const imported = store.seedImport(providerId);

    const response = await app.inject({
      method: "POST",
      url: "/v1/facets",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        providerId,
        importJobId: imported.importJobId,
        selections: [
          selection(imported.candidates[0]!.id, "daily"),
          selection(imported.candidates[1]!.id, "severe"),
        ],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      facets: [
        {
          providerId,
          slug: "daily-weather",
          type: "EXTERNAL_HTTP_API",
          status: "DRAFT",
          visibility: "PRIVATE",
          version: 1,
          draftVersion: {
            displayVersion: "0.1.0",
            status: "DRAFT",
            sourceVersionId: imported.sourceVersionId,
            sourceOperationPointer: "#/paths/~1weather/get",
            version: 1,
            validation: { status: "PENDING", errors: [], warnings: [] },
          },
        },
        {
          providerId,
          slug: "severe-weather",
          draftVersion: {
            sourceOperationPointer: "#/paths/~1alerts/get",
          },
        },
      ],
    });
    expect(response.json().facets[0].draftVersion.contentHash).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
    expect(store.drafts).toHaveLength(2);
    expect(response.body).not.toMatch(
      /baseUrl|secretRef|credential|apiKey|bearerToken/iu,
    );
  });

  it("rejects duplicate candidate IDs before creating any draft", async () => {
    const providerId = await createProvider();
    const imported = store.seedImport(providerId);
    const duplicate = imported.candidates[0]!.id;

    const response = await app.inject({
      method: "POST",
      url: "/v1/facets",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        providerId,
        importJobId: imported.importJobId,
        selections: [
          selection(duplicate, "first"),
          selection(duplicate, "second"),
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: "INPUT_INVALID" },
    });
    expect(store.drafts).toHaveLength(0);
  });

  it("denies cross-provider selection and rejects an import that is not ready", async () => {
    const providerId = await createProvider();
    const imported = store.seedImport(providerId);
    const denied = await app.inject({
      method: "POST",
      url: "/v1/facets",
      headers: { "x-facet-dev-user": "mallory" },
      payload: {
        providerId,
        importJobId: imported.importJobId,
        selections: [selection(imported.candidates[0]!.id, "denied")],
      },
    });
    expect(denied.statusCode).toBe(403);

    const queued = store.seedImport(providerId, "queued");
    const notReady = await app.inject({
      method: "POST",
      url: "/v1/facets",
      headers: { "x-facet-dev-user": "alice" },
      payload: {
        providerId,
        importJobId: queued.importJobId,
        selections: [selection(queued.candidates[0]!.id, "queued")],
      },
    });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json()).toMatchObject({
      error: { code: "RESOURCE_CONFLICT" },
    });
    expect(store.drafts).toHaveLength(0);
  });
});
