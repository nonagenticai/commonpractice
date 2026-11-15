// tests/dataset-duplicate-columns.test.ts — COLUMN NAMES WITHIN A DATASET ARE UNIQUE, ON EVERY
// WRITE PATH.
//
// ⛔ THE DEFECT. Rows are objects keyed by column NAME, so a repeated name is not a cosmetic
// problem — it is DATA LOSS at parse time, before a row is ever inserted. The invariant was
// enforced on exactly ONE of several write paths: `PATCH /api/datasets/:slug` throws
// `duplicate_column` (routes/datasets.ts), while every INGEST path accepted a repeat, persisted it,
// and handed a duplicate name to five frontend screens that key an `{#each}` on it.
//
// Measured on the un-fixed tree, verbatim, `id,Amount,Amount` over `1,100,999`:
//   xlsx  columns = [id, Amount, Amount]     rows = [{ id: 1, Amount: 999 }]   ← the 100 is gone
//   csv   columns = [id, Amount, Amount_1]   rows = [{ id:1, Amount:100, Amount_1:999 }]
//
// ⚠️ THAT CSV LINE IS WHY THE CSV CASES BELOW LOOK ODD, AND IT MATTERS. papaparse (5.5.3) already
// de-duplicates an EXACT repeat on its own ("Duplicate headers found and renamed." → `Amount_1`),
// so `id,Amount,Amount` was never the CSV path's bug. The CSV path broke on a header that differs
// only by WHITESPACE: csv.ts trimmed the field names but left the rows keyed by papaparse's RAW
// header text, so `Amount` + `Amount ` collided AFTER the trim — invisible to papaparse, which had
// already looked at the untrimmed text and found nothing to rename. A test that only fed CSV an
// exact repeat would have passed against the BROKEN code and proved nothing.
//
// ⚠️ THE WHITESPACE BUG DID NOT NEED A DUPLICATE TO FIRE AT ALL — see the `" a , b "` case. That
// same trim/key mismatch silently replaced a whole column's values with nulls.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { parseCsv, parseJson, parseText, parseSqlPaste } from '../src/datasets/parse';
import { parseXlsx } from '../src/datasets/parse/xlsx';
import { uniqueColumnNames, finalize } from '../src/datasets/parse/infer';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerDatasetRoutes } from '../src/routes/datasets';
import { db, users, datasets, datasetRows } from '../src/db/client';
import { readRows } from '../src/datasets/dataset-service';
import type { User } from '../src/types';

const names = (r: { columns: { name: string }[] }) => r.columns.map((c) => c.name);
/** The property every ingest path must satisfy, stated once. */
function expectUniqueNames(r: { columns: { name: string }[] }, where: string) {
  const n = names(r);
  expect(new Set(n).size, `${where} produced a duplicate column name: ${JSON.stringify(n)}`).toBe(
    n.length,
  );
}

