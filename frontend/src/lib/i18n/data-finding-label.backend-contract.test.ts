// src/lib/i18n/data-finding-label.backend-contract.test.ts — the data-contract vocabulary is
// COMPLETE.
//
// THE DEFECT THIS PINS is the one that only appears LATER: `dataFindingLabel` falls back to the
// backend's English for an unrecognised rule — deliberately, so a rule shipped backend-first
// degrades instead of vanishing. That fallback is a safety net, not a destination. Without this
// test the net is invisible: a third `DataValidationRule` would ship, every locale would quietly
// render an English sentence, and nothing in CI would say a word. This is the file that reds.
//
// backend/ and frontend/ are two separate Bun projects — no workspaces, no shared package, no
// codegen — so, exactly as `policy-label.backend-contract.test.ts` does, this walks BACKEND SOURCE
// TEXT on disk with plain `fs` and diffs the sets. It reads the FRONTEND switch as text too rather
// than calling it, so it needs no paraglide runtime and no message mock: "is there a case for this
// rule" is a question about source, and mocking the answer would make it vacuous.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const BACKEND = fileURLToPath(new URL('../../../../backend', import.meta.url));
const VALIDATION = join(BACKEND, 'src', 'datasets', 'ontology-validation.ts');

const backendSrc = readFileSync(VALIDATION, 'utf8');
const labelSrc = readFileSync(new URL('./data-finding-label.ts', import.meta.url), 'utf8');
const enCatalog = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../../messages/en.json', import.meta.url)), 'utf8')
) as Record<string, unknown>;

// ---------------------------------------------------------------- backend reader

/**
 * Every quoted string literal in a chunk of TypeScript — SINGLE, DOUBLE **OR BACKTICK**.
 *
 * ⛔⛔ THE NON-SINGLE HALVES ARE NOT DEFENSIVE PROGRAMMING, THEY ARE A MEASURED HOLE. This scrape
 * used to be `/'([^']+)'/g`. Adding `| "range_violation";` to the backend union — one member, one
 * pair of double quotes — left ALL SEVEN assertions in this file GREEN (measured 2026-08-16), because
 * the invisible member never entered the parsed set at all: `rules` and `cases` were both short by
 * one, so the equality below still held and the rule shipped English into seven locales. There is NO
 * prettier and NO eslint config anywhere in this repo, so nothing normalises quote style in
 * `backend/` and a double-quoted literal is a perfectly ordinary thing for the next author to write.
 *
 * Same fix, same reason, as `graph-issue-label.backend-contract.test.ts`'s `quotedLiterals`.
 */
