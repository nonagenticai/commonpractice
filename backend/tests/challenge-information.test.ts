// tests/challenge-information.test.ts — W8 "Information involved" on a challenge.
//
// P1: GET /api/challenges/:id/entities returns plain cards (localized label + description, no key,
//     no slug) for the types of information the challenge's sample data is CONFIRMED to be about.
// P2: the creator (or a super_admin) links types of information DIRECTLY — PUT
//     /api/challenges/:id/entities, or `entities` on POST /api/challenges — into `challenge_entities`
//     (0111). It writes the challenge only, never the ontology. A non-creator cannot edit; another
//     tenant can neither read nor link.
// P3: POST /api/challenges/entity-suggestions asks the tenant's AI, through the METERED broker,
//     with the title, the description and the option NAMES only. The captured provider request is
//     asserted to carry no sample-data value, no column name and no PII from the tenant's datasets.
//
// ⛔ EVERY CALL RUNS AS `cp_app` (withTenantDbAsRuntimeRoleForTests) — the production role. The owner
// connection bypasses RLS, so a cross-tenant assertion made as the owner passes in the WRONG
// direction (commonpractice-metering-bypass memory). The first test proves RLS is biting.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray, like, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerChallengeRoutes } from '../src/routes/challenges';
import {
  db,
  tenants,
  users,
  datasets,
  datasetMappings,
  ontologyEntities,
  challenges,
  challengeDatasets,
  challengeEntities,
  ontologyAttributes,
  contentTranslations,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import { entityKey, tenantEntityI18nId, ONTOLOGY_ENTITY_TENANT_I18N } from '../src/ontology/ontology-service';
import { __setBrokerDepsForTests } from '../src/host/llm-broker';
import type { LlmProvider, LlmRequest } from '../src/ai/llm/provider';
import { datasetRows } from '../src/db/client';
import type { User } from '../src/types';

// Ids owned by THIS FILE ONLY (tests/fixture-id-collisions.test.ts).
const T = '00000000-0000-0000-0000-00000a8c0001';
const T_OTHER = '00000000-0000-0000-0000-00000a8c0002';
const CREATOR_ID = '00000000-0000-0000-0000-00000a8c0011';
const OTHER_ID = '00000000-0000-0000-0000-00000a8c0012';
const PEER_ID = '00000000-0000-0000-0000-00000a8c0013';
const ADMIN_ID = '00000000-0000-0000-0000-00000a8c0014';
const MEMBER_ID = '00000000-0000-0000-0000-00000a8c0015';
const E_FOREIGN = '00000000-0000-0000-0000-00000a8c0023';
const E_HIDDEN = '00000000-0000-0000-0000-00000a8c0024';
const MARK = 'ZW8INFO';
const E_CLAIM = '00000000-0000-0000-0000-00000a8c0021';
const E_POLICY = '00000000-0000-0000-0000-00000a8c0022';
const DS_ID = '00000000-0000-0000-0000-00000a8c0031';
const CH_ID = '00000000-0000-0000-0000-00000a8c0041';
const SLUG = 'w8-info-claims';
const DEPT = 'W8InfoDept';

const creator: User = { id: CREATOR_ID, email: 'w8i-creator@test', name: 'W8 Creator', roles: [], tenantId: T };
const outsider: User = { id: OTHER_ID, email: 'w8i-other@test', name: 'W8 Outsider', roles: [], tenantId: T_OTHER };
// A member of the SAME tenant who did not create the challenge.
const peer: User = { id: PEER_ID, email: 'w8i-peer@test', name: 'W8 Peer', roles: ['developer'], tenantId: T };
// F1 (owner decision W8.4): a tenant_admin of the SAME tenant may link; a plain member may not.
const admin: User = { id: ADMIN_ID, email: 'w8i-admin@test', name: 'W8 Admin', roles: ['tenant_admin'], tenantId: T };
const member: User = { id: MEMBER_ID, email: 'w8i-member@test', name: 'W8 Member', roles: ['member'], tenantId: T };

const router = new Router();
registerChallengeRoutes(router);

function as(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

async function call(tenant: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  return withTenantDbAsRuntimeRoleForTests(tenant, async () => {
    const req = new Request(`http://localhost${path}`, {
      method,
      headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const res = await matched.handler(req, ...matched.params);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  });
}

const claimKey = entityKey({ scope: 'generic', industry: null, department: DEPT, name: 'W8InfoClaim' });

async function cleanup() {
  await db.execute(sql`delete from usage_events where user_id in (${CREATOR_ID}, ${OTHER_ID}, ${PEER_ID})`);
  await db.execute(sql`delete from usage_counters where user_id in (${CREATOR_ID}, ${OTHER_ID}, ${PEER_ID})`);
  await db.execute(sql`delete from audit_log where actor_id in (${ADMIN_ID}, ${MEMBER_ID})`);
  await db.delete(datasetRows).where(eq(datasetRows.dataset_id, DS_ID));
  const made = (await db.select({ id: challenges.id }).from(challenges).where(like(challenges.title, `${MARK}%`))).map((r) => r.id);
  if (made.length) await db.delete(challenges).where(inArray(challenges.id, made));
  await db.delete(challengeEntities).where(inArray(challengeEntities.tenant_id, [T, T_OTHER]));
  await db.delete(contentTranslations).where(eq(contentTranslations.entity_id, tenantEntityI18nId(T, claimKey)));
  await db.delete(challengeDatasets).where(eq(challengeDatasets.challenge_id, CH_ID));
  await db.delete(challenges).where(eq(challenges.id, CH_ID));
  await db.delete(datasetMappings).where(eq(datasetMappings.dataset_id, DS_ID));
  await db.delete(datasets).where(eq(datasets.id, DS_ID));
  await db.delete(ontologyEntities).where(inArray(ontologyEntities.id, [E_CLAIM, E_POLICY, E_FOREIGN, E_HIDDEN]));
  await db.delete(users).where(inArray(users.id, [CREATOR_ID, OTHER_ID, PEER_ID, ADMIN_ID, MEMBER_ID]));
  await db.delete(tenants).where(inArray(tenants.id, [T, T_OTHER]));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: T, name: 'W8 Info Tenant', slug: 'w8-info' },
    { id: T_OTHER, name: 'W8 Info Other', slug: 'w8-info-other' },
  ]);
  await db.insert(users).values([
    { id: CREATOR_ID, email: creator.email, name: creator.name, tenant_id: T },
    { id: OTHER_ID, email: outsider.email, name: outsider.name, tenant_id: T_OTHER },
    { id: PEER_ID, email: peer.email, name: peer.name, tenant_id: T },
    { id: ADMIN_ID, email: admin.email, name: admin.name, tenant_id: T, tenant_role: 'tenant_admin' },
    { id: MEMBER_ID, email: member.email, name: member.name, tenant_id: T },
  ]);
  await db.insert(ontologyEntities).values([
    { id: E_CLAIM, scope: 'generic', department: DEPT, name: 'W8InfoClaim', label: 'Claim', description: 'A request for payment', tenant_id: T },
    { id: E_POLICY, scope: 'generic', department: DEPT, name: 'W8InfoPolicy', label: 'Policy', description: 'An insurance contract', tenant_id: T },
    // Another tenant's own type of information: never linkable from T.
    { id: E_FOREIGN, scope: 'generic', department: DEPT, name: 'W8InfoSecret', label: 'Secret', tenant_id: T_OTHER },
    // A tombstone T wrote: hidden from T's ontology, so not linkable either.
    { id: E_HIDDEN, scope: 'generic', department: DEPT, name: 'W8InfoGone', label: 'Gone', tenant_id: T, hidden: true },
  ]);
  await db.insert(contentTranslations).values([
    { entity_type: ONTOLOGY_ENTITY_TENANT_I18N, entity_id: tenantEntityI18nId(T, claimKey), locale: 'nl', field: 'label', value: 'Schadeclaim' },
    { entity_type: ONTOLOGY_ENTITY_TENANT_I18N, entity_id: tenantEntityI18nId(T, claimKey), locale: 'nl', field: 'description', value: 'Een verzoek om uitbetaling' },
  ]);
  await db.insert(datasets).values({
    id: DS_ID, owner_id: CREATOR_ID, tenant_id: T, name: 'W8 Info Claims', slug: SLUG, source_type: 'csv',
    columns: [{ name: 'amount', type: 'number' }, { name: 'holder_email', type: 'string', pii: true }], row_count: 1,
  });
  // A real-looking sample row whose values must NEVER reach the AI (P3).
  await db.insert(datasetRows).values({ dataset_id: DS_ID, idx: 0, data: { amount: 98765, holder_email: 'anna.w8secret@x.invalid' } });
  await db.insert(datasetMappings).values([
    // CONFIRMED → Claim is "involved".
    { dataset_id: DS_ID, entity_id: E_CLAIM, industry: '', department: DEPT, column_map: { amount: 'amount' }, confirmed: true, tenant_id: T },
    // A PROPOSAL only → Policy is not.
    { dataset_id: DS_ID, entity_id: E_POLICY, industry: '', department: DEPT, column_map: {}, confirmed: false, tenant_id: T },
  ]);
  await db.insert(challenges).values({
    id: CH_ID, tenant_id: T, title: 'W8 info challenge', description: 'Claims wait four days', work_area: 'Claims',
    submitter_id: CREATOR_ID, status: 'voting', week: '2026-W42',
  });
  await db.insert(challengeDatasets).values({ challenge_id: CH_ID, dataset_slug: SLUG, added_by: CREATOR_ID });
}, 30_000);

afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('the fixture runs under RLS — the other tenant cannot see this challenge as cp_app', async () => {
  const seen = await withTenantDbAsRuntimeRoleForTests(T_OTHER, async () =>
    db.select({ id: challenges.id }).from(challenges).where(eq(challenges.id, CH_ID)),
  );
  expect(seen).toEqual([]);
});

test('P1: cards come from CONFIRMED mappings of the sample data — label + description, no keys', async () => {
  as(creator);
  const r = await call(T, 'GET', `/api/challenges/${CH_ID}/entities`);
  expect(r.status).toBe(200);
  expect(r.json.items).toEqual([{ id: E_CLAIM, label: 'Claim', description: 'A request for payment', linked: false }]);
  // Nothing internal reaches the card: no natural key, no entity name, no dataset slug.
  const wire = JSON.stringify(r.json.items);
  expect(wire).not.toContain('W8InfoClaim');
  expect(wire).not.toContain(SLUG);
  expect(r.json.canEdit).toBe(true);
});

test('P1: the cards are localized to the reader\'s language', async () => {
  as(creator);
  const r = await call(T, 'GET', `/api/challenges/${CH_ID}/entities`, { 'accept-language': 'nl' });
  expect(r.json.items).toEqual([{ id: E_CLAIM, label: 'Schadeclaim', description: 'Een verzoek om uitbetaling', linked: false }]);
});

