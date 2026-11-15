// src/host/vote-service.ts — the one upvote-per-user-per-target toggle, shared by
// the challenge and solution vote endpoints. A `votes` row is a genuine per-user
// upvote; the denormalized `votes_count` on the target is bumped ±1 in the SAME
// transaction so the leaderboard count and the real vote rows never drift. The
// unique (user, target_type, target_id) constraint makes a double-vote a no-op
// (idempotent), so the count is never double-bumped.
//
// ⚠️ RETRACTION. This header used to describe `votes_count` as "seeded with a fidelity
// baseline", stated as part of the design. It was not a baseline, it was a fabrication, and
// naming it here is what made it survive review: 17 challenge rows and 8 solution rows carried
// 4,760 displayed votes against 18 real `votes` rows platform-wide (measured), and `WINNER_ORDER`
// (host/cycle-eligibility.ts:71) ranks the WINNER on this column — so the seeder, not the
// members, decided who won. `votes` is the RECORD; this column is a CACHE of it and has no
// licence to hold anything else. Migration 0064 reconciled the existing rows; both seeders now
// clamp the INSERT to 0 when fabrication is off, and `recountVotes` below repairs the counter
// after any writer that inserts `votes` rows without going through `castVote`.
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, votes, challenges, solutions } from '../db/client';
import { notFound, forbidden, conflict } from '../utils/http';
// The vote gate is the SHARED cycle predicate, not a rule spelled here. The gate state comes from the
// cadence resolver (host/cycle-cadence.ts) rather than `cycle-service` on purpose: this is the hot path
// behind every upvote click and it must not drag `enqueueWinner`/`recordAudit`/`config` in behind
// it. Same discipline cycle-eligibility.ts applies to the read path.
import { periodClosedSql, SOLUTION_PERIOD } from './cycle-eligibility';
import { currentPeriodGate } from './cycle-cadence';

export type VoteTarget = 'challenge' | 'solution';

/** Either the pool `db` or a drizzle transaction handle — `recountVotes` composes into a
 *  caller's transaction so the counter it writes and the `votes` rows it counted are one
 *  atomic step. Same shape as host/cycle-eligibility.ts's `DbOrTx`. */
type Db = typeof db;
type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface VoteResult {
  voted: boolean;
  count: number;
}

const targetTable = (type: VoteTarget) => (type === 'challenge' ? challenges : solutions);

interface VoteEligibility {
  votesCount: number;
  authorId: string;
  closed: boolean;
}

/**
 * Confirm the target row exists (404 otherwise) and return its votes_count, its
 * author/submitter id (self-vote guard), and whether its cycle has closed (voting gate).
 *
 * ⛔ A SOLUTION'S VOTABILITY IS ITS OWN COMPETING CYCLE'S, NOT ITS PARENT CHALLENGE'S. This
 * function used to inner-join `challenges` and gate on `challenges.status === 'closed'`, and that
 * one line is why the marketplace never crowned a winner. Nine closed cycles in prod carry
 * `winner_solution_id` NULL, and the tenth was already guaranteed: the live 2026-W33 board's only
 * entry (`voting`, 0 votes) was filed 2026-08-10 03:49Z against CH-284, a **2026-W23** challenge.
 * Eight hours later that day's tick ran `healOrphanedChallenges` and — correctly — closed CH-284,
 * whose own week ended in June. The join then reported the W33 entry as closed, every vote on it
 * 409'd, and `closeCycle`'s "a winner needs ≥1 vote" guard could never be satisfied. A solution
 * filed into a LIVE week was made unvotable by the lifecycle of a row in a DEAD one.
 *
 * The old rule was not arbitrary — `solutions.status` genuinely is useless as a close signal
 * (`closeCycle` flips only the WINNER to 'shipping' and leaves every loser at 'voting' forever), so
 * the parent looked like the only column that moved. The right answer was never a status column at
 * all: it is `marketplace_cycles`, the row that actually decides when this solution's race ends.
 * `periodClosedSql` (host/cycle-eligibility.ts) is that question, shared with the read path so the
 * board's `cycleClosed` flag and this 409 can never disagree.
 *
 * ⚠️ ACCEPTED, DOCUMENTED SIDE EFFECT: a solution whose parent challenge is invisible to the caller
 * now VOTES instead of 404-ing. The dropped inner join was the only thing that hid it. That is
 * safe — `solutions` carries its own RLS (0028 §4a, `tenant_id = app_current_tenant_uuid()`), so a
 * cross-tenant row is still invisible and still 404s on the `solutions` select itself. What changes
 * is the same-tenant case where only the CHALLENGE is hidden, which is a state nothing in the
 * product produces today (solution and challenge tenants match by construction).
 *
 * `now` is threaded from the route so the gate is evaluated at one instant and is testable.
 */
