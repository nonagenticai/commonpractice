// tests/pipeline.test.ts — the production-pipeline routes (Session 6, reworked for 0062).
//
// GET columns + metrics + board policy; PATCH move persists + audits; staging seeds the canary
// percent from policy; enqueueWinner adds a review card; rollback pulls a live card back.
//
// ⛔ THE CENTRE OF THIS FILE IS THE GOVERNANCE PROMOTION GATE, AND WHAT IT IS ALLOWED TO COUNT.
// Before migration 0062 the gate compared `body.reviewerCount` — a literal the browser sent
// (`+page.svelte` hard-coded `reviewerCount: 2`) — against `promotion.required_reviewers`. One
// click by one admin therefore satisfied "2 reviewers required". The old version of this file
// RELIED on that defect: its gate test promoted a card by sending `{ reviewed: true,
// reviewerCount: 2 }` from a single identity, which is exactly the bypass, dressed as coverage.
//
// The gate now counts `pipeline_reviews` rows — one per DISTINCT human, enforced by a UNIQUE
// constraint — inside the same transaction as the stage write. The tests below are written so that
// each one goes RED if a specific piece of that is removed; the revert that kills each is named on
// the test itself. Two identities (ADMIN_A / ADMIN_B) exist because a single-identity suite cannot
// tell "two reviewers approved" apart from "one reviewer clicked twice", which is the whole bug.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray, like, not } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError } from '../src/types';
import { Router } from '../src/utils/router';
import { registerPipelineRoutes } from '../src/routes/pipeline';
import { db, users, challenges, solutions, pipelineItems, pipelineReviews, auditLog, policies, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { PolicyValue } from '../src/db/schema';
import { invalidatePolicyCache } from '../src/host/policy-store';
import type { User } from '../src/types';

const ADMIN_ID = '00000000-0000-0000-0000-0000006b0100';
// A SECOND super-admin identity. Without one, "2 distinct reviewers approved this" is
// indistinguishable from "1 reviewer clicked twice" — the defect 0062 fixes.
const ADMIN_B_ID = '00000000-0000-0000-0000-0000006b0200';
// A THIRD identity that AUTHORS the cards, so neither reviewer is self-reviewing by accident and
// the self-review guard (T5) is exercised deliberately rather than tripped over everywhere.
const AUTHOR_ID = '00000000-0000-0000-0000-0000006b0300';
const USER_IDS = [ADMIN_ID, ADMIN_B_ID, AUTHOR_ID];

const platform: User = { id: ADMIN_ID, email: 'pipe@test', name: 'Pipe Admin', roles: ['super_admin', 'employee'] };
const platformB: User = { id: ADMIN_B_ID, email: 'pipeb@test', name: 'Bea Reviewer', roles: ['super_admin', 'employee'] };
const employee: User = { id: ADMIN_ID, email: 'pipe@test', name: 'Pipe Admin', roles: ['employee'] };
const MARK = 'ZTEST-PIPE ';

function install(u: User) {
  __setAuthOverridesForTests({
    validateAuth: async () => u,
    requireRole: async (_req, role) => {
      if (!u.roles.includes(role)) throw new UnauthorizedError(`Role '${role}' required`);
      return u;
    },
  });
}

const router = new Router();
registerPipelineRoutes(router);

async function callJson(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function makeCard(stage: 'review' | 'hardening' | 'staging' | 'production', opts: Partial<typeof pipelineItems.$inferInsert> = {}) {
  const [row] = await db
    .insert(pipelineItems)
    // Authored by AUTHOR_ID (not the acting admin) so the default card is reviewable by both
    // admins. Tests that need a self-authored card pass `author_id` explicitly.
    .values({ title: `${MARK}${crypto.randomUUID().slice(0, 6)}`, stage, author_id: AUTHOR_ID, ...opts })
    .returning();
  return row!;
}

/** Insert REAL review rows for `userIds` on a card — the setup a card needs to be promotable.
 *  Writes the authoritative rows directly (not through the route), which is exactly what a test
 *  fixture should do; the gate reads these rows, so nothing else is required to satisfy it.
 *
 *  The display caches are recomputed to match, so a fixture leaves the card in a state the
 *  APPLICATION could actually have produced. A fixture that wrote rows but left `reviewer_count`
 *  at 0 would be silently pre-corrupting the cache in every test that used it — and a test that
 *  then asserted on the cache would be asserting against an artefact of its own setup. Tests that
 *  WANT an incoherent cache (T6) corrupt it explicitly, afterwards, which is the honest way to
 *  say so. */
async function giveReviews(cardId: string, userIds: string[]) {
  await db
    .insert(pipelineReviews)
    .values(userIds.map((id) => ({ pipeline_item_id: cardId, reviewer_id: id })))
    .onConflictDoNothing();
  const rows = await db
    .select()
    .from(pipelineReviews)
    .where(eq(pipelineReviews.pipeline_item_id, cardId))
    .orderBy(pipelineReviews.created_at);
  const last = rows[rows.length - 1];
  await db
    .update(pipelineItems)
    .set({
      reviewed: rows.length > 0,
      reviewer_count: rows.length,
      reviewed_by: last?.reviewer_id ?? null,
      reviewed_at: last?.created_at ?? null,
    })
    .where(eq(pipelineItems.id, cardId));
}

/** How many review rows a card actually carries — read straight from the table, never the cache. */
async function reviewRows(cardId: string) {
  return db.select().from(pipelineReviews).where(eq(pipelineReviews.pipeline_item_id, cardId));
}

/** The card as the board renders it (so `reviewers` / `myReview` / `isAuthor` are covered too). */
async function cardFromBoard(cardId: string) {
  const r = await callJson('GET', '/api/pipeline');
  for (const col of r.json.columns) {
    const hit = col.items.find((i: { id: string }) => i.id === cardId);
    if (hit) return hit;
  }
  return undefined;
}

// Pin the promotion policies this suite depends on (other suites may mutate them).
async function setPolicy(key: string, value: PolicyValue) {
  await db.update(policies).set({ value }).where(eq(policies.key, key));
}

async function cleanup() {
  // pipeline_reviews cascades off pipeline_items (0062), so deleting the cards clears the reviews.
  await db.delete(pipelineItems).where(like(pipelineItems.title, `${MARK}%`));
  await db.delete(auditLog).where(inArray(auditLog.actor_id, USER_IDS));
  await db.delete(solutions).where(inArray(solutions.author_id, USER_IDS));
  await db.delete(challenges).where(inArray(challenges.submitter_id, USER_IDS));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await db.delete(users).where(inArray(users.id, USER_IDS));
  await db.insert(users).values([
    { id: ADMIN_ID, email: platform.email, name: platform.name, avatar_initials: 'PA' },
    { id: ADMIN_B_ID, email: platformB.email, name: platformB.name, avatar_initials: 'BR' },
    { id: AUTHOR_ID, email: 'pipeauthor@test', name: 'Ada Author', avatar_initials: 'AA' },
  ]).onConflictDoNothing();
  await setPolicy('promotion.mandatory_review', true);
  await setPolicy('promotion.required_reviewers', '2');
  await setPolicy('promotion.staging_canary_pct', 5);
  invalidatePolicyCache();
  install(platform);
}, 30_000);
afterAll(async () => {
  await cleanup();
  await db.delete(users).where(inArray(users.id, USER_IDS));
  __setAuthOverridesForTests(undefined);
}, 30_000);
afterEach(async () => {
  install(platform);
  await cleanup();
}, 30_000);

test('non-super_admin user is rejected (403)', async () => {
  install(employee);
  expect((await callJson('GET', '/api/pipeline')).status).toBe(403);
});

test('GET returns 4 stage columns + metrics + the board review policy', async () => {
  await makeCard('review');
  const prod = await makeCard('production', { live: true, rollout_pct: 100 });
  await giveReviews(prod.id, [ADMIN_ID, ADMIN_B_ID]);
  const r = await callJson('GET', '/api/pipeline');
  expect(r.status).toBe(200);
  expect(r.json.columns.map((c: { stage: string }) => c.stage)).toEqual(['review', 'hardening', 'staging', 'production']);
  expect(r.json.metrics).toMatchObject({ rolledBack: 0 });
  expect(r.json.metrics.inProduction).toBeGreaterThanOrEqual(1);
  // 0062: the board carries the governance policy so a card can render "N of M" with no second
  // round-trip. Additive + optional frontend-side (a new frontend briefly talks to an old backend).
  expect(r.json.policy).toEqual({ mandatoryReview: true, requiredReviewers: 2 });
});

// ---------------------------------------------------------------------------
// T1 — the client-supplied number is INERT. This is the defect, stated as a test.
// ---------------------------------------------------------------------------
test('T1: a client-supplied reviewerCount is ignored — one click by one admin is ONE review', async () => {
  const card = await makeCard('hardening');

  // The old frontend's exact payload shape, with an absurd count. `reviewerCount` must be ACCEPTED
  // (removing it from the .strict() schema would 422 every old-frontend Approve click during a
  // roll) and IGNORED.
  const r = await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true, reviewerCount: 99 });
  expect(r.status).toBe(200);
  expect(r.json.reviewerCount).toBe(1); // the TRUE derived count, not the 99 that was sent
  expect((await reviewRows(card.id)).length).toBe(1);

  // …and the gate is not fooled either: 1 real review against a policy of 2.
  const blocked = await callJson('PATCH', `/api/pipeline/${card.id}`, { stage: 'production' });
  expect(blocked.status).toBe(422);
  expect(blocked.json.error).toBe('policy_violation');
  expect(blocked.json.message).toBe('Required reviewers: 2 (have 1).');

  const [row] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, card.id));
  expect(row!.stage).toBe('hardening'); // never moved

  // ⛔ THE EXACT HISTORICAL BYPASS, IN ITS ORIGINAL ONE-CALL SHAPE. The old frontend sent the
  // approve and the promote as one PATCH, and the gate read the count straight out of that same
  // body — so the request that asked to be promoted also supplied the number authorising it.
  // Asserting the two-call form alone is NOT enough: a gate reading `body.reviewerCount ??
  // item.reviewer_count` still refuses the second call (whose body carries no count) while
  // happily promoting this one.
  const selfAuthorised = await callJson('PATCH', `/api/pipeline/${card.id}`, {
    stage: 'production',
    reviewed: true,
    reviewerCount: 99,
  });
  expect(selfAuthorised.status).toBe(422);
  expect(selfAuthorised.json.message).toBe('Required reviewers: 2 (have 1).');
  const [after] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, card.id));
  expect(after!.stage).toBe('hardening');
  expect(after!.live).toBe(false);
  expect((await reviewRows(card.id)).length).toBe(1); // still just the one real reviewer
});
// REVERT THAT MUST MAKE THIS RED: restore `set.reviewer_count = body.reviewerCount` and the
// `const reviewerCount = body.reviewerCount ?? item.reviewer_count` gate variable → the card
// promotes at 99.

