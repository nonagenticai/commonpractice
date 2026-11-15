// tests/allowlist-reconcile.test.ts — the additive-only `models.allowlist` boot self-heal
// (host/allowlist-reconcile.ts). Covers the decision matrix from the module's own header comment:
//   - a stale allowlist gains missing catalog ids (proven against the REAL dev fixture — the
//     3-entry row this repo has been carrying, per PR #161 / the 2026-07-30 handoff);
//   - an operator-edited row (updated_by set) is NEVER touched, even additively;
//   - an empty/absent allowlist is left alone (means "no restriction" — reconciling would IMPOSE
//     one, a behaviour change);
//   - the reconcile is idempotent across two runs.
//
// Two of the throwaway-row tests use a synthetic policy key so they don't depend on (or perturb)
// the shared dev fixture's exact contents; the "real fixture" test uses the actual
// `models.allowlist` row and restores it byte-for-byte in a finally block, per this repo's dev-DB
// mutation rule.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { and, eq, isNull } from 'drizzle-orm';
import { db, policies, policyChanges, auditLog, users } from '../src/db/client';
import type { PolicyValue } from '../src/db/schema';
import { providerCatalog } from '../src/ai/llm/provider-catalog';
import { getSnapshot } from '../src/host/policy-store';
import {
  MODELS_ALLOWLIST_KEY,
  planAllowlistReconcile,
  reconcileModelsAllowlist,
} from '../src/host/allowlist-reconcile';

const CATALOG_MODELS = [...new Set(providerCatalog().flatMap((p) => p.models))];

const TEST_OPERATOR_USER_ID = '00000000-0000-0000-0000-0000ac10ac10';
const KEY_STALE = 'test.allowlist_reconcile_stale';
const KEY_OPERATOR = 'test.allowlist_reconcile_operator';
const KEY_EMPTY = 'test.allowlist_reconcile_empty';
const TEST_KEYS = [KEY_STALE, KEY_OPERATOR, KEY_EMPTY];

async function insertTestPolicy(key: string, value: PolicyValue, updatedBy: string | null) {
  await db
    .insert(policies)
    .values({
      key,
      category: 'models_tools',
      label: 'Test allowlist reconcile fixture',
      control: 'list',
      value,
      updated_by: updatedBy,
    })
    .onConflictDoNothing({ target: policies.key });
  // onConflictDoNothing means a re-run leaves stale state from a prior aborted run — force the
  // exact fixture value/updated_by every time regardless.
  await db.update(policies).set({ value, updated_by: updatedBy }).where(eq(policies.key, key));
  // ⛔ And clear this key's AUDIT TRAIL too, not just its value. Several tests share `KEY_STALE`,
  // and the write-race tests below COUNT `policy_changes` / `audit_log` rows — without this they
  // inherit diffs from whichever test ran before and fail with a count that looks exactly like the
  // duplicate-audit bug they exist to detect. (I hit precisely that false positive writing them.)
  await db.delete(policyChanges).where(eq(policyChanges.policy_key, key));
  await db.delete(auditLog).where(eq(auditLog.target_id, key));
}

