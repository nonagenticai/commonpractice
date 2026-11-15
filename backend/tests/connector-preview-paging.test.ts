// tests/connector-preview-paging.test.ts — the connector preview's row window.
//
// ⛔ WHY. `GET /api/connectors/:slug` used to read `readRows(d.id, DATASET_PREVIEW_ROWS, 0)` with no
// query parameters at all, while the very same response carried `rowCount` — so a 10 000-row
// connector answered with 50 rows and a field saying 10 000, and the drawer showed the 50 with
// nothing anywhere admitting the other 9 950 existed. Its sibling `GET /api/datasets/:slug` has
// read `?limit`/`?offset` (clamped at `DATASET_PREVIEW_ROWS * 4`, floored at 1) since Phase 2.0.
// Same class as the dataset picker that silently stopped at 12 (PR #309): a hardcoded cap hiding
// user data behind a number that says otherwise.
//
// ⛔ THE FIXTURE IS 250 ROWS AND THAT IS THE POINT. A 10-row fixture cannot tell a 50-cap from a
// 200-cap — every assertion would pass on both the defect and the fix — and that vacuity is the
// single most common way a test in this repo proves nothing. 250 > the ceiling (200), so the
// ceiling itself is observable rather than merely unreached.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerConnectorRoutes } from '../src/routes/connectors';
import { db, users, datasets, datasetRows, tenants } from '../src/db/client';
import { DATASET_PREVIEW_ROWS } from '../src/db/dataset-types';
import type { User } from '../src/types';

// Ids owned by THIS file only — see tests/fixture-id-collisions.test.ts.
const OWNER_ID = '00000000-0000-0000-0000-0000c9a90001';
const CONNECTOR_ID = '00000000-0000-0000-0000-0000c9a90002';
const SLUG = 'connector-preview-paging';
const SEEDED = 250;
const CEILING = DATASET_PREVIEW_ROWS * 4;

const owner: User = {
  id: OWNER_ID,
  email: 'cpp@test',
  name: 'Preview Paging Owner',
  roles: ['super_admin', 'employee'],
  tenantId: OWNER_ID,
};

const router = new Router();
registerConnectorRoutes(router);

async function get(path: string) {
  const matched = router.match('GET', path.split('?')[0]!);
  if (!matched) throw new Error(`no route for GET ${path}`);
  const res = await matched.handler(new Request(`http://localhost${path}`), ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  await db.delete(datasetRows).where(eq(datasetRows.dataset_id, CONNECTOR_ID));
  await db.delete(datasets).where(eq(datasets.id, CONNECTOR_ID));
  await db.delete(users).where(eq(users.id, OWNER_ID));
  await db.delete(tenants).where(eq(tenants.id, OWNER_ID));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS.
beforeAll(async () => {
  await cleanup();
  __setAuthOverridesForTests({ validateAuth: async () => owner });
  await db.insert(tenants).values({ id: OWNER_ID, name: 'Connector Preview Paging', slug: 'connector-preview-paging-tenant' });
  await db.insert(users).values({ id: OWNER_ID, email: owner.email, name: owner.name, role: 'employee', tenant_id: OWNER_ID });
  await db.insert(datasets).values({
    id: CONNECTOR_ID,
    owner_id: OWNER_ID,
    tenant_id: OWNER_ID,
    name: 'Preview Paging Connector',
    slug: SLUG,
    source_type: 'postgres',
    event_source: 'none',
    status: 'ready',
    columns: [{ name: 'n', type: 'number' }],
    row_count: SEEDED,
  });
  await db.insert(datasetRows).values(
    Array.from({ length: SEEDED }, (_, i) => ({ dataset_id: CONNECTOR_ID, idx: i, data: { n: i } })),
  );
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('the connector preview defaults to DATASET_PREVIEW_ROWS and says so on the wire', async () => {
  const r = await get(`/api/connectors/${SLUG}`);
  expect(r.status).toBe(200);
  expect(r.json.rowCount).toBe(SEEDED);
  expect(r.json.rows).toHaveLength(DATASET_PREVIEW_ROWS);
  expect(r.json.rows[0].n).toBe(0);
  // The window is ECHOED, exactly as `GET /api/datasets/:slug` echoes it, so the client can render
  // "showing N of M" instead of silently presenting a truncated table as the whole thing.
  expect(r.json.limit).toBe(DATASET_PREVIEW_ROWS);
  expect(r.json.offset).toBe(0);
});

test('?limit=200 returns MORE than DATASET_PREVIEW_ROWS rows', async () => {
  const r = await get(`/api/connectors/${SLUG}?limit=200`);
  expect(r.status).toBe(200);
  expect(r.json.rows.length).toBeGreaterThan(DATASET_PREVIEW_ROWS);
  expect(r.json.rows).toHaveLength(200);
  expect(r.json.rows[199].n).toBe(199);
  expect(r.json.limit).toBe(200);
});

test('the clamp holds at the ceiling — a limit above DATASET_PREVIEW_ROWS * 4 is capped, not honoured', async () => {
  // 250 rows exist, so a cap at 200 is a fact about the CLAMP and not about the fixture running out.
  const r = await get(`/api/connectors/${SLUG}?limit=9999`);
  expect(r.status).toBe(200);
  expect(r.json.rows).toHaveLength(CEILING);
  expect(r.json.limit).toBe(CEILING);
});

test('the floor holds at 1 — a negative limit never means "everything" or "nothing"', async () => {
  const neg = await get(`/api/connectors/${SLUG}?limit=-5`);
  expect(neg.status).toBe(200);
  expect(neg.json.rows).toHaveLength(1);
  expect(neg.json.limit).toBe(1);

  // ⚠️ `?limit=0` IS THE DEFAULT, NOT 1, AND THAT IS THE SIBLING'S CONTRACT VERBATIM. `0 ||
  // DATASET_PREVIEW_ROWS` folds a zero in with the unparseable and the absent — the route cannot
  // tell "the caller asked for none" from "the caller said nothing", and Postgres `LIMIT 0` means
  // "nothing", so guessing either way would be a guess. Pinned rather than tolerated: this route
  // and `GET /api/datasets/:slug` render the same drawer over the same table, so if the floor is
  // ever tightened it must be tightened in BOTH or the two screens start disagreeing.
  for (const q of ['limit=0', 'limit=abc', 'limit=']) {
    const r = await get(`/api/connectors/${SLUG}?${q}`);
    expect(r.status).toBe(200);
    expect(r.json.rows).toHaveLength(DATASET_PREVIEW_ROWS);
    expect(r.json.limit).toBe(DATASET_PREVIEW_ROWS);
  }
});

test('?offset moves the window, so the rows beyond the first page are actually reachable', async () => {
  const r = await get(`/api/connectors/${SLUG}?offset=200&limit=50`);
  expect(r.status).toBe(200);
  expect(r.json.rows).toHaveLength(50);
  expect(r.json.rows[0].n).toBe(200);
  expect(r.json.rows[49].n).toBe(249);
  expect(r.json.offset).toBe(200);
  // A negative offset floors at 0 rather than throwing a Postgres error.
  const neg = await get(`/api/connectors/${SLUG}?offset=-10`);
  expect(neg.status).toBe(200);
  expect(neg.json.offset).toBe(0);
  expect(neg.json.rows[0].n).toBe(0);
});
