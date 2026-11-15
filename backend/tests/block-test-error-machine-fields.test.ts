// tests/block-test-error-machine-fields.test.ts — the machine fields behind a block-run refusal
// SURVIVE THE ROUND TRIP, and a block author's own words never acquire one.
//
// ⛔ THE TRAP THIS FILE EXISTS FOR. `block_test_results.error` is a flat `text` column, and
// `routes/blocks.ts` `listTests` RE-READS it into the /block-edit list DTO on every page load. Ship
// `rule` + `detail` on the live POST response only, and the localized sentence appears the instant
// the suite runs and REVERTS TO ENGLISH ON REFRESH — silently, with every frontend render test
// green, because they build their own props. That is precisely the "green in every test, inert in
// production" shape the HEAD commit is named after. So the assertions below do not stop at the run
// response: they GET the list back and read the fields off `last_result`.
//
// ⛔ AND THE SECOND HALF IS THE DISCRIMINATOR ITSELF. `classify()` funnels a block author's own
// `throw new Error('…')` through the SAME field as the runner's refusals, and `kind` cannot tell
// them apart — `block_throw` is the DEFAULT for any error with no kind, and an author can
// `Object.assign(err, {kind:'validation'})`. What separates them is that `rule` is attached ONLY by
// a factory the block's module scope cannot reach. `author text carries no rule` is therefore a
// property of the executor, not of a heuristic, and it is asserted here against a REAL subprocess
// run rather than against a fixture.
//
// Integration: drives the block routes via in-process Request objects against the dev Postgres,
// executing real runner subprocesses. Auth via the __setAuthOverridesForTests seam (NO mock.module).
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerBlockRoutes } from '../src/routes/blocks';
import { seed } from '../src/db/seed';
import { seedPlatform } from '../src/db/seed-platform';
import { db, buildingBlocks, users, runAsSystem } from '../src/db/client';
import type { User } from '../src/types';

const SLUG = 'test-bem-refusals';
// A SECOND block whose SOURCE descriptor and STORED descriptor AGREE. See the branch-pinning tests
// at the bottom: which of the two conformance verdicts a wrong-shaped output produces depends
// entirely on whether the two descriptors diverge, and until it was pinned, one of the two branches
// looked unreachable from a browser.
const AGREE_SLUG = 'test-bem-agree';
const TEST_SLUGS = [SLUG, AGREE_SLUG];

// ⛔ THIS FILE OWNS ITS FIXTURE IDS. It used to borrow the seed's platform super_admin
// (`…0000aa`), which `blocks.test.ts`, `block-tests.test.ts`, `acting-as-scope.test.ts` and
// `licenses-admin.test.ts` also hard-code and each tear down — `tests/fixture-id-collisions.test.ts`
// is the ratchet that caught it, and it caught it across a worktree boundary where a green local
// run could not. The row is INSERTed here rather than assumed, because an audit_log write on the
// simulate path has an FK to `users` and a borrowed-but-absent id fails it silently.
const PLATFORM_ID = '00000000-0000-0000-0000-0000be0f0001';

async function cleanup() {
  await db.delete(buildingBlocks).where(inArray(buildingBlocks.slug, TEST_SLUGS));
  await runAsSystem('boot-seed', () => db.delete(users).where(inArray(users.id, [PLATFORM_ID])));
}

const platformUser: User = {
  id: PLATFORM_ID,
  email: 'plat@test',
  name: 'Plat',
  roles: ['super_admin', 'employee'],
  tenantId: PLATFORM_ID,
};

function asUser(u: User) {
  __setAuthOverridesForTests({
    validateAuth: async () => u,
    requireRole: async (_req, role) => {
      if (!u.roles.includes(role)) {
        const { UnauthorizedError } = await import('../src/types');
        throw new UnauthorizedError(`Role '${role}' required`);
      }
      return u;
    },
  });
}

