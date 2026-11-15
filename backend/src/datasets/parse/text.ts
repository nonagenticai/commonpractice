// src/datasets/parse/text.ts — plain text → {columns, rows}. One row per non-empty
// line ({ line, text }). A common, predictable shape for log/notes test data.
import { type FinalizedDataset, finalize } from './infer';

export function parseText(text: string): FinalizedDataset {
  const rows = text
    .split(/\r?\n/)
    .map((t) => t.replace(/\s+$/, ''))
    .filter((t) => t.length > 0)
    .map((t, i) => ({ line: i + 1, text: t }));
  return finalize(['line', 'text'], rows);
}
