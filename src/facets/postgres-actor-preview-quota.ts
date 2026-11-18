import { lt, sql } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { actorPreviewUsage } from "../db/schema.js";

const DAILY_LIMIT = 10;

export class PostgresActorPreviewQuota {
  constructor(private readonly database: Database["db"]) {}

  async consume(userId: string, now: Date): Promise<boolean> {
    const rows = await this.database
      .insert(actorPreviewUsage)
      .values({ userId, dayUtc: now.toISOString().slice(0, 10), count: 1 })
      .onConflictDoUpdate({
        target: [actorPreviewUsage.userId, actorPreviewUsage.dayUtc],
        set: { count: sql`${actorPreviewUsage.count} + 1` },
        setWhere: lt(actorPreviewUsage.count, DAILY_LIMIT),
      })
      .returning({ count: actorPreviewUsage.count });
    return rows.length === 1;
  }
}
