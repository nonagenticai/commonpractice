// tests/onboarding-integrity-contract.test.ts — the "assigning a tenant stays human" guard, made
// unforgeable.
//
// ⛔ WHAT THIS PINS, AND WHY A TEST RATHER THAN A COMMENT.
// PR #350 built `host/onboarding-integrity.ts` to census two broken onboarding states and repair
// one of them — and drew a line, in code AND in a test, that assigning a person to a tenant is a
// decision that stays human: "It deliberately does not fabricate a tenant… choosing someone's
// tenant is exactly the decision that must stay human." Nothing about that line survives in the
// type system. A future edit that adds one `.update(users).set({ tenant_id })` call, or a lookup
// named `matchTenantByEmail`, would compile clean and typecheck clean while quietly crossing it.
// This file is what stops that edit from merging silently — the same role
// tests/tick-claim-contract.test.ts plays for `claimTick`: see that file's header for why a
// convention that only lives in prose is followed only sometimes.
//
// Reads `onboarding-integrity.ts` as TEXT and strips comments before scanning it, for the same
// reason tick-claim-contract.test.ts does: this reconciler's own docblock legitimately QUOTES some
// of the banned identifiers below (to explain why they are banned), and a raw-source scan would be
// tripped by its own documentation.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;
const RECONCILER_PATH = join(SRC, 'host/onboarding-integrity.ts');

/**
 * TypeScript source with `//` and block comments removed; string/template literals are preserved.
 *
 * Copied verbatim from tick-claim-contract.test.ts's `stripComments` — this file owns no source
 * outside itself and may not import from a sibling test file. See that file for why this is a
 * character scanner and not a regex, and for the measured proof that a raw-source scan is defeated
 * by a comment that merely quotes the string being searched for.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src[i]! + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Executable source of `host/onboarding-integrity.ts`, comments stripped. */
function reconcilerCode(): string {
  return stripComments(readFileSync(RECONCILER_PATH, 'utf8'));
}

