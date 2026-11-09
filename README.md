# FACET Control API

FACET control plane for provider identity/membership, Facet drafts and versions, publication, catalog and import commands.

**Phase:** 1 — active.
**Runtime:** Fastify + PostgreSQL, host-native.
**Boundary:** Does not execute provider endpoints and never owns payment signing keys.

This is a standalone npm repository. It owns its `package-lock.json`, database migrations, service configuration, authorization rules, tests and API documentation. Shared schemas are consumed as a pinned `contracts` release/package, never from a sibling path.

## Local setup

```bash
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

OpenAPI ingestion uses three local processes. Start `openapi-importer` on its configured port first, then run the Control API and worker in separate terminals:

```bash
npm run dev
npm run worker:dev
```

The worker polls the PostgreSQL transactional outbox, claims work with an expiring lease, calls the importer contract v0.4, verifies snapshot integrity and persists operation candidates. It retries transient network/5xx failures up to the configured limit; deterministic importer errors become terminal job failures.

Replace the placeholder `DATABASE_URL` in the ignored `.env`. Liveness is available at `/health/live`; `/health/ready` additionally verifies PostgreSQL. Run `npm run verify` before committing.

After migrations, `npm run db:smoke` verifies provider creation, membership mutation, final-owner protection, paste/URL import worker completion, candidate persistence and atomic Facet-draft creation against the configured local database. It uses an in-process importer client double, creates uniquely named synthetic records, uses a temporary object-store directory and removes everything before exiting.

Phase 1 source snapshots use the local filesystem adapter rooted at `FACET_OBJECT_ROOT`. Objects are content-addressed, written with owner-only permissions and verified on read. This adapter is for the local demo only; object keys are internal identifiers, not public filesystem paths.

Phase 1 local authentication uses `FACET_AUTH_MODE=local` and requires an `x-facet-dev-user` header on protected routes. This mode fails closed outside `FACET_ENV=local`. See `docs/authentication.md`, `docs/providers-api.md`, `docs/openapi-imports-api.md` and `docs/facet-drafts-api.md` for the current boundary and examples.
