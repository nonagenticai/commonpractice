// tests/tick-claim-contract.test.ts — the refused-tick convention, made unforgeable.
//
// ⛔ WHAT WENT WRONG, AND WHY A TEST RATHER THAN A COMMENT.
// `runSystemTick` RESOLVES to `undefined` when another pod holds the claim window — it does not
// throw. So a call site that wires up only `.catch()` discards a refusal in total silence. That
// silence is what made the 2026-08-09/10 marketplace-cycle starvation undiagnosable: the cycle sat
// ~27h overdue and the only trace anywhere was the next `[cycle] next tick at …` line naming a day
// later than expected.
//
// The fix at the time added the missing branch to TWO schedulers and wrote this into tick-locks.ts:
//
//     "…every scheduler now LOGS AND COUNTS a refused claim (see the `result === undefined` branch
//      in each *-scheduler.ts)"
//
// FOUR OF THE SIX TICKS DID NOT DO THAT, at the moment that sentence was written:
//   • translation-scheduler.ts — routed the result into `logDrain`, whose first line is
//     `if (!r) return`, so a refused claim was byte-identical to an idle drain: no log, no counter.
//   • budget-scheduler.ts      — boot path had `.catch()` only; scheduled path logged only when the
//     RESULT was non-empty.
//   • sandbox-service.ts       — no branch at all.
//   • run-controller.ts        — no branch at all.
// The last two do not even have a `*-scheduler.ts` file, so the comment's cross-reference could not
// be followed to check it.
//
// A convention that lives in prose is followed only sometimes, and the failure mode of THIS
// convention is silence — the one failure mode nobody notices. So `claimTick` (host/tick-locks.ts)
// now OWNS the `result === undefined` branch, and this test makes routing around it a red build.
import { test, expect } from 'bun:test';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { linesWithMsg } from './helpers/log-lines';

/**
 * The labels of every `tick_skipped` event on one captured channel, in emission order.
 *
 * ⛔ THE REFUSAL LINE IS NOW A FIELD, NOT A SENTENCE. `claimTick` emits
 * `{lvl, msg:'tick_skipped', label}` through host/logger.ts instead of the old
 * `` `${label} SKIPPED` `` text. Matching `msg === 'tick_skipped'` and then comparing `label`
 * EXACTLY is stricter than the substring match it replaces: the old assertion was satisfied by any
 * line that merely contained those words, this one is satisfied only by the refusal event itself
 * carrying that exact label.
 *
 * ⛔ FILTERED BY `msg`, NOT BY POSITION — the same channel carries unrelated events (a scheduler
 * booting, a model substitution), and their interleaving is not a contract. Unparseable lines are
 * NOT dropped: `linesWithMsg` throws on them, because a bare `console.*` that escaped the
 * structured logger is the regression these tests exist to catch, not noise to filter away.
 */
function skipLabels(captured: readonly string[]): string[] {
  return linesWithMsg(captured, 'tick_skipped').map((l) => String(l.label));
}

const SRC = new URL('../src', import.meta.url).pathname;

/** Where `runSystemTick` may legitimately be named in an import. */
const ALLOWED_IMPORTERS = new Set(['host/tick-locks.ts']);
/** Where it is defined (and therefore not imported). */
const DEFINED_IN = 'db/client.ts';

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

const rel = (p: string): string => p.slice(SRC.length + 1);

/**
 * TypeScript source with `//` and block comments removed; string/template literals are preserved.
 *
 * ⛔ WHY EVERY SCAN IN THIS FILE GOES THROUGH HERE FIRST, AND WHY IT IS NOT A DETAIL.
 * Both scans below used to read raw source, and BOTH were defeated by a comment. Measured against
 * this exact tree: deleting `run-controller.ts`'s leader election outright and leaving behind a
 * comment that merely CONTAINED the string `claimTick({` kept this file at 4 pass / 0 fail with
 * `typecheck` clean — while every replica reconciled stale runs concurrently. That is the strongest
 * possible statement of the problem: a test whose subject is "prose is not a convention" was itself
 * satisfied by prose.
 *
 * And it is not a hypothetical form of comment: this repo documents call sites by quoting them, so
 * `tick-locks.ts` and both schedulers legitimately contain `claimTick(` and `runSystemTick` in
 * their docblocks. Stripping is what lets those comments stay honest AND the scan stay real.
 *
 * A character scanner, not a regex: `//` also appears inside `'https://…'` string literals, which a
 * regex-based stripper would eat along with the rest of the line.
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

/** Executable source of every `src/**\/*.ts`, comments removed. */
function codeOfEveryFile(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of listTsFiles(SRC)) out.set(rel(file), stripComments(readFileSync(file, 'utf8')));
  return out;
}