test('P1: a member of another tenant cannot read the cards (404)', async () => {
  as(outsider);
  const r = await call(T_OTHER, 'GET', `/api/challenges/${CH_ID}/entities`);
  expect(r.status).toBe(404);
  expect(JSON.stringify(r.json)).not.toContain('Claim');
});


// ---- P2: direct links ----------------------------------------------------------------------------

const ontologyCounts = async () =>
  (await db.execute(sql`select (select count(*) from ontology_entities)::int as e, (select count(*) from ontology_attributes)::int as a`)) as unknown as { e: number; a: number }[];

test('P2: the creator links a type of information; it shows first, marked linked, and the ontology is untouched', async () => {
  const before = await ontologyCounts();
  as(creator);
  const r = await call(T, 'PUT', `/api/challenges/${CH_ID}/entities`, {}, { entityIds: [E_POLICY] });
  expect(r.status).toBe(200);
  expect(r.json.items).toEqual([
    { id: E_POLICY, label: 'Policy', description: 'An insurance contract', linked: true },
    { id: E_CLAIM, label: 'Claim', description: 'A request for payment', linked: false },
  ]);
  const rows = await db.select().from(challengeEntities).where(eq(challengeEntities.challenge_id, CH_ID));
  expect(rows.map((x) => [x.entity_id, x.tenant_id, x.created_by])).toEqual([[E_POLICY, T, CREATOR_ID]]);
  expect(await ontologyCounts()).toEqual(before);

  const g = await call(T, 'GET', `/api/challenges/${CH_ID}/entities`);
  expect(g.json.items.map((i: { id: string }) => i.id)).toEqual([E_POLICY, E_CLAIM]);
});

