# Facet Version publication

Contract `0.9.0` publishes one already-`VALID` Facet Version. Publication does not execute or probe the provider API.

```text
POST /v1/facet-versions/{versionId}/publish
```

```json
{
  "version": 3,
  "visibility": "PUBLIC"
}
```

`visibility` is `PUBLIC` or `UNLISTED`. `version` is the current optimistic revision; a stale request returns `412 VERSION_PRECONDITION_FAILED`. The authenticated user needs `facet:write` permission for the owning provider.

The transaction locks the Facet and Facet Version, rechecks that validation is `VALID` and a protected endpoint is configured, freezes the version as `PUBLISHED`, recomputes its hash with the selected public visibility, records publisher/time, and advances the Facet's `currentPublishedVersionId`. It also writes a redacted audit event. Repeated publication, invalid drafts, disabled resources and post-publication validation/endpoint mutation return `409 RESOURCE_CONFLICT`.

The response contains only publication metadata. It never contains the protected base URL, SecretRef, vault reference or secret value.
