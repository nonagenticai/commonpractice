// tests/logging-discipline.test.ts — the structured-logging migration as an ENFORCED gate.
//
// ⛔ WHY THIS FILE EXISTS. `host/logger.ts` shipped and then sat at TWO importers for weeks while
// 155 `console.*` call sites kept emitting free-form text with no request id, no level field and no
// tenant. Nothing failed. A logger nobody calls is indistinguishable from no logger at all, and the
// only symptom is the one you get during an incident: you can see THAT a request failed and not WHY,
// because the lines explaining it are unattributable prose in the same stdout stream.
//
// So the migration needs a floor, or it decays back. Every assertion below is a ratchet: it pins
// what the codebase is allowed to still do, and any NEW offender fails.
//
// ⚠️ EACH CHECK CARRIES A NON-VACUITY GUARD. These are regex scans over source, and a regex that
// matches nothing passes every "there are no offenders" assertion trivially — the failure mode
// where the gate is green because it is broken. So each scan first proves it can still SEE the
// thing it is scanning for.
import { test, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripComments } from './helpers/strip-non-code';

const SRC = join(import.meta.dir, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const FILES = walk(SRC).map((p) => ({ path: p, rel: relative(SRC, p), code: stripComments(readFileSync(p, 'utf8')) }));

const CONSOLE_CALL = /\bconsole\.(log|warn|error|info|debug)\s*\(/g;

/**
 * The ONLY files allowed to call `console.*` directly, each for a reason that would be a
 * regression to "fix". This list may SHRINK. Adding to it is a decision, not a formality.
 */
const CONSOLE_ALLOWED = new Map<string, string>([
  // `console.*` IS the logger's output transport — Bun's console is line-buffered and crash-safe,
  // and routing through a stream we manage would introduce a way to lose the last lines before a
  // crash, which are the ones worth having.
  ['host/logger.ts', 'the logger implementation itself'],
  // The failed-request emitter already builds a well-formed JSON line and carries `reqId`
  // EXPLICITLY. Routing it through `log.*` would make that id depend on the AsyncLocalStorage
  // scope still being active at that point in the response path; if it is not, every 4xx/5xx line
  // silently loses its correlation id. The logger's own docstring names this emitter as the shape
  // it was modelled on, not as a defect.
  ['server.ts', 'the pre-existing structured http error emitter (explicit reqId)'],
]);

test('console.* is confined to the two files that are allowed to use it', () => {
  const offenders: string[] = [];
  let seen = 0;
  for (const f of FILES) {
    const hits = [...f.code.matchAll(CONSOLE_CALL)];
    seen += hits.length;
    if (hits.length > 0 && !CONSOLE_ALLOWED.has(f.rel)) {
      offenders.push(`${f.rel} (${hits.length})`);
    }
  }
  // NON-VACUITY: the allowed files genuinely still contain console calls, so a regex that stopped
  // matching cannot pass this test by finding nothing anywhere.
  expect(seen).toBeGreaterThan(0);
  expect(offenders).toEqual([]);
});

test('every allowlisted file is still real — a stale exemption is a silent licence', () => {
  // If a file on the allowlist no longer calls console.* , the exemption has outlived its reason
  // and must be deleted rather than left standing for some future call site to inherit.
  for (const [rel] of CONSOLE_ALLOWED) {
    const f = FILES.find((x) => x.rel === rel);
    expect(f, `${rel} is allowlisted but does not exist`).toBeDefined();
    expect([...f!.code.matchAll(CONSOLE_CALL)].length, `${rel} no longer calls console.* — remove its exemption`).toBeGreaterThan(0);
  }
});

test('every log.* message is a constant string, never interpolated', () => {
  // The message is the aggregation key. `log.warn(\`enqueue failed for ${id}\`)` produces one
  // distinct "message" per id, which is exactly the unfilterable free-form text the migration
  // removed — it just moves it inside the logger. Ids belong in FIELDS.
  //
  // Scanning the RAW source here (not the stripped copy) because the thing being detected IS a
  // literal; a backtick or a `+` immediately after `log.x(` is the signal.
  const bad: string[] = [];
  let calls = 0;
  for (const f of FILES) {
    const src = readFileSync(f.path, 'utf8');
    for (const m of src.matchAll(/\blog\.(debug|info|warn|error)\s*\(\s*([`'"])/g)) {
      calls += 1;
      if (m[2] === '`') bad.push(`${f.rel}: log.${m[1]} with a template literal`);
    }
    for (const m of src.matchAll(/\blog\.(debug|info|warn|error)\s*\(\s*[^`'"\s)]/g)) {
      bad.push(`${f.rel}: log.${m[1]} whose first argument is not a string literal`);
    }
  }
  // NON-VACUITY: if this found no `log.*` calls at all, the codebase would have silently reverted
  // to console and every assertion above would still be green.
  expect(calls).toBeGreaterThan(100);
  expect(bad).toEqual([]);
});

test('errors are handed to the logger as a field, not stringified at the call site', () => {
  // `log.error('x', { err: String(e) })` throws away name/stack — the logger already unpacks an
  // Error into {name, message, stack}, and a pre-stringified one arrives as a flat useless line.
  const bad: string[] = [];
  for (const f of FILES) {
    if (f.rel === 'host/logger.ts') continue;
    const src = readFileSync(f.path, 'utf8');
    for (const m of src.matchAll(/\blog\.(debug|info|warn|error)\s*\([^)]*?(String\(\s*(?:e|err|error)\s*\)|\b(?:e|err|error)\.message\b)/gs)) {
      bad.push(`${f.rel}: ${m[2]}`);
    }
  }
  expect(bad).toEqual([]);
});
