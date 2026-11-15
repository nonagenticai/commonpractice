// src/datasets/parse/csv.ts — CSV → {columns, rows}. papaparse handles quoting,
// embedded newlines, and delimiter sniffing; we infer column types + coerce cells.
import Papa from 'papaparse';
import { badRequest } from '../../utils/http';
import { type FinalizedDataset, finalize, uniqueColumnNames } from './infer';

/**
 * ⛔ THE ROW KEYS ARE papaparse's, AND THEY ARE NOT THE TRIMMED NAMES.
 *
 * This used to read `(res.meta.fields ?? []).map((f) => f.trim()).filter(Boolean)` and hand the
 * TRIMMED list to `finalize` while leaving the rows keyed by papaparse's RAW header text. The two
 * disagree the moment a header carries whitespace, and every downstream lookup is `row[col.name]`
 * — so the column rendered with its data silently replaced by nulls. It did not need a duplicate
 * to fire; `" a , b "` over `1,2` produced columns `[a, b]` and rows `[{a: null, b: null}]`, i.e.
 * a whole spreadsheet of empty cells from one stray space in the header. Trailing spaces in an
 * exported header row are ordinary, not adversarial.
 *
 * Collapse that pair into ONE mapping — raw key → the name the dataset will carry — and key the
 * rows by it. Two defects close together:
 *   • the whitespace blanking above, and
 *   • `"id,Amount,Amount "` → trim makes both `Amount`, a DUPLICATE column name (papaparse's own
 *     de-duplication ran on the raw text, where the two differed, so it saw nothing to rename).
 *     Three columns, two row keys, the third column's values gone, and five frontend screens that
 *     key an `{#each}` on the column name throwing `each_key_duplicate` on the result.
 */
interface CsvField {
  /** The key papaparse actually used on every row object. */
  rawKey: string;
  /** The reader-facing name after trimming (pre-uniquify). */
  name: string;
}

export function parseCsv(text: string): FinalizedDataset {
  const res = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: false, // we do our own inference + coercion
  });
  const fields: CsvField[] = (res.meta.fields ?? [])
    .map((rawKey) => ({ rawKey, name: rawKey.trim() }))
    .filter((f) => f.name !== '');
  if (fields.length === 0) {
    throw badRequest('csv_no_header', 'CSV must have a header row with column names');
  }
  const { names, renamed } = uniqueColumnNames(fields.map((f) => f.name));

  // Tolerate a trailing all-empty row. Filtered on the RAW row (which still carries any blank-header
  // and `__parsed_extra` values) so "is this row empty?" answers exactly what it did before.
  const rows = (res.data as Record<string, unknown>[])
    .filter((r) => r && Object.values(r).some((v) => v !== '' && v !== null && v !== undefined))
    .map((r) => {
      const out: Record<string, unknown> = {};
      fields.forEach((f, i) => {
        out[names[i]!] = r[f.rawKey];
      });
      return out;
    });
  return finalize(names, rows, renamed);
}
