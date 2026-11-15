// tests/block-test-sse-scope.test.ts — the SSE block-test run must persist what it streams.
//
// ⛔ WHY THIS FILE EXISTS SEPARATELY FROM block-tests.test.ts. That file calls
// `matched.handler(req)` bare, so its handlers never have a tenant context to escape from — it
// cannot see this defect by construction. Production runs every handler inside server.ts:356's
// `withTenantDb(tenantId, () => handler(...))`, and the whole point of the bug is what happens
// AFTER that wrapper unwinds. So `call()` below reproduces server.ts's wrapper exactly, and the
// stream is drained OUTSIDE it — which is precisely when the browser drains it.
//
// THE DEFECT: routes/blocks.ts's `runVersionTests` SSE branch builds a `ReadableStream` whose
// `start()` fires a DETACHED `void (async () => …)` running `runBlockTests(...)`, then returns the
// Response. `withTenantDb`'s `finally` immediately blanks `app.current_tenant` on the reserved
// connection and `release()`s it back to the pool — while the suite is still running (each test
// spawns a sandboxed subprocess: seconds). `runBlockTests` defaults `database` to the `db` Proxy;
// the detached IIFE inherits the AsyncLocalStorage store, so the Proxy hands it that same
// released, blanked connection. For a TENANT-owned block `persist` is a no-op
// (`isGlobalBlock ? runAsSystem('tenant-parameterised', fn) : fn()`), so under the production `cp_app` role:
//   • the block_test_results INSERT fails 0057's WITH CHECK (42501), visible only as an SSE
//     `error` frame;
//   • recomputeTestsPassing's `UPDATE block_versions SET tests_passing` matches 0 rows and
//     RETURNS THE COMPUTED VALUE ANYWAY — the UI streams "1/1 passing" while the column never
//     flips and the publish gate that reads it refuses forever.
// The NON-SSE branch of the same route is correct because it `await`s inside the handler. Two
// paths through one route disagreeing is the tell.
//
// The frontend uses the SSE path (frontend/src/lib/api/blocks.ts:260 sends
// `Accept: text/event-stream`).
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerBlockRoutes } from '../src/routes/blocks';
import { recomputeTestsPassing } from '../src/blocks/test-runner';
import type { ScannedSource } from '../src/blocks/source-gate';
import { seed } from '../src/db/seed';
import {
  db,
  buildingBlocks,
  blockVersions,
  blockTestResults,
  tenants,
  users,
  withTenantDb,
  runAsSystem,
} from '../src/db/client';
import type { User } from '../src/types';

const TENANT = '00000000-0000-0000-0000-00000b5e0001';
const SLUG = 'sse-scope-doubler';

const developer: User = {
  id: '00000000-0000-0000-0000-00000b5e0de1',
  email: 'sse-dev@test',
  name: 'SSE Dev',
  roles: ['developer'],
  tenantId: TENANT,
};

const SOURCE = `export default {
  descriptor: { inputs: { x: { type: 'number', required: true } }, outputs: { doubled: { type: 'number' } }, capabilities: {} },
  async run(inputs, ctx) { return { doubled: inputs.x * 2 }; }
};`;

const router = new Router();
registerBlockRoutes(router);

/** server.ts:356's wrapper, verbatim: every handler runs inside `withTenantDb(tenantId, …)`.
 *  Returns the raw Response — the caller drains the body AFTER this has unwound, exactly as a
 *  browser does. */
