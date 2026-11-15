-- 0024_ontology_tombstones.sql — Phase 3.7: per-tenant tombstoning of global entities.
--
-- A tenant can already override/extend/delete its OWN ontology rows (3.5), but it could
-- not HIDE a global entity it doesn't want in its graph. A tombstone is just a tenant
-- override row (same scope/industry/department/name + tenant_id, allowed to coexist by the
-- 0018 coalesce natural-key unique index) carrying `hidden = true`. compileEffective drops
-- a hidden-winning entity (and its relations) from the graph the agent/builder consume, and
-- surfaces it in a separate `hidden[]` list so an admin can unhide it. `hidden` is only ever
-- meaningful on a tenant row; global rows keep the default false and are immutable from here.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) per the 0023 convention.

ALTER TABLE ontology_entities
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false;
