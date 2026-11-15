-- 0061 — split the PLATFORM's LLM load off the HUMAN's governance quota.
--
-- ⛔ FILENAME RECONCILIATION — READ THIS FIRST, IT IS NOT THE 0061 THAT 0060 PROMISED.
-- ---------------------------------------------------------------------------------
-- 0060_block_i18n_tenant_key_expand.sql forward-references a "0061" four times (lines 50, 59,
-- 111, 207): the CONTRACT half that would DELETE the legacy bare-slug `content_translations`
-- rows for tenant-owned blocks, guarded by a RAISE EXCEPTION if any legacy row had no
-- `block_tenant` counterpart. THAT CONTRACT WAS RETIRED, UNWRITTEN, and this file is a
-- DIFFERENT change that merely inherited the next free number.
--
-- Why it was retired, measured against prod (re-verified 2026-08-07, the same day):
--     content_translations WHERE entity_type = 'block'         ->  0 rows
--     content_translations WHERE entity_type = 'block_tenant'  ->  0 rows
-- 0060's own orphan branch (step 4) had already removed all 14 legacy rows — every one of them
-- matched no live `building_blocks.slug`, so they were unreachable, not tenant-owned. A DELETE
-- over an empty set and a RAISE guard that is VACUOUSLY satisfied prove nothing; running them
-- against prod would have manufactured a false sense of a contract having been enforced. The
-- DURABLE half of that spec — "a tenant block's translations must never be filed under the bare
-- slug" — is an INVARIANT, not a cleanup, and it now lives where an invariant belongs: as
-- executable assertions over both write seams (`backfillTranslations` and `publishVersionCore`)
-- in tests/translation-pipeline.test.ts. There is no missing migration. Do not write one.
--
--
-- THE DEFECT THIS FILE EXISTS FOR — MEASURED, NOT INFERRED
-- -------------------------------------------------------
-- `translation_jobs` holds 608 pending rows. ALL 608 carry the SAME
-- `requested_by = 32969c16-6ecd-49fe-a106-ba13e6640dc8` (the `fr-test` identity, home tenant
-- 0195f48b-d000-7000-8000-000000000099). That user's `usage_counters` row for today reads:
--
--     llm_calls  = 50        spend.daily_llm_cap = 50      <- exactly at the cap
--     spend_usd  = 0.000000                                <- and it cost NOTHING
--
-- `AGENT_MODEL` is `local-llm`, which the pricing table prices at 0 in / 0 out, so every one of
-- those calls is free. A $0.00 backlog of 608 jobs is therefore PERMANENTLY blocked by a
-- per-user CALL cap, and it drains at most 50 jobs/day — 13 days, assuming the human whose quota
-- it is never makes a single LLM call of their own (they do; each one they make is a job that
-- does not drain). 504 of the 608 pending rows are block cells, which is precisely why
-- `content_translations` holds ZERO `block` rows and ZERO `block_tenant` rows and every block
-- name/description/docs_md renders ENGLISH in all 8 locales.
--
--
-- THE ROOT CAUSE IS A CATEGORY ERROR IN ONE COLUMN
-- -----------------------------------------------
-- `usage_counters.llm_calls` is doing two incompatible jobs at once:
--
--   1. a GOVERNANCE QUOTA — "how much of THIS HUMAN's daily allowance is left", the thing
--      `spend.daily_llm_cap` is compared against, whose whole purpose is to bound what one
--      person can spend on the company's behalf; and
--   2. a LOAD METER — "how many provider calls did this row cause", the thing the /it-dash fleet
--      headline reads, whose whole purpose is to make traffic visible.
--
-- Platform background work (the translation drainer, and anything like it that follows) is
-- legitimately the second and illegitimately the first. It is not a person; it has no allowance;
-- nobody authorised it by clicking anything today. Attributing its calls to whichever human
-- happened to be `requested_by` is a false statement about a named individual AND, because that
-- number is a cap, a self-inflicted denial of service on the platform's own maintenance.
--
-- The fix is to stop overloading the column: keep `llm_calls` as the human's quota, and give
-- platform load its own counter on the same row. One SELECT still answers both questions.
--
--
-- THE THREE ALTERNATIVES THAT WERE CONSIDERED AND WHY EACH LOSES
-- -------------------------------------------------------------
-- (a) A DEDICATED ROBOT USER. Mint a `platform@…` user row and set `requested_by` to it.
--     * It does not fix anything: the robot gets its OWN `usage_counters` row and its OWN
--       50/day cap, so the 608-job backlog still takes 13 days. It moves the stall, it does not
--       remove it. Raising the robot's cap is alternative (b), below, with extra steps.
--     * `usage_counters` is keyed `(tenant_id, user_id, day)` and `users` carries a NOT NULL
--       `tenant_id`, so it is not one robot — it is one robot user row PER TENANT, forever,
--       created and reconciled on every tenant lifecycle event. A new failure surface in the
--       onboarding path in exchange for nothing.
--     * It DESTROYS AUDIT DATA. `translation_jobs.requested_by` is the record of which human
--       asked for this content to exist; 0060's step 5 goes to real trouble to set it to the
--       block's own maintainer precisely so the right tenant is attributed. Overwriting it with
--       a robot id discards that, irreversibly, to work around a counter.
--
-- (b) A SEPARATE POLICY KNOB, `spend.platform_daily_llm_cap`.
--     * It re-creates the exact same stall at a different number. 608 jobs against a cap of 200
--       is a 4-day stall instead of a 13-day one; the next backfill is bigger than whatever
--       number was chosen, and the failure mode is identical and equally silent.
--     * More fundamentally: at $0.00/call a CALL cap bounds nothing that costs anything. The
--       resource actually worth bounding is MONEY, and money is already bounded — see the
--       weekly ceiling, which this change deliberately leaves in force for platform work.
--
-- (c) JUST SKIP THE INCREMENT for platform calls, no new column.
--     * This is not a simplification, it is a BUG, and a silent one. `releaseCall()` decrements
--       `llm_calls` on EVERY provider failure — that is what stops an outage from burning a
--       user's quota. A reserve path that SKIPS the increment paired with a release path that
--       PERFORMS the decrement STEALS A SLOT FROM THE HUMAN on every failed platform call. 608
--       jobs against a flaky provider would drive a real person's counter NEGATIVE (or to zero
--       and stuck, given `llm_calls > 0`), and nothing anywhere would report it.
--     * RESERVE/RELEASE SYMMETRY IS AN INDEPENDENT ARGUMENT FOR THIS COLUMN even if one did not
--       care about observability at all: the release must be able to decrement EXACTLY the
--       counter the reserve incremented, which requires that counter to exist and to be named.
--
--
-- WHAT THIS FILE DELIBERATELY DOES **NOT** CHANGE
-- ----------------------------------------------
--   * `usage_counters_tenant_user_day_uq (tenant_id, user_id, day)` — untouched. 0059 is a
--     ONE-WAY DOOR (see its header): the moment any user metered under two tenants on one UTC
--     day the pre-tenancy narrow key became un-recreatable. This file adds a COLUMN; it does not
--     go near the key, the arbiter, or the broker's untargeted `ON CONFLICT DO NOTHING`.
--     tests/usage-counters-key.test.ts re-asserts that the 0059 arbiter is still the only one.
--   * `spend_usd` STAYS SHARED. Platform spend accumulates into the SAME `spend_usd` the human's
--     does, and `reserveCall`'s weekly-spend ceiling still runs for platform calls. That is the
--     point: the ceiling is the bound that survives, so platform work can never spend real money
--     without limit even though it is exempt from the call cap. A call cap at $0 bounds nothing;
--     a money ceiling bounds money.
--   * `requireMeteringTenant()` — a platform call is still refused outright with no tenant
--     context. Fail-closed is unchanged.
--   * RLS. `usage_counters_tenant` (`tenant_id = app_current_tenant_uuid()`) and the explicit
--     `tenant_id = app_current_tenant_uuid()` predicate on every broker statement both apply to
--     the new column exactly as they do to `llm_calls`.
--   * `BrokerRejectionKind`. No new rejection kind. That union is mirrored in db/trace-types.ts,
--     the frontend trace types, BlockResultView.svelte and eight i18n catalogues; adding to it is
--     a cross-repo release. A platform call that passes the gate is not rejected at all.
--
--
-- THE NAMED RESIDUAL — STATED, NOT HIDDEN
-- ---------------------------------------
-- Because `spend_usd` stays shared, platform work consumes the WEEKLY MONEY ALLOWANCE of the
-- human in `requested_by`. Today that is exactly zero dollars: `AGENT_MODEL` is `local-llm` and
-- the pricing table prices `local-*` at 0/0, so a platform call adds 0.000000. The day AGENT_MODEL
-- stops being a `local-*` model, background translation starts eating a real person's weekly
-- ceiling and can lock them out of their own chat.
-- That is a REAL future defect and it is deliberately NOT fixed here. The remedy when it arrives
-- is the same shape as this file — a `platform_spend_usd` column plus a platform ceiling — NOT
-- widening this change speculatively now. Adding an unused money column today would mean shipping
-- an unexercised code path on the one code path where being wrong costs money.
--
--
-- WHY `SET LOCAL lock_timeout`, ON A FILE THAT ONLY ADDS COLUMNS
-- -------------------------------------------------------------
-- `ADD COLUMN … DEFAULT 0 NOT NULL` is metadata-only in PG 11+ (no table rewrite), but it still
-- takes ACCESS EXCLUSIVE, and ACQUIRING that lock queues behind any open reader. The runner
-- (db/migration-runner.ts:48-73) applies EVERY pending file inside ONE outer transaction with
-- per-file savepoints, so a lock waited on here is a lock held until the LAST pending file
-- commits — and every metered LLM call in the fleet writes `usage_counters`. An unbounded wait
-- would therefore queue every subsequent `usage_counters` access behind this statement for the
-- whole rollout, i.e. stall all LLM traffic to fix a stalled translation queue. Failing fast
-- instead rolls back this file's savepoint, leaves the schema at 0060, and the pod retries on its
-- next boot. A retried migration beats a wedged fleet.
--
-- NO GRANT AND NO RLS CHANGE IS NEEDED. 0028 (lines 235-246) issued a TABLE-level
-- `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES … TO cp_app`; a table-level grant covers
-- columns added later, including these. The `usage_counters_tenant` policy is row-scoped, not
-- column-scoped, so it applies to the new column with no edit. Nothing to do.

SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM OF THIS FILE. `SET LOCAL` is scoped to the TRANSACTION, and the runner
-- (db/migration-runner.ts) applies every pending file inside ONE outer transaction with a savepoint
-- per file — `RELEASE SAVEPOINT` does not undo a SET LOCAL. Without the reset this 5s ceiling would
-- silently apply to 0062 and everything after it in the same boot, so a later migration that
-- legitimately needs to wait on a lock would fail for a reason nobody wrote down. No effect today
-- (0061 is last), which is exactly why it would have been a confusing surprise later.

-- ---------------------------------------------------------------------------
-- 1. usage_counters.platform_llm_calls — the LOAD half of the split.
--    NOT NULL DEFAULT 0 so every existing row is immediately correct (no platform call has ever
--    been made, so 0 is the true value, not a placeholder) and so the broker's
--    `platform_llm_calls + 1` can never meet a NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE usage_counters
  ADD COLUMN IF NOT EXISTS platform_llm_calls integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN usage_counters.platform_llm_calls IS
  'LLM calls made by PLATFORM background work (translation drainer, etc.) attributed to this '
  '(tenant, user, day) row. Deliberately SEPARATE from llm_calls: llm_calls is a GOVERNANCE '
  'QUOTA bounded by spend.daily_llm_cap and belongs to the human; this is a LOAD METER and is '
  'exempt from that cap (migration 0061). Both the reserve and the release path in '
  'host/llm-broker.ts increment/decrement THIS column for a platform call, never llm_calls — '
  'the symmetry is what stops a failed platform call from stealing a human''s slot. spend_usd '
  'is NOT split: the weekly spend ceiling still bounds platform work. Read llm_calls alone for '
  '"how much is this employee using" (routes/sandboxes.ts); read the SUM of both for fleet load '
  '(host/ops-metrics.ts).';

