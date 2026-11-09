CREATE TYPE "public"."facet_type" AS ENUM('external_http_api');--> statement-breakpoint
CREATE TYPE "public"."facet_visibility" AS ENUM('private', 'unlisted', 'public');--> statement-breakpoint
ALTER TYPE "public"."facet_status" ADD VALUE 'deprecated';--> statement-breakpoint
ALTER TYPE "public"."facet_version_status" ADD VALUE 'valid' BEFORE 'published';--> statement-breakpoint
ALTER TYPE "public"."facet_version_status" ADD VALUE 'disabled';--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "source_version_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "source_operation_pointer" text NOT NULL;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "manifest" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "content_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "validation_result" jsonb DEFAULT '{"status":"pending","errors":[],"warnings":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "warning_acknowledgements" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "published_by" uuid;--> statement-breakpoint
ALTER TABLE "facets" ADD COLUMN "type" "facet_type" DEFAULT 'external_http_api' NOT NULL;--> statement-breakpoint
ALTER TABLE "facets" ADD COLUMN "visibility" "facet_visibility" DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "facets" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD CONSTRAINT "facet_versions_source_version_id_api_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."api_source_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD CONSTRAINT "facet_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "facet_versions_facet_hash_uidx" ON "facet_versions" USING btree ("facet_id","content_hash");