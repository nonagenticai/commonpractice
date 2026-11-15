-- 0107 — competition PERIODS (week | month | year) instead of hard-wired ISO weeks.
--
-- The marketplace cycle cadence becomes a platform setting (`policies` key `cycle.cadence`,
-- off | week | month | year — written at boot from CYCLE_ENABLED, then edited on /governance).
-- A period is (kind, key, start):  week '2026-W41' · month '2026-10' · year '2026'.
--
-- WHAT THIS ADDS
--   challenges, solutions, pipeline_items, weekly_winners:  period_kind text, period_start timestamptz
--   marketplace_cycles:                                     period_kind, period_key, period_start (NOT NULL)
--   marketplace_cycles uniqueness: UNIQUE(week) → UNIQUE(period_kind, period_key)
--
-- ⛔ ORDERING MOVES TO period_start. `week` text sorted chronologically only while every value was an
-- ISO week; '2026-W41' < '2026-10' is true as text and meaningless as time. Every gate, every
-- "older than the current period" test and every newest-first sort reads period_start now.
--
-- `period_kind = 'off'` (with period_start NULL) marks a challenge/solution filed while the cadence
-- was off: it never competed in a period and is never made stale by one.
-- `period_kind IS NULL` is a legacy row whose `week` was '' (never filed into any cycle).
--
-- ⚠️ THE `week` COLUMNS STAY, AND STAY WRITTEN (they now hold the period KEY for every kind). They
-- are dropped in a LATER release, never in the one that stops reading them: migrations run at pod
-- startup with 2-4 replicas, and old pods select `week` explicitly for the whole rollout window.
-- The trigger below derives period_* from `week` whenever a writer sets only `week` — that is what
-- keeps an OLD pod's insert during the rollout (and every seeder/test that stamps a literal week)
-- consistent, instead of leaving a NULL period that the gate would read as "legacy, closed".
-- The key fully determines kind and start, so the trigger is a pure function, not a second source.
--
--   policies:  effective_from timestamptz, previous_value jsonb — a value that takes effect LATER.
--              `cycle.cadence` uses it: a change starts at the next period boundary, and the switch
--              instant + the value in force until then are persisted so every replica (and the boot
--              catch-up) derive the same answer. NULL effective_from = the value is in force now.
--
-- FORWARD-ONLY, idempotent (runs at startup on every replica).
--
-- ⛔ lock_timeout: every ALTER TABLE below needs ACCESS EXCLUSIVE on a hot table (challenges,
-- solutions, …) while old pods are still serving. Without a ceiling the ALTER queues behind a long
-- reader and every later query on that table queues behind the ALTER — a full stall. With it the
-- file fails fast (55P03); the runner applies all pending files in ONE transaction, so the whole run
-- rolls back cleanly, the boot throws, the pod restarts and retries. The runner RESETs it after the
-- file (migration-runner.ts MIGRATION_RESET_GUCS).
SET LOCAL lock_timeout = '5s';

