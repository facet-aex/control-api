# Facet draft operation selection

This Slice 3 checkpoint turns operation candidates from one ready OpenAPI import into provider-private Facet drafts. The command is atomic: either every selected operation creates its Facet and initial version, or none do.

## Current boundary

- The caller needs `facet:write` for the provider.
- The import must belong to that provider, be `ready` and have an immutable source version.
- Every selected candidate must belong to the same import job.
- Candidate IDs and slugs must be unique within the batch; provider slugs remain unique in PostgreSQL.
- Each initial version is `0.1.0`, private and linked to the exact source version plus operation JSON Pointer.
- The stored draft manifest and response never include a protected base URL or provider credential.
- Input/output/error schemas from importer contract v0.6 are copied into the draft manifest. A single supported auth scheme maps to its API-key/Bearer kind; no-auth operations map to `NONE`. Multiple/combined/unsupported alternatives remain `UNCONFIGURED` for provider choice.
- Schema closure for referenced parameters/request bodies, endpoint configuration, secret references, warning acknowledgement, final validation and publication remain pending Slice 3 work. Initial drafts therefore keep `validation.status = PENDING`, including importer warnings.

## Create drafts

`POST /v1/facets`

```json
{
  "providerId": "00000000-0000-0000-0000-000000000000",
  "importJobId": "00000000-0000-0000-0000-000000000001",
  "selections": [
    {
      "operationCandidateId": "00000000-0000-0000-0000-000000000002",
      "slug": "current-weather",
      "name": "Current weather",
      "summary": "Read current weather observations.",
      "description": "Provider-owned weather observations.",
      "category": "weather",
      "tags": ["weather", "forecast"],
      "sideEffectClass": "READ_ONLY"
    }
  ]
}
```

`sideEffectClass` is one of `READ_ONLY`, `IDEMPOTENT_WRITE`, `NON_IDEMPOTENT_WRITE` or `UNKNOWN`. This declaration is provider metadata in Phase 1; FACET does not execute the operation or infer correctness from the HTTP method.

The response is `201 Created`:

```json
{
  "facets": [
    {
      "id": "00000000-0000-0000-0000-000000000010",
      "providerId": "00000000-0000-0000-0000-000000000000",
      "slug": "current-weather",
      "type": "EXTERNAL_HTTP_API",
      "status": "DRAFT",
      "visibility": "PRIVATE",
      "version": 1,
      "createdAt": "2026-11-09T00:00:00.000Z",
      "draftVersion": {
        "id": "00000000-0000-0000-0000-000000000011",
        "displayVersion": "0.1.0",
        "status": "DRAFT",
        "sourceVersionId": "00000000-0000-0000-0000-000000000012",
        "sourceOperationPointer": "#/paths/~1weather/get",
        "contentHash": "sha256:...",
        "version": 1,
        "validation": {
          "status": "PENDING",
          "errors": [],
          "warnings": []
        }
      }
    }
  ]
}
```

The operation-selection command remains contract v0.5; the candidate payload it consumes is validated against importer contract v0.6. The service keeps equivalent local runtime validation and does not import sibling repository source.