async function loadTarget(type: VoteTarget, id: string, now: Date): Promise<VoteEligibility> {
  if (type === 'challenge') {
    const [row] = await db
      .select({ n: challenges.votes_count, authorId: challenges.submitter_id, status: challenges.status })
      .from(challenges)
      .where(eq(challenges.id, id));
    if (!row) throw notFound('challenge_not_found', `No challenge '${id}'`);
    return { votesCount: row.n, authorId: row.authorId, closed: row.status === 'closed' };
  }
  // The period gate at `now` (host/cycle-cadence.ts) — in OFF mode there is no gate at all and
  // votes stay a plain ranking.
  //
  // ⛔ 0110: THE GATE IS THE SOLUTION'S OWN TENANT'S. Cycles are per tenant, so the "current period"
  // the gate compares against is that tenant's — read the row's tenant first (RLS already confines
  // the row to the caller's tenant; a cross-tenant id 404s right here).
  const [owner] = await db.select({ tenantId: solutions.tenant_id }).from(solutions).where(eq(solutions.id, id));
  if (!owner) throw notFound('solution_not_found', `No solution '${id}'`);
  const gate = await currentPeriodGate(now, owner.tenantId);
  const [row] = await db
    .select({
      n: solutions.votes_count,
      authorId: solutions.author_id,
      cycleClosed: periodClosedSql(SOLUTION_PERIOD, gate),
    })
    .from(solutions)
    .where(eq(solutions.id, id));
  if (!row) throw notFound('solution_not_found', `No solution '${id}'`);
  return { votesCount: row.n, authorId: row.authorId, closed: row.cycleClosed };
}

/** POST a vote: insert the row if absent and increment the count. Idempotent. */
export async function castVote(
  userId: string,
  type: VoteTarget,
  id: string,
  now: Date = new Date(),
): Promise<VoteResult> {
  const target = await loadTarget(type, id, now); // 404 before we touch anything
  if (target.authorId === userId) {
    throw forbidden('self_vote_not_allowed', `Cannot vote for your own ${type}`);
  }
  if (target.closed) {
    // `type` ('challenge' | 'solution') is the only interpolated value — name it for the catalog.
    throw conflict('voting_closed', `Voting on this ${type} has closed`, { type });
  }
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(votes)
      .values({ user_id: userId, target_type: type, target_id: id })
      .onConflictDoNothing({ target: [votes.user_id, votes.target_type, votes.target_id] })
      .returning({ id: votes.id });
    const table = targetTable(type);
    if (inserted.length) {
      const [row] = await tx
        .update(table)
        .set({ votes_count: sql`${table.votes_count} + 1`, updated_at: new Date() })
        .where(eq(table.id, id))
        .returning({ n: table.votes_count });
      return { voted: true, count: row!.n };
    }
    const [row] = await tx.select({ n: table.votes_count }).from(table).where(eq(table.id, id));
    return { voted: true, count: row!.n };
  });
}