// ---------------------------------------------------------------------------
// T2 — idempotence. The UNIQUE constraint, not application logic, is what holds this.
// ---------------------------------------------------------------------------
test('T2: the same admin approving twice stays at ONE review (idempotent, UNIQUE-backed)', async () => {
  const card = await makeCard('hardening');

  const first = await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });
  expect(first.status).toBe(200);
  expect(first.json.reviewerCount).toBe(1);

  const second = await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });
  expect(second.status).toBe(200); // NOT a 500 from a 23505
  expect(second.json.reviewerCount).toBe(1);

  expect((await reviewRows(card.id)).length).toBe(1);
});
// REVERTS THAT MUST MAKE THIS RED:
//   (a) drop `onConflictDoNothing({ target: [...] })` from addReview → 23505 → 500 on the second call;
//   (b) drop the UNIQUE constraint from migration 0062 → two rows, reviewerCount === 2.

// ---------------------------------------------------------------------------
// T3 — the headline: TWO DISTINCT humans are required, and two distinct humans suffice.
// ---------------------------------------------------------------------------
test('T3: two DISTINCT admins are needed to promote; one is not enough', async () => {
  const card = await makeCard('hardening');

  // Admin A approves — one real review.
  install(platform);
  const a = await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });
  expect(a.json.reviewerCount).toBe(1);

  // A alone cannot promote.
  const blocked = await callJson('PATCH', `/api/pipeline/${card.id}`, { stage: 'production' });
  expect(blocked.status).toBe(422);
  expect(blocked.json.message).toBe('Required reviewers: 2 (have 1).');

  // Admin B approves — now two DISTINCT reviewers, and both are named.
  install(platformB);
  const b = await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });
  expect(b.status).toBe(200);
  expect(b.json.reviewerCount).toBe(2);
  expect(b.json.reviewers.map((x: { name: string }) => x.name).sort()).toEqual(['Bea Reviewer', 'Pipe Admin']);

  // …and now it promotes.
  const ok = await callJson('PATCH', `/api/pipeline/${card.id}`, { stage: 'production' });
  expect(ok.status).toBe(200);
  expect(ok.json.stage).toBe('production');
  expect(ok.json.live).toBe(true);
  expect(ok.json.rolloutPct).toBe(100);

  const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'deploy.production'));
  expect(audits.some((x) => x.actor_id === ADMIN_B_ID)).toBe(true);
});
// REVERT THAT MUST MAKE THIS RED: revert the route to main → no `reviewers` field on the response,
// the count never leaves 0, and BOTH promotes 422.

