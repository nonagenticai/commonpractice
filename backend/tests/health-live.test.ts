// tests/health-live.test.ts — GET /health/live (src/routes/health.ts), the shallow LIVENESS
// endpoint from commonpractice#308.
//
// ⛔ WHAT WOULD PASS UNDER THE DEFECT, AND IS THEREFORE NOT ASSERTED ALONE. "It returns 200 and
// says live" passes against a handler that awaits a DB round trip and happens to find the database
// UP — which is every run of this suite, and every manual curl anybody will ever do. That assertion
// proves nothing about the only property the endpoint exists for: it must answer 200 while Postgres
// is DOWN, because the gitops livenessProbe NOW POINTS AT IT (gitops #3372 moved liveness and
// startup here on 2026-09-04) and a 503 there kills the pod. The happy path is asserted, but the load-bearing claim is INDEPENDENCE, and it is proved two
// ways that fail for that reason and no other:
//
//   1. RUNTIME — the handler settles before the event loop can turn. A DB round trip is I/O; I/O
//      cannot complete without at least one macrotask. So "the response is in hand before a
//      `setTimeout(…, 0)` fires" is a mechanical proof that no query was awaited, and it needs no
//      database, no mock and no injection point to establish.
//   2. STATIC — `src/db/client.ts` is unreachable from `src/routes/health.ts` through the
//      transitive import graph. This catches the case (1) cannot: a DB call added later that is
//      synchronous-looking, cached, or fire-and-forget.
//
// Neither can pass by exercising nothing: each carries an explicit NON-VACUITY control that must
// come out the OTHER way, so a broken probe (a timer that never fires, a walker that never
// recurses) reds this file instead of silently blessing everything.
//
// This file is deliberately DB-FREE and must stay that way. It is the test for the endpoint whose
// whole point is working when the database does not; making it need a database would be its own
// small joke.
//
// REVERT THAT REDS THIS:
//   • put an `await validateConnection()` in the handler → §2 (runtime) and §4 (import graph) red.
//   • change the registered path to `/healthz` → §1 and §3 red (the manifest path is a literal).
//   • return `{ ok: true }` instead of `{ status: 'live' }` → §1 reds (fr's contract, and the one
//     the gitops unblock step curls for).
//   • delete the recursion from `reachable()` → §4's second non-vacuity control reds.
import { test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { LIVENESS_PATH, PUBLIC_LIVENESS_PATH, registerLivenessRoutes } from '../src/routes/health';
import { Router } from '../src/utils/router';

const router = new Router();
registerLivenessRoutes(router);

/** The literal string `httpGet.path` carries in
 *  gitops-production/clusters/strato/services/commonpractice/deployment.yaml. Written out here on
 *  purpose rather than imported: the point is to catch the module renaming its own constant. */
const MANIFEST_PATH = '/health/live';

/** The literal the EXTERNAL prober targets, via `commonpractice-app.nonagentic.ai/api/health/live`
 *  (gitops-production scripts/host-configs/air/external-probe.sh). Written out for the same
 *  reason as MANIFEST_PATH: renaming the module's own constant must red this file, not silently
 *  retarget a probe that pages a human. The `/api/` prefix is load-bearing — it is the ONLY prefix
 *  `commonpractice-public-vs` routes to the backend; a bare path reaches the SPA catch-all. */
const EXTERNAL_PROBE_PATH = '/api/health/live';

function handlerFor(r: Router, method: string, path: string) {
  const matched = r.match(method, path);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  return () => matched.handler(new Request(`http://localhost:8790${path}`));
}

// ── §1 the contract the kubelet and the unblock step read ───────────────────────────────────────

test('GET /health/live answers a literal 200 with {status:"live"}', async () => {
  const res = await handlerFor(router, 'GET', MANIFEST_PATH)();
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/json');
  expect(await res.json()).toEqual({ status: 'live' });
});

// ── §2 RUNTIME INDEPENDENCE: the handler never yields to the event loop ─────────────────────────

/**
 * True when `run()`'s promise settles before a `setTimeout(…, 0)` callback gets to run.
 *
 * Microtasks (a resolved promise, an `await` on one) always drain before the timer queue, so a
 * handler that returns without awaiting I/O settles with the timer still pending. Anything that
 * awaits the network or the DB — postgres-js included — cannot: it needs the loop to turn at least
 * once. This is why the probe is a TIMER and not a stopwatch: elapsed-milliseconds thresholds are
 * unfalsifiable on a fast box with a warm local database, and go flaky on a slow CI runner.
 */
async function settledBeforeTheLoopTurned(run: () => Promise<unknown>): Promise<boolean> {
  let loopTurned = false;
  const timer = setTimeout(() => {
    loopTurned = true;
  }, 0);
  await run();
  clearTimeout(timer);
  return !loopTurned;
}

test('⛔ /health/live settles without the event loop turning — it CANNOT have awaited the DB', async () => {
  expect(await settledBeforeTheLoopTurned(handlerFor(router, 'GET', MANIFEST_PATH))).toBe(true);

  // NON-VACUITY. The same probe must report `false` for a handler that DOES wait on the loop —
  // otherwise `true` above would mean "the timer never fires in this runtime", not "no I/O".
  // `setTimeout(0)` is the cheapest macrotask there is; a real query is strictly slower.
  const control = new Router();
  control.add('GET', '/control-awaits-io', async () => {
    await new Promise((r) => setTimeout(r, 0));
    return new Response('ok');
  });
  expect(
    await settledBeforeTheLoopTurned(handlerFor(control, 'GET', '/control-awaits-io')),
  ).toBe(false);
});

// ── §3 the path is the one the manifest will target, and nothing else ───────────────────────────

test('registered at exactly /health/live, and it does not shadow the deep /health', () => {
  expect(LIVENESS_PATH).toBe(MANIFEST_PATH);
  expect(router.match('GET', MANIFEST_PATH)).not.toBeNull();
  // The deep `/health` and `/ready` live in server.ts and must stay there: this module owns the
  // shallow path ONLY. If it ever registered `/health`, it would win by declaration order and
  // silently turn the READINESS probe into a literal 200 — a pod with no database would stay in
  // the Service endpoints and 500 every request instead of being depooled.
  expect(router.match('GET', '/health')).toBeNull();
  expect(router.match('GET', '/ready')).toBeNull();
  // A liveness probe is a GET. Nothing else on this path.
  expect(router.match('POST', MANIFEST_PATH)).toBeNull();
  expect(router.list().map((r) => `${r.method} ${r.template}`)).toEqual([
    `GET ${MANIFEST_PATH}`,
    `GET ${EXTERNAL_PROBE_PATH}`,
  ]);
});

// ── §3b the externally-reachable mount ──────────────────────────────────────────────────────────

test('the external-probe mount is the SAME literal 200, at the /api/ prefix the VS routes', async () => {
  expect(PUBLIC_LIVENESS_PATH).toBe(EXTERNAL_PROBE_PATH);
  // ⛔ The prefix is the whole point. Measured against the real public host on 2026-09-04: a bare
  // /health/live returns 404 with the SPA's HTML because commonpractice-public-vs routes only
  // `prefix: /api/` to the backend. A mount that is not under /api/ is unreachable from outside and
  // the probe would page on a 404 forever.
  expect(EXTERNAL_PROBE_PATH.startsWith('/api/')).toBe(true);
  const res = await handlerFor(router, 'GET', EXTERNAL_PROBE_PATH)();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'live' });
});

