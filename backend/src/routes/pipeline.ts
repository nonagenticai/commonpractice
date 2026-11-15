// src/routes/pipeline.ts — the platform "Production pipeline" kanban (Session 6).
// Platform-gated. GET returns the 4 stage columns (review → hardening → staging →
// production) + counts + top metrics. PATCH moves a card / sets rollout / marks it
// reviewed — and is GATED BY GOVERNANCE: a card may only enter Production when the
// promotion.mandatory_review policy is satisfied and promotion.required_reviewers is
// met; entering Staging seeds rollout from promotion.staging_canary_pct. Every move
// writes an audit row (deploy.staging / deploy.production / pipeline.move/review).
//
// ⛔ THE PROMOTION GATE COUNTS `pipeline_reviews` ROWS, INSIDE THE TRANSACTION THAT PERFORMS THE
// STAGE WRITE (migration 0062). It does NOT read `pipeline_items.reviewer_count`, and it does NOT
// read anything off the request body. Until 0062 it did both: the frontend hard-coded
// `reviewerCount: 2` and the gate compared that client-supplied literal against the policy, so ONE
// click by ONE admin satisfied "2 reviewers required" — and setting the policy to 3 (an option the
// Governance screen offers) deadlocked promotion permanently, because nothing could ever write a 3.
// `{reviewed:true}` now records ONE review by the ACTOR (idempotent, UNIQUE-constrained);
// `{reviewed:false}` withdraws the actor's OWN review; `reviewerCount` is accepted and ignored.
import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, runAsSystem, pipelineItems, solutions, challenges } from '../db/client';
import type { PipelineItem } from '../db/schema';
import { requireSuperAdmin } from '../middleware/admin-guards';
import { HttpError, jsonResponse, readJson, route, notFound, forbidden, unprocessable } from '../utils/http';
import { getSnapshot } from '../host/policy-store';
import { recordAudit } from '../host/audit-service';
import {
  enqueueWinner,
  authorsFor,
  reviewCount,
  addReview,
  withdrawReview,
  reviewersFor,
  myReviewedItemIds,
} from '../host/pipeline-service';
import type { Router } from '../utils/router';

const STAGES = ['review', 'hardening', 'staging', 'production'] as const;
type Stage = (typeof STAGES)[number];
const DAY_MS = 24 * 60 * 60 * 1000;
// ⛔ `column.title` is DEPRECATED — no frontend reads it; delete one deploy after this one.
//
// These English strings were the /pipeline board's column heads in a Dutch UI. The stage
// vocabulary now lives in the catalogs (`pipeline_stage_*`) and KanbanColumn resolves it from
// `column.stage`, which was already on the DTO. The field stays on the wire for exactly one
// deploy window: an OLD frontend against a NEW backend would otherwise render four blank
// column heads.
//
// ⚠️ The `audit_log.result` use below (`→ ${STAGE_TITLES[targetStage]}`) is NOT deprecated and
// must NOT be localized — see the note at that call site.
const STAGE_TITLES: Record<Stage, string> = {
  review: 'In review',
  hardening: 'Hardening',
  staging: 'Staging · canary',
  production: 'Production',
};

/** Start of the calendar quarter containing `now`, **in UTC**.
 *
 *  UTC is a deliberate choice, not an oversight. The rows this windows (`rolled_back_at`) are
 *  `timestamptz` stamped by the server, the board is platform-wide (there is no single tenant whose
 *  local calendar would be the right one), and the eight locales this product ships in span enough
 *  offsets that any "local" quarter boundary would make the same rollback fall in different
 *  quarters for two admins looking at the same screen. A card rolled back within a few hours of a
 *  quarter boundary can therefore land in the neighbouring quarter for an admin west of UTC; that
 *  is accepted, and is strictly better than an all-time counter under a "this quarter" label. */
function quarterStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1, 0, 0, 0, 0));
}

/** The per-card review facts the board renders (0062). All ADDITIVE and all optional on the
 *  frontend type: a new frontend briefly talks to an old backend on every roll, and an unguarded
 *  read of a field the old backend never sent throws and blanks the whole page. */
interface ReviewFacts {
  reviewers: { id: string; name: string; initials: string; at: Date }[];
  /** Has the CALLING admin personally reviewed this card? Drives add-vs-withdraw on the button. */
  myReview: boolean;
  /** Is the calling admin this card's author? They may not review their own work. */
  isAuthor: boolean;
}

