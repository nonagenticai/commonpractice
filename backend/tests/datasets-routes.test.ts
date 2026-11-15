// tests/datasets-routes.test.ts — the Datasets API (Phase 2.0) + the host-side
// injection helper + the describe_data MCP tool. Owner-scoped CRUD over a real PG.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerDatasetRoutes } from '../src/routes/datasets';
import { db, users, datasets, datasetRows } from '../src/db/client';
import {
  __setDatasetPersistHookForTests,
  createDataset,
  loadInjectedDatasets,
} from '../src/datasets/dataset-service';
import { DATASET_MAX_BYTES } from '../src/db/dataset-types';
import { getPlatformTool } from '../src/ai/mcp/tools';
import type { User } from '../src/types';

const OWNER_ID = '00000000-0000-0000-0000-0000da7a0001';
const OTHER_ID = '00000000-0000-0000-0000-0000da7a0002';
// The `developer` / plain-`member` identities for the data-manager gate below. New ids in THIS
// file only, so the fixture-id ratchet stays quiet (it flags ids that appear in >1 file).
const DEV_ID = '00000000-0000-0000-0000-0000da7a0003';
const MEMBER_ID = '00000000-0000-0000-0000-0000da7a0004';
const owner: User = { id: OWNER_ID, email: 'ds@test', name: 'DS Owner', roles: ['super_admin', 'employee'], tenantId: OWNER_ID };
// Both sit in the OWNER_ID tenant so `cleanup()` reaches anything they create.
const developer: User = { id: DEV_ID, email: 'dev@test', name: 'DS Dev', roles: ['developer'], tenantId: OWNER_ID };
const plainMember: User = { id: MEMBER_ID, email: 'mem@test', name: 'DS Member', roles: [], tenantId: OWNER_ID };

function install(u: User) {
  __setAuthOverridesForTests({ validateAuth: async () => u });
}

const router = new Router();
registerDatasetRoutes(router);

async function call(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const isForm = body instanceof FormData;
  const req = new Request(`http://localhost${path}`, {
    method,
    // Let Bun set the multipart boundary for FormData; JSON otherwise.
    headers: body !== undefined && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function cleanup() {
  for (const ownerId of [OWNER_ID, DEV_ID, MEMBER_ID]) {
    const owned = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, ownerId));
    for (const d of owned) await db.delete(datasetRows).where(eq(datasetRows.dataset_id, d.id));
    await db.delete(datasets).where(eq(datasets.owner_id, ownerId));
  }
  for (const id of [OWNER_ID, OTHER_ID, DEV_ID, MEMBER_ID]) {
    await db.delete(users).where(eq(users.id, id));
  }
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  install(owner);
}, 30_000);
afterAll(async () => {
  __setDatasetPersistHookForTests(undefined);
  await cleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('POST (JSON/csv) parses, persists rows, returns a typed schema + preview', async () => {
  const r = await call('POST', '/api/datasets', {
    name: 'Claims April',
    sourceType: 'csv',
    content: 'claim_id,amount,email\nCLM-1,250,a@x.invalid\nCLM-2,980,b@x.invalid\n',
  });
  expect(r.status).toBe(201);
  expect(r.json.slug).toBe('claims-april');
  expect(r.json.rowCount).toBe(2);
  expect(r.json.preview).toHaveLength(2);
  const email = r.json.columns.find((c: { name: string }) => c.name === 'email');
  expect(email.pii).toBe(true);
});

test('POST (multipart/csv upload) infers source type from the file', async () => {
  const form = new FormData();
  form.append('file', new File(['city,pop\nAms,900000\n'], 'cities.csv', { type: 'text/csv' }));
  const r = await call('POST', '/api/datasets', form);
  expect(r.status).toBe(201);
  expect(r.json.sourceType).toBe('csv');
  expect(r.json.slug).toBe('cities');
  expect(r.json.rowCount).toBe(1);
});

// ---- the upload never GUESSES a source type (the dropped-PDF defect) ----------------------------
//
// ⛔ THE DEFECT, ON THE REAL ROUTE. `sourceTypeFromName` answers `null` for an extension it does not
// know, and the route closed that with `?? 'csv'`. So dragging `report.pdf` onto /datasets decoded
// the binary as UTF-8, made line 1 the header row, and answered **201 with a dataset that looked
// successfully imported**. The frontend's only guard was `accept=` on the hidden <input>, which the
// drag-and-drop path never consults. These three cases pin the whole decision table: refuse an
// unknown extension, refuse a nameless/extensionless file, and let an EXPLICIT `sourceType` win.
//
// The bytes below start with a real `%PDF-` signature and carry commas, so on the pre-fix route they
// parse cleanly into columns — the assertion is that the route REFUSES, not that some parser happened
// to choke downstream.
const PDF_BYTES = new Uint8Array([
  ...new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<< /Type /Catalog, /Pages 2 0 R >>\nendobj\n'),
  // Binary bytes that are NOT valid UTF-8 (they decode to U+FFFD), so the "decode it as text and
  // hope" path is demonstrably wrong. ⛔ NO 0x00 HERE ON PURPOSE: a NUL makes the row INSERT die on
  // Postgres 22P05 (`\u0000 cannot be converted to text`), which turns the pre-fix run into a 500
  // and hides the actual defect — a clean **201 with a garbage dataset**.
  0x0a, 0x80, 0xff, 0xfe, 0x0a,
  ...new TextEncoder().encode('trailer\n<< /Size 4, /Root 1 0 R >>\n%%EOF\n'),
]);

async function ownedDatasetCount(ownerId: string) {
  const rows = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, ownerId));
  return rows.length;
}

