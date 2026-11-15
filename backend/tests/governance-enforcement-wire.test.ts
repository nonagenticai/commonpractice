// tests/governance-enforcement-wire.test.ts — /api/governance TELLS THE BROWSER WHAT BACKS EACH
// RAIL, and a RETIRED rail cannot be written.
//
// ⛔ THE DEFECT. The Governance screen was headed "Policy rails · enforced at the boundary" over
// eighteen rails, four of which no code reads at all — `models.code_exec_outside_blocks`,
// `data.block_prod_data`, `data.cross_sandbox_isolation` and `data.eu_only` parse into
// GovernanceSnapshot fields with ZERO consumers in backend/src. The browser had no way to tell an
// architectural assertion from a boundary that really refuses a run, because the wire did not carry
// the distinction. `host/policy-enforcement.ts` now owns it and this file pins it TO THE ROUTE:
// a frontend-side copy of "which rails are enforced" would be a second source of truth for a fact
// only the backend can know.
//
// ⛔ AND THE PATCH REFUSAL IS THE HALF THAT CANNOT LIVE IN THE BROWSER. `data.eu_only` claimed EU
// residency nothing ever checked; the claim is withdrawn and the screen renders it read-only. But
// /governance is reachable by curl and by any admin script, and the one thing that must not happen
// is a fresh `policy_changes` diff + `policy.change` audit row recording that somebody "turned
// EU-only execution off" — a change to a control that never controlled anything, sitting in the
// compliance trail beside real hardening decisions.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError } from '../src/types';
import { Router } from '../src/utils/router';
import { registerGovernanceRoutes } from '../src/routes/governance';
import { db, users, policies, policyChanges, auditLog } from '../src/db/client';
import { getSnapshot, invalidatePolicyCache } from '../src/host/policy-store';
import { POLICY_ENFORCEMENT } from '../src/host/policy-enforcement';
import { ensureCadencePolicy } from '../src/host/cycle-cadence';
import type { User } from '../src/types';

// ⛔ Fixture ids must be UNIQUE PER TEST FILE — every file runs against ONE database and each
// DELETEs its own fixtures, so a shared id means one file rips a row out from under another's.
const ADMIN_ID = '00000000-0000-0000-0000-0000006a0e01';
const platform: User = {
  id: ADMIN_ID,
  email: 'gov-enf@test',
  name: 'Gov Enf Admin',
  roles: ['super_admin', 'employee'],
};

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
registerGovernanceRoutes(router);

