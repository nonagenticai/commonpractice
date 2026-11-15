// tests/challenge-datasets.test.ts — Phase 3.0 (Pillar A): the challenge → applicable-
// datasets link table + API. Drives /api/challenges against real CI Postgres :5433:
//   (a) POST with datasets persists the links; GET :id returns them + canEditDatasets;
//   (b) PATCH as the creator replaces the set; as a non-creator → 403;
//   (c) an unknown / non-owned slug → 400 (and never creates an orphan challenge);
//   (d) deleting the challenge cascade-deletes its links.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerChallengeRoutes } from '../src/routes/challenges';
import { db, users, challenges, challengeDatasets, datasets, datasetMappings, ontologyEntities, solutions } from '../src/db/client';
import { seedOntology } from '../src/db/seed-ontology';
import { buildAgentChallengeContext } from '../src/challenges/challenge-data-service';
import type { User } from '../src/types';

const CREATOR_ID = '00000000-0000-0000-0000-00000cd00001';
const STRANGER_ID = '00000000-0000-0000-0000-00000cd00002';
const creator: User = { id: CREATOR_ID, email: 'cd-creator@test', name: 'Dana Creator', roles: ['employee'], tenantId: CREATOR_ID };
const stranger: User = { id: STRANGER_ID, email: 'cd-stranger@test', name: 'Sam Stranger', roles: ['employee'], tenantId: STRANGER_ID };
const platform: User = { id: STRANGER_ID, email: 'cd-stranger@test', name: 'Sam Stranger', roles: ['employee', 'super_admin'], tenantId: STRANGER_ID };
const MARK = 'ZCDTEST';
const SLUG_A = 'cd-claims-a';
const SLUG_B = 'cd-claims-b';

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerChallengeRoutes(router);