function itemDto(
  p: PipelineItem,
  author: { name: string; initials: string } | undefined,
  reviewer: { name: string; initials: string } | undefined,
  challenge: { code: string | null; id: string } | null,
  facts: ReviewFacts,
) {
  return {
    id: p.id,
    title: p.title,
    solutionId: p.solution_id,
    // The originating challenge's display code (via solution → challenge), so the card shows
    // the SAME code as the challenge page / audit log instead of a hard-coded literal.
    challengeCode: challenge?.code ?? null,
    // The originating challenge's id, so the card's code badge can deep-link to the challenge.
    challengeId: challenge?.id ?? null,
    author: author ?? null,
    stage: p.stage,
    week: p.week,
    rolloutPct: p.rollout_pct,
    progress: p.progress,
    // ⚠️ `reviewed` / `reviewerCount` / `reviewedBy` / `reviewedAt` are DISPLAY CACHES
    // (pipeline_items columns, maintained by pipeline-service.recacheReviewFields in the same
    // transaction as the review row). The promotion gate does NOT read them — it counts
    // `pipeline_reviews` inside its own transaction — so drift here is a rendering bug, never an
    // authorization bypass. `reviewers` below is the authoritative list.
    reviewed: p.reviewed,
    reviewerCount: p.reviewer_count,
    reviewedBy: reviewer ?? null,
    reviewedAt: p.reviewed_at,
    // Additive (0062): the real, distinct reviewers, so a card renders "1 of 2" with avatars
    // without a second round-trip.
    reviewers: facts.reviewers,
    myReview: facts.myReview,
    isAuthor: facts.isAuthor,
    featured: p.featured,
    live: p.live,
    position: p.position,
  };
}

// ---------------------------------------------------------------------------------------------
// ⛔ THE BOARD IS CROSS-TENANT; `solutions` IS NOT. READ THIS BEFORE TOUCHING A SOLUTION WRITE.
//
// `pipeline_items` is deliberately OUTSIDE RLS (0028_rls.sql:21,24) so the platform Operate board
// shows EVERY tenant's cards. `solutions` is under strict RLS with a notNull `tenant_id`. And
// `requireSuperAdmin` — unlike `resolveTenant` — never calls `refreshTenantGuc`, so
// `app.current_tenant` stays the OPERATOR'S OWN tenant for the whole request.
//
// So promoting a card owned by tenant B while the operator's claim is tenant A ran
//     UPDATE solutions SET status='shipping' WHERE id = <B's solution>
// under A's GUC, matched ZERO rows, and nothing checked. The route returned 200 with `live:true`
// and wrote a `deploy.production` audit row while the solution sat in `voting` on B's marketplace.
// Rollback and "leaving Production" had the identical shape in the other direction. Nothing could
// catch it: pipeline.test.ts runs as the table OWNER (RLS bypassed) AND puts every fixture in one
// tenant, so operator-tenant == card-tenant on both axes.
//
// THE FIX HAS TWO HALVES AND BOTH ARE LOAD-BEARING:
//   1. The write runs under `runAsSystem` (the owner pool, RLS bypassed, no tenant GUC) — the
//      documented escape hatch for genuine cross-tenant platform work, already used this way by
//      routes/sandboxes.ts, routes/blocks.ts and routes/ontology.ts. A super_admin shipping a card
//      from the platform board IS cross-tenant work; a per-request tenant GUC cannot express it.
//   2. The rowcount is ASSERTED. Bypassing RLS makes today's zero-row case impossible, but the
//      defect was never "RLS blocked us" — it was "a write that changed nothing reported success".
//      Replacing a silent failure with a differently-silent one is not a fix. `solution_id` is an
//      FK, so an empty result here means the row vanished mid-request: loud 500, transaction
//      rolled back, nothing half-shipped.
//
// ⛔ AND THE READS HAD THE SAME DEFECT — that half was fixed a release later, so do not read the
// two paragraphs above as "solved". A GUC is not directional: it hid other tenants' rows from
// SELECTs exactly as it dropped them from UPDATEs. Two live instances, both now `runAsSystem`:
//   • `enqueueWinner` (POST /api/pipeline/enqueue) SELECTs `solutions` → another tenant's winner
//     was invisible → null → 422 `solution_not_found` for a solution plainly on the operator's
//     screen. The winner → production path was dead for every card the operator did not own.
//   • the solution → challenge join (`challengeRefFor`, and `codeRows` in GET) reads TWO RLS
//     tables → `challengeCode`/`challengeId` came back null on cross-tenant cards, and
//     KanbanCard.svelte renders `★ #{code}` only when it is non-null, so the badge silently
//     vanished from other tenants' featured cards.
// The rule this leaves behind: on THIS board, any statement naming `solutions` or `challenges`
// belongs inside `runAsSystem` — read or write. `pipeline_items` / `pipeline_reviews` / `users`
// are outside RLS and need nothing. tests/pipeline-cross-tenant-solution.test.ts covers both
// halves, AS `cp_app` (NOBYPASSRLS); running it as the owner makes every case here vacuous.
// ---------------------------------------------------------------------------------------------

/** Anything that can issue an UPDATE — the request `db` proxy or a drizzle transaction handle. */
type SolutionWriter = Pick<typeof db, 'update'>;