async function call(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(headers ?? {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return withTenantDb(TENANT, () => matched.handler(req, ...matched.params));
}

async function callJson(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await call(method, path, body, { accept: 'application/json' });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Fixtures run as system for the reason cleanup does: they must not be subject to the thing
 *  under test. */
async function cleanup() {
  await runAsSystem('boot-seed', async () => {
    await db.delete(buildingBlocks).where(eq(buildingBlocks.slug, SLUG));
    await db.delete(users).where(inArray(users.id, [developer.id]));
    await db.delete(tenants).where(eq(tenants.id, TENANT));
  });
}

beforeAll(async () => {
  await seed();
  await cleanup();
  await runAsSystem('boot-seed', async () => {
    await db.insert(tenants).values({ id: TENANT, name: 'SSE Scope', slug: 'sse-scope-tenant' });
    await db
      .insert(users)
      .values({ id: developer.id, email: developer.email, name: developer.name, tenant_id: TENANT })
      .onConflictDoNothing();
  });
  __setAuthOverridesForTests({ validateAuth: async () => developer });
  const created = await callJson('POST', '/api/blocks', {
    slug: SLUG,
    name: 'SSE Scope Doubler',
    category: 'logic',
    source_ts: SOURCE,
    descriptor: {
      inputs: { x: { type: 'number', required: true } },
      outputs: { doubled: { type: 'number' } },
      capabilities: {},
    },
  });
  expect(created.status).toBe(201);
  // The block must really be TENANT-owned: `persist`'s runAsSystem escape hatch only applies to
  // global blocks, and a global block would mask the whole defect.
  expect(created.json.block.tenant_id).toBe(TENANT);
  const added = await callJson('POST', `/api/blocks/${SLUG}/tests`, {
    name: 'doubles 5',
    inputs: { x: 5 },
    expected: { doubled: 10 },
    assert_mode: 'subset',
  });
  expect(added.status).toBe(201);
}, 120_000);
afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 30_000);
afterEach(() => __setAuthOverridesForTests({ validateAuth: async () => developer }));

/** Read the whole SSE body and split it into `event:` names + parsed payloads. */
async function drainSse(res: Response): Promise<{ event: string; data: any }[]> {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((b) => b.trim() !== '')
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
      const raw = /^data: (.*)$/m.exec(block)?.[1] ?? '{}';
      return { event, data: JSON.parse(raw) };
    });
}

/** What the database ACTUALLY holds, read as system so an RLS-hidden row is still visible —
 *  otherwise "the row was never written" and "the row is invisible to me" look the same. */
async function persisted() {
  return runAsSystem('platform-admin', async () => {
    const [block] = await db.select().from(buildingBlocks).where(eq(buildingBlocks.slug, SLUG));
    const [version] = await db
      .select()
      .from(blockVersions)
      .where(eq(blockVersions.block_id, block!.id));
    const results = await db
      .select()
      .from(blockTestResults)
      .where(eq(blockTestResults.version_id, version!.id));
    return { testsPassing: version!.tests_passing, results };
  });
}