/** DELETE a vote: remove the row if present and decrement the count. Idempotent. */
export async function retractVote(
  userId: string,
  type: VoteTarget,
  id: string,
  now: Date = new Date(),
): Promise<VoteResult> {
  const target = await loadTarget(type, id, now);
  if (target.closed) {
    // `type` ('challenge' | 'solution') is the only interpolated value — name it for the catalog.
    throw conflict('voting_closed', `Voting on this ${type} has closed`, { type });
  }
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(votes)
      .where(and(eq(votes.user_id, userId), eq(votes.target_type, type), eq(votes.target_id, id)))
      .returning({ id: votes.id });
    const table = targetTable(type);
    if (removed.length) {
      // GREATEST guards the baseline from going negative under odd re-seeds.
      const [row] = await tx
        .update(table)
        .set({ votes_count: sql`GREATEST(${table.votes_count} - 1, 0)`, updated_at: new Date() })
        .where(eq(table.id, id))
        .returning({ n: table.votes_count });
      return { voted: false, count: row!.n };
    }
    const [row] = await tx.select({ n: table.votes_count }).from(table).where(eq(table.id, id));
    return { voted: false, count: row!.n };
  });
}

/**
 * Recompute `votes_count` ABSOLUTELY from the `votes` rows, for the given target ids. Returns the
 * number of rows that actually changed.
 *
 * WHY THIS EXISTS RATHER THAN "just call castVote". `castVote`'s ±1 is correct for the request
 * path and wrong as a general repair: any writer that inserts `votes` rows directly — today, the
 * showcase seeder's raw `db.insert(votes)` at seed-tenant-showcase.ts, which deliberately bypasses
 * castVote's 404 / self-vote / closed-cycle gates — bumps nothing at all, and no sequence of ±1s
 * can recover a counter that was never incremented. A recompute can, from any starting value, in
 * either direction.
 *
 * This is the same trade pipeline-service.ts:144-172 (`recacheReviewFields`) already made in this
 * codebase, and its comment names this very file as the counter-example: "Unlike castVote's ±1
 * arithmetic on `votes_count` this recomputes absolutely — the source of truth is one cheap indexed
 * count, and a recompute cannot drift the way an increment that misses a code path can." An
 * increment that missed a code path is exactly what happened here.
 *
 * ⛔ THE COUNT IS A CORRELATED SUBQUERY INSIDE THE UPDATE, never a value read first and written
 * second — same reasoning as migration 0064's header. `castVote` inserts the vote row and bumps
 * the counter in ONE transaction; a measure-then-write would compute n while a genuine vote
 * committed, then stamp n over a column legitimately holding n+1, silently destroying that vote
 * while its `votes` row survives to prove it happened.
 *
 * ⚠️ RETRACTION — THAT ON ITS OWN IS NOT ENOUGH, AND THIS DOCBLOCK USED TO SAY IT WAS. It claimed
 * the correlated subquery closed the race outright. It does not. Under READ COMMITTED an UPDATE
 * that blocks on a row lock re-checks the UPDATED ROW when the blocker commits (`EvalPlanQual`),
 * but evaluates the rest of the statement — the subquery included — against its ORIGINAL snapshot:
 * it sees "the effects of concurrent updating commands on the same rows it is trying to update",
 * not their effects "on other rows in the database" (PostgreSQL manual, Read Committed Isolation
 * Level). `votes` is another table. So a `castVote` that committed while we were parked on its row
 * lock hands us its new `challenges`/`solutions` row and hides its new `votes` row, and the UPDATE
 * writes the pre-vote count over a legitimately higher one. Measured, not reasoned: a row drifted
 * at 5/2, a genuine vote committing during the lock wait, and this function reporting "changed 1
 * row" while leaving shown = 2 against real = 3.
 *
 * ⛔ SO THE ROWS ARE TAKEN UNDER `SELECT … FOR UPDATE` FIRST, IN THE SAME TRANSACTION. That is what
 * makes this function safe, and it is not removable:
 *
 *   - while we hold those row locks, no `castVote`/`retractVote` transaction can COMMIT a `votes`
 *     row, because its own `votes_count` write blocks behind us — so the vote set for these targets
 *     cannot move under the UPDATE;
 *   - if such a transaction committed while we WAITED for the lock, the counting statement that
 *     follows the lock is a NEW statement, and a new statement under READ COMMITTED takes a FRESH
 *     snapshot — which is the first thing here that can see it. We then write the truth;
 *   - and a `castVote` that arrives AFTER us blocks, then applies its own `+ 1` to the value we
 *     wrote, so it too lands on the truth.
 *
 * 0064 takes the other branch of the same trade — it cannot pre-lock a whole table cheaply, so it
 * detects the loss afterwards with a residual re-check and ABORTS. Here a pre-lock is affordable
 * (`ids` is always a small explicit set) and produces the right answer instead of a failure, which
 * is what a repair primitive should do.
 *
 * ⚠️ The one case the pre-lock does NOT cover, stated so nobody mistakes it for a bug: a writer
 * that inserts `votes` rows WITHOUT bumping the counter — today only the showcase seeder's raw
 * `db.insert(votes)` — can commit while we hold the locks, leaving the counter low. That writer's
 * obligation is to call this function AFTER its inserts commit, which is exactly what the seeder
 * does (seed-tenant-showcase.ts, un-gated, right after the voteSpecs loop).
 *
 * `ORDER BY id` on the lock: two overlapping recounts must take the rows in the same order or they
 * can deadlock each other. Nothing else in the codebase locks these tables in bulk today, but the
 * ordering costs nothing and removes the question.
 *
 * The transaction is opened here rather than demanded of the caller, so the guarantee cannot be
 * lost by calling this on the pool. Handed a caller's transaction it nests as a SAVEPOINT, which
 * changes nothing: the locks are still held to the OUTER commit.
 *
 * `IS DISTINCT FROM` means an already-correct row is not written: no new `xmin`, no wasted WAL,
 * and the returned count is the honest number of rows that were WRONG. `votes_target_idx` covers
 * the (target_type, target_id) lookup. `updated_at` is left alone on purpose — repairing a cache
 * is not an event on the row, and stamping `now()` would assert an edit that did not happen.
 *
 * Pinned by VC11 in tests/vote-count-reconciliation.test.ts, which drives the two-session
 * interleaving above deterministically (the voter's lock is released only once pg_stat_activity
 * reports this function parked on it).
 */