async function callJson(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

type WirePolicy = { key: string; value: unknown; enforcement?: string };
const allPolicies = (json: { groups: { policies: WirePolicy[] }[] }): WirePolicy[] =>
  json.groups.flatMap((g) => g.policies);

// explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS, so a slow one fails as
// "(unnamed) [5003ms]" naming neither file nor cause.
beforeAll(async () => {
  await db.delete(users).where(inArray(users.id, [ADMIN_ID]));
  await db
    .insert(users)
    .values({ id: ADMIN_ID, email: platform.email, name: platform.name, avatar_initials: 'GE' })
    .onConflictDoNothing();
  // `cycle.cadence` is written at server BOOT, not by the seed (its value comes from CYCLE_ENABLED,
  // which the seed step does not see), so a test DB has no row until something ensures it. Same
  // idempotent call server.ts makes; the bootstrap value under tests is 'week' (setup-env.ts).
  await ensureCadencePolicy();
  install(platform);
}, 30_000);
afterAll(async () => {
  // This file writes exactly two policy values — the enforced-rail control case and the
  // applied-rail control case — and puts both back. Each test also restores its own row inline;
  // these are the net for a test that fails mid-way, because a stale value here is read by every
  // later file in the run through the ≤5s policy cache.
  await db.update(policies).set({ value: 5 }).where(eq(policies.key, 'promotion.staging_canary_pct'));
  await db.update(policies).set({ value: 50 }).where(eq(policies.key, 'spend.daily_llm_cap'));
  // ⛔ AND IT RESTORES `data.eu_only` TOO, WHICH IT IS NOT SUPPOSED TO WRITE. Measured while
  // producing the red-then-green evidence for this change: deleting the PATCH guard makes the
  // refusal test's own PATCH SUCCEED, which stores `false` — and then the test stays RED after the
  // guard is restored, because the row it asserts on has moved. A probe that poisons the shared
  // database is indistinguishable from a fix that did not work; this line is what makes reverting
  // the guard a repeatable experiment.
  await db.update(policies).set({ value: true }).where(eq(policies.key, 'data.eu_only'));
  invalidatePolicyCache();
  await db.delete(policyChanges).where(eq(policyChanges.changed_by, ADMIN_ID));
  await db.delete(auditLog).where(eq(auditLog.actor_id, ADMIN_ID));
  await db.delete(users).where(inArray(users.id, [ADMIN_ID]));
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('GET puts an `enforcement` on EVERY rail — no rail is left unclassified on the wire', async () => {
  const r = await callJson('GET', '/api/governance');
  expect(r.status).toBe(200);
  const rails = allPolicies(r.json);
  // Non-vacuity: the real seeded+migrated set, not an empty list.
  expect(rails.length).toBeGreaterThanOrEqual(18);
  const unclassified = rails.filter((p) => p.enforcement === undefined).map((p) => p.key);
  expect(unclassified).toEqual([]);
  const bad = rails
    .filter((p) => !['enforced', 'applied', 'architectural', 'retired'].includes(p.enforcement!))
    .map((p) => `${p.key}=${p.enforcement}`);
  expect(bad).toEqual([]);
});

test('⛔ the rails that CHANGE a run but refuse NOTHING come across as `applied`, not `enforced`', async () => {
  // ⛔ THE DEFECT THIS PAIR OF COMMITS CLOSES. `promotion.staging_canary_pct`,
  // `models.work_tiers` and `models.pricing` all have a real consumer, so they were filed under
  // 'enforced' — a band whose note promises, in eight languages, that "the run, brokered call,
  // publish or promotion that breaks it is refused, and the refusal names the rail". Not one of
  // the three refuses anything:
  //   • `pipeline.ts:445` ASSIGNS `set.rollout_pct = snapshot.stagingCanaryPct` and no code in
  //     backend/src or frontend/src ever compares `rollout_pct` to anything;
  //   • `budget-service.ts:419` PICKS `snapshot.workTierModels[tier]` — no comparison, no throw;
  //   • `llm-broker.ts:324` PRICES a completed call; the refusal it can eventually contribute to
  //     names `spend.weekly_spend_ceiling`, which is a different rail and enforced on its own.
  // "Has a consumer" is not "refuses". `applied` is the kind that says so.
  const r = await callJson('GET', '/api/governance');
  const byKey = new Map(allPolicies(r.json).map((p) => [p.key, p.enforcement]));
  expect(byKey.get('promotion.staging_canary_pct')).toBe('applied');
  // `models.work_tiers` lost its only consumer when the welcome budget was retired (0099): it is
  // `architectural` now — no reader, so `applied` ("the next call changes") would be false.
  expect(byKey.get('models.work_tiers')).toBe('architectural');
  expect(byKey.get('models.pricing')).toBe('applied');
  // …and 'applied' is NOT a synonym for either neighbour. It must not read as a boundary, and it
  // must not read as "the switch does nothing" — both of those are the untruths being removed.
  for (const k of ['promotion.staging_canary_pct', 'models.pricing']) {
    expect(byKey.get(k)).not.toBe('enforced');
    expect(byKey.get(k)).not.toBe('architectural');
    expect(byKey.get(k)).not.toBe('retired');
  }
  // ⛔ `spend.auto_suspend_idle` JOINED THEM ON 2026-10-15. Its chain used to END in a refusal
  // (`POST /api/runs` threw `sandbox_suspended` on an idle-suspended sandbox), which is why this
  // line used to assert 'enforced'. An explicit run by the owner now resumes an idle suspension
  // (tests/sandbox-lifecycle.test.ts proves it), so nothing is refused for this window any more.
  // Only the operator's pause (`suspension_reason='admin'`) still refuses, and this rail does not
  // write that.
  expect(byKey.get('spend.auto_suspend_idle')).toBe('applied');
});

test('⛔ the rails nothing enforces do NOT come across the wire as enforced', async () => {
  // These are the whole reason this exists. Their GovernanceSnapshot fields have zero consumers in
  // backend/src, so a screen that files them under "enforced" is lying to a compliance reader.
  //
  // ⛔ THIS WAS "the four rails" AND IS NOW THREE — the guard working, not drift.
  // `models.code_exec_outside_blocks` was genuinely unenforced when this was written. The
  // block-source gate (`src/blocks/source-gate.ts`) now reads `codeExecOutsideBlocks` to decide
  // whether a source that trips the static scan is refused, so the rail acquired a real consumer
  // and moved to 'enforced' — asserted below with the other enforced rails. Keeping it here would
  // have asserted the opposite of what the code does. If a rail ever loses its last consumer,
  // expect the reverse failure and move it back.
  const r = await callJson('GET', '/api/governance');
  const byKey = new Map(allPolicies(r.json).map((p) => [p.key, p.enforcement]));
  expect(byKey.get('data.block_prod_data')).toBe('architectural');
  expect(byKey.get('data.cross_sandbox_isolation')).toBe('architectural');
  expect(byKey.get('data.eu_only')).toBe('retired');
  // …and the mirror: rails that really do refuse something still say so, or the assertions above
  // would be satisfied by a route that simply called everything 'architectural'.
  expect(byKey.get('models.external_http')).toBe('enforced');
  expect(byKey.get('models.code_exec_outside_blocks')).toBe('enforced');
  expect(byKey.get('data.pii_scrubbing')).toBe('enforced');
  expect(byKey.get('spend.daily_llm_cap')).toBe('enforced');
  expect(byKey.get('promotion.mandatory_review')).toBe('enforced');
  // The wire agrees with the module, key for key — the route may not hand-roll its own opinion.
  for (const [key, entry] of Object.entries(POLICY_ENFORCEMENT)) {
    expect(byKey.get(key)).toBe(entry.enforcement);
  }
});

test('⛔ PATCH on the RETIRED rail is refused, and mints NO history', async () => {
  const before = await db
    .select()
    .from(policyChanges)
    .where(eq(policyChanges.policy_key, 'data.eu_only'));
  const auditsBefore = await db.select().from(auditLog).where(eq(auditLog.actor_id, ADMIN_ID));

  const r = await callJson('PATCH', '/api/governance/data.eu_only', { value: false });
  expect(r.status).toBe(422);
  // `route()` serialises an HttpError as `{ error: code, message }` (src/utils/http.ts).
  expect(r.json.error).toBe('policy_retired');
  expect(String(r.json.message)).toContain('retired');

  // The stored value did not move…
  const [row] = await db.select().from(policies).where(eq(policies.key, 'data.eu_only'));
  expect(row!.value).toBe(true);
  // …and — the point — the compliance trail records nothing. A `policy_changes` row here would be
  // an audit entry for a hardening decision that cannot have happened.
  const after = await db
    .select()
    .from(policyChanges)
    .where(eq(policyChanges.policy_key, 'data.eu_only'));
  expect(after.length).toBe(before.length);
  const auditsAfter = await db.select().from(auditLog).where(eq(auditLog.actor_id, ADMIN_ID));
  expect(auditsAfter.length).toBe(auditsBefore.length);
});

test('the retired rail is still RETURNED, and its row still exists (the FK target)', async () => {
  // Retiring is not deleting. `policy_changes.policy_key` references `policies.key` ON DELETE
  // CASCADE, so removing the row would destroy every change ever recorded against it — and an
  // auditor reading an old entry needs the rail's name to still resolve.
  const r = await callJson('GET', '/api/governance');
  expect(allPolicies(r.json).some((p) => p.key === 'data.eu_only')).toBe(true);
  const [row] = await db.select().from(policies).where(eq(policies.key, 'data.eu_only'));
  expect(row).toBeDefined();
});

test('⛔ the retired rail is GONE from the runtime snapshot entirely', async () => {
  // The other half of retirement: the runtime stops CARRYING the claim, so no future caller can
  // pick up a field that means nothing. `euOnly` was removed from GovernanceSnapshot.
  invalidatePolicyCache();
  const snap = (await getSnapshot()) as unknown as Record<string, unknown>;
  expect('euOnly' in snap).toBe(false);
  // Non-vacuity: its neighbours in the same seeded group are still parsed, so this is not just an
  // empty snapshot.
  expect('crossSandboxIsolation' in snap).toBe(true);
  expect('piiScrubbing' in snap).toBe(true);
});

test('an ENFORCED rail still accepts an edit — the refusal is scoped, not a freeze', async () => {
  // The non-vacuity partner of the refusal test: if PATCH were broken for everything, the 422
  // above would pass for the wrong reason.
  //
  // ⛔ THE CONTROL RAIL MUST BE ONE THAT STAYS ENFORCED. This test used
  // `promotion.staging_canary_pct` and asserted `enforcement === 'enforced'` on it — which made
  // the non-vacuity partner assert the very classification this branch corrects, so it would have
  // gone red for the right change and been "fixed" by weakening it. `spend.daily_llm_cap` really
  // does refuse (`llm-broker.ts:842` throws `BrokerRejection('llm_capped')` naming the cap).
  const r = await callJson('PATCH', '/api/governance/spend.daily_llm_cap', { value: 51 });
  expect(r.status).toBe(200);
  expect(r.json.value).toBe(51);
  expect(r.json.enforcement).toBe('enforced');
  const [change] = await db
    .select()
    .from(policyChanges)
    .where(eq(policyChanges.policy_key, 'spend.daily_llm_cap'));
  expect(change).toBeDefined();
  // Restored inline, not only in afterAll: every later file in the run reads this cap through the
  // ≤5s policy cache, and a broker test that finds 51 instead of 50 fails somewhere else entirely.
  await db.update(policies).set({ value: 50 }).where(eq(policies.key, 'spend.daily_llm_cap'));
  invalidatePolicyCache();
});

test('⛔ an APPLIED rail is EDITABLE — the read-only guard is keyed on retirement, not on refusal', async () => {
  // The other half of the retirement guard's scope, and the trap in the middle of this change: a
  // rail that refuses nothing is NOT thereby a rail nobody may edit. `promotion.staging_canary_pct`
  // has no boundary behind it, but the number it carries is what the next promotion records — a
  // 422 here would take a live setting read-only for a reason that does not apply to it.
  const r = await callJson('PATCH', '/api/governance/promotion.staging_canary_pct', { value: 9 });
  expect(r.status).toBe(200);
  expect(r.json.value).toBe(9);
  expect(r.json.enforcement).toBe('applied');
  // …and it mints history, exactly as an enforced rail does. An 'applied' rail is a governed
  // setting, so the trail must record who changed it and from what.
  const [change] = await db
    .select()
    .from(policyChanges)
    .where(eq(policyChanges.policy_key, 'promotion.staging_canary_pct'));
  expect(change).toBeDefined();
  await db.update(policies).set({ value: 5 }).where(eq(policies.key, 'promotion.staging_canary_pct'));
  invalidatePolicyCache();
});