test('the SSE test run persists results and flips tests_passing, exactly like the JSON branch', async () => {
  const res = await call('POST', `/api/blocks/${SLUG}/versions/0.1.0/test`, undefined, {
    accept: 'text/event-stream',
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/event-stream');

  const frames = await drainSse(res);

  // 1. The run itself must not have died. `runVersionTests`'s catch converts any throw into an
  //    `error` frame, which is the ONLY server-side trace of a detached failure.
  const errorFrame = frames.find((f) => f.event === 'error');
  expect(errorFrame?.data?.message ?? null).toBeNull();

  // 2. Non-vacuity: the suite really ran and really passed, so there IS something to persist.
  //    Without this, a run that produced nothing would satisfy "no error frame" trivially.
  const summary = frames.find((f) => f.event === 'summary')?.data;
  expect(summary).toBeDefined();
  expect(summary.total).toBe(1);
  expect(summary.passed).toBe(1);
  expect(summary.testsPassing).toBe(true);

  // 3. THE DEFECT. The stream said "1/1 passing"; the database has to agree.
  const after = await persisted();
  expect(after.results).toHaveLength(1);
  expect(after.results[0]!.status).toBe('pass');
  // `recomputeTestsPassing` returns the computed value whether or not its UPDATE matched a row, so
  // the summary frame above cannot witness this — only the column can.
  expect(after.testsPassing).toBe(true);
}, 120_000);

// ---- the rollup must not report a value it failed to persist ---------------------------------
//
// `recomputeTestsPassing` computes `passing`, writes it, and returns it — and it used to return it
// whether or not the write matched a row. That is the exact mechanism that let the defect above be
// silent end-to-end: every caller, including the SSE summary frame and the JSON branch, reports the
// COMPUTED value, so a 0-row UPDATE is invisible from every observation point in the product. The
// function's own docstring already described this trap (for the `isGlobal` mis-classification
// case); nothing enforced it.
//
// Induced role-independently with a version id that does not exist, which is the same `UPDATE 0`
// the blanked-GUC case produced. Without the RETURNING row-count check this call resolves to
// `false` and nothing anywhere ever learns the rollup was dropped.
test('recomputeTestsPassing THROWS when its UPDATE matches no row, instead of returning a value it never wrote', async () => {
  const ghost = '00000000-0000-0000-0000-00000b5e9999';
  await expect(
    runAsSystem('platform-admin', () => recomputeTestsPassing(ghost, ghost, db, false)),
  ).rejects.toThrow(/matched 0 block_versions rows/);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⛔ WHAT THE `error` FRAME CARRIES, AND WHY THE BAG IS NOT OPTIONAL.
//
// The frame used to carry `message` alone, so the browser had one line of backend English and no
// way to tell a 402 licence refusal from a 500 infrastructure fault; `code`/`status` were added for
// that. `details` is the third of the same `HttpError`'s own fields and it was left behind — which
// looks harmless until you notice WHICH refusal reaches this catch first.
//
// `runBlockTests` calls `assertRunnableSource` BEFORE the first test (test-runner.ts:605), and for
// a DRAFT that is `assertBlockSourceSafe` → `unprocessable('lint_failed', 'Block failed lint',
// { findings })` (source-gate.ts:75). The ENTIRE actionable content of that refusal is in the bag:
// the browser's `lint_failed` entry (frontend error-message.ts:757) is `lintTranscript(details)` and
// returns `null` without it, dropping a Dutch author back onto the English `Block failed lint`.
// `code` and `status` cannot substitute — they say which sentence, not what it says.
//
// ⚠️ THE FRONTEND CANNOT ASSERT THIS. `blocks.stream-tests-terminal.test.ts` hand-builds the frame,
// so it proves the client LIFTS a bag that is present; only this side can prove one is put there.
// That split is the same one `error-message.wire.test.ts`'s header is about.
test('⛔ an `error` frame carries the HttpError’s `details`, not just `code`/`status`', async () => {
  const original = await runAsSystem('platform-admin', async () => {
    const [block] = await db.select().from(buildingBlocks).where(eq(buildingBlocks.slug, SLUG));
    const [version] = await db
      .select()
      .from(blockVersions)
      .where(eq(blockVersions.block_id, block!.id));
    // The gate only refuses a DRAFT — if this fixture were ever published the case below would pass
    // vacuously by never reaching the throw.
    expect(version!.status, 'the fixture version is not a draft — the source gate would not run').toBe(
      'draft',
    );
    await db
      .update(blockVersions)
      // ⚠️ THE CAST IS THE POINT OF THE FIXTURE, NOT A SHORTCUT. `source_ts` is branded
      // `ScannedSource`, so the ONLY way to hold a banned source is to bypass the gate — which is
      // exactly the row this test needs to exist: a draft written before the gate, or by a seeder.
      .set({
        source_ts:
          `export default { descriptor: { inputs: {}, outputs: {}, capabilities: {} }, async run() { await fetch('https://example.test'); return {}; } };` as ScannedSource,
      })
      .where(eq(blockVersions.id, version!.id));
    return { id: version!.id, source: version!.source_ts };
  });

  try {
    const res = await call('POST', `/api/blocks/${SLUG}/versions/0.1.0/test`, undefined, {
      accept: 'text/event-stream',
    });
    expect(res.status).toBe(200);
    const frames = await drainSse(res);
    const frame = frames.find((f) => f.event === 'error');
    expect(frame, 'the banned source did not refuse the run at all').toBeDefined();

    // The two fields the previous commit added — asserted so a regression in either is not read as
    // a regression in `details`.
    expect(frame!.data.status).toBe(422);
    expect(frame!.data.code).toBe('lint_failed');
    // The English stays on the wire byte for byte; three non-browser readers depend on it.
    expect(frame!.data.message).toBe('Block failed lint');

    // ⛔ THE BAG. Nested under `details`, the same key `utils/http.ts:161-168` uses on a JSON error
    // body, so the client lifts it with the same `detailsFrom(body)` every `unwrap` uses.
    const findings = frame!.data.details?.findings;
    expect(
      Array.isArray(findings),
      'the frame dropped `details` — the browser localizes `lint_failed` into nothing and prints ' +
        'the English `Block failed lint`',
    ).toBe(true);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].source).toBe('scan');
    // `message` is what `lintTranscript` joins and interpolates — an entry without one contributes
    // nothing and the transcript would be `null` again.
    expect(typeof findings[0].message).toBe('string');
    expect(findings.map((f: any) => f.rule)).toContain('no-fetch');
  } finally {
    await runAsSystem('platform-admin', () =>
      db.update(blockVersions).set({ source_ts: original.source }).where(eq(blockVersions.id, original.id)),
    );
  }
}, 120_000);