// ---------------------------------------------------------------------------
// T4 — withdrawal is real: it removes the row, decrements, and re-blocks.
// ---------------------------------------------------------------------------
test('T4: withdrawing a review decrements the count and re-blocks promotion', async () => {
  const card = await makeCard('hardening');
  await giveReviews(card.id, [ADMIN_ID, ADMIN_B_ID]);
  expect((await reviewRows(card.id)).length).toBe(2);

  // B withdraws their OWN review.
  install(platformB);
  const w = await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: false });
  expect(w.status).toBe(200);

  // The ROW is gone — asserted first, because that is the thing that must be true. Clearing the
  // cache columns while leaving the row behind (the pre-0062 behaviour) is the failure this catches.
  const rows = await reviewRows(card.id);
  expect(rows.length).toBe(1);
  expect(rows[0]!.reviewer_id).toBe(ADMIN_ID); // A's review is untouched — you withdraw only your own
  expect(w.json.reviewerCount).toBe(1);

  const blocked = await callJson('PATCH', `/api/pipeline/${card.id}`, { stage: 'production' });
  expect(blocked.status).toBe(422);
  expect(blocked.json.message).toBe('Required reviewers: 2 (have 1).');
});
// REVERT THAT MUST MAKE THIS RED: restore the old `{reviewed:false}` handling (clear the
// `reviewed`/`reviewed_by` cache columns only) → the rows survive, the count stays 2, promote 200.

// ---------------------------------------------------------------------------
// T5 — you may not approve your own work.
// ---------------------------------------------------------------------------
test('T5: approving your OWN card is refused (403) and writes NO review row', async () => {
  const card = await makeCard('hardening', { author_id: ADMIN_ID });

  const r = await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });
  expect(r.status).toBe(403);
  expect(r.json.error).toBe('self_review_not_allowed');
  // The guard runs BEFORE any write (mirroring castVote), so nothing partial is left behind.
  expect((await reviewRows(card.id)).length).toBe(0);

  // …and somebody else reviewing the same card is of course fine.
  install(platformB);
  const ok = await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });
  expect(ok.status).toBe(200);
  expect(ok.json.reviewerCount).toBe(1);
});
// REVERT THAT MUST MAKE THIS RED: delete the self-review guard from routes/pipeline.ts → 200 + one row.

// ---------------------------------------------------------------------------
// T6 ⭐ — THE MOST VALUABLE TEST IN THE FILE.
// The gate must never consult the display cache. If it did, cache drift (a rolled-back backend
// image that still wrote the client literal, a hand-edit, a future path that forgets to recache)
// would stop being a rendering bug and become an AUTHORIZATION BYPASS.
// ---------------------------------------------------------------------------
test('T6: a CORRUPTED review cache cannot promote — the gate counts rows, never the cache', async () => {
  // --- Part A: cache claims fully approved, table holds NOTHING. ---
  const cardA = await makeCard('hardening');
  // Exactly what prod's fabricated cards look like: `reviewed = t, reviewer_count = 2` (here 5, to
  // clear any policy) with not one real review behind it.
  await db
    .update(pipelineItems)
    .set({ reviewed: true, reviewer_count: 5, reviewed_by: ADMIN_ID, reviewed_at: new Date() })
    .where(eq(pipelineItems.id, cardA.id));
  expect((await reviewRows(cardA.id)).length).toBe(0);

  const a = await callJson('PATCH', `/api/pipeline/${cardA.id}`, { stage: 'production' });
  expect(a.status).toBe(422);
  expect(a.json.error).toBe('policy_violation');
  // Zero real reviewers → the mandatory-review branch, despite `reviewed = true` in the cache.
  expect(a.json.message).toBe('Mandatory code review is required before Production.');
  const [rowA] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, cardA.id));
  expect(rowA!.stage).toBe('hardening');
  expect(rowA!.live).toBe(false);

  // --- Part B: the counted branch, with a cache that would have passed it. ---
  // ONE real review; the cache says 5. A gate reading the cache promotes; a gate reading the rows
  // reports `(have 1)`. This is the assertion that pins the exact number the gate used.
  const cardB = await makeCard('hardening');
  await giveReviews(cardB.id, [ADMIN_ID]);
  await db
    .update(pipelineItems)
    .set({ reviewed: true, reviewer_count: 5, reviewed_by: ADMIN_ID, reviewed_at: new Date() })
    .where(eq(pipelineItems.id, cardB.id));

  const b = await callJson('PATCH', `/api/pipeline/${cardB.id}`, { stage: 'production' });
  expect(b.status).toBe(422);
  expect(b.json.message).toBe('Required reviewers: 2 (have 1).'); // NOT "have 5"
  const [rowB] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, cardB.id));
  expect(rowB!.stage).toBe('hardening');
  expect(rowB!.live).toBe(false);
});
// REVERT THAT MUST MAKE THIS RED: make the gate read `item.reviewer_count` (or `item.reviewed`)
// instead of `await reviewCount(item.id, tx)` → 200, and an unapproved card goes live.

