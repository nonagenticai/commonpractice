// tests/governance.test.ts — the Governance routes (Session 6). GET returns grouped
// policies + compliance + recent changes; PATCH validates per control, writes a
// policy_changes diff + an audit row, and invalidates the cache so a subsequent
// enforced read sees the new value (the cross-cutting headline, proven at the route).
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError } from '../src/types';
import { Router } from '../src/utils/router';
import { registerGovernanceRoutes } from '../src/routes/governance';
import { db, users, policies, policyChanges, auditLog } from '../src/db/client';
import type { PolicyValue } from '../src/db/schema';
import { getSnapshot } from '../src/host/policy-store';
import type { User } from '../src/types';

const ADMIN_ID = '00000000-0000-0000-0000-0000006a0100';
const platform: User = { id: ADMIN_ID, email: 'gov@test', name: 'Gov Admin', roles: ['super_admin', 'employee'] };
const employee: User = { id: ADMIN_ID, email: 'gov@test', name: 'Gov Admin', roles: ['employee'] };

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

/**
 * THE WHOLE `policies` TABLE as this file found it: key -> its canonical jsonb TEXT (see readPolicies).
 *
 * ⛔ WHY THE WHOLE TABLE AND NOT A LIST OF KEYS. `policies` has no `tenant_id`, sits explicitly
 * outside RLS (migrations/0028_rls.sql:22), and is a single GLOBAL table read live by policy-store,
 * the broker and the run-gate. Anything this suite leaves behind is a permanent, unaudited edit to
 * production-shaped state.
 *
 * This started as a hardcoded literal map (`{'spend.daily_llm_cap': 50, 'models.allowlist':
 * [three models]}`) — a WRITE dressed as a restore, which truncated a live 22-model allowlist to 3
 * on every run. Replacing the literals with a snapshot of *an enumerated key list* fixed that one
 * instance and left the class untouched: the select-rail test below PATCHes `data.validation_mode`
 * "block" -> "warn" and that key was on nobody's list, so it stayed flipped — an ENFORCEMENT rail,
 * silently, forever. Enumerating is precisely the thing that failed twice; someone adds a PATCH and
 * does not add the key.
 *
 * So the unit of restore is the TABLE. A new PATCH against a new rail is covered the day it is
 * written, by nobody remembering anything. The `ZZ GUARD` test at the bottom of this file is the
 * other half: it fails loudly if a row is still drifted, added or removed at the end.
 */
const SNAPSHOT = new Map<string, string>();

/** Every key any test actually drifted — proves `restore()` is doing work, see the ZZ GUARD. */
const DRIFTED = new Set<string>();

/**
 * The table as POSTGRES sees it: `value::text`, the canonical jsonb text of each row.
 *
 * ⛔⛔ `value::text` AND NOT THE DRIVER'S JS VALUE — THIS IS NOT A STYLE CHOICE. Reading through
 * drizzle/postgres-js loses the jsonb TYPE on exactly the rails this suite edits. Measured on the
 * live instance: with `promotion.required_reviewers` holding the jsonb STRING `"2"`, the driver
 * hands back the JS NUMBER `2` (the same coercion the select-rail test further down exists to
 * document). A snapshot built from that value stores `JSON.stringify(2)` === `'2'`, and restoring
 * it writes the jsonb NUMBER `2` — silently retyping a `select` rail whose every option is a
 * string, which is precisely the class of shared-state corruption this file is supposed to stop.
 *
 * Worse, a JS-level guard cannot even SEE it: `JSON.stringify(driverValue)` is `'2'` both before
 * and after, so the round-trip reads as clean while `psql` shows `"2"` -> `2`. The snapshot, the
 * restore and the ZZ GUARD therefore all speak jsonb text, end to end. Caught by diffing the real
 * table before/after a run — the in-process check reported no drift.
 */
