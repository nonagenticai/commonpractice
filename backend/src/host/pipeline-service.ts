// src/host/pipeline-service.ts — production-pipeline helpers (Session 6).
// enqueueWinner adds a winning solution to the pipeline at the 'review' stage. It
// is the auto-enqueue hook: called when a weekly winner is announced (and reusable
// from the seed). Idempotent — a solution already on the board keeps its one card.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db as defaultDb, pipelineItems, pipelineReviews, solutions, users } from '../db/client';
import type { PipelineItem } from '../db/schema';

type Db = typeof defaultDb;

/** Either the pool `db` or a drizzle transaction handle — the review helpers accept both, so a
 *  caller can compose them into the SAME transaction as its own writes. That is not a convenience:
 *  the promotion gate's count MUST share a transaction with the stage write (see `reviewCount`). */
type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

const STAGE_ORDER = ['review', 'hardening', 'staging', 'production'] as const;

/** A "won → live" timeline for a solution, derived from its real pipeline card.
 *  Returns a 5-step list (won + the 4 stages) with each step's state
 *  (done | active | '') based on where the card currently sits. Returns null if
 *  the solution has no pipeline card (the winner page then falls back gracefully). */
export async function solutionTimeline(
  solutionId: string,
  database: Db = defaultDb,
): Promise<
  | {
      stage: PipelineItem['stage'];
      rolloutPct: number;
      live: boolean;
      progress: PipelineItem['progress'];
      steps: { key: string; label: string; state: 'done' | 'active' | '' }[];
    }
  | null
> {
  const [card] = await database
    .select()
    .from(pipelineItems)
    .where(eq(pipelineItems.solution_id, solutionId));
  if (!card) return null;

  const idx = STAGE_ORDER.indexOf(card.stage);
  // ⛔ DEPRECATED — no frontend reads this; delete one deploy after this one.
  //
  // These English strings were rendered VERBATIM into a Dutch UI on /winner ("Won vote ·
  // Code review · Hardening · Staging · Production"). The stage vocabulary now lives in the
  // catalogs and is resolved from `step.key` by frontend/src/lib/i18n/stage-label.ts.
  // `label` stays on the wire for exactly one deploy window: backend and frontend are
  // separate images, so an OLD frontend talks to a NEW backend on every roll, and dropping
  // the field now would make that frontend render "undefined" across the whole timeline.
  const labels: Record<(typeof STAGE_ORDER)[number], string> = {
    review: 'Code review',
    hardening: 'Hardening',
    staging: 'Staging',
    production: 'Production',
  };
  const steps: { key: string; label: string; state: 'done' | 'active' | '' }[] = [
    { key: 'won', label: 'Won vote', state: 'done' },
  ];
  STAGE_ORDER.forEach((stage, i) => {
    const state = card.live && stage === 'production'
      ? 'done'
      : i < idx
        ? 'done'
        : i === idx
          ? 'active'
          : '';
    steps.push({ key: stage, label: labels[stage], state });
  });
  return { stage: card.stage, rolloutPct: card.rollout_pct, live: card.live, progress: card.progress, steps };
}

export async function enqueueWinner(
  solutionId: string,
  database: Db = defaultDb,
): Promise<PipelineItem | null> {
  const [existing] = await database
    .select()
    .from(pipelineItems)
    .where(eq(pipelineItems.solution_id, solutionId));
  if (existing) return existing;

  const [sol] = await database
    .select({
      title: solutions.title,
      authorId: solutions.author_id,
      week: solutions.week,
      periodKind: solutions.period_kind,
      periodStart: solutions.period_start,
    })
    .from(solutions)
    .where(eq(solutions.id, solutionId));
  if (!sol) return null;

  const [created] = await database
    .insert(pipelineItems)
    .values({
      solution_id: solutionId,
      title: sol.title,
      author_id: sol.authorId,
      stage: 'review',
      week: sol.week || null,
      // 0107: the card carries the solution's period (the `week` text is the key, kept one release).
      period_kind: sol.periodKind,
      period_start: sol.periodStart,
      position: 0,
    })
    .returning();
  return created ?? null;
}

// ---------------------------------------------------------------------------
// Review records (0062). One row per DISTINCT reviewer per card — the AUTHORITY the promotion
// gate reads. Shaped after host/vote-service.ts castVote/retractVote, which solves the identical
// one-action-per-user-per-target problem; the differences from that file are called out inline.
// ---------------------------------------------------------------------------

