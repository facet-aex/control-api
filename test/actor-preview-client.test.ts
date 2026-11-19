import { afterEach, expect, test, vi } from "vitest";

import { createActorPreviewExecutor } from "../src/facets/actor-preview-client.js";

afterEach(() => vi.unstubAllGlobals());

test("sends preview to the internal executor with its token and returns bounded JSON", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      status: "SUCCEEDED",
      result: { ok: true },
      dataset: [{ ok: true }],
      logs: [],
      usage: {
        itemCount: 1,
        durationMs: 1,
        outputHash: `sha256:${"a".repeat(64)}`,
        runnerSignature: `0x${"b".repeat(130)}`,
      },
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const execute = createActorPreviewExecutor(
    "http://executor:4030",
    "a".repeat(32),
  );
  const request = {
    runId: "a",
    facetId: "b",
    facetType: "ACTOR" as const,
    input: { value: "one" },
    timeoutMs: 15_000,
    actorBundle: {
      code: "export default async () => ({})",
      entrypoint: "run" as const,
      imageDigest: `sha256:${"a".repeat(64)}`,
    },
  };
  await expect(execute(request)).resolves.toMatchObject({
    status: "SUCCEEDED",
  });
  expect(fetcher).toHaveBeenCalledOnce();
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("http://executor:4030/v1/execute");
  expect(new Headers(init.headers).get("x-facet-executor-token")).toBe(
    "a".repeat(32),
  );
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toMatchObject({
    input: { value: "one" },
  });
});
