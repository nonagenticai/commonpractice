-- 0047_weekly_cycle_tenant_align.sql
--
-- Heals the four data defects behind "the weekly cycle has never produced a winner".
-- Every statement is idempotent (re-running changes nothing).
--
-- ⚠️ APPLY THIS FILE INSIDE A TRANSACTION. The realign below is a DELETE followed by an
--    INSERT (a single UPDATE trips the (tenant_id, week) unique index mid-statement when two
--    rows swap tenants). db/migration-runner.ts already wraps every file in one transaction
--    with a per-file SAVEPOINT, so the normal startup path is safe and needs nothing. But
--    `psql -f` runs in autocommit: a failure between those two statements would permanently
--    destroy the realigned winner rows. If you apply this by hand, wrap it: psql -1 -f …
--
--   1. weekly_winners rows whose solution belongs to ANOTHER tenant (same class of defect
--      0042 healed for flows). GET /api/winner takes the tenant's latest row by
--      announced_at; the demo tenant's 2026-W21 row was announced LATER than its real W23
--      one, pointed at a different tenant's solution, and therefore resolved to nothing
--      under RLS — so the marquee page rendered its empty state with a real winner in the
--      table. Every row's TRUE owner is its solution's tenant; we keep one row per
--      (true owner, week) and realign it, and drop the rest.
--
-- SCOPE, stated plainly: this heals the DATA, it does not retro-create the seven missing
-- winners. Every existing row is backfilled to the ISO week it was actually created in
-- (all in the past), so nothing here becomes eligible for a future close. 2026-W24…W30
-- stay winner-less because no eligible solution was ever filed against them, and inventing
-- one would be fabrication (the same posture as routes/marketplace-summary.ts's HONEST
-- stats note). /winner is unblocked for content submitted from the deploy onward, and the
-- existing "top shipping solution" fallback keeps the page populated until then.
--   2. challenges.code duplicates within one tenant — seed-marketplace and
--      seed-tenant-showcase both stamp 'CH-284' onto the demo tenant. Renumber the losers
--      so the per-tenant unique index below can be created.
--   3. The per-tenant unique index on (tenant_id, code), which the new code allocator in
--      routes/challenges.ts relies on to make its max+1 race-safe.
--   4. The `week = ''` backfill. No route ever wrote a real ISO week (challenges hardcoded
--      '', solutions omitted the column entirely and took the '' default), so the weekly
--      close matched nothing, forever. Derive each pre-fix row's week from created_at.
--   5. marketplace_cycles.winner_solution_id / .stats: cleared. That table is the GLOBAL
--      phase clock (a platform table, no RLS — 0028) and those two single-valued columns
--      cannot represent N per-tenant winners; every value in them is one arbitrary tenant's
--      solution id plus platform-wide vote totals. cycle-service no longer writes them and
--      routes/cycle.ts no longer serves them; weekly_winners is the winner artifact.

-- 1a. Decide the whole outcome up front from a TOTAL ORDER, not from "does a conflicting row
--     exist right now". An earlier draft realigned first (guarded by NOT EXISTS) and deleted the
--     remainder, which made the result depend on the statement-start snapshot: with two mutually
--     conflicting rows in one week, each saw the other and BOTH were deleted even though one
--     could have been saved. Here the keeper for each (true owner, week) is chosen by rank —
--     already-aligned first, then the most recent announcement, then id — so the same data always
--     produces the same result regardless of evaluation order. weekly_winners is
--     UNIQUE(tenant_id, week) (0041), and an aligned row has tenant_id = its solution's tenant,
--     so there can be at most one aligned candidate per group: a genuine row always wins.
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

-- 1b. Realign the survivors. Exactly one row per (true owner, week) is left, but a plain UPDATE
--     can still trip the unique index mid-statement when two rows swap tenants, so the rows are
--     moved out and back in as two SEPARATE statements — the delete is fully applied before the
--     insert's uniqueness checks run. Idempotent: on a second run nothing is misaligned, the plan
--     table is empty, and both statements touch zero rows.
DROP TABLE IF EXISTS cp_0047_realign;
CREATE TEMP TABLE cp_0047_realign AS
SELECT ww.id, ww.week, s.tenant_id AS true_tenant, ww.solution_id, ww.challenge_id,
       ww.stats, ww.announced_at
FROM weekly_winners ww
JOIN solutions s ON s.id = ww.solution_id
WHERE ww.tenant_id IS DISTINCT FROM s.tenant_id;

DELETE FROM weekly_winners WHERE id IN (SELECT id FROM cp_0047_realign);

INSERT INTO weekly_winners (id, week, tenant_id, solution_id, challenge_id, stats, announced_at)
SELECT id, week, true_tenant, solution_id, challenge_id, stats, announced_at
FROM cp_0047_realign;

DROP TABLE cp_0047_realign;

-- 2. Renumber duplicate per-tenant codes. Oldest row keeps the code; each loser gets the
--    next free CH-n for its tenant (the same scheme the allocator uses).
WITH ranked AS (
  SELECT id, tenant_id,
         row_number() OVER (PARTITION BY tenant_id, code ORDER BY created_at, id) AS rn
  FROM challenges
  WHERE code IS NOT NULL
),
losers AS (
  SELECT id, tenant_id,
         row_number() OVER (PARTITION BY tenant_id ORDER BY id) AS k
  FROM ranked
  WHERE rn > 1
),
maxima AS (
  -- {1,9} digits, not +: an 11-digit CH- code overflows int4 and `value "99999999999" is out of
  -- range for type integer` would abort this whole migration file at BOOT (migrations run at
  -- backend startup). Bounding the capture makes the cast total — a wider code simply sits
  -- outside the CH-n scheme and is ignored by the numbering, which is the safe reading. 999999999
  -- + the loser count still fits int4, so the arithmetic below cannot overflow either.
  SELECT tenant_id,
         max((substring(code from '^CH-([0-9]{1,18})$'))::bigint) AS maxn
  FROM challenges
  WHERE code ~ '^CH-[0-9]{1,18}$'
  GROUP BY tenant_id
)
UPDATE challenges c
SET code = 'CH-' || (coalesce(m.maxn, 0) + l.k)
FROM losers l
LEFT JOIN maxima m ON m.tenant_id = l.tenant_id
WHERE c.id = l.id;

-- 3. Per-tenant uniqueness. Partial: the historical code-less rows stay legal.
CREATE UNIQUE INDEX IF NOT EXISTS challenges_tenant_code_key
  ON challenges (tenant_id, code)
  WHERE code IS NOT NULL;

-- 4. Backfill the never-stamped weeks. `week = ''` is itself the "predates the fix" marker —
--    from this migration on, both create routes write a real label — and created_at is the
--    honest source: it is the ISO week whose cycle was running when the row was submitted,
--    which is exactly what the (ISO-week-aligned) phase clock would have judged it in.
--    UTC-pinned to match cycle-service's weekString, which works entirely in UTC.
UPDATE challenges
SET week = to_char(created_at AT TIME ZONE 'UTC', 'IYYY-"W"IW')
WHERE week = '';

UPDATE solutions
SET week = to_char(created_at AT TIME ZONE 'UTC', 'IYYY-"W"IW')
WHERE week = '';

-- 5. Drop the known-wrong global winner/stat values off the phase clock.
UPDATE marketplace_cycles
SET winner_solution_id = NULL, stats = NULL
WHERE winner_solution_id IS NOT NULL OR stats IS NOT NULL;