test('POST (multipart) refuses an unsupported file extension and persists NOTHING', async () => {
  const before = await ownedDatasetCount(OWNER_ID);
  const form = new FormData();
  form.append('file', new File([PDF_BYTES], 'report.pdf', { type: 'application/pdf' }));
  const r = await call('POST', '/api/datasets', form);
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('unsupported_file_type');
  // `reason` is the localization discriminator (utils/http.ts's `details` seam) — one code, two
  // sentences — and `extension` is the value a catalog needs to name the offender in Dutch.
  expect(r.json.details.reason).toBe('extension');
  expect(r.json.details.extension).toBe('.pdf');
  // ⛔ THE HALF THAT MATTERS: a refusal that still wrote the row would be the same defect with a
  // louder status code.
  expect(await ownedDatasetCount(OWNER_ID)).toBe(before);
});

test('POST (multipart) refuses a file with no extension at all', async () => {
  const before = await ownedDatasetCount(OWNER_ID);
  const form = new FormData();
  form.append('file', new File(['a,b\n1,2\n'], 'export', { type: 'application/octet-stream' }));
  const r = await call('POST', '/api/datasets', form);
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('unsupported_file_type');
  expect(r.json.details.reason).toBe('no_extension');
  expect(r.json.details.name).toBe('export');
  expect(await ownedDatasetCount(OWNER_ID)).toBe(before);
});

test('POST (multipart) still honours an EXPLICIT sourceType over the file name', async () => {
  const form = new FormData();
  form.append('file', new File(['a,b\n1,2\n'], 'report.pdf', { type: 'application/pdf' }));
  form.append('sourceType', 'csv');
  form.append('name', 'explicit-wins');
  const r = await call('POST', '/api/datasets', form);
  expect(r.status).toBe(201);
  expect(r.json.sourceType).toBe('csv');
  expect(r.json.rowCount).toBe(1);
});

test('POST (multipart/.txt) is UNCHANGED — it is a known extension, parsed as text', async () => {
  const form = new FormData();
  form.append('file', new File(['a,b\n1,2\n'], 'notes.txt', { type: 'text/plain' }));
  const r = await call('POST', '/api/datasets', form);
  expect(r.status).toBe(201);
  expect(r.json.sourceType).toBe('text');
  expect(r.json.columns.map((c: { name: string }) => c.name)).toEqual(['line', 'text']);
});

