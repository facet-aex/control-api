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
GET /me                          authenticated FACET user ID/profile
GET /providers/{providerId}       public active-provider fields
GET /me/providers                authenticated user's memberships
GET /providers/{providerId}/members
```

The member list is private to current provider members and never returns the external authentication subject.

## Manage memberships

An authenticated user must first call `GET /me` and share the returned FACET user ID with a provider owner/admin. This avoids using wallet addresses or external authentication subjects as platform identifiers.

```http
PUT /providers/{providerId}/members/{userId}
x-facet-dev-user: demo-owner
content-type: application/json

{ "role": "developer" }
```

```text
DELETE /providers/{providerId}/members/{userId}
```

Owners and admins may manage memberships, but only owners may grant or alter the `owner` role. A mutation that would leave no owner returns `409 FINAL_OWNER_REQUIRED`. Membership changes write audit and outbox events in the same transaction.

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