export async function recountVotes(
  type: VoteTarget,
  ids: string[],
  database: DbOrTx = db,
): Promise<number> {
  if (!ids.length) return 0;
  const table = targetTable(type);
  // Spelled out per branch rather than parameterised, so the enum literal is a LITERAL (no bind
  // parameter whose type the server has to infer against `vote_target_type`) and so each query
  // reads the same way as the migration's two statements.
  const real =
    type === 'challenge'
      ? sql<number>`(SELECT count(*)::int FROM ${votes} v
                      WHERE v.target_type = 'challenge' AND v.target_id = ${challenges.id})`
      : sql<number>`(SELECT count(*)::int FROM ${votes} v
                      WHERE v.target_type = 'solution' AND v.target_id = ${solutions.id})`;
  return database.transaction(async (tx) => {
    // ⛔ LOAD-BEARING, NOT A PERFORMANCE HINT — see the docblock. Without this the UPDATE below
    // silently overwrites a vote that committed while it was waiting for the same row lock.
    await tx
      .select({ id: table.id })
      .from(table)
      .where(inArray(table.id, ids))
      .orderBy(table.id)
      .for('update');
    const changed = await tx
      .update(table)
      .set({ votes_count: real })
      .where(and(inArray(table.id, ids), sql`${table.votes_count} IS DISTINCT FROM ${real}`))
      .returning({ id: table.id });
    return changed.length;
  });
}

/** Which target ids of a given type the user has voted on (for hasVoted flags). */
export async function votedTargetIds(userId: string, type: VoteTarget, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await db
    .select({ target_id: votes.target_id })
    .from(votes)
    .where(and(eq(votes.user_id, userId), eq(votes.target_type, type)));
  const wanted = new Set(ids);
  const out = new Set<string>();
  for (const r of rows) if (wanted.has(r.target_id)) out.add(r.target_id);
  return out;
}
