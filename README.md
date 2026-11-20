# FACET Control API (`@facet/control-api`)

[![FACET](https://img.shields.io/badge/FACET-facet.briandev.space-050505?style=flat-square&labelColor=DFFF4F)](https://facet.briandev.space)
[![Layer](https://img.shields.io/badge/BACKEND-CONTROL%20PLANE-0D0D0D?style=flat-square&labelColor=343434)](https://github.com/facet-aex)

> Core control-plane HTTP API and background worker managing FACET identities, authoring, publication, catalog, and faucet workflows.

## Overview

`control-api` is the central control plane and system of record for **FACET**. It manages user accounts, capability drafts, immutable SemVer version publication, public catalog queries, upstream credential references, and test `fUSD` faucet distribution.

## Role in FACET

- **Unified User & Payout Identity:** Synchronizes Clerk users via verified webhooks into a single `users` account model and verifies payout wallet ownership (`providerPayTo`).
- **Facet Lifecycle & Validation:** Manages creation, manifest validation, pricing configuration (`PAY_PER_RUN` and `PAY_PER_RESULT`), and immutable publication across `API`, `ACTOR`, and `AGENT` modalities.
- **Background Outbox Worker:** Coordinates asynchronous OpenAPI import jobs with `openapi-importer` and anchors published Facet versions onto `FacetActorRegistry` on Avalanche.
- **Catalog & Faucet API:** Serves the public capability catalog consumed by `web`, `@facet-aex/cli`, and `@facet-aex/mcp-server`, alongside rate-limited `fUSD` claims.

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime & HTTP | Node.js 24 (ESM), TypeScript, Fastify 5 |
| Database | PostgreSQL 18, Drizzle ORM, `pg` |
| Validation & Contracts | Ajv (JSON Schema 2020-12), Zod |
| Auth & Blockchain | Clerk (`@clerk/backend`), `viem` |
| Testing & Container | Vitest, ESLint, Docker (`node:24-alpine`) |

---

Part of **[FACET](https://facet.briandev.space)** (`facet-aex`) — Federated Agent Capability Exchange & Trust on Avalanche.
