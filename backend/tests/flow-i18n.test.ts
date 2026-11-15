// tests/flow-i18n.test.ts — `flow` as a first-class translatable entity.
//
// ⛔ THE DEFECT THIS FILE PINS. Measured in prod: `SELECT count(*) FROM flows` = 23,
// `SELECT count(DISTINCT entity_id) FROM content_translations WHERE entity_type='flow'` = **0**.
// The deep-i18n pipeline (Phase 2-G) had no `flow` entity type AT ALL — no backfill branch, no
// auto-enqueue on create/update, no read overlay — so every flow name and description rendered
// English in all 8 locales while `block` (24/24), `block_template` (20/20) and `challenge` (15/17)
// sat at full coverage. Nothing failed; the only symptom was prose quietly staying English, which
// is the same shape as the 608-job stall in translation-pipeline.test.ts.
//
// Covers all three sides, because any one of them alone is a no-op:
//   * WRITE  — `enqueueTranslations('flow', …)` on POST and on a prose-bearing PATCH (and NOT on
//              the autosave's graph-only PATCH, which is the overwhelming majority of them).
//   * BACKFILL — `backfillTranslations({entityType:'flow'})`, the on-ramp for the 23 existing rows.
//   * READ   — the `content_translations` overlay on the list and on the read-only viewer's detail.
//
// ⛔ AND THE ONE PLACE THE OVERLAY IS DELIBERATELY ABSENT: `GET /api/flows/:id` for the OWNER.
// That payload is the editor's load and the builder echoes `name` back on every autosave, so
// overlaying it would write the machine translation into `flows.name` and destroy the English
// source. The last test in this file is what stops a future "the overlay is incomplete" fix from
// silently turning a rendering into a data loss. See the ⛔ in routes/flows.ts `getFlow`.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerFlowRoutes } from '../src/routes/flows';
import {
  db,
  withTenantDb,
  users,
  flows,
  challenges,
  solutions,
  translationJobs,
  contentTranslations,
} from '../src/db/client';
import {
  backfillTranslations,
  sourceHash,
  TARGET_LOCALES,
} from '../src/host/translation-service';
import { ensureDemoTenant } from '../src/db/seed-platform';
import { DEMO_TENANT_ID } from '../src/config';
import { emptyGraph } from '../src/db/flow-types';
import type { User } from '../src/types';

const OWNER_ID = '00000000-0000-0000-0000-00000f118001';
const VIEWER_ID = '00000000-0000-0000-0000-00000f118002';
const USER_IDS = [OWNER_ID, VIEWER_ID];
const MARK = 'ZFLOWI18N';

const owner: User = { id: OWNER_ID, email: 'flowi18n-o@test', name: 'Ola Owner', roles: ['employee'] };
const viewer: User = { id: VIEWER_ID, email: 'flowi18n-v@test', name: 'Vic Viewer', roles: ['employee'] };

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerFlowRoutes(router);

async function call(method: string, path: string, opts: { body?: unknown; locale?: string } = {}) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.locale) headers['accept-language'] = opts.locale;
  const req = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** The flow-scoped translation jobs, as `field:locale -> source_text`. */
async function jobsFor(flowId: string): Promise<Map<string, string>> {
  const rows = await db
    .select()
    .from(translationJobs)
    .where(and(eq(translationJobs.entity_type, 'flow'), eq(translationJobs.entity_id, flowId)));
  return new Map(rows.map((r) => [`${r.field}:${r.target_locale}`, r.source_text]));
}

let ownedFlowId = '';
let publishedFlowId = '';