async function call(method: string, path: string, body?: unknown) {
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

async function cleanup() {
  const ids = (await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(challengeDatasets).where(inArray(challengeDatasets.challenge_id, ids));
    await db.delete(challenges).where(inArray(challenges.id, ids));
  }
  await db.delete(datasets).where(inArray(datasets.owner_id, [CREATOR_ID, STRANGER_ID]));
  await db.delete(users).where(inArray(users.id, [CREATOR_ID, STRANGER_ID]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await seedOntology(); // idempotent — for the §B6 involves-chip test (insurance Claim entity).
  await cleanup();
  await db.insert(users).values([
    { id: CREATOR_ID, email: creator.email, name: creator.name },
    { id: STRANGER_ID, email: stranger.email, name: stranger.name },
  ]).onConflictDoNothing();
  // Two datasets owned by the creator (the challenge's data space).
  await db.insert(datasets).values([
    { owner_id: CREATOR_ID, tenant_id: CREATOR_ID, name: 'Claims A', slug: SLUG_A, source_type: 'json', columns: [{ name: 'clm_amt', type: 'number' }], row_count: 3 },
    { owner_id: CREATOR_ID, tenant_id: CREATOR_ID, name: 'Claims B', slug: SLUG_B, source_type: 'json', columns: [{ name: 'pol_no', type: 'string' }], row_count: 5 },
  ]);
  asUser(creator);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('POST with datasets persists links; GET returns them + canEditDatasets for the creator', async () => {
  asUser(creator);
  const created = await call('POST', '/api/challenges', {
    title: `${MARK} with data`,
    description: 'flag claims over the threshold',
    work_area: 'Claims',
    datasets: [{ slug: SLUG_A, note: 'the amount column is what matters' }],
  });
  expect(created.status).toBe(201);
  const id = created.json.id as string;

  const detail = await call('GET', `/api/challenges/${id}`);
  expect(detail.status).toBe(200);
  expect(detail.json.canEditDatasets).toBe(true);
  expect(detail.json.datasets).toHaveLength(1);
  expect(detail.json.datasets[0].slug).toBe(SLUG_A);
  expect(detail.json.datasets[0].name).toBe('Claims A');
  expect(detail.json.datasets[0].note).toBe('the amount column is what matters');
  expect(detail.json.datasets[0].rowCount).toBe(3);
  expect(detail.json.datasets[0].columns[0].name).toBe('clm_amt');
});

test('POST with an unknown slug is 400 and creates no orphan challenge', async () => {
  asUser(creator);
  const before = (await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK} orphan%`))).length;
  const r = await call('POST', '/api/challenges', {
    title: `${MARK} orphan`,
    description: 'should not persist',
    work_area: 'Claims',
    datasets: [{ slug: 'does-not-exist' }],
  });
  expect(r.status).toBe(400);
  const after = (await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK} orphan%`))).length;
  expect(after).toBe(before); // no challenge row left behind
});

test('PATCH as the creator replaces the dataset set', async () => {
  asUser(creator);
  const created = await call('POST', '/api/challenges', { title: `${MARK} patch`, description: 'x', work_area: 'Claims' });
  const id = created.json.id as string;

  const patched = await call('PATCH', `/api/challenges/${id}`, {
    datasets: [{ slug: SLUG_A, note: 'first' }, { slug: SLUG_B, note: 'second' }],
  });
  expect(patched.status).toBe(200);
  expect(patched.json.datasets).toHaveLength(2);

  // Replace (not append): a second PATCH with one slug leaves exactly one.
  const reduced = await call('PATCH', `/api/challenges/${id}`, { datasets: [{ slug: SLUG_B, note: 'only' }] });
  expect(reduced.json.datasets).toHaveLength(1);
  expect(reduced.json.datasets[0].slug).toBe(SLUG_B);
});

test('PATCH as a non-creator is 403; as platform is allowed', async () => {
  asUser(creator);
  const created = await call('POST', '/api/challenges', { title: `${MARK} authz`, description: 'x', work_area: 'Claims' });
  const id = created.json.id as string;

  asUser(stranger);
  const forbidden = await call('PATCH', `/api/challenges/${id}`, { datasets: [{ slug: SLUG_A }] });
  expect(forbidden.status).toBe(403);

  // Platform may edit; slugs still validate against the creator's data space.
  asUser(platform);
  const ok = await call('PATCH', `/api/challenges/${id}`, { datasets: [{ slug: SLUG_A }] });
  expect(ok.status).toBe(200);
  expect(ok.json.datasets).toHaveLength(1);

  // Non-creator GET sees datasets but cannot edit.
  asUser(stranger);
  const detail = await call('GET', `/api/challenges/${id}`);
  expect(detail.json.canEditDatasets).toBe(false);
  expect(detail.json.datasets).toHaveLength(1);
});

test('buildAgentChallengeContext lists the applicable datasets for the agent', async () => {
  asUser(creator);
  const created = await call('POST', '/api/challenges', {
    title: `${MARK} agent ctx`,
    description: 'x',
    work_area: 'Claims',
    datasets: [{ slug: SLUG_A, note: 'amount matters' }],
  });
  const id = created.json.id as string;

  const block = await buildAgentChallengeContext(id);
  expect(block).toBeTruthy();
  expect(block).toContain(SLUG_A);
  expect(block).toContain('amount matters');
  expect(block).toContain('clm_amt'); // the dataset's column is surfaced

  // No challenge / no datasets / no solutions → null (no noise injected into the prompt).
  const bare = await call('POST', '/api/challenges', { title: `${MARK} agent bare`, description: 'x', work_area: 'Claims' });
  expect(await buildAgentChallengeContext(bare.json.id as string)).toBeNull();
});

test('Phase 5B: buildAgentChallengeContext surfaces blocks used in existing solutions', async () => {
  asUser(creator);
  // A challenge with NO datasets but WITH a solution that used two blocks.
  const created = await call('POST', '/api/challenges', {
    title: `${MARK} agent solblocks`,
    description: 'x',
    work_area: 'Claims',
  });
  const id = created.json.id as string;

  await db.insert(solutions).values({
    challenge_id: id,
    tenant_id: CREATOR_ID,
    title: `${MARK} sol`,
    author_id: CREATOR_ID,
    status: 'voting',
    blocks_used: ['ai-summarize', 'if-else'],
  });

  const block = await buildAgentChallengeContext(id);
  expect(block).toBeTruthy();
  expect(block).toContain('existing solutions');
  expect(block).toContain('ai-summarize');
  expect(block).toContain('if-else');
});

test('§B6: GET involves the entities from the datasets’ confirmed mappings', async () => {
  // A confirmed (human) mapping of SLUG_A → an insurance Claim entity.
  const [claim] = await db
    .select({ id: ontologyEntities.id, label: ontologyEntities.label, name: ontologyEntities.name })
    .from(ontologyEntities)
    .where(and(eq(ontologyEntities.name, 'Claim'), eq(ontologyEntities.industry, 'insurance')))
    .limit(1);
  expect(claim).toBeDefined();
  const [ds] = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.slug, SLUG_A));
  await db.insert(datasetMappings).values({
    dataset_id: ds!.id,
    entity_id: claim!.id,
    industry: 'insurance',
    department: 'Claims',
    column_map: { clm_amt: 'amount' },
    confidence: 0.95,
    source: 'human',
    confirmed: true,
  });

  asUser(creator);
  const created = await call('POST', '/api/challenges', {
    title: `${MARK} involves`,
    description: 'x',
    work_area: 'Claims',
    datasets: [{ slug: SLUG_A }],
  });
  const detail = await call('GET', `/api/challenges/${created.json.id}`);
  expect(detail.json.involves).toContain(claim!.label || claim!.name);
});

test('deleting a challenge cascade-deletes its dataset links', async () => {
  asUser(creator);
  const created = await call('POST', '/api/challenges', {
    title: `${MARK} cascade`,
    description: 'x',
    work_area: 'Claims',
    datasets: [{ slug: SLUG_A }],
  });
  const id = created.json.id as string;
  expect((await db.select().from(challengeDatasets).where(eq(challengeDatasets.challenge_id, id)))).toHaveLength(1);

  await db.delete(challenges).where(eq(challenges.id, id));
  expect((await db.select().from(challengeDatasets).where(eq(challengeDatasets.challenge_id, id)))).toHaveLength(0);
});
