import type { Pool } from "pg";

import type { FacetType, PricingModel } from "../identifiers.js";
import type {
  ActorRegistrationJob,
  ActorRegistrationWorkerStore,
} from "./actor-registration-worker.js";

interface JobRow {
  facet_id: string;
  version_id: string;
  facet_type: string;
  image_digest: string | null;
  content_hash: string | null;
  pricing_model: string;
  price_atomic: string;
  pay_to: string | null;
  erc8004_token_id: string | null;
  schema_uri: string;
  signed_raw: string | null;
  tx_hash: string | null;
}

function parseFacetType(value: string): FacetType {
  if (value === "API" || value === "ACTOR" || value === "AGENT") {
    return value;
  }
  throw new Error(`Unsupported registration facetType '${value}'`);
}

function parsePricingModel(value: string): PricingModel {
  if (value === "PAY_PER_RUN" || value === "PAY_PER_RESULT") {
    return value;
  }
  throw new Error(`Unsupported registration pricingModel '${value}'`);
}

export class PostgresActorRegistrationStore implements ActorRegistrationWorkerStore {
  constructor(private readonly pool: Pool) {}

  async next(): Promise<ActorRegistrationJob | null> {
    const result = await this.pool.query<JobRow>(
      `with selected as (
         select version_id from actor_registration_jobs
          where status = 'pending'
            and (lease_expires_at is null or lease_expires_at < now())
          order by created_at, version_id
          for update skip locked limit 1
       )
       update actor_registration_jobs as job
          set lease_expires_at = now() + interval '90 seconds',
              attempt_count = job.attempt_count + 1,
              updated_at = now()
         from selected, facet_versions as version, facets as facet
        where job.version_id = selected.version_id
          and version.id = job.version_id
          and facet.id = job.facet_id
       returning job.facet_id, job.version_id, facet.type::text as facet_type,
                 version.image_digest, version.content_hash,
                 version.pricing_model, version.price_atomic, version.pay_to,
                 version.erc8004_token_id, job.schema_uri,
                 job.signed_raw, job.tx_hash`,
    );
    const row = result.rows[0];
    if (!row) return null;
    const digest = row.image_digest ?? row.content_hash;
    if (!digest || !row.price_atomic || !row.pay_to) {
      throw new Error(
        "Pending registration has incomplete immutable version metadata",
      );
    }
    return {
      facetId: row.facet_id,
      versionId: row.version_id,
      facetType: parseFacetType(row.facet_type),
      digest,
      pricingModel: parsePricingModel(row.pricing_model),
      priceAtomic: row.price_atomic,
      payTo: row.pay_to,
      schemaURI: row.schema_uri,
      erc8004TokenId: row.erc8004_token_id,
      signedRaw: row.signed_raw,
      txHash: row.tx_hash,
    };
  }

  async saveSigned(
    versionId: string,
    signed: { hash: string; raw: string },
  ): Promise<void> {
    const result = await this.pool.query(
      `update actor_registration_jobs set signed_raw = $2, tx_hash = $3, updated_at = now()
        where version_id = $1::uuid and status = 'pending' and signed_raw is null`,
      [versionId, signed.raw, signed.hash],
    );
    if (result.rowCount !== 1)
      throw new Error("Registration signing claim is stale");
  }

  async promote(job: ActorRegistrationJob): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const claimed = await client.query(
        `update actor_registration_jobs set status = 'published', lease_expires_at = null, updated_at = now()
          where version_id = $1::uuid and tx_hash = $2 and status = 'pending' returning version_id`,
        [job.versionId, job.txHash],
      );
      if (claimed.rowCount !== 1)
        throw new Error("Registration promotion claim is stale");
      const version = await client.query<{ manifest: unknown }>(
        `update facet_versions set status = 'published', registry_verified = true,
            registry_tx_hash = $2, published_at = now(), published_by = created_by, updated_at = now()
          where id = $1::uuid and status in ('draft', 'valid')
          returning manifest`,
        [job.versionId, job.txHash],
      );
      if (version.rowCount !== 1)
        throw new Error("Facet version is not ready for promotion");

      const manifest = (version.rows[0]?.manifest ?? {}) as {
        facetDisplayName?: unknown;
        description?: unknown;
        category?: unknown;
        tags?: unknown;
        visibility?: unknown;
      };
      const manifestVisibility =
        typeof manifest.visibility === "string"
          ? manifest.visibility.toUpperCase()
          : null;
      const explicitVisibility =
        manifestVisibility === "UNLISTED"
          ? "unlisted"
          : manifestVisibility === "PUBLIC"
            ? "public"
            : null;
      const facetDisplayName =
        typeof manifest.facetDisplayName === "string" &&
        manifest.facetDisplayName.length > 0
          ? manifest.facetDisplayName
          : null;
      const description =
        typeof manifest.description === "string" ? manifest.description : null;
      const category =
        typeof manifest.category === "string" && manifest.category.length > 0
          ? manifest.category
          : null;
      const tags = Array.isArray(manifest.tags)
        ? manifest.tags.filter(
            (item): item is string => typeof item === "string",
          )
        : null;

      const facet = await client.query(
        `update facets set status = 'published',
            visibility = coalesce($3::facet_visibility, case when visibility = 'unlisted' then 'unlisted'::facet_visibility else 'public'::facet_visibility end),
            facet_display_name = coalesce($4, facet_display_name),
            description = coalesce($5, description),
            category = coalesce($6, category),
            tags = coalesce($7::text[], tags),
            revision = revision + 1,
            current_published_version_id = $2::uuid,
            updated_at = now()
          where id = $1::uuid and status in ('draft', 'published')`,
        [
          job.facetId,
          job.versionId,
          explicitVisibility,
          facetDisplayName,
          description,
          category,
          tags,
        ],
      );
      if (facet.rowCount !== 1)
        throw new Error("Facet is not ready for promotion");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async fail(job: ActorRegistrationJob, errorCode: string): Promise<void> {
    await this.pool.query(
      `update actor_registration_jobs set status = 'failed', error_code = $2,
          lease_expires_at = null, updated_at = now()
        where version_id = $1::uuid and status = 'pending'`,
      [job.versionId, errorCode],
    );
  }
}