/**
 * Files whose EXECUTABLE code names `runSystemTick` at all.
 *
 * ⛔ ANY MENTION, NOT JUST AN IMPORT BINDING. This used to parse only `import { … }` binding lists,
 * which two ordinary TypeScript spellings walk straight past:
 *
 *     import * as dbclient from '../db/client';   dbclient.runSystemTick(key, ms, fn);
 *     const { runSystemTick } = await import('../db/client');
 *
 * The first was measured against this tree: sandbox-service.ts routed around `claimTick` entirely
 * that way and this file stayed 4 pass / 0 fail. Comments are already gone by the time we get here
 * (see `stripComments`), so the half-dozen docblocks that legitimately DISCUSS `runSystemTick` —
 * which is the point of those docblocks — cannot trip it.
 */
function filesNamingRunSystemTick(): string[] {
  const hits: string[] = [];
  for (const [name, code] of codeOfEveryFile()) {
    if (/\brunSystemTick\b/.test(code)) hits.push(name);
  }
  return hits.sort();
}

test('⛔ runSystemTick is named ONLY by host/tick-locks.ts — every tick goes through claimTick', () => {
  const namers = filesNamingRunSystemTick();

  // ⛔ NON-VACUITY. If the scan (or the source tree) moved and the regex matched nothing, every
  // assertion below would pass while proving nothing at all. tick-locks.ts MUST be in the list —
  // it is the wrapper, so it is the one file that has to name the primitive — and so must the file
  // that DEFINES it, which is the other end of the same anchor.
  expect(namers).toContain('host/tick-locks.ts');
  expect(namers).toContain(DEFINED_IN);

  const rogue = namers.filter((f) => !ALLOWED_IMPORTERS.has(f) && f !== DEFINED_IN);
  expect(
    rogue,
    rogue.length
      ? `${JSON.stringify(rogue)} name runSystemTick in executable code. A refused claim RESOLVES ` +
          `to undefined (it does not throw), so a direct call silently drops the skip — the exact ` +
          `failure that hid a ~27h cycle starvation. Use claimTick() from host/tick-locks.ts, ` +
          `which owns the log + counter branch. (Namespace access — dbclient.runSystemTick(…) — ` +
          `counts: it is the same call with a different spelling.)`
      : undefined,
  ).toEqual([]);
});

test('the primitive is still exported from db/client.ts (the anchor the rule is written against)', () => {
  const text = readFileSync(join(SRC, DEFINED_IN), 'utf8');
  expect(text).toContain('export async function runSystemTick');
});

/**
 * ⛔ THE SECOND HALF. The rule above bans the primitive; it does not prove the six ticks still
 * CLAIM anything. Deleting a scheduler's claim entirely would satisfy it perfectly — and that is a
 * worse bug than the one being fixed (every replica runs every tick: double cycle advances,
 * duplicate compliance exports, double LLM spend, duplicate budget emails).
 */
test('every tick call site goes through claimTick (the budget scheduler was retired in 0099)', () => {
  const CALL_SITES = [
    'host/cycle-scheduler.ts',
    'host/audit-export-scheduler.ts',
    'host/translation-scheduler.ts',
    'host/sandbox-service.ts',
    'host/run-controller.ts',
    'host/signup-digest-scheduler.ts',
  ];
  const code = codeOfEveryFile();
  for (const f of CALL_SITES) {
    // ⛔ COMMENTS ARE STRIPPED FIRST. Reading raw source here was defeated by deleting
    // run-controller.ts's leader election and leaving a comment containing `claimTick({` — 4 pass /
    // 0 fail, typecheck clean, and every replica reconciling stale runs at once. See `stripComments`.
    expect(code.get(f), `${f} no longer claims its tick`).toContain('claimTick({');
  }
});

/**
 * ⛔ AND THE BRANCH ITSELF, IN THE ONE PLACE THAT NOW OWNS IT.
 * `claimTick` could be gutted to a pass-through and every assertion above would still pass, which
 * would restore the original silence in a single edit. This drives the real function with a `run`
 * that is never reached (the claim is refused because it is taken twice inside the window) and
 * asserts the refusal is both LOGGED and COUNTED.
 */
