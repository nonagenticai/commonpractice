// tests/dataset-parse.test.ts — the ingestion parsers (Phase 2.0): CSV / Excel /
// JSON / text / SQL-paste → typed {columns, rows}, type inference, PII heuristic,
// and the row caps. Pure (no DB).
import { test, expect } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { parseCsv, parseJson, parseText, parseSqlPaste } from '../src/datasets/parse';
import { parseXlsx } from '../src/datasets/parse/xlsx';
import { inferColumns, coerceRows, capRows, isPiiName } from '../src/datasets/parse/infer';
import { DATASET_MAX_ROWS } from '../src/db/dataset-types';
import type { HttpError } from '../src/utils/http';

test('CSV: header → typed columns, cells coerced, PII flagged by name', () => {
  const csv = 'name,age,active,email\nAlice,30,true,a@x.invalid\nBob,25,false,b@x.invalid\n';
  const { columns, rows } = parseCsv(csv);
  const col = (n: string) => columns.find((c) => c.name === n)!;
  expect(col('name').type).toBe('string');
  expect(col('age').type).toBe('number');
  expect(col('active').type).toBe('boolean');
  expect(col('email').pii).toBe(true);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ name: 'Alice', age: 30, active: true });
  expect(rows[0]!.age).toBe(30); // coerced to a real number, not "30"
});

test('CSV: a leading-zero value stays a string (zip-code safety)', () => {
  const { columns } = parseCsv('zip\n0123\n0456\n');
  expect(columns[0]!.type).toBe('string');
});

test('JSON: array of objects → rows; key union preserves order', () => {
  const { columns, rows } = parseJson('[{"a":1,"b":"x"},{"a":2,"c":true}]');
  expect(columns.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  expect(rows).toHaveLength(2);
  expect(columns.find((c) => c.name === 'a')!.type).toBe('number');
});

test('JSON: a single object → one row', () => {
  const { rows } = parseJson('{"x":1}');
  expect(rows).toHaveLength(1);
});

test('text: one row per non-empty line ({line,text})', () => {
  const { columns, rows } = parseText('first\n\nsecond\n');
  expect(columns.map((c) => c.name)).toEqual(['line', 'text']);
  expect(rows).toEqual([
    { line: 1, text: 'first' },
    { line: 2, text: 'second' },
  ]);
});

test('SQL-paste: JSON result and CSV result both parse', () => {
  const j = parseSqlPaste('[{"id":1,"name":"A"}]');
  expect(j.rows).toEqual([{ id: 1, name: 'A' }]);
  const c = parseSqlPaste('id,name\n1,A\n');
  expect(c.rows).toEqual([{ id: 1, name: 'A' }]);
});

test('Excel: first sheet, header row, typed cells', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('data');
  ws.addRow(['name', 'amount']);
  ws.addRow(['Claim 1', 250]);
  ws.addRow(['Claim 2', 980]);
  const buf = (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  const { columns, rows } = await parseXlsx(new Uint8Array(buf));
  expect(columns.map((c) => c.name)).toEqual(['name', 'amount']);
  expect(columns.find((c) => c.name === 'amount')!.type).toBe('number');
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ name: 'Claim 2', amount: 980 });
});

