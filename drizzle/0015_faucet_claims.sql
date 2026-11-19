CREATE TABLE "faucet_claims" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"recipient_address" text NOT NULL,
	"ip_hash" text NOT NULL,
	"amount_atomic" text NOT NULL,
	"tx_hash" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "faucet_claims_recipient_claimed_idx" ON "faucet_claims" USING btree ("recipient_address","claimed_at");
--> statement-breakpoint
CREATE INDEX "faucet_claims_ip_claimed_idx" ON "faucet_claims" USING btree ("ip_hash","claimed_at");
