-- 0005_sandboxes.sql — Session 4: persistent per-user sandboxes + Ops surface.
-- Matches src/db/schema.ts (sandboxes + sandbox_status enum + flow_runs.sandbox_id).
-- A sandbox is a per-user execution context, lazily provisioned on first run and
-- transitioned by the run path (idle ⇄ running → error; idle/error → suspended).
-- A suspended sandbox blocks that user's runs (enforced in host/run-controller.ts);
-- an idle/error sandbox is auto-suspended past the idle threshold by a periodic
-- sweep. cost_today / llm_calls_today are NOT stored here — they are derived live
-- from usage_counters (single source of truth; one primary sandbox per user).

DO $$ BEGIN
  CREATE TYPE sandbox_status AS ENUM ('running', 'idle', 'suspended', 'error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS sandboxes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       UUID NOT NULL REFERENCES users(id),
  slug           TEXT NOT NULL UNIQUE,
  label          TEXT NOT NULL DEFAULT '',
  project        TEXT,
  status         sandbox_status NOT NULL DEFAULT 'idle',
  region         TEXT NOT NULL DEFAULT 'eu-west',
  mem_cap_mb     INTEGER NOT NULL DEFAULT 1200,
  last_active_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sandboxes_owner_id_idx ON sandboxes(owner_id);
CREATE INDEX IF NOT EXISTS sandboxes_status_idx ON sandboxes(status);

-- Tie a run to the sandbox it executed in (for inspect + per-sandbox activity).
-- SET NULL on delete so removing a sandbox never cascades away run history.
ALTER TABLE flow_runs
  ADD COLUMN IF NOT EXISTS sandbox_id UUID REFERENCES sandboxes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS flow_runs_sandbox_id_idx ON flow_runs(sandbox_id);