-- ---------------------------------------------------------------------------
-- 2. Shape guard. `ADD COLUMN IF NOT EXISTS` is a silent no-op against a column that already
--    exists in ANY shape, so a hand-patched environment could carry e.g. a nullable
--    `platform_llm_calls` or a `bigint` with no default and this file would report success.
--    The broker's `platform_llm_calls + 1` on a NULL yields NULL, which the NOT NULL on the
--    column is the only thing preventing — and if the column were nullable that UPDATE would
--    write NULL and the load meter would read as absent forever, silently. Refuse instead.
--    Exactly one column, integer, NOT NULL, default '0'. Anything else is a hard stop.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n int;
  shape record;
BEGIN
  SELECT count(*) INTO n
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'usage_counters'
     AND column_name  = 'platform_llm_calls';

  IF n <> 1 THEN
    RAISE EXCEPTION
      'usage_counters.platform_llm_calls: expected exactly 1 matching column, found %. '
      'The ADD COLUMN above should have guaranteed this — the schema is not what 0061 assumes.', n;
  END IF;

  SELECT data_type, is_nullable, column_default INTO shape
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'usage_counters'
     AND column_name  = 'platform_llm_calls';

  IF shape.data_type <> 'integer'
     OR shape.is_nullable <> 'NO'
     OR shape.column_default IS DISTINCT FROM '0'
  THEN
    RAISE EXCEPTION
      'usage_counters.platform_llm_calls has the WRONG SHAPE: data_type=%, is_nullable=%, '
      'column_default=%. Expected integer / NO / 0. A pre-existing column of another shape makes '
      'ADD COLUMN IF NOT EXISTS a silent no-op; a NULLABLE column in particular would let the '
      'broker''s reserving UPDATE write NULL and the platform load meter would read as absent '
      'forever with no error anywhere. Fix the column by hand, then re-run.',
      shape.data_type, shape.is_nullable, shape.column_default;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. usage_events.stage — the per-call ledger half.
--    `BrokerCallMeta.stage` has existed since the fleet cost emit was added and was threaded all
--    the way into `emitCostEvent`, but the LOCAL ledger row never recorded it: settleSpend's
--    INSERT simply did not have the column. So the OPTIONAL, off-by-default Redis emit knew a
--    row was 'content-translation' and the authoritative billing ledger did not. Nullable with
--    no default and no backfill on purpose: every historical row was written with no stage
--    recorded, so there is nothing to reconstruct from, and stamping them with a guessed value
--    would be a fabrication (identical reasoning to 0053's `price_source` NULLs).
-- ---------------------------------------------------------------------------
ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS stage TEXT;

COMMENT ON COLUMN usage_events.stage IS
  'Optional sub-step label for the call that produced this ledger row — the same value '
  'BrokerCallMeta.stage carries into the fleet cost emit (''flow-run'' | ''agent-chat'' | '
  '''content-translation'' | …). NULL means "written before this column existed, or by a caller '
  'that passed no stage"; it is deliberately NOT backfilled, because no historical row recorded '
  'one and a guessed value would be a fabrication. Correlation only — nothing gates on it.';

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
