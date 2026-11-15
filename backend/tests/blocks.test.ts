// tests/blocks.test.ts — Session 1 building-blocks coverage.
//  * static-scan: pure unit (no DB).
//  * route handlers: driven via in-process Request objects against the live
//    CI/dev Postgres (:5433, seeded). Auth is installed through the
//    __setAuthOverridesForTests seam (NO mock.module — house rule).
import { test, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerBlockRoutes } from '../src/routes/blocks';
import { scanBlockSource } from '../src/exec/static-scan';
import { seed } from '../src/db/seed';
import { db, buildingBlocks } from '../src/db/client';
import type { User } from '../src/types';

const TEST_SLUGS = ['test-lifecycle-block', 'test-bad-source-block', 'x-emp-block'];
async function cleanupTestBlocks() {
  await db.delete(buildingBlocks).where(inArray(buildingBlocks.slug, TEST_SLUGS));
}

const platformUser: User = {
  id: '00000000-0000-0000-0000-0000000000aa',
  email: 'plat@test',
  name: 'Plat',
  roles: ['super_admin', 'employee'],
};
const employeeUser: User = {
  id: '00000000-0000-0000-0000-0000000000bb',
  email: 'emp@test',
  name: 'Emp',
  roles: ['employee'],
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
): Promise<{ status: number; json: any }> {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const url = `http://localhost${path}`;
  const req = new Request(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await seed(); // idempotent — ensures the 12 demo blocks exist
  await cleanupTestBlocks(); // remove leftovers from a prior run
}, 30_000);
afterAll(cleanupTestBlocks, 30_000);
afterEach(() => __setAuthOverridesForTests(undefined));

// ---- static-scan (pure) ----

test('static-scan passes clean SDK-only source', () => {
  const r = scanBlockSource(
    'export default { descriptor: { inputs:{}, outputs:{}, capabilities:{} }, async run(i, ctx){ return {}; } };',
  );
  expect(r.ok).toBe(true);
  expect(r.findings).toHaveLength(0);
});

test('static-scan rejects a banned node:net import', () => {
  const r = scanBlockSource('import net from "node:net";\nexport default {};');
  expect(r.ok).toBe(false);
  expect(r.findings.some((f) => f.rule === 'banned-import')).toBe(true);
});

test('static-scan rejects global fetch and dynamic import', () => {
  const r = scanBlockSource('export default { async run(){ await fetch("x"); await import("y"); } };');
  const rules = r.findings.map((f) => f.rule);
  expect(rules).toContain('no-fetch');
  expect(rules).toContain('no-dynamic-import');
});

test('static-scan rejects a non-allowlisted import', () => {
  const r = scanBlockSource('import x from "lodash";\nexport default {};');
  expect(r.findings.some((f) => f.rule === 'import-not-allowlisted')).toBe(true);
});

// ---- list / filter ----

test('GET /api/blocks lists seeded blocks', async () => {
  asUser(employeeUser);
  const { status, json } = await call('GET', '/api/blocks');
  expect(status).toBe(200);
  expect(json.total).toBeGreaterThanOrEqual(12);
  const slugs = json.items.map((i: any) => i.slug);
  expect(slugs).toContain('read-claim-form');
});

test('GET /api/blocks?category=ai returns only AI blocks', async () => {
  asUser(employeeUser);
  const { json } = await call('GET', '/api/blocks?category=ai&sort=alpha');
  expect(json.items.length).toBeGreaterThanOrEqual(3);
  expect(json.items.every((i: any) => i.category === 'ai')).toBe(true);
});

test('GET /api/blocks?sort=usage orders by usage desc', async () => {
  asUser(employeeUser);
  const { json } = await call('GET', '/api/blocks?sort=usage');
  const usages = json.items.map((i: any) => i.usage_count);
  const sorted = [...usages].sort((a, b) => b - a);
  expect(usages).toEqual(sorted);
});

test('GET /api/blocks/:slug returns full detail + versions', async () => {
  asUser(employeeUser);
  const { status, json } = await call('GET', '/api/blocks/read-claim-form');
  expect(status).toBe(200);
  expect(json.slug).toBe('read-claim-form');
  expect(Array.isArray(json.versions)).toBe(true);
  expect(json.versions[0].descriptor.inputs.file).toBeDefined();
});

test('GET unknown slug → 404', async () => {
  asUser(employeeUser);
  const { status, json } = await call('GET', '/api/blocks/does-not-exist');
  expect(status).toBe(404);
  expect(json.error).toBe('block_not_found');
});

// ---- write authz ----

test('POST /api/blocks as employee → 403 (super_admin-only)', async () => {
  asUser(employeeUser);
  const { status } = await call('POST', '/api/blocks', {
    slug: 'x-emp-block',
    name: 'x',
    category: 'logic',
  });
  expect(status).toBe(403);
});

// ---- create → version → publish lifecycle ----

const lifecycleSlug = 'test-lifecycle-block';

