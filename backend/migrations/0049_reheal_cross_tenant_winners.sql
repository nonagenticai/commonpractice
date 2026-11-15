-- 0049_reheal_cross_tenant_winners.sql
--
-- Re-runs 0047's cross-tenant winner heal, once, because the seed undid it.
--
-- 0047 applied cleanly in production at 2026-07-29T01:45:32.535Z and deleted the misaligned
-- weekly_winners row exactly as designed. Nine seconds later, on the SAME boot, the demo seed
-- re-created it (announced_at 2026-07-29T01:45:41.101Z): seed-marketplace.ts adopts a solution
-- idempotently by (challenge, title), so on a database carrying pre-C.1 data it picks up a legacy
-- row living in one of the old per-USER tenants and paired that id with a hardcoded
-- DEMO_TENANT_ID. That seed bug is fixed (the tenant now comes from the solution), so the row
-- cannot come back — but 0047 has already been recorded as applied and will never run again, so
-- the row it deleted is sitting there once more. This migration removes it.
--
-- Deliberately a re-run of the same heal rather than a targeted `DELETE ... WHERE id = '019fab8c…'`:
-- a hardcoded id would be a no-op on every other environment and would silently miss any other
-- misalignment the same seed bug produced elsewhere. This is set-based and self-describing.
--
-- Idempotent by construction: on a database with no misaligned rows every statement touches zero
-- rows. Safe to run against a database that never had the problem.
--
-- ⚠️ APPLY THIS FILE INSIDE A TRANSACTION, for the same reason as 0047: the realign is a DELETE
--    followed by an INSERT (a single UPDATE trips the (tenant_id, week) unique index mid-statement
--    when two rows swap tenants). db/migration-runner.ts already wraps every file in one
--    transaction with a per-file SAVEPOINT, so the normal startup path needs nothing. If you apply
--    this by hand, use `psql -1 -f` — `psql -f` is autocommit and a failure between the two
--    statements would permanently destroy the realigned rows.

-- 1. Keep one row per (TRUE owner, week), chosen by a total order so the outcome never depends on
--    evaluation order: already-aligned first, then the most recent announcement, then id. An
--    aligned row has tenant_id = its solution's tenant and weekly_winners is UNIQUE(tenant_id,
--    week), so there is at most one aligned candidate per group — a genuine row always wins.
WITH truth AS (
  SELECT ww.id,
         ww.week,
         s.tenant_id AS true_tenant,
         (ww.tenant_id = s.tenant_id) AS aligned,
         ww.announced_at
  FROM weekly_winners ww
  JOIN solutions s ON s.id = ww.solution_id
),
keeper AS (
  SELECT DISTINCT ON (true_tenant, week) id
  FROM truth
  ORDER BY true_tenant, week, aligned DESC, announced_at DESC, id
)
DELETE FROM weekly_winners ww
USING truth t
WHERE t.id = ww.id
  AND NOT EXISTS (SELECT 1 FROM keeper k WHERE k.id = t.id);

-- 2. Realign whatever survived onto its solution's tenant, out-and-back-in so the delete is fully
--    applied before the insert's uniqueness checks run.
DROP TABLE IF EXISTS cp_0049_realign;
CREATE TEMP TABLE cp_0049_realign AS
SELECT ww.id, ww.week, s.tenant_id AS true_tenant, ww.solution_id, ww.challenge_id,
       ww.stats, ww.announced_at
FROM weekly_winners ww
JOIN solutions s ON s.id = ww.solution_id
WHERE ww.tenant_id IS DISTINCT FROM s.tenant_id;

DELETE FROM weekly_winners WHERE id IN (SELECT id FROM cp_0049_realign);

INSERT INTO weekly_winners (id, week, tenant_id, solution_id, challenge_id, stats, announced_at)
SELECT id, week, true_tenant, solution_id, challenge_id, stats, announced_at
FROM cp_0049_realign;

DROP TABLE cp_0049_realign;