// ---- PII-gaps hunt, FIX 3 — the xlsx row cap was enforced only AFTER full
// materialization: wb.xlsx.load() built the WHOLE parsed Workbook (every cell of every
// row) in memory BEFORE finalize()'s capRows ever ran. A small, highly-repetitive
// .xlsx — well under DATASET_MAX_BYTES *compressed* — can decompress to a huge
// worksheet XML (zip-bomb-shaped) and OOM the shared API process. Reproduced locally:
// a 10 MB compressed / 500k-row file (93 MB uncompressed worksheet XML) crashed
// wb.xlsx.load() with a JS heap OOM under a 300 MB heap limit.
//
// A genuinely streaming, row-by-row reader (exceljs's own WorkbookReader) was tried
// and reverted: it crashes on any file whose zip entries put xl/workbook.xml AFTER
// the worksheet — which is how exceljs's OWN non-streaming writer orders them, so it
// broke on ordinary round-tripped workbooks, not just adversarial ones. The shipped
// mitigation is a cheap PRE-PARSE guard: peek at the zip's central directory (declared
// entry sizes, no decompression) and reject a file whose worksheet XML would
// decompress past a sane bound BEFORE wb.xlsx.load() ever runs. See xlsx.ts's
// assertWorksheetSizeBounded doc for the size calibration and the honestly-documented
// residual risk (a heuristic, not an exact row count).
async function writeRepetitiveXlsx(rows: number): Promise<Uint8Array> {
  const file = join(tmpdir(), `xlsx-guard-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: file,
    useStyles: false,
    useSharedStrings: true,
  });
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['id', 'name', 'email']).commit();
  for (let i = 0; i < rows; i++) {
    ws.addRow([i, 'Repeated Person Name', 'person@example.com']).commit();
  }
  await ws.commit();
  await wb.commit();
  try {
    return new Uint8Array(await readFile(file));
  } finally {
    await unlink(file).catch(() => {});
  }
}

test('xlsx: a small, highly-repetitive file is rejected BEFORE materialization, not after', async () => {
  // 450,000 narrow rows decompresses to ~69 MB of worksheet XML (comfortably over the
  // 60 MB guard, comfortably under the proven-to-OOM 93 MB/500k-row case) while still
  // being quick and safe to fully parse in-process for a "does the OLD code even
  // attempt it" comparison — see PR notes for why an actual multi-hundred-MB fixture
  // isn't exercised in an automated test.
  const bytes = await writeRepetitiveXlsx(450_000);
  const err = await parseXlsx(bytes).then(
    () => {
      throw new Error('parseXlsx resolved — the guard did not fire');
    },
    (e: unknown) => e as HttpError,
  );
  expect(err).toMatchObject({ code: 'xlsx_too_large', status: 400 });
  // Both sizes must reach the client as raw NUMBERS in `details`, not only baked into the English
  // sentence: a locale catalog rebuilds that sentence and formats/rounds its own numbers.
  expect(err.details).toMatchObject({ limitMb: 60 });
  expect(err.details?.actualMb as number).toBeGreaterThan(60);
}, 30_000);

test('xlsx: a normal-sized file with rows over the cap still parses + truncates normally', async () => {
  // The guard must not fire on ordinary content — DATASET_MAX_ROWS + a modest overshoot,
  // 2 columns, well under the 60 MB threshold.
  const bytes = await writeRepetitiveXlsx(DATASET_MAX_ROWS + 500);
  const { rows, truncated } = await parseXlsx(bytes);
  expect(rows).toHaveLength(DATASET_MAX_ROWS);
  expect(truncated).toBe(500); // exact — the existing post-parse capRows is untouched
}, 30_000);

test('PII heuristic matches the obvious column names', () => {
  for (const n of ['email', 'ssn', 'phone', 'dob', 'first_name', 'home_address'])
    expect(isPiiName(n)).toBe(true);
  for (const n of ['amount', 'status', 'claim_id']) expect(isPiiName(n)).toBe(false);
});

test('capRows truncates and reports the dropped count', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ i }));
  const { rows: capped, truncated } = capRows(rows, 10);
  expect(capped).toHaveLength(10);
  expect(truncated).toBe(2);
});

test('inferColumns + coerceRows round-trips mixed string cells', () => {
  const raw = [{ n: '1', b: 'false' }, { n: '2', b: 'true' }];
  const cols = inferColumns(['n', 'b'], raw);
  const typed = coerceRows(raw, cols);
  expect(typed).toEqual([{ n: 1, b: false }, { n: 2, b: true }]);
});
