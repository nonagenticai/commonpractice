// src/datasets/parse/xlsx.ts — Excel (.xlsx) → {columns, rows} via exceljs (pure-JS,
// Bun-safe). First worksheet by default; the first row is the header. Cells are
// normalised to primitives (exceljs wraps formulas/rich-text/hyperlinks in objects).
//
// Row cap ordering (residual-risk note — read before touching this file):
// `wb.xlsx.load()` below materializes the FULL parsed workbook (every cell of every
// row) BEFORE `finalize()`'s capRows ever runs — a small, highly-repetitive .xlsx, well
// under DATASET_MAX_BYTES *compressed*, can decompress to a huge in-memory document
// (zip-bomb-shaped) and OOM the shared API process. Reproduced locally: a 10 MB
// compressed / 500k-row file (93 MB uncompressed worksheet XML) crashed `wb.xlsx.load()`
// with a JS heap OOM under a 300 MB heap limit.
//
// exceljs also ships a genuinely streaming reader (`ExcelJS.stream.xlsx.WorkbookReader`)
// that reads row-by-row and lets a caller stop early — the obvious "bound it before
// materialization" fix. It was tried here and reverted: its worksheet parser reads
// `this.model.sheets` (populated only once `xl/workbook.xml` has been parsed), but
// `xl/workbook.xml` is NOT guaranteed to precede the worksheet entries in the zip — and
// critically, exceljs's OWN non-streaming writer (`Workbook#xlsx.writeBuffer()`, used
// throughout this codebase's tests and by anything that round-trips a workbook) writes
// `xl/workbook.xml` LAST. The streaming reader crashes
// (`TypeError: Cannot read properties of undefined (reading 'sheets')`) on that
// mainstream case, not just a contrived adversarial one — not a safe drop-in.
//
// So: the mitigation here is a cheap PRE-PARSE guard, not a parse-time cap. Before
// `wb.xlsx.load()` ever runs, peek at the zip's central directory (no decompression —
// entry sizes are declared metadata) and reject a file whose worksheet XML would
// decompress far past any sane multiple of DATASET_MAX_ROWS. This is a heuristic, not
// an exact row-count check — see assertWorksheetSizeBounded's doc for the calibration
// and the honestly-documented residual risk.
import ExcelJS from 'exceljs';
import { Open as unzipOpen } from 'unzipper';
import { badRequest } from '../../utils/http';
import { type FinalizedDataset, finalize, uniqueColumnNames } from './infer';

/** Flatten an exceljs cell value to a plain primitive. */
function cellPrimitive(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('text' in o) return o.text; // rich text / hyperlink
    if ('result' in o) return o.result; // formula → computed result
    if ('hyperlink' in o) return o.hyperlink;
    return null;
  }
  return v;
}

/**
 * Reject a .xlsx whose worksheet XML would decompress past a sane bound, BEFORE
 * exceljs ever parses it. Uncompressed-bytes-per-row is roughly constant regardless of
 * cell CONTENT — exceljs writes shared-string TABLE REFERENCES into `<c>` elements, not
 * the string itself, so highly-repetitive VALUES don't shrink the row markup the way
 * they'd shrink a naive CSV. Measured here: a realistic 50,000-row × 5-column file
 * (id/name/email/amount/notes, ordinary content) produced ~11 MB of uncompressed
 * worksheet XML; a proven-to-OOM 500,000-row narrow file produced ~93 MB. The 60 MB
 * threshold below sits with generous headroom over the former (comfortably covers
 * wider/richer legitimate tables — several times the realistic baseline) and well under
 * the latter.
 *
 * Honest residual risk: this is a heuristic, not a row count. A legitimate, extremely
 * wide/verbose table at or near DATASET_MAX_ROWS could in principle be rejected here —
 * there is no way to distinguish that from an adversarial file without parsing it,
 * which is exactly the unbounded operation this guard exists to avoid. Sums ALL
 * worksheet entries (not just the requested/first sheet), so a multi-sheet workbook
 * shares one budget across sheets — simpler and more conservative than replicating
 * exceljs's sheet-order resolution just to size-check the one sheet we'll actually read.
 */
