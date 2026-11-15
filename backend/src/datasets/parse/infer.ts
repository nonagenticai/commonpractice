// src/datasets/parse/infer.ts — shared schema inference for the dataset parsers.
// Given raw rows + an ordered column-name list, infer each column's type (from a
// sample), flag likely-PII columns by name, and coerce string cells (CSV/Excel) to
// their typed JS form so the runner receives real numbers/booleans, not strings.
// Plus the row/size caps (SPEC-PHASE2 §2.7) with explicit truncation reporting.
import {
  type ColumnRename,
  type DatasetColumn,
  type DatasetColumnType,
  type ParsedDataset,
  DATASET_MAX_ROWS,
} from '../../db/dataset-types';

// Column-name heuristic → suggests pii:true (the dev confirms/edits in the UI).
const PII_RE =
  /(^|[_\s-])(e[-_]?mail|ssn|sin|iban|bic|swift|phone|tel|mobile|dob|birth(date)?|first[_\s-]?name|last[_\s-]?name|sur[_\s-]?name|full[_\s-]?name|name|address|street|zip|post[_\s-]?code|passport|credit[_\s-]?card|card[_\s-]?number|account[_\s-]?number)([_\s-]|$)/i;

export function isPiiName(name: string): boolean {
  return PII_RE.test(name.trim());
}

// Pure ISO-ish date detector (YYYY-MM-DD, optionally with a time). Deliberately
// strict so "12-34" style strings stay `string`.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?)?$/;
// Integer or decimal WITHOUT a leading zero (so a zip like "0123" stays a string).
const NUMERIC_RE = /^-?(0|[1-9]\d*)(\.\d+)?$/;

type CellType = DatasetColumnType | 'empty';

/** What every parser returns: `finalize`'s output. Declared here, beside the only function that
 *  produces it, so a new parser cannot spell the shape slightly differently and drop a field.
 *  `parse/index.ts` re-exports it as `ParseResult` (the name the routes already use). */
export interface FinalizedDataset extends ParsedDataset {
  /** Rows dropped at the row cap — never silent (SPEC-PHASE2 §2.7). */
  truncated: number;
  /** Duplicate column names disambiguated at parse — never silent, same rule. */
  renamedColumns: ColumnRename[];
}

/** Classify a single raw cell value (string or already-typed). */
export function inferCellType(raw: unknown): CellType {
  if (raw === null || raw === undefined) return 'empty';
  if (typeof raw === 'number') return Number.isFinite(raw) ? 'number' : 'string';
  if (typeof raw === 'boolean') return 'boolean';
  if (raw instanceof Date) return 'date';
  if (typeof raw === 'object') return 'json';
  const s = String(raw).trim();
  if (s === '') return 'empty';
  if (/^(true|false)$/i.test(s)) return 'boolean';
  if (NUMERIC_RE.test(s) && Number.isFinite(Number(s))) return 'number';
  if (ISO_DATE_RE.test(s)) return 'date';
  return 'string';
}

const SAMPLE_SIZE = 200;

/** Reduce a column's sampled cell types to one column type. Mixed/typeless → string. */
function reduceColumnType(types: CellType[]): DatasetColumnType {
  const seen = new Set(types.filter((t) => t !== 'empty'));
  if (seen.size === 0) return 'string';
  if (seen.size === 1) return [...seen][0] as DatasetColumnType;
  if (seen.has('json')) return 'json';
  return 'string';
}