/** Wire a linked solution's lifecycle to its card's deploy state. Throws if it matched no row.
 *
 * Exported for tests ONLY. The zero-row branch cannot be staged through the routes — `solution_id`
 * is an FK with `ON DELETE SET NULL`, so deleting the solution nulls the card and the route skips
 * this call entirely; the branch exists for a row that vanishes mid-request. An adversarial review
 * deleted the whole `throw` and every pipeline test stayed green, so it is driven directly with a
 * writer that reports no rows. Pinning the guard beats pretending the state is reachable. */
export async function setSolutionStatus(
  writer: SolutionWriter,
  solutionId: string,
  status: 'shipping' | 'voting',
): Promise<void> {
  const changed = await writer
    .update(solutions)
    .set({ status, updated_at: new Date() })
    .where(eq(solutions.id, solutionId))
    .returning({ id: solutions.id });
  if (changed.length === 0) {
    throw new HttpError(
      500,
      'solution_status_write_lost',
      `Solution ${solutionId} was not moved to '${status}' — the write matched no row.`,
    );
  }
}

// The originating challenge's display code + id for a single card (via solution → challenge).
//
// ⛔ `runAsSystem` FOR THE SAME REASON THE WRITES USE IT (see the cross-tenant note above
// `setSolutionStatus`) — this is the READ half of that seam. `solutions` AND `challenges` are both
// under strict RLS; `pipeline_items` is not. Under the operator's own tenant GUC this join returned
// ZERO rows for every card owned by another tenant, so `challengeCode`/`challengeId` came back null
// and KanbanCard.svelte's `{#if card.featured && card.challengeCode}` dropped the `★ #CH-nnn`
// badge from exactly the cards a platform operator does not own. Every caller of this helper is
// behind `requireSuperAdmin` on the platform board, which is cross-tenant BY DEFINITION.
async function challengeRefFor(
  solutionId: string | null,
): Promise<{ code: string | null; id: string } | null> {
  if (!solutionId) return null;
  const [r] = await runAsSystem('platform-admin', () =>
    db
      .select({ code: challenges.code, id: challenges.id })
      .from(solutions)
      .innerJoin(challenges, eq(solutions.challenge_id, challenges.id))
      .where(eq(solutions.id, solutionId)),
  );
  return r ? { code: r.code, id: r.id } : null;
}

