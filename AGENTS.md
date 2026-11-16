# `control-api` instructions

**Owner in Wave 1:** Antigravity  
**Port:** `4000`  
**Active architectural authority:** `../docs/architecture/decisions/ADR-0015-actorbazaar-docker-and-a2a-mvp.md`

## Role

`control-api` is FACET's provider and catalog control plane. Under ADR-0015, it supports all three capability types (`EXTERNAL_HTTP_API`, `HOSTED_ACTOR`, `AUTONOMOUS_AGENT`):

1. **Minimalist 1-Step Hosted Actor Publishing (`POST /v1/actors`):**
   - Accepts `{ providerId, name, slug, summary, description, category, tags, inputSchema, code, pricingModel, priceAtomic, payTo, registryTxHash }`.
   - Validates `inputSchema` (JSON Schema 2020-12) and `code` (non-empty ESM module exporting `run`).
   - Computes deterministic `imageDigest = "sha256:" + sha256Hex("facet/node-actor-runner:1.0\n" + code.trim())`.
   - Creates and publishes the `HOSTED_ACTOR` Facet and its `1.0.0` immutable `FacetVersion` in one transaction.
2. **Minimalist 1-Step A2A Agent Registration (`POST /v1/agent-facets`):**
   - Accepts `{ providerId, name, slug, summary, description, category, tags, erc8004TokenId, erc8004Registry, taskKind, code, inputSchema, pricingModel, priceAtomic, payTo, registryTxHash }`.
   - Creates and publishes the `AUTONOMOUS_AGENT` Facet bound to the specified Fuji ERC-8004 Identity.
3. **Existing OpenAPI Import & Manual GET API Flow:**
   - Preserves `/v1/openapi-imports`, `/v1/facets`, `/v1/facet-versions/:id/endpoint-config`, `/validate`, and `/publish`.
4. **Public Multi-Modal Catalog (`GET /v1/catalog/facets` & `GET /v1/catalog/facets/:facetId`):**
   - Supports filtering by `q`, `type` (`EXTERNAL_HTTP_API` | `HOSTED_ACTOR` | `AUTONOMOUS_AGENT`), and `category`.
   - Returns `v0.13.0` `PublicFacet` objects including `facetType`, `pricing`, `actorMeta`, and `agentMeta`. Never exposes private `endpoint_configs` or `secret_refs`.