async function readPolicies(): Promise<Map<string, string>> {
  const rows = (await db.execute(
    sql`select key, value::text as v from policies`,
  )) as unknown as { key: string; v: string }[];
  // Postgres normalizes jsonb (canonical key order, canonical spacing), so plain string equality
  // over this text is a sound, type-faithful value comparison.
  return new Map(rows.map((r) => [r.key, r.v]));
}

/**
 * The value a rail held when this file started, for assertions that need to name it.
 *
 * NB this parses the jsonb text back into JS, so it is subject to the same driver coercion
 * described above for rails whose stored type and JS type disagree. It is only used for
 * `spend.daily_llm_cap` and `models.allowlist`, where they agree. Compare rails with
 * `readPolicies()` text, not this, if you ever need a type-faithful assertion.
 */
function asFound<T = PolicyValue>(key: string): T {
  const raw = SNAPSHOT.get(key);
  expect(raw, `policy '${key}' was not present when this file snapshotted the table`).toBeDefined();
  return JSON.parse(raw!) as T;
}

/** Put every drifted row back exactly as found. Writes only what actually changed. */
async function restore() {
  const now = await readPolicies();
  for (const [key, before] of SNAPSHOT) {
    const after = now.get(key);
    if (after === undefined || after === before) continue; // gone, or untouched — no write
    DRIFTED.add(key);
    // Cast the ORIGINAL jsonb text straight back, never a JS round-trip — see readPolicies().
    await db.execute(sql`update policies set value = ${before}::jsonb where key = ${key}`);
  }
  await db.delete(auditLog).where(eq(auditLog.actor_id, ADMIN_ID));
  await db.delete(policyChanges).where(eq(policyChanges.changed_by, ADMIN_ID));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  // Snapshot the WHOLE table before anything mutates. Everything downstream — `restore()`,
  // `asFound()` and the ZZ GUARD — reads from this one capture.
  for (const [key, value] of await readPolicies()) SNAPSHOT.set(key, value);
  expect(SNAPSHOT.size, 'no policies seeded — this whole file would be vacuous').toBeGreaterThan(0);
  await db.delete(users).where(inArray(users.id, [ADMIN_ID]));
  await db.insert(users).values({ id: ADMIN_ID, email: platform.email, name: platform.name, avatar_initials: 'GA' }).onConflictDoNothing();
  install(platform);
}, 30_000);
afterAll(async () => {
  await restore();
  await db.delete(policyChanges).where(eq(policyChanges.changed_by, ADMIN_ID));
  await db.delete(users).where(inArray(users.id, [ADMIN_ID]));
  __setAuthOverridesForTests(undefined);
}, 30_000);
afterEach(async () => {
  install(platform);
  await restore();
}, 30_000);

test('non-super_admin user is rejected (403)', async () => {
  install(employee);
  const r = await callJson('GET', '/api/governance');
  expect(r.status).toBe(403);
});

test('GET returns the 4 rail groups (+ the voting cycle once ensured) + compliance + recent changes', async () => {
  const r = await callJson('GET', '/api/governance');
  expect(r.status).toBe(200);
  const cats = r.json.groups.map((g: { category: string }) => g.category);
  // `marketplace` (the `cycle.cadence` row, 0107) is written at server boot, not by the seed, so it is
  // present only once something has ensured it — order-dependent across files, hence optional here.
  expect(cats.filter((c: string) => c !== 'marketplace')).toEqual(['data_isolation', 'spend_quota', 'models_tools', 'promotion']);
  expect(cats.length === 4 || cats[4] === 'marketplace').toBe(true);
  expect(r.json.compliance.length).toBeGreaterThan(0);
  expect(Array.isArray(r.json.recentChanges)).toBe(true);
  const cap = r.json.groups.flatMap((g: { policies: unknown[] }) => g.policies).find((p: { key: string }) => p.key === 'spend.daily_llm_cap');
  // Against the SNAPSHOT, not a literal 50: the claim worth making is that GET echoes what is
  // stored, and a literal here would just re-introduce the assumption the SNAPSHOT above exists
  // to kill (it would fail the moment an operator legitimately changes the cap).
  expect(cap.value).toBe(asFound('spend.daily_llm_cap'));
});