// GET /api/pipeline — columns + counts + top metrics.
const getPipeline = route(async (req) => {
  const actor = await requireSuperAdmin(req);
  const rows = await db
    .select()
    .from(pipelineItems)
    .orderBy(asc(pipelineItems.stage), asc(pipelineItems.position));
  const people = await authorsFor(
    rows.flatMap((r) => [r.author_id, r.reviewed_by]).filter((x): x is string => !!x),
  );

  // Real reviewers per card + whether the caller is one of them (0062). Two indexed queries for
  // the whole board, not one per card.
  const itemIds = rows.map((r) => r.id);
  const reviewersByItem = await reviewersFor(itemIds);
  const mine = await myReviewedItemIds(actor.id, itemIds);

  // Resolve each card's originating challenge code via solution → challenge.
  const solIds = rows.map((r) => r.solution_id).filter((x): x is string => !!x);
  // ⛔ `runAsSystem` — the board is platform-wide and both joined tables are under strict RLS.
  //    Bound to the operator's own tenant GUC this returned rows for THEIR tenant's cards only,
  //    silently blanking `challengeCode` on everyone else's. Same seam as `challengeRefFor`.
  const codeRows = solIds.length
    ? await runAsSystem('platform-admin', () =>
        db
          .select({ solution_id: solutions.id, code: challenges.code, id: challenges.id })
          .from(solutions)
          .innerJoin(challenges, eq(solutions.challenge_id, challenges.id))
          .where(inArray(solutions.id, solIds)),
      )
    : [];
  const refBySolution = new Map(codeRows.map((r) => [r.solution_id, { code: r.code, id: r.id }]));

  const columns = STAGES.map((stage) => {
    const items = rows
      .filter((r) => r.stage === stage)
      .map((r) =>
        itemDto(
          r,
          r.author_id ? people.get(r.author_id) : undefined,
          r.reviewed_by ? people.get(r.reviewed_by) : undefined,
          (r.solution_id && refBySolution.get(r.solution_id)) || null,
          {
            reviewers: reviewersByItem.get(r.id) ?? [],
            myReview: mine.has(r.id),
            isAuthor: !!r.author_id && r.author_id === actor.id,
          },
        ),
      );
    return { stage, title: STAGE_TITLES[stage], count: items.length, items };
  });

  const inProduction = rows.filter((r) => r.stage === 'production').length;
  // EVERY card that is not in Production is in the pipeline. Deliberately `rows.length -
  // inProduction` and nothing cleverer.
  //
  // ⛔ An earlier version of this change narrowed it to `stage !== 'production' && !r.live_at`, so
  // that a rolled-back card — which keeps its `live_at` — would stop being counted under a label
  // that reads "not yet live". Adversarial review proved that trade is bad: a card dragged from
  // Production back to Hardening through the ordinary kanban PATCH (`:372` clears `live` but never
  // `live_at`, and sets no `rolled_back_at`), and any card rolled back in a PREVIOUS quarter, then
  // appear in NO count at all — `inPipeline` 0, `inProduction` 0, `rolledBack` 0 — while the column
  // underneath still renders the card. A card visible on the board that every statistic denies is a
  // worse contradiction than the one being fixed, and it is the same species: a number on this row
  // disagreeing with what is on screen beside it.
  //
  // The falsehood was never the count; it was the SUB-LABEL claiming these cards had never been
  // live. That is fixed where it lives, in the message catalogues, which cost 8 string edits and no
  // arithmetic. `rolledBack` remains a separate, independent fact about the same board — a
  // rolled-back card is legitimately both "not in production" and "rolled back".
  const inPipeline = rows.length - inProduction;
  // Real metrics from the live_at / rolled_back_at timestamps (Phase 2-E) — were
  // hard-coded literals before. avgTimeToLiveMs averages (live_at - created_at)
  // over cards that reached Production; rolledBack counts pulled-back cards.
  const liveRows = rows.filter((r) => r.live_at);
  /** How many cards have EVER been live. This is the data-existence fact the "avg time to live"
   *  card needs, and until now it had no representation on the wire at all — the frontend was
   *  forced to use the magnitude of `avgTimeToLiveDays` as a stand-in ("> 0 means we have data"),
   *  which is why a real 41-minute deploy rendered as "— / none live yet" right next to
   *  "In production 1 / live now". A count and a duration are different questions; ship both. */
  const liveCount = liveRows.length;
  const avgMs = liveCount
    ? liveRows.reduce((sum, r) => sum + (r.live_at!.getTime() - r.created_at.getTime()), 0) / liveCount
    : 0;
  /** The average in MILLISECONDS, or `null` when nothing has shipped.
   *
   *  Milliseconds because unit selection is a PRESENTATION concern: any unit the server picks
   *  re-creates the original bug at its own granularity (a 41-minute deploy is `0` days; a
   *  20-minute promotion is `0` hours), and which unit reads naturally is locale-dependent anyway.
   *  The browser picks the unit and the catalog supplies the word.
   *
   *  `null` — not `0` — for "nothing shipped", because `0` is a legitimate duration and reusing it
   *  as an absence marker rebuilds exactly the magnitude-as-existence-predicate conflation being
   *  fixed here. `null` survives JSON; `undefined` would vanish from the response body and become
   *  indistinguishable from an old backend that never sent the field. */
  const avgTimeToLiveMs: number | null = liveCount ? Math.round(avgMs) : null;
  // ⛔ BACK-COMPAT, DO NOT "IMPROVE". Byte-identical to the pre-fix computation: whole days,
  // `Math.round`, `0` when nothing is live. Backend and frontend are separate images and BOTH
  // mixed states occur on every roll (see the `reviewerCount` note on the PATCH schema below for
  // the same rule spelled out). An OLD frontend reads this field and tests it with `> 0`:
  //   - making it a float ships `0.028 > 0` → it renders "0.028d across shipped" for the whole
  //     roll window, with a locale-dependent decimal separator;
  //   - switching to `Math.ceil` ships "1d" for a 41-minute deploy — trading a visible
  //     contradiction for an invisible lie, which is worse.
  // New frontends ignore this entirely and read `liveCount` + `avgTimeToLiveMs`.
  // backend/tests/pipeline.test.ts pins this to `0` for the 41-minute case on purpose.
  const avgTimeToLiveDays = liveCount ? Math.round(avgMs / DAY_MS) : 0;
  // Windowed to the CURRENT QUARTER because the sub-label under this stat says "this quarter"
  // (`pipeline_stat_this_quarter`, and its 7 translations). It used to count all time, so the
  // number could only grow and a rollback from two years ago was still being reported as this
  // quarter's. Fixing the computation makes the existing label true in all 8 catalogs; retranslating
  // 8 files to describe a monotonic all-time counter would have made it honest but useless.
  const quarterStart = quarterStartUtc(new Date());
  const rolledBack = rows.filter((r) => r.rolled_back_at && r.rolled_back_at >= quarterStart).length;
  const metrics = { inPipeline, inProduction, rolledBack, avgTimeToLiveDays, liveCount, avgTimeToLiveMs };

  // Board-level governance policy (0062), so a card can render "1 of 2 reviewers" without every
  // card fetching the policy itself. Additive + optional on the frontend type.
  const snapshot = await getSnapshot();
  const policy = {
    mandatoryReview: snapshot.mandatoryReview,
    requiredReviewers: snapshot.requiredReviewers,
  };

  return jsonResponse({ columns, metrics, policy });
});