test('full lifecycle: create → save draft → new version → publish', async () => {
  asUser(platformUser);

  // create (initial draft 0.1.0)
  const create = await call('POST', '/api/blocks', {
    slug: lifecycleSlug,
    name: 'Test Lifecycle',
    description: 'temp',
    category: 'logic',
    source_ts: 'export default { async run(){ return {}; } };',
  });
  expect(create.status).toBe(201);
  expect(create.json.version.version).toBe('0.1.0');
  expect(create.json.version.status).toBe('draft');

  // duplicate slug → 409
  const dup = await call('POST', '/api/blocks', {
    slug: lifecycleSlug,
    name: 'dup',
    category: 'logic',
  });
  expect(dup.status).toBe(409);

  // save the draft (set clean source)
  const save = await call('PATCH', `/api/blocks/${lifecycleSlug}/versions/0.1.0`, {
    source_ts: 'export default { descriptor:{inputs:{},outputs:{},capabilities:{}}, async run(){ return {ok:true}; } };',
    docs_md: '# test',
  });
  expect(save.status).toBe(200);
  expect(save.json.docs_md).toBe('# test');

  // Phase 2-B: publishing to stable requires at least one passing test.
  const t = await call('POST', `/api/blocks/${lifecycleSlug}/tests`, {
    name: 'returns ok',
    inputs: {},
    expected: { ok: true },
    assert_mode: 'subset',
  });
  expect(t.status).toBe(201);

  // publish 0.1.0 (gate re-runs the test → green)
  const pub = await call('POST', `/api/blocks/${lifecycleSlug}/versions/0.1.0/publish`, {});
  expect(pub.status).toBe(200);
  expect(pub.json.status).toBe('stable');
  expect(pub.json.published_at).toBeTruthy();
  expect(pub.json.tests_passing).toBe(true);

  // editing a published version → 409 not_a_draft
  const editPub = await call('PATCH', `/api/blocks/${lifecycleSlug}/versions/0.1.0`, {
    docs_md: 'nope',
  });
  expect(editPub.status).toBe(409);
  expect(editPub.json.error).toBe('not_a_draft');
  // BOTH interpolated values must reach the wire named — 'stable' here vs the publish path below.
  expect(editPub.json.details).toMatchObject({ version: '0.1.0', status: 'stable' });

  // new draft bumps patch → 0.1.1
  const newVer = await call('POST', `/api/blocks/${lifecycleSlug}/versions`, {});
  expect(newVer.status).toBe(201);
  expect(newVer.json.version).toBe('0.1.1');
  expect(newVer.json.status).toBe('draft');
}, 30_000);

test('re-publishing an already-published version is refused (409 not_a_draft)', async () => {
  asUser(platformUser);
  // Move the library forward: publish the 0.1.1 draft the lifecycle test left open.
  const forward = await call('POST', `/api/blocks/${lifecycleSlug}/versions/0.1.1/publish`, {});
  expect(forward.status).toBe(200);
  const before = await call('GET', `/api/blocks/${lifecycleSlug}`);
  const v011 = before.json.versions.find((v: { version: string }) => v.version === '0.1.1');
  expect(before.json.current_version_id).toBe(v011.id);
  const publishedAt010 = before.json.versions.find(
    (v: { version: string }) => v.version === '0.1.0',
  ).published_at;

  // `beta` skips the test gate, so re-publishing the SUPERSEDED 0.1.0 used to walk the library
  // backwards — status rewritten to beta, published_at restamped, current_version_id repointed —
  // with no tests run. saveVersionCore already refuses to touch a non-draft; publish must too.
  const republish = await call('POST', `/api/blocks/${lifecycleSlug}/versions/0.1.0/publish`, {
    status: 'beta',
  });
  expect(republish.status).toBe(409);
  expect(republish.json.error).toBe('not_a_draft');
  expect(republish.json.details).toMatchObject({ version: '0.1.0', status: 'stable' });

  const after = await call('GET', `/api/blocks/${lifecycleSlug}`);
  expect(after.json.current_version_id).toBe(v011.id);
  const v010 = after.json.versions.find((v: { version: string }) => v.version === '0.1.0');
  expect(v010.status).toBe('stable');
  expect(v010.published_at).toBe(publishedAt010);
}, 30_000);

test('a banned source is refused at CREATE, and still blocks publish when it predates the gate', async () => {
  // ⛔ THIS TEST USED TO CREATE THE BAD BLOCK THROUGH THE API AND THEN PUBLISH IT. It cannot any
  // more, and that IS the fix: `createBlockCore` now refuses the source instead of writing it and
  // leaving publish as the only thing standing between arbitrary code and the library. The test
  // keeps BOTH halves rather than losing one:
  //   (a) the new save-time refusal, and
  //   (b) the pre-existing publish gate, exercised on a row planted the way history planted them
  //       (a write that never saw a scan) — which is the only state it can still meet in the wild.
  asUser(platformUser);
  const slug = 'test-bad-source-block';
  const BAD = 'import net from "node:net";\nexport default {};';

  const refused = await call('POST', '/api/blocks', {
    slug, name: 'Bad Source', category: 'logic', source_ts: BAD,
  });
  expect(refused.status).toBe(422);
  expect(refused.json.error).toBe('lint_failed');
  // RESIDUE: refused means NOT WRITTEN, not "written and then complained about".
  const none = await db.select({ id: buildingBlocks.id }).from(buildingBlocks).where(eq(buildingBlocks.slug, slug));
  expect(none).toEqual([]);

  // (b) the publish gate, on a legacy row.
  const created = await call('POST', '/api/blocks', {
    slug, name: 'Bad Source', category: 'logic', source_ts: 'export default {};',
  });
  expect(created.status).toBe(201);
  await db.execute(sql`
    update block_versions set source_ts = ${BAD}
    where version = '0.1.0' and block_id = (select id from building_blocks where slug = ${slug} limit 1)
  `);
  const pub = await call('POST', `/api/blocks/${slug}/versions/0.1.0/publish`, {});
  expect(pub.status).toBe(422);
  expect(pub.json.error).toBe('lint_failed');
  expect(pub.json.findings.length).toBeGreaterThan(0);
});

// ---- validation ----

test('POST /api/blocks rejects a non-kebab slug (422)', async () => {
  asUser(platformUser);
  const { status, json } = await call('POST', '/api/blocks', {
    slug: 'Not Valid',
    name: 'x',
    category: 'logic',
  });
  expect(status).toBe(422);
  expect(json.error).toBe('validation');
});