test('⛔ claimTick LOGS and COUNTS a refused claim — the branch four schedulers never had', async () => {
  const { claimTick } = await import('../src/host/tick-locks');
  const { renderMetrics } = await import('../src/host/metrics');
  const { db, schedulerTicks } = await import('../src/db/client');
  const { eq } = await import('drizzle-orm');

  const KEY = `test-claim-contract:${crypto.randomUUID()}`;
  const COUNTER = 'test_tick_skipped_total';
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  };
  try {
    const before = renderMetrics();
    const first = await claimTick({
      key: KEY,
      minIntervalMs: 60 * 60 * 1000,
      label: '[test] first',
      skipCounter: COUNTER,
      run: async () => 'ran',
    });
    expect(first).toBe('ran');
    expect(warns).toEqual([]); // a WON claim must stay silent

    let ranTwice = false;
    const second = await claimTick({
      key: KEY,
      minIntervalMs: 60 * 60 * 1000,
      label: '[test] second',
      skipCounter: COUNTER,
      run: async () => {
        ranTwice = true;
        return 'ran';
      },
    });
    expect(second).toBeUndefined();
    expect(ranTwice).toBe(false); // the body of a refused tick must not run

    // The refusal was emitted, on `warn`, and it names THIS tick — an exact label match, not a
    // substring of a sentence.
    expect(skipLabels(warns)).toEqual(['[test] second']);
    expect(linesWithMsg(warns, 'tick_skipped')[0]?.lvl).toBe('warn');
    const after = renderMetrics();
    expect(after).toContain(`${COUNTER} 1`);
    expect(before).not.toContain(`${COUNTER} 1`);

    // ⛔ NON-VACUITY for the nullable counter: `null` must still LOG. cycle-scheduler passes null
    // for its boot catch-up on purpose (a same-day collision happens on every deploy and would page
    // on every rollout), and a wrapper that treated null as "say nothing" would hand that scheduler
    // back exactly the silence this whole change removes.
    warns.length = 0;
    const third = await claimTick({
      key: KEY,
      minIntervalMs: 60 * 60 * 1000,
      label: '[test] third',
      skipCounter: null,
      run: async () => 'ran',
    });
    expect(third).toBeUndefined();
    expect(skipLabels(warns)).toEqual(['[test] third']);
    expect(renderMetrics()).toContain(`${COUNTER} 1`); // still 1 — null did not bump it
  } finally {
    console.warn = originalWarn;
    await db.delete(schedulerTicks).where(eq(schedulerTicks.key, KEY));
  }
}, 30_000);

/**
 * ⛔ THE NOISE HALF. A refusal that is LOGGED is the fix; a refusal that is logged 17,280 times a
 * day is the same defect wearing the fix's clothes.
 *
 * `runLeaseReconciler` fires every 15s and `sandboxSweep` every 60s on EVERY replica, so on a
 * 2-replica deployment the losing pod is refused 5,760 + 1,440 times a day (17,280 + 4,320 at
 * four). Both sites were silent before `claimTick` existed, so an unconditional `console.warn`
 * there does not restore a lost signal — it manufactures ~7k–22k WARN lines a day that say only
 * "there is more than one pod", and buries the refusals that DO mean something. `refusal:
 * 'expected'` keeps the first one per process loud and drops the repeats to a level nobody pages on.
 *
 * ⚠️ THAT LEVEL IS `info`, AND THE CHANNEL IS `console.log`. This case used to capture
 * `console.debug`, because `claimTick` used to call it directly. Under host/logger.ts `log.debug` is
 * LEVEL-GATED — `LOG_LEVEL` defaults to `info`, so a `debug` repeat would emit NOTHING in
 * production, which is the silence this whole file exists to remove. `tick-locks.ts` therefore emits
 * the repeats at `info`, and `logger.ts` routes both `info` and `debug` to `console.log`. So:
 * capture `console.log` for the repeats, and keep capturing `console.debug` purely to prove they did
 * NOT regress back onto the gated channel.
 */