const patchSchema = z
  .object({
    stage: z.enum(STAGES).optional(),
    rolloutPct: z.number().int().min(0).max(100).optional(),
    reviewed: z.boolean().optional(),
    // ⛔ INERT SINCE 0062 — ACCEPTED AND IGNORED. DO NOT REMOVE, DO NOT VALIDATE. (Added
    // 2026-08-09; remove once the frontend that stopped sending it has fully rolled.)
    //
    // This field WAS the defect: the frontend hard-coded `reviewerCount: 2` and the gate compared
    // that client-supplied literal against `promotion.required_reviewers`, so one click by one
    // admin satisfied "2 reviewers required". The count now comes from `pipeline_reviews` rows and
    // nothing reads this value.
    //
    // It stays in the `.strict()` schema for DEPLOY ORDERING. Backend and frontend are separate
    // images and BOTH mixed states occur on every roll. The old frontend always sends this field,
    // so REMOVING it from a `.strict()` schema (or rejecting it) makes every old-frontend Approve
    // click fail zod validation → 422, for the whole roll window, on the exact button this change
    // exists to fix — a self-inflicted outage. Accepting-and-ignoring means an old frontend against
    // a new backend DOES THE RIGHT NEW THING: one click records one real review by the actor, and
    // the bogus 2 hits the floor. The response echoes the TRUE derived count.
    reviewerCount: z.number().int().min(0).optional(),
  })
  .strict();