// ---------------------------------------------------------------------------
// T8 — the reviewers list is derived from the rows, not from the single `reviewed_by` column.
// ---------------------------------------------------------------------------
test('T8: a card exposes EVERY reviewer, with distinct ids and names', async () => {
  const card = await makeCard('hardening');
  // Approve through the ROUTE with both admins, so `reviewed_by`/`reviewed_at` are populated too.
  // That matters: a `reviewers` list wrongly derived from the single `reviewed_by` column would
  // then still render ONE plausible-looking name rather than an obviously-empty list, which is
  // exactly the near-miss this test has to catch.
  install(platform);
  await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });
  install(platformB);
  await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });
  install(platform);

  const rendered = await cardFromBoard(card.id);
  expect(rendered).toBeDefined();
  expect(rendered.reviewers).toHaveLength(2);
  expect([...new Set(rendered.reviewers.map((x: { id: string }) => x.id))]).toHaveLength(2);
  expect(rendered.reviewers.map((x: { name: string }) => x.name).sort()).toEqual(['Bea Reviewer', 'Pipe Admin']);
  expect(rendered.reviewers.every((x: { initials: string }) => !!x.initials)).toBe(true);
  // The acting admin (A) is one of them; the card is not theirs.
  expect(rendered.myReview).toBe(true);
  expect(rendered.isAuthor).toBe(false);
});
// REVERT THAT MUST MAKE THIS RED: derive `reviewers` from `reviewed_by` alone → ONE entry.

// ---------------------------------------------------------------------------
// T10 — the caches are maintained, in the same transaction, in both directions.
// They are not authoritative, but a card that renders the wrong number is still a bug.
// ---------------------------------------------------------------------------
test('T10: the display cache stays coherent with the rows after an add AND after a withdraw', async () => {
  const card = await makeCard('hardening');

  install(platform);
  await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });
  let [row] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, card.id));
  expect(row!.reviewer_count).toBe(1);
  expect(row!.reviewed).toBe(true);
  expect(row!.reviewed_by).toBe(ADMIN_ID);
  expect(row!.reviewed_at).not.toBeNull();

  install(platformB);
  await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });
  [row] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, card.id));
  expect(row!.reviewer_count).toBe(2);
  expect(row!.reviewed_by).toBe(ADMIN_B_ID); // most recent reviewer

  await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: false });
  [row] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, card.id));
  expect(row!.reviewer_count).toBe(1);
  expect(row!.reviewed).toBe(true); // still one reviewer left
  expect(row!.reviewed_by).toBe(ADMIN_ID);

  install(platform);
  await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: false });
  [row] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, card.id));
  expect(row!.reviewer_count).toBe(0);
  expect(row!.reviewed).toBe(false);
  expect(row!.reviewed_by).toBeNull();
  expect(row!.reviewed_at).toBeNull();
  expect((await reviewRows(card.id)).length).toBe(0);
});
// REVERT THAT MUST MAKE THIS RED: delete the `recacheReviewFields` calls from addReview /
// withdrawReview → the cache never moves off its initial value.

// ---------------------------------------------------------------------------
// T11 — the blocked-deploy audit trail must SURVIVE the refusal.
// ---------------------------------------------------------------------------
test('T11: a BLOCKED promotion still persists its deploy.blocked audit row', async () => {
  const card = await makeCard('hardening');
  await giveReviews(card.id, [ADMIN_ID]); // 1 of 2 → will be refused

  const r = await callJson('PATCH', `/api/pipeline/${card.id}`, { stage: 'production' });
  expect(r.status).toBe(422);

  // The gate now runs INSIDE a transaction. `deploy.blocked` is the record that someone tried to
  // ship something unapproved, and it has to outlive the refusal — so the transaction RETURNS a
  // decision and the audit + throw happen after it commits.
  const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'deploy.blocked'));
  const mine = audits.filter((a) => a.target_id === card.id);
  expect(mine.length).toBe(1);
  expect(mine[0]!.actor_id).toBe(ADMIN_ID);
  expect(mine[0]!.result).toBe('Blocked · needs 2 reviewers');
});
// REVERT THAT MAKES THIS RED (verified): `recordAudit({…}, tx)` + `throw` INSIDE the db.transaction
// → the row rolls back with the throw and this query finds nothing.
//
// ⚠️ BE PRECISE ABOUT THE HAZARD, because a looser statement of it is wrong and was checked.
// Merely MOVING the existing `recordAudit({…})` call inside the transaction does NOT lose the row:
// `recordAudit`'s `database` parameter defaults to the pool `db` (host/audit-service.ts:23-26), so
// an un-parameterised call writes on a DIFFERENT connection, commits independently, and survives
// the rollback. That was measured, not assumed — the naive move leaves this test GREEN.
//
// The row is lost only when the audit write is ENLISTED IN the caller's transaction by passing the
// handle. That is not an exotic mistake: the parameter exists precisely so callers can pass one,
// and "make the audit atomic with the thing it audits" sounds like an improvement. It is the
// opposite here — a blocked deploy has no other durable trace, so an audit that rolls back with the
// refusal records nothing at all. Hence the ordering this test pins.

test('marking reviewed captures the acting admin as reviewedBy; withdrawing clears it', async () => {
  const card = await makeCard('hardening');
  const r = await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });
  expect(r.status).toBe(200);
  expect(r.json.reviewed).toBe(true);
  expect(r.json.reviewedBy?.name).toBe('Pipe Admin');
  expect(r.json.reviewedAt).toBeTruthy();
  expect(r.json.myReview).toBe(true);
  const cleared = await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: false });
  expect(cleared.json.reviewedBy).toBeNull();
  expect(cleared.json.reviewedAt).toBeNull();
  expect(cleared.json.myReview).toBe(false);
});

