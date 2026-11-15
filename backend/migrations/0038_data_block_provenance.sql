-- 0038_data_block_provenance.sql — Phase 3 of the ontology-data-blocks plan: data-block derivation.
--
-- Phase 3 lets a developer turn an ontology entity (with a bound PRIMARY test-data sample) into a
-- runnable, tenant-scoped category='data' block. To badge "Derived from <entity>" in the palette and
-- to make the derive route idempotent (find-or-version the existing derived block instead of creating a
-- duplicate), building_blocks records the source entity's reseed-stable NATURAL KEY.
--
-- We store the natural KEY (entityKey: "scope:industry:department:name"), NOT the entity row id: entity
-- uuids churn on a DB reset and flip to the tenant-override row id, whereas the natural key is stable and
-- tenant-agnostic. So no FK (and no RLS interaction) — it is a provenance label, nullable for every
-- hand-authored / platform block.
--
-- FORWARD-ONLY / PROD-SAFE & ADDITIVE: one nullable column + a plain index. building_blocks already has
-- RLS (0037 §4c) and the cp_app GRANT covers the table — a column add inherits both. Zero behaviour change.

ALTER TABLE building_blocks
  ADD COLUMN IF NOT EXISTS source_entity_key text;

CREATE INDEX IF NOT EXISTS building_blocks_source_entity_idx
  ON building_blocks (source_entity_key);