// PATCH /api/pipeline/:id — move / set rollout / mark reviewed (governance-gated).
const patchPipeline = route(async (req, id) => {
  const actor = await requireSuperAdmin(req);
  const body = patchSchema.parse(await readJson(req));
  const [item] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, id!));
  if (!item) throw notFound('pipeline_item_not_found', `No pipeline item '${id}'`);

  const snapshot = await getSnapshot();

  // --- SELF-REVIEW GUARD, BEFORE ANY WRITE ---
  // Mirrors castVote's `self_vote_not_allowed`, which likewise raises before opening its
  // transaction. "Two reviewers approved this" means nothing if one of them wrote the code, and a
  // guard that throws before any write cannot leave a partial one behind. Only an explicit
  // approval is refused — withdrawing (`reviewed: false`) and plain stage moves are unaffected.
  if (body.reviewed === true && item.author_id && item.author_id === actor.id) {
    throw forbidden(
      'self_review_not_allowed',
      'You cannot approve your own pipeline card — a review has to come from someone else.',
    );
  }

  // --- APPROVALS ON A SHIPPED CARD ARE IMMUTABLE, ALSO BEFORE ANY WRITE ---
  //
  // ⛔ A card in Production is LIVE, and the reviews that let it through are the record of WHY it
  // was allowed to ship. Withdrawing them is a hard DELETE of that record, performed by the very
  // people it names, and it leaves a live card at 100% rollout reading `reviewed = false,
  // reviewer_count = 0` with no surviving `pipeline_reviews` row and no tombstone.
  //
  // That directly contradicts the reason `pipeline_reviews.reviewer_id` carries NO ON DELETE
  // clause (0062, following 0050's tombstone): an approval is AUTHORSHIP and must survive its
  // author leaving the company. It is worth nothing if the author can erase it herself in one
  // click. Refusing here is what makes that FK rationale true rather than decorative.
  //
  // Enforced SERVER-SIDE and not only by hiding the button: the PATCH is reachable regardless of
  // what the UI renders, so a UI-only guard is not a guard. Withdrawal is refused; ADDING a review
  // to a live card is still allowed — more approvals never weakens the record.
  //
  // The way to un-ship a card is `POST /api/pipeline/:id/rollback`, which is audited as
  // `deploy.rollback`. Once it is back in Staging its reviews are withdrawable again.
  if (body.reviewed === false && item.stage === 'production') {
    throw unprocessable(
      'review_locked',
      'This card is live in Production — its approvals are the record of why it shipped and cannot be withdrawn. Roll the card back first.',
    );
  }

  const targetStage = (body.stage ?? item.stage) as Stage;
  const moving = body.stage !== undefined && body.stage !== item.stage;
  const enteringProduction = moving && targetStage === 'production';
  const leavingProduction = moving && item.stage === 'production' && targetStage !== 'production';
  // The gate applies to ENTERING Production, including a PATCH that names 'production' without
  // `moving` being true only when the card is already there (then it does not apply).
  const gated = targetStage === 'production' && item.stage !== 'production';

  /** What the transaction decided. A BLOCK is reported, not thrown, from inside — see below. */
  type Decision =
    | { blocked: 'review_required' }
    | { blocked: 'reviewers'; have: number; need: number }
    | { blocked: null };

  // ⛔ EVERYTHING THAT MUST BE ATOMIC HAPPENS HERE; NOTHING THAT MUST SURVIVE A REFUSAL DOES.
  //
  // The gate counts real review rows INSIDE the same transaction as the stage write. That is the
  // load-bearing property of this whole change: counted outside a transaction, two concurrent
  // promote requests would both read count = 1 and both pass.
  //
  // ⛔ AND THIS IS WHY A BLOCK IS *RETURNED* RATHER THAN THROWN. `deploy.blocked` is the audit
  // trail of refused deploys — the record that someone tried to ship something unapproved. Throwing
  // from inside the transaction (or recording the audit row inside it and then throwing) would roll
  // that row back with everything else, silently erasing the trail precisely when it matters most.
  // So the transaction returns a decision and the `recordAudit` + `throw` happen AFTER it commits.
  // tests/pipeline.test.ts T11 exists solely to hold this ordering.
  //
  // ⛔ AND IT RUNS UNDER `runAsSystem`, WHICH IS NOT COSMETIC — see the cross-tenant note above
  // `setSolutionStatus`. The two other tables this transaction touches (`pipeline_items`,
  // `pipeline_reviews`) are deliberately outside RLS, so binding the owner pool changes nothing
  // for them; `solutions` is the one row here that belongs to a tenant which may not be the
  // operator's, and under the request GUC its UPDATE silently matched zero rows.
  const decision = await runAsSystem('platform-admin', () => db.transaction(async (tx): Promise<Decision> => {
    // 1. Apply the review change first, so a single PATCH that both approves and promotes counts
    //    the review it just recorded (the pre-0062 code achieved the same via `body.reviewed ?? …`).
    //    `reviewerCount` from the body is IGNORED — see the schema comment.
    if (body.reviewed === true) await addReview(item.id, actor.id, tx);
    else if (body.reviewed === false) await withdrawReview(item.id, actor.id, tx);

    // 2. The promotion gate, on the REAL count of distinct reviewers.
    //    ⛔ NEVER `item.reviewer_count` — that column is a display cache (see pipeline-service
    //    `reviewCount`). T6 hand-corrupts it and asserts this branch still refuses.
    if (gated && snapshot.mandatoryReview) {
      const have = await reviewCount(item.id, tx);
      // Both branches are needed and NOT redundant: policy-store clamps `requiredReviewers` at a
      // floor of 0, so with the policy set to 0 the second branch can never fire and this first
      // one is the only thing still insisting that SOMEBODY reviewed the card.
      if (have === 0) return { blocked: 'review_required' };
      if (have < snapshot.requiredReviewers) {
        return { blocked: 'reviewers', have, need: snapshot.requiredReviewers };
      }
    }

    // 3. Gate passed (or did not apply) — apply the move.
    const set: Partial<typeof pipelineItems.$inferInsert> = { updated_at: new Date() };
    if (body.stage !== undefined) set.stage = body.stage;

    // Rollout: explicit wins; entering Staging seeds the canary percent from policy;
    // entering Production goes full (100%).
    if (body.rolloutPct !== undefined) {
      set.rollout_pct = body.rolloutPct;
    } else if (moving && targetStage === 'staging') {
      set.rollout_pct = snapshot.stagingCanaryPct;
    } else if (moving && targetStage === 'production') {
      set.rollout_pct = 100;
    }
    if (enteringProduction) {
      set.live = true;
      if (!item.live_at) set.live_at = new Date(); // first-live wins (drives avgTimeToLiveDays)
    }
    if (moving && targetStage !== 'production') set.live = false;

    await tx.update(pipelineItems).set(set).where(eq(pipelineItems.id, item.id));

    // Wire the linked solution's lifecycle to the deploy (Phase 2-E): entering Production
    // ships it; leaving Production puts it back to voting. Guard the optional solution FK.
    if (item.solution_id && enteringProduction) {
      await setSolutionStatus(tx, item.solution_id, 'shipping');
    } else if (item.solution_id && leavingProduction) {
      await setSolutionStatus(tx, item.solution_id, 'voting');
    }
    return { blocked: null };
  }));

  // --- POST-COMMIT: the blocked-deploy audit row, then the refusal. ---
  // Reached only after the transaction committed, so this row PERSISTS even though the request
  // ends in a 422. Note the review recorded in step 1 also persists: approving is a genuine,
  // independent act by this admin, and refusing the promotion is no reason to discard it — the
  // card correctly reads "1 of 2" afterwards instead of losing the approval.
  if (decision.blocked === 'review_required') {
    await recordAudit({
      actorId: actor.id,
      action: 'deploy.blocked',
      category: 'deploy',
      targetType: 'pipeline_item',
      targetId: item.id,
      result: 'Blocked · review required',
      resultTone: 'error',
      metadata: { title: item.title },
    });
    throw unprocessable('policy_violation', 'Mandatory code review is required before Production.');
  }
  if (decision.blocked === 'reviewers') {
    await recordAudit({
      actorId: actor.id,
      action: 'deploy.blocked',
      category: 'deploy',
      targetType: 'pipeline_item',
      targetId: item.id,
      result: `Blocked · needs ${decision.need} reviewers`,
      resultTone: 'error',
      metadata: { title: item.title, have: decision.have },
    });
    // Message kept byte-identical to the pre-0062 copy — the frontend surfaces it verbatim via
    // writeErrorText, and it is asserted on in the tests.
    throw unprocessable(
      'policy_violation',
      `Required reviewers: ${decision.need} (have ${decision.have}).`,
    );
  }

  const [updated] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, item.id));

  // Audit the action.
  if (moving && targetStage === 'production') {
    await recordAudit({ actorId: actor.id, action: 'deploy.production', category: 'deploy', targetType: 'pipeline_item', targetId: item.id, result: 'Live', resultTone: 'ok', metadata: { title: item.title } });
  } else if (moving && targetStage === 'staging') {
    await recordAudit({ actorId: actor.id, action: 'deploy.staging', category: 'deploy', targetType: 'pipeline_item', targetId: item.id, result: `Staging · ${updated!.rollout_pct}% canary`, resultTone: 'ok', metadata: { title: item.title } });
  } else if (moving) {
    // ⛔ DO NOT LOCALIZE THIS STRING — and this is not an oversight left behind by the
    // stage-vocabulary change above.
    //
    // `audit_log` is a cross-tenant, super_admin-only feed and the row has NO reader locale:
    // it is written once, by whoever performed the action, and read later by someone else
    // entirely. Localizing at WRITE time therefore bakes the ACTOR's language into a record
    // written for a different reader — a Dutch admin's move would appear in Polish to the
    // next auditor and could never be re-rendered, because the enum that produced it is gone
    // by then. The only alternative that works is storing the enum and localizing at read
    // time, which is a schema change across 87 existing result strings, not part of this fix.
    // Until then, uniform English is strictly better than a log whose language depends on who
    // happened to click: mixed-language history is unsearchable and unfilterable.
    await recordAudit({ actorId: actor.id, action: 'pipeline.move', category: 'deploy', targetType: 'pipeline_item', targetId: item.id, result: `→ ${STAGE_TITLES[targetStage]}`, resultTone: 'ok', metadata: { title: item.title } });
  } else if (body.reviewed !== undefined) {
    // ⛔ THE COPY DESCRIBES THE ACTOR'S ACTION (`body.reviewed`), NOT THE CARD'S AGGREGATE STATE.
    //
    // This audit row says what THIS admin just did, so it must be keyed on what they asked for.
    // Keying it on `updated.reviewed` — the card's state after the write — was a REGRESSION
    // introduced by 0062 and is a compliance-integrity defect: before 0062 a `{reviewed:false}`
    // always drove the flag false, so "Review cleared" was always right. Now the flag can stay
    // TRUE after a withdrawal because SOMEONE ELSE's review survives — so admin B withdrawing
    // from a card A had also approved produced a row reading `actor = B, result = "Reviewed · 1",
    // tone = ok`. B revoked their approval and the compliance feed recorded them GRANTING one.
    //
    // ⛔ `body.reviewerCount` is deliberately NOT part of this condition either: it is inert since
    // 0062, so a PATCH carrying only that field changes nothing, and auditing it would file a row
    // for something that never happened.
    //
    // Both branches carry the resulting count so the row stays informative about the card, while
    // the verb stays true to the actor. A withdrawal is toned `warn`, not `ok` — like
    // `deploy.rollback`, it REDUCES the approval standing of something that may be live.
    const standing = `${updated!.reviewer_count}/${snapshot.requiredReviewers}`;
    await recordAudit({
      actorId: actor.id,
      action: 'pipeline.review',
      category: 'deploy',
      targetType: 'pipeline_item',
      targetId: item.id,
      result: body.reviewed ? `Reviewed · ${standing}` : `Review withdrawn · ${standing}`,
      resultTone: body.reviewed ? 'ok' : 'warn',
      metadata: { title: item.title, reviewers: updated!.reviewer_count, required: snapshot.requiredReviewers },
    });
  }

  const people = await authorsFor(
    [updated!.author_id, updated!.reviewed_by].filter((x): x is string => !!x),
  );
  const author = updated!.author_id ? people.get(updated!.author_id) : undefined;
  const reviewer = updated!.reviewed_by ? people.get(updated!.reviewed_by) : undefined;
  const reviewers = (await reviewersFor([updated!.id])).get(updated!.id) ?? [];
  return jsonResponse(
    itemDto(updated!, author, reviewer, await challengeRefFor(updated!.solution_id), {
      reviewers,
      myReview: reviewers.some((r) => r.id === actor.id),
      isAuthor: !!updated!.author_id && updated!.author_id === actor.id,
    }),
  );
});

