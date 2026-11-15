-- 0110 — the voting cycle becomes PER TENANT (PLAN-2026-10-14-ux-cleanup.md § W7).
--
-- Until now `marketplace_cycles` was ONE platform-wide phase clock: no tenant_id, no RLS, unique on
-- (period_kind, period_key). Only the crowning was per tenant (weekly_winners UNIQUE(tenant_id, week)).
-- A tenant can now run its own cadence (off | week | month | quarter | year), so every tenant owns
-- its own cycle rows and every engine query carries an explicit tenant predicate.
--
-- WHAT THIS ADDS
--   tenant_cycle_cadence          one row per tenant that OVERRIDES the platform `cycle.cadence`
--                                 policy (no row = inherit). `effective_from` + `previous_value` carry
--                                 a pending switch exactly like `policies` (0107).
--   tenant_cycle_cadence_changes  the append-only history the catch-up replays for that tenant.
--   Both: strict tenant RLS (0028 §4a shape). The changes table has NO update/delete policy and
--   cp_app gets only SELECT, INSERT on it.
--   marketplace_cycles.tenant_id  uuid NULL → tenants ON DELETE CASCADE. New rows always carry it.
--                                 RLS: cp_app reads own-tenant + NULL-tenant rows; no cp_app writes.
--   uniqueness                    (tenant_id, period_kind, period_key) and (tenant_id, period_kind,
--                                 period_start), NULLS NOT DISTINCT — the NULL-tenant legacy rows
--                                 stay unique among themselves.
--
-- BACKFILL (prod 2026-10-14: 22 tenants, 5 with challenges/solutions, 19 cycle rows, 1 open):
--   • every tenant with STAMPED challenges/solutions (a real period, not 'off'/legacy '') gets a copy
--     of EVERY platform row — phase, boundaries, closed_at, period columns, timestamps — so each of
--     its rows resolves open/closed exactly as before (the vote gate's stranded floor is the latest
--     CLOSED row's end, so the whole history is needed, not just the open row);
--   • every other non-offboarded tenant gets a copy of the current NON-CLOSED row(s) only, so its
--     cycle keeps running in step with the platform.
--   winner_solution_id / stats are NOT copied (0047 nulled them; winners live in weekly_winners).
--
-- ⚠️ THE NULL-TENANT LEGACY ROWS STAY for one release: old pods still read and write them during the
-- rollout (their claim insert is ON CONFLICT DO NOTHING with no target, so it no-ops against the
-- NULL-tenant unique slot). The new code never reads a NULL-tenant row. Drop them next release.
--
-- FORWARD-ONLY, idempotent (runs at startup on every replica): IF NOT EXISTS everywhere, the copies
-- are ON CONFLICT DO NOTHING against the new unique indexes. Same fail-fast lock ceiling as 0107.
SET LOCAL lock_timeout = '5s';

-- ---- the tenant setting + its history -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_cycle_cadence (
  tenant_id      uuid PRIMARY KEY DEFAULT app_current_tenant_uuid()
                   REFERENCES tenants(id) ON DELETE CASCADE,
  value          text NOT NULL CHECK (value IN ('off', 'week', 'month', 'quarter', 'year')),
  effective_from timestamptz,
  previous_value text CHECK (previous_value IS NULL OR previous_value IN ('off', 'week', 'month', 'quarter', 'year')),
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_cycle_cadence_changes (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id      uuid NOT NULL DEFAULT app_current_tenant_uuid()
                   REFERENCES tenants(id) ON DELETE CASCADE,
  old_value      text,
  new_value      text NOT NULL CHECK (new_value IN ('off', 'week', 'month', 'quarter', 'year')),
  effective_from timestamptz,
  actor_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_cycle_cadence_changes_tenant_idx
  ON tenant_cycle_cadence_changes (tenant_id, created_at, id);

ALTER TABLE tenant_cycle_cadence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_cycle_cadence_tenant ON tenant_cycle_cadence;
CREATE POLICY tenant_cycle_cadence_tenant ON tenant_cycle_cadence
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());

-- Append-only: a SELECT and an INSERT policy, nothing for UPDATE/DELETE (RLS denies by default).
ALTER TABLE tenant_cycle_cadence_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_cycle_cadence_changes_read ON tenant_cycle_cadence_changes;
DROP POLICY IF EXISTS tenant_cycle_cadence_changes_ins ON tenant_cycle_cadence_changes;
CREATE POLICY tenant_cycle_cadence_changes_read ON tenant_cycle_cadence_changes
  FOR SELECT USING (tenant_id = app_current_tenant_uuid());
CREATE POLICY tenant_cycle_cadence_changes_ins ON tenant_cycle_cadence_changes
  FOR INSERT WITH CHECK (tenant_id = app_current_tenant_uuid());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_cycle_cadence TO cp_app;
    GRANT SELECT, INSERT ON tenant_cycle_cadence_changes TO cp_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON tenant_cycle_cadence_changes FROM cp_app;
    RAISE NOTICE '[0110] granted cp_app on tenant_cycle_cadence (DML) + tenant_cycle_cadence_changes (SELECT, INSERT)';
  ELSE
    RAISE NOTICE '[0110] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;

-- ---- marketplace_cycles.tenant_id ------------------------------------------------------------------
ALTER TABLE marketplace_cycles ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE;

-- RLS: cp_app READS its own tenant's rows plus the NULL-tenant legacy rows (old pods read those
-- during the rollout, as cp_app). NO write policy: every cycle write runs as SYSTEM (runAsSystem /
-- runSystemTick: the tick, POST /api/cycle/advance, the governance and tenant cadence switches), and
-- the owner role bypasses RLS (ENABLE, not FORCE). A cp_app INSERT is refused and an UPDATE/DELETE
-- matches no row. ⛔ Per-command policy: a bare CREATE POLICY is FOR ALL and would grant writes.
ALTER TABLE marketplace_cycles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_cycles_read ON marketplace_cycles;
CREATE POLICY marketplace_cycles_read ON marketplace_cycles
  FOR SELECT USING (tenant_id IS NULL OR tenant_id = app_current_tenant_uuid());

-- The per-tenant uniqueness REPLACES the platform one (a copy per tenant could not exist under it).
DROP INDEX IF EXISTS marketplace_cycles_period_key_uq;
DROP INDEX IF EXISTS marketplace_cycles_period_start_uq;
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_cycles_tenant_period_key_uq
  ON marketplace_cycles (tenant_id, period_kind, period_key) NULLS NOT DISTINCT;
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_cycles_tenant_period_start_uq
  ON marketplace_cycles (tenant_id, period_kind, period_start) NULLS NOT DISTINCT;

-- ---- backfill ------------------------------------------------------------------------------------------
-- Tenants with at least one challenge or solution stamped into a real period: the FULL history.
INSERT INTO marketplace_cycles
  (tenant_id, week, period_kind, period_key, period_start, phase,
   voting_ends_at, solution_ends_at, closes_at, closed_at, created_at, updated_at)
SELECT t.id, mc.week, mc.period_kind, mc.period_key, mc.period_start, mc.phase,
       mc.voting_ends_at, mc.solution_ends_at, mc.closes_at, mc.closed_at, mc.created_at, mc.updated_at
  FROM marketplace_cycles mc
 CROSS JOIN (
   SELECT DISTINCT x.tenant_id AS id
     FROM (SELECT tenant_id FROM challenges WHERE period_kind IN ('week', 'month', 'quarter', 'year')
           UNION
           SELECT tenant_id FROM solutions  WHERE period_kind IN ('week', 'month', 'quarter', 'year')) x
     JOIN tenants tt ON tt.id = x.tenant_id
 ) t
 WHERE mc.tenant_id IS NULL
ON CONFLICT DO NOTHING;

-- Every other live tenant: the running (non-closed) row(s) only.
INSERT INTO marketplace_cycles
  (tenant_id, week, period_kind, period_key, period_start, phase,
   voting_ends_at, solution_ends_at, closes_at, closed_at, created_at, updated_at)
SELECT t.id, mc.week, mc.period_kind, mc.period_key, mc.period_start, mc.phase,
       mc.voting_ends_at, mc.solution_ends_at, mc.closes_at, mc.closed_at, mc.created_at, mc.updated_at
  FROM marketplace_cycles mc
 CROSS JOIN tenants t
 WHERE mc.tenant_id IS NULL
   AND mc.phase <> 'closed'
   AND t.offboarded_at IS NULL
ON CONFLICT DO NOTHING;