/** First non-empty value in a column (for the schema preview). */
function firstSample(rows: Record<string, unknown>[], name: string): unknown {
  for (const r of rows) {
    const v = r[name];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return undefined;
}

/**
 * Make an ordered column-name list UNIQUE, preserving order, reporting what it changed.
 *
 * ⛔ THE INVARIANT THIS EXISTS TO HOLD: column names within a dataset are unique. It was enforced
 * on exactly ONE of several write paths — `PATCH /api/datasets/:slug` (routes/datasets.ts) throws
 * `duplicate_column` — while every INGEST path accepted a repeat and persisted it.
 *
 * ⛔ AND A DUPLICATE NAME IS NOT A COSMETIC PROBLEM, IT IS DATA LOSS, because rows are OBJECTS
 * KEYED BY COLUMN NAME. Two columns called `Amount` are one key: the second write wins and the
 * first column's values are unreachable, from the parser onward. Measured on the xlsx path before
 * this change, for `id,Amount,Amount` over `1,100,999`:
 *   columns = [id, Amount, Amount]        (three columns)
 *   rows    = [{ id: 1, Amount: 999 }]    (two keys — the 100 is GONE)
 * That is why this returns NAMES TO KEY BY rather than throwing: it must run BEFORE the parser
 * builds its row objects, at which point nothing has been lost yet. A guard placed after keying
 * could only ever report the loss, never prevent it.
 *
 * ⚠️ THE SUFFIX IS papaparse's, DELIBERATELY. papaparse (5.5.3) already de-duplicates an exact
 * repeat in a CSV header on its own — `id,Amount,Amount` arrives as `['id','Amount','Amount_1']`
 * with a "Duplicate headers found and renamed." warning — and has for years. So `_1`/`_2` is not a
 * convention invented here; it is the one the CSV path has silently shipped all along, and using
 * it is what makes csv and xlsx produce the SAME schema for the same table. Rejecting the upload
 * instead (the other candidate fix) would have made CSV *stricter than it is today* and broken
 * files that currently import fine.
 *
 * The `taken` set grows as it goes, so a generated name can never collide with a later raw one:
 * `Amount,Amount,Amount_1` → `Amount, Amount_1, Amount_1_1`. Ugly, and unique, which is the job.
 */
export function uniqueColumnNames(raw: string[]): { names: string[]; renamed: ColumnRename[] } {
  const taken = new Set<string>();
  const names: string[] = [];
  const renamed: ColumnRename[] = [];
  for (const name of raw) {
    if (!taken.has(name)) {
      taken.add(name);
      names.push(name);
      continue;
    }
    let n = 1;
    let candidate = `${name}_${n}`;
    while (taken.has(candidate)) candidate = `${name}_${++n}`;
    taken.add(candidate);
    names.push(candidate);
    renamed.push({ from: name, to: candidate });
  }
  return { names, renamed };
}

/** Infer the typed column schema for an ordered set of column names. */
export function inferColumns(
  orderedNames: string[],
  rows: Record<string, unknown>[],
): DatasetColumn[] {
  const sample = rows.slice(0, SAMPLE_SIZE);
  return orderedNames.map((name) => {
    const type = reduceColumnType(sample.map((r) => inferCellType(r[name])));
    const col: DatasetColumn = { name, type };
    if (isPiiName(name)) col.pii = true;
    const s = firstSample(rows, name);
    if (s !== undefined) col.sample = s;
    return col;
  });
}

/** Coerce one raw cell to the column's inferred type. Untyped/blank → null. */
export function coerceCell(raw: unknown, type: DatasetColumnType): unknown {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  switch (type) {
    case 'number': {
      if (typeof raw === 'number') return raw;
      const n = Number(String(raw).trim());
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      return /^true$/i.test(String(raw).trim());
    case 'json':
      if (typeof raw === 'string') {
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      }
      return raw;
    case 'date':
      return raw instanceof Date ? raw.toISOString() : String(raw).trim();
    case 'string':
    default:
      return typeof raw === 'string' ? raw : String(raw);
  }
}

/** Apply the inferred column types across every row (string cells → typed values). */
export function coerceRows(
  rows: Record<string, unknown>[],
  columns: DatasetColumn[],
): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const col of columns) out[col.name] = coerceCell(row[col.name], col.type);
    return out;
  });
}

/** Union of keys across rows, preserving first-seen order (for JSON sources). */
export function orderedKeys(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        order.push(k);
      }
    }
  }
  return order;
}

/** JSON byte size of the row payload (for the size cap + size_bytes column). */
export function byteSize(rows: Record<string, unknown>[]): number {
  return Buffer.byteLength(JSON.stringify(rows), 'utf8');
}

/** Cap a row array, reporting whether it was truncated (never silent — §2.7). */
export function capRows<T>(
  rows: T[],
  max = DATASET_MAX_ROWS,
): { rows: T[]; truncated: number } {
  if (rows.length <= max) return { rows, truncated: 0 };
  return { rows: rows.slice(0, max), truncated: rows.length - max };
}

/**
 * Finalise a raw {names, rows} into a typed, capped ParsedDataset.
 *
 * ⛔ THE ONE FUNNEL. Every source that can ever produce a dataset ends here — parse/csv.ts,
 * parse/xlsx.ts, parse/json.ts, parse/text.ts, parse/sql.ts (via json/csv), and the postgres
 * connector (connectors/postgres.ts); the http and storage connectors go through parseCsv /
 * parseJson / parseXlsx, and a connector REFRESH re-inflates this same output through
 * `mergeRefreshedColumns`, which is a 1:1 `inferred.map(...)` and so cannot reintroduce a
 * duplicate. Putting `uniqueColumnNames` here is what makes the invariant hold on EVERY write
 * path rather than on the one that happened to guard it.
 *
 * ⚠️ THE BACKSTOP CANNOT UN-LOSE DATA, WHICH IS WHY IT IS NOT THE ONLY CALL SITE. By the time
 * rows reach this function they are already keyed; renaming the 3rd `Amount` to `Amount_2` here
 * would yield a column whose values nothing holds. The two parsers that BUILD row keys from a
 * header row — csv and xlsx — therefore uniquify first and key their rows by the result, and pass
 * what they changed in as `renamedByCaller`. This call is then idempotent for them (already
 * unique), and covers the paths where a duplicate is structurally impossible anyway (json/text/
 * sql-json/postgres all derive names from OBJECT KEYS, which cannot repeat) so that a future
 * caller cannot quietly reopen the hole.
 */
export function finalize(
  orderedNames: string[],
  rawRows: Record<string, unknown>[],
  renamedByCaller: ColumnRename[] = [],
): FinalizedDataset {
  const { rows: capped, truncated } = capRows(rawRows);
  const { names, renamed } = uniqueColumnNames(orderedNames);
  const columns = inferColumns(names, capped);
  const rows = coerceRows(capped, columns);
  return { columns, rows, truncated, renamedColumns: [...renamedByCaller, ...renamed] };
}
