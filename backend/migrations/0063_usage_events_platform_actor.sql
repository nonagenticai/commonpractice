-- 0063 — the /usage screen bills a NAMED HUMAN for the PLATFORM's own background work.
--
-- 0061 split the COUNTER (`usage_counters.llm_calls` vs `platform_llm_calls`) so the translation
-- drainer would stop consuming a person's daily quota. It did NOT split the LEDGER. `/usage`
-- reads `usage_events`, not `usage_counters`, and `host/usage-metrics.ts` contains the word
-- `platform` exactly zero times. So the governance stall is fixed and the REPORTING lie is not.
--
--
-- THE DEFECT, MEASURED IN PROD (not inferred)
-- ------------------------------------------
-- 608 `usage_events` rows were written by the translation backfill. Every one of them carries
-- `user_id = 32969c16-6ecd-49fe-a106-ba13e6640dc8` (the `fr-test` identity — the human who asked
-- for the CONTENT to exist, which is audit data 0060 step 5 went to real trouble to get right)
-- and `cost_usd = 0.000000` (AGENT_MODEL is `local-llm`, priced 0 in / 0 out). All four /usage
-- aggregates read that ledger unfiltered, so on the tenant-admin's screen:
--
--   * getStats   — `calls` reads 878 where the humans made 270, and the four `price_source`
--                  buckets are padded by 608 rows nobody authorised.
--   * getByModel — a `local-llm` row: 608 calls, $0.00, a zero-width bar. It is ordered by
--                  spend, so the biggest row by count sorts last and renders as nothing.
--   * getByDay   — the sparkline is plotted on CALLS. The backfill burst sets `dayMax`, so every
--                  genuine human day is squashed to near-zero against a baseline that is not
--                  human activity at all.
--   * getByMember— ONE ROW, A REAL PERSON'S REAL NAME, `calls` = 608 + their own, FUSED INTO ONE
--                  INTEGER. Click the "Calls" column header and that person leaps to the top of
--                  a per-person usage table on work they did not do. The client-side CSV export
--                  then writes `"member","<their name>","608+n","0.0000"` into a file that
--                  LEAVES THE PRODUCT.
--
-- That last one is the reason this file exists. Every other symptom is a wrong number; that one
-- is a false statement about a named individual, printed next to their name, exported to disk.
--
--
-- THE DECISION: EXCLUDE PLATFORM-INITIATED ROWS FROM ALL FOUR AGGREGATES
-- ---------------------------------------------------------------------
-- `/usage` is the TENANT-ADMIN's screen. Every decision it supports — budget, chargeback,
-- per-person coaching — is about work the tenant CAUSED and PAYS FOR. Platform translation of
-- the platform's own block catalogue is none of those three. Note that the page's own lede,
-- "Brokered LLM usage for the active tenant", becomes MORE accurate under this change, not less,
-- which is why it ships with ZERO new i18n keys (there are 8 catalogues and catalogs.test.ts
-- enforces exact key-set equality — a new key is an 8-file change for a sentence that is already
-- true).
--
-- ⛔ THIS COMPLETES A DELIBERATELY ASYMMETRIC TRIO. DO NOT "HARMONISE" THE OTHER TWO:
--     host/ops-metrics.ts   /it-dash fleet headline  = SUM(llm_calls + platform_llm_calls)  BOTH
--     routes/sandboxes.ts   per-person sandbox row   = SUM(llm_calls)                      HUMAN
--     host/usage-metrics.ts /usage, all 4 aggregates = NOT platform_actor                  HUMAN
-- Three questions, three answers, each pinned by its own test (ops-metrics.test.ts,
-- sandboxes-routes.test.ts, usage-metrics-platform.test.ts) which seed the SAME shape and assert
-- DIFFERENT numbers on purpose. Changing one to match another reds exactly one of the three.
--
--
-- ⛔ WHY `platform_actor` AND NOT `stage`. THIS WAS ARBITRATED. DO NOT REVISIT.
-- ---------------------------------------------------------------------------
-- 0061 added `usage_events.stage` and it is TEMPTING to filter on `stage <> 'content-translation'`
-- and add no column at all. That is wrong for a structural reason, not a stylistic one:
--
--   * `stage` is a CORRELATION LABEL. Its live values are 'flow-run', 'agent-chat',
--     'dataset-mapping' and 'content-translation' — THREE OF THE FOUR ARE HUMAN. Filtering on it
--     means hand-maintaining a BLACKLIST of the platform ones inside a SQL string.
--   * That blacklist breaks SILENTLY the day a second platform drainer appears. The new caller
--     passes some new stage, nobody remembers this file, and /usage quietly starts billing a
--     human again — with no error, no test failure, and no way to notice except by re-measuring
--     prod, which is how the 608 rows were found in the first place.
--   * The real discriminator ALREADY EXISTS and is already load-bearing: `BrokerCallMeta
--     .platformActor` (host/llm-broker.ts) is typed as the LITERAL `true` so it must be written
--     out at a call site, and it already decides the daily-cap exemption AND the counter split.
--     It was simply never PERSISTED to `usage_events` — that is the actual gap this file closes.
--   * Threading it through makes forgetting it STRUCTURALLY IMPOSSIBLE. A future platform caller
--     that forgets the flag also loses its cap exemption and stalls at 50 calls/day — i.e. it
--     fails LOUDLY and immediately, in the same way the 608-job backlog did, instead of silently
--     mis-attributing forever. The failure mode moves from "wrong number nobody sees" to
--     "the feature does not work", which is the trade you want.
--
--
-- WHY THE BACKFILL BELOW IS LEGITIMATE, WHERE 0053's AND 0061's WERE NOT
-- ---------------------------------------------------------------------
-- 0053 (`price_source`) and 0061 (`stage`) both REFUSED to backfill, and said so: every
-- historical row had been written with NO record of the value, so any stamped value would have
-- been a guess dressed as data. That reasoning does not apply here, and the difference is
-- evidentiary, not a change of heart:
--
--   THE 608 ROWS CARRY A RECORDED DISCRIMINATOR. `host/translation-service.ts` is the ONLY site
--   in the codebase that emits `stage: 'content-translation'`, and it emits `platformActor: true`
--   ON THE SAME OBJECT LITERAL — one call site, both fields, no branch between them. So
--   `stage = 'content-translation'` is not a heuristic for "was a platform call"; within this
--   codebase it is a RECORD of one, written by the only writer that can produce it.
--
-- That is reconstruction FROM EVIDENCE, which 0053 explicitly allowed for and simply did not
-- have. The guard on step 3 refuses to proceed unless the UPDATE touched exactly as many rows as
-- match the predicate, so a partial write cannot pass silently.
--
--   THE 106 PRE-0061 ROWS CARRY THE SAME QUALITY OF EVIDENCE, IN A DIFFERENT TABLE. `stage` did
--   not exist until 0061, so the platform translations that completed BEFORE it shipped wrote
--   ledger rows with `stage IS NULL` and step 3 does not claim them. `translation_jobs` holds
--   **714** done jobs, not 608; the missing 106 are exactly those pre-0061 completions. They are
--   NOT indistinguishable, which is what an earlier draft of this header wrongly asserted (see
--   the residual section below, which now records the correction): the THIRD FIELD is
--   `translation_jobs` itself, in this same database. Correlating `usage_events.created_at`
--   against `translation_jobs.updated_at WHERE status = 'done'` returns EXACTLY 106 at a ±10s
--   tolerance AND EXACTLY 106 at ±90s — the window is therefore NOT load-bearing, which is the
--   whole point: a correlation whose answer is stable across a 9× widening of the tolerance is
--   measuring a real coincidence of events, not an artefact of a threshold someone tuned. It
--   also agrees at DAY granularity (06-14: 7, 06-29: 49, 08-08: 50), against ZERO jobs done on
--   the days that hold the other 38 NULL-stage rows.
--
--   ⛔ THE EVIDENTIARY STANDARD IS IDENTICAL TO THE ONE THIS FILE ALREADY ACCEPTS FOR THE 608,
--   and that symmetry IS the argument — it is not a second, looser rule bolted on. In both cases
--   the value is reconstructed from a RECORD written by the only writer that can produce it:
--   step 3 reads a record `translation-service.ts` left in `usage_events.stage`; step 4 reads a
--   record the SAME code path left in `translation_jobs` on the SAME call. One drainer, one
--   moment, two rows. Rejecting step 4 while accepting step 3 would mean holding that a record
--   is evidence only when it happens to live in the table being corrected, which is a statement
--   about table layout, not about what is known.
--
--
-- ⛔ THE NAMED RESIDUAL — MEASURED, AND CORRECTED IN PLACE
-- -------------------------------------------------------
-- ⚠️ AN EARLIER DRAFT OF THIS FILE CLAIMED, IN THIS PARAGRAPH, that pre-0061 platform rows were
-- "NOT separable from the 144 human NULL-stage `local-llm` rows … there is no third field to tell
-- them apart". BOTH HALVES OF THAT WERE FALSE, and the sentence is preserved here as a retraction
-- rather than quietly deleted, because it was the sentence that JUSTIFIED NOT FIXING the problem:
--   * there are 144 NULL-stage `local-llm` rows IN TOTAL, of which **106 are platform** and only
--     **38 are human**. The claim treated the entire bucket as human and so mis-stated a 106-row
--     mis-attribution as a rounding detail; and
--   * there IS a third field — `translation_jobs`, in this same database (see step 4 above).
-- A residual asserted without measuring it is worse than no residual note at all: it converts an
-- open question into a settled one and stops the next reader from looking.
--
-- WHAT THE RESIDUAL ACTUALLY IS, AFTER STEPS 3 AND 4:
--   * 608 rows claimed by `stage = 'content-translation'`                       (step 3)
--   * 106 rows claimed by correlation against `translation_jobs`                (step 4)
--   * 38 NULL-stage `local-llm` rows remain attributed and ARE GENUINELY HUMAN — zero translation
--     jobs completed on those days, so there is nothing to claim them with and nothing to fix.
--   * THE TRUE RESIDUAL is any platform call that left NO job row at all. None is currently known
--     to exist: `translation-service.ts` is driven by the job table, so a call without a job row
--     would require a code path that does not exist today. If one is ever added, THIS is the
--     paragraph it invalidates — and the remedy is the flag, not another correlation.
-- Every one of these rows is $0.00 (AGENT_MODEL is `local-llm`, priced 0/0), so no money was ever
-- misreported by any of this; what was misreported is a CALL COUNT beside a person's name.
--
-- WHY THIS MATTERED MORE THAN "608 vs 714" SUGGESTS. The /usage page defaults to range=30
-- (frontend `+page.svelte`), and the 106 unclaimed rows are NOT spread evenly across time — they
-- cluster in the recent window. Measured against prod for the named human `32969c16`, step 3
-- ALONE would have left:
--       range | row today | after step 3 | still platform | genuinely hers
--          7d |       658 |           50 |             50 |  0   (100% wrong)
--         30d |       660 |           52 |             50 |  2   (26x overstated)
--         90d |       752 |          144 |            106 | 38   (3.8x)
-- i.e. the DEFAULT VIEW of the screen this migration exists to fix would still have been wrong by
-- 26×, and the 7-day view would have been 100% platform work under a real person's name. A fix
-- that is correct only outside the default range is not a fix.
--
--
-- WHY `SET LOCAL lock_timeout` ON A FILE THAT ADDS ONE COLUMN
-- ----------------------------------------------------------
-- Same reasoning as 0061's, and it now has a second edge: the ADD COLUMN takes ACCESS EXCLUSIVE
-- on `usage_events` — the hottest INSERT path in the product (one row per brokered LLM call) —
-- and the runner (db/migration-runner.ts:48-73) applies EVERY pending file inside ONE OUTER
-- TRANSACTION with a savepoint per file, so a lock waited on here is held until the LAST pending
-- file commits. An unbounded wait would queue every metered LLM call in the fleet behind this
-- statement for the whole rollout. Failing fast rolls back this file's savepoint, leaves the
-- schema at 0062, and the pod retries on its next boot. A retried migration beats a wedged fleet.
--
-- NO GRANT AND NO RLS CHANGE. 0028 issued a TABLE-level GRANT to `cp_app`, which covers columns
-- added later; the `usage_events` tenant policy is row-scoped, not column-scoped.
--
-- NO INDEX. See the comment in host/usage-metrics.ts — `usage_events_tenant_created_idx` already
-- serves the selective part of every one of these predicates, the table is low-thousands of rows,
-- and a ~69/31 boolean is a column the planner will never choose, so a b-tree on it would buy
-- nothing and cost write amplification on that hottest INSERT path. If it ever does matter the
-- right shape is PARTIAL — `(tenant_id, created_at) WHERE NOT platform_actor` — not this.

SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM OF THIS FILE. `SET LOCAL` is scoped to the TRANSACTION, and the runner
-- applies every pending file inside ONE outer transaction with a savepoint per file — `RELEASE
-- SAVEPOINT` does not undo a SET LOCAL. Without the reset this 5s ceiling silently applies to
-- 0064 and everything after it in the same boot, so a later migration that legitimately needs to
-- wait on a lock fails for a reason nobody wrote down. 0061 left exactly this footgun behind once
-- already; the reset is the fix, not a formality.

-- ---------------------------------------------------------------------------
-- 1. usage_events.platform_actor — the per-call ATTRIBUTION discriminator.
--    NOT NULL DEFAULT false so the /usage predicate (`NOT platform_actor`) can never meet a NULL
--    and silently drop a real human's row: in SQL, `NOT NULL_value` is NULL, which is not TRUE,
--    which means the row VANISHES from every aggregate with no error anywhere. A nullable column
--    here would therefore under-report humans, i.e. fail in the OPPOSITE direction from the
--    defect being fixed, and just as silently. false is also the TRUE value for every row written
--    before this column existed apart from the 608 the step-3 backfill claims.
-- ---------------------------------------------------------------------------
ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS platform_actor boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. Shape guard (0061 step 2's pattern). `ADD COLUMN IF NOT EXISTS` is a SILENT NO-OP against a
--    column that already exists in ANY shape, so a hand-patched environment carrying e.g. a
--    NULLABLE `platform_actor`, or a `text` one, would let this file report success and leave
--    /usage under-reporting humans forever (see the NULL reasoning above). Refuse instead:
--    exactly one column, boolean, NOT NULL, default 'false'. Anything else is a hard stop.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n int;
  shape record;
BEGIN
  SELECT count(*) INTO n
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'usage_events'
     AND column_name  = 'platform_actor';

  IF n <> 1 THEN
    RAISE EXCEPTION
      'usage_events.platform_actor: expected exactly 1 matching column, found %. '
      'The ADD COLUMN above should have guaranteed this — the schema is not what 0063 assumes.', n;
  END IF;

  SELECT data_type, is_nullable, column_default INTO shape
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'usage_events'
     AND column_name  = 'platform_actor';

  IF shape.data_type <> 'boolean'
     OR shape.is_nullable <> 'NO'
     OR shape.column_default IS DISTINCT FROM 'false'
  THEN
    RAISE EXCEPTION
      'usage_events.platform_actor has the WRONG SHAPE: data_type=%, is_nullable=%, '
      'column_default=%. Expected boolean / NO / false. A pre-existing column of another shape '
      'makes ADD COLUMN IF NOT EXISTS a silent no-op; a NULLABLE column in particular would make '
      'the /usage predicate `NOT ue.platform_actor` evaluate to NULL — which is not TRUE — and so '
      'skip REAL HUMAN rows forever, with no error anywhere. Fix the column by hand, then re-run.',
      shape.data_type, shape.is_nullable, shape.column_default;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Backfill the 608 measured rows — see "WHY THE BACKFILL BELOW IS LEGITIMATE" above.
--    `host/translation-service.ts` is the ONLY emitter of `stage = 'content-translation'` and it
--    always emits `platformActor: true` on the same object literal, so this reconstructs a
--    RECORDED value rather than guessing one.
--
--    The guard is not ceremony: without it a permission problem, an RLS surprise or a partially
--    applied earlier run would leave some subset attributed and the /usage screen would go on
--    billing a human for whatever it missed — the exact silent-partial-fix this file exists to
--    end. Prod measured 608 at the time of writing; a different count here is INFORMATION (the
--    drainer kept running, or this is not prod), not necessarily an error, which is why the
--    exception fires on UPDATED <> MATCHED and not on a hard-coded 608.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  matched  bigint;
  updated  bigint;
BEGIN
  SELECT count(*) INTO matched FROM usage_events WHERE stage = 'content-translation';

  UPDATE usage_events SET platform_actor = true WHERE stage = 'content-translation';
  GET DIAGNOSTICS updated = ROW_COUNT;

  IF updated <> matched THEN
    RAISE EXCEPTION
      'usage_events.platform_actor backfill is INCOMPLETE: % rows match '
      'stage = ''content-translation'' but only % were updated. Every unclaimed row keeps billing '
      'the human in its user_id on the /usage screen, which is the defect 0063 exists to fix. '
      'Do not proceed on a partial attribution.', matched, updated;
  END IF;

  RAISE NOTICE '[0063] step 3: platform_actor backfilled on % content-translation row(s) '
               '(prod measured 608 at the time of writing)', updated;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Backfill the PRE-0061 platform rows, which step 3 structurally cannot reach.
--
--    `stage` did not exist until 0061, so every platform translation that completed before it
--    shipped wrote a ledger row with `stage IS NULL`. Prod: `translation_jobs` holds 714 done
--    jobs; step 3 claims 608; these are the other 106. Leaving them is not a rounding detail —
--    the /usage page DEFAULTS to range=30, where those 106 are 50 of the 52 calls still shown
--    against one named human (26x overstated), and at range=7 they are ALL 50 of them (100%
--    wrong). See the header for the full table and for the evidentiary argument, which is the
--    SAME one step 3 rests on: this reads a record the same drainer wrote on the same call, in
--    a different table.
--
--    ±10s is not a tuned threshold. ±10s and ±90s both return EXACTLY 106, and the match holds
--    at day granularity (06-14: 7, 06-29: 49, 08-08: 50, and ZERO done jobs on the days holding
--    the 38 genuinely-human NULL-stage rows). A correlation stable across a 9x widening of the
--    window is measuring the events, not the window.
--
--    ⛔ NO HARD ROW-COUNT ASSERTION HERE, UNLIKE STEP 3, AND THE ASYMMETRY IS DELIBERATE. Step 3's
--    predicate is self-describing (`stage = 'content-translation'`), so "matched" and "updated"
--    must agree and a divergence is a real fault. Step 4's expected count is a property of ONE
--    DATABASE'S HISTORY: 106 in prod, and legitimately ZERO on CI, on a fresh dev box, and on
--    every database seeded after this file ships. RAISE-ing on "not 106" would make this
--    migration fail everywhere except the one machine it was measured on — the classic way a
--    correct backfill becomes an outage. So: NOTICE the count always, and EXCEPTION only on an
--    IMPOSSIBLE over-claim (more rows updated than there were candidates), which would mean the
--    predicate is not doing what it says.
--
--    `AND NOT ue.platform_actor` keeps this idempotent: a re-run claims nothing and reports 0.
-- ---------------------------------------------------------------------------
-- >>> 0063 STEP 4 BACKFILL — extracted verbatim and executed by
-- >>> tests/usage-metrics-platform.test.ts. Keep the two marker lines intact.
DO $$
DECLARE
  candidates bigint;
  updated    bigint;
BEGIN
  SELECT count(*) INTO candidates
    FROM usage_events
   WHERE stage IS NULL AND model = 'local-llm' AND NOT platform_actor;

  UPDATE usage_events ue SET platform_actor = true
   WHERE ue.stage IS NULL AND ue.model = 'local-llm' AND NOT ue.platform_actor
     AND EXISTS (SELECT 1 FROM translation_jobs tj
                  WHERE tj.status = 'done'
                    AND tj.updated_at BETWEEN ue.created_at - interval '10 seconds'
                                          AND ue.created_at + interval '10 seconds');
  GET DIAGNOSTICS updated = ROW_COUNT;

  IF updated > candidates THEN
    RAISE EXCEPTION
      '[0063] step 4 claimed % rows from a candidate pool of % — impossible. The UPDATE predicate '
      'is not the one the candidate count was taken over, so this backfill is attributing rows it '
      'was never shown to be about. Refusing to proceed.', updated, candidates;
  END IF;

  RAISE NOTICE '[0063] step 4: platform_actor backfilled on % of % NULL-stage local-llm row(s) by '
               'correlation against translation_jobs (prod measured 106 of 144 at the time of '
               'writing; 0 is the correct answer on CI and on any fresh database)',
               updated, candidates;
END $$;
-- >>> END 0063 STEP 4 BACKFILL <<<

COMMENT ON COLUMN usage_events.platform_actor IS
  'TRUE when this ledger row came from work the PLATFORM itself initiated with no human in the '
  'loop (today: the translation drainer) — the persisted form of BrokerCallMeta.platformActor, '
  'written by settleSpend from the SAME `meta?.platformActor === true` expression that decides '
  'the daily-cap exemption and the usage_counters split, so the ledger and the counter cannot '
  'disagree (migration 0063, on top of 0061). READ SITES, all in host/usage-metrics.ts and all '
  'four EXCLUDING it: getStats, getByModel, getByMember (WHERE) and getByDay (in the LEFT JOIN '
  'ON clause — in WHERE it would degenerate the join to an INNER JOIN and destroy the '
  'generate_series zero-fill). /usage is the tenant-admin''s budget + chargeback + per-person '
  'screen and platform background work is none of those. ⛔ DELIBERATELY ASYMMETRIC with the two '
  'usage_counters readers: host/ops-metrics.ts sums BOTH columns (fleet load) and '
  'routes/sandboxes.ts sums llm_calls ONLY (one person''s row). Three questions, three answers — '
  'do not harmonise them. NOT filtered on `stage`: that is a correlation label whose live values '
  'are 3/4 human, so filtering on it means a hand-maintained blacklist that breaks silently when '
  'a second platform drainer appears. BACKFILLED IN TWO STEPS: 608 rows by '
  'stage = ''content-translation'', then 106 PRE-0061 rows (written before `stage` existed) by '
  'correlating created_at against translation_jobs.updated_at WHERE status = ''done'' — stable at '
  'both ±10s and ±90s, so the window is not load-bearing. RESIDUAL: the 38 NULL-stage local-llm '
  'rows that remain are GENUINELY HUMAN (zero jobs completed on those days). The only true '
  'residual is a platform call that left no job row, of which none is currently known.';

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
