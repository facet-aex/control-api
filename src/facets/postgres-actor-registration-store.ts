import type { Pool } from "pg";

import type {
  ActorRegistrationJob,
  ActorRegistrationWorkerStore,
} from "./actor-registration-worker.js";

interface JobRow {
  facet_id: string;
  version_id: string;
  image_digest: string;
  price_atomic: string;
  pay_to: string;
  schema_uri: string;
  signed_raw: string | null;
  tx_hash: string | null;
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
         from selected, facet_versions as version
        where job.version_id = selected.version_id
          and version.id = job.version_id
       returning job.facet_id, job.version_id, version.image_digest,
                 version.price_atomic, version.pay_to, job.schema_uri,
                 job.signed_raw, job.tx_hash`,
    );
    const row = result.rows[0];
    if (!row) return null;
    if (!row.image_digest || !row.price_atomic || !row.pay_to) {
      throw new Error(
        "Pending Actor registration has incomplete immutable version metadata",
      );
    }
    return {
      facetId: row.facet_id,
      versionId: row.version_id,
      imageDigest: row.image_digest,
      priceAtomic: row.price_atomic,
      payTo: row.pay_to,
      schemaURI: row.schema_uri,
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
      const version = await client.query(
        `update facet_versions set status = 'published', registry_verified = true,
            registry_tx_hash = $2, published_at = now(), published_by = created_by, updated_at = now()
          where id = $1::uuid and status = 'valid'`,
        [job.versionId, job.txHash],
      );
      if (version.rowCount !== 1)
        throw new Error("Actor version is not ready for promotion");
      const facet = await client.query(
        `update facets set status = 'published', visibility = 'public',
            current_published_version_id = $2::uuid, updated_at = now()
          where id = $1::uuid and status = 'draft'`,
        [job.facetId, job.versionId],
      );
      if (facet.rowCount !== 1)
        throw new Error("Actor Facet is not ready for promotion");
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
