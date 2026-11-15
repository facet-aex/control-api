import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const api = process.env.FACET_CONTROL_API_URL ?? "http://127.0.0.1:4000";
const user = process.env.FACET_DEMO_PROVIDER_USER ?? "facet-demo-provider";
const suffix = randomUUID().slice(0, 8);
const source = await readFile(new URL("../fixtures/demo-github.openapi.yaml", import.meta.url), "utf8");

async function call(method, path, body) {
  const response = await fetch(new URL(path, api), {
    method,
    headers: {
      "x-facet-dev-user": user,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

const { provider } = await call("POST", "/v1/providers", {
  slug: `facet-demo-github-${suffix}`,
  name: "FACET demo GitHub provider",
});
const { job } = await call("POST", "/v1/openapi-imports", {
  providerId: provider.id,
  name: "GitHub public repository lookup",
  source: { kind: "paste", mediaType: "application/yaml", content: source },
});

let ready;
for (let attempt = 0; attempt < 50; attempt++) {
  ready = (await call("GET", `/v1/openapi-imports/${job.id}`)).job;
  if (ready.status === "ready") break;
  if (ready.status === "failed") throw new Error(`Import failed: ${JSON.stringify(ready)}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (ready.status !== "ready") throw new Error(`Import did not become ready: ${ready.status}`);

const { operations } = await call("GET", `/v1/openapi-imports/${job.id}/operations`);
if (operations.length !== 1 || operations[0].method !== "GET") {
  throw new Error(`Expected one GitHub GET operation, received ${operations.length}`);
}
const { facets } = await call("POST", "/v1/facets", {
  providerId: provider.id,
  importJobId: job.id,
  selections: [{
    operationCandidateId: operations[0].id,
    slug: `github-repository-${suffix}`,
    name: "GitHub public repository lookup",
    summary: "Look up public GitHub repository metadata",
    category: "developer-tools",
    tags: ["github", "repository", "demo"],
    sideEffectClass: "READ_ONLY",
  }],
});
const facet = facets[0];
const versionId = facet.draftVersion.id;
const configured = await call("PUT", `/v1/facet-versions/${versionId}/endpoint-config`, {
  version: facet.draftVersion.version,
  baseUrl: "https://api.github.com",
  auth: { kind: "NONE" },
  timeoutMs: 15_000,
  maxResponseBytes: 1_048_576,
  redirectPolicy: "DENY",
});
let version = configured.endpointConfig.facetVersionVersion;
let validation = (await call("POST", `/v1/facet-versions/${versionId}/validate`, {
  version,
  warningAcknowledgements: [],
})).facetVersion;
if (validation.status === "DRAFT") {
  validation = (await call("POST", `/v1/facet-versions/${versionId}/validate`, {
    version: validation.version,
    warningAcknowledgements: validation.validation.warnings.map(({ warningId }) => ({
      warningId,
      reason: "Accepted for the supervised local GitHub demo.",
    })),
  })).facetVersion;
}
if (validation.status !== "VALID") throw new Error(`Facet validation status: ${validation.status}`);
const published = await call("POST", `/v1/facet-versions/${versionId}/publish`, {
  version: validation.version,
  visibility: "PUBLIC",
});
const detail = await call("GET", `/v1/catalog/facets/${facet.id}`);
if (detail.facet?.id !== facet.id) throw new Error("Published Facet missing from public catalog");
console.log(JSON.stringify({ providerId: provider.id, importJobId: job.id, facetId: facet.id, facetVersionId: versionId, status: published.facetVersion.status }, null, 2));
