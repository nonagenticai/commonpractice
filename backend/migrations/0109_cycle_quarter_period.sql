-- 0109 — the QUARTER period kind: key 'YYYY-Qn' (n = 1..4), start = the 1st of the quarter's first
-- month (Jan / Apr / Jul / Oct) 00:00 UTC. Voting runs the first two months, building the third.
-- The TS twin is host/period.ts; tests/period-sql-parity.test.ts asserts the two agree key by key.
--
-- WHAT THIS CHANGES (0107 built the period machinery for week | month | year):
--   cp_period_kind_of_key / cp_period_start_of_key   recognise 'YYYY-Qn'
--   the five period_kind CHECK constraints           accept 'quarter'
--   the `cycle.cadence` policy row's `options`        gain 'quarter' (its VALUE is never touched:
--                                                     ensureCadencePolicy inserts ON CONFLICT DO
--                                                     NOTHING, so without this UPDATE an existing
--                                                     database could never offer or accept it)
--
-- The 0107 follow-week triggers call the two functions, so a writer that sets only `week` to a
-- quarter key gets period_kind/period_start derived like every other kind.
--
-- FORWARD-ONLY, idempotent (runs at startup on every replica). Replacing a CHECK needs ACCESS
-- EXCLUSIVE on hot tables, so the same fail-fast ceiling as 0107 (see its header).
SET LOCAL lock_timeout = '5s';

-- The quarter pattern is disjoint from the other three ('Q' is not a digit, 'W' is not 'Q').
CREATE OR REPLACE FUNCTION cp_period_kind_of_key(k text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN k ~ '^[0-9]{4}-W[0-9]{2}$' THEN 'week'
    WHEN k ~ '^[0-9]{4}-[0-9]{2}$'  THEN 'month'
    WHEN k ~ '^[0-9]{4}-Q[1-4]$'    THEN 'quarter'
    WHEN k ~ '^[0-9]{4}$'           THEN 'year'
  END
$$;

CREATE OR REPLACE FUNCTION cp_period_start_of_key(k text) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE cp_period_kind_of_key(k)
    WHEN 'week' THEN (
      make_date(substr(k, 1, 4)::int, 1, 4)
        - (extract(isodow FROM make_date(substr(k, 1, 4)::int, 1, 4))::int - 1)
        + (substr(k, 7, 2)::int - 1) * 7
    )::timestamp AT TIME ZONE 'UTC'
    WHEN 'month'   THEN make_date(substr(k, 1, 4)::int, substr(k, 6, 2)::int, 1)::timestamp AT TIME ZONE 'UTC'
    WHEN 'quarter' THEN make_date(substr(k, 1, 4)::int, 3 * (substr(k, 7, 1)::int - 1) + 1, 1)::timestamp AT TIME ZONE 'UTC'
    WHEN 'year'    THEN make_date(k::int, 1, 1)::timestamp AT TIME ZONE 'UTC'
  END
$$;

-- Drop + re-add each CHECK (same names as 0107). Re-running drops the 0109 version and re-adds it —
-- identical result, so the file is idempotent.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['challenges', 'solutions', 'pipeline_items', 'weekly_winners'] LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_period_kind_check');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (period_kind IS NULL OR period_kind IN (''week'', ''month'', ''quarter'', ''year'', ''off''))',
      t, t || '_period_kind_check');
  END LOOP;
END $$;

ALTER TABLE marketplace_cycles DROP CONSTRAINT IF EXISTS marketplace_cycles_period_kind_check;
ALTER TABLE marketplace_cycles
  ADD CONSTRAINT marketplace_cycles_period_kind_check CHECK (period_kind IN ('week', 'month', 'quarter', 'year'));

-- The governance select's options (and its English description, which lists them). Never the value.
UPDATE policies
   SET options = '["off", "week", "month", "quarter", "year"]'::jsonb,
       description = 'How often challenges are voted on and a winner is chosen: weekly, monthly, quarterly, yearly, or off. Off keeps votes as a ranking with no winners. A change starts at the next period.'
 WHERE key = 'cycle.cadence';