test('⛔ an EXPECTED refusal warns ONCE per process, then drops to info — but is never silent', async () => {
  const { claimTick } = await import('../src/host/tick-locks');
  const { db, schedulerTicks } = await import('../src/db/client');
  const { eq } = await import('drizzle-orm');

  const KEY = `test-refusal-level:${crypto.randomUUID()}`;
  const LABEL = `[test] expected-refusal ${crypto.randomUUID()}`;
  const warns: string[] = [];
  const infos: string[] = [];
  const debugs: string[] = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  const originalDebug = console.debug;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(' '));
  console.log = (...a: unknown[]) => void infos.push(a.map(String).join(' '));
  console.debug = (...a: unknown[]) => void debugs.push(a.map(String).join(' '));
  const claim = (): Promise<string | undefined> =>
    claimTick({
      key: KEY,
      minIntervalMs: 60 * 60 * 1000,
      label: LABEL,
      skipCounter: null,
      refusal: 'expected',
      run: async () => 'ran',
    });
  try {
    expect(await claim()).toBe('ran'); // wins the claim — silent either way
    expect(warns).toEqual([]);
    expect(skipLabels(infos)).toEqual([]);
    expect(debugs).toEqual([]);

    expect(await claim()).toBeUndefined(); // first REFUSAL
    expect(skipLabels(warns)).toEqual([LABEL]);
    expect(skipLabels(infos)).toEqual([]);
    expect(debugs).toEqual([]);

    expect(await claim()).toBeUndefined(); // second and third
    expect(await claim()).toBeUndefined();
    // ⛔ NOT SILENCED — silence is the failure mode this whole file exists to remove. The repeats
    // still name the same tick, just where nobody pages on it. Two of them, each carrying THIS
    // label, and each on `info` — not the level-gated `debug` that would be silent in production.
    const repeats = linesWithMsg(infos, 'tick_skipped');
    expect(repeats.length).toBe(2);
    expect(repeats.map((l) => l.label)).toEqual([LABEL, LABEL]);
    expect(repeats.map((l) => l.lvl)).toEqual(['info', 'info']);
    expect(debugs).toEqual([]);
    // …and the warn count did NOT grow. This is the assertion that reddens if `refusal` is ignored.
    expect(skipLabels(warns).length).toBe(1);
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
    console.debug = originalDebug;
    await db.delete(schedulerTicks).where(eq(schedulerTicks.key, KEY));
  }
}, 30_000);

test('⛔ NON-VACUITY — the DEFAULT refusal level still warns EVERY time', async () => {
  // Without this, making `claimTick` warn-once for everything would satisfy the test above while
  // silencing `cycle` and `audit-export`, whose ticks are 24h apart and where the SECOND refusal in
  // a day is the single most interesting line in the log.
  const { claimTick } = await import('../src/host/tick-locks');
  const { db, schedulerTicks } = await import('../src/db/client');
  const { eq } = await import('drizzle-orm');

  const KEY = `test-refusal-default:${crypto.randomUUID()}`;
  const LABEL = `[test] notable-refusal ${crypto.randomUUID()}`;
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(' '));
  const claim = (): Promise<string | undefined> =>
    claimTick({ key: KEY, minIntervalMs: 60 * 60 * 1000, label: LABEL, skipCounter: null, run: async () => 'ran' });
  try {
    await claim();
    await claim();
    await claim();
    await claim();
    expect(warns.length).toBe(3);
  } finally {
    console.warn = originalWarn;
    await db.delete(schedulerTicks).where(eq(schedulerTicks.key, KEY));
  }
}, 30_000);

/**
 * ⛔ THE ROLLOUT-COLLISION HALF, DRIVEN THROUGH THE REAL SCHEDULERS.
 *
 * `cycle-scheduler` deliberately passes `null` for its BOOT catch-up: a boot tick colliding with an
 * already-run tick happens on EVERY deploy of a multi-replica deployment, and a counter that is
 * non-zero after every rollout is a counter nobody reads. Its two siblings shipped the opposite —
 * both `budget` (7-min claim window, 15-min period) and `translation` (2-min window, 5-min period)
 * passed a real counter on their boot path, so the second replica to boot inside a rolling deploy
 * bumps `budget_tick_skipped_total` / `translation_tick_skipped_total` every single time.
 *
 * This does not read source text: it pre-claims the real key, starts the real scheduler, and reads
 * the real counter. The `run` body never executes (the claim is refused), so no LLM/OpenRouter work
 * is reachable from here.
 */