const router = new Router();
registerBlockRoutes(router);

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: any }> {
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
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const JSON_ACCEPT = { accept: 'application/json' };

// `x` is declared `number, required` so an empty input config fails the DESCRIPTOR check (a
// PRODUCT refusal); `x === 13` throws the author's own Dutch sentence (an AUTHOR refusal). One
// block produces both classes, which is the point — they travel the same field.
//
// ⚠️ THE SOURCE'S OWN `doubled` IS `json`, THE STORED DESCRIPTOR'S IS `number`, DELIBERATELY. The
// runner validates outputs against the descriptor it loaded FROM THE SOURCE
// (`flow-executor.ts:156`); `test-runner.ts` re-validates against `block_versions.descriptor`. They
// are two different objects and only the second reaches the conformance site this file has to
// exercise. Declaring both as `number` makes the node itself error first, and the conformance
// branch is never entered — measured: the run reported `validation: 'doubled' must be a finite
// number` instead.
const SOURCE = `export default {
  descriptor: {
    inputs: { x: { type: 'number', required: true }, mode: { type: 'enum', enum: ['fast', 'slow'] } },
    outputs: { doubled: { type: 'json' } },
    capabilities: {}
  },
  async run(inputs, ctx) {
    if (inputs.x === 13) throw new Error('mijn eigen fout');
    if (inputs.x === 7) return { doubled: 'not a number' };
    return { doubled: inputs.x * 2 };
  }
};`;

beforeAll(async () => {
  await seed();
  await seedPlatform();
  await cleanup();
  await runAsSystem('boot-seed', () =>
    db
      .insert(users)
      .values({ id: PLATFORM_ID, email: 'bem-plat@test', name: 'Plat' })
      .onConflictDoNothing({ target: users.id }),
  );
  asUser(platformUser);
  const created = await call('POST', '/api/blocks', {
    slug: SLUG,
    name: SLUG,
    category: 'logic',
    source_ts: SOURCE,
    descriptor: {
      inputs: {
        x: { type: 'number', required: true },
        mode: { type: 'enum', enum: ['fast', 'slow'] },
      },
      outputs: { doubled: { type: 'number' } },
      capabilities: {},
    },
  });
  expect(created.status).toBe(201);

  const agreed = await call('POST', '/api/blocks', {
    slug: AGREE_SLUG,
    name: AGREE_SLUG,
    category: 'logic',
    // `doubled` is `number` in BOTH the source below and the stored descriptor.
    source_ts: `export default {
  descriptor: {
    inputs: { x: { type: 'number', required: true } },
    outputs: { doubled: { type: 'number' } },
    capabilities: {}
  },
  async run(inputs, ctx) { return { doubled: 'not a number' }; }
};`,
    descriptor: {
      inputs: { x: { type: 'number', required: true } },
      outputs: { doubled: { type: 'number' } },
      capabilities: {},
    },
  });
  expect(agreed.status).toBe(201);
}, 60_000);
afterAll(cleanup, 30_000);
afterEach(() => __setAuthOverridesForTests(undefined));

/** Create a test, run the whole suite, and return BOTH the live outcome and the RE-READ row. */
async function runAndReread(
  name: string,
  body: Record<string, unknown>,
): Promise<{ live: any; stored: any }> {
  return runAndReread2(SLUG, name, body);
}

async function runAndReread2(
  slug: string,
  name: string,
  body: Record<string, unknown>,
): Promise<{ live: any; stored: any }> {
  const SLUG = slug;
  asUser(platformUser);
  const created = await call('POST', `/api/blocks/${SLUG}/tests`, { name, ...body });
  expect(created.status).toBe(201);
  const testId = created.json.id;

  const run = await call(
    'POST',
    `/api/blocks/${SLUG}/versions/0.1.0/test?testId=${testId}`,
    undefined,
    JSON_ACCEPT,
  );
  expect(run.status).toBe(200);
  const live = run.json.results.find((r: any) => r.testId === testId);
  expect(live, `the run returned no outcome for '${name}'`).toBeDefined();

  // ⛔ THE ROUND TRIP. Not the POST response — the LIST endpoint, which re-reads
  // `block_test_results` and rebuilds `last_result`. This is the read every /block-edit page load
  // performs, and the one an in-memory-only fix leaves English.
  const list = await call('GET', `/api/blocks/${SLUG}/tests?version=0.1.0`);
  expect(list.status).toBe(200);
  const item = list.json.items.find((t: any) => t.id === testId);
  expect(item, `the list endpoint lost the test '${name}'`).toBeDefined();
  expect(item.last_result, `no last_result persisted for '${name}'`).not.toBeNull();

  await call('DELETE', `/api/blocks/${SLUG}/tests/${testId}`);
  return { live, stored: item.last_result };
}

test('⛔ a PRODUCT refusal persists its rule + detail and survives the re-read', async () => {
  // Empty inputs → `validateInputs` refuses the missing required input inside the runner, the
  // node errors with kind `validation`, and the test-runner wraps it.
  const { live, stored } = await runAndReread('missing-required-input', {
    inputs: {},
    expected: { doubled: 2 },
    assert_mode: 'subset',
  });

  expect(live.status).toBe('fail');
  // The English is UNCHANGED, byte for byte — `run_block_test` ships it to an LLM and "Fix with AI"
  // seeds a prompt with it. It is not dead weight, it is the fallback and the machine reader's copy.
  expect(live.error).toContain("missing required input 'x'");

  // The machine fields, live…
  expect(live.errorRule).toBe('test_block_errored');
  expect(live.errorDetail?.actualKind).toBe('validation');
  expect(live.errorDetail?.cause).toContain("missing required input 'x'");

  // …and after the round trip through `block_test_results`.
  expect(stored.error).toContain("missing required input 'x'");
  expect(
    stored.error_rule,
    'the rule did not survive the write — the panel reverts to English on refresh',
  ).toBe('test_block_errored');
  expect(stored.error_detail?.actualKind).toBe('validation');
  expect(stored.error_detail?.cause).toContain("missing required input 'x'");
}, 60_000);

test('⛔ a CONFORMANCE refusal persists the per-issue bag, not a joined string', async () => {
  // `x === 7` returns `{doubled: 'not a number'}` — the descriptor OUTPUT check refuses it. The old
  // wire was `conform.errors.join('; ')`, which no client can take apart.
  const { live, stored } = await runAndReread('output-shape', {
    inputs: { x: 7 },
    expected: { doubled: 14 },
    assert_mode: 'subset',
  });

  expect(live.status).toBe('fail');
  expect(live.error).toContain('output does not match the declared descriptor');
  expect(live.errorRule).toBe('test_output_not_conformant');

  const issues = stored.error_detail?.issues;
  expect(Array.isArray(issues), 'detail.issues is not an array — the join is still unrecoverable').toBe(
    true,
  );
  expect(issues).toHaveLength(1);
  expect(issues[0].rule).toBe('field_must_be_number');
  expect(issues[0].detail?.field).toBe('doubled');
  // Each nested issue keeps its OWN English too, so the recursion has a per-issue fallback.
  expect(issues[0].message).toContain('must be a finite number');
  expect(stored.error_rule).toBe('test_output_not_conformant');
}, 60_000);

test('⛔⛔ THE CRUX: a block author’s own throw carries NO rule, live and persisted', async () => {
  // `x === 13` throws 'mijn eigen fout' from INSIDE the block. It reaches `outcome.error` through
  // exactly the same field as the two refusals above. Nothing may localize it — and nothing can,
  // because the only thing that attaches a rule is a factory the author's module scope cannot see.
  const { live, stored } = await runAndReread('author-throw', {
    inputs: { x: 13 },
    expected: { doubled: 26 },
    assert_mode: 'subset',
  });

  expect(live.status).toBe('fail');
  expect(live.error).toContain('mijn eigen fout');
  // The WRAPPER around it is a product rule (the test-runner composed "kind: cause"), but the
  // author's sentence is quarantined in `cause`, which the browser renders raw.
  expect(live.errorRule).toBe('test_block_errored');
  expect(live.errorDetail?.cause).toBe('mijn eigen fout');
  expect(stored.error_detail?.cause).toBe('mijn eigen fout');

  // ⛔ AND THE INNER EVENT — what the /build run console renders — carries no rule at all.
  // Asserted through `simulate`, which returns the classified node error unwrapped.
  asUser(platformUser);
  const sim = await call('POST', `/api/blocks/${SLUG}/versions/0.1.0/simulate`, { inputs: { x: 13 } });
  expect(sim.status).toBe(200);
  expect(sim.json.status).toBe('error');
  expect(sim.json.error.message).toBe('mijn eigen fout');
  expect(
    sim.json.error.rule ?? null,
    'the author’s throw acquired a rule — it will be localized into words they never wrote',
  ).toBeNull();
}, 60_000);

test('a PRODUCT refusal reached through simulate DOES carry its rule + detail', async () => {
  // The other side of the same coin — without this the crux above is satisfied by a build that
  // attaches no rules at all.
  asUser(platformUser);
  const sim = await call('POST', `/api/blocks/${SLUG}/versions/0.1.0/simulate`, { inputs: {} });
  expect(sim.status).toBe(200);
  expect(sim.json.status).toBe('error');
  expect(sim.json.error.kind).toBe('validation');
  expect(sim.json.error.message).toContain("missing required input 'x'");
  expect(sim.json.error.rule).toBe('node_inputs_invalid');
  const issues = sim.json.error.detail?.issues;
  expect(Array.isArray(issues)).toBe(true);
  expect(issues[0].rule).toBe('input_missing_required');
  expect(issues[0].detail?.field).toBe('x');
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHICH BRANCH DOES A DESCRIPTOR-CONFORMANCE FAILURE TAKE? Both of them, and which one depends on
// something no reader would guess: whether `block_versions.descriptor` is STRICTER than the
// descriptor the source itself declares. A browser proof running an ordinary block (the two agree)
// only ever reached `test_block_errored` and reported `test_output_not_conformant` as dead copy.
// It is not dead — it is the divergent case — but the common case was rendering RAW ENGLISH inside
// a Dutch frame, which is the defect that finding really named. Both are pinned here, by execution.

test('⛔ descriptors AGREE → the NODE refuses first, and its rule + issues are RELAYED', async () => {
  // The runner validates the output against the descriptor it loaded FROM THE SOURCE
  // (flow-executor.ts), so the node errors before `runOneBlockTest` ever re-validates. The verdict
  // is therefore `test_block_errored` — and what used to happen next was the defect: `error.error`
  // was copied into `cause`, which the browser renders UNTRANSLATED because a cause is normally the
  // author's own words. Here it is OURS. The inner refusal now rides along as `detail.issues`, the
  // shape `blockTestErrorLabel` already recurses into.
  const { live, stored } = await runAndReread2(AGREE_SLUG, 'agree-shape', {
    inputs: { x: 3 },
    expected: { doubled: 6 },
    assert_mode: 'subset',
  });

  expect(live.status).toBe('fail');
  expect(live.errorRule).toBe('test_block_errored');
  expect(live.errorDetail?.actualKind).toBe('validation');
  // ⛔ THE RELAY. Without it this whole sentence renders as English inside a localized frame.
  const issues = stored.error_detail?.issues;
  expect(
    Array.isArray(issues),
    'the node’s own refusal was flattened into `cause` — the browser cannot localize it',
  ).toBe(true);
  expect(issues).toHaveLength(1);
  expect(issues[0].rule).toBe('node_outputs_invalid');
  expect(issues[0].detail?.issues[0].rule).toBe('field_must_be_number');
  expect(issues[0].detail?.issues[0].detail?.field).toBe('doubled');
  // The English is unchanged, byte for byte — it is still the fallback and the LLM reader's copy.
  expect(live.error).toContain("'doubled' must be a finite number");
});

test('⛔ the STORED descriptor is stricter → `test_output_not_conformant` really is reached', async () => {
  // The non-vacuity half. `SLUG`'s source declares `doubled: json` while its stored descriptor says
  // `number`, so the node SUCCEEDS and `runOneBlockTest`'s own conformance check is what refuses.
  // This is the only path to that verdict, and it is a real one: the two descriptors are two
  // different objects and drift is exactly what the stored one exists to catch.
  const { live } = await runAndReread2(SLUG, 'stored-stricter', {
    inputs: { x: 7 },
    expected: { doubled: 14 },
    assert_mode: 'subset',
  });
  expect(live.status).toBe('fail');
  expect(live.errorRule).toBe('test_output_not_conformant');
  expect(live.errorDetail?.issues?.[0]?.rule).toBe('field_must_be_number');
});
