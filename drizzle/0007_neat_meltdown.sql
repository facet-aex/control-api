ALTER TYPE "public"."facet_type" ADD VALUE 'hosted_actor';--> statement-breakpoint
ALTER TYPE "public"."facet_type" ADD VALUE 'autonomous_agent';--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "actor_code" text;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "image_digest" text;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "pricing_model" text DEFAULT 'PAY_PER_RUN' NOT NULL;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "price_atomic" text DEFAULT '1000' NOT NULL;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "pay_to" text;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "erc8004_token_id" text;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "erc8004_registry" text;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "agent_task_kind" text;--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "registry_tx_hash" text;