-- 0037_tenant_blocks.sql — Phase 2 of the ontology-data-blocks plan: tenant-scoped building blocks.
--
-- building_blocks (+ block_versions / block_tests / block_test_results) is platform-global today:
-- no tenant_id, explicitly OUTSIDE RLS (0028 left it in the platform allowlist), slug globally UNIQUE,
-- all writes super_admin-only. The product needs tenant DEVELOPERS to author their own blocks alongside
-- the platform-shipped ones, with provable isolation. This is the foundation Phase 3 builds on
-- (ontology→data-block derivation materializes tenant-scoped data blocks).
--
-- MODEL = dual ownership, mirroring 0028 §4c "nullable global-override" (as used for ontology_entities):
--   building_blocks.tenant_id IS NULL  ⇒ platform/global (shipped, seeded via runAsSystem)
--   building_blocks.tenant_id = <uuid> ⇒ tenant-authored
-- Reads return global ∪ own-tenant; writes are own-tenant only (global writes go through the owner /
-- runAsSystem path, which bypasses RLS). The three child tables carry no own tenant_id and are scoped
-- 0028 §4d (child-via-parent EXISTS) — a child row is visible iff its parent block/version is visible.
--
-- FORWARD-ONLY / PROD-SAFE & ADDITIVE: nullable column (existing rows → NULL = global, the correct
-- default), ENABLE (not FORCE) RLS so the owner bypasses for migrations / runAsSystem, cp_app
-- (non-owner, NOBYPASSRLS) fully bound. Zero behaviour change until a developer actually authors a block.

-- 1. Dual-ownership column. NULL = global; DEFAULT = per-request GUC (0028 convention), so a developer
--    INSERT auto-stamps their tenant and a runAsSystem INSERT (no GUC) → NULL = global.
ALTER TABLE building_blocks
  ADD COLUMN IF NOT EXISTS tenant_id uuid DEFAULT app_current_tenant_uuid()
    REFERENCES tenants(id) ON DELETE CASCADE;

-- 2. Slug uniqueness → per-owner. Drop the global UNIQUE (inline-named building_blocks_slug_key) and add
--    a coalesce expression index (sentinel zero-UUID for NULL global rows), exactly like
--    ontology_entities_natural_uq (0018). Global rows share one slot; each tenant gets its own slot.
--    (v1 still forbids a tenant REUSING a global slug at the app layer — routes/blocks.ts — so within a
--    tenant's RLS view slug stays unique; the index only permits cross-tenant slug reuse.)
ALTER TABLE building_blocks DROP CONSTRAINT IF EXISTS building_blocks_slug_key;
CREATE UNIQUE INDEX IF NOT EXISTS building_blocks_slug_owner_uq
  ON building_blocks (slug, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX IF NOT EXISTS building_blocks_tenant_idx ON building_blocks (tenant_id);

-- 3. RLS on building_blocks = 0028 §4c (nullable global-override). Read global (NULL) + own-tenant;
--    INSERT/UPDATE/DELETE own-tenant only (WITH CHECK rejects NULL → only the owner/runAsSystem seeds
--    global rows). Verbatim shape from the 0028 ontology_entities policies.
ALTER TABLE building_blocks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS building_blocks_read ON building_blocks;
DROP POLICY IF EXISTS building_blocks_ins ON building_blocks;
DROP POLICY IF EXISTS building_blocks_upd ON building_blocks;
DROP POLICY IF EXISTS building_blocks_del ON building_blocks;
CREATE POLICY building_blocks_read ON building_blocks FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant_uuid());
CREATE POLICY building_blocks_ins ON building_blocks FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_uuid());
CREATE POLICY building_blocks_upd ON building_blocks FOR UPDATE
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());
CREATE POLICY building_blocks_del ON building_blocks FOR DELETE
  USING (tenant_id = app_current_tenant_uuid());

-- 4. RLS on the 3 children = 0028 §4d (child-via-parent EXISTS). No own tenant_id; a child is visible iff
--    its parent is. block_test_results→block_versions→building_blocks chains automatically (the EXISTS on
--    block_versions itself respects block_versions' own 4d policy, which respects building_blocks §4c).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('block_versions','building_blocks','block_id'),
    ('block_tests','building_blocks','block_id'),
    ('block_test_results','block_versions','version_id')
  ) AS v(child, parent, fk) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.child);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.child || '_via_parent', r.child);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I)) WITH CHECK (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I))',
      r.child || '_via_parent', r.child, r.parent, r.child, r.fk, r.parent, r.child, r.fk);
  END LOOP;
END $$;

-- 5. GRANT to cp_app (role-existence-guarded, like 0028 §5 / 0036). These tables were outside RLS so
--    cp_app already had owner default-privileges; grant explicitly so they are self-contained post-RLS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      building_blocks, block_versions, block_tests, block_test_results TO cp_app;
    RAISE NOTICE '[0037] granted cp_app DML on building_blocks + 3 children';
  ELSE
    RAISE NOTICE '[0037] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;