test('a review-only PATCH writes a pipeline.review audit row', async () => {
  const card = await makeCard('hardening');
  await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });
  const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'pipeline.review'));
  const mine = audits.filter((a) => a.target_id === card.id);
  expect(mine.length).toBe(1);
  expect(mine[0]!.result).toBe('Reviewed · 1/2');
  expect(mine[0]!.result_tone).toBe('ok');
});

// ---------------------------------------------------------------------------
// D1 ⭐ — the audit copy describes the ACTOR'S ACTION, not the card's aggregate state.
// A compliance-integrity regression introduced by 0062 and caught in adversarial review.
// ---------------------------------------------------------------------------
test('D1: withdrawing is NEVER logged as an approval, even when someone else\'s review survives', async () => {
  const card = await makeCard('hardening');

  // A and B both approve. The card now stands at 2 reviewers.
  install(platform);
  await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });
  install(platformB);
  await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });

  // B WITHDRAWS. The card's `reviewed` flag stays TRUE, because A's review survives — which is
  // exactly the state that made the state-keyed copy lie.
  const w = await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: false });
  expect(w.status).toBe(200);
  const [row] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, card.id));
  expect(row!.reviewed).toBe(true); // the precondition for the bug — assert it, do not assume it
  expect(row!.reviewer_count).toBe(1);

  const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'pipeline.review'));
  const bRows = audits.filter((a) => a.target_id === card.id && a.actor_id === ADMIN_B_ID);
  // B acted twice: one approval, then one withdrawal.
  expect(bRows.length).toBe(2);
  const withdrawal = bRows.find((a) => (a.result ?? '').includes('withdrawn'));
  expect(
    withdrawal,
    `B withdrew their approval but no audit row says so. Rows for B: ${JSON.stringify(bRows.map((a) => a.result))}. ` +
      `Keying the copy on the CARD's post-write state instead of the ACTOR's action files a row ` +
      `reading "Reviewed · N" against the admin who just REVOKED their approval.`,
  ).toBeDefined();
  expect(withdrawal!.result).toBe('Review withdrawn · 1/2');
  // Toned like deploy.rollback: it REDUCES the approval standing of something that may be live.
  expect(withdrawal!.result_tone).toBe('warn');
  // …and no row attributed to B may read as a grant of approval other than their genuine one.
  expect(bRows.filter((a) => (a.result ?? '').startsWith('Reviewed ·')).length).toBe(1);
});
// REVERT THAT MAKES THIS RED: restore `result: updated!.reviewed ? \`Reviewed · ${updated!.reviewer_count}\`
// : 'Review cleared'` (state-keyed) → B's withdrawal is filed as "Reviewed · 1", tone ok.

// ---------------------------------------------------------------------------
// D2 ⭐ — a shipped card's approvals are the record of WHY it shipped, and are immutable.
// ---------------------------------------------------------------------------
test('D2: a reviewer cannot withdraw their approval from a LIVE Production card', async () => {
  const card = await makeCard('hardening');
  await giveReviews(card.id, [ADMIN_ID, ADMIN_B_ID]);

  // Ship it, legitimately.
  const promoted = await callJson('PATCH', `/api/pipeline/${card.id}`, { stage: 'production' });
  expect(promoted.status).toBe(200);
  expect(promoted.json.live).toBe(true);
  expect(promoted.json.rolloutPct).toBe(100);

  // Now one of its own approvers tries to erase their approval of the live card.
  const refused = await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: false });
  expect(refused.status).toBe(422);
  expect(refused.json.error).toBe('review_locked');

  // ⛔ THE ROWS SURVIVE. Without this the card sits live at 100% rollout with reviewer_count = 0
  // and no surviving record of who let it through — a hard delete performed by the very people the
  // record names, which is precisely what `reviewer_id`'s NO-ACTION FK exists to prevent.
  expect((await reviewRows(card.id)).length).toBe(2);
  const [row] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, card.id));
  expect(row!.reviewer_count).toBe(2);
  expect(row!.reviewed).toBe(true);
  expect(row!.live).toBe(true);

  // The guard runs before any write, so it leaves no audit row for an action that did not happen.
  const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'pipeline.review'));
  expect(audits.filter((a) => a.target_id === card.id).length).toBe(0);
});
// REVERT THAT MAKES THIS RED: delete the `body.reviewed === false && item.stage === 'production'`
// guard from routes/pipeline.ts → 200, and both review rows are gone from a live card.

test('D2: rolling the card back makes its approvals withdrawable again', async () => {
  const card = await makeCard('production', { live: true, rollout_pct: 100, live_at: new Date() });
  await giveReviews(card.id, [ADMIN_ID, ADMIN_B_ID]);

  // Refused while live…
  expect((await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: false })).status).toBe(422);

  // …and permitted once it is no longer live. The lock is on the STAGE, not on the review, so it
  // is a real workflow step rather than a dead end.
  const rolled = await callJson('POST', `/api/pipeline/${card.id}/rollback`);
  expect(rolled.status).toBe(200);
  expect(rolled.json.stage).toBe('staging');

  const w = await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: false });
  expect(w.status).toBe(200);
  expect((await reviewRows(card.id)).length).toBe(1);
});

test('D2: ADDING a review to a live card is still allowed — more approvals never weaken the record', async () => {
  // author_id null so the third reviewer is not self-reviewing.
  const card = await makeCard('hardening', { author_id: null });
  await giveReviews(card.id, [ADMIN_ID, ADMIN_B_ID]);
  expect((await callJson('PATCH', `/api/pipeline/${card.id}`, { stage: 'production' })).status).toBe(200);

  // The lock is on REMOVING the record, not on the card being live. A third approver may still
  // sign on to something already shipped.
  install({ id: AUTHOR_ID, email: 'pipeauthor@test', name: 'Ada Author', roles: ['super_admin', 'employee'] });
  const added = await callJson('PATCH', `/api/pipeline/${card.id}`, { reviewed: true });
  expect(added.status).toBe(200);
  expect(added.json.reviewerCount).toBe(3);
  expect((await reviewRows(card.id)).length).toBe(3);
});

