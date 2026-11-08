# FACET Control API

FACET control plane for provider identity/membership, Facet drafts and versions, publication, catalog and import commands.

**Phase:** 1 — active.
**Runtime:** Fastify + PostgreSQL, host-native.
**Boundary:** Does not execute provider endpoints and never owns payment signing keys.

This is a standalone npm repository. It owns its `package-lock.json`, database migrations, service configuration, authorization rules, tests and API documentation. Shared schemas are consumed as a pinned `contracts` release/package, never from a sibling path.
