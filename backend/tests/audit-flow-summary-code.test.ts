// tests/audit-flow-summary-code.test.ts — /api/audit carries the flow-summary CODE, not only the
// English prose, so /audit and /build say the SAME WORDS about the SAME EVENT.
//
// ⛔ THE DEFECT. `POST /api/flows/:id/snapshots` and `…/restore` write the snapshot with a
// `summary_code` (so `/build`'s history drawer renders "Handmatig checkpoint" to a Dutch reader
// via `frontend/src/lib/i18n/flow-summary-label.ts`) and, in the very same handler, write an audit
// row whose `result` is the ENGLISH sentence and nothing else. `/audit` rendered `{item.result}`
// raw, so one event was "Handmatig checkpoint" on one screen and "Manual checkpoint" on the other.
// The product contradicted itself, in the reader's own language, about a row it had just written.
//
// The fix reuses the mechanism that already exists rather than inventing a second one: the code and
// params travel in the `metadata` jsonb column that `recordAudit` already persists, and the audit
// route DERIVES exactly two public fields from it.
//
// ⛔ AND ONLY TWO. `metadata` is an internal bag — it also carries `snapshotId` and, on the
// orphan-actor fallback (host/audit-service.ts), `actorSub`: the Keycloak subject of a super_admin
// with no local `users` row. Shipping the whole bag to the browser would leak an identity the feed
// deliberately renders as "System". The last test here is the one that holds that down.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray, like } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerFlowRoutes } from '../src/routes/flows';
import { registerAuditRoutes } from '../src/routes/audit';
import { db, flows, flowSnapshots, auditLog, users, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { User } from '../src/types';

// One identity for both routers: the flow routes gate on ownership (`validateAuth`), the audit
// feed on `requireSuperAdmin` — and both consult the same test override.
const USER_ID = '00000000-0000-0000-0000-0000009c0d10';
const actor: User = {
  id: USER_ID,
  email: 'auditparity@test',
  name: 'Audit Parity',
  roles: ['super_admin', 'employee'],
};
const LEAK_MARK = 'ztest.auditparity.leak';

const router = new Router();
registerFlowRoutes(router);
registerAuditRoutes(router);

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** The response BODY AS TEXT — the wire, before `JSON.parse` throws structure over it. */
async function callText(method: string, path: string): Promise<{ status: number; text: string }> {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, { method });
  const res = await withTenantDb(DEMO_TENANT_ID, () => matched.handler(req, ...matched.params));
  return { status: res.status, text: await res.text() };
}

async function cleanup() {
  const owned = await db.select({ id: flows.id }).from(flows).where(eq(flows.owner_id, USER_ID));
  const ids = owned.map((f) => f.id);
  if (ids.length) await db.delete(flowSnapshots).where(inArray(flowSnapshots.flow_id, ids));
  await db.delete(auditLog).where(eq(auditLog.actor_id, USER_ID));
  await db.delete(auditLog).where(like(auditLog.action, `${LEAK_MARK}%`));
  await db.delete(flows).where(eq(flows.owner_id, USER_ID));
  await db.delete(users).where(eq(users.id, USER_ID));
}

