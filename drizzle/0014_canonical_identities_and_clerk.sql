ALTER TABLE "users" ADD COLUMN "wallet_address" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "wallet_verified_at" timestamp with time zone;--> statement-breakpoint
DO $$
DECLARE
  p_rec record;
  u_rec record;
  f_rec record;
  v_rec record;
  target_user uuid;
  owned_slug text;
  candidate text;
  final_name text;
  ver_str text;
  minor_bump int;
  old_manifest jsonb;
  new_type text;
  owner_username text;
BEGIN
  CREATE TEMP TABLE _provider_to_user (
    provider_id uuid PRIMARY KEY,
    user_id uuid NOT NULL
  ) ON COMMIT DROP;

  FOR p_rec IN
    SELECT p.id, p.slug, p.wallet_address, p.wallet_verified_at, p.created_at
    FROM "providers" p
    ORDER BY p.created_at ASC, p.id ASC
  LOOP
    SELECT pm.user_id INTO target_user
    FROM "provider_memberships" pm
    WHERE pm.provider_id = p_rec.id
    ORDER BY
      CASE pm.role
        WHEN 'owner' THEN 0
        WHEN 'admin' THEN 1
        WHEN 'developer' THEN 2
        ELSE 3
      END,
      pm.created_at ASC,
      pm.user_id ASC
    LIMIT 1;

    IF target_user IS NULL THEN
      SELECT j.created_by INTO target_user
      FROM "openapi_import_jobs" j
      WHERE j.provider_id = p_rec.id
      ORDER BY j.created_at ASC
      LIMIT 1;
    END IF;

    IF target_user IS NULL THEN
      SELECT fv.created_by INTO target_user
      FROM "facets" f
      JOIN "facet_versions" fv ON fv.facet_id = f.id
      WHERE f.provider_id = p_rec.id
      ORDER BY fv.created_at ASC
      LIMIT 1;
    END IF;

    IF target_user IS NULL THEN
      SELECT u.id INTO target_user
      FROM "users" u
      WHERE u.username = p_rec.slug
      LIMIT 1;
    END IF;

    IF target_user IS NULL THEN
      INSERT INTO "users" ("external_subject", "username", "status")
      VALUES ('migrated:' || p_rec.id::text, NULL, 'disabled')
      RETURNING "id" INTO target_user;
    END IF;

    INSERT INTO _provider_to_user (provider_id, user_id)
    VALUES (p_rec.id, target_user);
  END LOOP;

  -- Backfill wallet proof onto users from their primary owned provider.
  FOR u_rec IN SELECT id FROM "users" LOOP
    SELECT p.wallet_address, p.wallet_verified_at
    INTO p_rec
    FROM _provider_to_user m
    JOIN "providers" p ON p.id = m.provider_id
    LEFT JOIN "provider_memberships" pm
      ON pm.provider_id = p.id AND pm.user_id = u_rec.id
    WHERE m.user_id = u_rec.id
      AND p.wallet_address IS NOT NULL
    ORDER BY
      (p.wallet_verified_at IS NOT NULL) DESC,
      CASE COALESCE(pm.role::text, 'owner') WHEN 'owner' THEN 0 ELSE 1 END,
      p.wallet_verified_at DESC NULLS LAST,
      p.created_at ASC
    LIMIT 1;

    IF FOUND AND p_rec.wallet_address IS NOT NULL THEN
      UPDATE "users"
      SET "wallet_address" = p_rec.wallet_address,
          "wallet_verified_at" = p_rec.wallet_verified_at
      WHERE "id" = u_rec.id;
    END IF;
  END LOOP;

  -- Normalize all users.username values to unique 8-16 char lowercase kebab-case.
  CREATE TEMP TABLE _assigned_usernames (
    user_id uuid PRIMARY KEY,
    username text NOT NULL UNIQUE
  ) ON COMMIT DROP;

  FOR u_rec IN
    SELECT id, external_subject, username, created_at
    FROM "users"
    ORDER BY created_at ASC, id ASC
  LOOP
    SELECT p.slug INTO owned_slug
    FROM _provider_to_user m
    JOIN "providers" p ON p.id = m.provider_id
    WHERE m.user_id = u_rec.id
    ORDER BY p.created_at ASC, p.id ASC
    LIMIT 1;

    candidate := NULL;
    IF u_rec.username IS NOT NULL
       AND char_length(u_rec.username) BETWEEN 8 AND 16
       AND u_rec.username ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
       AND NOT EXISTS (SELECT 1 FROM _assigned_usernames a WHERE a.username = u_rec.username)
    THEN
      candidate := u_rec.username;
    ELSIF owned_slug IS NOT NULL
       AND char_length(owned_slug) BETWEEN 8 AND 16
       AND owned_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
       AND NOT EXISTS (SELECT 1 FROM _assigned_usernames a WHERE a.username = owned_slug)
    THEN
      candidate := owned_slug;
    ELSE
      candidate := COALESCE(
        NULLIF(u_rec.username, ''),
        owned_slug,
        NULLIF(regexp_replace(u_rec.external_subject, '^local:', ''), ''),
        'facet-user'
      );
      candidate := lower(candidate);
      candidate := regexp_replace(candidate, '[^a-z0-9]+', '-', 'g');
      candidate := regexp_replace(candidate, '-{2,}', '-', 'g');
      candidate := regexp_replace(candidate, '^-+|-+$', '', 'g');
      IF candidate = '' THEN
        candidate := 'facet-user';
      END IF;
      IF char_length(candidate) > 16 THEN
        candidate := regexp_replace(left(candidate, 16), '-+$', '');
      END IF;
      IF char_length(candidate) < 8 THEN
        candidate := candidate || '-' || left(md5(u_rec.id::text), GREATEST(2, 8 - char_length(candidate) - 1));
        candidate := regexp_replace(left(candidate, 16), '^-+|-+$', '', 'g');
        IF char_length(candidate) < 8 OR candidate !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' THEN
          candidate := 'u-' || left(md5(u_rec.id::text), 8);
        END IF;
      END IF;
    END IF;

    final_name := candidate;
    WHILE EXISTS (SELECT 1 FROM _assigned_usernames a WHERE a.username = final_name) LOOP
      final_name := COALESCE(NULLIF(regexp_replace(left(candidate, 9), '^-+|-+$', '', 'g'), ''), 'u') || '-' || left(md5(u_rec.id::text || final_name), 6);
      IF char_length(final_name) < 8 THEN
        final_name := 'u-' || left(md5(u_rec.id::text || final_name), 10);
      END IF;
    END LOOP;

    INSERT INTO _assigned_usernames (user_id, username) VALUES (u_rec.id, final_name);
    UPDATE "users" SET "username" = final_name WHERE "id" = u_rec.id;
  END LOOP;

  -- Repoint all provider_id FKs from providers(id) to users(id).
  ALTER TABLE "api_sources" DROP CONSTRAINT IF EXISTS "api_sources_provider_id_providers_id_fk";
  ALTER TABLE "openapi_import_jobs" DROP CONSTRAINT IF EXISTS "openapi_import_jobs_provider_id_providers_id_fk";
  ALTER TABLE "secret_refs" DROP CONSTRAINT IF EXISTS "secret_refs_provider_id_providers_id_fk";
  ALTER TABLE "endpoint_configs" DROP CONSTRAINT IF EXISTS "endpoint_configs_provider_id_providers_id_fk";
  ALTER TABLE "audit_events" DROP CONSTRAINT IF EXISTS "audit_events_provider_id_providers_id_fk";
  ALTER TABLE "actor_registration_jobs" DROP CONSTRAINT IF EXISTS "actor_registration_jobs_provider_id_providers_id_fk";
  ALTER TABLE "facets" DROP CONSTRAINT IF EXISTS "facets_provider_id_providers_id_fk";
  ALTER TABLE "wallet_link_challenges" DROP CONSTRAINT IF EXISTS "wallet_link_challenges_provider_id_providers_id_fk";

  UPDATE "api_sources" s SET "provider_id" = m.user_id FROM _provider_to_user m WHERE s."provider_id" = m.provider_id;
  UPDATE "openapi_import_jobs" j SET "provider_id" = m.user_id FROM _provider_to_user m WHERE j."provider_id" = m.provider_id;
  UPDATE "secret_refs" sr SET "provider_id" = m.user_id FROM _provider_to_user m WHERE sr."provider_id" = m.provider_id;
  UPDATE "endpoint_configs" ec SET "provider_id" = m.user_id FROM _provider_to_user m WHERE ec."provider_id" = m.provider_id;
  UPDATE "audit_events" ae SET "provider_id" = m.user_id FROM _provider_to_user m WHERE ae."provider_id" = m.provider_id;

  -- Disambiguate any actor_registration_jobs idempotency_key collision before repointing.
  FOR f_rec IN
    SELECT arj.version_id, m.user_id, arj.idempotency_key
    FROM "actor_registration_jobs" arj
    JOIN _provider_to_user m ON m.provider_id = arj.provider_id
    ORDER BY arj.created_at ASC, arj.version_id ASC
  LOOP
    IF EXISTS (
      SELECT 1 FROM "actor_registration_jobs" other
      JOIN _provider_to_user om ON om.provider_id = other.provider_id
      WHERE other.version_id <> f_rec.version_id
        AND om.user_id = f_rec.user_id
        AND other.idempotency_key = f_rec.idempotency_key
        AND (other.created_at < (SELECT created_at FROM "actor_registration_jobs" WHERE version_id = f_rec.version_id)
             OR other.version_id < f_rec.version_id)
    ) THEN
      UPDATE "actor_registration_jobs"
      SET "idempotency_key" = f_rec.idempotency_key || ':' || left(md5(f_rec.version_id::text), 8)
      WHERE "version_id" = f_rec.version_id;
    END IF;
  END LOOP;
  UPDATE "actor_registration_jobs" arj SET "provider_id" = m.user_id FROM _provider_to_user m WHERE arj."provider_id" = m.provider_id;

  -- Normalize facets.slug -> 4-32 char kebab-case and repoint facets.provider_id without losing facets.id.
  DROP INDEX IF EXISTS "facets_provider_slug_uidx";
  UPDATE "facets" f SET "provider_id" = m.user_id FROM _provider_to_user m WHERE f."provider_id" = m.provider_id;

  CREATE TEMP TABLE _assigned_facet_names (
    facet_id uuid PRIMARY KEY,
    provider_id uuid NOT NULL,
    facet_name text NOT NULL,
    UNIQUE (provider_id, facet_name)
  ) ON COMMIT DROP;

  FOR f_rec IN SELECT id, provider_id, slug, created_at FROM "facets" ORDER BY created_at ASC, id ASC LOOP
    IF f_rec.slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' AND char_length(f_rec.slug) BETWEEN 4 AND 32 THEN
      candidate := f_rec.slug;
    ELSE
      candidate := lower(f_rec.slug);
      candidate := regexp_replace(candidate, '[^a-z0-9]+', '-', 'g');
      candidate := regexp_replace(candidate, '-{2,}', '-', 'g');
      candidate := regexp_replace(candidate, '^-+|-+$', '', 'g');
      IF char_length(candidate) > 32 THEN
        candidate := regexp_replace(left(candidate, 32), '-+$', '');
      END IF;
      IF char_length(candidate) < 4 THEN
        candidate := COALESCE(NULLIF(candidate, ''), 'facet') || '-' || left(md5(f_rec.id::text), 4);
        candidate := left(candidate, 32);
      END IF;
    END IF;

    final_name := candidate;
    WHILE EXISTS (
      SELECT 1 FROM _assigned_facet_names af
      WHERE af.provider_id = f_rec.provider_id AND af.facet_name = final_name
    ) LOOP
      final_name := regexp_replace(left(candidate, 25), '-+$', '') || '-' || left(md5(f_rec.id::text || final_name), 6);
    END LOOP;

    INSERT INTO _assigned_facet_names (facet_id, provider_id, facet_name)
    VALUES (f_rec.id, f_rec.provider_id, final_name);
    UPDATE "facets" SET "slug" = final_name WHERE "id" = f_rec.id;
  END LOOP;

  -- Normalize facet_versions.version to strict SemVer MAJOR.MINOR.PATCH without losing version ids.
  DROP INDEX IF EXISTS "facet_versions_facet_version_uidx";
  CREATE TEMP TABLE _assigned_semver (
    version_id uuid PRIMARY KEY,
    facet_id uuid NOT NULL,
    version text NOT NULL,
    UNIQUE (facet_id, version)
  ) ON COMMIT DROP;

  FOR v_rec IN SELECT id, facet_id, version, created_at FROM "facet_versions" ORDER BY created_at ASC, id ASC LOOP
    IF v_rec.version ~ '^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$' THEN
      ver_str := v_rec.version;
    ELSIF v_rec.version ~ '^v?[0-9]+$' THEN
      ver_str := (regexp_replace(v_rec.version, '^v', ''))::int::text || '.0.0';
    ELSIF v_rec.version ~ '^v?[0-9]+\.[0-9]+$' THEN
      ver_str := split_part(regexp_replace(v_rec.version, '^v', ''), '.', 1)::int::text
        || '.' || split_part(regexp_replace(v_rec.version, '^v', ''), '.', 2)::int::text
        || '.0';
    ELSIF v_rec.version ~ '^v?[0-9]+\.[0-9]+\.[0-9]+$' THEN
      ver_str := split_part(regexp_replace(v_rec.version, '^v', ''), '.', 1)::int::text
        || '.' || split_part(regexp_replace(v_rec.version, '^v', ''), '.', 2)::int::text
        || '.' || split_part(regexp_replace(v_rec.version, '^v', ''), '.', 3)::int::text;
    ELSE
      ver_str := '1.0.0';
    END IF;

    minor_bump := 0;
    WHILE EXISTS (
      SELECT 1 FROM _assigned_semver s WHERE s.facet_id = v_rec.facet_id AND s.version = ver_str
    ) LOOP
      minor_bump := minor_bump + 1;
      ver_str := split_part(ver_str, '.', 1) || '.' || split_part(ver_str, '.', 2) || '.' || (split_part(ver_str, '.', 3)::int + 1)::text;
    END LOOP;

    INSERT INTO _assigned_semver (version_id, facet_id, version) VALUES (v_rec.id, v_rec.facet_id, ver_str);
    UPDATE "facet_versions" SET "version" = ver_str WHERE "id" = v_rec.id;
  END LOOP;

  -- Backfill facet_versions.manifest JSONB cleanly to Option B + uppercase type.
  FOR v_rec IN
    SELECT fv.id, fv.manifest, fv.version, f.id as fid, f.type::text as ftype, f.slug as fname, f.name as fdname, u.id as uid, u.username
    FROM "facet_versions" fv
    JOIN "facets" f ON f.id = fv.facet_id
    JOIN "users" u ON u.id = f.provider_id
  LOOP
    old_manifest := v_rec.manifest;
    new_type := CASE v_rec.ftype
      WHEN 'hosted_actor' THEN 'ACTOR'
      WHEN 'autonomous_agent' THEN 'AGENT'
      WHEN 'ACTOR' THEN 'ACTOR'
      WHEN 'AGENT' THEN 'AGENT'
      ELSE 'API'
    END;
    owner_username := v_rec.username;
    old_manifest := (old_manifest - 'name' - 'slug' - 'displayVersion') || jsonb_build_object(
      'providerId', v_rec.uid::text,
      'provider', owner_username,
      'facetName', v_rec.fname,
      'facetDisplayName', COALESCE(old_manifest->>'facetDisplayName', old_manifest->>'name', v_rec.fdname),
      'version', v_rec.version,
      'type', new_type
    );
    UPDATE "facet_versions" SET "manifest" = old_manifest WHERE "id" = v_rec.id;
  END LOOP;