test('⛔ never writes users.tenant_id — assigning a tenant is the decision PR #350 kept human', () => {
  const code = reconcilerCode();

  // Drizzle write shape: `.update(users)` paired with a `.set({ … tenant_id … })` naming the same
  // column. Matched loosely (bounded lookahead, not a full parser) on purpose, matching this repo's
  // house idiom: the job is to catch the FIRST such call, not to validate its formatting, and a
  // tighter regex is a regex a reformatted future edit can dodge.
  const drizzleWrite = /\bupdate\(\s*users\s*\)[\s\S]{0,400}?\.set\(\s*\{[^}]*\btenant_id\b/;
  // Raw SQL escape hatch — `sql\`UPDATE users SET tenant_id = …\`` — stays visible because
  // stripComments preserves string/template contents.
  const rawSqlWrite = /\bUPDATE\s+users\b/i;

  expect(
    drizzleWrite.test(code),
    "found `update(users)…set({ …tenant_id… })` in onboarding-integrity.ts — this reconciler must " +
      'never assign a person to a tenant. PR #350: "It deliberately does not fabricate a tenant… ' +
      'choosing someone\'s tenant is exactly the decision that must stay human." Census and report ' +
      'the orphan; do not write tenant_id.',
  ).toBe(false);
  expect(
    rawSqlWrite.test(code),
    'found a raw `UPDATE users` statement in onboarding-integrity.ts — same rule as the Drizzle ' +
      'check above, closed for the raw-SQL escape hatch: no write path to users.tenant_id from this ' +
      'reconciler, however it is spelled.',
  ).toBe(false);
});

test('⛔ never provisions or mutates a Keycloak identity', () => {
  const code = reconcilerCode();
  const BANNED = [
    'provisionRealmUser',
    'createRealmUser',
    'setUserAttributes',
    'executeActionsEmail',
    'assignRealmRole',
  ];
  const named = BANNED.filter((name) => new RegExp(`\\b${name}\\b`).test(code));
  expect(
    named,
    named.length
      ? `${JSON.stringify(named)} named in onboarding-integrity.ts. This reconciler CENSUSES and ` +
          'REPAIRS licence issuance — it has no business creating or mutating a Keycloak identity. ' +
          'Naming any of these is the write-side twin of the tenant-assignment ban above: both are ' +
          'identity decisions PR #350 drew the line to keep out of an automated reconciler.'
      : undefined,
  ).toEqual([]);
});

test('⛔ never routes a person to a tenant by matching or resolving one', () => {
  const code = reconcilerCode();
  const BANNED = ['matchTenantByEmail', 'assignedTenantId'];
  const named = BANNED.filter((name) => new RegExp(`\\b${name}\\b`).test(code));
  expect(
    named,
    named.length
      ? `${JSON.stringify(named)} named in onboarding-integrity.ts. Naming either is how a future ` +
          'edit could smuggle tenant-routing logic in WITHOUT ever writing to users.tenant_id ' +
          'directly — resolve-then-hand-off is still the automated routing decision PR #350 ' +
          'forbade. Report the orphaned person; let a human pick the tenant.'
      : undefined,
  ).toEqual([]);
});

test('subject-resolution query filters tombstoned users (deleted_at)', () => {
  const code = reconcilerCode();
  expect(
    code.includes('deleted_at'),
    'onboarding-integrity.ts never names `deleted_at`. scripts/backfill-licenses.ts:47-53 is the ' +
      "measured version of this exact bug: its oldest-user query has no tombstone filter, so it " +
      'can bind a licence to a user who is deleted. This reconciler resolves subjects the same ' +
      'shape of way — its query MUST filter deleted_at or it reintroduces the bug that sibling ' +
      'script still has.',
  ).toBe(true);
});

test('⛔ claims go through claimTick — never call runSystemTick directly', () => {
  const code = reconcilerCode();
  expect(
    /\brunSystemTick\b/.test(code),
    'onboarding-integrity.ts names `runSystemTick` directly. A refused claim RESOLVES to undefined ' +
      '(it does not throw) — see tick-claim-contract.test.ts for the ~27h cycle-starvation this ' +
      'caused the last time a call site routed around the wrapper. Use `claimTick` from ' +
      'host/tick-locks.ts, which owns the log + counter branch for a refused claim.',
  ).toBe(false);
  expect(
    /\bclaimTick\s*\(/.test(code),
    'onboarding-integrity.ts never calls `claimTick` at all — non-vacuity for the assertion above: ' +
      'a reconciler with NO claim call would pass "never names runSystemTick" while running ' +
      'unguarded on every pod, double-driving the licence repair this reconciler exists to perform.',
  ).toBe(true);
});

test('claim window is strictly below its own scheduler fire period — checked for every registered tick', async () => {
  const { TICK_MIN_INTERVAL_MS } = await import('../src/host/tick-locks');

  // label -> documented fire period, ms. Not just onboardingIntegrity: the bug this guards against
  // is a CLASS, not a one-off — tick-locks.ts's own TICK_MIN_INTERVAL_MS doc records that a 12h
  // window against cycle/auditExport's 24h period ate an entire day's tick — so every registered
  // entry is checked here, not only the new one.
  const PERIODS_MS: Record<keyof typeof TICK_MIN_INTERVAL_MS, number> = {
    cycle: 24 * 60 * 60 * 1000,
    auditExport: 24 * 60 * 60 * 1000,
    translation: 5 * 60 * 1000,
    budget: 15 * 60 * 1000,
    sandboxSweep: 60 * 1000,
    runLeaseReconciler: 15 * 1000,
    onboardingIntegrity: 5 * 60 * 1000,
    // host/metering-outbox-drainer.ts METERING_OUTBOX_INTERVAL_MS.
    meteringOutbox: 30 * 1000,
    // host/metering-reconcile.ts RECONCILE_INTERVAL_MS. ⚠️ Its claim key is per UTC DAY
    // (`meteringReconcileTickKey`), not the bare cadence key, which is what lets a 12h window sit
    // under a 24h period without the starvation this test exists to catch — the key changes at
    // midnight, so a stale claim cannot outlive the day it was taken for.
    meteringReconcile: 24 * 60 * 60 * 1000,
  };

  for (const [label, period] of Object.entries(PERIODS_MS) as Array<
    [keyof typeof TICK_MIN_INTERVAL_MS, number]
  >) {
    const window = TICK_MIN_INTERVAL_MS[label];
    expect(
      window < period,
      `TICK_MIN_INTERVAL_MS.${label} is ${window}ms but its scheduler fires every ${period}ms — a ` +
        'claim window that is not STRICTLY BELOW the fire period suppresses every tick after the ' +
        "first (tick-locks.ts's own doc: a 12h window against a 24h period is what starved " +
        'cycle-scheduler for ~27h with no error, because a refused claim resolves to undefined ' +
        'rather than throwing). onboardingIntegrity is deliberately 2min/5min (2m<5m) — if THIS ' +
        'entry reddens, either its window widened past its fire period or the fire period moved ' +
        'underneath it without this check being updated to match.',
    ).toBe(true);
  }
});
