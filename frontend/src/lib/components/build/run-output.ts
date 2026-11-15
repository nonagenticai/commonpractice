// src/lib/components/build/run-output.ts — a step's output as a member can read it.
//
// ⛔ THE DEFECT. The Result panel printed `node_success.outputPreview` as is, so a member's test run
// read `{"rows":[{"id":"value-1","name":…` under each step. The preview is the runner's
// `JSON.stringify(output)`, cut at 2048 bytes with a trailing `…` (backend exec/flow-executor.ts
// `truncatePreview`), so it is often NOT valid JSON at all. This module turns it into a plain view:
// a row count plus the first rows as a table, a value, or label → value lines. The raw text stays
// under Details for developers and above (`canSeeInternalErrors`).
//
// Pure and runes-free, so it is unit-testable under the node-env vitest.

/** First rows shown in the table. */
export const MAX_ROWS = 5;
/** First columns shown in the table; the rest are counted. */
export const MAX_COLUMNS = 6;
/** Label → value lines shown for an object output. */
export const MAX_FIELDS = 8;
/** Longest cell / value text. */
const MAX_TEXT = 80;
/** Longest text for a whole output (the old one-line summary length). */
const MAX_SUMMARY = 140;

export type FieldValue =
	| { kind: 'text'; text: string }
	| { kind: 'count'; count: number; atLeast: boolean }
	/** A rows array the cut emptied: there were rows, none arrived whole. */
	| { kind: 'rowsCut' };

export interface OutputTable {
	/** The output key the rows came from (`rows`), or null when the output itself was the array. */
	key: string | null;
	count: number;
	/** The preview was cut, so the array is longer than `count`. */
	atLeast: boolean;
	columns: string[];
	hiddenColumns: number;
	rows: Record<string, unknown>[];
}

export interface OutputView {
	/** A plain value (text, number, a short list). */
	text: string | null;
	fields: { key: string; value: FieldValue }[];
	/** The whole output was a rows array the cut emptied (see FieldValue `rowsCut`). */
	rowsCut?: boolean;
	table: OutputTable | null;
}

/** How numbers and yes/no read in the reader's locale (the component passes `num` and the catalog). */
export interface OutputFormat {
	num: (n: number) => string;
	bool: (b: boolean) => string;
}
const PLAIN: OutputFormat = { num: String, bool: String };

const EMPTY: OutputView = { text: null, fields: [], table: null };

