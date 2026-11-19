import { afterEach, beforeEach, expect, test } from "vitest";

import { buildApp } from "../src/app.js";
import type {
  PreviewExecutionRequest,
  PreviewExecutionResponse,
} from "../src/facets/actor-preview.js";
import { LocalAuthenticator } from "../src/auth/local-authenticator.js";
import { ProviderService } from "../src/providers/provider-service.js";
import { InMemoryProviderStore } from "./in-memory-provider-store.js";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
let providers: InMemoryProviderStore;
let executorCalls: unknown[];

beforeEach(() => {
  providers = new InMemoryProviderStore();
  executorCalls = [];
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function testApp(
  options: {
    consumeQuota?: () => Promise<boolean>;
    execute?: (
      request: PreviewExecutionRequest,
    ) => Promise<PreviewExecutionResponse>;
  } = {},
) {
  const authenticator = new LocalAuthenticator();
  const app = await buildApp({
    checkDatabase: async () => undefined,
    environment: "production",
    webOrigin: "https://facet.example",
    providerRoutes: {
      authenticator,
      service: new ProviderService(providers, {
        environment: "production",
        challengeDomain: "https://facet.example",
      }),
    },
    actorPreviewRoutes: {
      authenticator,
      providers,
      consumeQuota: options.consumeQuota ?? (async () => true),
      execute:
        options.execute ??
        (async (request: unknown) => {
          executorCalls.push(request);
          const body = request as { input: Record<string, unknown> };
          return {
            status: "SUCCEEDED",
            result: { echoed: body.input.value },
            dataset: [{ echoed: body.input.value }],
            logs: ["preview complete"],
            usage: {
              itemCount: 1,
              durationMs: 5,
              outputHash: `sha256:${"a".repeat(64)}`,
              runnerSignature: `0x${"b".repeat(130)}`,
            },
          };
        }),
    },
  });
  apps.push(app);
  return app;
}

function previewPayload() {
  return {
    code: "export default async function run(input) { return [{ echoed: input.value }]; }",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    input: { value: "one" },
  };
}

test("authorizes and executes distinct preview inputs using uppercase ACTOR without providerId or facetVersionId", async () => {
  const app = await testApp();
  const payload = previewPayload();
  const preview = (value: string, user = "alice-labs") =>
    app.inject({
      method: "POST",
      url: "/v1/actors/preview",
      headers: { "x-facet-dev-user": user },
      payload: { ...payload, input: { value } },
    });
  const first = await preview("one");
  const second = await preview("two");
  expect(first.statusCode).toBe(200);
  expect(second.statusCode).toBe(200);
  expect(first.json().dataset).toEqual([{ echoed: "one" }]);
  expect(second.json().dataset).toEqual([{ echoed: "two" }]);
  expect(executorCalls).toHaveLength(2);
  expect(executorCalls[0]).toMatchObject({ facetType: "ACTOR" });
  expect(executorCalls[0]).not.toHaveProperty("facetVersionId");
});

test("rejects extra providerId, invalid schema, input, code and oversized payload before execution", async () => {
  const app = await testApp();
  const send = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/v1/actors/preview",
      headers: { "x-facet-dev-user": "alice-labs" },
      payload,
    });
  const base = previewPayload();
  expect(
    (
      await send({
        ...base,
        providerId: "00000000-0000-4000-8000-000000000001",
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (await send({ ...base, inputSchema: { type: "array" } })).statusCode,
  ).toBe(400);
  expect((await send({ ...base, input: { value: 1 } })).statusCode).toBe(400);
  expect((await send({ ...base, code: "console.log('bad')" })).statusCode).toBe(
    400,
  );
  expect(
    (await send({ ...base, input: { value: "x".repeat(20_000) } })).statusCode,
  ).toBe(413);
  expect(executorCalls).toHaveLength(0);
});

test("denies a preview after its durable quota is exhausted", async () => {
  const app = await testApp({ consumeQuota: async () => false });
  const response = await app.inject({
    method: "POST",
    url: "/v1/actors/preview",
    headers: { "x-facet-dev-user": "alice-labs" },
    payload: previewPayload(),
  });
  expect(response.statusCode).toBe(429);
  expect(executorCalls).toHaveLength(0);
});

test("fails closed on executor failure or oversized output", async () => {
  const app = await testApp({
    execute: async () => {
      throw new Error("Docker unavailable");
    },
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/actors/preview",
    headers: { "x-facet-dev-user": "alice-labs" },
    payload: previewPayload(),
  });
  expect(response.statusCode).toBe(502);
  expect(response.body).not.toContain("Docker unavailable");
});