test('an oversized request is rejected from Content-Length before body buffering', async () => {
  const matched = router.match('POST', '/api/datasets')!;
  const req = new Request('http://localhost/api/datasets', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(DATASET_MAX_BYTES + 1),
    },
    body: '{}',
  });
  const response = await matched.handler(req, ...matched.params);
  expect(response.status).toBe(400);
  const body = (await response.json()) as {
    error: string;
    details: { reason?: string; limitMb?: number };
  };
  expect(body.error).toBe('dataset_too_large');
  // `dataset_too_large` covers three different sentences (body ceiling / multipart file / parser
  // input), so the localizable discriminator + the interpolated limit must both be ON THE WIRE —
  // a catalog cannot rebuild "Upload exceeds the 25 MB dataset limit" in Dutch from the code alone.
  // This is the Content-Length path, so `upload`, never `file`.
  expect(body.details.reason).toBe('upload');
  expect(body.details.limitMb).toBe(Math.floor(DATASET_MAX_BYTES / 1_048_576));
});

test('a failure after the first row chunk rolls back metadata and every row', async () => {
  __setDatasetPersistHookForTests((chunkIndex) => {
    if (chunkIndex === 1) throw new Error('injected chunk failure');
  });
  try {
    await expect(
      createDataset({
        ownerId: OWNER_ID,
        tenantId: OWNER_ID,
        name: 'Atomic failure',
        sourceType: 'json',
        parsed: {
          columns: [{ name: 'n', type: 'number' }],
          rows: Array.from({ length: 501 }, (_, n) => ({ n })),
        },
      }),
    ).rejects.toThrow('injected chunk failure');
  } finally {
    __setDatasetPersistHookForTests(undefined);
  }
  expect(
    await db.select().from(datasets).where(eq(datasets.name, 'Atomic failure')),
  ).toHaveLength(0);
});

test('GET list is owner-scoped + searchable', async () => {
  const all = await call('GET', '/api/datasets');
  expect(all.status).toBe(200);
  expect(all.json.items.length).toBeGreaterThanOrEqual(2);
  const q = await call('GET', '/api/datasets?q=claims');
  expect(q.json.items.every((d: { slug: string }) => d.slug.includes('claims'))).toBe(true);
});

test('GET :slug returns the schema + a page of rows', async () => {
  const r = await call('GET', '/api/datasets/claims-april');
  expect(r.status).toBe(200);
  expect(r.json.rows).toHaveLength(2);
  expect(r.json.rows[0].claim_id).toBe('CLM-1');
});

test('PATCH retypes a column + toggles PII', async () => {
  const r = await call('PATCH', '/api/datasets/claims-april', {
    columns: [
      { name: 'claim_id', type: 'string' },
      { name: 'amount', type: 'number', pii: true },
      { name: 'email', type: 'string', pii: false },
    ],
  });
  expect(r.status).toBe(200);
  expect(r.json.columns.find((c: { name: string }) => c.name === 'amount').pii).toBe(true);
  expect(r.json.columns.find((c: { name: string }) => c.name === 'email').pii).toBe(false);
});

test('PATCH with a mismatched column set is rejected (422/400)', async () => {
  const r = await call('PATCH', '/api/datasets/claims-april', {
    columns: [{ name: 'only_one', type: 'string' }],
  });
  expect(r.status).toBe(400);
});

test('PATCH cannot drop a column by REPEATING another one', async () => {
  // `[claim_id, claim_id, amount]` has the same length as the stored set and every name in it
  // exists, so the old length+membership check waved it through — and `email` vanished from the
  // schema while its row values stayed behind, unreachable.
  const r = await call('PATCH', '/api/datasets/claims-april', {
    columns: [
      { name: 'claim_id', type: 'string' },
      { name: 'claim_id', type: 'string' },
      { name: 'amount', type: 'number' },
    ],
  });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('duplicate_column');

  const after = await call('GET', '/api/datasets/claims-april');
  expect(after.json.columns.map((c: { name: string }) => c.name).sort()).toEqual([
    'amount', 'claim_id', 'email',
  ]);
});

