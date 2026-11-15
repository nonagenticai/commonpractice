-- 0114 — drop the pre-0110 platform cycle rows; every marketplace_cycles row belongs to a tenant.
--
-- 0110 made the voting cycle per tenant and kept the NULL-tenant platform rows for ONE release, only
-- so that pre-0110 pods could keep reading and claiming them during that rollout (0110:30-32). Every
-- pod now runs the per-tenant engine, and no engine query reads a NULL-tenant row (cycle-service,
-- cycle-eligibility, cycle-cadence, routes/cycle, routes/challenges all carry a tenant predicate).
-- Prod on 2026-10-15: 19 NULL-tenant rows (2026-W24 … 2026-W42) next to 97 tenant rows.
--
-- WHAT THIS DOES
--   1. DELETE the NULL-tenant rows. Nothing references marketplace_cycles by foreign key (it only
--      points OUT: tenant_id → tenants, winner_solution_id → solutions), so nothing cascades.
--      Every tenant got its copy of these rows in 0110's backfill; winners live in weekly_winners.
--   2. tenant_id SET NOT NULL — a tenant-less cycle row can no longer be written at all.
--   3. The cp_app read policy loses its `tenant_id IS NULL OR` branch: own tenant only.
--   4. The two per-tenant unique indexes lose NULLS NOT DISTINCT. With every key column NOT NULL the
--      clause can never apply; rebuilt (same names, same columns) only where it is still set, so the
--      index definition matches schema.ts and a later reader is not sent looking for NULLs.
--
-- The `week` columns and the 0107 week→period trigger STAY (a separate release drops them).
--
-- FORWARD-ONLY, idempotent: the runner applies it once, under its advisory lock, inside one
-- transaction with every other pending file, so two replicas starting together cannot both run it.
-- Run twice anyway, it is a no-op: the DELETE matches nothing, SET NOT NULL on a NOT NULL column is
-- a no-op, the policy is dropped and recreated identically, and the index rebuild is guarded on
-- pg_index.indnullsnotdistinct. Same fail-fast lock ceiling as 0107/0110/0112.
SET LOCAL lock_timeout = '5s';

DELETE FROM marketplace_cycles WHERE tenant_id IS NULL;

ALTER TABLE marketplace_cycles ALTER COLUMN tenant_id SET NOT NULL;

-- Same shape as 0110: ONE per-command SELECT policy and no write policy. Every cycle write runs as
-- SYSTEM (the owner bypasses RLS: ENABLE, not FORCE), so a cp_app INSERT is refused and an
-- UPDATE/DELETE matches no row. ⛔ A bare CREATE POLICY is FOR ALL and would grant writes.
ALTER TABLE marketplace_cycles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_cycles_read ON marketplace_cycles;
CREATE POLICY marketplace_cycles_read ON marketplace_cycles
  FOR SELECT USING (tenant_id = app_current_tenant_uuid());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
              WHERE c.relname = 'marketplace_cycles_tenant_period_key_uq' AND i.indnullsnotdistinct) THEN
    DROP INDEX marketplace_cycles_tenant_period_key_uq;
    CREATE UNIQUE INDEX marketplace_cycles_tenant_period_key_uq
      ON marketplace_cycles (tenant_id, period_kind, period_key);
    RAISE NOTICE '[0114] rebuilt marketplace_cycles_tenant_period_key_uq without NULLS NOT DISTINCT';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
              WHERE c.relname = 'marketplace_cycles_tenant_period_start_uq' AND i.indnullsnotdistinct) THEN
    DROP INDEX marketplace_cycles_tenant_period_start_uq;
    CREATE UNIQUE INDEX marketplace_cycles_tenant_period_start_uq
      ON marketplace_cycles (tenant_id, period_kind, period_start);
    RAISE NOTICE '[0114] rebuilt marketplace_cycles_tenant_period_start_uq without NULLS NOT DISTINCT';
  END IF;
END $$;
