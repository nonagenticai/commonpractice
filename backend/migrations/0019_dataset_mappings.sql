-- 0019_dataset_mappings.sql — Phase 3.3: the dataset → ontology mapping bridge
-- (Pillar A ↔ B). One row per (dataset, ontology entity) carrying a column→attribute
-- map, so the agent (3.4) learns the MEANING + relations of a dataset's columns, not
-- just their types — e.g. a column `clm_amt` becomes Insurance.Claim.amount.
--
-- FK by dataset_id (not slug — datasets.slug is only unique per (owner_id, slug)) and
-- by entity_id → ontology_entities (3.2 prerequisite). industry/department denormalize
-- the compiled cell the mapping was authored against (entity_id alone doesn't say which
-- (industry × department) cell). column_map = { datasetColumn: attributeName }. Proposals
-- are source='auto', confirmed=false until a human confirms (source='human', confirmed).
-- tenant_id NULL = global; per-tenant overrides (3.5) reuse this table with it set.
-- Matches src/db/schema.ts (mapping_source enum + dataset_mappings).

DO $$ BEGIN
  CREATE TYPE mapping_source AS ENUM ('auto', 'human');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS dataset_mappings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id  UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  entity_id   UUID NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  industry    TEXT NOT NULL,
  department  TEXT NOT NULL,
  column_map  JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence  REAL NOT NULL DEFAULT 0,
  source      mapping_source NOT NULL DEFAULT 'auto',
  confirmed   BOOLEAN NOT NULL DEFAULT false,
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Natural-key uniqueness for idempotent upsert: one mapping per (dataset, entity, tenant).
-- coalesce over the nullable tenant_id (expression index drizzle can't express).
CREATE UNIQUE INDEX IF NOT EXISTS dataset_mappings_natural_uq
  ON dataset_mappings (
    dataset_id,
    entity_id,
    coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX IF NOT EXISTS dataset_mappings_dataset_id_idx ON dataset_mappings(dataset_id);
CREATE INDEX IF NOT EXISTS dataset_mappings_entity_id_idx ON dataset_mappings(entity_id);