async function cleanup() {
  const flowIds = (
    await db.select({ id: flows.id }).from(flows).where(inArray(flows.owner_id, USER_IDS))
  ).map((r) => r.id);
  if (flowIds.length) {
    await db.delete(translationJobs).where(inArray(translationJobs.entity_id, flowIds));
    await db.delete(contentTranslations).where(inArray(contentTranslations.entity_id, flowIds));
    await db.delete(solutions).where(inArray(solutions.flow_id, flowIds));
  }
  const chIds = (
    await db.select({ id: challenges.id }).from(challenges).where(inArray(challenges.submitter_id, USER_IDS))
  ).map((r) => r.id);
  if (chIds.length) {
    await db.delete(solutions).where(inArray(solutions.challenge_id, chIds));
    await db.delete(challenges).where(inArray(challenges.id, chIds));
  }
  await db.delete(flows).where(inArray(flows.owner_id, USER_IDS));
  await db.delete(users).where(inArray(users.id, USER_IDS));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks (see flows.test.ts).
beforeAll(async () => {
  await cleanup();
  // Idempotent — a no-op on a seeded DB. Every fixture below is stamped DEMO_TENANT_ID (the flows
  // insert takes it from the `app.current_tenant` GUC), and `users.tenant_id` FKs `tenants`, so
  // without this the file cannot run against a migrated-but-unseeded database.
  await ensureDemoTenant();
  await db
    .insert(users)
    .values([
      { id: OWNER_ID, email: owner.email, name: owner.name, avatar_initials: 'OO', tenant_id: DEMO_TENANT_ID },
      { id: VIEWER_ID, email: viewer.email, name: viewer.name, avatar_initials: 'VV', tenant_id: DEMO_TENANT_ID },
    ])
    .onConflictDoNothing();
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

// ---- WRITE side ----

test('POST /api/flows auto-enqueues name + description for every target locale', async () => {
  asUser(owner);
  const created = await call('POST', '/api/flows', {
    body: { name: `${MARK} Claim summariser`, description: 'Summarises an inbound claim form.' },
  });
  expect(created.status).toBe(201);
  ownedFlowId = created.json.id as string;

  const jobs = await jobsFor(ownedFlowId);
  // 2 fields x 7 non-en locales. `en` is the base edition and is never a translation target.
  expect(jobs.size).toBe(2 * TARGET_LOCALES.length);
  expect(TARGET_LOCALES).not.toContain('en' as never);
  for (const loc of TARGET_LOCALES) {
    expect(jobs.get(`name:${loc}`)).toBe(`${MARK} Claim summariser`);
    expect(jobs.get(`description:${loc}`)).toBe('Summarises an inbound claim form.');
  }
});

test('a graph-only PATCH (the autosave) enqueues NOTHING new', async () => {
  asUser(owner);
  const before = await db
    .select({ id: translationJobs.id, updated: translationJobs.updated_at })
    .from(translationJobs)
    .where(and(eq(translationJobs.entity_type, 'flow'), eq(translationJobs.entity_id, ownedFlowId)));

  const patched = await call('PATCH', `/api/flows/${ownedFlowId}`, { body: { graph: emptyGraph() } });
  expect(patched.status).toBe(200);

  const after = await db
    .select({ id: translationJobs.id, updated: translationJobs.updated_at })
    .from(translationJobs)
    .where(and(eq(translationJobs.entity_type, 'flow'), eq(translationJobs.entity_id, ownedFlowId)));
  expect(after.length).toBe(before.length);
  // Not merely "same count" — the autosave must not RESET the rows either, which is what an
  // unguarded enqueue would do the moment a cell's source_hash ever differed.
  expect(after.map((r) => r.updated?.toISOString()).sort()).toEqual(
    before.map((r) => r.updated?.toISOString()).sort(),
  );
});

test('a rename PATCH re-queues the name cell against the NEW source text', async () => {
  asUser(owner);
  const renamed = `${MARK} Claim triage`;
  const patched = await call('PATCH', `/api/flows/${ownedFlowId}`, { body: { name: renamed } });
  expect(patched.status).toBe(200);
  expect(patched.json.name).toBe(renamed);

  const jobs = await jobsFor(ownedFlowId);
  for (const loc of TARGET_LOCALES) expect(jobs.get(`name:${loc}`)).toBe(renamed);

  const [row] = await db
    .select({ hash: translationJobs.source_hash, status: translationJobs.status })
    .from(translationJobs)
    .where(
      and(
        eq(translationJobs.entity_type, 'flow'),
        eq(translationJobs.entity_id, ownedFlowId),
        eq(translationJobs.field, 'name'),
        eq(translationJobs.target_locale, 'nl'),
      ),
    );
  expect(row!.hash).toBe(sourceHash(renamed));
  expect(row!.status).toBe('pending');
});

// ---- BACKFILL side (the on-ramp for the 23 pre-existing prod rows) ----

test("backfillTranslations({entityType:'flow'}) matches flows and queues their prose", async () => {
  // A flow written straight to the table, i.e. one that predates the auto-enqueue above.
  const [legacy] = await withTenantDb(DEMO_TENANT_ID, () =>
    db
      .insert(flows)
      .values({
        name: `${MARK} Legacy canvas`,
        description: 'Written before the pipeline knew about flows.',
        owner_id: OWNER_ID,
        tenant_id: DEMO_TENANT_ID,
        graph: emptyGraph(),
      })
      .returning(),
  );
  expect(await jobsFor(legacy!.id)).toHaveProperty('size', 0);

  const res = await withTenantDb(DEMO_TENANT_ID, () =>
    backfillTranslations({ entityType: 'flow', entityId: legacy!.id }, OWNER_ID),
  );
  expect(res.matched).toBe(1);
  expect(res.queued).toBe(2 * TARGET_LOCALES.length);

  const jobs = await jobsFor(legacy!.id);
  for (const loc of TARGET_LOCALES) {
    expect(jobs.get(`name:${loc}`)).toBe(`${MARK} Legacy canvas`);
    expect(jobs.get(`description:${loc}`)).toBe('Written before the pipeline knew about flows.');
  }
});

test('a blank description queues no description cells (it is NOT NULL DEFAULT \'\')', async () => {
  asUser(owner);
  const created = await call('POST', '/api/flows', { body: { name: `${MARK} Nameless prose` } });
  const jobs = await jobsFor(created.json.id as string);
  expect(jobs.size).toBe(TARGET_LOCALES.length); // name only
  expect(jobs.get('description:nl')).toBeUndefined();
});

// ---- READ side ----

test('GET /api/flows overlays name + description in a non-en locale', async () => {
  await db.insert(contentTranslations).values([
    { entity_type: 'flow', entity_id: ownedFlowId, locale: 'nl', field: 'name', value: 'Schadetriage' },
    { entity_type: 'flow', entity_id: ownedFlowId, locale: 'nl', field: 'description', value: 'Vat een schadeformulier samen.' },
  ]);
  asUser(owner);

  const nl = await call('GET', '/api/flows', { locale: 'nl' });
  expect(nl.status).toBe(200);
  const nlCard = nl.json.items.find((i: { id: string }) => i.id === ownedFlowId);
  expect(nlCard.name).toBe('Schadetriage');
  expect(nlCard.description).toBe('Vat een schadeformulier samen.');

  // en (and any locale with no rows) keeps the base columns.
  const en = await call('GET', '/api/flows', { locale: 'en' });
  const enCard = en.json.items.find((i: { id: string }) => i.id === ownedFlowId);
  expect(enCard.name).toBe(`${MARK} Claim triage`);
  const de = await call('GET', '/api/flows', { locale: 'de' });
  expect(de.json.items.find((i: { id: string }) => i.id === ownedFlowId).name).toBe(`${MARK} Claim triage`);
});

test('the list `q` filter matches the LOCALIZED name a Dutch reader can actually see', async () => {
  asUser(owner);
  const hit = await call('GET', '/api/flows?q=schadetriage', { locale: 'nl' });
  expect(hit.json.items.map((i: { id: string }) => i.id)).toContain(ownedFlowId);
});

test('a read-only viewer of a published flow gets the localized name', async () => {
  // The one non-owner read path: a flow that backs a published solution.
  const [flow] = await withTenantDb(DEMO_TENANT_ID, () =>
    db
      .insert(flows)
      .values({
        name: `${MARK} Published canvas`,
        description: 'The English source.',
        owner_id: OWNER_ID,
        tenant_id: DEMO_TENANT_ID,
        graph: emptyGraph(),
      })
      .returning(),
  );
  publishedFlowId = flow!.id;
  const [ch] = await db
    .insert(challenges)
    .values({
      title: `${MARK} host challenge`,
      description: 'x',
      business_impact: 'x',
      work_area: 'Claims',
      submitter_id: OWNER_ID,
      tenant_id: DEMO_TENANT_ID,
      status: 'voting',
      week: '2026-W21',
    })
    .returning();
  await db.insert(solutions).values({
    challenge_id: ch!.id,
    tenant_id: DEMO_TENANT_ID,
    title: `${MARK} host solution`,
    author_id: OWNER_ID,
    flow_id: publishedFlowId,
    published_graph: emptyGraph(),
  });
  await db.insert(contentTranslations).values([
    { entity_type: 'flow', entity_id: publishedFlowId, locale: 'nl', field: 'name', value: 'Gepubliceerd canvas' },
  ]);

  asUser(viewer);
  const nl = await call('GET', `/api/flows/${publishedFlowId}`, { locale: 'nl' });
  expect(nl.status).toBe(200);
  expect(nl.json.readOnly).toBe(true);
  expect(nl.json.name).toBe('Gepubliceerd canvas');
  // `description` has no nl row → the English base column survives.
  expect(nl.json.description).toBe('The English source.');
});

test('⛔ the OWNER\'s GET /api/flows/:id is NOT overlaid — the builder echoes `name` back on save', async () => {
  // If this ever goes green on the translated value, the next autosave (`doSave()` in
  // frontend/src/routes/build/+page.svelte sends `name: builder.flow.name` on EVERY tick) writes
  // the machine translation into `flows.name` and the English source is gone for good.
  asUser(owner);
  const nl = await call('GET', `/api/flows/${ownedFlowId}`, { locale: 'nl' });
  expect(nl.status).toBe(200);
  expect(nl.json.readOnly).toBe(false);
  expect(nl.json.name).toBe(`${MARK} Claim triage`);

  // Same for the PATCH echo, which is the value doSave() actually round-trips.
  const patched = await call('PATCH', `/api/flows/${ownedFlowId}`, {
    body: { graph: emptyGraph() },
    locale: 'nl',
  });
  expect(patched.json.name).toBe(`${MARK} Claim triage`);
});
