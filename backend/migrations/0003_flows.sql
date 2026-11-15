-- 0003_flows.sql — Session 2: flow canvas + persistence.
-- Matches src/db/schema.ts (flows table + flow_status enum). A flow is a
-- user-owned working document; its graph ({nodes, edges}) is stored as JSONB.

DO $$ BEGIN
  CREATE TYPE flow_status AS ENUM ('draft', 'submitted', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS flows (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  owner_id      UUID NOT NULL REFERENCES users(id),
  status        flow_status NOT NULL DEFAULT 'draft',
  graph         JSONB NOT NULL,
  version       TEXT NOT NULL DEFAULT '0.1.0',
  -- Reserved for the marketplace solution link (Session 5); no FK until then.
  solution_id   UUID,
  last_saved_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS flows_owner_id_idx ON flows(owner_id);
CREATE INDEX IF NOT EXISTS flows_status_idx ON flows(status);