async function xlsxOf(rows: unknown[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data');
  for (const r of rows) ws.addRow(r);
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

// ---- the unit the whole fix funnels through --------------------------------------------------

test('uniqueColumnNames: order preserved, repeats suffixed, renames reported', () => {
  expect(uniqueColumnNames(['id', 'Amount', 'Amount'])).toEqual({
    names: ['id', 'Amount', 'Amount_1'],
    renamed: [{ from: 'Amount', to: 'Amount_1' }],
  });
  // Nothing to do on the ordinary path — and `renamed` empty is what keeps the route quiet.
  expect(uniqueColumnNames(['a', 'b'])).toEqual({ names: ['a', 'b'], renamed: [] });
});

test('uniqueColumnNames: a MINTED name cannot collide with a later real one', () => {
  // `row_number()`-style numbering would emit [X, X_1, X_1] here — still a duplicate. The `taken`
  // set is what makes the third distinct.
  expect(uniqueColumnNames(['X', 'X', 'X_1']).names).toEqual(['X', 'X_1', 'X_1_1']);
});

// ---- XLSX: the path that lost data unconditionally --------------------------------------------

test('⛔ xlsx: a repeated header keeps BOTH columns AND both values', async () => {
  const r = await parseXlsx(await xlsxOf([['id', 'Amount', 'Amount'], [1, 100, 999], [2, 200, 888]]));

  expectUniqueNames(r, 'parseXlsx');
  expect(names(r)).toEqual(['id', 'Amount', 'Amount_1']);
  // ⛔ THE ASSERTION THAT INVERTS ON A REVERT. The old code produced { id: 1, Amount: 999 } — the
  // 100 overwritten by the second column and unreachable. Asserting the whole row object (not just
  // that `Amount_1` exists) is what pins BOTH halves: the column was added AND it took the right
  // value, and the first column kept its own.
  expect(r.rows).toEqual([
    { id: 1, Amount: 100, Amount_1: 999 },
    { id: 2, Amount: 200, Amount_1: 888 },
  ]);
  expect(r.renamedColumns).toEqual([{ from: 'Amount', to: 'Amount_1' }]);
});

test('xlsx: three-way repeat, and the sample no longer reads off the wrong column', async () => {
  const r = await parseXlsx(await xlsxOf([['n', 'n', 'n', 'ok'], [1, 2, 3, true]]));
  expectUniqueNames(r, 'parseXlsx');
  expect(names(r)).toEqual(['n', 'n_1', 'n_2', 'ok']);
  expect(r.rows).toEqual([{ n: 1, n_1: 2, n_2: 3, ok: true }]);
  // Pre-fix every `n` column reported the LAST column's value as its representative sample, because
  // `firstSample` looked all three up under the one surviving key.
  expect(r.columns.map((c) => c.sample)).toEqual([1, 2, 3, true]);
});

test('xlsx: an ordinary header is untouched — no gratuitous renaming', async () => {
  const r = await parseXlsx(await xlsxOf([['id', 'name'], [1, 'A']]));
  expect(names(r)).toEqual(['id', 'name']);
  expect(r.renamedColumns).toEqual([]);
});

// ---- CSV: the trim/key mismatch ---------------------------------------------------------------

test('⛔ csv: a header differing only by WHITESPACE is a duplicate after trimming', () => {
  // papaparse sees `Amount` vs `Amount ` as distinct and renames nothing; the trim then collides
  // them. Pre-fix: columns [id, Amount, Amount] and rows [{ id:1, Amount:100 }] — 999 dropped.
  const r = parseCsv('id,Amount,Amount \n1,100,999\n');
  expectUniqueNames(r, 'parseCsv');
  expect(names(r)).toEqual(['id', 'Amount', 'Amount_1']);
  expect(r.rows).toEqual([{ id: 1, Amount: 100, Amount_1: 999 }]);
  expect(r.renamedColumns).toEqual([{ from: 'Amount', to: 'Amount_1' }]);
});

test('⛔ csv: whitespace in a header no longer blanks the column — NO duplicate involved', () => {
  // The same root cause with the duplicate removed entirely. Pre-fix this returned
  // [{ a: null, b: null }]: names came from the TRIMMED list, values were keyed by the RAW one.
  const r = parseCsv(' a , b \n1,2\n3,4\n');
  expect(names(r)).toEqual(['a', 'b']);
  expect(r.rows).toEqual([
    { a: 1, b: 2 },
    { a: 3, b: 4 },
  ]);
  expect(r.renamedColumns).toEqual([]);
});

test('csv: an exact repeat still works (papaparse already renamed it) and reports no rename of ours', () => {
  const r = parseCsv('id,Amount,Amount\n1,100,999\n');
  expectUniqueNames(r, 'parseCsv');
  expect(names(r)).toEqual(['id', 'Amount', 'Amount_1']);
  expect(r.rows).toEqual([{ id: 1, Amount: 100, Amount_1: 999 }]);
  // papaparse did it upstream, so WE renamed nothing — the report must not claim a change we did
  // not make. This is also the case that pins our suffix to papaparse's, so csv and xlsx agree.
  expect(r.renamedColumns).toEqual([]);
});

test('csv: a blank header column is still dropped, and drops the right values', () => {
  const r = parseCsv('a,,b\n1,2,3\n');
  expect(names(r)).toEqual(['a', 'b']);
  expect(r.rows).toEqual([{ a: 1, b: 3 }]);
});

test('csv: sql-paste inherits the same treatment (it delegates to parseCsv)', () => {
  const r = parseSqlPaste('id,Amount,Amount \n1,100,999\n');
  expectUniqueNames(r, 'parseSqlPaste');
  expect(names(r)).toEqual(['id', 'Amount', 'Amount_1']);
});

// ---- the funnel, and the paths where a repeat is structurally impossible -----------------------

test('finalize: the backstop holds the invariant for any FUTURE caller', () => {
  // json/text/sql-json/postgres derive names from OBJECT KEYS, which cannot repeat — so nothing
  // reaches this today. It exists so a new parser cannot quietly reopen the hole, and it is the
  // reason the invariant is one line rather than one line per source.
  const r = finalize(['a', 'a'], [{ a: 1 }]);
  expect(names(r)).toEqual(['a', 'a_1']);
  expect(r.renamedColumns).toEqual([{ from: 'a', to: 'a_1' }]);
});

test('json / text: unchanged, and every parser reports renamedColumns as a real array', () => {
  const j = parseJson('[{"a":1,"b":"x"}]');
  expectUniqueNames(j, 'parseJson');
  expect(j.renamedColumns).toEqual([]);

  const t = parseText('first\nsecond\n');
  expectUniqueNames(t, 'parseText');
  // ⚠️ NOT `toBeFalsy()`. A caller that treats `undefined` as "nothing happened" is exactly how a
  // never-silent field goes silent; every parser must return the array.
  expect(Array.isArray(t.renamedColumns)).toBe(true);
});

// ---- THE REAL HTTP UPLOAD PATH -----------------------------------------------------------------
//
// The parser cases above are pure. This drives `POST /api/datasets` end-to-end against a real
// Postgres so the claim is about what is PERSISTED and what a client is TOLD, not about a function
// in isolation — an invariant that holds in the parser and is dropped by the route would look
// identical from up there.
// New ids in THIS file only — the fixture-id ratchet (tests/fixture-id-collisions.test.ts) flags an
// id that appears in more than one file.
const DUP_OWNER = '00000000-0000-0000-0000-0000da7a0011';
const dupOwner: User = {
  id: DUP_OWNER,
  email: 'dup@test',
  name: 'Dup Owner',
  roles: ['super_admin', 'employee'],
  tenantId: DUP_OWNER,
};

const dupRouter = new Router();
registerDatasetRoutes(dupRouter);

async function post(body: unknown) {
  const matched = dupRouter.match('POST', '/api/datasets')!;
  const isForm = body instanceof FormData;
  const req = new Request('http://localhost/api/datasets', {
    method: 'POST',
    headers: isForm ? undefined : { 'content-type': 'application/json' },
    body: isForm ? (body as FormData) : JSON.stringify(body),
  });
  const res = await matched.handler(req);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function dupCleanup() {
  const owned = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, DUP_OWNER));
  for (const d of owned) await db.delete(datasetRows).where(eq(datasetRows.dataset_id, d.id));
  await db.delete(datasets).where(eq(datasets.owner_id, DUP_OWNER));
  await db.delete(users).where(eq(users.id, DUP_OWNER));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for HOOKS (see bunfig.toml's note),
// so a slow one would fail as "(unnamed) [5003ms]" with no file or cause attached.
beforeAll(async () => {
  await dupCleanup();
  __setAuthOverridesForTests({ validateAuth: async () => dupOwner });
}, 30_000);
afterAll(async () => {
  await dupCleanup();
  __setAuthOverridesForTests(undefined);
}, 30_000);

test('⛔ POST /api/datasets (xlsx): a repeated header persists as TWO columns with BOTH values', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data');
  ws.addRow(['id', 'Amount', 'Amount']);
  ws.addRow([1, 100, 999]);
  const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const form = new FormData();
  form.append(
    'file',
    new File([buf], 'dupes.xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  );

  const r = await post(form);
  expect(r.status).toBe(201);
  expect(r.json.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'Amount', 'Amount_1']);
  // NEVER SILENT — the uploader is told which header was renamed, not left to discover it.
  expect(r.json.renamedColumns).toEqual([{ from: 'Amount', to: 'Amount_1' }]);

  // ⛔ WHAT IS ACTUALLY IN THE TABLE. The response could be right while the persisted rows are not;
  // pre-fix the stored row was { id: 1, Amount: 999 } and the 100 was unrecoverable from the DB.
  const [row] = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.slug, r.json.slug));
  const stored = await readRows(row!.id, 10, 0);
  expect(stored).toEqual([{ id: 1, Amount: 100, Amount_1: 999 }]);
}, 30_000);

test('POST /api/datasets (csv paste): whitespace-collided headers persist both columns', async () => {
  const r = await post({
    name: 'Dup Csv',
    sourceType: 'csv',
    content: 'id,Amount,Amount \n1,100,999\n',
  });
  expect(r.status).toBe(201);
  expect(r.json.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'Amount', 'Amount_1']);
  expect(r.json.renamedColumns).toEqual([{ from: 'Amount', to: 'Amount_1' }]);
  expect(r.json.preview).toEqual([{ id: 1, Amount: 100, Amount_1: 999 }]);
});