test('PATCH a number policy writes a diff + audit and invalidates the cache', async () => {
  const r = await callJson('PATCH', '/api/governance/spend.daily_llm_cap', { value: 7 });
  expect(r.status).toBe(200);
  expect(r.json.value).toBe(7);

  // policy_changes captured old→new
  const [change] = await db.select().from(policyChanges).where(eq(policyChanges.policy_key, 'spend.daily_llm_cap'));
  // `old_value` is whatever `restore()` last put back — the snapshot, not a literal 50.
  expect(change!.old_value).toBe(asFound('spend.daily_llm_cap'));
  expect(change!.new_value).toBe(7);

  // an audit row exists
  const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'policy.change'));
  expect(audits.some((a) => a.actor_id === ADMIN_ID)).toBe(true);

  // the LIVE snapshot reflects the edit immediately (cache invalidated)
  const snap = await getSnapshot();
  expect(snap.dailyLlmCap).toBe(7);
});

test('PATCH validates per control: a bad value is 422', async () => {
  const bad = await callJson('PATCH', '/api/governance/spend.daily_llm_cap', { value: 'lots' });
  expect(bad.status).toBe(422);
  const badList = await callJson('PATCH', '/api/governance/models.allowlist', { value: 'not-a-list' });
  expect(badList.status).toBe(422);
});

test('PATCH a list policy replaces the allowlist', async () => {
  const r = await callJson('PATCH', '/api/governance/models.allowlist', { value: ['claude-opus-4-7'] });
  expect(r.status).toBe(200);
  expect(r.json.value).toEqual(['claude-opus-4-7']);
  const snap = await getSnapshot();
  expect(snap.allowlistedModels).toEqual(['claude-opus-4-7']);
});

test('PATCH a list policy dedupes (guards the each_key_duplicate render crash)', async () => {
  const r = await callJson('PATCH', '/api/governance/models.allowlist', {
    value: ['claude-opus-4-7', 'claude-opus-4-7', 'claude-sonnet-4-6'],
  });
  expect(r.status).toBe(200);
  // first-seen order preserved, no duplicate keys reach the value-keyed badge render.
  expect(r.json.value).toEqual(['claude-opus-4-7', 'claude-sonnet-4-6']);
});

// ⛔ THE NO-OP WRITE, CLOSED AT THE ROUTE. The browser rail is guarded in `PolicyRow.svelte`
// (commitList / commitNumber / commitMapEntry all compare before emitting), but that only binds
// clients that happen to be this SPA. Any other caller — curl, a script, an admin tool, a retry —
// PATCHed an unchanged value and the handler wrote the `policies` row, a `policy_changes` diff whose
// `old_value` was byte-identical to its `new_value`, AND a `policy.change` row in `audit_log`,
// unconditionally. False compliance rows are worse than none: every real edit now sits in a list the
// reader has learned to discount.
//
// ⚠️ COUNTED BEFORE AND AFTER, per table. `afterEach`'s `restore()` clears only the rows THIS suite
// wrote, so a fixed count would be a claim about the whole shared database.
test('PATCH with the value the policy already holds writes nothing at all', async () => {
  const [pBefore] = await db.select().from(policies).where(eq(policies.key, 'spend.daily_llm_cap'));
  const changesBefore = await db.select().from(policyChanges).where(eq(policyChanges.policy_key, 'spend.daily_llm_cap'));
  const auditsBefore = (await db.select().from(auditLog).where(eq(auditLog.action, 'policy.change'))).filter((a) => a.actor_id === ADMIN_ID);

  // ⛔ pBefore's OWN value, never a literal 50. This test's whole claim is "PATCH with the value the
  // policy already holds", and a literal silently inverts it into "PATCH with a DIFFERENT value" the
  // moment the live cap is not 50 — every assertion below would then assert the exact opposite of
  // what it reads, and the rail would be left changed. It read `pBefore` one line up; use it.
  const r = await callJson('PATCH', '/api/governance/spend.daily_llm_cap', { value: pBefore!.value });
  // Still a 200 carrying the current DTO — a no-op is not an error, and the caller must not be
  // pushed into a retry loop by a refusal for having asked for what is already true.
  expect(r.status).toBe(200);
  expect(r.json.value).toBe(pBefore!.value);

  const changesAfter = await db.select().from(policyChanges).where(eq(policyChanges.policy_key, 'spend.daily_llm_cap'));
  expect(changesAfter, 'an unchanged value minted a policy_changes diff').toHaveLength(changesBefore.length);
  const auditsAfter = (await db.select().from(auditLog).where(eq(auditLog.action, 'policy.change'))).filter((a) => a.actor_id === ADMIN_ID);
  expect(auditsAfter, 'an unchanged value minted a policy.change audit row').toHaveLength(auditsBefore.length);
  // The row itself was not touched either — `updated_at` is stamped `new Date()` on every write, so
  // an unchanged timestamp is the proof that the UPDATE never ran.
  const [pAfter] = await db.select().from(policies).where(eq(policies.key, 'spend.daily_llm_cap'));
  expect(pAfter!.updated_at, 'the policies row was re-stamped for a change that did not happen').toEqual(pBefore!.updated_at);
});