function quotedLiterals(chunk: string): string[] {
	return [...chunk.matchAll(/(['"`])([^'"`]+)\1/g)].map((x) => x[2]!);
}

/**
 * The members of the `DataValidationRule` union, out of the backend's `export type` line.
 *
 * ⛔ IT DOES NOT PARSE TYPESCRIPT. A union assembled from another type, or one wrapped across lines
 * in a shape this regex misses, is invisible to it — which is why the first assertion below pins
 * the parsed set to a floor. If the declaration is ever reshaped, that assertion fails loudly
 * rather than every later comparison passing vacuously against an empty set.
 */
function backendRules(src: string = backendSrc): string[] {
	const decl = src.match(/export type DataValidationRule\s*=([^;]+);/);
	if (!decl) throw new Error('DataValidationRule not found in backend/src/datasets/ontology-validation.ts');
	return quotedLiterals(decl[1]!);
}

/** Every field declared on the backend's `DataValidationFinding` interface. */
function backendFindingFields(): string[] {
	const at = backendSrc.indexOf('export interface DataValidationFinding {');
	if (at === -1) throw new Error('DataValidationFinding interface not found');
	const body = backendSrc.slice(at, backendSrc.indexOf('\n}', at));
	// `name:` / `name?:` at the start of a line, skipping doc comments and their `* …` lines.
	return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]!);
}

// ---------------------------------------------------------------- frontend readers

/** The `case '…':` labels inside one exported function of the label module. Quote-agnostic. */
function switchCases(fn: string, src: string = labelSrc): string[] {
	const at = src.indexOf(`export function ${fn}(`);
	if (at === -1) throw new Error(`${fn} not found`);
	const next = src.indexOf('\nexport function ', at + 1);
	const body = src.slice(at, next === -1 ? src.length : next);
	return [...body.matchAll(/case\s*(['"`])([^'"`]*)\1\s*:/g)].map((x) => x[2]!);
}

const rules = backendRules();
const cases = switchCases('dataFindingLabel');

// ---------------------------------------------------------------- the contract

describe('data-finding vocabulary ↔ backend', () => {
	it('found the backend declarations at all (guards the parsers themselves)', () => {
		// If a parser or a path ever breaks, every set below goes empty and the comparisons pass
		// vacuously. This is the assertion that makes the rest mean something.
		expect(rules.length).toBeGreaterThanOrEqual(2);
		expect(rules).toEqual(expect.arrayContaining(['pii_uncovered', 'type_mismatch']));
		expect(cases.length).toBeGreaterThanOrEqual(2);
	});

	it('every rule the backend can emit has a SENTENCE — no rule renders English by default', () => {
		// ⛔ THIS IS THE GUARD. Add a third `DataValidationRule` backend-first and this goes red
		// here, naming it, instead of shipping an English sentence into seven non-English locales.
		expect([...rules].sort()).toEqual([...cases].sort());
	});

	it('every case in the switch is a rule the backend actually emits', () => {
		// The other direction: a case for a rule that no longer exists is dead code carrying five
		// dead catalog keys with it. Implied by the equality above; asserted separately so the
		// failure message says which direction broke.
		for (const c of cases) expect(rules).toContain(c);
	});

	it('every message the module references exists in the base catalog', () => {
		// paraglide fails its own compile on a missing key, but only during `bun run check`. This
		// puts the same failure in `bun run test`, where it names the offending key directly.
		const referenced = [...labelSrc.matchAll(/\bm\.([a-z0-9_]+)\(/g)].map((x) => x[1]!);
		expect(referenced.length).toBeGreaterThanOrEqual(2);
		expect(referenced.filter((k) => !(k in enCatalog))).toEqual([]);
	});

	it('the pill copy keys exist too', () => {
		// These live in the build page rather than this module, but they are the SAME shipment and
		// there is no other place that would notice one going missing.
		for (const k of [
			'data_findings_title_block',
			'data_findings_title_warn',
			'data_findings_warn_policy_note'
		]) {
			expect(k in enCatalog).toBe(true);
		}
	});

	it('the machine fields this module interpolates are really on the wire', () => {
		// `dataFindingLabel` reads `count`/`expected` off the finding. If the backend interface ever
		// drops them the switch would interpolate `undefined` forever via the mid-roll branch —
		// silently, because that branch is a legitimate runtime state. Pin them to the source.
		const fields = backendFindingFields();
		expect(fields).toEqual(
			expect.arrayContaining(['rule', 'dataset', 'column', 'attribute', 'message', 'count', 'expected'])
		);
	});

	it('⛔ the scrapers see a DOUBLE-QUOTED and a BACKTICK declaration too (they measurably did not)', () => {
		// ⛔ THE SCRAPERS' OWN NON-VACUITY, ON A SYNTHETIC SOURCE. Every other assertion here is only
		// as good as the regexes above, and `/'([^']+)'/` was blind to a member written with double
		// quotes: adding `| "range_violation";` to the real backend union left all seven assertions
		// GREEN and shipped a rule with no sentence. Driving the parsers over a fixture is the only
		// way to test a parser without waiting for the bug.
		const FIXTURE = [
			'export type DataValidationRule =',
			"  | 'type_mismatch'",
			'  | "range_violation"',
			'  | `null_rate`;',
			''
		].join('\n');
		expect(backendRules(FIXTURE)).toEqual(['type_mismatch', 'range_violation', 'null_rate']);

		const SWITCH = [
			'export function dataFindingLabel(f: DataValidationFinding): string {',
			'	switch (f.rule) {',
			"		case 'type_mismatch':",
			'		case "range_violation":',
			'		case `null_rate`:',
			'	}',
			'}',
			''
		].join('\n');
		expect(switchCases('dataFindingLabel', SWITCH)).toEqual([
			'type_mismatch',
			'range_violation',
			'null_rate'
		]);

		// …and the REAL sources still parse the same way through the widened regexes, so the fix did
		// not buy the fixture at the cost of the thing it guards.
		expect(rules).toEqual(backendRules(backendSrc));
		expect(cases.length).toBeGreaterThanOrEqual(2);
	});

	it('the `type_mismatch` catalog entry is an ICU PLURAL, not a bare string', () => {
		// It interpolates `{count}`. A flat string would read "1 values" in en and be outright
		// ungrammatical in pl/ar/he, which have more plural categories than two.
		const entry = enCatalog.data_finding_type_mismatch;
		expect(Array.isArray(entry)).toBe(true);
		const variant = (entry as Record<string, unknown>[])[0]!;
		expect(variant.selectors).toEqual(['countPlural']);
		expect(variant.declarations).toEqual(expect.arrayContaining(['local countPlural = count: plural']));
	});
});
