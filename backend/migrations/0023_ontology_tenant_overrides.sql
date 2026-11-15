-- 0023_ontology_tenant_overrides.sql — Phase 3.5: per-tenant ontology overrides.
--
-- The ontology tables already support per-tenant rows: ontology_entities.tenant_id
-- exists (0018) with a coalesce() natural-key unique index, so a tenant can add an
-- entity (new name) or override a global one (same scope/industry/department/name +
-- tenant_id). Attributes ride their entity row (scope follows the entity), so they
-- need no tenant_id. RELATIONS are the gap: an edge references entity ids and can join
-- a tenant entity to a GLOBAL one, so a tenant edge between two global ids would
-- otherwise leak to every tenant. Give ontology_relations its own tenant_id and make
-- the edge-uniqueness coalesce it (so a tenant edge can coexist with the global one).
--
-- tenant_id NULL = the shipped global ontology; a set tenant_id = that tenant's override.
-- Idempotent (DO $$ … EXCEPTION) per the 0019 convention.

ALTER TABLE ontology_relations
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE;

-- Replace the plain (from,to,predicate) unique with a tenant-aware expression index
-- (coalesce over the nullable tenant_id, mirroring ontology_entities_natural_uq). An
-- expression index drizzle can't represent, so it lives here only.
DO $$ BEGIN
  ALTER TABLE ontology_relations DROP CONSTRAINT ontology_relations_edge_uq;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ontology_relations_edge_uq
  ON ontology_relations (
    from_entity,
    to_entity,
    predicate,
    coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS ontology_relations_tenant_id_idx
  ON ontology_relations(tenant_id);