/** Display name + initials for a person, derived the same way `authorsFor` does. */
function displayPerson(name: string, storedInitials: string | null): { name: string; initials: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const initials =
    storedInitials ??
    (parts.length === 1
      ? parts[0]!.slice(0, 2)
      : (parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')
    ).toUpperCase();
  return { name, initials };
}

/**
 * How many DISTINCT humans have approved this card — counted from the review rows themselves.
 *
 * ⛔ THIS IS THE ONE NUMBER THE PROMOTION GATE MAY USE, and the `tx` parameter is the whole point.
 * Pass the SAME transaction handle that performs the stage write:
 *
 *   * Without a shared transaction, two concurrent promote requests both read count = 1 and BOTH
 *     pass the gate — the card ships having been approved by one person.
 *   * `pipeline_items.reviewer_count` is a DISPLAY CACHE and must never be substituted here. If
 *     the gate read the cache, any drift (a backend image rollback to a build that still wrote the
 *     client-supplied literal, a hand-edit, a future code path that forgets to recache) would stop
 *     being a rendering bug and become an AUTHORIZATION BYPASS.
 *
 * tests/pipeline.test.ts T6 pins exactly this: a card with zero review rows whose cache has been
 * hand-corrupted to `reviewed = true, reviewer_count = 5` must still be refused with `(have 0)`.
 */
export async function reviewCount(itemId: string, tx: DbOrTx = defaultDb): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(pipelineReviews)
    .where(eq(pipelineReviews.pipeline_item_id, itemId));
  return row?.n ?? 0;
}

/**
 * Refresh the four DISPLAY CACHES on `pipeline_items` from the authoritative rows. Private to this
 * module — nothing outside it should be writing those columns.
 *
 * Always called inside the caller's transaction, so the cache and the rows can never be observed
 * disagreeing. `reviewed_by`/`reviewed_at` show the MOST RECENT reviewer (the card renders one
 * name plus a count; the full list comes from `reviewersFor`). Unlike castVote's ±1 arithmetic on
 * `votes_count` this recomputes absolutely — the source of truth is one cheap indexed count, and a
 * recompute cannot drift the way an increment that misses a code path can.
 */
async function recacheReviewFields(tx: DbOrTx, itemId: string): Promise<void> {
  const [latest] = await tx
    .select({ reviewer_id: pipelineReviews.reviewer_id, created_at: pipelineReviews.created_at })
    .from(pipelineReviews)
    .where(eq(pipelineReviews.pipeline_item_id, itemId))
    .orderBy(desc(pipelineReviews.created_at), desc(pipelineReviews.id))
    .limit(1);
  const n = await reviewCount(itemId, tx);
  await tx
    .update(pipelineItems)
    .set({
      reviewed: n > 0,
      reviewer_count: n,
      reviewed_by: latest?.reviewer_id ?? null,
      reviewed_at: latest?.created_at ?? null,
      updated_at: new Date(),
    })
    .where(eq(pipelineItems.id, itemId));
}

/**
 * Record one review by `reviewerId`. IDEMPOTENT: the second click by the same admin inserts
 * nothing and leaves the count alone.
 *
 * `onConflictDoNothing` names the UNIQUE constraint's columns as its arbiter, exactly as castVote
 * does. Dropping that target turns a repeat click into a 23505 → 500; dropping the constraint from
 * 0062 turns it into a second row, and the gate silently reverts to counting CLICKS rather than
 * reviewers — the original defect. Both failure modes are pinned by tests/pipeline.test.ts T2.
 *
 * The self-review guard lives in the ROUTE, not here, mirroring castVote (which raises
 * `self_vote_not_allowed` before opening its transaction): the guard needs the card's author, the
 * route has already loaded the card, and a guard that throws before any write cannot leave a
 * partial one behind.
 */
export async function addReview(itemId: string, reviewerId: string, tx: DbOrTx): Promise<number> {
  await tx
    .insert(pipelineReviews)
    .values({ pipeline_item_id: itemId, reviewer_id: reviewerId })
    .onConflictDoNothing({
      target: [pipelineReviews.pipeline_item_id, pipelineReviews.reviewer_id],
    });
  await recacheReviewFields(tx, itemId);
  return reviewCount(itemId, tx);
}