test('⛔ the external mount is shallow too — it settles without the event loop turning', async () => {
  // Same mechanical proof as §2 for the in-cluster path: I/O cannot complete without at least one
  // macrotask, so settling before a setTimeout(…,0) fires proves no query was awaited. Asserted
  // SEPARATELY from the /health/live case because the two are distinct router entries: a future
  // edit could make one of them await and leave the other's proof standing.
  let turned = false;
  setTimeout(() => {
    turned = true;
  }, 0);
  await handlerFor(router, 'GET', EXTERNAL_PROBE_PATH)();
  expect(turned).toBe(false);
});

// ── §4 STATIC INDEPENDENCE: db/client.ts is unreachable from routes/health.ts ────────────────────

const SRC = resolve(import.meta.dir, '..', 'src');
const DB_CLIENT = join(SRC, 'db', 'client.ts');

/** Resolve a relative specifier the way the repo writes them (extensionless .ts, or a directory
 *  index). Returns null when it resolves to nothing — the caller treats that as UNRESOLVED and
 *  fails, rather than skipping it: a silently-skipped specifier is an unwalked subtree, which is
 *  exactly how a "found nothing, therefore clean" check lies. */
function resolveRelative(fromDir: string, spec: string): string | null {
  const base = resolve(fromDir, spec);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && candidate.endsWith('.ts')) return candidate;
  }
  return null;
}

