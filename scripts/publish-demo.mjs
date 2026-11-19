import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const api = process.env.FACET_CONTROL_API_URL ?? "http://127.0.0.1:4000";
const user = process.env.FACET_DEMO_PROVIDER_USER ?? "facet-demo";
const suffix = randomUUID().replace(/-/g, "").slice(0, 6);
const source = await readFile(
  new URL("../fixtures/demo-github.openapi.yaml", import.meta.url),
  "utf8",
);

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
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

const { user: currentUser } = await call("GET", "/v1/me");
const provider = currentUser.username;
const { job } = await call("POST", "/v1/openapi-imports", {
  name: "GitHub public repository lookup",
  source: { kind: "paste", mediaType: "application/yaml", content: source },
});

let ready;
for (let attempt = 0; attempt < 50; attempt++) {
  ready = (await call("GET", `/v1/openapi-imports/${job.id}`)).job;
  if (ready.status === "ready") break;
  if (ready.status === "failed")
    throw new Error(`Import failed: ${JSON.stringify(ready)}`);
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (ready.status !== "ready")
  throw new Error(`Import did not become ready: ${ready.status}`);

const { operations } = await call(
  "GET",
  `/v1/openapi-imports/${job.id}/operations`,
);
if (operations.length !== 1 || operations[0].method !== "GET") {
  throw new Error(
    `Expected one GitHub GET operation, received ${operations.length}`,
  );
}

const facetName = `github-repository-${suffix}`;
const { facets } = await call("POST", "/v1/facets", {
  importJobId: job.id,
  selections: [
    {
      operationCandidateId: operations[0].id,
      facetName,
      facetDisplayName: "GitHub public repository lookup",
      summary: "Look up public GitHub repository metadata",
      category: "developer-tools",
      tags: ["github", "repository", "demo"],
      sideEffectClass: "READ_ONLY",
    },
  ],
});
const facet = facets[0];
const version = facet.draftVersion.version;
const configured = await call(
  "PUT",
  `/v1/facets/${provider}/${facetName}/versions/${version}/endpoint-config`,
  {
    revision: facet.draftVersion.revision,
    baseUrl: "https://api.github.com",
    auth: { kind: "NONE" },
    timeoutMs: 15_000,
    maxResponseBytes: 1_048_576,
    redirectPolicy: "DENY",
  },
);
let revision = configured.endpointConfig.facetVersionRevision;
let validation = (
  await call(
    "POST",
    `/v1/facets/${provider}/${facetName}/versions/${version}/validate`,
    {
      revision,
      warningAcknowledgements: [],
    },
  )
).facetVersion;
if (validation.status === "DRAFT") {
  validation = (
    await call(
      "POST",
      `/v1/facets/${provider}/${facetName}/versions/${version}/validate`,
      {
        revision: validation.revision,
        warningAcknowledgements: validation.validation.warnings.map(
          ({ warningId }) => ({
            warningId,
            reason: "Accepted for the supervised local GitHub demo.",
          }),
        ),
      },
    )
  ).facetVersion;
}
if (validation.status !== "VALID")
  throw new Error(`Facet validation status: ${validation.status}`);
const published = await call(
  "POST",
  `/v1/facets/${provider}/${facetName}/versions/${version}/publish`,
  {
    revision: validation.revision,
    visibility: "PUBLIC",
  },
);
const detail = await call("GET", `/v1/catalog/facets/${provider}/${facetName}`);
if (detail.facet?.facetName !== facetName)
  throw new Error("Published Facet missing from public catalog");
console.log(
  JSON.stringify(
    {
      provider,
      importJobId: job.id,
      facetName,
      version,
      status: published.facetVersion.status,
    },
    null,
    2,
  ),
);
