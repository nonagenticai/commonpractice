-- 0004_runs.sql — Session 3: flow execution runs + per-user usage counters.
-- Matches src/db/schema.ts (flowRuns + usageCounters + flow_run_status enum).
-- A flow_run is one execution in the isolated subprocess runner; the streamed
-- NDJSON trace is persisted as a JSONB array on completion. usage_counters is
-- the per-user/day ledger the LLM broker locks (FOR UPDATE) for cap enforcement.

DO $$ BEGIN
  CREATE TYPE flow_run_status AS ENUM ('running', 'ok', 'partial', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS flow_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id        UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  triggered_by   UUID NOT NULL REFERENCES users(id),
  status         flow_run_status NOT NULL DEFAULT 'running',
  trace          JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_ms       INTEGER,
  total_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  tokens_in      INTEGER NOT NULL DEFAULT 0,
  tokens_out     INTEGER NOT NULL DEFAULT 0,
  llm_calls      INTEGER NOT NULL DEFAULT 0,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS flow_runs_flow_id_idx ON flow_runs(flow_id);
CREATE INDEX IF NOT EXISTS flow_runs_triggered_by_idx ON flow_runs(triggered_by);

CREATE TABLE IF NOT EXISTS usage_counters (
  user_id   UUID NOT NULL REFERENCES users(id),
  day       DATE NOT NULL,
  llm_calls INTEGER NOT NULL DEFAULT 0,
  spend_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  CONSTRAINT usage_counters_user_day_uq UNIQUE (user_id, day)
);
