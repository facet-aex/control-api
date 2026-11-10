# OpenAPI import commands

The Phase 1 control plane accepts an OpenAPI source, creates immutable source provenance where possible and queues an import job. It does not parse the job inline and does not execute provider APIs.

## Current boundary

- `paste` and `upload` snapshot the submitted UTF-8 content into the configured immutable object store before the database transaction.
- `upload` currently uses JSON `content` as the local-demo fallback. Multipart and streaming upload are not implemented yet.
- `url` accepts HTTPS only and stores the protected source URL. The worker fetches and snapshots it through the isolated importer transport. Before processing, the job is `queued` and `sourceVersionId` is `null`; a successful worker completion populates the source version.
- Source URLs, object keys and source payloads are private provider data. API responses expose identifiers and status, not filesystem paths or source URLs.
- Creating an import requires `facet:write`. Reading it requires `provider:read-private` for the owning provider.

## Create an import

`POST /v1/openapi-imports`

Local authentication uses `x-facet-dev-user`.

Paste example:

```json
{
  "providerId": "00000000-0000-0000-0000-000000000000",
  "name": "Example API",
  "source": {
    "kind": "paste",
    "mediaType": "application/yaml",
    "content": "openapi: 3.1.0\ninfo:\n  title: Example\n  version: 1.0.0\npaths: {}\n"
  }
}
```

URL example:

```json
{
  "providerId": "00000000-0000-0000-0000-000000000000",
  "name": "Remote API",
  "source": {
    "kind": "url",
    "url": "https://provider.example/openapi.json"
  }
}
```

The command returns `202 Accepted` with a `queued` job. For paste/upload, `sourceVersionId` is populated immediately. For URL input, it remains `null` until the worker fetches and snapshots the document. Run `npm run worker:dev` alongside the Control API; the isolated `openapi-importer` process must be reachable at `FACET_IMPORTER_URL`.

## Read an import

`GET /v1/openapi-imports/:jobId`

The response includes job identifiers, status, warnings and a safe error summary. It does not return the source body or source URL.

## Read operation candidates

`GET /v1/openapi-imports/:jobId/operations`

Provider members may retrieve normalized operation candidates after the worker persists them. Importer contract v0.6 adds namespaced input schema, selected output/error schemas, private server templates, auth alternatives, response metadata and per-operation warnings. Schema examples, defaults and unallowlisted `x-*` extensions are removed before persistence. Reachable referenced schemas are embedded as candidate-local `$defs`; recursive references remain local and serializable. It never includes the protected source URL, raw snapshot, remote reference URL, object key or filesystem path.

## Limits

Each job stores a snapshot of the active limits so later worker behavior is reproducible. The defaults are:

- document: 5 MiB
- YAML aliases: 20
- redirects: 3
- reference depth: 16
- reference count: 256
- operations: 500
- total fetch/import timeout: 10 seconds

The control plane enforces the document byte limit for paste/upload and HTTPS for URL input before queueing. The isolated importer remains authoritative for network, parsing and reference limits.

The JSON transport limit for `POST /v1/openapi-imports` is derived from the configured document limit as `2 × maxDocumentBytes + 64 KiB`. The additional allowance covers JSON escaping and command metadata without increasing the decoded OpenAPI document budget. Exceeding either the transport or decoded-document limit returns `413 IMPORT_TOO_LARGE`.