function clip(s: string, max = MAX_TEXT): string {
	const flat = s.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isRowArray(v: unknown): v is Record<string, unknown>[] {
	return Array.isArray(v) && v.length > 0 && v.every(isRecord);
}

/** A value inside a cell or a field, in words: never JSON. */
export function plainValue(v: unknown, fmt: OutputFormat = PLAIN): string {
	if (v === null || v === undefined) return '';
	if (typeof v === 'number') return fmt.num(v);
	if (typeof v === 'string') return clip(v);
	if (typeof v === 'boolean') return fmt.bool(v);
	if (Array.isArray(v)) return clip(v.map((x) => plainValue(x, fmt)).filter(Boolean).join(', '));
	if (isRecord(v)) return clip(Object.values(v).map((x) => plainValue(x, fmt)).filter(Boolean).join(', '));
	return clip(String(v));
}

const CLOSE: Record<string, string> = { '{': '}', '[': ']' };
const closers = (open: string) => [...open].reverse().map((b) => CLOSE[b]).join('');

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

/**
 * Parse the preview, repairing a cut one. The runner cuts the JSON text at 2048 characters and
 * appends `…`; the repair keeps what is complete and marks what is not:
 *   • cut inside a ROW of an array of rows → that row is dropped (a half row would read as a whole
 *     one); the count becomes "at least".
 *   • cut inside a string VALUE (a long text, `{summary: "…"}`) → the string is closed with `…`, so
 *     the reader sees the start of the text, visibly clipped.
 *   • anything else (a key, a number, `true`) → back up to the last comma outside a string and
 *     close every open bracket.
 */
export interface ParsedPreview {
	value: unknown;
	cut: boolean;
	/** The cut fell inside the FIRST row of an array, which is therefore `[]` and the last thing parsed. */
	emptied?: boolean;
}

/**
 * A string cut mid-escape (`\`, `\u00`, `\u00e`) cannot be closed: drop the incomplete escape.
 * `\\` (an escaped backslash) is complete — only an ODD run of trailing backslashes is a fragment.
 */
export function dropPartialEscape(text: string): string {
	const u = /(\\+)u[0-9a-fA-F]{0,3}$/.exec(text);
	if (u && u[1].length % 2 === 1) return text.slice(0, u.index + u[1].length - 1);
	const b = /\\+$/.exec(text);
	if (b && b[0].length % 2 === 1) return text.slice(0, -1);
	return text;
}

export function parsePreview(preview: string): ParsedPreview | null {
	const s = preview.trim();
	if (s === '') return null;
	const whole = tryParse(s);
	if (whole.ok) return { value: whole.value, cut: false };
	if (!s.endsWith('…')) return null;
	const body = s.slice(0, -1);
	if (!/^[[{"]/.test(body)) return null;

	// One scan: the open brackets (with positions) and each comma outside a string.
	const cuts: { at: number; open: string }[] = [];
	const stack: { ch: string; at: number }[] = [];
	let inString = false;
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (inString) {
			if (c === '\\') i++;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === '{' || c === '[') stack.push({ ch: c, at: i });
		else if (c === '}' || c === ']') stack.pop();
		else if (c === ',') cuts.push({ at: i, open: stack.map((b) => b.ch).join('') });
	}
	const open = stack.map((b) => b.ch).join('');

	// 1. Cut inside a row: drop that row. The OUTERMOST array whose element is an open object.
	const rowArray = stack.findIndex((b, i) => b.ch === '[' && stack[i + 1]?.ch === '{');
	if (rowArray >= 0) {
		const level = open.slice(0, rowArray + 1);
		const from = stack[rowArray].at;
		const comma = [...cuts].reverse().find((c) => c.open === level && c.at > from);
		const at = comma ? comma.at : from + 1;
		const r = tryParse(body.slice(0, at) + closers(level));
		if (r.ok) return { value: r.value, cut: true, emptied: !comma };
	}
	// 2. Cut inside a string value: close it, visibly clipped.
	if (inString) {
		const r = tryParse(`${dropPartialEscape(body)}…"${closers(open)}`);
		if (r.ok) return { value: r.value, cut: true };
	}
	// 3. Cut right after a complete value.
	if (!inString && /[}\]"]$/.test(body.trimEnd())) {
		const r = tryParse(body + closers(open));
		if (r.ok) return { value: r.value, cut: true };
	}
	// 4. Back up to the last comma that leaves valid JSON.
	for (let k = cuts.length - 1, tries = 0; k >= 0 && tries < 64; k--, tries++) {
		const r = tryParse(body.slice(0, cuts[k].at) + closers(cuts[k].open));
		if (r.ok) return { value: r.value, cut: true };
	}
	return null;
}

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: ' ', f: ' ', n: ' ', r: ' ', t: ' ' };
/** JSON string escapes in plain text: `\n` → space, `\"` → `"`, `\u00e9` → é. */
function decodeEscapes(text: string): string {
	return text.replace(/\\(u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (_m, e: string) =>
		e.length === 5 ? String.fromCharCode(parseInt(e.slice(1), 16)) : ESCAPES[e]
	);
}

/**
 * The last resort when the preview cannot be read as JSON (malformed, or `[redacted]`): its words
 * without JSON punctuation. A member never gets an empty row where an output exists.
 */
export function plainExcerpt(preview: string): string {
	const words = decodeEscapes(dropPartialEscape(preview.replace(/…$/, '')))
		.replace(/[{}[\]"]+/g, ' ')
		.replace(/\s*,\s*/g, ', ')
		.replace(/\s*:\s*/g, ': ')
		.replace(/^[\s,:]+|[\s,:]+$/g, '');
	return clip(preview.trimEnd().endsWith('…') ? `${words}…` : words, MAX_SUMMARY);
}

function tableOf(key: string | null, rows: Record<string, unknown>[], cut: boolean): OutputTable {
	const columns: string[] = [];
	for (const r of rows.slice(0, MAX_ROWS)) for (const c of Object.keys(r)) if (!columns.includes(c)) columns.push(c);
	return {
		key,
		count: rows.length,
		atLeast: cut,
		columns: columns.slice(0, MAX_COLUMNS),
		hiddenColumns: Math.max(0, columns.length - MAX_COLUMNS),
		rows: rows.slice(0, MAX_ROWS)
	};
}

/** The plain view of one step's `outputPreview`. Use `safeOutputView` at a render site. */
export function outputView(preview: string | undefined | null, fmt: OutputFormat = PLAIN): OutputView {
	if (!preview) return EMPTY;
	const view = readView(preview, fmt);
	if (hasOutput(view)) return view;
	// Never an empty row where an output exists: fall back to its words.
	const excerpt = plainExcerpt(preview);
	return excerpt === '' ? EMPTY : { ...EMPTY, text: excerpt };
}

/** `outputView` that cannot throw: a value nobody anticipated degrades to the plain excerpt. */
export function safeOutputView(preview: string | undefined | null, fmt: OutputFormat = PLAIN): OutputView {
	try {
		return outputView(preview, fmt);
	} catch {
		const excerpt = preview ? plainExcerpt(preview) : '';
		return excerpt === '' ? EMPTY : { ...EMPTY, text: excerpt };
	}
}

function readView(preview: string, fmt: OutputFormat): OutputView {
	const parsed = parsePreview(preview);
	if (!parsed) return EMPTY;
	const { value, cut, emptied } = parsed;
	if (value === null || value === undefined) return EMPTY;
	if (emptied && Array.isArray(value) && value.length === 0) return { ...EMPTY, rowsCut: true };
	if (!Array.isArray(value) && !isRecord(value)) {
		// A whole-output text gets the one-line summary length, not a cell's.
		const text = typeof value === 'string' ? clip(value, MAX_SUMMARY) : plainValue(value, fmt);
		return text === '' ? EMPTY : { ...EMPTY, text };
	}
	if (Array.isArray(value)) {
		if (isRowArray(value)) return { ...EMPTY, table: tableOf(null, value, cut) };
		const text = plainValue(value, fmt);
		return text === '' ? EMPTY : { ...EMPTY, text };
	}
	const entries = Object.entries(value);
	// `{ rows: [...] }` — the usual shape of a block output: the rows ARE the result.
	if (entries.length === 1 && isRowArray(entries[0][1])) {
		return { ...EMPTY, table: tableOf(entries[0][0], entries[0][1], cut) };
	}
	let table: OutputTable | null = null;
	const fields: OutputView['fields'] = [];
	const last = entries.length - 1;
	for (const [i, [key, v]] of entries.entries()) {
		if (emptied && i === last && Array.isArray(v) && v.length === 0) {
			fields.push({ key, value: { kind: 'rowsCut' } });
			continue;
		}
		if (i >= MAX_FIELDS) continue;
		if (isRowArray(v)) {
			if (!table) table = tableOf(key, v, cut);
			fields.push({ key, value: { kind: 'count', count: v.length, atLeast: cut } });
			continue;
		}
		const text = plainValue(v, fmt);
		if (text !== '') fields.push({ key, value: { kind: 'text', text } });
	}
	return { text: null, fields, table };
}

/** Does the view show anything at all? */
export function hasOutput(v: OutputView): boolean {
	return v.text !== null || v.fields.length > 0 || v.table !== null || v.rowsCut === true;
}