// ⛔ EVERY `select` RAIL, AND THE REASON IT IS EVERY ONE RATHER THAN A SPECIMEN. The guard above
// compares the validated new value against the STORED one, and for `select` those two can arrive in
// different JS types: measured on a live instance, `promotion.required_reviewers` reads back from
// the driver as the NUMBER 1 while `validateValue`'s select branch always yields a STRING. Its two
// siblings read back as strings, so a test written against `data.validation_mode` or
// `spend.auto_suspend_idle` passes while the third stays broken — which is precisely how this
// shipped. `spend.daily_llm_cap` (the case above) is a `number` rail, where both sides are numbers
// and the bug is invisible. Loop the control, do not pick a representative.
test('an identical PATCH writes nothing for EVERY select rail, whatever type it reads back as', async () => {
  // ⚠️ SORTED, because the non-vacuity PATCH at the bottom of this test picks ONE rail out of this
  // array and an unordered SELECT hands them back in physical row order. That made which rail got
  // written vary between runs, so any bug in the restore path fired only on the runs that happened
  // to land on the affected rail — it presented as flakiness with no reproducer. Deterministic
  // target, deterministic blast radius. (The loop itself covers every select rail either way.)
  const selects = (await db.select().from(policies))
    .filter((p) => p.control === 'select')
    .sort((a, b) => a.key.localeCompare(b.key));
  expect(selects.length, 'no select rails seeded — this test would be vacuous').toBeGreaterThanOrEqual(3);

  for (const p of selects) {
    const changesBefore = await db.select().from(policyChanges).where(eq(policyChanges.policy_key, p.key));
    const auditsBefore = (await db.select().from(auditLog).where(eq(auditLog.action, 'policy.change'))).filter((a) => a.actor_id === ADMIN_ID);

    // Send back exactly what the rail already holds, the way the UI's own <select> would.
    const r = await callJson('PATCH', `/api/governance/${p.key}`, { value: p.value });
    expect(r.status, `${p.key} refused its own current value`).toBe(200);

    const changesAfter = await db.select().from(policyChanges).where(eq(policyChanges.policy_key, p.key));
    expect(
      changesAfter,
      `${p.key} (stored as ${typeof p.value}) minted a policy_changes diff for its own value`
    ).toHaveLength(changesBefore.length);
    const auditsAfter = (await db.select().from(auditLog).where(eq(auditLog.action, 'policy.change'))).filter((a) => a.actor_id === ADMIN_ID);
    expect(auditsAfter, `${p.key} minted a policy.change audit row for its own value`).toHaveLength(auditsBefore.length);
  }

  // Non-vacuity: a REAL change on a select rail must still be written, or the loop above is
  // satisfied by a guard that swallows everything.
  const target = selects.find((p) => (p.options ?? []).length > 1)!;
  const other = (target.options ?? []).find((o) => o !== String(target.value))!;
  const changesBefore = await db.select().from(policyChanges).where(eq(policyChanges.policy_key, target.key));
  const r = await callJson('PATCH', `/api/governance/${target.key}`, { value: other });
  expect(r.status).toBe(200);
  const changesAfter = await db.select().from(policyChanges).where(eq(policyChanges.policy_key, target.key));
  expect(changesAfter, 'a real select change was swallowed').toHaveLength(changesBefore.length + 1);
});

