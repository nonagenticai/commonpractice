// tests/rls-bypass-discipline.test.ts — `runAsSystem` as a RATCHET.
//
// ⛔ WHAT THIS PROTECTS. `runAsSystem` binds the owner pool and sets NO `app.current_tenant`, so
// inside it the ~40 RLS-policed tables are wide open across every tenant. An audit of all 57 sites
// (before the `reason` parameter existed) found ZERO exploitable paths — and that is exactly why a
// gate is needed rather than a fix: every site was correct, none of them said so, and the safety
// property was "the caller passed the right id", which no type and no runtime check represented.
//
// The file's own history records that property breaking TWICE: `services/provisioning.ts` documents
// a real cross-tenant CASCADE that deleted another tenant's metering and chat history, and
// `routes/connectors.ts` documents RLS being removed as an accidental second layer. Both were found
// by a human reading code. This test is the machine that reads it every time.
//
// ⚠️ NON-VACUITY FIRST. Every assertion below is of the form "no offenders", which a broken scan
// passes trivially by matching nothing. So the scan proves it can still SEE the call sites before
// it is allowed to report that none of them offend.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripComments } from './helpers/strip-non-code';

const ROOT = join(import.meta.dir, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const FILES = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))].map((p) => ({
  rel: relative(ROOT, p),
  // Comments stripped: this codebase discusses `runAsSystem (…)` in prose constantly, and a raw
  // scan reports every one of those as an undeclared call site.
  src: stripComments(readFileSync(p, 'utf8')),
}));

/** Kept in sync with `SystemReason` in src/db/client.ts. Duplicated deliberately: if the union
 *  grows, this test must be edited too, which is the point — a new bypass CATEGORY is a decision. */
const REASONS = new Set([
  'boot-seed',
  'scheduler-tick',
  'platform-admin',
  'credential-auth',
  'non-rls-table',
  'tenant-parameterised',
  'cross-tenant-aggregate',
]);

const CALL = /runAsSystem\s*\(\s*(?:'([a-z-]+)'|([^'\s)]))/g;

function callSites(): { rel: string; reason: string | null }[] {
  const out: { rel: string; reason: string | null }[] = [];
  for (const f of FILES) {
    if (f.rel === 'src/db/client.ts') continue; // the definition + its own doc comment
    for (const m of f.src.matchAll(CALL)) {
      out.push({ rel: f.rel, reason: m[1] ?? null });
    }
  }
  return out;
}

test('every runAsSystem call declares a reason, as an inline literal', () => {
  const sites = callSites();
  // NON-VACUITY: the codebase really does still bypass RLS in dozens of places. If this ever drops
  // near zero the regex has broken, not the risk.
  expect(sites.length).toBeGreaterThan(50);

  // A non-literal (a variable, a ternary, a helper call) would satisfy the compiler while making
  // the reason unreadable to any reviewer or grep — which defeats the whole parameter.
  const nonLiteral = sites.filter((s) => s.reason === null).map((s) => s.rel);
  expect(nonLiteral).toEqual([]);

  const unknown = sites.filter((s) => s.reason && !REASONS.has(s.reason));
  expect(unknown.map((s) => `${s.rel}: ${s.reason}`)).toEqual([]);
});

/**
 * `tenant-parameterised` is the honest label for "safe ONLY because the caller passed the right
 * id — the database enforces nothing here". It is the bucket the doc comment says to shrink, so it
 * is pinned two ways: a count that may only go DOWN, and a fixed set of files. A new file entering
 * this bucket is a real decision about blast radius, and it should cost a deliberate edit here
 * rather than sliding in with a plausible-looking one-line diff.
 */
const TENANT_PARAMETERISED_FILES = new Set([
  'src/ai/llm/select.ts',
  'src/blocks/test-runner.ts',
  'src/datasets/mapping-service.ts',
  'src/host/budget-service.ts',
  'src/routes/blocks.ts',
  'src/routes/connectors.ts',
  // W7 task C (2026-10-15), a deliberate entry: PATCH /api/tenant/cycle-cadence runs
  // `switchTenantCadence` as SYSTEM because it moves the tenant's running `marketplace_cycles` row,
  // which cp_app may only READ (0110). The id comes from `requireTenantAdmin` in the same handler
  // (a body/query tenant id is refused, 400) and every write in the switch carries it explicitly;
  // tests/tenant-cycle-cadence.test.ts drives the smuggled-id and cross-tenant cases as cp_app.
  'src/routes/tenant-cycle-cadence.ts',
  'src/services/license-provisioning.ts',
  'src/services/offboarding.ts',
  'src/services/provisioning.ts',
  'src/services/seat-limit.ts',
]);
const TENANT_PARAMETERISED_CEILING = 20;

test('the tenant-parameterised bucket only ever shrinks', () => {
  const sites = callSites().filter((s) => s.reason === 'tenant-parameterised');

  // NON-VACUITY: the bucket is not empty, so "no new files" is a real constraint and not an
  // artefact of a scan that found nothing.
  expect(sites.length).toBeGreaterThan(0);

  expect(
    sites.length,
    `tenant-parameterised grew to ${sites.length}. This bucket is meant to shrink: either give the ` +
      'site a narrower reason, or move the gate into the callee — do not raise the ceiling.',
  ).toBeLessThanOrEqual(TENANT_PARAMETERISED_CEILING);

  const newFiles = [...new Set(sites.map((s) => s.rel))].filter((f) => !TENANT_PARAMETERISED_FILES.has(f));
  expect(
    newFiles,
    'a new file started trusting a caller-passed tenant id under an RLS bypass — that is a blast-radius decision',
  ).toEqual([]);
});

test('the reason union in the test matches the one in client.ts', () => {
  // If they drift, this test silently stops policing whatever was added — the classic way a
  // ratchet keeps passing while no longer covering the thing it was written for.
  const src = readFileSync(join(ROOT, 'src', 'db', 'client.ts'), 'utf8');
  const block = src.slice(src.indexOf('export type SystemReason'), src.indexOf('export async function runAsSystem'));
  const declared = new Set([...block.matchAll(/\|\s*'([a-z-]+)'/g)].map((m) => m[1]!));
  expect(declared.size).toBeGreaterThan(0);
  expect([...declared].sort()).toEqual([...REASONS].sort());
});