beforeAll(async () => {
  await cleanup();
  await db
    .insert(users)
    .values({ id: USER_ID, email: actor.email, name: actor.name, avatar_initials: 'AP' })
    .onConflictDoNothing();
  __setAuthOverridesForTests({ validateAuth: async () => actor, requireRole: async () => actor });
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

/** Every audit item whose target is `flowId`, newest first — the feed the admin actually sees. */
async function auditRowsFor(flowId: string): Promise<any[]> {
  const res = await call('GET', `/api/audit?range=all&q=${flowId}`);
  expect(res.status).toBe(200);
  return res.json.items as any[];
}

test('a DEFAULT manual checkpoint ships flow_summary_manual_checkpoint on the audit feed', async () => {
  // REVERT THAT TURNS THIS RED: drop `summaryCode` from the `recordAudit` metadata in
  // routes/flows.ts, or drop `metadata` from the audit route's `.select()`. Either way the /audit
  // reader is back to the raw English while /build says "Handmatig checkpoint".
  const created = await call('POST', '/api/flows', { name: 'ws4 parity default' });
  expect(created.status).toBe(201);
  const flowId = created.json.id as string;

  const snap = await call('POST', `/api/flows/${flowId}/snapshots`, {});
  expect(snap.status).toBe(201);

  const rows = await auditRowsFor(flowId);
  const row = rows.find((r) => r.action === 'flow.checkpoint');
  expect(row, 'no flow.checkpoint audit row').toBeTruthy();
  // The English stays on the wire byte for byte — it is the permanent fallback.
  expect(row.result).toBe('Manual checkpoint');
  expect(row.resultCode).toBe('flow_summary_manual_checkpoint');
  // Parameterless code → no params, the same shape the snapshot row persists.
  expect(row.resultParams ?? null).toBeNull();
});

test('a USER-TYPED checkpoint gets NO code — their own words come back verbatim', async () => {
  // ⛔ THE DISCRIMINATOR IS THE PRESENCE OF USER TEXT, NOT ITS VALUE. This mirrors the snapshot
  // path (routes/flows.ts) exactly: a code here would silently translate a reader's own Dutch
  // sentence into the catalog's, on the audit trail of all places.
  const created = await call('POST', '/api/flows', { name: 'ws4 parity typed' });
  const flowId = created.json.id as string;
  const snap = await call('POST', `/api/flows/${flowId}/snapshots`, { summary: "Tom's eigen tekst" });
  expect(snap.status).toBe(201);

  const rows = await auditRowsFor(flowId);
  const row = rows.find((r) => r.action === 'flow.checkpoint');
  expect(row.result).toBe("Tom's eigen tekst");
  expect(row.resultCode ?? null).toBeNull();
});

test('a restore ships flow_summary_restored plus the RAW ISO instant it rolled back to', async () => {
  const created = await call('POST', '/api/flows', { name: 'ws4 parity restore' });
  const flowId = created.json.id as string;
  const snap = await call('POST', `/api/flows/${flowId}/snapshots`, {});
  const snapshotId = snap.json.id as string;

  const restored = await call('POST', `/api/flows/${flowId}/snapshots/${snapshotId}/restore`);
  expect(restored.status).toBe(200);

  const rows = await auditRowsFor(flowId);
  const row = rows.find((r) => r.action === 'flow.restore');
  expect(row, 'no flow.restore audit row').toBeTruthy();
  expect(row.resultCode).toBe('flow_summary_restored');
  expect(typeof row.resultParams?.at).toBe('string');
  // ⛔ ONE INSTANT, TWO RENDERINGS, AND THIS ASSERTION IS WHAT STOPS THEM DRIFTING. The English
  // sentence and the machine field must be composed from the SAME value handed to `writeSnapshot`;
  // recomputing `new Date()` for the audit row would pass a `typeof` check and still name a
  // different moment than /build does.
  expect(row.result).toBe(`Restored snapshot from ${row.resultParams.at}`);
  // The params must be interpolatable: `flow-summary-label.ts` falls back to the English when
  // `at` is absent or empty, which is precisely the silent no-op this test forbids.
  expect(row.resultParams.at).not.toBe('');
  expect(new Date(row.resultParams.at as string).toISOString()).toBe(row.resultParams.at);
});

test('⛔ the feed leaks NOTHING else from metadata — not actorSub, not snapshotId, not the bag', async () => {
  // `actorSub` is written by the orphan-actor fallback in host/audit-service.ts on a row the feed
  // deliberately renders as "System". A `metadata: r.metadata` passthrough would hand the browser
  // the Keycloak subject of the very actor the row anonymised, plus every pipeline internal any
  // future `recordAudit` caller decides to stash. Two derived fields, never the bag.
  await db.insert(auditLog).values([
    {
      actor_id: null,
      action: `${LEAK_MARK}.checkpoint`,
      category: 'block',
      target_type: 'flow',
      target_id: 'zleakflow',
      result: 'Manual checkpoint',
      result_tone: 'ok',
      metadata: {
        snapshotId: 'zsnap-1',
        actorSub: 'kc-subject-should-never-ship',
        summaryCode: 'flow_summary_manual_checkpoint',
        summaryParams: null,
        pipelineInternal: 'zinternal',
      },
    },
    // ⛔ THE NESTED CASE — the one a top-level key allowlist passes and still leaks. `resultParams`
    // used to be a VERBATIM passthrough of whatever sub-object the writer stashed, so the payload's
    // top-level SHAPE was fixed while its DEPTH was not. Not reachable from routes/flows.ts today;
    // the projection has to hold anyway, because "no writer does this yet" is a fact about the
    // writers and not a property of this route.
    {
      actor_id: null,
      action: `${LEAK_MARK}.restore`,
      category: 'block',
      target_type: 'flow',
      target_id: 'zleakflow',
      result: 'Restored snapshot from 2026-08-07T09:12:44.031Z',
      result_tone: 'ok',
      metadata: {
        summaryCode: 'flow_summary_restored',
        summaryParams: {
          at: '2026-08-07T09:12:44.031Z',
          actorSub: 'kc-nested-should-never-ship',
          pipelineInternal: 'znestedinternal',
        },
      },
    },
    // An ARRAY under a field the frontend types `Record<string, unknown>`: JSON.parse hands the
    // browser an array, `has()` reads indices, and the whole thing is on the wire regardless.
    {
      actor_id: null,
      action: `${LEAK_MARK}.array`,
      category: 'block',
      target_type: 'flow',
      target_id: 'zleakflow',
      result: 'Manual checkpoint',
      result_tone: 'ok',
      metadata: {
        summaryCode: 'flow_summary_manual_checkpoint',
        summaryParams: ['zarrayleak'],
      },
    },
  ]);

  // ⛔ ASSERTED ON THE RESPONSE TEXT, NOT ON A PARSED KEY LIST. `Object.keys(row)` is a TOP-LEVEL
  // question, and the defect above is one level down — a key-list assertion is green on a payload
  // whose `resultParams` object carries `actorSub` inside it. The bytes are what ship.
  const raw = await callText('GET', `/api/audit?range=all&q=${LEAK_MARK}`);
  expect(raw.status).toBe(200);
  const items = (JSON.parse(raw.text).items as any[]).filter((r) =>
    String(r.action).startsWith(LEAK_MARK),
  );
  // NON-VACUITY FIRST: all three rows are here AND the derived fields did come through, so the
  // absences below are absences from a payload that was actually built.
  expect(items).toHaveLength(3);
  const byAction = Object.fromEntries(items.map((r) => [r.action, r]));
  expect(byAction[`${LEAK_MARK}.checkpoint`].resultCode).toBe('flow_summary_manual_checkpoint');
  expect(byAction[`${LEAK_MARK}.restore`].resultCode).toBe('flow_summary_restored');
  // The PERMITTED nested field survives the projection — otherwise "nothing leaked" would be
  // satisfied by a route that dropped `resultParams` entirely and blanked every restore row.
  expect(byAction[`${LEAK_MARK}.restore`].resultParams).toEqual({ at: '2026-08-07T09:12:44.031Z' });
  // An array is not a params bag; it collapses to the fallback rather than travelling as one.
  expect(byAction[`${LEAK_MARK}.array`].resultParams).toBeNull();

  for (const forbidden of [
    'actorSub',
    'kc-subject-should-never-ship',
    'kc-nested-should-never-ship',
    'snapshotId',
    'zsnap-1',
    'pipelineInternal',
    'zinternal',
    'znestedinternal',
    'zarrayleak',
  ]) {
    expect(raw.text, `${forbidden} reached the wire`).not.toContain(forbidden);
  }

  // ⛔ AND ASSERT THE SUPERSET AT BOTH LEVELS, NOT JUST THE KNOWN NAMES: a key added to `metadata`
  // or to `summaryParams` next week is caught by the allowlists, never by the strings above.
  for (const row of items) {
    expect(Object.keys(row).sort()).toEqual(
      [
        'action',
        'actor',
        'category',
        'createdAt',
        'id',
        'result',
        'resultCode',
        'resultParams',
        'resultTone',
        'targetId',
        'targetType',
      ].sort(),
    );
    for (const k of Object.keys(row.resultParams ?? {})) {
      expect(
        ['slug', 'nodeId', 'edgeId', 'key', 'source', 'sourceHandle', 'target', 'targetHandle', 'at'],
        `resultParams.${k} is not a declared summary param`,
      ).toContain(k);
    }
  }
});
