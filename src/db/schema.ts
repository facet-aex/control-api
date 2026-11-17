import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
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
  "deprecated",
]);
export const facetVersionStatus = pgEnum("facet_version_status", [
  "draft",
  "valid",
  "published",
  "disabled",
]);
export const facetType = pgEnum("facet_type", [
  "external_http_api",
  "hosted_actor",
  "autonomous_agent",
]);
export const facetVisibility = pgEnum("facet_visibility", [
  "private",
  "unlisted",
  "public",
]);
export const apiSourceKind = pgEnum("api_source_kind", [
  "upload",
  "paste",
  "url",
]);
export const apiSourceStatus = pgEnum("api_source_status", [
  "active",
  "disabled",
]);
export const openApiImportStatus = pgEnum("openapi_import_status", [
  "queued",
  "fetching",
  "parsing",
  "normalizing",
  "ready",
  "failed",
  "expired",
]);
export const secretKind = pgEnum("secret_kind", ["api_key", "bearer_token"]);
export const secretStatus = pgEnum("secret_status", ["active", "revoked"]);
export const endpointAuthKind = pgEnum("endpoint_auth_kind", [
  "none",
  "api_key_header",
  "api_key_query",
  "bearer",
]);
export const endpointRedirectPolicy = pgEnum("endpoint_redirect_policy", [
  "deny",
  "same_origin",
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
    walletVerifiedAt: timestamp("wallet_verified_at", { withTimezone: true }),
    status: providerStatus("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [uniqueIndex("providers_slug_uidx").on(table.slug)],
);

export const walletLinkChallenges = pgTable(
  "wallet_link_challenges",
  {
    id: uuid("id").primaryKey(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    message: text("message").notNull(),
    nonceHash: text("nonce_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("wallet_link_challenges_provider_user_idx").on(
      table.providerId,
      table.userId,
    ),
  ],
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

export const apiSources = pgTable(
  "api_sources",
  {
    id: uuid("id")
      .default(sql`uuidv7()`)
      .primaryKey(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    sourceKind: apiSourceKind("source_kind").notNull(),
    sourceUrl: text("source_url"),
    status: apiSourceStatus("status").notNull().default("active"),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index("api_sources_provider_created_idx").on(
      table.providerId,
      table.createdAt,
    ),
  ],
);

export const apiSourceVersions = pgTable(
  "api_source_versions",
  {
    id: uuid("id")
      .default(sql`uuidv7()`)
      .primaryKey(),
    apiSourceId: uuid("api_source_id")
      .notNull()
      .references(() => apiSources.id, { onDelete: "restrict" }),
    mediaType: text("media_type"),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    openApiVersion: text("openapi_version"),
    resolvedDocumentHash: text("resolved_document_hash"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("api_source_versions_source_hash_uidx").on(
      table.apiSourceId,
      table.sha256,
    ),
    index("api_source_versions_hash_idx").on(table.sha256),
  ],
);

export const openApiImportJobs = pgTable(
  "openapi_import_jobs",
  {
    id: uuid("id")
      .default(sql`uuidv7()`)
      .primaryKey(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    apiSourceId: uuid("api_source_id")
      .notNull()
      .references(() => apiSources.id, { onDelete: "restrict" }),
    sourceVersionId: uuid("source_version_id").references(
      () => apiSourceVersions.id,
      { onDelete: "restrict" },
    ),
    status: openApiImportStatus("status").notNull().default("queued"),
    limitsSnapshot: jsonb("limits_snapshot").notNull(),
    warnings: jsonb("warnings")
      .notNull()
      .default(sql`'[]'::jsonb`),
    errorCode: text("error_code"),
    errorSummary: text("error_summary"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("openapi_import_jobs_provider_status_created_idx").on(
      table.providerId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const importOperationCandidates = pgTable(
  "import_operation_candidates",
  {
    id: uuid("id")
      .default(sql`uuidv7()`)
      .primaryKey(),
    importJobId: uuid("import_job_id")
      .notNull()
      .references(() => openApiImportJobs.id, { onDelete: "cascade" }),
    jsonPointer: text("json_pointer").notNull(),
    operationId: text("operation_id"),
    method: text("method").notNull(),
    pathTemplate: text("path_template").notNull(),
    summary: text("summary"),
    normalizedCandidate: jsonb("normalized_candidate").notNull(),
    warnings: jsonb("warnings")
      .notNull()
      .default(sql`'[]'::jsonb`),
  },
  (table) => [
    uniqueIndex("import_operation_candidates_job_pointer_uidx").on(
      table.importJobId,
      table.jsonPointer,
    ),
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
    type: facetType("type").notNull().default("external_http_api"),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull(),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    status: facetStatus("status").notNull().default("draft"),
    visibility: facetVisibility("visibility").notNull().default("private"),
    currentPublishedVersionId: uuid("current_published_version_id").references(
      (): AnyPgColumn => facetVersions.id,
      { onDelete: "restrict" },
    ),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("facets_provider_slug_uidx").on(table.providerId, table.slug),
    index("facets_status_idx").on(table.status),
  ],
);

export const secretRefs = pgTable(
  "secret_refs",
  {
    id: uuid("id")
      .default(sql`uuidv7()`)
      .primaryKey(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    kind: secretKind("kind").notNull(),
    label: text("label").notNull(),
    vaultProvider: text("vault_provider").notNull(),
    vaultReference: text("vault_reference").notNull(),
    status: secretStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    index("secret_refs_provider_status_idx").on(table.providerId, table.status),
  ],
);

export const endpointConfigs = pgTable(
  "endpoint_configs",
  {
    id: uuid("id")
      .default(sql`uuidv7()`)
      .primaryKey(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "restrict" }),
    protectedBaseUrl: text("protected_base_url").notNull(),
    method: text("method").notNull(),
    pathTemplate: text("path_template").notNull(),
    authKind: endpointAuthKind("auth_kind").notNull(),
    authTemplate: jsonb("auth_template")
      .notNull()
      .default(sql`'{}'::jsonb`),
    secretRefId: uuid("secret_ref_id").references(() => secretRefs.id, {
      onDelete: "restrict",
    }),
    timeoutMs: integer("timeout_ms").notNull(),
    maxResponseBytes: integer("max_response_bytes").notNull(),
    redirectPolicy: endpointRedirectPolicy("redirect_policy").notNull(),
    egressPolicyId: text("egress_policy_id").notNull(),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    index("endpoint_configs_provider_idx").on(table.providerId),
    index("endpoint_configs_secret_ref_idx").on(table.secretRefId),
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
    displayVersion: text("version").notNull(),
    status: facetVersionStatus("status").notNull().default("draft"),
    sourceVersionId: uuid("source_version_id")
      .notNull()
      .references(() => apiSourceVersions.id, { onDelete: "restrict" }),
    sourceOperationPointer: text("source_operation_pointer").notNull(),
    manifest: jsonb("manifest").notNull(),
    contentHash: text("content_hash").notNull(),
    validationResult: jsonb("validation_result")
      .notNull()
      .default(sql`'{"status":"pending","errors":[],"warnings":[]}'::jsonb`),
    warningAcknowledgements: jsonb("warning_acknowledgements")
      .notNull()
      .default(sql`'[]'::jsonb`),
    endpointConfigId: uuid("endpoint_config_id").references(
      () => endpointConfigs.id,
      { onDelete: "restrict" },
    ),
    operation: jsonb("operation").notNull(),
    inputSchema: jsonb("input_schema").notNull(),
    outputSchema: jsonb("output_schema").notNull(),
    actorCode: text("actor_code"),
    imageDigest: text("image_digest"),
    pricingModel: text("pricing_model").notNull().default("PAY_PER_RUN"),
    priceAtomic: text("price_atomic").notNull().default("1000"),
    payTo: text("pay_to"),
    erc8004TokenId: text("erc8004_token_id"),
    erc8004Registry: text("erc8004_registry"),
    agentTaskKind: text("agent_task_kind"),
    registryTxHash: text("registry_tx_hash"),
    registryVerified: boolean("registry_verified").notNull().default(false),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    version: integer("revision").notNull().default(1),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    publishedBy: uuid("published_by").references(() => users.id, {
      onDelete: "restrict",
    }),
  },
  (table) => [
    uniqueIndex("facet_versions_facet_version_uidx").on(
      table.facetId,
      table.displayVersion,
    ),
    uniqueIndex("facet_versions_facet_hash_uidx").on(
      table.facetId,
      table.contentHash,
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
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    claimToken: uuid("claim_token"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [
    index("outbox_events_unprocessed_idx").on(
      table.processedAt,
      table.availableAt,
      table.leaseExpiresAt,
      table.createdAt,
    ),
  ],
);