test('the no-op guard compares the VALIDATED value, not the request body', async () => {
  // ⛔ THE HALF THAT MAKES THE GUARD REACH THE REAL CLIENTS. `"50"` is what an `<input type=number>`
  // and most hand-written scripts put on the wire, and `['a','a','b']` is what an admin typing a
  // duplicate produces — both normalize to the stored value inside `validateValue`, so comparing the
  // raw body instead would let exactly the everyday spellings through.
  const cap = await db.select().from(policyChanges).where(eq(policyChanges.policy_key, 'spend.daily_llm_cap'));
  const numeric = await callJson('PATCH', '/api/governance/spend.daily_llm_cap', { value: '50' });
  expect(numeric.status).toBe(200);
  expect(await db.select().from(policyChanges).where(eq(policyChanges.policy_key, 'spend.daily_llm_cap'))).toHaveLength(cap.length);

  // ⛔ THE DUPLICATE IS TAKEN FROM THE STORED LIST, NEVER NAMED AS A LITERAL MODEL ID. This
  // line used to append `'claude-opus-4-7'`, which is only a dedupe NO-OP if that id is already
  // stored — and whether it is depends entirely on which database you are on. The seeded value is
  // `CATALOG_MODELS` (seed-platform.ts:61), derived live from `providerCatalog()`, and today's
  // catalog carries `claude-opus-4-8` and NOT `claude-opus-4-7`. So on a freshly migrated+seeded
  // CI database the append was a REAL change (21 -> 22 models, the extra id landing at the end),
  // the guard correctly declined to treat it as a no-op, and this assertion failed — while on a
  // long-lived dev box, whose row still holds an older catalog that does contain `claude-opus-4-7`,
  // it deduped away and passed. A test whose subject is "an identical value writes nothing" must
  // not depend on the identity of any particular model.
  //
  // Duplicating `stored[0]` is a no-op against ANY non-empty list: `validateValue`'s
  // `[...new Set()]` keeps first-occurrence order, so the extra copy always collapses back onto
  // the element already at the front. If you ever need an id guaranteed ABSENT, synthesise one
  // (`zz-not-a-real-model`); never reach for a real one whose presence varies by environment.
  const stored = asFound<string[]>('models.allowlist');
  expect(stored.length, 'an empty allowlist cannot demonstrate a dedupe no-op').toBeGreaterThan(0);
  const list = await db.select().from(policyChanges).where(eq(policyChanges.policy_key, 'models.allowlist'));
  const dupes = await callJson('PATCH', '/api/governance/models.allowlist', {
    value: [...stored, stored[0]!],
  });
  expect(dupes.status).toBe(200);
  expect(dupes.json.value).toEqual(stored);
  expect(
    await db.select().from(policyChanges).where(eq(policyChanges.policy_key, 'models.allowlist')),
    'a duplicate that deduped back to the stored list still wrote a diff',
  ).toHaveLength(list.length);
});

