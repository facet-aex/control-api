import type { PreviewExecutionRequest } from "./actor-preview.js";

const MAX_RESPONSE_BYTES = 1024 * 1024;

export function createActorPreviewExecutor(baseUrl: string, token: string) {
  if (token.length < 32)
    throw new Error("FACET_EXECUTOR_TOKEN must have at least 32 characters");
  const url = new URL("/v1/execute", baseUrl).toString();
  return async (request: PreviewExecutionRequest): Promise<unknown> => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-facet-executor-token": token,
      },
      body: JSON.stringify(request),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(request.timeoutMs + 2_000),
    });
    if (!response.ok) throw new Error("Executor rejected preview");
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new Error("Executor response too large");
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("Executor response too large");
    }
    return JSON.parse(body) as unknown;
  };
}