-- ---- pure key → (kind, start) -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION cp_period_kind_of_key(k text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN k ~ '^[0-9]{4}-W[0-9]{2}$' THEN 'week'
    WHEN k ~ '^[0-9]{4}-[0-9]{2}$'  THEN 'month'
    WHEN k ~ '^[0-9]{4}$'           THEN 'year'
  END
$$;

-- Monday of ISO week 1 is Jan 4th moved back to its Monday (same arithmetic as host/iso-week.ts
-- weekStart). All instants are UTC midnight.
CREATE OR REPLACE FUNCTION cp_period_start_of_key(k text) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE cp_period_kind_of_key(k)
    WHEN 'week' THEN (
      make_date(substr(k, 1, 4)::int, 1, 4)
        - (extract(isodow FROM make_date(substr(k, 1, 4)::int, 1, 4))::int - 1)
        + (substr(k, 7, 2)::int - 1) * 7
    )::timestamp AT TIME ZONE 'UTC'
    WHEN 'month' THEN make_date(substr(k, 1, 4)::int, substr(k, 6, 2)::int, 1)::timestamp AT TIME ZONE 'UTC'
    WHEN 'year'  THEN make_date(k::int, 1, 1)::timestamp AT TIME ZONE 'UTC'
  END
$$;

-- ---- columns ------------------------------------------------------------------------------------
ALTER TABLE challenges         ADD COLUMN IF NOT EXISTS period_kind  text;
ALTER TABLE challenges         ADD COLUMN IF NOT EXISTS period_start timestamptz;
ALTER TABLE solutions          ADD COLUMN IF NOT EXISTS period_kind  text;
ALTER TABLE solutions          ADD COLUMN IF NOT EXISTS period_start timestamptz;
ALTER TABLE pipeline_items     ADD COLUMN IF NOT EXISTS period_kind  text;
ALTER TABLE pipeline_items     ADD COLUMN IF NOT EXISTS period_start timestamptz;
ALTER TABLE weekly_winners     ADD COLUMN IF NOT EXISTS period_kind  text;
ALTER TABLE weekly_winners     ADD COLUMN IF NOT EXISTS period_start timestamptz;
ALTER TABLE marketplace_cycles ADD COLUMN IF NOT EXISTS period_kind  text;
ALTER TABLE marketplace_cycles ADD COLUMN IF NOT EXISTS period_key   text;
ALTER TABLE marketplace_cycles ADD COLUMN IF NOT EXISTS period_start timestamptz;
ALTER TABLE policies           ADD COLUMN IF NOT EXISTS effective_from timestamptz;
ALTER TABLE policies           ADD COLUMN IF NOT EXISTS previous_value jsonb;
-- The cadence HISTORY: when each recorded switch takes over (NULL = at once). The catch-up replays the
-- whole trail, because the policy row's single previous_value cannot describe two switches in one outage.
ALTER TABLE policy_changes     ADD COLUMN IF NOT EXISTS effective_from timestamptz;

-- ---- backfill from week (before the trigger exists, so it is a plain UPDATE) --------------------
UPDATE challenges SET period_kind = cp_period_kind_of_key(week), period_start = cp_period_start_of_key(week)
 WHERE period_kind IS NULL AND cp_period_kind_of_key(week) IS NOT NULL;
UPDATE solutions SET period_kind = cp_period_kind_of_key(week), period_start = cp_period_start_of_key(week)
 WHERE period_kind IS NULL AND cp_period_kind_of_key(week) IS NOT NULL;
UPDATE pipeline_items SET period_kind = cp_period_kind_of_key(week), period_start = cp_period_start_of_key(week)
 WHERE period_kind IS NULL AND cp_period_kind_of_key(week) IS NOT NULL;
UPDATE weekly_winners SET period_kind = cp_period_kind_of_key(week), period_start = cp_period_start_of_key(week)
 WHERE period_kind IS NULL AND cp_period_kind_of_key(week) IS NOT NULL;
UPDATE marketplace_cycles
   SET period_kind = cp_period_kind_of_key(week), period_key = week, period_start = cp_period_start_of_key(week)
 WHERE period_kind IS NULL;

-- ---- constraints --------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['challenges', 'solutions', 'pipeline_items', 'weekly_winners'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_period_kind_check' AND conrelid = t::regclass) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (period_kind IS NULL OR period_kind IN (''week'', ''month'', ''year'', ''off''))',
        t, t || '_period_kind_check');
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketplace_cycles_period_kind_check'
                  AND conrelid = 'marketplace_cycles'::regclass) THEN
    ALTER TABLE marketplace_cycles
      ADD CONSTRAINT marketplace_cycles_period_kind_check CHECK (period_kind IN ('week', 'month', 'year'));
  END IF;
END $$;

