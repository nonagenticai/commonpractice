-- 0059 — CONTRACT half of the 0058 expand/contract: drop the pre-tenancy (user_id, day) key.
--
-- WHAT THIS DOES
-- --------------
-- Drops `usage_counters_user_day_uq`, the `UNIQUE (user_id, day)` carried since 0004_runs.sql,
-- leaving `usage_counters_tenant_user_day_uq (tenant_id, user_id, day)` — created by 0058 — as
-- the table's only natural key. It is a UNIQUE CONSTRAINT (pg_constraint contype='u'), NOT a bare
-- index, so this is `ALTER TABLE … DROP CONSTRAINT`; a `DROP INDEX` would fail.
--
-- WHY IT IS A SEPARATE RELEASE FROM 0058
-- --------------------------------------
-- Migrations run at backend STARTUP with 2-4 replicas rolling, so old and new code run against
-- one schema during every deploy. Dropping the narrow constraint in 0058 would have made the
-- then-live replicas' `ON CONFLICT (user_id, day)` raise 42P10 ("no unique or exclusion constraint
-- matching the ON CONFLICT specification") for the whole rollout window — every LLM call 500s.
-- 0058 therefore only ADDED the wider index and moved every call site off the narrow key: the
-- broker and db/seed-tenant-showcase.ts to an untargeted `ON CONFLICT DO NOTHING` (valid with and
-- without the old constraint), db/seed-ops.ts and tests/ops-metrics.test.ts to the wide target.
-- That release is deployed; prod's migration head is 0058. Every replica now runs code that names
-- no narrow target, which is precisely the precondition this file was waiting on.
--
-- Until this runs, the bug 0058 documents is STILL LIVE: while the narrow constraint exists it
-- keeps winning, the cross-tenant row cannot be created, and the daily call cap plus the weekly
-- spend ceiling stay bypassable for any user metering under two tenants on the same UTC day.
-- This file is what actually fixes it.
--
-- ⛔ THIS IS A ONE-WAY DOOR — BOTH WAYS
-- ------------------------------------
-- 1. NO SCHEMA ROLLBACK. Dropping the narrow constraint is exactly what ALLOWS a user to hold two
--    counter rows for one (user_id, day) under two tenants. The moment one such pair exists the
--    constraint can never be re-created — it would fail on duplicate keys — without destroying or
--    merging real metering data. There is no down migration; only roll forward. (Verified against
--    prod before writing this: 0 rows currently have >1 tenant per (user_id, day), so the DROP
--    itself cannot fail on existing data. That is a statement about TODAY, and it stops being
--    true the first time a scope-switched admin makes two calls.)
-- 2. NO APPLICATION ROLLBACK PAST THE 0058 CODE. Any replica running pre-0058 code names
--    `ON CONFLICT (user_id, day)`; with the constraint gone that is a 42P10 on EVERY LLM call, in
--    both the streaming and non-streaming paths. The rollback floor is commit `f780cda` (PR #199,
--    the 0058 release) — rolling the app back past it after this migration has run breaks all
--    metered LLM traffic instantly. The deploy carrying this file is the last safe rollback point.
--
-- WHY THE GUARD BELOW EXISTS
-- --------------------------
-- After this DROP, the broker's INSERT is an UNTARGETED `ON CONFLICT DO NOTHING`, which arbitrates
-- over whatever unique constraints happen to exist. If the wide key were missing, malformed, or
-- partial, that INSERT would stop de-duplicating and simply append a fresh row on every single
-- call — the day's counter would never accumulate past 1 and the cap would be disabled a NEW way,
-- silently, with no error anywhere. So we refuse to drop the only remaining arbiter unless a
-- USABLE replacement is provably present: unique, valid, NON-partial (Postgres rejects a partial
-- index as an `ON CONFLICT` arbiter), and with KEY columns — not INCLUDE payload — exactly
-- (tenant_id, user_id, day). This is the same structural check tests/usage-counters-key.test.ts
-- makes, asserted here at the one moment where being wrong is unrecoverable.
--
-- `SET LOCAL lock_timeout` because DROP CONSTRAINT takes an ACCESS EXCLUSIVE lock on a table that
-- every metered LLM call writes to, and the runner applies all pending files inside ONE outer
-- transaction: without a bound, a single long-running reader could block the DROP, and the DROP
-- would in turn queue every subsequent usage_counters access behind it for the whole rollout.
-- Failing fast leaves the schema at 0058 (the savepoint rolls back) and the pod retries on the
-- next boot, which is a strictly better outcome than a stalled deploy.

SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
  arbiters int;
BEGIN
  SELECT count(*) INTO arbiters
    FROM pg_index ix
    JOIN pg_class t     ON t.oid = ix.indrelid
    JOIN pg_namespace n  ON n.oid = t.relnamespace
   WHERE t.relname = 'usage_counters'
     AND n.nspname = 'public'
     AND ix.indisunique
     AND ix.indisvalid
     AND ix.indpred IS NULL          -- a PARTIAL index cannot serve as an ON CONFLICT arbiter
     AND ix.indnkeyatts = 3          -- KEY columns only: an INCLUDE payload does not count
     AND (
           SELECT array_agg(a.attname ORDER BY a.attname)
             FROM unnest(ix.indkey[0:ix.indnkeyatts - 1]) AS k(attnum)
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
         ) = ARRAY['day', 'tenant_id', 'user_id']::name[];

  IF arbiters = 0 THEN
    RAISE EXCEPTION
      'refusing to drop usage_counters_user_day_uq: no usable tenant-aligned arbiter found. '
      'Expected a VALID, NON-PARTIAL UNIQUE index whose KEY columns are exactly '
      '(tenant_id, user_id, day) — created by 0058. Without it the broker''s untargeted '
      'ON CONFLICT DO NOTHING would stop de-duplicating and append one row per LLM call, '
      'disabling the daily cap. Fix 0058 before re-running this migration.';
  END IF;
END $$;

ALTER TABLE usage_counters DROP CONSTRAINT IF EXISTS usage_counters_user_day_uq;
