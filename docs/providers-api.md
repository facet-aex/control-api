# Providers API — Slice 1

Base URL: `http://localhost:4000/v1`

## Create

```http
POST /providers
x-facet-dev-user: demo-owner
content-type: application/json

{
  "slug": "northstar-labs",
  "name": "Northstar Labs",
  "description": "External data capabilities.",
  "websiteUrl": "https://northstar.example",
  "walletAddress": "0x0000000000000000000000000000000000000001"
}
```

Creation writes the Provider, initial owner membership, audit event and outbox event in one PostgreSQL transaction.

## Read and list memberships

```text
GET /providers/{providerId}       public active-provider fields
GET /me/providers                authenticated user's memberships
```

## Update

```http
PATCH /providers/{providerId}
x-facet-dev-user: demo-owner
content-type: application/json

{
  "version": 1,
  "description": "Updated description"
}
```

`version` provides optimistic concurrency. A stale version returns `412 VERSION_PRECONDITION_FAILED`; a non-member or insufficient role returns `403 AUTHORIZATION_DENIED`.

Public responses never include auth subjects, internal user IDs, audit metadata or outbox payloads. Wallet address is optional metadata only; no chain request occurs in Phase 1.
