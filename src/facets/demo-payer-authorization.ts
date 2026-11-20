import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

import type { IdentityAuthenticator } from "../auth/types.js";
import { AppError } from "../errors.js";
import type { ProviderStore } from "../providers/provider-types.js";

export interface DemoPayerTarget {
  provider: string;
  facetName: string;
  version: string;
}

export interface DemoPayerGrant {
  amountAtomic: string;
  providerPayTo: string;
  remainingToday: number;
}

export interface DemoPayerAllowance {
  authorize(
    userId: string,
    target: DemoPayerTarget,
    idempotencyKey: string,
    now: Date,
  ): Promise<DemoPayerGrant>;
}

export class PostgresDemoPayerAllowance implements DemoPayerAllowance {
  constructor(
    private readonly pool: Pool,
    private readonly maxPerDay = 3,
  ) {}

  async authorize(
    userId: string,
    target: DemoPayerTarget,
    idempotencyKey: string,
    now: Date,
  ): Promise<DemoPayerGrant> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const dayUtc = now.toISOString().slice(0, 10);
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${userId}:${dayUtc}`],
      );
      const version = await client.query<{
        version_id: string;
        price_atomic: string;
        pay_to: string;
      }>(
        `select version.id as version_id, version.price_atomic, version.pay_to
           from facet_versions as version
           join facets as facet on facet.id = version.facet_id
           join users as u on u.id = facet.provider_id
          where u.username = $1
            and facet.facet_name = $2
            and version.version = $3
            and u.status = 'active'
            and version.status = 'published'
            and version.registry_verified = true
            and version.price_atomic = '1000'
            and version.pricing_model = 'PAY_PER_RUN'
            and version.pay_to is not null
            and facet.type = 'ACTOR'
            and facet.status = 'published'
            and facet.visibility = 'public'
            and facet.current_published_version_id = version.id`,
        [target.provider, target.facetName, target.version],
      );
      const terms = version.rows[0];
      if (!terms)
        throw new AppError(
          "DEMO_VERSION_NOT_ALLOWED",
          "This Actor is outside the browser demo allowance.",
          403,
        );
      const previous = await client.query<{ facet_version_id: string }>(
        `select facet_version_id from demo_payer_authorizations
          where user_id = $1::uuid and idempotency_key = $2`,
        [userId, idempotencyKey],
      );
      if (
        previous.rows[0] &&
        previous.rows[0].facet_version_id !== terms.version_id
      ) {
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "This key was used for another Actor version.",
          409,
        );
      }
      const count = await client.query<{ count: string }>(
        `select count(*)::text as count from demo_payer_authorizations
          where user_id = $1::uuid and day_utc = $2`,
        [userId, dayUtc],
      );
      const used = Number(count.rows[0]?.count ?? "0");
      if (!previous.rows[0] && used >= this.maxPerDay) {
        throw new AppError(
          "DEMO_ALLOWANCE_EXHAUSTED",
          "Daily browser demo allowance is exhausted.",
          429,
        );
      }
      if (!previous.rows[0]) {
        await client.query(
          `insert into demo_payer_authorizations (user_id, facet_version_id, idempotency_key, day_utc)
           values ($1::uuid, $2::uuid, $3, $4)`,
          [userId, terms.version_id, idempotencyKey, dayUtc],
        );
      }
      await client.query("commit");
      return {
        amountAtomic: terms.price_atomic,
        providerPayTo: terms.pay_to,
        remainingToday: this.maxPerDay - used - (previous.rows[0] ? 0 : 1),
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function registerDemoPayerRoutes(
  app: FastifyInstance,
  dependencies: {
    authenticator: IdentityAuthenticator;
    providers: ProviderStore;
    allowance: DemoPayerAllowance;
  },
): Promise<void> {
  void dependencies;
  app.post("/v1/demo-payer/authorize", async () => {
    throw new AppError(
      "DEMO_PAYER_RETIRED",
      "Server-sponsored browser demo payments have been retired. Sign directly with your Avalanche wallet.",
      410,
    );
  });
}
