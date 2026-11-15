-- 0111_challenge_entities.sql — W8/P2: the types of information (ontology entities) a challenge's
-- creator says it is about, linked DIRECTLY — not through a dataset mapping.
--
-- A link belongs to the CHALLENGE, never to the ontology: nothing here writes an ontology row, and
-- admin ontology control (requireOntologyManager) is unchanged. Edit rule = the dataset links'
-- (creator or super_admin), enforced in the route.
--
-- `entity_id` may be a GLOBAL entity (tenant_id IS NULL) or one of this tenant's own; the route
-- validates visibility. ON DELETE CASCADE from the challenge (a deleted challenge leaves no links)
-- and from the entity (an entity an admin deletes drops out of every challenge, no dangling id).
-- `created_by` is SET NULL so a removed user never blocks anything.
--
-- RLS: strict tenant shape (own column, no global branch), the same predicate in USING and WITH
-- CHECK so writes are own-tenant-only. Split per command so no policy is an implicit FOR ALL.
--
-- FORWARD-ONLY, idempotent (runs at startup on every replica). Numbered 0111: 0108-0110 are taken
-- by open branches (flow templates, tenant cadence).

CREATE TABLE IF NOT EXISTS challenge_entities (
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  entity_id    uuid NOT NULL REFERENCES ontology_entities(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL DEFAULT app_current_tenant_uuid()
                 REFERENCES tenants(id) ON DELETE CASCADE,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT challenge_entities_pk PRIMARY KEY (challenge_id, entity_id)
);

CREATE INDEX IF NOT EXISTS challenge_entities_tenant_idx ON challenge_entities (tenant_id);
CREATE INDEX IF NOT EXISTS challenge_entities_entity_idx ON challenge_entities (entity_id);

ALTER TABLE challenge_entities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS challenge_entities_read ON challenge_entities;
DROP POLICY IF EXISTS challenge_entities_ins ON challenge_entities;
DROP POLICY IF EXISTS challenge_entities_upd ON challenge_entities;
DROP POLICY IF EXISTS challenge_entities_del ON challenge_entities;
CREATE POLICY challenge_entities_read ON challenge_entities FOR SELECT
  USING (tenant_id = app_current_tenant_uuid());
CREATE POLICY challenge_entities_ins ON challenge_entities FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_uuid());
CREATE POLICY challenge_entities_upd ON challenge_entities FOR UPDATE
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());
CREATE POLICY challenge_entities_del ON challenge_entities FOR DELETE
  USING (tenant_id = app_current_tenant_uuid());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON challenge_entities TO cp_app;
    RAISE NOTICE '[0111] granted cp_app DML on challenge_entities';
  ELSE
    RAISE NOTICE '[0111] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;