async function cleanupTestRows() {
  for (const key of TEST_KEYS) {
    await db.delete(policyChanges).where(eq(policyChanges.policy_key, key));
    await db.delete(policies).where(eq(policies.key, key));
  }
  await db.delete(auditLog).where(eq(auditLog.target_id, KEY_STALE));
  await db.delete(users).where(eq(users.id, TEST_OPERATOR_USER_ID));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(cleanupTestRows, 30_000); // wipe any debris from a prior aborted run before we rely on exact counts
afterAll(cleanupTestRows, 30_000);

// ---------------------------------------------------------------------------------------------
// Pure decision function — no DB. This is the policy from the module header, pinned exactly.
// ---------------------------------------------------------------------------------------------

test('planAllowlistReconcile: a stale, never-edited row gains exactly the missing catalog ids', () => {
  const stale = CATALOG_MODELS.slice(0, 2); // "seeded once, catalog grew since"
  const plan = planAllowlistReconcile({ value: stale, updated_by: null }, CATALOG_MODELS);
  expect(plan.reconciled).toBe(true);
  expect(plan.reason).toBe('reconciled');
  expect(new Set(plan.added)).toEqual(new Set(CATALOG_MODELS.slice(2)));
});

test('planAllowlistReconcile: an operator-edited row is never touched, even though ids are missing', () => {
  const missingSome = CATALOG_MODELS.slice(0, CATALOG_MODELS.length - 1);
  const plan = planAllowlistReconcile(
    { value: missingSome, updated_by: TEST_OPERATOR_USER_ID },
    CATALOG_MODELS,
  );
  expect(plan.reconciled).toBe(false);
  expect(plan.reason).toBe('skipped_operator_edited');
  expect(plan.added).toEqual([]);
});

test('planAllowlistReconcile: an empty allowlist means "no restriction" and is left alone', () => {
  const plan = planAllowlistReconcile({ value: [], updated_by: null }, CATALOG_MODELS);
  expect(plan.reconciled).toBe(false);
  expect(plan.reason).toBe('skipped_empty');
  expect(plan.added).toEqual([]);
});

test('planAllowlistReconcile: an absent row is a no-op', () => {
  const plan = planAllowlistReconcile(undefined, CATALOG_MODELS);
  expect(plan.reconciled).toBe(false);
  expect(plan.reason).toBe('skipped_row_absent');
});

test('planAllowlistReconcile: a catalog-complete row reports nothing missing (the idempotent end state)', () => {
  const plan = planAllowlistReconcile({ value: CATALOG_MODELS, updated_by: null }, CATALOG_MODELS);
  expect(plan.reconciled).toBe(false);
  expect(plan.reason).toBe('skipped_no_missing');
});

// ---------------------------------------------------------------------------------------------
// DB integration — throwaway synthetic rows, so these don't depend on (or risk) the shared
// dev-DB `models.allowlist` fixture's exact contents.
// ---------------------------------------------------------------------------------------------

test('reconcileModelsAllowlist: additively updates the row, writes an auditable diff, never reorders existing entries', async () => {
  const original = CATALOG_MODELS.slice(0, 2);
  await insertTestPolicy(KEY_STALE, original, null);

  const result = await reconcileModelsAllowlist(db, KEY_STALE);
  expect(result.reconciled).toBe(true);
  expect(new Set(result.added)).toEqual(new Set(CATALOG_MODELS.slice(2)));

  const [row] = await db.select().from(policies).where(eq(policies.key, KEY_STALE));
  // The original entries keep their exact original order/position — additive-only means append,
  // never a destructive reorder or a "reset to catalog order".
  expect((row!.value as string[]).slice(0, original.length)).toEqual(original);
  expect(new Set(row!.value as string[])).toEqual(new Set(CATALOG_MODELS));
  // The reconcile is a SYSTEM action, not an operator edit — must not set updated_by, or a
  // second run would (wrongly) treat this row as operator-owned and stop healing it.
  expect(row!.updated_by).toBeNull();

  // Auditable: a policy_changes diff, attributed to the System actor (changed_by null).
  const [change] = await db
    .select()
    .from(policyChanges)
    .where(and(eq(policyChanges.policy_key, KEY_STALE), isNull(policyChanges.changed_by)));
  expect(change).toBeDefined();
  expect(change!.old_value).toEqual(original);
  expect(new Set(change!.new_value as string[])).toEqual(new Set(CATALOG_MODELS));

  // Auditable: an audit_log row, System actor (actor_id null).
  const [audit] = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.target_id, KEY_STALE));
  expect(audit).toBeDefined();
  expect(audit!.actor_id).toBeNull();
  expect(audit!.action).toBe('policy.boot_reconcile_allowlist');

  // Idempotent: a second run against the now-complete row adds nothing and writes no new diff.
  const second = await reconcileModelsAllowlist(db, KEY_STALE);
  expect(second.reconciled).toBe(false);
  expect(second.reason).toBe('skipped_no_missing');
  const changesAfterSecond = await db
    .select()
    .from(policyChanges)
    .where(and(eq(policyChanges.policy_key, KEY_STALE), isNull(policyChanges.changed_by)));
  expect(changesAfterSecond.length).toBe(1); // still just the one diff from the first run
});

