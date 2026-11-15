// src/datasets/parse/index.ts — the parser dispatcher. One entry point the route
// calls with a source type + the raw input (decoded text for csv/json/text/sql, or
// binary bytes for xlsx). Returns the typed, capped {columns, rows} + a truncation
// count (logged by the caller, never silent — SPEC §2.7).
import { badRequest } from '../../utils/http';
import {
  type ColumnRename,
  type DatasetSourceType,
  type ParsedDataset,
  DATASET_MAX_BYTES,
} from '../../db/dataset-types';
import { parseCsv } from './csv';
import { parseXlsx } from './xlsx';
import { parseJson } from './json';
import { parseText } from './text';
import { parseSqlPaste } from './sql';

export interface ParseInput {
  sourceType: DatasetSourceType;
  /** Decoded text for csv/json/text/sql. */
  text?: string;
  /** Raw bytes for xlsx (or a csv uploaded as a file). */
  binary?: Uint8Array;
  /** Optional sheet name for xlsx. */
  sheet?: string;
}

/** Every parser's output. `renamedColumns` is always present (empty on the ordinary path) so a
 *  caller can never forget to surface it by treating `undefined` as "nothing happened". */
export type ParseResult = ParsedDataset & { truncated: number; renamedColumns: ColumnRename[] };

function enforceSize(input: ParseInput): void {
  const bytes = input.binary?.byteLength ?? (input.text ? Buffer.byteLength(input.text, 'utf8') : 0);
  if (bytes > DATASET_MAX_BYTES) {
    throw badRequest(
      'dataset_too_large',
      `Input is ${(bytes / 1_048_576).toFixed(1)} MB; the limit is ${DATASET_MAX_BYTES / 1_048_576} MB`,
      // `dataset_too_large` is also thrown by routes/datasets.ts with different sentences
      // (`upload`, `file`); `reason` is what tells the three apart. Raw MB, not the `.toFixed(1)`
      // string above — a locale formats its own numbers.
      {
        reason: 'input',
        actualMb: bytes / 1_048_576,
        limitMb: DATASET_MAX_BYTES / 1_048_576,
      },
    );
  }
}

export async function parseDataset(input: ParseInput): Promise<ParseResult> {
  enforceSize(input);
  switch (input.sourceType) {
    case 'csv': {
      const text = input.text ?? (input.binary ? new TextDecoder().decode(input.binary) : '');
      return parseCsv(text);
    }
    case 'xlsx': {
      if (!input.binary) throw badRequest('xlsx_no_file', 'Excel ingestion needs an uploaded file');
      return parseXlsx(input.binary, input.sheet);
    }
    case 'json':
      return parseJson(input.text ?? '');
    case 'text':
      return parseText(input.text ?? '');
    case 'sql':
      return parseSqlPaste(input.text ?? '');
    default:
      throw badRequest('unknown_source_type', `Unsupported source type '${input.sourceType}'`, {
        sourceType: input.sourceType,
      });
  }
}

export { parseCsv, parseXlsx, parseJson, parseText, parseSqlPaste };
