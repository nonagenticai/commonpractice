-- 0026_demo_tenant_fixed_id.sql — Phase 4 / C.1 follow-up: pin the demo tenant to the
-- fixed id 00000000-0000-0000-0000-000000000001.
--
-- C.1 standardised the demo/primary tenant on the fixed id …0001 (so dev-bypass, tests,
-- and the live `portal` super_admin `fr-test` — whose JWT carries tenant_id=…0001 — all
-- resolve to the same tenant). On a FRESH DB the seed creates it at …0001 directly. But a
-- DB seeded before C.1 already has the `common-practice-demo` tenant at a RANDOM id, so the
-- seed's `INSERT … ON CONFLICT (id) DO NOTHING` hits the slug-unique constraint instead and
-- errors, and `fr-test`'s claim (…0001) resolves to no tenant.
--
-- This one-time, data-driven reconciliation repoints the existing demo tenant to …0001:
-- free the slug, copy the row to …0001, repoint every reference (FK + value columns), drop
-- the legacy row. Idempotent and guarded — a no-op when …0001 already holds the demo tenant
-- or no demo tenant exists yet (the fresh-DB case: migrations run BEFORE the seed). Demo
-- data is disposable; this is forward-only, preferring repoint over wipe so the 14-day
-- usage history that backs the spend dashboard survives.

DO $$
DECLARE
  old_id uuid;
  new_id uuid := '00000000-0000-0000-0000-000000000001';
BEGIN
  SELECT id INTO old_id FROM tenants WHERE slug = 'common-practice-demo';

  IF old_id IS NOT NULL
     AND old_id <> new_id
     AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = new_id) THEN

    -- Free the unique slug, then materialise the demo tenant at the fixed id.
    UPDATE tenants SET slug = 'common-practice-demo-legacy' WHERE id = old_id;
    INSERT INTO tenants (id, name, slug, status, industry, created_at, updated_at)
      SELECT new_id, name, 'common-practice-demo', status, industry, created_at, updated_at
      FROM tenants WHERE id = old_id;

    -- Repoint every reference (uuid FK columns + the legacy TEXT/uuid value columns).
    UPDATE users            SET tenant_id = new_id        WHERE tenant_id = old_id;
    UPDATE usage_events     SET tenant_id = new_id        WHERE tenant_id = old_id;
    UPDATE mcp_api_keys     SET tenant_id = new_id        WHERE tenant_id = old_id;
    UPDATE ontology_entities  SET tenant_id = new_id      WHERE tenant_id = old_id;
    UPDATE ontology_relations SET tenant_id = new_id      WHERE tenant_id = old_id;
    UPDATE dataset_mappings SET tenant_id = new_id        WHERE tenant_id = old_id;
    UPDATE challenges       SET tenant_id = new_id        WHERE tenant_id = old_id;
    UPDATE datasets            SET tenant_id = new_id::text WHERE tenant_id = old_id::text;
    UPDATE tenant_llm_settings SET tenant_id = new_id::text WHERE tenant_id = old_id::text;

    -- The legacy tenant is now unreferenced.
    DELETE FROM tenants WHERE id = old_id;
  END IF;
END $$;