test('reconcileModelsAllowlist: an operator-edited row is left byte-for-byte unchanged', async () => {
  await db
    .insert(users)
    .values({ id: TEST_OPERATOR_USER_ID, email: 'allowlist-reconcile-test@test', name: 'Test Operator' })
    .onConflictDoNothing({ target: users.id });

  const operatorChosen = CATALOG_MODELS.slice(0, CATALOG_MODELS.length - 1); // deliberately dropped the last one
  await insertTestPolicy(KEY_OPERATOR, operatorChosen, TEST_OPERATOR_USER_ID);

  const result = await reconcileModelsAllowlist(db, KEY_OPERATOR);
  expect(result.reconciled).toBe(false);
  expect(result.reason).toBe('skipped_operator_edited');
  expect(result.added).toEqual([]);

  const [row] = await db.select().from(policies).where(eq(policies.key, KEY_OPERATOR));
  expect(row!.value).toEqual(operatorChosen); // untouched — the "forbidden" model stays absent

  const changes = await db
    .select()
    .from(policyChanges)
    .where(eq(policyChanges.policy_key, KEY_OPERATOR));
  expect(changes.length).toBe(0); // no diff written — nothing happened
});

test('reconcileModelsAllowlist: an empty allowlist stays empty (no restriction silently imposed)', async () => {
  await insertTestPolicy(KEY_EMPTY, [], null);

  const result = await reconcileModelsAllowlist(db, KEY_EMPTY);
  expect(result.reconciled).toBe(false);
  expect(result.reason).toBe('skipped_empty');

  const [row] = await db.select().from(policies).where(eq(policies.key, KEY_EMPTY));
  expect(row!.value).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// The REAL dev fixture: `models.allowlist` as it actually sits in this dev DB (3 entries, never
// operator-edited — `updated_by IS NULL`, verified live before writing this test). Restored
// byte-for-byte in `finally`, per the repo's dev-DB mutation rule.
// ---------------------------------------------------------------------------------------------

test('reconcileModelsAllowlist: heals the REAL live dev fixture (the actual #161 drift)', async () => {
  const [before] = await db.select().from(policies).where(eq(policies.key, MODELS_ALLOWLIST_KEY));
  expect(before).toBeDefined();
  // This test only makes sense as the regression proof if the fixture starts out exactly as
  // documented: never operator-edited. If a prior run left it operator-owned, fail loudly rather
  // than silently asserting nothing.
  expect(before!.updated_by).toBeNull();
  const originalValue = before!.value as string[];

  try {
    const result = await reconcileModelsAllowlist(db);
    // Only assert "gained the missing ids" if the live catalog has actually drifted ahead of the
    // fixture (true today per the handoff docs — 21 catalog ids vs this row's 3 — but this keeps
    // the test honest if someone widens the fixture before running it).
    const expectedMissing = CATALOG_MODELS.filter((m) => !originalValue.includes(m));
    if (expectedMissing.length > 0) {
      expect(result.reconciled).toBe(true);
      expect(new Set(result.added)).toEqual(new Set(expectedMissing));
      const [after] = await db.select().from(policies).where(eq(policies.key, MODELS_ALLOWLIST_KEY));
      // additive-only: the result is original ∪ missing, NOT `= catalog` — a stale id the
      // fixture carries that the catalog no longer lists (e.g. a renamed model) must survive,
      // because removing it would not be additive. Proven live: this dev fixture's
      // 'claude-opus-4-7' is no longer in the catalog (renamed to 'claude-opus-4-8'), and a
      // first draft of this test wrongly asserted equality with the catalog set — caught by
      // this exact expected/received diff.
      const expectedAfter = new Set([...originalValue, ...expectedMissing]);
      expect(new Set(after!.value as string[])).toEqual(expectedAfter);
      expect(after!.updated_by).toBeNull(); // still not operator-owned — can heal again next boot

      const snap = await getSnapshot();
      expect(new Set(snap.allowlistedModels)).toEqual(expectedAfter); // cache invalidated

      // Idempotent: running again against the now-healed live row adds nothing.
      const second = await reconcileModelsAllowlist(db);
      expect(second.reconciled).toBe(false);
      expect(second.reason).toBe('skipped_no_missing');
    } else {
      expect(result.reconciled).toBe(false);
      expect(result.reason).toBe('skipped_no_missing');
    }
  } finally {
    // Restore byte-for-byte: value AND updated_by (must stay NULL — the whole point of the
    // fixture is that it's never been operator-edited).
    await db
      .update(policies)
      .set({ value: originalValue, updated_by: null })
      .where(eq(policies.key, MODELS_ALLOWLIST_KEY));
    await db
      .delete(policyChanges)
      .where(and(eq(policyChanges.policy_key, MODELS_ALLOWLIST_KEY), isNull(policyChanges.changed_by)));
    await db
      .delete(auditLog)
      .where(and(eq(auditLog.target_id, MODELS_ALLOWLIST_KEY), isNull(auditLog.actor_id)));
  }
}, 30_000);

// ---- the WRITE-TIME race, which the original tests did not exercise --------------------------

test('a write landing between our SELECT and our UPDATE is NOT overwritten', async () => {
  // ⛔ THE DISCRIMINATING TEST, and it took two attempts to get honest.
  //
  // My first two attempts at this passed with the guard REVERTED, i.e. they proved nothing:
  //  * `Promise.all` of two reconciles — the two calls simply serialize, so the loser's SELECT
  //    happens after the winner's COMMIT and it correctly reports `skipped_no_missing`. No
  //    interleaving ever occurred.
  //  * setting `updated_by` BEFORE calling — `planAllowlistReconcile` then returns
  //    `skipped_operator_edited` and the UPDATE is never reached, so the read-time gate is
  //    exercised and the write-time guard is not.
  //
  // The only way to test a read-then-write race is to FORCE the interleaving. This passes a Db
  // facade that performs the real SELECT, then commits an interfering write, then hands the module
  // the STALE rows it read — exactly the state a concurrent operator PATCH or peer replica creates.
  const original = CATALOG_MODELS.slice(0, 3);
  await insertTestPolicy(KEY_STALE, original, null);

  // What the operator does mid-flight: remove one model, deliberately forbidding it.
  const operatorValue = CATALOG_MODELS.slice(0, 2) as PolicyValue;
  let interfered = false;

  // A Proxy over the real `db`, NOT a spread — drizzle's methods live on the prototype, so
  // `{...db}` silently drops `transaction` and the module dies on `database.transaction is
  // undefined` (which is how I first got this wrong).
  const wrapAwaitable = (b: unknown): unknown =>
    new Proxy(b as object, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop === 'then') {
          return (onOk: (r: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
            Promise.resolve(target as Promise<unknown>).then(async (rows) => {
              if (!interfered) {
                interfered = true;
                await db
                  .update(policies)
                  .set({ value: operatorValue, updated_by: TEST_OPERATOR_USER_ID })
                  .where(eq(policies.key, KEY_STALE));
              }
              return onOk(rows); // the module now holds a STALE snapshot
            }, onErr);
        }
        if (typeof v === 'function') {
          return (...a: unknown[]) => wrapAwaitable((v as Function).apply(target, a));
        }
        return v;
      },
    });

  const racingDb = new Proxy(db as object, {
    get(target, prop, recv) {
      if (prop === 'select') {
        return (...a: unknown[]) =>
          wrapAwaitable((Reflect.get(target, prop, recv) as Function).apply(target, a));
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as typeof db;

  const result = await reconcileModelsAllowlist(racingDb, KEY_STALE);

  expect(interfered).toBe(true); // the interleaving really happened
  // The module decided to heal from the stale snapshot, then its guarded UPDATE matched nothing.
  expect(result.reconciled).toBe(false);
  expect(result.reason).toBe('skipped_lost_race');

  // THE ASSERTION THAT FAILS WITHOUT THE GUARD: the operator's value stands byte-for-byte, the
  // model they forbade was not reinstated, and their attribution was not clobbered.
  const [row] = await db.select().from(policies).where(eq(policies.key, KEY_STALE));
  expect(row!.value).toEqual(operatorValue);
  expect(row!.value as string[]).not.toContain(CATALOG_MODELS[2]);
  expect(row!.updated_by).toBe(TEST_OPERATOR_USER_ID);
  // ...and nothing was audited, because nothing was changed.
  const changes = await db
    .select()
    .from(policyChanges)
    .where(eq(policyChanges.policy_key, KEY_STALE));
  expect(changes.length).toBe(0);
}, 30_000);