test('⛔ a boot claim refused by another replica LOGS but does NOT bump the tick counter', async () => {
  const { claimTick, TICK_LOCK, TICK_MIN_INTERVAL_MS } = await import('../src/host/tick-locks');
  const { renderMetrics } = await import('../src/host/metrics');
  const { db, schedulerTicks } = await import('../src/db/client');
  const { config } = await import('../src/config');
  const { eq, inArray } = await import('drizzle-orm');
  const { startTranslationScheduler, stopTranslationScheduler } = await import(
    '../src/host/translation-scheduler'
  );

  const counterOf = (name: string): number => {
    const m = new RegExp(`^\\w*${name} (\\d+)$`, 'm').exec(renderMetrics());
    return m ? Number(m[1]) : 0;
  };

  const warns: string[] = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(' '));
  console.log = () => {};
  const setFlag = (obj: object, key: string, v: boolean): void => {
    (obj as Record<string, boolean>)[key] = v;
  };
  const translationWas = config.translation.enabled;
  try {
    // ⛔ THE OTHER REPLICA. Take both claims first, exactly as the pod that booted one second
    // earlier in the same rolling deploy would have.
    for (const [key, ms] of [[TICK_LOCK.translation, TICK_MIN_INTERVAL_MS.translation]] as const) {
      expect(
        await claimTick({ key, minIntervalMs: ms, label: `[other-replica] ${key}`, skipCounter: null, run: async () => 'ran' }),
      ).toBe('ran');
    }
    warns.length = 0;

    const beforeTranslation = counterOf('translation_tick_skipped_total');

    setFlag(config.translation, 'enabled', true);
    startTranslationScheduler();
    // Both boot claims are fire-and-forget (`void`), so wait for their log lines rather than a
    // fixed guess. Each is one DB round-trip.
    const deadline = Date.now() + 10_000;
    while (
      Date.now() < deadline &&
      !skipLabels(warns).includes('[translation] boot drain')
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }

    // ⛔ IT STILL SAYS SO. `null` means "do not COUNT this", never "do not mention it" — the boot
    // collision is exactly what an operator needs to see when a deploy looks like it skipped work.
    // Both are `tick_skipped` events on `warn` naming the exact label their scheduler passed.
    expect(skipLabels(warns)).toContain('[translation] boot drain');

    // …and neither counter moved. This is the assertion the shipped code failed.
    expect(counterOf('translation_tick_skipped_total')).toBe(beforeTranslation);
  } finally {
    stopTranslationScheduler();
    setFlag(config.translation, 'enabled', translationWas);
    console.warn = originalWarn;
    console.log = originalLog;
    await db
      .delete(schedulerTicks)
      .where(inArray(schedulerTicks.key, [TICK_LOCK.translation]));
  }
}, 30_000);

/**
 * ⛔ THE CLAIM WINDOW MUST FOLLOW THE PERIOD THAT IS ACTUALLY CONFIGURED.
 *
 * `TICK_MIN_INTERVAL_MS.translation` (2 min) and `.budget` (7 min) were written against comments
 * asserting "scheduler fires every 5 min" / "every 15 min". Those periods are ENV-SETTABLE
 * (`TRANSLATION_INTERVAL_MIN`, `BUDGET_CHECK_INTERVAL_MIN`), so the constants asserted an invariant
 * — window strictly BELOW period — about a number they cannot see. At `TRANSLATION_INTERVAL_MIN=1`
 * the 2-min window spans two whole periods and the drainer runs at a fifth of its configured rate;
 * at `=2` it runs at half. And it is INVISIBLE: both scheduled paths pass `refusal:'expected'`, so
 * every one of those refusals is an `info` line indistinguishable from healthy leader election.
 *
 * These two drive the REAL schedulers against the REAL `scheduler_ticks` row rather than reading a
 * number out of the module: seed the row as though the previous tick ran one period + 1s ago, start
 * the scheduler, and watch whether the claim is granted (`last_run_at` moves) or refused. Under the
 * registry constant it is refused — which is the defect, stated as a measurement.
 */
async function seedTickRow(key: string, agoMs: number): Promise<Date> {
  const { db, schedulerTicks } = await import('../src/db/client');
  const at = new Date(Date.now() - agoMs);
  await db
    .insert(schedulerTicks)
    .values({ key, last_run_at: at, claimed_by: 'test-seed', updated_at: at })
    .onConflictDoUpdate({
      target: schedulerTicks.key,
      set: { last_run_at: at, claimed_by: 'test-seed', updated_at: at },
    });
  return at;
}

async function lastRunAt(key: string): Promise<Date | undefined> {
  const { db, schedulerTicks } = await import('../src/db/client');
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select().from(schedulerTicks).where(eq(schedulerTicks.key, key));
  return row?.last_run_at;
}