// POST /api/pipeline/:id/rollback — pull a live card back from Production (Phase 2-E).
// Platform-gated. Records rolled_back_at (→ the rolledBack metric), drops it to staging
// at 0% rollout, reverts the linked solution to voting, and writes a warn audit row.
const rollback = route(async (req, id) => {
  const actor = await requireSuperAdmin(req);
  const [item] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, id!));
  if (!item) throw notFound('pipeline_item_not_found', `No pipeline item '${id}'`);
  if (item.stage !== 'production') {
    throw unprocessable('not_in_production', 'Only a Production card can be rolled back.');
  }

  await db
    .update(pipelineItems)
    .set({ live: false, rollout_pct: 0, rolled_back_at: new Date(), stage: 'staging', updated_at: new Date() })
    .where(eq(pipelineItems.id, item.id));
  // Same cross-tenant seam as the promote path — a rollback of tenant B's card has to reach B's
  // solution, and has to say so if it does not. See the note above `setSolutionStatus`.
  if (item.solution_id) {
    await runAsSystem('platform-admin', () => setSolutionStatus(db, item.solution_id!, 'voting'));
  }

  await recordAudit({
    actorId: actor.id,
    action: 'deploy.rollback',
    category: 'deploy',
    targetType: 'pipeline_item',
    targetId: item.id,
    result: 'Rolled back · → Staging',
    resultTone: 'warn',
    metadata: { title: item.title },
  });

  const [updated] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, item.id));
  const people = await authorsFor(
    [updated!.author_id, updated!.reviewed_by].filter((x): x is string => !!x),
  );
  const author = updated!.author_id ? people.get(updated!.author_id) : undefined;
  const reviewer = updated!.reviewed_by ? people.get(updated!.reviewed_by) : undefined;
  // A rollback does not touch the reviews — the card keeps the approvals it earned.
  const reviewers = (await reviewersFor([updated!.id])).get(updated!.id) ?? [];
  return jsonResponse(
    itemDto(updated!, author, reviewer, await challengeRefFor(updated!.solution_id), {
      reviewers,
      myReview: reviewers.some((r) => r.id === actor.id),
      isAuthor: !!updated!.author_id && updated!.author_id === actor.id,
    }),
  );
});

