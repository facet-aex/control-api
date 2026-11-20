ALTER TABLE "facet_versions" ADD COLUMN "pricing_options" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "facet_versions" ADD COLUMN "max_items_cap" integer;
--> statement-breakpoint
UPDATE "facet_versions"
SET
  "max_items_cap" = CASE
    WHEN "pricing_model" = 'PAY_PER_RESULT' THEN 20
    ELSE NULL
  END,
  "pricing_options" = jsonb_build_array(
    jsonb_strip_nulls(
      jsonb_build_object(
        'model', "pricing_model",
        'priceAtomic', "price_atomic",
        'maxItemsCap', CASE WHEN "pricing_model" = 'PAY_PER_RESULT' THEN 20 ELSE NULL END,
        'isPrimary', true
      )
    )
  )
WHERE "pricing_options" = '[]'::jsonb;