/**
 * Every first-party module reachable from `entry` by a relative `import`/`export … from`,
 * transitively. Bare specifiers (`zod`, `drizzle-orm`) are out of scope — none of them is the
 * database client.
 *
 * `import type` lines are walked too, deliberately. They are erased at runtime and so cannot
 * themselves cause a DB touch, which makes counting them the FAIL-CLOSED direction: the worst a
 * type-only import of `db/client` can do here is red this test and make a human look, whereas
 * excluding them buys a way for a real import to hide behind a `type` keyword added later.
 */
function reachable(entry: string): { files: Set<string>; unresolved: string[] } {
  const files = new Set<string>();
  const unresolved: string[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) continue;
    files.add(file);
    const src = readFileSync(file, 'utf8');
    // ⛔ MATCHED ON THE `from '…'` CLAUSE, NOT ON A LINE STARTING WITH `import`. A line-anchored
    // pattern misses every MULTI-LINE import — the shape this repo uses whenever a module pulls
    // more than three names — and a missed import is an unwalked subtree that reports as clean
    // rather than as unresolved. `\(?` additionally covers `await import('./x')`. It can over-match
    // (a quoted relative path inside a comment), and that is the fail-closed direction: a false
    // positive reds this test, a false negative hides a database.
    for (const m of src.matchAll(/(?:^|[\s;])(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const spec = m[1] ?? '';
      const next = resolveRelative(dirname(file), spec);
      if (next === null) unresolved.push(`${file} -> ${spec}`);
      else queue.push(next);
    }
  }
  return { files, unresolved };
}

test('⛔ db/client.ts is UNREACHABLE from routes/health.ts (the liveness handler has no DB in its graph)', () => {
  const live = reachable(join(SRC, 'routes', 'health.ts'));
  // Every specifier in this subtree resolved, so "db/client is absent" is a measured absence and
  // not a subtree the walker gave up on.
  expect(live.unresolved).toEqual([]);
  expect(live.files.has(DB_CLIENT)).toBe(false);
  // And the graph really is tiny — jsonResponse + the Router type and nothing else of substance.
  expect(live.files.size).toBeLessThan(10);

  // NON-VACUITY 1 — the walker DOES find a database import when there is one (routes/me.ts imports
  // `../db/client` directly). Without this, `false` above could mean "the walker finds nothing,
  // ever".
  expect(reachable(join(SRC, 'routes', 'me.ts')).files.has(DB_CLIENT)).toBe(true);

  // NON-VACUITY 2 — and it RECURSES. routes/metrics.ts does not import the DB itself; it reaches
  // db/client only through host/scheduler-freshness.ts, two hops out. A depth-1 walker would call
  // routes/metrics.ts clean, and would call ANY indirect DB dependency of routes/health.ts clean
  // too. Both hops are asserted so a broken recursion cannot masquerade as a clean graph.
  const metrics = reachable(join(SRC, 'routes', 'metrics.ts'));
  expect(metrics.files.has(join(SRC, 'host', 'scheduler-freshness.ts'))).toBe(true);
  expect(metrics.files.has(DB_CLIENT)).toBe(true);
});