test('entering Staging seeds the canary percent from policy', async () => {
  const card = await makeCard('hardening');
  const r = await callJson('PATCH', `/api/pipeline/${card.id}`, { stage: 'staging' });
  expect(r.status).toBe(200);
  expect(r.json.stage).toBe('staging');
  expect(r.json.rolloutPct).toBe(5); // promotion.staging_canary_pct
  const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'deploy.staging'));
  expect(audits.length).toBeGreaterThan(0);
});

test('enqueue adds a winning solution to the board at review', async () => {
  const [ch] = await db.insert(challenges).values({ title: `${MARK}ch`, work_area: 'Claims', submitter_id: ADMIN_ID, tenant_id: ADMIN_ID }).returning();
  const [sol] = await withTenantDb(DEMO_TENANT_ID, () => db.insert(solutions).values({ challenge_id: ch!.id, title: `${MARK}sol`, author_id: ADMIN_ID }).returning());

  const r = await callJson('POST', '/api/pipeline/enqueue', { solutionId: sol!.id });
  expect(r.status).toBe(201);
  expect(r.json.stage).toBe('review');
  expect(r.json.solutionId).toBe(sol!.id);
  // A freshly enqueued card is honestly unreviewed.
  expect(r.json.reviewers).toEqual([]);
  expect(r.json.reviewerCount).toBe(0);

  // idempotent — same solution returns its existing card (still 201, same id)
  const again = await callJson('POST', '/api/pipeline/enqueue', { solutionId: sol!.id });
  expect(again.json.id).toBe(r.json.id);
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** A challenge + solution pair owned by the test admin (cleaned via the MARK helpers). */
async function makeSolution(status: 'voting' | 'shipping' = 'voting') {
  const [ch] = await db.insert(challenges).values({ title: `${MARK}ch`, work_area: 'Claims', submitter_id: ADMIN_ID, tenant_id: ADMIN_ID }).returning();
  const [sol] = await withTenantDb(DEMO_TENANT_ID, () => db.insert(solutions).values({ challenge_id: ch!.id, title: `${MARK}sol`, author_id: ADMIN_ID, status }).returning());
  return sol!;
}

test('entering Production stamps live_at + ships the linked solution (Phase 2-E)', async () => {
  const sol = await makeSolution('voting');
  const card = await makeCard('hardening', { solution_id: sol.id });
  // ⛔ TWO REAL REVIEW ROWS. The pre-0062 version of this test seeded
  // `{ reviewed: true, reviewer_count: 2 }` on a raw insert, which the gate no longer honours —
  // it would now 422 and this test would be testing nothing.
  // ⛔ AND NOT `setPolicy('promotion.required_reviewers', '0')`: that is the tempting fix and it is
  // the WRONG one — it makes this test vacuous with respect to the gate it has to get past.
  await giveReviews(card.id, [ADMIN_ID, ADMIN_B_ID]);

  const r = await callJson('PATCH', `/api/pipeline/${card.id}`, { stage: 'production' });
  expect(r.status).toBe(200);
  expect(r.json.live).toBe(true);

  const [row] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, card.id));
  expect(row!.live_at).not.toBeNull();
  const [s] = await db.select().from(solutions).where(eq(solutions.id, sol.id));
  expect(s!.status).toBe('shipping');
});

test('leaving Production reverts the linked solution to voting', async () => {
  const sol = await makeSolution('shipping');
  const card = await makeCard('production', { solution_id: sol.id, live: true, rollout_pct: 100, live_at: new Date() });

  const r = await callJson('PATCH', `/api/pipeline/${card.id}`, { stage: 'staging' });
  expect(r.status).toBe(200);
  expect(r.json.live).toBe(false);
  const [s] = await db.select().from(solutions).where(eq(solutions.id, sol.id));
  expect(s!.status).toBe('voting');
});

test('rollback pulls a Production card back, records rolled_back_at, audits, reverts solution', async () => {
  const sol = await makeSolution('shipping');
  const card = await makeCard('production', { solution_id: sol.id, live: true, rollout_pct: 100, live_at: new Date() });
  await giveReviews(card.id, [ADMIN_ID, ADMIN_B_ID]);

  const r = await callJson('POST', `/api/pipeline/${card.id}/rollback`);
  expect(r.status).toBe(200);
  expect(r.json.stage).toBe('staging');
  expect(r.json.live).toBe(false);
  expect(r.json.rolloutPct).toBe(0);
  // A rollback does not un-approve anything — the reviews the card earned survive it.
  expect(r.json.reviewers).toHaveLength(2);

  const [row] = await db.select().from(pipelineItems).where(eq(pipelineItems.id, card.id));
  expect(row!.rolled_back_at).not.toBeNull();
  const [s] = await db.select().from(solutions).where(eq(solutions.id, sol.id));
  expect(s!.status).toBe('voting');
  const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'deploy.rollback'));
  expect(audits.some((a) => a.actor_id === ADMIN_ID)).toBe(true);
});

test('rollback on a non-Production card is rejected (422)', async () => {
  const card = await makeCard('review');
  const r = await callJson('POST', `/api/pipeline/${card.id}/rollback`);
  expect(r.status).toBe(422);
  expect(r.json.error).toBe('not_in_production');
});

/** Run `fn` with the board metrics computed over THIS FILE'S CARDS ONLY.
 *
 *  The metrics tests assert EXACT figures — an average cannot be asserted as a delta — and
 *  `GET /api/pipeline` computes every metric over EVERY row in `pipeline_items`: the table is
 *  platform-wide, not tenant-scoped. A seeded dev/CI database holds 18 fixture cards, nine of them
 *  live with real `created_at`/`live_at` pairs, so an unisolated `avgTimeToLiveMs` assertion would
 *  really be an assertion about the seeder's fixture spread.
 *
 *  So: lift every row this file did not create out of the table for the duration of the callback,
 *  and put it back verbatim (same ids, same timestamps) in `finally`. Save-mutate-restore around a
 *  platform-wide table is the established shape in this suite — tests/marketplace-summary.test.ts
 *  :158-172 does exactly this with the `live` flag.
 *
 *  ⚠️ `pipeline_reviews` CASCADES off `pipeline_items`, so this would destroy reviews attached to a
 *  foreign row. The seeder deliberately seeds no review claims (seed-platform.ts:264-271), so there
 *  are none — and the assertion below fails loudly rather than silently deleting data if that ever
 *  stops being true. */
