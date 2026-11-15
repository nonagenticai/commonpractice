// tests/connector-pii-merge.test.ts — PII-gaps hunt, FIX 1: a connector refresh used to
// overwrite `datasets.columns` WHOLESALE with the freshly heuristic-inferred columns on
// EVERY sync (connector-refresh.ts doRefresh), silently discarding a human's
// PATCH /api/datasets/:slug `pii: true` correction — the very next sync (manual, or the
// secret-authed webhook ingress) would then inject that column UNREDACTED even with
// governance PII scrubbing ON.
//
// Proves against a real HTTP connector (egress test-seam, no network) that a refresh:
//   - keeps a human-set pii:true STICKY on a column the fresh heuristic would not re-flag
//   - still applies fresh inference to a genuinely-new column
//   - drops a column that disappeared from the source
//   - records the shape change (added/removed/piiPreserved) on the sync's audit row
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { and, desc, eq } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { __setEgressHooksForTests } from '../src/host/egress-guard';
import { invalidatePolicyCache } from '../src/host/policy-store';
import {
  snapshotPolicies,
  restorePolicies,
  CONNECTOR_POLICY_KEYS,
} from './helpers/policy-snapshot';
import { Router } from '../src/utils/router';
import { registerConnectorRoutes } from '../src/routes/connectors';
import { registerDatasetRoutes } from '../src/routes/datasets';
import { db, users, datasets, datasetRows, policies, auditLog } from '../src/db/client';
import type { User } from '../src/types';

const OWNER_ID = '00000000-0000-0000-0000-0000c1aa0001';
const owner: User = {
  id: OWNER_ID,
  email: 'conn-pii@test',
  name: 'Conn Pii Owner',
  roles: ['super_admin', 'employee'],
  tenantId: OWNER_ID,
};

const router = new Router();
registerConnectorRoutes(router);
registerDatasetRoutes(router);

async function call(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function setAllowlist(allow: string[], externalHttp = true) {
  for (const [key, value, control, category, label] of [
    ['models.external_http', externalHttp, 'toggle', 'models_tools', 'External HTTP'],
    ['data.egress_allowlist', allow, 'list', 'models_tools', 'Egress allowlist'],
  ] as const) {
    await db
      .insert(policies)
      .values({ key, value, control, category, label })
      .onConflictDoUpdate({ target: policies.key, set: { value } });
  }
  invalidatePolicyCache();
}

async function cleanup() {
  const owned = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, OWNER_ID));
  for (const d of owned) await db.delete(datasetRows).where(eq(datasetRows.dataset_id, d.id));
  await db.delete(datasets).where(eq(datasets.owner_id, OWNER_ID));
  await db.delete(auditLog).where(eq(auditLog.actor_id, OWNER_ID));
  await db.delete(users).where(eq(users.id, OWNER_ID));
}

// The fetch mock returns a DIFFERENT body depending on `fetchResponses` — mutated between
// the create-sync and the manual re-sync so we can simulate the source's shape changing.
let fetchBody: unknown[] = [];

/** Captured in `beforeAll`, put back verbatim in `afterAll` — never a literal. See
 *  `helpers/policy-snapshot.ts` for the 22→3 truncation this shape used to cause. */
let POLICY_SNAPSHOT: Map<string, unknown>;

beforeAll(async () => {
  POLICY_SNAPSHOT = await snapshotPolicies(CONNECTOR_POLICY_KEYS);
  await cleanup();
  __setAuthOverridesForTests({ validateAuth: async () => owner });
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'],
    fetch: async () =>
      new Response(JSON.stringify(fetchBody), { headers: { 'content-type': 'application/json' } }),
  });
  await setAllowlist(['pii-merge.test.invalid']);
}, 30_000);

afterAll(async () => {
  await cleanup();
  await restorePolicies(POLICY_SNAPSHOT);
  __setAuthOverridesForTests(undefined);
  __setEgressHooksForTests(undefined);
}, 30_000);

test('a connector refresh preserves a human pii:true flag, applies fresh inference elsewhere, and tracks shape changes', async () => {
  // First sync (on create): id, notes (NOT pii-named), legacy_flag. Neither non-id column
  // matches the PII name heuristic, so nothing is auto-flagged.
  fetchBody = [{ id: 1, notes: 'internal memo text', legacy_flag: true }];
  const created = await call('POST', '/api/connectors', {
    name: 'Case Notes Feed',
    sourceType: 'http',
    config: { url: 'https://pii-merge.test.invalid/rows.json' },
  });
  expect(created.status).toBe(201);
  expect(created.json.status).toBe('ready');
  const slug = created.json.slug as string;
  const notesCol = created.json.columns.find((c: { name: string }) => c.name === 'notes');
  expect(notesCol.pii).toBeFalsy(); // heuristic does not flag 'notes'

  // A human confirms 'notes' actually holds PII — the UI's PII toggle → PATCH /api/datasets/:slug.
  const patched = await call('PATCH', `/api/datasets/${slug}`, {
    columns: [
      { name: 'id', type: 'number' },
      { name: 'notes', type: 'string', pii: true },
      { name: 'legacy_flag', type: 'boolean' },
    ],
  });
  expect(patched.status).toBe(200);
  expect(patched.json.columns.find((c: { name: string }) => c.name === 'notes').pii).toBe(true);

  // The source's shape changes: 'legacy_flag' is gone, a new 'city' column appears. 'notes' is
  // still present but the FRESH heuristic still would not flag it — this is the crux of FIX 1.
  fetchBody = [{ id: 2, notes: 'a different memo', city: 'Amsterdam' }];
  const synced = await call('POST', `/api/connectors/${slug}/sync`, {});
  expect(synced.status).toBe(200);
  expect(synced.json.sync.ok).toBe(true);

  const cols = synced.json.columns as { name: string; type: string; pii?: boolean }[];
  const byName = (n: string) => cols.find((c) => c.name === n);

  // ⛔ THE ACTUAL FIX: without it, this refresh overwrote columns wholesale with the fresh
  // inference, which does not flag 'notes' — the human's pii:true would be silently dropped.
  expect(byName('notes')?.pii).toBe(true);
  // A genuinely new column still gets fresh inference (not sticky-by-default).
  expect(byName('city')).toBeDefined();
  expect(byName('city')?.pii).toBeFalsy();
  // A column that disappeared from the source is dropped, not carried forward as stale.
  expect(byName('legacy_flag')).toBeUndefined();
  expect(cols.map((c) => c.name).sort()).toEqual(['city', 'id', 'notes']);

  // The sync's audit row records the shape change (added/removed/piiPreserved) so an operator
  // can see WHY a refresh's schema moved without diffing raw column arrays. Two 'connector.sync'
  // rows exist (create's initial materialize + this manual re-sync) — take the latest.
  const [audit] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actor_id, OWNER_ID), eq(auditLog.action, 'connector.sync')))
    .orderBy(desc(auditLog.created_at))
    .limit(1);
  const meta = audit!.metadata as Record<string, unknown>;
  expect(meta.piiPreserved).toEqual(['notes']);
  expect(meta.columnsAdded).toEqual(['city']);
  expect(meta.columnsRemoved).toEqual(['legacy_flag']);
}, 30_000); // two real connector syncs (create + manual) — see bunfig's [test] timeout note above
