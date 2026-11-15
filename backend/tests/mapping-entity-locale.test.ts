// tests/mapping-entity-locale.test.ts — an ontology entity has ONE name in the reader's language,
// whichever screen reaches it. Drives the real queries against the seeded Postgres.
//
// ⛔ THE DEFECT. `compileEffective` has joined `content_translations` since 3.7, so /ontology showed
// the tenant's own entity as "Tussenpersoon-notitie". The challenge-detail chips
// ("This challenge involves: …") reach the SAME row by a different road —
// routes/challenges.ts → resolveChallengeEntities → listMappings — and that road selected
// `ontology_entities.label` raw: `grep -n locale src/datasets/mapping-service.ts` returned nothing.
// One row, two languages, two screens, in one product.
//
// ⚠️ WHY THIS IS A BACKEND TEST AND NOT A BROWSER WALK. The chips render only for a dataset with a
// CONFIRMED mapping (challenge-data-service.ts:88 `if (!m.confirmed) continue`). Nothing in the
// product's demo data guarantees one, so an absent chip row on screen is consistent with the bug,
// with the fix, and with there being no mapping at all — it proves nothing either way. The query is
// the thing under test, so the query is what gets exercised.
//
// The assertions are POSITIVE — "is Schadeclaim", never "is not Claim". A guard that only rules
// English out is satisfied by a blank string, by a null, and by an empty result set.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, eq, inArray, like, isNull } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerChallengeRoutes } from '../src/routes/challenges';
import { registerDatasetRoutes } from '../src/routes/datasets';
import { seedOntology } from '../src/db/seed-ontology';
import { seedOntologyI18n } from '../src/db/seed-ontology-i18n';
import { upsertTranslation } from '../src/db/translations';
import {
  db, users, tenants, challenges, challengeDatasets, datasets, datasetMappings,
  ontologyEntities, contentTranslations,
} from '../src/db/client';
import { listMappings } from '../src/datasets/mapping-service';
import { resolveChallengeEntities } from '../src/challenges/challenge-data-service';
import {
  ONTOLOGY_ENTITY_TENANT_I18N, entityKey, tenantEntityI18nId,
} from '../src/ontology/ontology-service';
import type { User } from '../src/types';

const ORG = '00000000-0000-0000-0000-00000e100001';
const OTHER = '00000000-0000-0000-0000-00000e100002';
const CREATOR_ID = '00000000-0000-0000-0000-00000e10ad01';
const creator: User = { id: CREATOR_ID, email: 'mel-creator@test', name: 'Mel Creator', roles: ['employee'], tenantId: ORG };

const MARK = 'ZMELTEST';
const SLUG = 'mel-claims';
/** A tenant-authored entity, so pass 2 of the localization (org-isolated keys) is exercised too. */
const CUSTOM_NAME = 'ZMelBrokerNote';
const CUSTOM_KEY = entityKey({ scope: 'industry_dept', industry: 'insurance', department: 'Claims', name: CUSTOM_NAME });

function asUser(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

const router = new Router();
registerChallengeRoutes(router);
registerDatasetRoutes(router);

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

let datasetId = '';
let globalClaimId = '';
let customId = '';

async function cleanup() {
  const ids = (await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(challengeDatasets).where(inArray(challengeDatasets.challenge_id, ids));
    await db.delete(challenges).where(inArray(challenges.id, ids));
  }
  // ⚠️ BY OWNER, NOT BY THE ONE SLUG. The unconfirmed-mapping test creates a second dataset
  // (`${SLUG}-2`); scoping cleanup to `SLUG` left it behind and the `users` delete below then died
  // on `datasets_owner_id_fkey` — a red hook, reported as an unnamed failure with no file.
  const ds = (await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, CREATOR_ID))).map((r) => r.id);
  if (ds.length) {
    await db.delete(datasetMappings).where(inArray(datasetMappings.dataset_id, ds));
    await db.delete(datasets).where(inArray(datasets.id, ds));
  }
  await db.delete(contentTranslations).where(
    and(
      eq(contentTranslations.entity_type, ONTOLOGY_ENTITY_TENANT_I18N),
      inArray(contentTranslations.entity_id, [tenantEntityI18nId(ORG, CUSTOM_KEY), tenantEntityI18nId(OTHER, CUSTOM_KEY)]),
    ),
  );
  await db.delete(ontologyEntities).where(inArray(ontologyEntities.tenant_id, [ORG, OTHER]));
  await db.delete(users).where(eq(users.id, CREATOR_ID));
  await db.delete(tenants).where(inArray(tenants.id, [ORG, OTHER]));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks.
