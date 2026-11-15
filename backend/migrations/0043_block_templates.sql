-- 0043_block_templates.sql — seeded starter-template catalog for the block editor.
--
-- A read-only (v1) catalog of professional STARTER blocks per category (logic / ui / ai / data).
-- Picking one in the block editor pre-fills a NEW block's descriptor + source skeleton + docs.
-- LOGIC templates also carry a PKO/PDDL-inspired formal structure (preconditions / postconditions
-- / steps) so reusable logic is captured in a standard, vertical-taggable shape — fully
-- self-contained (NO dependency on the procedure_management service; CP ships on-prem). Authored
-- as native JSON (backend/src/templates/seed/) and loaded via seed-templates.ts.
--
-- MODEL = dual ownership, identical to building_blocks (0037 §3): tenant_id IS NULL ⇒ shipped
-- global (seeded via runAsSystem); tenant_id = <uuid> ⇒ tenant-authored (reserved for a later
-- "save as template"). Reads return global ∪ own-tenant; writes own-tenant only.
--
-- FORWARD-ONLY / PROD-SAFE & ADDITIVE: new table, ENABLE (not FORCE) RLS so the owner bypasses
-- for migrations / runAsSystem, cp_app (non-owner, NOBYPASSRLS) fully bound. uuidv7() is native
-- Postgres 18 (0039). Matches src/db/schema.ts blockTemplates.

CREATE TABLE IF NOT EXISTS block_templates (
  id             UUID PRIMARY KEY DEFAULT uuidv7(),
  category       block_category NOT NULL,
  domain         TEXT,
  name           TEXT NOT NULL,
  label          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  tags           JSONB NOT NULL DEFAULT '[]'::jsonb,
  descriptor     JSONB NOT NULL,
  source_ts      TEXT NOT NULL DEFAULT '',
  docs_md        TEXT NOT NULL DEFAULT '',
  preconditions  JSONB NOT NULL DEFAULT '[]'::jsonb,
  postconditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  steps          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Dual ownership: NULL = global; DEFAULT = per-request GUC (0028 convention) so a tenant INSERT
  -- auto-stamps its tenant and a runAsSystem INSERT (no GUC) → NULL = global.
  tenant_id      UUID DEFAULT app_current_tenant_uuid() REFERENCES tenants(id) ON DELETE CASCADE,
  hidden         BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS block_templates_cat_domain_idx
  ON block_templates(category, domain);
CREATE INDEX IF NOT EXISTS block_templates_tenant_idx
  ON block_templates(tenant_id);

-- Natural-key uniqueness so the JSON seed is idempotent (coalesce over the nullable scoping
-- columns — an expression index drizzle can't express, so it lives here only). One template per
-- (category, domain, name, tenant).
CREATE UNIQUE INDEX IF NOT EXISTS block_templates_natural_uq
  ON block_templates (
    category,
    coalesce(domain, ''),
    name,
    coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- RLS = building_blocks (0037 §3): read global (NULL) + own-tenant; INSERT/UPDATE/DELETE
-- own-tenant only (WITH CHECK rejects NULL → only the owner / runAsSystem seeds global rows).
ALTER TABLE block_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS block_templates_read ON block_templates;
DROP POLICY IF EXISTS block_templates_ins ON block_templates;
DROP POLICY IF EXISTS block_templates_upd ON block_templates;
DROP POLICY IF EXISTS block_templates_del ON block_templates;
CREATE POLICY block_templates_read ON block_templates FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant_uuid());
CREATE POLICY block_templates_ins ON block_templates FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_uuid());
CREATE POLICY block_templates_upd ON block_templates FOR UPDATE
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());
CREATE POLICY block_templates_del ON block_templates FOR DELETE
  USING (tenant_id = app_current_tenant_uuid());

-- GRANT to cp_app (role-existence-guarded, like 0037 §5).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON block_templates TO cp_app;
    RAISE NOTICE '[0043] granted cp_app DML on block_templates';
  ELSE
    RAISE NOTICE '[0043] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;