const enqueueSchema = z.object({ solutionId: z.string().uuid() }).strict();

// POST /api/pipeline/enqueue — add a winning solution to the board (review stage).
const enqueue = route(async (req) => {
  const actor = await requireSuperAdmin(req);
  const { solutionId } = enqueueSchema.parse(await readJson(req));
  // ⛔ `runAsSystem` — enqueueWinner READS `solutions` (strict RLS) to build the card. Under the
  //    operator's own tenant GUC another tenant's winner was invisible, so this returned null and
  //    the line below 422'd `solution_not_found` for a solution the operator was looking at. That
  //    is the winner → production path, and it was dead for every card the operator did not own.
  //    The INSERT it performs targets `pipeline_items`, which is deliberately outside RLS, so the
  //    owner pool changes nothing about the write. Non-existence still yields null → still 422.
  const item = await runAsSystem('platform-admin', () => enqueueWinner(solutionId));
  if (!item) throw unprocessable('solution_not_found', `No solution '${solutionId}'`);
  await recordAudit({ actorId: actor.id, action: 'pipeline.enqueue', category: 'deploy', targetType: 'pipeline_item', targetId: item.id, result: 'Queued for review', resultTone: 'ok', metadata: { title: item.title } });
  const author = item.author_id ? (await authorsFor([item.author_id])).get(item.author_id) : undefined;
  // A freshly enqueued card is never reviewed yet → no reviewer, and no review rows. (An
  // ALREADY-enqueued solution returns its existing card, which may carry reviews — hence the
  // lookup rather than a hard-coded empty list.)
  const reviewers = (await reviewersFor([item.id])).get(item.id) ?? [];
  return jsonResponse(
    itemDto(item, author, undefined, await challengeRefFor(item.solution_id), {
      reviewers,
      myReview: reviewers.some((r) => r.id === actor.id),
      isAuthor: !!item.author_id && item.author_id === actor.id,
    }),
    201,
  );
});

export function registerPipelineRoutes(router: Router): void {
  router.add('GET', '/api/pipeline', getPipeline);
  router.add('POST', '/api/pipeline/enqueue', enqueue);
  router.add('POST', '/api/pipeline/:id/rollback', rollback);
  router.add('PATCH', '/api/pipeline/:id', patchPipeline);
}
