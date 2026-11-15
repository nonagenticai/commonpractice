// src/datasets/parse/sql.ts — SQL ingestion, 2.0 = paste-result only. The dev runs
// a SELECT elsewhere and pastes the result; we accept either a JSON array (the
// common psql `\gx`/JSON export) or CSV (tab/comma). Live read-only connect is a
// roadmap-A item, deliberately NOT in 2.0 (governance/egress surface). See SPEC §3-A.
import { badRequest } from '../../utils/http';
import type { FinalizedDataset } from './infer';
import { parseJsonValue } from './json';
import { parseCsv } from './csv';

export function parseSqlPaste(text: string): FinalizedDataset {
  const trimmed = text.trim();
  if (!trimmed) throw badRequest('sql_empty', 'Paste the SELECT result (JSON or CSV)');
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw badRequest('sql_json_invalid', 'Looks like JSON but did not parse');
    }
    return parseJsonValue(parsed);
  }
  // Otherwise treat as delimited text (papaparse sniffs comma vs tab).
  return parseCsv(trimmed);
}