END $$;--> statement-breakpoint
CREATE TYPE "public"."facet_type_v2" AS ENUM('API', 'ACTOR', 'AGENT');--> statement-breakpoint
ALTER TABLE "facets" ALTER COLUMN "type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "facets" ALTER COLUMN "type" TYPE "public"."facet_type_v2" USING (
  CASE "type"::text
    WHEN 'external_http_api' THEN 'API'::"public"."facet_type_v2"
    WHEN 'hosted_actor' THEN 'ACTOR'::"public"."facet_type_v2"
    WHEN 'autonomous_agent' THEN 'AGENT'::"public"."facet_type_v2"
    WHEN 'API' THEN 'API'::"public"."facet_type_v2"
    WHEN 'ACTOR' THEN 'ACTOR'::"public"."facet_type_v2"
    WHEN 'AGENT' THEN 'AGENT'::"public"."facet_type_v2"
    ELSE 'API'::"public"."facet_type_v2"
  END
);--> statement-breakpoint
DROP TYPE "public"."facet_type";--> statement-breakpoint
ALTER TYPE "public"."facet_type_v2" RENAME TO "facet_type";--> statement-breakpoint
ALTER TABLE "facets" ALTER COLUMN "type" SET DEFAULT 'API';--> statement-breakpoint
DROP INDEX IF EXISTS "users_external_subject_uidx";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "external_subject" TO "clerk_id";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "email";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "display_name";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_clerk_id_uidx" ON "users" USING btree ("clerk_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_format_chk" CHECK (char_length("username") between 8 and 16 and "username" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');--> statement-breakpoint
DROP INDEX IF EXISTS "wallet_link_challenges_provider_user_idx";--> statement-breakpoint
ALTER TABLE "wallet_link_challenges" DROP COLUMN "provider_id";--> statement-breakpoint
CREATE INDEX "wallet_link_challenges_user_idx" ON "wallet_link_challenges" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "facets" RENAME COLUMN "slug" TO "facet_name";--> statement-breakpoint
ALTER TABLE "facets" RENAME COLUMN "name" TO "facet_display_name";--> statement-breakpoint
ALTER TABLE "facets" RENAME COLUMN "version" TO "revision";--> statement-breakpoint
CREATE UNIQUE INDEX "facets_provider_facet_name_uidx" ON "facets" USING btree ("provider_id","facet_name");--> statement-breakpoint
CREATE UNIQUE INDEX "facet_versions_facet_version_uidx" ON "facet_versions" USING btree ("facet_id","version");--> statement-breakpoint
ALTER TABLE "api_sources" RENAME COLUMN "version" TO "revision";--> statement-breakpoint
ALTER TABLE "endpoint_configs" RENAME COLUMN "version" TO "revision";--> statement-breakpoint
ALTER TABLE "facets" ADD CONSTRAINT "facets_provider_id_users_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_sources" ADD CONSTRAINT "api_sources_provider_id_users_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openapi_import_jobs" ADD CONSTRAINT "openapi_import_jobs_provider_id_users_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_refs" ADD CONSTRAINT "secret_refs_provider_id_users_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_configs" ADD CONSTRAINT "endpoint_configs_provider_id_users_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actor_registration_jobs" ADD CONSTRAINT "actor_registration_jobs_provider_id_users_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_provider_id_users_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
DROP TABLE "provider_memberships";--> statement-breakpoint
DROP TABLE "providers";--> statement-breakpoint
DROP TYPE "public"."provider_role";--> statement-breakpoint
DROP TYPE "public"."provider_status";