test('loadInjectedDatasets redacts PII columns when asked, not otherwise', async () => {
  // email was un-flagged in the PATCH above; re-flag a PII col to test redaction.
  await call('PATCH', '/api/datasets/claims-april', {
    columns: [
      { name: 'claim_id', type: 'string' },
      { name: 'amount', type: 'number' },
      { name: 'email', type: 'string', pii: true },
    ],
  });
  const raw = await loadInjectedDatasets(OWNER_ID, ['claims-april'], false);
  expect(raw.datasets['claims-april']!.rows[0]!.email).toBe('a@x.invalid');
  const masked = await loadInjectedDatasets(OWNER_ID, ['claims-april'], true);
  expect(masked.datasets['claims-april']!.rows[0]!.email).toBe('[redacted]');
  expect(masked.datasets['claims-april']!.rows[0]!.amount).toBe(250); // non-PII untouched
});

test('describe_data MCP tool returns the dataset for its owner', async () => {
  const tool = getPlatformTool('describe_data')!;
  const out = (await tool.handler({ slug: 'claims-april' }, { userId: OWNER_ID, tenantId: OWNER_ID, roles: [], db })) as {
    rowCount: number;
    columns: unknown[];
    sample?: unknown[];
  };
  expect(out.rowCount).toBe(2);
  expect(out.columns.length).toBeGreaterThan(0);
  // W8: no example data reaches the AI — no row sample at all.
  expect(out.sample).toBeUndefined();
});

test('another user cannot read the owner\'s dataset (404)', async () => {
  install({ id: OTHER_ID, email: 'other@test', name: 'Other', roles: ['super_admin'], tenantId: OTHER_ID });
  const r = await call('GET', '/api/datasets/claims-april');
  expect(r.status).toBe(404);
  install(owner);
});

test('DELETE removes the dataset + its rows', async () => {
  const r = await call('DELETE', '/api/datasets/cities');
  expect(r.status).toBe(200);
  const gone = await call('GET', '/api/datasets/cities');
  expect(gone.status).toBe(404);
});

// ---- the data-manager gate: `developer` is a data manager, a plain `member` is not ----
//
// ⛔ Regression guard. `canManageData` used to read `ctx.role === 'tenant_admin' || isSuperAdmin`,
// and `ctx.role` is a BINARY — `middleware/tenant.ts:44,90` collapses every realm role that is not
// tenant_admin to `'member'`. So `developer`, the role that exists to author blocks and the
// ontology, could not create the test data its own work binds to: it may call `bindEntitySample`
// (isDeveloper-gated) but not create the dataset that call names. Every dataset had to be routed
// through a tenant_admin. These tests fail with 403 if that gate is ever narrowed back.

test('a `developer` may create test data — the role authors against it', async () => {
  install(developer);
  const r = await call('POST', '/api/datasets', {
    name: 'Dev Owned Set',
    sourceType: 'csv',
    content: 'sku,qty\nA-1,3\nA-2,9\n',
  });
  expect(r.status, 'a developer must be able to create the data its blocks bind to').toBe(201);
  install(owner);
});

test('a `developer` sees canManage=true on the list (the UI gates its upload button on this)', async () => {
  install(developer);
  const r = await call('GET', '/api/datasets');
  expect(r.status).toBe(200);
  expect(r.json.canManage).toBe(true);
  install(owner);
});

test('a plain `member` still cannot create test data, and sees canManage=false', async () => {
  install(plainMember);
  const w = await call('POST', '/api/datasets', {
    name: 'Member Attempt',
    sourceType: 'csv',
    content: 'a,b\n1,2\n',
  });
  expect(w.status, 'widening the gate to developer must not widen it to every member').toBe(403);
  const r = await call('GET', '/api/datasets');
  expect(r.status).toBe(200);
  expect(r.json.canManage).toBe(false);
  install(owner);
});
