import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
};

export const providerRole = pgEnum("provider_role", [
  "owner",
  "admin",
  "developer",
  "viewer",
]);
export const userStatus = pgEnum("user_status", ["active", "disabled"]);
export const providerStatus = pgEnum("provider_status", ["active", "disabled"]);
export const facetStatus = pgEnum("facet_status", [
  "draft",
  "published",
  "disabled",
]);
export const facetVersionStatus = pgEnum("facet_version_status", [
  "draft",
  "published",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id")
      .default(sql`uuidv7()`)
      .primaryKey(),
    externalSubject: text("external_subject").notNull(),
    email: text("email"),
    displayName: text("display_name"),
    status: userStatus("status").notNull().default("active"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("users_external_subject_uidx").on(table.externalSubject),
  ],
);

export const providers = pgTable(
  "providers",
  {
    id: uuid("id")
      .default(sql`uuidv7()`)
      .primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    websiteUrl: text("website_url"),
    contact: text("contact"),
    walletAddress: text("wallet_address"),
    status: providerStatus("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [uniqueIndex("providers_slug_uidx").on(table.slug)],
);

export const providerMemberships = pgTable(
  "provider_memberships",
  {
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: providerRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.providerId, table.userId] }),
    index("provider_memberships_user_idx").on(table.userId),
  ],
);

export const facets = pgTable(
  "facets",
  {
    id: uuid("id")
      .default(sql`uuidv7()`)
      .primaryKey(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull(),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    status: facetStatus("status").notNull().default("draft"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("facets_provider_slug_uidx").on(table.providerId, table.slug),
    index("facets_status_idx").on(table.status),
  ],
);

export const facetVersions = pgTable(
  "facet_versions",
  {
    id: uuid("id")
      .default(sql`uuidv7()`)
      .primaryKey(),
    facetId: uuid("facet_id")
      .notNull()
      .references(() => facets.id, { onDelete: "restrict" }),
    version: text("version").notNull(),
    status: facetVersionStatus("status").notNull().default("draft"),
    operation: jsonb("operation").notNull(),
    inputSchema: jsonb("input_schema").notNull(),
    outputSchema: jsonb("output_schema").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("facet_versions_facet_version_uidx").on(
      table.facetId,
      table.version,
    ),
    index("facet_versions_status_idx").on(table.status),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id")
      .default(sql`uuidv7()`)
      .primaryKey(),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    providerId: uuid("provider_id").references(() => providers.id, {
      onDelete: "set null",
    }),
    eventType: text("event_type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    requestId: text("request_id").notNull(),
    metadata: jsonb("metadata")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_events_provider_created_idx").on(
      table.providerId,
      table.createdAt,
    ),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id")
      .default(sql`uuidv7()`)
      .primaryKey(),
    topic: text("topic").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
  },
  (table) => [
    index("outbox_events_unprocessed_idx").on(
      table.processedAt,
      table.createdAt,
    ),
  ],
);