/** Poll until the tick row's `last_run_at` moves past `seeded`, or the deadline passes. */
async function claimGranted(key: string, seeded: Date, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const now = await lastRunAt(key);
    if (now && now.getTime() > seeded.getTime() + 1_000) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

test('⛔ translation: a 1-minute configured period is NOT suppressed by the 2-minute registry constant', async () => {
  const { TICK_LOCK, TICK_MIN_INTERVAL_MS } = await import('../src/host/tick-locks');
  const { db, schedulerTicks } = await import('../src/db/client');
  const { config } = await import('../src/config');
  const { eq } = await import('drizzle-orm');
  const { startTranslationScheduler, stopTranslationScheduler } = await import(
    '../src/host/translation-scheduler'
  );

  // ⛔ NON-VACUITY: the whole discrimination is that 61s sits INSIDE the registry constant's window
  // and OUTSIDE the configured period. If that ever stops holding, this test proves nothing.
  const AGO_MS = 61_000;
  expect(AGO_MS).toBeLessThan(TICK_MIN_INTERVAL_MS.translation);
  expect(AGO_MS).toBeGreaterThan(60_000); // one configured period (TRANSLATION_INTERVAL_MIN=1)

  const enabledWas = config.translation.enabled;
  const intervalWas = config.translation.intervalMinutes;
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    (config.translation as unknown as Record<string, unknown>).enabled = true;
    (config.translation as unknown as Record<string, unknown>).intervalMinutes = 1;
    const seeded = await seedTickRow(TICK_LOCK.translation, AGO_MS);

    startTranslationScheduler();
    // Granted ⇒ the scheduler asked for a window shorter than its own 60s period.
    // Refused ⇒ it asked for the 120s registry constant and starved its own next tick.
    expect(await claimGranted(TICK_LOCK.translation, seeded)).toBe(true);
  } finally {
    stopTranslationScheduler();
    console.log = originalLog;
    console.warn = originalWarn;
    (config.translation as unknown as Record<string, unknown>).enabled = enabledWas;
    (config.translation as unknown as Record<string, unknown>).intervalMinutes = intervalWas;
    await db.delete(schedulerTicks).where(eq(schedulerTicks.key, TICK_LOCK.translation));
  }
}, 30_000);

/**
 * ⛔ THE OTHER TWO HALVES OF THE SAME INVARIANT, WHICH THE TWO TESTS ABOVE CANNOT SEE.
 *
 * (a) NO REGRESSION AT THE DEFAULT PERIOD — at 5 min / 15 min the derived window must be exactly
 *     today's registry entry, so nothing about the shipped cadence changes. A fix that narrowed
 *     every window to "period − 1s" would pass the two tests above while silently widening the
 *     window `translation` has always run with from 2 min to 4m59s.
 * (b) STRICTLY BELOW, AT EVERY LEGAL PERIOD — including the 1-minute floor both schedulers clamp
 *     to (`msUntilNextDrain` / `msUntilNextCheck` both do `Math.max(1, minutes)`), and including
 *     the exact values that make the old constants degenerate (2 min for translation, 7 for budget).
 */
test('⛔ tickClaimWindowMs: registry value at the default period, strictly below the period at every other', async () => {
  const { tickClaimWindowMs, TICK_MIN_INTERVAL_MS } = await import('../src/host/tick-locks');
  const { msUntilNextDrain } = await import('../src/host/translation-scheduler');

  // (a) defaults are byte-identical to the registry — no behaviour change on the shipped config.
  expect(tickClaimWindowMs(msUntilNextDrain(5), TICK_MIN_INTERVAL_MS.translation)).toBe(
    TICK_MIN_INTERVAL_MS.translation,
  );

  // (b) strictly below the period, at every legal configured period on both schedulers — including
  // 0 and negatives, which both clamp to the 1-minute floor.
  for (const minutes of [-5, 0, 1, 2, 3, 5, 7, 15, 60]) {
    const drain = msUntilNextDrain(minutes);
    expect(tickClaimWindowMs(drain, TICK_MIN_INTERVAL_MS.translation)).toBeLessThan(drain);
  }

  // …and never WIDER than the registry ceiling, which is what keeps those constants live rather
  // than decorative: they still decide the window whenever the period is long enough.
  expect(tickClaimWindowMs(msUntilNextDrain(60), TICK_MIN_INTERVAL_MS.translation)).toBe(
    TICK_MIN_INTERVAL_MS.translation,
  );
});
