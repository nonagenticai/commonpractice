-- 0108 — flow templates: whole FLOWS (graph of blocks) a reader can start from on /build.
--
-- Until now the builder's empty-canvas "Pick a template" card linked to /solutions, because the only
-- templates in the product were BLOCK scaffolds (block_templates, 0043). This table is the flow-level
-- sibling:
--   • tenant_id IS NULL  ⇒ a platform STARTER, seeded from src/templates/flow-seed/*.json (keyed by
--                          seed_key) or saved by a super_admin with scope=global. Readable by every tenant.
--   • tenant_id = <uuid> ⇒ an organisation template, saved by a developer / tenant_admin from their
--                          own flow. Readable by that tenant only.
--
-- `graph` is a FlowGraph (db/flow-types.ts). It is COPIED into a new draft flow on use, with fresh node
-- and edge ids and each block node re-bound by slug to a block the USER can read — the template row is
-- never mutated by use. `block_slugs` is derived from the graph by the app (unique, sorted, foreach
-- containers excluded) so the gallery can compute availability without unpacking every graph.
--
-- RLS = block_templates (0043): read global + own tenant; INSERT/UPDATE/DELETE own tenant only, split
-- into per-command policies (never a bare `FOR ALL`, see 0057). A global row is written only by the
-- owner pool (runAsSystem): the seeder, and a super_admin save/archive behind isSuperAdmin.
--
-- FORWARD-ONLY, idempotent (runs at startup on every replica). New table, so no hot-table lock is
-- taken; lock_timeout is set anyway, like 0107, so a contended catalog lock fails fast and the boot
-- retries instead of stalling.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS flow_templates (
  id                 UUID PRIMARY KEY DEFAULT uuidv7(),
  -- NULL = platform starter. DEFAULT = the request GUC (0028 convention): a tenant-scoped INSERT stamps
  -- its own tenant, an owner-pool INSERT with no GUC leaves NULL.
  tenant_id          UUID DEFAULT app_current_tenant_uuid() REFERENCES tenants(id) ON DELETE CASCADE,
  seed_key           TEXT,
  name               TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  category           TEXT NOT NULL DEFAULT '',
  graph              JSONB NOT NULL,
  block_slugs        TEXT[] NOT NULL DEFAULT '{}',
  -- Provenance only; no FK, so archiving or deleting the source never touches the template.
  source_flow_id     UUID,
  source_solution_id UUID,
  created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS flow_templates_tenant_idx ON flow_templates (tenant_id);
-- The seeder's natural key. Platform rows only: a tenant row never carries a seed_key the seeder owns.
CREATE UNIQUE INDEX IF NOT EXISTS flow_templates_seed_key_uq
  ON flow_templates (seed_key) WHERE tenant_id IS NULL;

ALTER TABLE flow_templates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_templates_read ON flow_templates;
DROP POLICY IF EXISTS flow_templates_ins ON flow_templates;
DROP POLICY IF EXISTS flow_templates_upd ON flow_templates;
DROP POLICY IF EXISTS flow_templates_del ON flow_templates;
CREATE POLICY flow_templates_read ON flow_templates FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant_uuid());
CREATE POLICY flow_templates_ins ON flow_templates FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_uuid());
CREATE POLICY flow_templates_upd ON flow_templates FOR UPDATE
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());
CREATE POLICY flow_templates_del ON flow_templates FOR DELETE
  USING (tenant_id = app_current_tenant_uuid());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON flow_templates TO cp_app;
  END IF;
END $$;
