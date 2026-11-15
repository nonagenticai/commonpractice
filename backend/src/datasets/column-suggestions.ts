// src/datasets/column-suggestions.ts — which columns to SUGGEST to a data manager as "not personal"
// (owner decision 2026-10-15).
//
// ⛔ A SUGGESTION, NEVER A DECISION. Members see a column's real values (previews and test runs) only
// after a data manager marks it not personal (`DatasetColumn.nonPersonal`, datasets/member-view.ts).
// An earlier design applied this rule automatically; the re-audit showed no rule over the data can
// tell 3 handlers ("J. de Vries") from 3 tiers, so automatic real values would always leak names.
// This module only shortens the data manager's work: the schema editor labels these columns
// "Suggested: not personal" and offers one action to mark them all. Members never receive it.
//
// A column is suggested when ALL of these hold over the inspected rows (the first
// DATASET_INJECT_ROW_CAP, what a run reads):
//   1. no explicit classification (`pii: true`, `nonPersonal: true`, or a confirmed mapping);
//   2. its NAME passes the upload heuristic (`isPiiName`) AND the wider person-role matcher below
//      (`looksLikePersonColumnName` — camelCase/snake_case tokens, en + nl role words, compounds).
//      ⛔ The wider matcher is used HERE ONLY: in `isPiiName` it flagged member_count, user_agent,
//      agent_type… as PII at upload, and information-requests stores PII columns as "[redacted]"
//      with no way back — it destroyed data;
//   3. every VALUE passes the value detector (`scrubPiiCell`) unchanged, and no value looks like a
//      person name (2+ capitalised words or initials, particles allowed: `J. de Vries`);
//   4. CATEGORICAL: ≥ 6 non-null values, which are ≥ 50% of the rows; ≤ 10 distinct and
//      ≤ floor(values / 3) distinct (values repeat); each value ≤ 32 characters and ≤ 3 words;
//   5. not an IDENTIFIER: no id-like name (…id / nr / number) and not every value an integer or UUID
//      (an all-boolean column is exempt).
import type { DatasetColumn } from '../db/dataset-types';
import { isPiiName } from './parse/infer';
import { scrubPiiCell } from './pii-values';

export const SUGGEST_MAX_DISTINCT = 10;
export const SUGGEST_MIN_VALUES = 6;
export const SUGGEST_REPEAT_FACTOR = 3;
export const SUGGEST_MAX_CHARS = 32;
export const SUGGEST_MAX_WORDS = 3;

/** The most distinct values a categorical column may have over `valueCount` non-null values
 *  (0 below the 6-value floor: too small a sample to call anything categorical). */
export function suggestDistinctLimit(valueCount: number): number {
  if (valueCount < SUGGEST_MIN_VALUES) return 0;
  return Math.min(SUGGEST_MAX_DISTINCT, Math.floor(valueCount / SUGGEST_REPEAT_FACTOR));
}

// ---- person-role column names (suggestions only — NOT upload inference) ----

// Whole tokens (also plural with a trailing s). Short or ambiguous words (rep, lid, arts, agent,
// user, contact…) are whole-token only, so `report`, `valid`, `parts` do not match.
const PERSON_TOKENS = new Set([
  'name', 'naam', 'customer', 'klant', 'client', 'patient', 'manager', 'owner', 'eigenaar',
  'assigned', 'assignee', 'employee', 'medewerker', 'user', 'gebruiker', 'contact', 'person',
  'persoon', 'agent', 'rep', 'author', 'auteur', 'member', 'lid', 'staff', 'doctor', 'arts',
  'handler', 'behandelaar', 'advisor', 'adviseur', 'seller', 'verkoper', 'requester', 'aanvrager',
  'firstname', 'lastname', 'surname', 'fullname', 'username', 'voornaam', 'achternaam',
]);
// The same idea INSIDE a compound (`klantnaam`, `gebruikersnaam`, `dossierbehandelaar`): only the
// long, unambiguous words, so a substring cannot hit an ordinary word.
const PERSON_COMPOUND_RE =
  /naam|name|klant|eigenaar|medewerker|gebruiker|persoon|auteur|customer|employee|patient|manager|assignee|behandelaar|adviseur|verkoper|aanvrager/;

