-- 0016_marketplace_cycles.sql — Phase 2-E: marketplace + pipeline depth.
-- Matches src/db/schema.ts (marketplace_cycles table, marketplace_cycle_phase enum,
-- + two timestamp columns on pipeline_items).
--
-- The weekly social loop (vote → solution_phase → close → announce a winner) was
-- inert: weekly_winners rows were seeded and a winner was only enqueued by hand. This
-- table is the cycle's SOURCE OF TRUTH (the current phase + when each boundary closes)
-- AND its idempotency guard, mirroring audit_exports:
--   * UNIQUE(week) lets a tick "claim the week" via INSERT … ON CONFLICT DO NOTHING,
--     so a missed/double/multi-replica fire opens it at most once.
--   * closed_at IS NULL is the at-most-once CLOSE-claim — winner selection runs once
--     even if tickCycles fires repeatedly (a daily timer + a manual trigger both call it).
-- weekly_winners stays the durable winner artifact; this table holds the PROCESS state.
--
-- The two pipeline_items columns make the previously HARD-CODED pipeline metrics real:
-- live_at (first time a card entered Production) → avgTimeToLiveDays; rolled_back_at
-- (a Production card was pulled back) → the rolledBack count. No events table — two
-- nullable timestamps cover both metrics and keep this migration small.

DO $$ BEGIN
  CREATE TYPE marketplace_cycle_phase AS ENUM ('voting', 'solution_phase', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS marketplace_cycles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'YYYY-Www' (ISO week). The open/close claim key — same role as audit_exports.export_date.
  week                TEXT NOT NULL UNIQUE,
  phase               marketplace_cycle_phase NOT NULL DEFAULT 'voting',
  voting_ends_at      TIMESTAMPTZ NOT NULL,
  solution_ends_at    TIMESTAMPTZ NOT NULL,
  closes_at           TIMESTAMPTZ NOT NULL,
  -- the at-most-once close guard: set the instant the week is closed + winner selected.
  closed_at           TIMESTAMPTZ,
  winner_solution_id  UUID REFERENCES solutions(id) ON DELETE SET NULL,
  -- mirrors WeeklyWinnerStats — the headline tally captured at close.
  stats               JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS marketplace_cycles_phase_idx ON marketplace_cycles(phase);

-- Real timing for the pipeline metrics (were hard-coded literals before Phase 2-E).
ALTER TABLE pipeline_items ADD COLUMN IF NOT EXISTS live_at        TIMESTAMPTZ;
ALTER TABLE pipeline_items ADD COLUMN IF NOT EXISTS rolled_back_at TIMESTAMPTZ;
