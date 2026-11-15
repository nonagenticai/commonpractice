-- 0036_ontology_entity_samples.sql — Phase 1 of the ontology-data-blocks plan.
--
-- Binds a tenant DATASET as the canonical TEST DATA for an ontology ENTITY. This is the
-- "each ontology part gets test data" piece: today datasets exist and the 3.3 mapping bridge
-- relates columns→attributes, but nothing pins "THIS dataset is the example data for the
-- Claim entity". A data-type block (Phase 3) is later derived from the entity + its primary
-- sample, so the sample is the data a source/sink block emits and the runtime validates.
--
-- Reuses the existing datasets / dataset_rows store (no parallel row store) and the 3.3
-- dataset_mappings.column_map for the column→attribute projection (mapping_id, nullable). A
-- sample is a deliberate HUMAN binding, distinct from a mapping (the agent's learned semantics).
--
-- TENANT-SCOPED (tenant_id NOT NULL): the underlying datasets are strictly tenant-scoped
-- (0028 §4b), so there is no global dataset to bind a shipped global entity to — global/shipped
-- sample data is deferred. RLS = 0028 §4a strict-uuid (mirrors 0030). Resolution by the
-- reseed-stable entityKey natural key (scope/industry/department/name) lives in sample-service,
-- NOT here — the FK is to a concrete ontology_entities row for integrity.
--
-- FORWARD-ONLY / PROD-SAFE: created by the table owner on boot; tenant_id defaults to the
-- per-request GUC (0028 convention). ENABLE (not FORCE) so the owner bypasses for migrations /
-- runAsSystem; cp_app (non-owner, NOBYPASSRLS) is fully bound.

CREATE TABLE IF NOT EXISTS ontology_entity_samples (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The ontology entity this dataset is the test data for. FK for integrity; sample-service
  -- resolves across tenant-override + global rows of the same natural key at read time.
  entity_id   uuid NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  -- The bound dataset (its rows are the sample data). Delete cascades the binding.
  dataset_id  uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  -- The 3.3 column→attribute projection to apply before validation/derivation. NULL = use the
  -- dataset columns verbatim. SET NULL (not cascade) so dropping a mapping just unprojects.
  mapping_id  uuid REFERENCES dataset_mappings(id) ON DELETE SET NULL,
  -- The default sample for the entity (one per entity per tenant — partial unique below).
  is_primary  boolean NOT NULL DEFAULT false,
  -- RLS scope. Defaults to the per-request GUC (0028 convention); FK hard-scopes to a real tenant.
  tenant_id   uuid NOT NULL DEFAULT app_current_tenant_uuid()
                REFERENCES tenants(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- One binding per (entity, dataset) within a tenant — idempotent upserts.
  UNIQUE (entity_id, dataset_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS ontology_entity_samples_entity_idx
  ON ontology_entity_samples (entity_id, tenant_id);
CREATE INDEX IF NOT EXISTS ontology_entity_samples_dataset_idx
  ON ontology_entity_samples (dataset_id);

-- At most one PRIMARY sample per (entity, tenant).
CREATE UNIQUE INDEX IF NOT EXISTS ontology_entity_samples_primary_uq
  ON ontology_entity_samples (entity_id, tenant_id) WHERE is_primary;

-- RLS: tenant-scoped, fail-closed (unset GUC → NULL → zero rows). Mirrors 0028 §4a / 0030.
ALTER TABLE ontology_entity_samples ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ontology_entity_samples_tenant ON ontology_entity_samples;
CREATE POLICY ontology_entity_samples_tenant ON ontology_entity_samples
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());

-- GRANT to cp_app (role-existence-guarded, like 0028 §5 / 0030). Owner default-privileges also
-- auto-grant future owner-created tables, but grant explicitly so the table is self-contained.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ontology_entity_samples TO cp_app;
    RAISE NOTICE '[0036] granted cp_app DML on ontology_entity_samples';
  ELSE
    RAISE NOTICE '[0036] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;