let parkedTimestamps: { id: string; live_at: Date | null; rolled_back_at: Date | null }[] = [];

/** Restore whatever `withOnlyOurCards` parked, whether the test passed, threw, OR TIMED OUT.
 *
 *  ⛔ This is deliberately an `afterEach` and not a `finally`. Adversarial review proved that when
 *  a bun test body times out, the body's `finally` NEVER RUNS — the previous version of this helper
 *  DELETEd every foreign row, so a single timeout left `pipeline_items` permanently empty, with no
 *  error saying so. `backend/scripts/check-hook-timeouts.ts` documents four prior incidents of
 *  DB-touching test bodies timing out in this suite, and notes its own AST guard cannot see work
 *  dispatched through a route — which is exactly what these tests do. `afterEach` DOES run after a
 *  timed-out test and can see module state, so the restore belongs here. */
afterEach(async () => {
  if (!parkedTimestamps.length) return;
  const parked = parkedTimestamps;
  parkedTimestamps = [];
  for (const row of parked) {
    await db
      .update(pipelineItems)
      .set({ live_at: row.live_at, rolled_back_at: row.rolled_back_at })
      .where(eq(pipelineItems.id, row.id));
  }
}, 30_000);

/** Run `fn` with the time-based board metrics computed over THIS FILE'S CARDS ONLY.
 *
 *  The metrics tests assert EXACT figures — an average cannot be asserted as a delta — and
 *  `GET /api/pipeline` computes every metric over EVERY row in `pipeline_items`: the table is
 *  platform-wide, not tenant-scoped. A seeded dev/CI database holds 18 fixture cards, nine of them
 *  live with real `created_at`/`live_at` pairs, so an unisolated `avgTimeToLiveMs` assertion would
 *  really be an assertion about the seeder's fixture spread.
 *
 *  It parks foreign rows by NULLING the two timestamps the time-based metrics read, and restores
 *  them in the `afterEach` above. It does NOT delete rows: an earlier version did, and on the
 *  timeout path that destroyed the board and CASCADEd `pipeline_reviews` with it. An UPDATE of two
 *  nullable columns cannot lose a row, cannot cascade, and — since a lost restore only clears two
 *  derived timestamps — degrades to a cosmetic metrics blip rather than data loss. That is the
 *  shape `tests/marketplace-summary.test.ts:158-172` actually established (it parks a flag), and
 *  the shape this helper should have had from the start.
 *
 *  Counting metrics (`inPipeline`/`inProduction`) are NOT isolated by this and must be asserted as
 *  invariants or deltas, never as absolutes. */
async function withOnlyOurCards<T>(fn: () => Promise<T>): Promise<T> {
  const foreign = await db
    .select({ id: pipelineItems.id, live_at: pipelineItems.live_at, rolled_back_at: pipelineItems.rolled_back_at })
    .from(pipelineItems)
    .where(not(like(pipelineItems.title, `${MARK}%`)));
  parkedTimestamps = foreign.filter((r) => r.live_at !== null || r.rolled_back_at !== null);
  for (const row of parkedTimestamps) {
    await db
      .update(pipelineItems)
      .set({ live_at: null, rolled_back_at: null })
      .where(eq(pipelineItems.id, row.id));
  }
  return await fn();
}

// ---------------------------------------------------------------------------
// Board metrics. /pipeline rendered "AVG TIME TO LIVE — / none live yet" directly beside "IN
// PRODUCTION 1 / live now" in production, for a card that really did ship — in 41 minutes. Two
// faults stacked: the server rounded the interval to whole DAYS (41 min → 0), and the browser then
// used that MAGNITUDE as a data-existence predicate (`avgTimeToLiveDays > 0`, twice). The second is
// the defect; the first only made it reachable. The fix ships the existence fact itself
// (`liveCount`) and the duration in a unit that cannot round a real interval away (`avgTimeToLiveMs`).
// ---------------------------------------------------------------------------

// T1 — the real production interval, to the millisecond.
test('metrics: a 41-minute ship reports liveCount 1 + the exact interval (and still 0 whole days)', async () => {
  await withOnlyOurCards(async () => {
    const created = new Date(Date.now() - 3 * DAY_MS);
    const live = new Date(created.getTime() + 41 * 60_000);
    await makeCard('production', { live: true, created_at: created, live_at: live });

    const r = await callJson('GET', '/api/pipeline');
    expect(r.status).toBe(200);
    // The DATA-EXISTENCE fact, which had no representation on the wire before this fix. This is
    // what the stat card must branch on.
    expect(r.json.metrics.liveCount).toBe(1);
    // 41 min = 2_460_000 ms. Asserted exactly: any server-side unit coarser than this rounds a real
    // 41-minute deploy to zero, which is the whole defect.
    expect(r.json.metrics.avgTimeToLiveMs).toBe(2_460_000);
    // ⛔ AND the legacy field is STILL 0 — deliberately. `avgTimeToLiveDays` is read by the OLD
    // frontend for the length of every deploy (backend and frontend are separate images). Making it
    // a float ships "0.028d across shipped"; making it `Math.ceil` ships "1d" for a 41-minute
    // deploy, i.e. a lie an old frontend renders confidently. If someone "fixes" this field, this
    // line goes red and forces the deploy-ordering conversation instead of shipping it silently.
    expect(r.json.metrics.avgTimeToLiveDays).toBe(0);
  });
});

