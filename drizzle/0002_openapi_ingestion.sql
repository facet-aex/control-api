CREATE TYPE "public"."api_source_kind" AS ENUM('upload', 'paste', 'url');--> statement-breakpoint
CREATE TYPE "public"."api_source_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."openapi_import_status" AS ENUM('queued', 'fetching', 'parsing', 'normalizing', 'ready', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "api_source_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"api_source_id" uuid NOT NULL,
	"media_type" text,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"openapi_version" text,
	"resolved_document_hash" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_sources" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_kind" "api_source_kind" NOT NULL,
	"source_url" text,
	"status" "api_source_status" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_operation_candidates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"import_job_id" uuid NOT NULL,
	"json_pointer" text NOT NULL,
	"operation_id" text,
	"method" text NOT NULL,
	"path_template" text NOT NULL,
	"summary" text,
	"normalized_candidate" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openapi_import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider_id" uuid NOT NULL,
	"api_source_id" uuid NOT NULL,
	"source_version_id" uuid,
	"status" "openapi_import_status" DEFAULT 'queued' NOT NULL,
	"limits_snapshot" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_code" text,
	"error_summary" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_source_versions" ADD CONSTRAINT "api_source_versions_api_source_id_api_sources_id_fk" FOREIGN KEY ("api_source_id") REFERENCES "public"."api_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_source_versions" ADD CONSTRAINT "api_source_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_sources" ADD CONSTRAINT "api_sources_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_operation_candidates" ADD CONSTRAINT "import_operation_candidates_import_job_id_openapi_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."openapi_import_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openapi_import_jobs" ADD CONSTRAINT "openapi_import_jobs_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openapi_import_jobs" ADD CONSTRAINT "openapi_import_jobs_api_source_id_api_sources_id_fk" FOREIGN KEY ("api_source_id") REFERENCES "public"."api_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openapi_import_jobs" ADD CONSTRAINT "openapi_import_jobs_source_version_id_api_source_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."api_source_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openapi_import_jobs" ADD CONSTRAINT "openapi_import_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_source_versions_source_hash_uidx" ON "api_source_versions" USING btree ("api_source_id","sha256");--> statement-breakpoint
CREATE INDEX "api_source_versions_hash_idx" ON "api_source_versions" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "api_sources_provider_created_idx" ON "api_sources" USING btree ("provider_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_operation_candidates_job_pointer_uidx" ON "import_operation_candidates" USING btree ("import_job_id","json_pointer");--> statement-breakpoint
CREATE INDEX "openapi_import_jobs_provider_status_created_idx" ON "openapi_import_jobs" USING btree ("provider_id","status","created_at");