// ⛔ THE EMPTY-ALLOWLIST FLOOR, AND IT GUARDS A FAIL-**OPEN**, NOT A FAIL-CLOSED. `llm-broker.ts`
// `reserveCall` gates on `allowlist && allowlist.length > 0 && !allowlist.includes(model)`: an EMPTY
// list SKIPS the check and every model is permitted. So clearing the "Allowlisted models" box on
// /governance and clicking away did not switch the platform off — it switched the model GATE off,
// from a text input, with no confirmation and (before the sibling frontend fix) not even a keystroke
// required, on the screen whose whole claim is that governance is enforced.
//
// "Absent/empty = no restriction" stays the deliberate contract everywhere it is enforced
// (`routes/llm-settings.ts`, `ai/llm/pricing.ts`, `host/allowlist-reconcile.ts`); what this floor
// removes is the PATCH route as a way to reach it by accident.
test('PATCH models.allowlist with an empty list is refused with a 400', async () => {
  // ⚠️ COUNTED BEFORE AND AFTER, not asserted at zero: `policy_changes` is a shared, append-only
  // table and this suite only clears the rows IT wrote (`changed_by = ADMIN_ID`). What must be true
  // is that the refusal added nothing, which a fixed count cannot express.
  const before = await db.select().from(policyChanges).where(eq(policyChanges.policy_key, 'models.allowlist'));

  const r = await callJson('PATCH', '/api/governance/models.allowlist', { value: [] });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('empty_allowlist');
  // The sentence has to say what to do: `writeErrorText` renders a 400's backend message verbatim
  // (frontend/src/lib/api/error-message.ts), so this string IS the screen's copy.
  expect(r.json.message).toMatch(/at least one model/i);

  // …and NOTHING was written. A refusal that still minted the diff row would be the worse bug.
  const [p] = await db.select().from(policies).where(eq(policies.key, 'models.allowlist'));
  expect(p!.value).toEqual(asFound('models.allowlist'));
  const after = await db.select().from(policyChanges).where(eq(policyChanges.policy_key, 'models.allowlist'));
  expect(after).toHaveLength(before.length);
});

test('a list policy that documents empty as a real state still accepts it', async () => {
  // ⛔ THE CASE THAT BOUNDS THE FLOOR, and the reason it is not "no list may be empty": the two
  // rails' ENFORCERS are opposite shapes. `data.egress_allowlist` is checked by `egress-guard.ts`
  // `hostAllowlisted` → `allowlist.some(...)`, which over `[]` is `false` for EVERY host, so empty
  // there is deny-all — the TIGHTEST setting that rail has (its own seeded description reads
  // "Empty = no external host is reachable"), not a mistake. The broker's `length > 0` makes empty
  // mean the opposite on `models.allowlist`. A blanket rule would forbid the one hardening move
  // this rail exists for.
  const [before] = await db.select().from(policies).where(eq(policies.key, 'data.egress_allowlist'));
  try {
    const r = await callJson('PATCH', '/api/governance/data.egress_allowlist', { value: [] });
    expect(r.status).toBe(200);
    expect(r.json.value).toEqual([]);
  } finally {
    // Belt-and-braces: `restore()` now covers the whole table, but this rail's
    // seeded value is a provider-host list nobody should be re-typing into a constant.
    await db.update(policies).set({ value: before!.value }).where(eq(policies.key, 'data.egress_allowlist'));
  }
});

test('PATCH an unknown policy is 404', async () => {
  const r = await callJson('PATCH', '/api/governance/nope.nope', { value: true });
  expect(r.status).toBe(404);
});

// ---- the `map` control (migration 0045: models.work_tiers) ----

test('PATCH a map policy edits the values and feeds the snapshot', async () => {
  const r = await callJson('PATCH', '/api/governance/models.work_tiers', {
    value: {
      small: 'google/gemma-4-26b-a4b-it:free',
      medium: 'nvidia/nemotron-3-super-120b-a12b',
      large: 'z-ai/glm-5.2-turbo',
    },
  });
  expect(r.status).toBe(200);
  expect((r.json.value as Record<string, string>).large).toBe('z-ai/glm-5.2-turbo');
  const snap = await getSnapshot();
  expect(snap.workTierModels.large).toBe('z-ai/glm-5.2-turbo');
});

