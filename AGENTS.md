# FACET Control API instructions

- This is a standalone repository. It must install, migrate, build and test without a parent folder or sibling checkout.
- Current scope is Phase 1 provider/catalog control plane only.
- Clerk is an external session identity; FACET UUIDs and PostgreSQL memberships remain authoritative for domain authorization.
- Store only `SecretRef`, never plaintext provider credentials.
- Own PostgreSQL/Drizzle migrations. Use transactions for publication, membership invariants and durable outbox writes.
- Published `FacetVersion` records are immutable; updates create a new version.
- Consume and expose only pinned, versioned `contracts` artifacts; no relative sibling imports.
- Keep database credentials in local `.env`, never Git, logs or public responses.
- Do not implement execution, Run, wallet, ERC-8004 write or payment code in Phase 1.
