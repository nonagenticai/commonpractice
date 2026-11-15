// src/datasets/parse/json.ts — JSON → {columns, rows}. An array of objects becomes
// the rows; a single object becomes one row; an array of primitives becomes a
// single `value` column. Column order = first-seen key order across the rows.
import { badRequest } from '../../utils/http';
import { type FinalizedDataset, finalize, orderedKeys } from './infer';

export function parseJson(text: string): FinalizedDataset {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest('json_invalid', 'Body is not valid JSON');
  }
  return parseJsonValue(parsed);
}

/** Shared with the SQL-paste parser (which may hand us already-parsed JSON). */
export function parseJsonValue(parsed: unknown): FinalizedDataset {
  let rows: Record<string, unknown>[];
  if (Array.isArray(parsed)) {
    if (parsed.length > 0 && parsed.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))) {
      rows = parsed as Record<string, unknown>[];
    } else {
      rows = (parsed as unknown[]).map((v) => ({ value: v }));
    }
  } else if (parsed !== null && typeof parsed === 'object') {
    rows = [parsed as Record<string, unknown>];
  } else {
    rows = [{ value: parsed }];
  }
  const names = rows.length ? orderedKeys(rows) : ['value'];
  return finalize(names, rows);
}