const MAX_WORKSHEET_UNCOMPRESSED_BYTES = 60 * 1024 * 1024; // 60 MB

async function assertWorksheetSizeBounded(buf: Buffer): Promise<void> {
  let total = 0;
  try {
    const zip = await unzipOpen.buffer(buf);
    for (const entry of zip.files) {
      if (entry.path.startsWith('xl/worksheets/') && entry.path.endsWith('.xml')) {
        total += entry.uncompressedSize;
      }
    }
  } catch {
    // Not a readable zip at all — let exceljs's own load() produce the real, specific
    // error message rather than us guessing at one here.
    return;
  }
  if (total > MAX_WORKSHEET_UNCOMPRESSED_BYTES) {
    const mb = (n: number) => Math.round(n / 1_048_576);
    throw badRequest(
      'xlsx_too_large',
      `This Excel file's sheet data decompresses to ~${mb(total)} MB, over the ${mb(
        MAX_WORKSHEET_UNCOMPRESSED_BYTES,
      )} MB limit — checked before parsing so an oversized sheet is never loaded into memory.`,
      // Raw MB numbers, not the rounded strings above: a locale rounds and separates its own.
      {
        actualMb: total / 1_048_576,
        limitMb: MAX_WORKSHEET_UNCOMPRESSED_BYTES / 1_048_576,
      },
    );
  }
}

export async function parseXlsx(
  buf: ArrayBuffer | Uint8Array,
  sheetName?: string,
): Promise<FinalizedDataset> {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const nodeBuf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  await assertWorksheetSizeBounded(nodeBuf);

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(nodeBuf as unknown as ArrayBuffer);
  } catch {
    throw badRequest('xlsx_unreadable', 'Could not read the Excel file');
  }
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) throw badRequest('xlsx_no_sheet', 'The workbook has no readable sheet');

  // Header = row 1. exceljs row.values is 1-indexed (values[0] is undefined).
  const headerRow = ws.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    const name = cellPrimitive(cell.value);
    headers[col] = name === null || name === undefined ? '' : String(name).trim();
  });
  // ⛔ A REPEATED HEADER USED TO SILENTLY EAT A COLUMN. `headers` is 1-indexed and sparse, and the
  // row loop below writes `obj[key] = val` — so two `Amount` headers were ONE key, last write wins.
  // Measured on `id,Amount,Amount` over `1,100,999`:
  //     columns = [id, Amount, Amount]     rows = [{ id: 1, Amount: 999 }]
  // Three columns, two keys, the 100 unreachable — and the duplicate NAME then reached five
  // frontend screens that key an `{#each}` on it, each of which throws `each_key_duplicate`.
  // Unlike CSV, exceljs does no de-duplication of its own, so this path had no cover at all.
  //
  // Resolve the header row to (spreadsheet column → unique name) ONCE, before a single row object
  // is built, and key the rows by that. `col` is retained rather than re-derived: it is the cell
  // address the value comes from, and it is what makes the two `Amount`s two distinct reads.
  const kept: { col: number; name: string }[] = [];
  for (let col = 1; col < headers.length; col++) {
    const name = headers[col];
    if (name) kept.push({ col, name });
  }
  if (kept.length === 0) {
    throw badRequest('xlsx_no_header', 'The first row must contain column names');
  }
  const { names, renamed } = uniqueColumnNames(kept.map((k) => k.name));

  const rows: Record<string, unknown>[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // header
    const obj: Record<string, unknown> = {};
    let any = false;
    kept.forEach((k, i) => {
      const val = cellPrimitive(row.getCell(k.col).value);
      if (val !== null && val !== '') any = true;
      obj[names[i]!] = val;
    });
    if (any) rows.push(obj);
  });

  return finalize(names, rows, renamed);
}