/**
 * Withdraw `reviewerId`'s OWN review. Idempotent, and deliberately scoped to the actor's own row:
 * an admin can retract their approval, never someone else's. Symmetrical with `retractVote`.
 */
export async function withdrawReview(itemId: string, reviewerId: string, tx: DbOrTx): Promise<number> {
  await tx
    .delete(pipelineReviews)
    .where(
      and(
        eq(pipelineReviews.pipeline_item_id, itemId),
        eq(pipelineReviews.reviewer_id, reviewerId),
      ),
    );
  await recacheReviewFields(tx, itemId);
  return reviewCount(itemId, tx);
}

/**
 * The reviewers of each of `itemIds`, for rendering "1 of 2" plus avatars without a second
 * round-trip. Returns a map keyed by pipeline item id; a card with no reviews is simply absent.
 *
 * One `inArray` join — the same shape `authorsFor` below now uses. (This note used to point at
 * `authorsFor` as the counter-example: it selected EVERY row of `users` and filtered in JS. Fixed;
 * the warning lives on that function now, where the temptation is.)
 */
export async function reviewersFor(
  itemIds: string[],
  database: DbOrTx = defaultDb,
): Promise<Map<string, { id: string; name: string; initials: string; at: Date }[]>> {
  const out = new Map<string, { id: string; name: string; initials: string; at: Date }[]>();
  const ids = [...new Set(itemIds.filter(Boolean))];
  if (!ids.length) return out;
  const rows = await database
    .select({
      itemId: pipelineReviews.pipeline_item_id,
      userId: pipelineReviews.reviewer_id,
      at: pipelineReviews.created_at,
      name: users.name,
      initials: users.avatar_initials,
    })
    .from(pipelineReviews)
    .innerJoin(users, eq(users.id, pipelineReviews.reviewer_id))
    .where(inArray(pipelineReviews.pipeline_item_id, ids))
    .orderBy(pipelineReviews.created_at);
  for (const r of rows) {
    const list = out.get(r.itemId) ?? [];
    const person = displayPerson(r.name, r.initials);
    list.push({ id: r.userId, name: person.name, initials: person.initials, at: r.at });
    out.set(r.itemId, list);
  }
  return out;
}

/** Which of `itemIds` the given user has personally reviewed (drives the card's add/withdraw
 *  affordance — `myReview`). One indexed query, no per-card round-trip. */
export async function myReviewedItemIds(
  reviewerId: string,
  itemIds: string[],
  database: DbOrTx = defaultDb,
): Promise<Set<string>> {
  const ids = [...new Set(itemIds.filter(Boolean))];
  if (!ids.length) return new Set();
  const rows = await database
    .select({ itemId: pipelineReviews.pipeline_item_id })
    .from(pipelineReviews)
    .where(
      and(
        eq(pipelineReviews.reviewer_id, reviewerId),
        inArray(pipelineReviews.pipeline_item_id, ids),
      ),
    );
  return new Set(rows.map((r) => r.itemId));
}

/**
 * Resolve author display fields for a set of pipeline rows (name + initials).
 *
 * ⛔ THE `WHERE` IS THE POINT. This used to be an unfiltered `select … from users` followed by an
 * `ids.includes(r.id)` guard in JS: a full scan of a PLATFORM-GLOBAL, NON-RLS table
 * (migrations/0028_rls.sql) — every user of every tenant pulled into the pod, then an O(n·m) filter
 * — on every board load AND on every single card move (routes/pipeline.ts calls this from four
 * places). It produced the right answer, which is exactly why it survived: no behavioural test can
 * tell the two implementations apart. tests/pipeline-authors-for.test.ts asserts the `where` call
 * itself for that reason.
 *
 * Initials come from `displayPerson` rather than a second hand-rolled fallback; the copy that lived
 * here was character-for-character identical to it.
 */
export async function authorsFor(
  authorIds: string[],
  database: Db = defaultDb,
): Promise<Map<string, { name: string; initials: string }>> {
  const out = new Map<string, { name: string; initials: string }>();
  const ids = [...new Set(authorIds.filter(Boolean))];
  if (!ids.length) return out;
  const rows = await database
    .select({ id: users.id, name: users.name, initials: users.avatar_initials })
    .from(users)
    .where(inArray(users.id, ids));
  for (const r of rows) out.set(r.id, displayPerson(r.name, r.initials));
  return out;
}