test('POST /api/datasets: an ordinary upload reports renamedColumns as an empty array, not absent', async () => {
  // ⚠️ The field must always be PRESENT. `undefined` would let a client's `if (renamedColumns)`
  // and its `.length` disagree about whether anything happened.
  const r = await post({ name: 'Clean Csv', sourceType: 'csv', content: 'a,b\n1,2\n' });
  expect(r.status).toBe(201);
  expect(r.json.renamedColumns).toEqual([]);
});

test('the PATCH guard and the ingest path now agree — a repaired schema is editable', async () => {
  // ⛔ THE DEAD END THIS CLOSES. PATCH compares submitted names as a SET against the stored SET, so
  // a stored `{Amount, Amount}` is a 1-element set no 2-element submission can match, and a
  // submission repeating the name trips `duplicate_column`. A dataset the uploader was allowed to
  // create could never be edited by a human. With unique names the round-trip simply works.
  const created = await post({
    name: 'Patchable Dup',
    sourceType: 'csv',
    content: 'id,Amount,Amount \n1,100,999\n',
  });
  expect(created.status).toBe(201);

  const matched = dupRouter.match('PATCH', `/api/datasets/${created.json.slug}`)!;
  const res = await matched.handler(
    new Request(`http://localhost/api/datasets/${created.json.slug}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        columns: created.json.columns.map((c: { name: string; type: string }) => ({
          name: c.name,
          type: c.type,
          pii: c.name === 'Amount_1',
        })),
      }),
    }),
    ...matched.params,
  );
  expect(res.status).toBe(200);
  const patched = (await res.json()) as { columns: { name: string; pii?: boolean }[] };
  expect(patched.columns.find((c) => c.name === 'Amount_1')?.pii).toBe(true);
}, 30_000);
