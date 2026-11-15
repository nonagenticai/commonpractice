-- 0018_ontology.sql — Phase 3.2: industry × department data-object ontology.
-- A lightweight, declarative semantic map (entities, typed attributes, relations)
-- authored as native JSON (backend/src/ontology/seed/) and loaded into these
-- normalized tables. NO reasoner / no Python — the matrix engine
-- (ontology-service.ts) composes the effective ontology for a given
-- (industry, department) from three layers at query time:
--   effective(industry, dept) = base(dept) ⊕ industryOverlay(industry) ⊕ cell(industry, dept)
-- Matches src/db/schema.ts (ontology_scope enum + ontology_entities /
-- ontology_attributes / ontology_relations). tenant_id NULL = global/shipped
-- ontology; per-tenant overrides (3.5) reuse the same tables with tenant_id set.

DO $$ BEGIN
  CREATE TYPE ontology_scope AS ENUM ('generic', 'industry', 'industry_dept');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS ontology_entities (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       ontology_scope NOT NULL,
  industry    TEXT,
  department  TEXT,
  name        TEXT NOT NULL,
  label       TEXT NOT NULL,
  synonyms    JSONB NOT NULL DEFAULT '[]'::jsonb,
  description TEXT,
  tenant_id   UUID REFERENCES tenants(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ontology_entities_scope_idx
  ON ontology_entities(scope, industry, department);
CREATE INDEX IF NOT EXISTS ontology_entities_tenant_id_idx
  ON ontology_entities(tenant_id);

-- Natural-key uniqueness so the JSON seed is idempotent (coalesce over the
-- nullable scoping columns — an expression index drizzle can't express, so it
-- lives here only). One entity per (scope, industry, department, name, tenant).
CREATE UNIQUE INDEX IF NOT EXISTS ontology_entities_natural_uq
  ON ontology_entities (
    scope,
    coalesce(industry, ''),
    coalesce(department, ''),
    name,
    coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE TABLE IF NOT EXISTS ontology_attributes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id   UUID NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  synonyms    JSONB NOT NULL DEFAULT '[]'::jsonb,
  pii         BOOLEAN NOT NULL DEFAULT false,
  description TEXT
);

DO $$ BEGIN
  ALTER TABLE ontology_attributes
    ADD CONSTRAINT ontology_attributes_entity_name_uq UNIQUE (entity_id, name);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS ontology_attributes_entity_id_idx
  ON ontology_attributes(entity_id);

CREATE TABLE IF NOT EXISTS ontology_relations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_entity UUID NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  to_entity   UUID NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  predicate   TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  cardinality TEXT NOT NULL DEFAULT ''
);

DO $$ BEGIN
  ALTER TABLE ontology_relations
    ADD CONSTRAINT ontology_relations_edge_uq UNIQUE (from_entity, to_entity, predicate);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS ontology_relations_from_idx ON ontology_relations(from_entity);
CREATE INDEX IF NOT EXISTS ontology_relations_to_idx ON ontology_relations(to_entity);
