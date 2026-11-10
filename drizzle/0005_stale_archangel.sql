CREATE TYPE "public"."endpoint_auth_kind" AS ENUM('none', 'api_key_header', 'api_key_query', 'bearer');--> statement-breakpoint
CREATE TYPE "public"."endpoint_redirect_policy" AS ENUM('deny', 'same_origin');--> statement-breakpoint
CREATE TYPE "public"."secret_kind" AS ENUM('api_key', 'bearer_token');--> statement-breakpoint
CREATE TYPE "public"."secret_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TABLE "endpoint_configs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider_id" uuid NOT NULL,
	"protected_base_url" text NOT NULL,
	"method" text NOT NULL,
	"path_template" text NOT NULL,
	"auth_kind" "endpoint_auth_kind" NOT NULL,
	"auth_template" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_ref_id" uuid,
	"timeout_ms" integer NOT NULL,
	"max_response_bytes" integer NOT NULL,
	"redirect_policy" "endpoint_redirect_policy" NOT NULL,
	"egress_policy_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_refs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider_id" uuid NOT NULL,
	"kind" "secret_kind" NOT NULL,
	"label" text NOT NULL,
	"vault_provider" text NOT NULL,
	"vault_reference" text NOT NULL,
	"status" "secret_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "endpoint_config_id" uuid;--> statement-breakpoint
ALTER TABLE "endpoint_configs" ADD CONSTRAINT "endpoint_configs_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_configs" ADD CONSTRAINT "endpoint_configs_secret_ref_id_secret_refs_id_fk" FOREIGN KEY ("secret_ref_id") REFERENCES "public"."secret_refs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_refs" ADD CONSTRAINT "secret_refs_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "endpoint_configs_provider_idx" ON "endpoint_configs" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "endpoint_configs_secret_ref_idx" ON "endpoint_configs" USING btree ("secret_ref_id");--> statement-breakpoint
CREATE INDEX "secret_refs_provider_status_idx" ON "secret_refs" USING btree ("provider_id","status");--> statement-breakpoint
ALTER TABLE "facet_versions" ADD CONSTRAINT "facet_versions_endpoint_config_id_endpoint_configs_id_fk" FOREIGN KEY ("endpoint_config_id") REFERENCES "public"."endpoint_configs"("id") ON DELETE restrict ON UPDATE no action;