test('P2: a member who did not create the challenge cannot change its links (403, nothing written)', async () => {
  as(creator);
  await call(T, 'PUT', `/api/challenges/${CH_ID}/entities`, {}, { entityIds: [E_POLICY] });
  as(peer);
  const r = await call(T, 'PUT', `/api/challenges/${CH_ID}/entities`, {}, { entityIds: [] });
  expect(r.status).toBe(403);
  const rows = await db.select().from(challengeEntities).where(eq(challengeEntities.challenge_id, CH_ID));
  expect(rows.map((x) => x.entity_id)).toEqual([E_POLICY]);
  // …and can still READ them, with no edit right.
  const g = await call(T, 'GET', `/api/challenges/${CH_ID}/entities`);
  expect(g.status).toBe(200);
  expect(g.json.canEdit).toBe(false);
});

test('F1: a tenant_admin who did not create the challenge may change its links (cp_app) — and is told so', async () => {
  as(creator);
  await call(T, 'PUT', `/api/challenges/${CH_ID}/entities`, {}, { entityIds: [E_POLICY] });
  as(admin);
  const g = await call(T, 'GET', `/api/challenges/${CH_ID}/entities`);
  expect(g.json.canEdit).toBe(true);
  const r = await call(T, 'PUT', `/api/challenges/${CH_ID}/entities`, {}, { entityIds: [E_CLAIM, E_POLICY] });
  expect(r.status).toBe(200);
  const rows = await db.select().from(challengeEntities).where(eq(challengeEntities.challenge_id, CH_ID));
  expect(rows.map((x) => [x.entity_id, x.created_by]).sort()).toEqual([[E_CLAIM, ADMIN_ID], [E_POLICY, ADMIN_ID]].sort());
});

test('F1: a plain member who did not create the challenge may not change its links (403 under cp_app)', async () => {
  as(creator);
  await call(T, 'PUT', `/api/challenges/${CH_ID}/entities`, {}, { entityIds: [E_POLICY] });
  as(member);
  const r = await call(T, 'PUT', `/api/challenges/${CH_ID}/entities`, {}, { entityIds: [E_CLAIM] });
  expect(r.status).toBe(403);
  const rows = await db.select().from(challengeEntities).where(eq(challengeEntities.challenge_id, CH_ID));
  expect(rows.map((x) => x.entity_id)).toEqual([E_POLICY]);
  expect((await call(T, 'GET', `/api/challenges/${CH_ID}/entities`)).json.canEdit).toBe(false);
});

