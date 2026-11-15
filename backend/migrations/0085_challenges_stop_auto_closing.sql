-- 0085 — reopen every challenge the CALENDAR closed.
--
-- WHY THIS EXISTS
-- Until the commit that carries this migration, three separate mechanisms closed a challenge purely
-- because its ISO week had passed:
--   1. host/cycle-service.ts `closeCycle`   — swept EVERY challenge in a week when the cycle closed
--                                             ("Always close the week's challenges (winner or not)")
--   2. host/cycle-service.ts `healOrphanedChallenges` — closed anything in a week no tick could reach
--   3. host/cycle-eligibility.ts `challengeClosedOver` — INFERRED closure from the week on read,
--                                             regardless of what `status` actually said
-- All three are gone or narrowed in the same commit. This migration repairs the rows they left.
--
-- The product rule they violated: a challenge can legitimately wait months for someone able to
-- solve it. At a large company holding thousands of challenges that is the NORMAL case. The
-- calendar is not evidence that a piece of work is finished, and demo/evaluation content has to
-- stay available at all times rather than expiring on a timer nobody chose.
--
-- Measured state immediately before this migration (production, 2026-09-02):
--   ALL 17 challenges were status='closed' — weeks W33 x1, W24 x1, W23 x12, W21 x3 — while the live
--   cycle was 2026-W36. The board therefore rendered EMPTY under its default `?open=true` filter,
--   and every challenge vote answered `409 voting_closed`. The newest challenge was authored
--   2026-08-10, so the marketplace had been quietly emptying itself for three weeks.
--
-- ⛔ WHY REOPENING CANNOT DESTROY A HUMAN DECISION.
-- At the time of writing there was NO user-facing way to close a challenge. `update(challenges)`
-- had exactly three writers: `closeCycle` and `healOrphanedChallenges` (both calendar-driven, both
-- changed in this commit) and `enterSolutionPhase`, which does not close. So `status='closed'`
-- recorded no human intent — every closed row was engine-written. That is the entire justification
-- for a blanket repair, and it is checkable: `git log` the two functions above.
--
-- ⚠️ THIS ARGUMENT EXPIRES. The moment an explicit "close this challenge" endpoint exists, the
-- column can no longer distinguish an engine close from a human one — it records neither actor nor
-- timestamp. Any such endpoint MUST land after this migration, never before it, or a later repair
-- of this kind becomes unsafe. If you are adding one, add an actor column at the same time.
--
-- ⛔ WHY IT IS A MIGRATION AND NOT A SCRIPT.
-- `SEED_TENANT_SHOWCASE=false` and `SEED_DEMO_DATA=false` in production, so editing the seed ships
-- nothing (the same trap that forced 0079/0080/0082). And unlike a prod-only data purge, these rows
-- exist in ANY database that ran the showcase seed plus one cycle tick — every developer laptop and
-- every CI run included. A script would fix production and leave everyone else wrong.
--
-- WHAT IT DOES NOT DO: it does not touch `solutions`, `weekly_winners` or `marketplace_cycles`. The
-- weekly competition genuinely is weekly; winners already decided stay decided. Only the challenges
-- outlive their cycle. It also does not rewrite `week` — a challenge's week records which cycle it
-- was authored into, and that is history, not state.

-- The restored phase is INFERRED rather than guessed. A challenge that already has at least one
-- solution filed against it has demonstrably passed its voting stage, so it returns to
-- `solution_phase`; one with no solutions returns to `voting`, the phase the seed authors them in.
-- Both are open: `castVote` refuses only on `closed`, and the submit guard now reads `status` alone.
UPDATE challenges c
SET status = CASE
      WHEN EXISTS (SELECT 1 FROM solutions s WHERE s.challenge_id = c.id) THEN 'solution_phase'
      ELSE 'voting'
    END::challenge_status,
    updated_at = now()
WHERE c.status = 'closed';