beforeAll(async () => {
  await seedOntology();
  await seedOntologyI18n(); // the nl/de entity labels this whole file asserts on
  await cleanup();
  await db.insert(tenants).values([
    { id: ORG, name: 'Mel Ins', slug: 'mel-ins', industry: 'insurance' },
    { id: OTHER, name: 'Other Ins', slug: 'mel-other-ins', industry: 'insurance' },
  ]);
  await db.insert(users).values([{ id: CREATOR_ID, email: creator.email, name: creator.name, tenant_id: ORG }]);

  const [ds] = await db.insert(datasets).values({
    owner_id: CREATOR_ID, tenant_id: ORG, name: 'Mel Claims', slug: SLUG,
    source_type: 'json', columns: [{ name: 'clm_amt', type: 'number' }], row_count: 3,
  }).returning({ id: datasets.id });
  datasetId = ds!.id;

  // The GLOBAL insurance Claim — scope `industry`, natural key `industry:insurance::Claim`.
  // ⚠️ SELECTED BY SCOPE, not just (name, industry): the insurance overlay ships TWO Claim rows
  // (the industry-wide one and the `industry_dept:insurance:Claims` Claims-desk view, labelled
  // "Claim (Claims desk)"), so a `.limit(1)` on name+industry alone picks a coin-flip and this
  // file's expected strings would flap between "Schadeclaim" and "Schadeclaim (schadeafdeling)".
  const [claim] = await db
    .select({ id: ontologyEntities.id })
    .from(ontologyEntities)
    .where(and(
      eq(ontologyEntities.name, 'Claim'),
      eq(ontologyEntities.industry, 'insurance'),
      eq(ontologyEntities.scope, 'industry'),
      isNull(ontologyEntities.tenant_id),
    ));
  globalClaimId = claim!.id;

  // A tenant-authored entity + its org-isolated nl translation (localization pass 2).
  const [custom] = await db.insert(ontologyEntities).values({
    scope: 'industry_dept', industry: 'insurance', department: 'Claims',
    name: CUSTOM_NAME, label: 'Mel Broker Note', tenant_id: ORG,
  }).returning({ id: ontologyEntities.id });
  customId = custom!.id;
  await upsertTranslation(ONTOLOGY_ENTITY_TENANT_I18N, tenantEntityI18nId(ORG, CUSTOM_KEY), 'nl', 'label', 'Mel-tussenpersoonnotitie');

  // Both mappings CONFIRMED — the chips exist only for confirmed ones.
  await db.insert(datasetMappings).values([
    { dataset_id: datasetId, entity_id: globalClaimId, industry: 'insurance', department: 'Claims', column_map: { clm_amt: 'amount' }, confidence: 0.95, source: 'human', confirmed: true },
    { dataset_id: datasetId, entity_id: customId, industry: 'insurance', department: 'Claims', column_map: {}, confidence: 0.9, source: 'human', confirmed: true },
  ]);
  asUser(creator);
}, 60_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Non-vacuity first: if the seeded en and nl labels were the same string, every assertion below
// would be satisfiable by a function that does nothing at all.
test('the fixture is capable of showing the defect: en and nl labels genuinely differ', async () => {
  const en = await listMappings(datasetId);
  expect(en).toHaveLength(2);
  const enGlobal = en.find((m) => m.entityName === 'Claim')!;
  const enCustom = en.find((m) => m.entityName === CUSTOM_NAME)!;
  expect(enGlobal.entityLabel).toBe('Claim');
  expect(enCustom.entityLabel).toBe('Mel Broker Note');

  const nl = await listMappings(datasetId, db, { locale: 'nl', tenantId: ORG });
  expect(nl.find((m) => m.entityName === 'Claim')!.entityLabel).not.toBe(enGlobal.entityLabel);
  expect(nl.find((m) => m.entityName === CUSTOM_NAME)!.entityLabel).not.toBe(enCustom.entityLabel);
});

test('listMappings resolves a GLOBAL entity label through content_translations', async () => {
  const nl = await listMappings(datasetId, db, { locale: 'nl', tenantId: ORG });
  expect(nl.find((m) => m.entityName === 'Claim')!.entityLabel).toBe('Schadeclaim');

  const de = await listMappings(datasetId, db, { locale: 'de', tenantId: ORG });
  expect(de.find((m) => m.entityName === 'Claim')!.entityLabel).toBe('Schadenfall');
});

test('listMappings resolves a TENANT-authored entity label, isolated per org', async () => {
  const mine = await listMappings(datasetId, db, { locale: 'nl', tenantId: ORG });
  expect(mine.find((m) => m.entityName === CUSTOM_NAME)!.entityLabel).toBe('Mel-tussenpersoonnotitie');

  // ⛔ The other org's translations are a different key space. Asking as OTHER must fall back to
  // the en base column, never leak this org's word — that is what pass 2's tenant-scoped id buys.
  const theirs = await listMappings(datasetId, db, { locale: 'nl', tenantId: OTHER });
  expect(theirs.find((m) => m.entityName === CUSTOM_NAME)!.entityLabel).toBe('Mel Broker Note');
  // …and with no tenant at all (the agent/MCP shape), likewise.
  const anon = await listMappings(datasetId, db, { locale: 'nl' });
  expect(anon.find((m) => m.entityName === CUSTOM_NAME)!.entityLabel).toBe('Mel Broker Note');
  // The GLOBAL one still localizes in all three cases — a tenant miss must not disable pass 1.
  expect(theirs.find((m) => m.entityName === 'Claim')!.entityLabel).toBe('Schadeclaim');
  expect(anon.find((m) => m.entityName === 'Claim')!.entityLabel).toBe('Schadeclaim');
});

test('the default call is byte-for-byte what it always was — the MCP + delivery callers are untouched', async () => {
  // `listMappings(id)` and `listMappings(id, db)` are the two existing shapes (routes/datasets.ts,
  // ai/mcp/tools.ts). Both must still hand back the en base column.
  for (const rows of [await listMappings(datasetId), await listMappings(datasetId, db)]) {
    expect(rows.find((m) => m.entityName === 'Claim')!.entityLabel).toBe('Claim');
    expect(rows.find((m) => m.entityName === CUSTOM_NAME)!.entityLabel).toBe('Mel Broker Note');
  }
  // An explicit en is the same thing.
  const en = await listMappings(datasetId, db, { locale: 'en', tenantId: ORG });
  expect(en.find((m) => m.entityName === 'Claim')!.entityLabel).toBe('Claim');
});

test('entityName stays canonical en in every locale — it is a concept id, not prose', async () => {
  const nl = await listMappings(datasetId, db, { locale: 'nl', tenantId: ORG });
  expect(nl.map((m) => m.entityName).sort()).toEqual(['Claim', CUSTOM_NAME].sort());
  // The mapping's own cell columns are untouched too.
  expect(nl.every((m) => m.industry === 'insurance' && m.department === 'Claims')).toBe(true);
});

test('the natural key is built from the ENTITY’s columns, not the mapping’s cell', async () => {
  // ⛔ THE SUBTLE WAY THIS FIX BREAKS. `dataset_mappings` carries its own industry/department —
  // the cell the mapping was made IN — and they need not match where the entity is DECLARED. Key
  // off those and the lookup silently misses, leaving en on screen while every other test here
  // stays green. This mapping records the entity in the `Claims` cell; the global Claim is
  // declared industry-wide (department NULL), so the two disagree by construction.
  const [row] = await db
    .select({ industry: datasetMappings.industry, department: datasetMappings.department })
    .from(datasetMappings)
    // ⚠️ Scoped to THIS dataset: other suites (and the demo seed) map the same global Claim from
    // their own datasets, and an unscoped `[row]` picked whichever the planner returned first.
    .where(and(eq(datasetMappings.dataset_id, datasetId), eq(datasetMappings.entity_id, globalClaimId)));
  const [ent] = await db
    .select({ industry: ontologyEntities.industry, department: ontologyEntities.department })
    .from(ontologyEntities)
    .where(eq(ontologyEntities.id, globalClaimId));
  expect(row!.department).toBe('Claims');
  expect(ent!.department).toBeNull(); // they disagree — so the assertion below discriminates
  const nl = await listMappings(datasetId, db, { locale: 'nl', tenantId: ORG });
  expect(nl.find((m) => m.entityName === 'Claim')!.entityLabel).toBe('Schadeclaim');
});

test('resolveChallengeEntities returns the reader’s words, and en by default', async () => {
  asUser(creator);
  const created = await call('POST', '/api/challenges', {
    title: `${MARK} involves`,
    description: 'x',
    work_area: 'Claims',
    datasets: [{ slug: SLUG }],
  });
  expect(created.status).toBe(201);
  const challengeId = created.json.id as string;

  // Default (delivery/agent shape) — canonical en.
  expect(await resolveChallengeEntities(challengeId, ORG)).toEqual(
    expect.arrayContaining(['Claim', 'Mel Broker Note']),
  );
  // Dutch — the words a Dutch reader must see on the chips.
  const nl = await resolveChallengeEntities(challengeId, ORG, undefined, 'nl');
  expect(nl).toEqual(expect.arrayContaining(['Schadeclaim', 'Mel-tussenpersoonnotitie']));
});

test('GET /api/challenges/:id honours Accept-Language on the involves chips', async () => {
  // The end of the road the defect actually travelled: routes/challenges.ts:505 negotiated the
  // locale one line BELOW this call, so the chips were resolved in en before a locale existed.
  asUser(creator);
  const created = await call('POST', '/api/challenges', {
    title: `${MARK} route`,
    description: 'x',
    work_area: 'Claims',
    datasets: [{ slug: SLUG }],
  });
  const id = created.json.id as string;

  const en = await call('GET', `/api/challenges/${id}`);
  expect(en.status).toBe(200);
  expect(en.json.involves).toEqual(expect.arrayContaining(['Claim', 'Mel Broker Note']));

  const nl = await call('GET', `/api/challenges/${id}`, undefined, { 'accept-language': 'nl-NL,nl;q=0.9,en;q=0.8' });
  expect(nl.status).toBe(200);
  expect(nl.json.involves).toEqual(expect.arrayContaining(['Schadeclaim', 'Mel-tussenpersoonnotitie']));
  // Same shape on the wire — a `string[]`, not a widened object. The chips render `{ent}` directly.
  expect(Array.isArray(nl.json.involves)).toBe(true);
  expect(nl.json.involves.every((e: unknown) => typeof e === 'string')).toBe(true);
  expect(nl.json.involves).toHaveLength(en.json.involves.length);
});

test('an UNCONFIRMED mapping still contributes nothing — the fix did not widen the chip set', async () => {
  const [ds2] = await db.insert(datasets).values({
    owner_id: CREATOR_ID, tenant_id: ORG, name: 'Mel Claims 2', slug: `${SLUG}-2`,
    source_type: 'json', columns: [{ name: 'pol_no', type: 'string' }], row_count: 1,
  }).returning({ id: datasets.id });
  await db.insert(datasetMappings).values({
    dataset_id: ds2!.id, entity_id: globalClaimId, industry: 'insurance', department: 'Claims',
    // `mapping_source` is the two-value enum ('auto','human') — an unconfirmed row is `auto`.
    column_map: {}, confidence: 0.9, source: 'auto', confirmed: false,
  });
  asUser(creator);
  const created = await call('POST', '/api/challenges', {
    title: `${MARK} unconfirmed`, description: 'x', work_area: 'Claims',
    datasets: [{ slug: `${SLUG}-2` }],
  });
  const nl = await resolveChallengeEntities(created.json.id, ORG, undefined, 'nl');
  expect(nl).toEqual([]);

  await db.delete(datasetMappings).where(eq(datasetMappings.dataset_id, ds2!.id));
  await db.delete(datasets).where(eq(datasets.id, ds2!.id));
});

test('GET /api/datasets/:slug/mappings localizes entityLabel — the flow builder has a reader', async () => {
  // ⛔ THE CALLER THE FIRST PASS WRONGLY DECLARED "DELIBERATELY ENGLISH". `mappings[].entityLabel`
  // is rendered in exactly one place in the product — NodeConfigPanel.svelte:197, inside
  // `nodecfg_ontology_coverage` → nl "{mapped} van {total} kolommen gekoppeld aan {entity}". A
  // Dutch builder read "gekoppeld aan Broker Note" while /ontology said "Tussenpersoon-notitie".
  asUser(creator);
  const en = await call('GET', `/api/datasets/${SLUG}/mappings`);
  expect(en.status).toBe(200);
  expect(en.json.mappings.find((m: any) => m.entityName === 'Claim').entityLabel).toBe('Claim');

  const nl = await call('GET', `/api/datasets/${SLUG}/mappings`, undefined, { 'accept-language': 'nl' });
  expect(nl.status).toBe(200);
  const byName = (rows: any[], n: string) => rows.find((m) => m.entityName === n);
  expect(byName(nl.json.mappings, 'Claim').entityLabel).toBe('Schadeclaim');
  // The tenant-authored one too, via the org-isolated pass — `resolveTenant` supplies the tenant.
  expect(byName(nl.json.mappings, CUSTOM_NAME).entityLabel).toBe('Mel-tussenpersoonnotitie');
  // …and `entityName` is STILL the canonical id in both, because it is not prose.
  expect(byName(nl.json.mappings, 'Claim').entityName).toBe('Claim');
  // Same row count and same shape — nothing widened on the wire.
  expect(nl.json.mappings).toHaveLength(en.json.mappings.length);
});

test('the MCP tool path stays canonical en — the rule is the CONSUMER, not the route', async () => {
  // The other half of the distinction. `ai/mcp/tools.ts` calls `listMappings(d.id, ctx.db)` with no
  // options, feeding an AGENT. If someone "makes it consistent" by defaulting the locale inside
  // listMappings, this reds — which is the point: agent concept vocabulary stays en, exactly as
  // predicates and attribute names do.
  const agentShape = await listMappings(datasetId, db);
  expect(agentShape.find((m) => m.entityName === 'Claim')!.entityLabel).toBe('Claim');
  expect(agentShape.find((m) => m.entityName === CUSTOM_NAME)!.entityLabel).toBe('Mel Broker Note');
});