test('metrics: nothing shipped → avgTimeToLiveMs is null, NOT 0 (0 is a real duration)', async () => {
  await withOnlyOurCards(async () => {
    await makeCard('hardening');
    const r = await callJson('GET', '/api/pipeline');
    expect(r.json.metrics.liveCount).toBe(0);
    expect(r.json.metrics.avgTimeToLiveMs).toBeNull();
    // `null` and not `undefined`: `undefined` disappears from the JSON body, making "no data" look
    // exactly like "an old backend that never sent the field" — two different things the frontend
    // must tell apart.
    expect('avgTimeToLiveMs' in r.json.metrics).toBe(true);
    expect(r.json.metrics.avgTimeToLiveDays).toBe(0); // legacy field unchanged in the empty case too
  });
});

// T2 — the sub-label under this stat says "this quarter" in all 8 catalogs; the number now agrees.
test('metrics: rolledBack counts THIS QUARTER only (it used to count all time under a "this quarter" label)', async () => {
  await withOnlyOurCards(async () => {
    await makeCard('staging', { rolled_back_at: new Date() });
    // 200 days is more than two quarters, so this row is outside the current quarter whatever day
    // of the year the suite runs on.
    await makeCard('staging', { rolled_back_at: new Date(Date.now() - 200 * DAY_MS) });

    const r = await callJson('GET', '/api/pipeline');
    expect(r.status).toBe(200);
    expect(r.json.metrics.rolledBack).toBe(1);
  });
});

// T3 — a rolled-back card was counted twice: as "not yet live" AND as "rolled back".
test('metrics: no card on the board is invisible to every count', async () => {
  // The invariant: `inPipeline + inProduction` accounts for EVERY row, so a card a user can see in
  // a column is never denied by all of the numbers above it.
  //
  // ⛔ This test replaces one that asserted the opposite — `inPipeline === 0` for a card that had
  // been live — because an adversarial review proved that predicate (`!r.live_at`) made real cards
  // vanish from every count. TWO reachable states hit it: a card dragged Production → Hardening
  // through the ordinary kanban PATCH (which clears `live` but never `live_at`, and sets no
  // `rolled_back_at`), and any card rolled back in a PREVIOUS quarter, since `rolledBack` is
  // windowed. Both rendered in a column while `inPipeline`, `inProduction` and `rolledBack` all
  // read 0 — the same species of contradiction this whole change exists to remove.
  const before = await callJson('GET', '/api/pipeline');
  const base = before.json.metrics.inPipeline + before.json.metrics.inProduction;

  const created = new Date(Date.now() - 2 * DAY_MS);
  const card = await makeCard('production', {
    live: true,
    rollout_pct: 100,
    created_at: created,
    live_at: new Date(created.getTime() + DAY_MS),
  });
  expect((await callJson('POST', `/api/pipeline/${card.id}/rollback`)).status).toBe(200);

  const r = await callJson('GET', '/api/pipeline');
  expect(r.status).toBe(200);
  // Rollback drops the card to `staging`, so it is one more card NOT in production — and it is
  // still counted. `rolledBack` counts it too; those are two independent true facts about it, and
  // the sub-label no longer claims the pipeline column means "never live".
  expect(r.json.metrics.inPipeline + r.json.metrics.inProduction).toBe(base + 1);
  expect(r.json.metrics.rolledBack).toBeGreaterThanOrEqual(1);

  // Every row the board renders is accounted for by the two structural counts.
  const rendered = (r.json.columns as { items: unknown[] }[]).reduce((n, c) => n + c.items.length, 0);
  expect(r.json.metrics.inPipeline + r.json.metrics.inProduction).toBe(rendered);
});

// ⚠️ THE TEST BELOW PASSED UNDER THE DEFECT AND IS WHERE THE FALSE CONFIDENCE CAME FROM.
// It manufactures a TEN-DAY interval, so `Math.round(ms / DAY_MS)` returns 10 whether or not the
// rounding erases sub-day intervals — the one thing that was broken. It was also written against a
// seeded database in which NO card had a `live_at` at all (the seeder never stamped one), so
// "only live_at card → avg = 10" was true by accident rather than by isolation. Kept, now isolated
// and joined by T1 above, which uses the real 41-minute production interval.
test('metrics: avgTimeToLiveDays + rolledBack reflect the real timestamps', async () => {
  await withOnlyOurCards(async () => {
    // one card that went live exactly 10 days after creation
    await makeCard('production', { live: true, live_at: new Date(), created_at: new Date(Date.now() - 10 * DAY_MS) });
    // one rolled-back card
    await makeCard('staging', { rolled_back_at: new Date() });

    const r = await callJson('GET', '/api/pipeline');
    expect(r.status).toBe(200);
    expect(r.json.metrics.avgTimeToLiveDays).toBe(10); // only live_at card → avg = 10
    expect(r.json.metrics.rolledBack).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// The deadlock the old design also caused, in the OTHER direction: `promotion.required_reviewers`
// is a select offering ['1','2','3'], but the only writer of the count was the frontend's
// hard-coded `2`, so choosing 3 made promotion impossible FOREVER — with a fully green suite.
// ---------------------------------------------------------------------------
test('required_reviewers = 3 is reachable (the old hard-coded 2 made it a permanent deadlock)', async () => {
  await setPolicy('promotion.required_reviewers', '3');
  invalidatePolicyCache();
  try {
    // author_id null so all three identities are eligible reviewers here.
    const card = await makeCard('hardening', { author_id: null });
    await giveReviews(card.id, [ADMIN_ID, ADMIN_B_ID]);
    const blocked = await callJson('PATCH', `/api/pipeline/${card.id}`, { stage: 'production' });
    expect(blocked.status).toBe(422);
    expect(blocked.json.message).toBe('Required reviewers: 3 (have 2).');

    // A third distinct human unblocks it — under the old design nothing could ever write a 3.
    await giveReviews(card.id, [AUTHOR_ID]);
    const ok = await callJson('PATCH', `/api/pipeline/${card.id}`, { stage: 'production' });
    expect(ok.status).toBe(200);
    expect(ok.json.stage).toBe('production');
  } finally {
    await setPolicy('promotion.required_reviewers', '2');
    invalidatePolicyCache();
  }
});