ALTER TABLE marketplace_cycles ALTER COLUMN period_kind  SET NOT NULL;
ALTER TABLE marketplace_cycles ALTER COLUMN period_key   SET NOT NULL;
ALTER TABLE marketplace_cycles ALTER COLUMN period_start SET NOT NULL;

-- UNIQUE(week) → UNIQUE(period_kind, period_key). The old constraint is the inline one from 0016.
ALTER TABLE marketplace_cycles DROP CONSTRAINT IF EXISTS marketplace_cycles_week_key;
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_cycles_period_key_uq ON marketplace_cycles (period_kind, period_key);
CREATE UNIQUE INDEX IF NOT EXISTS marketplace_cycles_period_start_uq ON marketplace_cycles (period_kind, period_start);

CREATE INDEX IF NOT EXISTS solutions_period_idx  ON solutions (period_kind, period_start);
CREATE INDEX IF NOT EXISTS challenges_period_idx ON challenges (period_kind, period_start);

-- ---- keep period_* in step with week for writers that only set week ------------------------------
CREATE OR REPLACE FUNCTION cp_period_follow_week() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.period_kind IS NULL AND cp_period_kind_of_key(NEW.week) IS NOT NULL THEN
      NEW.period_kind  := cp_period_kind_of_key(NEW.week);
      NEW.period_start := cp_period_start_of_key(NEW.week);
    END IF;
  ELSIF NEW.week IS DISTINCT FROM OLD.week
        AND NEW.period_kind IS NOT DISTINCT FROM OLD.period_kind
        AND NEW.period_start IS NOT DISTINCT FROM OLD.period_start THEN
    -- `week` rewritten without touching the period: the period follows the key.
    NEW.period_kind  := cp_period_kind_of_key(NEW.week);
    NEW.period_start := cp_period_start_of_key(NEW.week);
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION cp_cycle_period_follow_week() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.period_kind IS NULL THEN
      NEW.period_kind  := cp_period_kind_of_key(NEW.week);
      NEW.period_start := cp_period_start_of_key(NEW.week);
    END IF;
    IF NEW.period_key IS NULL THEN
      NEW.period_key := NEW.week;
    END IF;
  ELSIF NEW.week IS DISTINCT FROM OLD.week AND NEW.period_key IS NOT DISTINCT FROM OLD.period_key THEN
    NEW.period_kind  := cp_period_kind_of_key(NEW.week);
    NEW.period_key   := NEW.week;
    NEW.period_start := cp_period_start_of_key(NEW.week);
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS challenges_period_follow_week ON challenges;
CREATE TRIGGER challenges_period_follow_week BEFORE INSERT OR UPDATE OF week ON challenges
  FOR EACH ROW EXECUTE FUNCTION cp_period_follow_week();
DROP TRIGGER IF EXISTS solutions_period_follow_week ON solutions;
CREATE TRIGGER solutions_period_follow_week BEFORE INSERT OR UPDATE OF week ON solutions
  FOR EACH ROW EXECUTE FUNCTION cp_period_follow_week();
DROP TRIGGER IF EXISTS pipeline_items_period_follow_week ON pipeline_items;
CREATE TRIGGER pipeline_items_period_follow_week BEFORE INSERT OR UPDATE OF week ON pipeline_items
  FOR EACH ROW EXECUTE FUNCTION cp_period_follow_week();
DROP TRIGGER IF EXISTS weekly_winners_period_follow_week ON weekly_winners;
CREATE TRIGGER weekly_winners_period_follow_week BEFORE INSERT OR UPDATE OF week ON weekly_winners
  FOR EACH ROW EXECUTE FUNCTION cp_period_follow_week();
DROP TRIGGER IF EXISTS marketplace_cycles_period_follow_week ON marketplace_cycles;
CREATE TRIGGER marketplace_cycles_period_follow_week BEFORE INSERT OR UPDATE OF week ON marketplace_cycles
  FOR EACH ROW EXECUTE FUNCTION cp_cycle_period_follow_week();