/** A column name split into lower-case tokens: `customerName` → [customer, name],
 *  `account_manager` → [account, manager], `HTTPStatus` → [http, status]. */
export function nameTokens(name: string): string[] {
  return name
    .trim()
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\dÀ-ɏ]+/)
    .filter(Boolean);
}

/** Does the column NAME suggest it holds people (a role or a name)? Suggestions only. */
export function looksLikePersonColumnName(name: string): boolean {
  return nameTokens(name).some(
    (t) => PERSON_TOKENS.has(t) || (t.endsWith('s') && PERSON_TOKENS.has(t.slice(0, -1))) || PERSON_COMPOUND_RE.test(t),
  );
}

// ---- value shape ----

// 2+ words, each capitalised or an initial, optionally joined by lower-case particles
// (`Anna de Vries`, `J. de Vries`, `Jan van der Berg`, `Mary O'Neil`). Errs towards not suggesting:
// a capitalised two-word category ("Gold Plus") is not suggested either.
const PARTICLE = "(?:van|von|de|der|den|het|ter|ten|te|du|da|di|del|della|le|la|op|in|'t)";
const CAP_WORD = "\\p{Lu}[\\p{L}'’.-]*";
const PERSON_NAME_RE = new RegExp(`^${CAP_WORD}(?:\\s+(?:${PARTICLE}\\s+)*${CAP_WORD})+$`, 'u');
export function looksLikePersonName(text: string): boolean {
  return PERSON_NAME_RE.test(text.trim());
}

const INTEGER_RE = /^-?\d+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_TAIL_TOKENS = new Set(['id', 'ids', 'nr', 'number', 'nummer', 'no']);
export function isIdLikeName(name: string): boolean {
  const toks = nameTokens(name);
  return ID_TAIL_TOKENS.has(toks[toks.length - 1] ?? '') || /(id|nr|number)$/i.test(name.trim());
}

function scalarText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return null; // object / array: never categorical
}

/** Rules 2–5 for one column. (Explicit classification, rule 1, is the caller's.) */
export function isSuggestibleColumn(column: DatasetColumn, rows: Record<string, unknown>[]): boolean {
  if (column.pii === true || column.nonPersonal === true) return false;
  if (isPiiName(column.name) || looksLikePersonColumnName(column.name)) return false;
  const distinct = new Set<string>();
  let values = 0;
  let allBoolean = true;
  let allIdValues = true;
  for (const r of rows) {
    const v = r[column.name];
    if (v === null || v === undefined || v === '') continue;
    const text = scalarText(v);
    if (text === null) return false;
    if (text.length > SUGGEST_MAX_CHARS) return false;
    if (text.trim().split(/\s+/).length > SUGGEST_MAX_WORDS) return false;
    if (scrubPiiCell(column.name, v) !== v) return false;
    if (typeof v !== 'boolean') {
      allBoolean = false;
      if (looksLikePersonName(text)) return false;
    }
    if (!(typeof v === 'number' ? Number.isInteger(v) : INTEGER_RE.test(text.trim()) || UUID_RE.test(text.trim())))
      allIdValues = false;
    distinct.add(text);
    values++;
    if (distinct.size > SUGGEST_MAX_DISTINCT) return false;
  }
  if (values === 0) return false;
  if (!allBoolean && (allIdValues || isIdLikeName(column.name))) return false;
  if (values * 2 < rows.length) return false; // null-heavy
  return distinct.size <= suggestDistinctLimit(values);
}

/**
 * The columns of one dataset to SUGGEST as not personal. `classified` = every column an explicit
 * classification covers (member-view `memberColumnClassification`): those are never suggested.
 */
export function suggestNonPersonalColumns(
  columns: DatasetColumn[],
  rows: Record<string, unknown>[],
  classified: ReadonlySet<string>,
): string[] {
  return columns.filter((c) => !classified.has(c.name) && isSuggestibleColumn(c, rows)).map((c) => c.name);
}
