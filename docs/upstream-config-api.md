# Provider secrets and draft endpoint configuration

This Phase 1 boundary configures a draft without executing the provider API. It implements contract `0.7.0` and requires `facet:write` membership permission.

## Write-only SecretRefs

```text
POST   /v1/providers/{providerId}/secrets
POST   /v1/providers/{providerId}/secrets/{secretId}/rotate
DELETE /v1/providers/{providerId}/secrets/{secretId}
```

Create accepts `kind` (`API_KEY` or `BEARER_TOKEN`), `label` and `value`. Rotate accepts only a new `value`. Responses return safe metadata (`id`, kind, label, status, usage count and timestamps); they never return the value, vault provider/reference or local path. Delete revokes only an unused SecretRef. A SecretRef attached to an endpoint configuration returns `409 RESOURCE_CONFLICT`.

The local demo adapter writes owner-readable files under `FACET_SECRET_ROOT` and gives PostgreSQL an opaque reference. It is deliberately behind `SecretValueStore`; local filesystem storage is not encryption and must be replaced by a managed secret store before deployment. A failed best-effort deletion of an old/revoked local value cannot roll back a committed rotation/revocation; a deployed adapter needs durable garbage collection and alerting.

## Configure a draft endpoint

`PUT /v1/facet-versions/{versionId}/endpoint-config`

```json
{
  "version": 1,
  "baseUrl": "https://api.example.com",
  "auth": {
    "kind": "API_KEY_HEADER",
    "secretRefId": "00000000-0000-0000-0000-000000000001",
    "parameterName": "X-Api-Key"
  },
  "timeoutMs": 15000,
  "maxResponseBytes": 1048576,
  "redirectPolicy": "DENY"
}
```

Auth is one of:

- `{ "kind": "NONE" }`;
- `{ "kind": "BEARER", "secretRefId": "..." }`;
- API-key header/query with both `secretRefId` and `parameterName`.

The SecretRef must be active, belong to the same provider and have the matching kind. The base URL must be concrete HTTPS without embedded credentials, query or fragment. Method and path are copied from the immutable imported operation, never accepted from the browser. `version` is the current Facet Version revision and stale writes return `412 VERSION_PRECONDITION_FAILED`.

The response confirms `baseUrlConfigured: true` but omits the protected base URL. Configuring a draft updates its public execution-policy/auth metadata, content hash and revision. Published/disabled versions reject this mutation. Phase 1 does not perform DNS/egress reachability checks or execute the endpoint; the separate validation and publication commands remain authoritative.
