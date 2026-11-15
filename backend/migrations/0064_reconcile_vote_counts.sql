-- 0064 — every "top" surface in the product ranks on a number nobody cast.
--
-- `challenges.votes_count` and `solutions.votes_count` are denormalized counters. `castVote`
-- (host/vote-service.ts) inserts the `votes` row and does `votes_count = votes_count + 1` in the
-- SAME transaction, so the counter and the rows cannot drift under the APPLICATION. They drift
-- because the two seeders INSERT a fabricated baseline into the column and never write a matching
-- `votes` row — and both seeders say so in their own headers (seed-marketplace.ts:6-8, and the
-- "NEVER touch votes_count" note at seed-tenant-showcase.ts:339-341, which is about the UPDATE
-- path and is correct; the INSERT path is where the number is invented).
--
--
-- THE DEFECT, MEASURED IN PROD (not inferred). `shown` = the column, `real` = rows in `votes`:
-- ------------------------------------------------------------------------------------------
--   solutions   W23 Streaming summarizer with OCR fallback   316 / 2   (x2 tenants)
--               W23 Inline review queue for associates       271 / 1
--               W23 Multi-template field extractor           234 / 1 · 233 / 0
--               W23 Low-code variant with audit log          189 / 1 · 188 / 0
--               W32 Untitled flow                              0 / 0
--               W33 Claim-samenvatting in drie blokken         0 / 0
--   challenges  W23 Auto-summarize claim forms               312 / 2   (x2 tenants)
--               W21 Compare policies in natural language     241 / 0
--               W21 Auto-categorize customer email           203 / 0
--               W23 Draft renewal letters from policy data    198 / 0
--               … 17 challenge rows in all; the only OPEN-week (W33) challenge shows 0.
--
-- `votes` holds **18 rows across the entire platform**. **4,760 are displayed.** Both numbers were
-- measured directly against prod rather than estimated from the table above, which lists only the
-- largest rows. The shape of
-- the lie is the point: the rows a member can still act on read 0, and the rows nobody can act on
-- any more read in the hundreds. So the board does not merely inflate — it inverts. It teaches the
-- reader that participation collapsed, when what actually happened is that participation was never
-- there and the seeded rows never stopped claiming otherwise.
--
-- This is not only a display number. `WINNER_ORDER` (host/cycle-eligibility.ts:71) is
-- `votes_count desc, created_at asc, id asc` and it is what `closeCycle` ranks the WINNER by, and
-- what `/api/winner` ranks the honourable mentions by. A seeded 316 outranks every genuine vote
-- that will ever be cast against it, so under the seeded baseline the winner is decided by the
-- seeder, deterministically, forever. `challenges.ts` sorts the whole Discover board on it too.
--
-- The seeders are OFF in prod (gitops #2472) so nothing NEW is being fabricated there, but the
-- rows they already wrote remain, and both seeders re-inflate on any new tenant. The code half of
-- this change closes that; this file corrects the rows that exist.
--
--
-- THE DECISION: RECONCILE THE COUNTER TO THE ROWS. The demo board collapses from "312 stemmen" to
-- "2 stemmen", and that is the intended outcome, explicitly accepted. There is no version of this
-- where the number stays big and is also true: the only other way to make 312 and 2 agree is to
-- INSERT 310 votes, i.e. to fabricate 310 members' opinions in the table that is supposed to be
-- the evidence. `votes` is the record; the counter is the cache. A cache disagreeing with its
-- record is fixed by recomputing the cache, in one direction only.
--
--
-- ⛔ THE COUNT IS A CORRELATED SUBQUERY INSIDE THE UPDATE — NECESSARY, AND NOT SUFFICIENT.
-- ---------------------------------------------------------------------------------------
-- The obvious spelling — `WITH real AS (SELECT target_id, count(*) …) UPDATE … FROM real` — is a
-- MEASURE-THEN-WRITE, and it can DESTROY A GENUINE VOTE. `castVote` inserts the `votes` row and
-- bumps `votes_count` in one transaction. A vote committing between this file's measurement and
-- its write would be counted in neither: the CTE's snapshot predates the insert, so it computes
-- n, and the UPDATE then stamps n over a column that legitimately holds n+1 — silently deleting
-- one real member's real vote while the `votes` row survives to prove it happened. So the
-- correlated subquery is the right SHAPE — it puts the row lock and the count of that row's
-- `votes` rows in ONE statement, which is as close as SQL gets to doing both at once — and that is
-- why the statements below repeat it instead of factoring it out. It is not a style choice to be
-- tidied up later. But it is NOT the thing that makes this file safe. Read on before deleting the
-- guards.
--
-- ⚠️ RETRACTION — THIS HEADER USED TO CLAIM THE SUBQUERY CLOSES THE RACE. The sentence that stood
-- here said: "The correlated subquery is evaluated as part of the UPDATE's own statement snapshot
-- against the row it is locking, so the window does not exist." IT IS FALSE, and it was disproved
-- by running it, not by re-reading it:
--
--   session V   BEGIN; INSERT INTO votes(…);                       -- a genuine, legitimate vote
--               UPDATE challenges SET votes_count = votes_count + 1 WHERE id = <ch>;
--               -- row now legitimately holds 313 shown / 3 real; V holds the row lock, uncommitted
--   step 1      runs 0.7 s later WITH THE `IF residual <> 0` BRANCH STRIPPED. It blocks on V's row
--               lock. V commits. Step 1 proceeds and writes **shown = 2 against real = 3**.
--               The vote is gone: the `votes` row survives to prove it was cast, and no counter
--               anywhere reflects it.
--
-- The mechanism is documented PostgreSQL behaviour, not a quirk of this schema. Under READ
-- COMMITTED, an UPDATE that blocks on a row lock re-checks the UPDATED ROW when the blocker
-- commits (`EvalPlanQual`) — but it evaluates the rest of the statement, our subquery included,
-- against the statement's ORIGINAL snapshot: "it can see the effects of concurrent updating
-- commands on the same rows it is trying to update, but it does not see effects of those commands
-- on other rows in the database" (PostgreSQL manual, Read Committed Isolation Level). `votes` is
-- another table. EvalPlanQual hands us V's new `challenges` row; it does not hand us V's new
-- `votes` row, so the subquery still counts 2. Verify this rather than trusting it — VC10 in
-- tests/vote-count-reconciliation.test.ts drives exactly the interleaving above, deterministically.
--
-- ⛔ THE RESIDUAL GUARD IS WHAT MAKES THIS FILE SAFE. IT IS NOT A PARANOIA CHECK.
-- The `SELECT count(*) … INTO residual` below is a SECOND STATEMENT, and a second statement under
-- READ COMMITTED takes a FRESH snapshot — which is the first thing in this file that can see V's
-- committed vote. Under the interleaving above the shipped statements raise
--
--       [0064] step 1: 1 challenge row(s) still disagree with the votes table …
--
-- which rolls the whole file back and leaves 313 / 3 — the correct value, because `castVote`'s own
-- `+ 1` already arrived at the truth and this file's only remaining job is to not overwrite it.
-- Delete the `IF residual <> 0` branch and that abort becomes silent, permanent, undetectable vote
-- loss. VC6 and VC10 exist to stop that; VC10 asserts BOTH halves of it (guard present → raises and
-- writes nothing; guard stripped → writes 2 over a real 3).
--
-- THE ACCEPTED CONSEQUENCE: ON A GENUINE CONCURRENT VOTE THIS FILE ABORTS AND WRITES NOTHING.
-- ------------------------------------------------------------------------------------------
-- That is the right trade and it is deliberate, but it is not free, so know what it looks like.
-- db/migration-runner.ts applies every pending file inside ONE outer transaction with a savepoint
-- per file, and server.ts's `await applyMigrations(...)` is a BARE TOP-LEVEL await: the rejection
-- is unhandled, the process exits, and the pod goes CrashLoopBackOff. It SELF-HEALS on the next
-- boot — the vote that provoked it is committed by then, so the subquery counts it and the file
-- applies cleanly — and because the savepoint rolled back, nothing was half-written. This file is
-- re-runnable by construction: every UPDATE carries `IS DISTINCT FROM`, so a re-roll is a no-op on
-- whatever it already fixed. The window is one statement wide on a platform holding 18 votes in its
-- entire history, so the probability is negligible; and the alternative — proceeding, and deleting
-- a member's vote — is strictly worse than a re-roll.
--
-- ⛔ DO NOT "FIX" THIS WITH A RETRY, OR A try/catch AROUND THE BOOT MIGRATIONS. That changes the
-- failure semantics of EVERY migration, forever, to soften one statement in one file; a boot that
-- carries on after a migration failed is a far larger defect than the CrashLoop it would hide. If
-- you are reading this next to a CrashLoop whose logs carry the step 1 or step 2 guard message:
-- someone cast a vote during the roll-out, nothing was written, roll again.
--
-- (The other ordering — a vote committing AFTER this file's UPDATE — is safe by construction: that
-- transaction does its own `+ 1` on the value this file wrote, and arrives at the truth.)
--
--
-- IDEMPOTENCE, AND WHY A NO-OP IS THE CORRECT OUTCOME ON CI
-- --------------------------------------------------------
-- Every UPDATE carries `WHERE <column> IS DISTINCT FROM (<count>)`, so a second run matches ZERO
-- rows and writes nothing — no new `xmin`, no `updated_at` churn, no replication traffic. On a
-- fresh CI database, seeded by a seeder that now clamps, every step matches zero rows on the FIRST
-- run too. That is success, not a failure to detect: this file's job is "counter equals rows", and
-- on a database where that already holds there is nothing to do. A migration that RAISEs because
-- it found nothing to fix would fail on every machine except the one it was measured on.
--
-- ⛔ THE GUARDS BELOW ASSERT A POST-CONDITION — `residual = 0`, nothing still disagrees — and NEVER
-- "not the number I measured in prod". This is 0063 step 4's rule and the reason it is stated there
-- at length: an assertion on a MEASURED COUNT turns a correct backfill into a fleet-wide boot
-- failure everywhere the count legitimately differs. So: NOTICE the count always, EXCEPTION never
-- on its value.
--
-- ⚠️ Do not read "post-condition" as "unreachable", and do not delete these on the grounds that the
-- statement above them cannot fail. `residual <> 0` IS reachable — by the concurrent-vote
-- interleaving in the retraction above, which is the ONLY interleaving that reaches it and the one
-- where the guard is the difference between an abort and a destroyed vote. A guard that has never
-- fired in prod is not a guard that cannot fire.
--
--
-- `updated_at` IS DELIBERATELY NOT TOUCHED. `castVote` bumps it because a vote is an EVENT on the
-- row; a correction to a cache is not, and stamping `now()` across the whole board would assert
-- that seventeen challenges were edited at rollout. Nothing sorts on it (`newest`/`trending` in
-- routes/challenges.ts read `created_at`), so leaving it alone costs nothing and keeps this file
-- from writing its own small fiction while removing a larger one.
--
--
-- ⛔ WHY STEP 3 IS REQUIRED AND IS NOT SCOPE CREEP
-- -----------------------------------------------
-- `weekly_winners.stats` is the frozen "week in numbers" artifact. On the winner screen
-- (frontend/src/routes/winner/+page.svelte:88-89) the LIVE counter and the FROZEN artifact are
-- printed side by side IN THE SAME STAT ROW: "{votesCount} stemmen ontvangen" next to
-- "{stats.totalVotesCast} stemmen uitgebracht". And routes/marketplace-summary.ts:355 only
-- recomputes `stats` when the artifact's is EMPTY (`Object.keys(stats).length === 0`) — prod's two
-- W23 rows are not empty. So steps 1-2 WITHOUT step 3 do not leave a stale number lying around
-- somewhere; they MANUFACTURE, in this migration, a permanent screen that reads
--
--       "2 stemmen ontvangen  ·  1.180 stemmen uitgebracht"
--
-- — 590 votes cast per vote received, on a page where the two numbers are eight pixels apart. A
-- fix that creates a worse-looking lie than the one it removes is not finished.
--
-- ⚠️ CORRECTING A NATURAL PREMISE: those stats were NOT derived from the inflated counters, and
-- anyone reasoning "1180 is just the sum of the fabricated votes_count values, so fixing the
-- counters fixes it" will conclude, wrongly, that step 3 is unnecessary. `1180` and `1207` are
-- HARD-CODED OBJECT LITERALS — seed-tenant-showcase.ts:443 and seed-marketplace.ts:522. They are
-- independent inventions and nothing about steps 1-2 moves them.
--
--
-- ⛔ "SEEDER-WRITTEN" IS A RECORD, NOT A HEURISTIC — AND STEP 3 MUST NOT TOUCH ANYTHING ELSE.
-- -----------------------------------------------------------------------------------------
-- A close-written artifact is the output of a real cycle close and is legitimately FROZEN: it says
-- what the week looked like when it was announced, and recomputing it later would silently rewrite
-- history every time a row moved. Only the seeder's inventions may be recomputed, so the predicate
-- has to separate them by EVIDENCE rather than by resemblance.
--
-- `weekSolutionStats` (host/cycle-eligibility.ts:93-111) is the ONLY other writer of this column —
-- `closeCycle` stamps it, and marketplace-summary calls the same helper — and it returns EXACTLY
-- two keys: `{solutionsSubmitted, totalVotesCast}`. It has never emitted `firstTimeBuilders` or
-- `crossDomain`, and no aggregate anywhere in the codebase can compute either one (there is no
-- "first time" flag on a solution and no cross-domain relation to count). Those two keys therefore
-- exist in exactly one place in the system: the two hard-coded literals named above. Matching on
-- their PRESENCE is reading a marker only the seeder can have left — the same standard 0063 used
-- for `stage = 'content-translation'`.
--
-- The two keys are DROPPED rather than zeroed. `winner/+page.svelte:150-151` guards each tile with
-- `!= null`, so an absent key stops rendering while a `0` renders as a measured zero — "first-time
-- builders: 0" is a fresh false claim, not the removal of one.
--
--
-- WHAT THIS FILE DOES NOT DO
-- --------------------------
--   * It creates and destroys NO `votes` row. It only ever writes the cache, never the record.
--   * It does not stop the seeders. That is the code half of this change (the `fabricate` seam on
--     both seeders, gated by `config.seedFabricatedTelemetry`). Re-running an un-clamped seeder
--     against a reconciled database re-inflates it and this file would have to run again.
--   * It changes no ranking PREDICATE. `WINNER_ORDER` is untouched; it simply starts ordering on
--     real numbers. Week-scoping the Discover board is a separate, already-declined decision
--     (routes/challenges.ts:120-123, with an 8-catalogue relabel attached).
--   * It cannot reach data this database does not own. services/delivery-payload.ts:103 has
--     already stamped `provenance.votes_count` into external Jira / ADO / fr issues; those numbers
--     were true-as-displayed when written and are now permanently inflated over there. Nothing in
--     this repository can correct them, and no future reader should assume they agree with us.
--
--
-- ⛔ REJECTED: A `BEFORE INSERT` TRIGGER ENFORCING `votes_count <= (SELECT count(*) FROM votes …)`.
-- 0055 (`0055_usage_seed_provenance.sql:35-38`) establishes the rule such a trigger would have to
-- follow — scope it to `current_user = 'cp_app'`, or it freezes the table against its own
-- migrations, the seeders and any support fix, with no bypass. But the seeders run as OWNER
-- (`runAsSystem`), so a correctly-scoped trigger would guard every path EXCEPT the one that
-- actually broke, and an incorrectly-scoped one would have blocked this migration. The enforcement
-- that works here is the clamp at the INSERT site plus the un-gated `recountVotes` after the
-- seeder's own genuine `votes` inserts — in the code, where the fabrication is.

SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM OF THIS FILE — same footgun 0063 documents. `SET LOCAL` is TRANSACTION-
-- scoped and db/migration-runner.ts:48-73 applies every pending file inside ONE outer transaction
-- with a savepoint per file, so without the reset this ceiling silently applies to 0065 and
-- everything after it in the same boot.
--
-- Why a ceiling at all on three UPDATEs: they take row locks on `challenges` and `solutions`, and
-- `castVote` holds row locks on exactly those rows for the length of its own transaction. A vote
-- landing during a rollout would otherwise make this file wait unbounded — and because the runner
-- holds ONE outer transaction, every lock taken here is held until the LAST pending file commits.
-- Failing fast rolls back this file's savepoint and the pod retries on its next boot.

-- ---------------------------------------------------------------------------
-- 1. challenges.votes_count := the number of `votes` rows pointing at the challenge.
--    See the correlated-subquery note in the header: the count is INSIDE the UPDATE on purpose.
-- ---------------------------------------------------------------------------
-- >>> 0064 STEP 1 CHALLENGES RECONCILE — extracted verbatim and executed by
-- >>> tests/vote-count-reconciliation.test.ts. Keep the two marker lines intact.
DO $$
DECLARE
  updated  bigint;
  residual bigint;
BEGIN
  UPDATE challenges c
     SET votes_count = (SELECT count(*)::int FROM votes v
                         WHERE v.target_type = 'challenge' AND v.target_id = c.id)
   WHERE c.votes_count IS DISTINCT FROM (SELECT count(*)::int FROM votes v
                                          WHERE v.target_type = 'challenge' AND v.target_id = c.id);
  GET DIAGNOSTICS updated = ROW_COUNT;

  SELECT count(*) INTO residual
    FROM challenges c
   WHERE c.votes_count IS DISTINCT FROM (SELECT count(*)::int FROM votes v
                                          WHERE v.target_type = 'challenge' AND v.target_id = c.id);

  IF residual <> 0 THEN
    RAISE EXCEPTION
      '[0064] step 1: % challenge row(s) still disagree with the votes table after reconciling % '
      'row(s). The likely cause is the one this guard exists for: a GENUINE vote committed while '
      'the UPDATE above was blocked on its row lock, and the UPDATE could not see it (READ '
      'COMMITTED evaluates the subquery against the statement snapshot — see the retraction in '
      'this file''s header). Nothing has been written: castVote''s own + 1 already holds the '
      'correct value, and this file must not overwrite it. Re-roll the pod; the vote is committed '
      'by then and this file applies cleanly. If it recurs on a quiet database, the statement was '
      'edited apart from its guard.', residual, updated;
  END IF;

  RAISE NOTICE '[0064] step 1: votes_count reconciled on % challenge row(s) '
               '(prod measured 15 drifted rows out of 17 challenge rows at the time of writing; 0 '
               'is the CORRECT answer on CI and on any database already in agreement)', updated;
END $$;
-- >>> END 0064 STEP 1 CHALLENGES RECONCILE <<<

-- ---------------------------------------------------------------------------
-- 2. solutions.votes_count — identical statement, `target_type = 'solution'`.
--    Written out rather than factored into a helper function: a plpgsql function taking a table
--    name would need dynamic SQL, which loses the planner's ability to use `votes_target_idx` on
--    the correlated subquery and hides the one detail (the subquery being INSIDE the UPDATE) that
--    this file most needs to keep visible to the next reader.
-- ---------------------------------------------------------------------------
-- >>> 0064 STEP 2 SOLUTIONS RECONCILE — extracted verbatim and executed by
-- >>> tests/vote-count-reconciliation.test.ts. Keep the two marker lines intact.
DO $$
DECLARE
  updated  bigint;
  residual bigint;
BEGIN
  UPDATE solutions s
     SET votes_count = (SELECT count(*)::int FROM votes v
                         WHERE v.target_type = 'solution' AND v.target_id = s.id)
   WHERE s.votes_count IS DISTINCT FROM (SELECT count(*)::int FROM votes v
                                          WHERE v.target_type = 'solution' AND v.target_id = s.id);
  GET DIAGNOSTICS updated = ROW_COUNT;

  SELECT count(*) INTO residual
    FROM solutions s
   WHERE s.votes_count IS DISTINCT FROM (SELECT count(*)::int FROM votes v
                                          WHERE v.target_type = 'solution' AND v.target_id = s.id);

  IF residual <> 0 THEN
    RAISE EXCEPTION
      '[0064] step 2: % solution row(s) still disagree with the votes table after reconciling % '
      'row(s) — same cause and same remedy as the step 1 guard: most likely a genuine vote '
      'committed while this UPDATE was blocked on its row lock, where READ COMMITTED hides it from '
      'the subquery. Nothing written, re-roll. Proceeding instead would stamp a count taken before '
      'that vote over the correct one, and this column decides WINNER_ORDER — and therefore the '
      'winner.', residual, updated;
  END IF;

  RAISE NOTICE '[0064] step 2: votes_count reconciled on % solution row(s) '
               '(prod measured 8 drifted rows at the time of writing; 0 is the CORRECT answer on '
               'CI and on any database already in agreement)', updated;
END $$;
-- >>> END 0064 STEP 2 SOLUTIONS RECONCILE <<<

-- ---------------------------------------------------------------------------
-- 3. weekly_winners.stats — recomputed for SEEDER-WRITTEN rows ONLY.
--
--    ⛔ MUST RUN AFTER STEPS 1 AND 2. `totalVotesCast` sums `solutions.votes_count`, so running
--    this first would freeze the inflated total into the artifact permanently — the artifact is
--    only recomputed once, by this file.
--
--    The recompute is `weekSolutionStats` (host/cycle-eligibility.ts:93-111) transcribed into SQL:
--    same (week, tenant) scope, deliberately NOT status-filtered (the close counts every
--    submission, including drafts that never entered the vote), `coalesce(sum(...), 0)`. Keeping
--    the two in agreement is the point — marketplace-summary recomputes an EMPTY artifact with
--    that helper at request time, so a row this file rewrites and a row the page recomputes must
--    produce the same object.
--
--    `jsonb_exists(stats, k)` rather than `stats ? k`: identical semantics, but `?` is a parameter
--    placeholder in several drivers and this block is also executed verbatim from a test.
--    `jsonb_exists(NULL, k)` is NULL, so artifacts with no stats at all are not selected — those
--    are the DERIVED winners marketplace-summary recomputes live, and they are already correct.
-- ---------------------------------------------------------------------------
-- >>> 0064 STEP 3 WINNER STATS RECOMPUTE — extracted verbatim and executed by
-- >>> tests/vote-count-reconciliation.test.ts. Keep the two marker lines intact.
DO $$
DECLARE
  updated  bigint;
  residual bigint;
BEGIN
  UPDATE weekly_winners w
     SET stats = jsonb_build_object(
           'solutionsSubmitted',
             (SELECT count(*)::int FROM solutions s
               WHERE s.week = w.week AND s.tenant_id = w.tenant_id),
           'totalVotesCast',
             (SELECT coalesce(sum(s.votes_count), 0)::int FROM solutions s
               WHERE s.week = w.week AND s.tenant_id = w.tenant_id))
   WHERE (jsonb_exists(w.stats, 'firstTimeBuilders') OR jsonb_exists(w.stats, 'crossDomain'))
     AND w.stats IS DISTINCT FROM jsonb_build_object(
           'solutionsSubmitted',
             (SELECT count(*)::int FROM solutions s
               WHERE s.week = w.week AND s.tenant_id = w.tenant_id),
           'totalVotesCast',
             (SELECT coalesce(sum(s.votes_count), 0)::int FROM solutions s
               WHERE s.week = w.week AND s.tenant_id = w.tenant_id));
  GET DIAGNOSTICS updated = ROW_COUNT;

  SELECT count(*) INTO residual
    FROM weekly_winners w
   WHERE jsonb_exists(w.stats, 'firstTimeBuilders') OR jsonb_exists(w.stats, 'crossDomain');

  IF residual <> 0 THEN
    RAISE EXCEPTION
      '[0064] step 3: % weekly_winners row(s) still carry firstTimeBuilders/crossDomain after '
      'recomputing % row(s). The recompute writes a two-key object, so a surviving row is '
      'impossible if the UPDATE above ran as written. Leaving one behind means the winner screen '
      'goes on printing a hard-coded total beside the live count it now contradicts — the exact '
      'screen step 3 exists to prevent.', residual, updated;
  END IF;

  RAISE NOTICE '[0064] step 3: recomputed stats on % seeder-written weekly_winners row(s) '
               '(prod measured EXACTLY 2 rows carrying the four-key literal at the time of writing '
               '— both W23, one per tenant; 0 is the CORRECT answer on CI and wherever no seeder '
               'artifact exists)', updated;
END $$;
-- >>> END 0064 STEP 3 WINNER STATS RECOMPUTE <<<

COMMENT ON COLUMN challenges.votes_count IS
  'Denormalized count of `votes` rows with (target_type = ''challenge'', target_id = id). The '
  'CACHE; `votes` is the RECORD. Written by castVote (host/vote-service.ts) as a ±1 inside the '
  'same transaction as the vote row, and recomputed absolutely by recountVotes() — which the '
  'showcase seeder calls UN-GATED after its own raw `votes` inserts, because those bypass '
  'castVote and so bump nothing. Reconciled to the rows by migration 0064 after both seeders were '
  'found INSERTing a fabricated baseline (4,760 displayed votes against 18 real '
  'ones platform-wide). ⛔ Any future correction must recompute with the count as a CORRELATED '
  'SUBQUERY INSIDE the UPDATE — a measure-then-write races castVote and silently destroys a real '
  'vote — AND must not stop there: under READ COMMITTED the subquery is evaluated against the '
  'statement snapshot, so an UPDATE that waited behind a voting transaction still cannot see the '
  'vote it waited for. Close it with a residual re-check that ABORTS (migration 0064) or by taking '
  'the row FOR UPDATE before counting (recountVotes). This column decides the Discover board '
  'ordering (routes/challenges.ts).';

COMMENT ON COLUMN solutions.votes_count IS
  'Denormalized count of `votes` rows with (target_type = ''solution'', target_id = id) — same '
  'contract as challenges.votes_count (see that comment; reconciled by migration 0064). ⛔ Higher '
  'stakes than a display number: this is the FIRST key of WINNER_ORDER '
  '(host/cycle-eligibility.ts:71), so it decides which solution closeCycle crowns and how '
  '/api/winner ranks the honourable mentions. A fabricated value here does not merely misreport '
  'the winner, it CHOOSES one.';

COMMENT ON COLUMN weekly_winners.stats IS
  'The FROZEN "week in numbers" for an announced winner — what the week looked like at close. '
  'Written by closeCycle from weekSolutionStats (host/cycle-eligibility.ts), which emits exactly '
  '{solutionsSubmitted, totalVotesCast}; marketplace-summary recomputes with the same helper when '
  'this is EMPTY, never when it is merely stale. ⛔ Do not "harmonise" a close-written row with '
  'live data: frozen is the point. Migration 0064 recomputed ONLY the seeder-written rows, '
  'identified by carrying `firstTimeBuilders`/`crossDomain` — two keys no aggregate in the '
  'codebase can produce, so their presence is a RECORD of the hard-coded literals at '
  'seed-tenant-showcase.ts:443 / seed-marketplace.ts:522. They were dropped rather than zeroed '
  'because winner/+page.svelte guards each tile with `!= null`, so absent renders nothing while 0 '
  'renders as a measured zero.';

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
