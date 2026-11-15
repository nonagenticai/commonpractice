-- 0051_scheduler_ticks.sql
--
-- The boot schedulers' "exactly one pod runs each tick" guard has never worked in prod, and the
-- audit trail proves it: `audit.export` wrote TWO rows ~200 ms apart on 2026-07-24, -25, -27 and
-- -28 ("Exported 13 rows" twice, "Exported 6 rows" twice, …).
--
-- WHY the advisory lock failed. `runSystemTick` used a SESSION-level `pg_try_advisory_lock` on the
-- owner pool — and in prod that pool points at `pgbouncer.pgbouncer.svc.cluster.local:6432`, the
-- TRANSACTION pooler (the session pooler is the separate `pgbouncer-session` host, used only by
-- `cp_app`). Under transaction pooling a server connection is bound to a client only for the
-- duration of a transaction, so two single-statement `pg_try_advisory_lock` calls from two
-- DIFFERENT pods can be routed to the SAME server connection — and Postgres documents that "if a
-- session already holds a given advisory lock, additional requests by it will always succeed".
-- The second pod re-acquires the lock re-entrantly, gets `true`, and runs the tick as well.
-- The paired `pg_advisory_unlock` has the mirror-image problem: it lands on whatever connection
-- the pooler picks, usually not the one holding the lock, so it returns false and the lock leaks.
--
-- The fix does not depend on connection identity at all. Claiming a tick is a single atomic
-- statement whose WHERE clause is evaluated under a row lock, so exactly one caller can win it
-- regardless of how the pooler shuffles connections — the same self-serializing shape the
-- sandbox-watchdog already relies on (documented in host/tick-locks.ts).

CREATE TABLE IF NOT EXISTS scheduler_ticks (
  -- The logical tick name ('cycle', 'audit_export', …). Stable across deploys and pods.
  key           TEXT PRIMARY KEY,
  -- When the tick was last CLAIMED (not completed) — the claim is what serialises.
  last_run_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Best-effort provenance: which pod won it. Diagnostic only, never read by the guard.
  claimed_by    TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Deliberately OUTSIDE the RLS regime (0028 §COVERAGE), like the other platform-global operational
-- tables: it is keyed by scheduler name, holds no tenant data, and is only ever touched by the
-- system path (runSystemTick on the owner pool).
