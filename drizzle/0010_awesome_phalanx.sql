CREATE TABLE "actor_preview_usage" (
	"user_id" uuid NOT NULL,
	"day_utc" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "actor_preview_usage_user_id_day_utc_pk" PRIMARY KEY("user_id","day_utc")
);
--> statement-breakpoint
ALTER TABLE "actor_preview_usage" ADD CONSTRAINT "actor_preview_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;