test('P2: a member of another tenant can neither link nor read (404 under cp_app)', async () => {
  as(outsider);
  const put = await call(T_OTHER, 'PUT', `/api/challenges/${CH_ID}/entities`, {}, { entityIds: [E_FOREIGN] });
  expect(put.status).toBe(404);
  const rows = await db.select().from(challengeEntities).where(eq(challengeEntities.entity_id, E_FOREIGN));
  expect(rows).toEqual([]);
  // RLS itself: T's links are invisible to T_OTHER's runtime role.
  const seen = await withTenantDbAsRuntimeRoleForTests(T_OTHER, async () =>
    db.select().from(challengeEntities).where(eq(challengeEntities.challenge_id, CH_ID)),
  );
  expect(seen).toEqual([]);
});

test('P2: RLS refuses a link row written under another tenant\'s scope', async () => {
  let err: unknown;
  try {
    await withTenantDbAsRuntimeRoleForTests(T_OTHER, async () =>
      db.insert(challengeEntities).values({ challenge_id: CH_ID, entity_id: E_CLAIM, tenant_id: T, created_by: OTHER_ID }),
    );
  } catch (e) {
    err = e;
  }
  expect(String((err as { cause?: unknown })?.cause ?? err)).toContain('row-level security');
});

test('P2: another tenant\'s type of information, or a hidden one, cannot be linked (400, nothing written)', async () => {
  as(creator);
  await call(T, 'PUT', `/api/challenges/${CH_ID}/entities`, {}, { entityIds: [E_POLICY] });
  for (const bad of [E_FOREIGN, E_HIDDEN]) {
    const r = await call(T, 'PUT', `/api/challenges/${CH_ID}/entities`, {}, { entityIds: [E_CLAIM, bad] });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('information_not_found');
  }
  const rows = await db.select().from(challengeEntities).where(eq(challengeEntities.challenge_id, CH_ID));
  expect(rows.map((x) => x.entity_id)).toEqual([E_POLICY]);
});

test('P2: POST /api/challenges links at creation; a foreign id refuses the whole submit', async () => {
  as(creator);
  const ok = await call(T, 'POST', '/api/challenges', {}, {
    title: `${MARK} with information`, description: 'x', work_area: 'Claims', entities: [E_CLAIM, E_POLICY, E_CLAIM],
  });
  expect(ok.status).toBe(201);
  const rows = await db.select().from(challengeEntities).where(eq(challengeEntities.challenge_id, ok.json.id));
  expect(rows.map((x) => x.entity_id).sort()).toEqual([E_CLAIM, E_POLICY].sort());

  const bad = await call(T, 'POST', '/api/challenges', {}, {
    title: `${MARK} orphan`, description: 'x', work_area: 'Claims', entities: [E_FOREIGN],
  });
  expect(bad.status).toBe(400);
  const orphans = await db.select({ id: challenges.id }).from(challenges).where(eq(challenges.title, `${MARK} orphan`));
  expect(orphans).toEqual([]);

  // Deleting the challenge removes its links (ON DELETE CASCADE).
  await db.delete(challenges).where(eq(challenges.id, ok.json.id));
  const gone = await db.select().from(challengeEntities).where(eq(challengeEntities.challenge_id, ok.json.id));
  expect(gone).toEqual([]);
});

test('P2: the picker offers the tenant\'s own types of information for the work area — not another tenant\'s, not hidden ones', async () => {
  as(creator);
  const r = await call(T, 'GET', `/api/challenges/entity-options?work_area=${DEPT}`, { 'accept-language': 'nl' });
  expect(r.status).toBe(200);
  const labels = r.json.items.map((i: { label: string }) => i.label);
  expect(labels).toContain('Schadeclaim');
  expect(labels).toContain('Policy');
  expect(labels).not.toContain('Secret');
  expect(labels).not.toContain('Gone');
  const claim = r.json.items.find((i: { id: string }) => i.id === E_CLAIM);
  expect(claim).toEqual({ id: E_CLAIM, label: 'Schadeclaim', description: 'Een verzoek om uitbetaling', synonyms: [] });
});

