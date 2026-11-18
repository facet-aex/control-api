CREATE TABLE "actor_registration_jobs" (
	"version_id" uuid PRIMARY KEY NOT NULL,
	"facet_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"schema_uri" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"signed_raw" text,
	"tx_hash" text,
	"error_code" text,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actor_registration_jobs" ADD CONSTRAINT "actor_registration_jobs_version_id_facet_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."facet_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_registration_jobs" ADD CONSTRAINT "actor_registration_jobs_facet_id_facets_id_fk" FOREIGN KEY ("facet_id") REFERENCES "public"."facets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_registration_jobs" ADD CONSTRAINT "actor_registration_jobs_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "actor_registration_provider_idempotency_uidx" ON "actor_registration_jobs" USING btree ("provider_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "actor_registration_pending_idx" ON "actor_registration_jobs" USING btree ("status","lease_expires_at","created_at");