CREATE TABLE "demo_payer_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"facet_version_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"day_utc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demo_payer_authorizations" ADD CONSTRAINT "demo_payer_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_payer_authorizations" ADD CONSTRAINT "demo_payer_authorizations_facet_version_id_facet_versions_id_fk" FOREIGN KEY ("facet_version_id") REFERENCES "public"."facet_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demo_payer_user_key_uidx" ON "demo_payer_authorizations" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "demo_payer_user_day_idx" ON "demo_payer_authorizations" USING btree ("user_id","day_utc");