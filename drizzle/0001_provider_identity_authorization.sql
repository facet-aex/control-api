CREATE TYPE "public"."provider_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "facet_versions" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "facets" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "outbox_events" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "providers" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT uuidv7();--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "request_id" text DEFAULT 'migration:0001' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "request_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "topic" text DEFAULT 'legacy.events' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_events" ALTER COLUMN "topic" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_memberships" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "website_url" text;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "contact" text;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "status" "provider_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" "user_status" DEFAULT 'active' NOT NULL;