test('a map edit may NOT invent or drop a key — consumers resolve by key', async () => {
  const missing = await callJson('PATCH', '/api/governance/models.work_tiers', {
    value: { small: 'a', medium: 'b' },
  });
  expect(missing.status).toBe(422);

  const extra = await callJson('PATCH', '/api/governance/models.work_tiers', {
    value: { small: 'a', medium: 'b', large: 'c', huge: 'd' },
  });
  expect(extra.status).toBe(422);
});

test('a map value must be a non-empty string — a blank model id would break every call', async () => {
  const blank = await callJson('PATCH', '/api/governance/models.work_tiers', {
    value: { small: 'a', medium: '   ', large: 'c' },
  });
  expect(blank.status).toBe(422);

  const wrongType = await callJson('PATCH', '/api/governance/models.work_tiers', {
    value: { small: 'a', medium: 3, large: 'c' },
  });
  expect(wrongType.status).toBe(422);
});

test('a map policy rejects an array or a scalar body', async () => {
  expect((await callJson('PATCH', '/api/governance/models.work_tiers', { value: ['a'] })).status).toBe(422);
  expect((await callJson('PATCH', '/api/governance/models.work_tiers', { value: 'a' })).status).toBe(422);
  expect((await callJson('PATCH', '/api/governance/models.work_tiers', { value: null })).status).toBe(422);
});

test('map values are trimmed on save (a stray space in a model id is a silent 404 at the provider)', async () => {
  const r = await callJson('PATCH', '/api/governance/models.work_tiers', {
    value: { small: '  a/b  ', medium: 'c/d', large: 'e/f' },
  });
  expect(r.status).toBe(200);
  expect((r.json.value as Record<string, string>).small).toBe('a/b');
});

// ⛔⛔ THE GUARD WHOSE ABSENCE LET THE ORIGINAL BUG LIVE — KEEP IT LAST IN THE FILE.
//
// `policies` is global, outside RLS and read live by policy-store / the broker / the run-gate, so a
// rail this suite forgets to put back is a permanent, unaudited production edit. Twice now that has
// actually happened: a hardcoded `models.allowlist` literal truncated a live 22-model list to 3 on
// every run, and — after that was fixed by snapshotting an ENUMERATED key list — the select-rail
// test's non-vacuity PATCH left `data.validation_mode` flipped "block" -> "warn", an enforcement
// rail nobody had added to the list.
//
// `restore()` snapshotting the whole table makes the second class structurally impossible. This
// test is the proof that it WORKED, and the alarm if it ever stops: a future PATCH against a rail,
// a row inserted by a test, or a restore that silently failed all surface HERE, loudly, instead of
// as silent drift in shared state that nobody attributes to this file for another six months.
//
// Bun runs tests in declaration order, so by the time this runs every other test has been through
// `afterEach`'s `restore()`.
test('ZZ GUARD: the policies table is byte-identical to what this file found', async () => {
  // NON-VACUITY FIRST. This suite genuinely PATCHes rails, so `restore()` must have had real work
  // to do. Without this, a `restore()` that silently no-oped — or a snapshot that came up empty —
  // would satisfy the equality below perfectly while restoring nothing.
  expect(
    [...DRIFTED].sort(),
    'no rail drifted all suite: restore() is never exercised, so the checks below prove nothing',
  ).not.toEqual([]);

  const now = await readPolicies();

  // A row ADDED or REMOVED is drift the value comparison below cannot see.
  expect([...now.keys()].sort(), 'a policies ROW was added or removed by this suite').toEqual(
    [...SNAPSHOT.keys()].sort(),
  );

  // Report every offender at once, with its values, rather than dying on the first.
  const drift = [...SNAPSHOT]
    .filter(([key, before]) => now.get(key) !== before)
    .map(([key, before]) => `${key}: expected ${before}, found ${now.get(key)}`);
  expect(
    drift,
    'a PATCHed rail was left un-restored — add nothing to a key list, fix restore() so the whole ' +
      'table round-trips',
  ).toEqual([]);
});
