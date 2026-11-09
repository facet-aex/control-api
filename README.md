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

Replace the placeholder `DATABASE_URL` in the ignored `.env`. Liveness is available at `/health/live`; `/health/ready` additionally verifies PostgreSQL. Run `npm run verify` before committing.

After migrations, `npm run db:smoke` verifies provider creation, membership mutation, final-owner protection and OpenAPI import persistence against the configured local database. It creates uniquely named synthetic records, uses a temporary object-store directory and removes both before exiting.

Phase 1 source snapshots use the local filesystem adapter rooted at `FACET_OBJECT_ROOT`. Objects are content-addressed, written with owner-only permissions and verified on read. This adapter is for the local demo only; object keys are internal identifiers, not public filesystem paths.

Phase 1 local authentication uses `FACET_AUTH_MODE=local` and requires an `x-facet-dev-user` header on protected routes. This mode fails closed outside `FACET_ENV=local`. See `docs/authentication.md`, `docs/providers-api.md` and `docs/openapi-imports-api.md` for the current boundary and examples.
