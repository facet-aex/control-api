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