// ---- P3: AI suggestions --------------------------------------------------------------------------

function fakeAi(reply: string | Error): { provider: LlmProvider; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    requests,
    provider: {
      chat: async (req: LlmRequest) => {
        requests.push(req);
        if (reply instanceof Error) throw reply;
        return { text: reply, usage: { tokensIn: 40, tokensOut: 4 } };
      },
    } as LlmProvider,
  };
}

const SUGGEST_BODY = { title: 'Claims wait four days', description: 'Every claim waits for a manual check.', work_area: DEPT };

async function suggest(body: unknown = SUGGEST_BODY) {
  as(creator);
  return call(T, 'POST', '/api/challenges/entity-suggestions', {}, body);
}

const usageRows = async () =>
  (await db.execute(sql`select count(*)::int as n from usage_events where user_id = ${CREATOR_ID} and stage = 'challenge-information'`)) as unknown as { n: number }[];

test('P3: suggestions come back as cards, through the metered broker', async () => {
  // The options are sorted by label: Claim (1), Policy (2).
  const ai = fakeAi('[2, 1]');
  __setBrokerDepsForTests({ chatProvider: ai.provider, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
  const before = (await usageRows())[0]!.n;
  const r = await suggest();
  expect(r.status).toBe(200);
  expect(r.json.items).toEqual([
    { id: E_POLICY, label: 'Policy', description: 'An insurance contract' },
    { id: E_CLAIM, label: 'Claim', description: 'A request for payment' },
  ]);
  expect(ai.requests).toHaveLength(1);
  // Metered: one usage_events row for this user and stage.
  expect((await usageRows())[0]!.n).toBe(before + 1);
});

test('⛔ P3: the AI request carries the title, description and names — and NO sample data, column or PII', async () => {
  const ai = fakeAi('[]');
  __setBrokerDepsForTests({ chatProvider: ai.provider, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
  await suggest();
  expect(ai.requests).toHaveLength(1);
  const payload = JSON.stringify(ai.requests[0]!.messages);
  // What it MAY carry:
  expect(payload).toContain('Claims wait four days');
  expect(payload).toContain('Every claim waits for a manual check.');
  expect(payload).toContain('Claim');
  expect(payload).toContain('Policy');
  // What it must NOT: the tenant's dataset values, column names, the dataset, or the internal key.
  for (const forbidden of ['98765', 'anna.w8secret', 'holder_email', SLUG, 'W8 Info Claims', 'W8InfoClaim', 'A request for payment']) {
    expect(payload).not.toContain(forbidden);
  }
  // Another tenant's information is not even offered.
  expect(payload).not.toContain('Secret');
});

test('P3: a client cannot smuggle anything else into the prompt (strict body)', async () => {
  const ai = fakeAi('[]');
  __setBrokerDepsForTests({ chatProvider: ai.provider, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
  const r = await suggest({ ...SUGGEST_BODY, rows: [{ holder_email: 'anna.w8secret@x.invalid' }] });
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(ai.requests).toHaveLength(0);
});

test('P3: any AI failure is silent — no suggestions, still 200', async () => {
  for (const reply of [new Error('provider down'), 'I think Claim fits best.', '[99, "x"]']) {
    const ai = fakeAi(reply);
    __setBrokerDepsForTests({ chatProvider: ai.provider, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
    const r = await suggest();
    expect(r.status).toBe(200);
    expect(r.json.items).toEqual([]);
  }
});

test('P3: the tenant\'s budget applies — over the daily cap the AI is not called and there are no suggestions', async () => {
  const ai = fakeAi('[1]');
  __setBrokerDepsForTests({ chatProvider: ai.provider, limits: () => ({ dailyLlmCap: 0, weeklySpendUsd: 100 }) });
  const r = await suggest();
  expect(r.status).toBe(200);
  expect(r.json.items).toEqual([]);
  expect(ai.requests).toHaveLength(0);
});
