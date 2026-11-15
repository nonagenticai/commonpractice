// src/lib/i18n/scan-finding-label.backend-contract.test.ts — the static-scan vocabulary is
// COMPLETE.
//
// THE DEFECT THIS PINS is the one that only appears LATER: `scanFindingLabel` falls back to the
// backend's English for an unrecognised rule — deliberately, so a rule shipped backend-first
// degrades instead of vanishing. That fallback is a safety net, not a destination. Without this
// test the net is invisible: a twelfth scan rule would ship, every locale would quietly render an
// English sentence beside a localized issue counter, and nothing in CI would say a word. This is
// the file that reds. Direct clone of `data-finding-label.backend-contract.test.ts`.
//
// ⛔ IT SCRAPES ONLY `static-scan.ts`, AND THAT SCOPE IS THE WHOLE POINT. `lint.ts` merges TWO
// vocabularies into one `LintFinding[]`. The `scan` half is closed — thirteen rules, all declared in
// this one file — and is what a catalog can cover. The `type` half is `TS####` + tsc's own English
// diagnostic: unbounded, reworded between compiler releases, and deliberately NOT translated
// (`scanFindingLabel` returns it verbatim). Demanding catalog coverage of that half would be
// demanding the impossible, so it is out of scope here by construction, not by omission.
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
import { stripComments } from '$lib/test/source-scan';

const BACKEND = fileURLToPath(new URL('../../../../backend', import.meta.url));
const SCAN = join(BACKEND, 'src', 'exec', 'static-scan.ts');
const LINT = join(BACKEND, 'src', 'blocks', 'lint.ts');

// ⛔ COMMENTS STRIPPED BEFORE ANY SCRAPE. This module's own header names four rules in prose, and
// the backend interface's doc comments name three more. A raw-text scrape would read those and
// report a vocabulary the code does not have — passing for the wrong reason.
const scanSrc = stripComments(readFileSync(SCAN, 'utf8'));
const lintSrc = stripComments(readFileSync(LINT, 'utf8'));
// The frontend module is stripped for the same reason: its header names `finding.message`,
// `finding.source` and every rule it handles, in prose.
const labelSrc = stripComments(readFileSync(new URL('./scan-finding-label.ts', import.meta.url), 'utf8'));
const enCatalog = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../../messages/en.json', import.meta.url)), 'utf8')
) as Record<string, unknown>;

// ---------------------------------------------------------------- backend readers

/**
 * The eight rules of the `AMBIENT_GLOBALS` table.
 *
 * ⛔ IT DOES NOT PARSE TYPESCRIPT. The table is matched by its declaration and its closing `\n];`,
 * and each entry by a quoted `rule:`. A table reshaped into a `Map`, or assembled from another
 * constant, is invisible to it — which is why the floor assertions below pin BOTH halves to an
 * exact count. If a declaration is reshaped, those fail loudly rather than every later comparison
 * passing vacuously against a short set.
 *
 * ⛔⛔ `['"]`, NOT `'` — A MEASURED HOLE, NOT DEFENSIVENESS. This used to read `/\brule:\s*'([^']+)'/g`.
 * Adding `{ rule: "no-timer", … }` to the real `AMBIENT_GLOBALS` table — one entry, one pair of
 * double quotes — left ALL NINE assertions in this file GREEN, including the "exactly 6 / exactly 11"
 * floors, because the invisible entry never entered the parsed set. There is NO prettier and NO
 * eslint config anywhere in this repo (verified: no `.prettierrc*`, `prettier.config*`, `.eslintrc*`
 * or `eslint.config*` outside node_modules), so nothing normalises quote style in `backend/`.
 *
 * ⚠️ THE SAME HOLE IS OPEN IN THREE SIBLING CONTRACT TESTS — `data-finding-label`, `policy-label`
 * and `notification-label`. They are NOT touched here on purpose: widening a house-wide gap belongs
 * in its own change rather than smuggled into an i18n branch. Reported for follow-up.
 */
function ambientRules(src: string = scanSrc): string[] {
	const table = src.match(/const AMBIENT_GLOBALS[^=]*=\s*\[([\s\S]*?)\n\];/);
	if (!table) throw new Error('AMBIENT_GLOBALS table not found in backend/src/exec/static-scan.ts');
	return [...table[1]!.matchAll(/\brule:\s*['"]([^'"]+)['"]/g)].map((x) => x[1]!);
}

/**
 * The five rules pushed as literals by `scanBlockSource` / `flagSpecifier`.
 *
 * Anchored on `findings.push({` so the AMBIENT loop's `findings.push({ rule: g.rule, … })` — which
 * carries a variable, not a literal — is correctly NOT counted twice here. Quote-agnostic for the
 * same measured reason as `ambientRules`.
 */
function pushedRules(src: string = scanSrc): string[] {
	return [...src.matchAll(/findings\.push\(\{\s*rule:\s*['"]([^'"]+)['"]/g)].map((x) => x[1]!);
}

/** Every field declared on an interface in a backend source file. */
function interfaceFields(src: string, name: string): string[] {
	const at = src.indexOf(`export interface ${name} {`);
	if (at === -1) throw new Error(`${name} interface not found`);
	const body = src.slice(at, src.indexOf('\n}', at));
	return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]!);
}

// ---------------------------------------------------------------- frontend readers

/** The `case '…':` labels inside one exported function of the label module. Quote-agnostic. */
function switchCases(fn: string, src: string = labelSrc): string[] {
	const at = src.indexOf(`export function ${fn}(`);
	if (at === -1) throw new Error(`${fn} not found`);
	const next = src.indexOf('\nexport function ', at + 1);
	const body = src.slice(at, next === -1 ? src.length : next);
	return [...body.matchAll(/case\s*['"]([^'"]*)['"]\s*:/g)].map((x) => x[1]!);
}

/** The `finding.<field>` reads inside the label module, minus the two the type always carries. */
function optionalFieldsRead(): string[] {
	const all = [...labelSrc.matchAll(/\bfinding\.([a-z]\w*)\b/g)].map((x) => x[1]!);
	return [...new Set(all)].filter((f) => !['rule', 'message', 'source'].includes(f));
}

const ambient = ambientRules();
const pushed = pushedRules();
const rules = [...ambient, ...pushed];
const cases = switchCases('scanFindingLabel');

// ---------------------------------------------------------------- the contract

describe('static-scan vocabulary ↔ backend', () => {
	it('found the backend declarations at all (guards the parsers themselves)', () => {
		// ⛔ THE NON-VACUITY FLOOR. If a parser or a path ever breaks, every set below goes empty and
		// the comparisons pass vacuously — the failure mode this repo has hit before. Both scrape
		// shapes are pinned separately, so losing ONE of them cannot hide behind the other.
		expect(ambient, 'the AMBIENT_GLOBALS table').toHaveLength(8);
		expect(pushed, 'the literal findings.push() calls').toHaveLength(5);
		expect(rules).toHaveLength(13);
		expect(rules).toEqual(expect.arrayContaining(['no-eval', 'import-not-allowlisted']));
		// One rule from each shape, so a scrape that read only one table is caught by name.
		expect(ambient).toContain('no-fetch');
		// The two rules the save-time gate added — named, so a regression that drops them from the
		// table (or reshapes the table past the scraper) says WHICH rules went missing.
		expect(ambient).toEqual(expect.arrayContaining(['no-function-constructor', 'no-computed-global']));
		expect(pushed).toContain('syntax');
		expect(new Set(rules).size, 'a rule is declared twice in static-scan.ts').toBe(13);
		expect(cases.length).toBeGreaterThanOrEqual(13);
	});

	it('every rule the backend can emit has a SENTENCE — no rule renders English by default', () => {
		// ⛔ THIS IS THE GUARD. Add a fourteenth scan rule backend-first and this goes red here, naming
		// it, instead of shipping an English sentence into seven non-English locales beside a
		// localized issue counter.
		expect([...rules].sort()).toEqual([...cases].sort());
	});

	it('every case in the switch is a rule the backend actually emits', () => {
		// The other direction: a case for a rule that no longer exists is dead code carrying eight
		// dead catalog keys with it. Implied by the equality above; asserted separately so the
		// failure message says which direction broke.
		for (const c of cases) expect(rules).toContain(c);
	});

	it('every message the module references exists in the base catalog', () => {
		// paraglide fails its own compile on a missing key, but only during `bun run check`. This
		// puts the same failure in `bun run test`, where it names the offending key directly.
		const referenced = [...labelSrc.matchAll(/\bm\.([a-z0-9_]+)\(/g)].map((x) => x[1]!);
		expect(referenced).toHaveLength(13);
		expect(referenced.filter((k) => !(k in enCatalog))).toEqual([]);
	});

	it('the surrounding /block-edit findings copy exists too', () => {
		// These live in the page rather than this module, but they are the SAME shipment: the list
		// heading and the localized issue counter that made the half-English screen so obvious.
		for (const k of [
			'blockedit_findings_title',
			'blockedit_lint_title',
			'blockedit_lint_issues',
			'blockedit_finding_line',
			'blockedit_lint_src_scan',
			'blockedit_lint_src_type'
		]) {
			expect(k in enCatalog, k).toBe(true);
		}
	});

	it('⛔ every optional field this module interpolates is really on the wire', () => {
		// `scanFindingLabel` reads `spec` and `detail` off the finding. If the backend ever drops one
		// the switch would take the mid-roll branch FOREVER and every locale would silently return to
		// English — a legitimate runtime state, so nothing else would notice. Pin them to the source,
		// on BOTH interfaces: `ScanFinding` is where they are produced, `LintFinding` is what the
		// browser actually receives, and a field on the first but not the second never arrives.
		const read = optionalFieldsRead();
		expect(read.sort(), 'the reads this test is about').toEqual(['detail', 'spec']);
		const scanFields = interfaceFields(scanSrc, 'ScanFinding');
		const lintFields = interfaceFields(lintSrc, 'LintFinding');
		expect(scanFields).toEqual(expect.arrayContaining(['rule', 'message', 'line', 'spec', 'detail']));
		expect(lintFields).toEqual(
			expect.arrayContaining(['source', 'rule', 'message', 'line', 'col', 'spec', 'detail'])
		);
		for (const f of read) {
			expect(scanFields, `backend ScanFinding does not declare \`${f}\``).toContain(f);
			expect(lintFields, `backend LintFinding does not declare \`${f}\``).toContain(f);
		}
	});

	it('⛔ …and `lint.ts` FORWARDS them from the scan finding it wraps', () => {
		// Declaring the fields is not shipping them. `lint.ts` rebuilds every scan finding field by
		// field into a `LintFinding`; a forward that is declared but not written is exactly the shape
		// that leaves the browser on its English fallback with every type in the repo green. The
		// runtime proof is `backend/tests/static-scan-machine-fields.test.ts`; this is the cheap
		// source-level one that fires in the frontend suite too.
		const at = lintSrc.indexOf('for (const f of scan.findings)');
		expect(at, 'the scan-forwarding loop moved — this assertion reads nothing').toBeGreaterThan(0);
		const block = lintSrc.slice(at, lintSrc.indexOf('typeCheckBlockSource(source)', at));
		expect(block, 'non-vacuity: the slice really is the forwarding loop').toContain('rule: f.rule');
		expect(block).toContain('spec: f.spec');
		expect(block).toContain('detail: f.detail');
	});

	it('⛔ the `type` half is branched on BEFORE the rule switch', () => {
		// The design decision this whole module hangs on, asserted where it cannot be quietly
		// reordered. The behavioural proof is in `scan-finding-label.test.ts` (a type finding whose
		// rule text collides with `no-eval`); this pins the SOURCE ORDER so a refactor that moves the
		// check below the switch is named here rather than only failing over there.
		const guard = labelSrc.indexOf("finding.source === 'type'");
		const firstCase = labelSrc.indexOf("case 'no-fetch'");
		expect(guard, 'the `type` passthrough is gone').toBeGreaterThan(0);
		expect(firstCase, 'the rule switch is gone').toBeGreaterThan(0);
		expect(guard).toBeLessThan(firstCase);
	});

	it('⛔ the scrapers see a DOUBLE-QUOTED declaration too (they measurably did not)', () => {
		// ⛔ THE SCRAPER'S OWN NON-VACUITY, ON A SYNTHETIC SOURCE. Every other assertion in this file
		// is only as good as the regexes above, and `/rule:\s*'([^']+)'/` was blind to an entry
		// written with double quotes: adding `{ rule: "no-timer", … }` to the real `AMBIENT_GLOBALS`
		// table left all nine assertions green. Driving the parsers over a fixture is the only way to
		// test a parser without waiting for the bug.
		const TABLE = [
			'const AMBIENT_GLOBALS: AmbientRule[] = [',
			"  { rule: 'no-fetch', re: /x/ },",
			'  { rule: "no-timer", re: /y/ },',
			'];',
			"findings.push({ rule: 'syntax', message: 'm' });",
			'findings.push({ rule: "no-clock", message: "m" });',
			''
		].join('\n');
		expect(ambientRules(TABLE)).toEqual(['no-fetch', 'no-timer']);
		expect(pushedRules(TABLE)).toEqual(['syntax', 'no-clock']);

		const SWITCH = [
			'export function scanFindingLabel(finding: LintFinding): string {',
			"	switch (finding.rule) {",
			"		case 'no-eval':",
			'		case "no-timer":',
			'	}',
			'}',
			''
		].join('\n');
		expect(switchCases('scanFindingLabel', SWITCH)).toEqual(['no-eval', 'no-timer']);

		// …and the REAL sources still parse the same way through the widened regexes, so the fix did
		// not buy the fixture at the cost of the thing it guards.
		expect(ambient).toHaveLength(8);
		expect(pushed).toHaveLength(5);
		expect(cases).toHaveLength(13);
	});

	it('both /block-edit render sites go through this module, and neither prints `f.message`', () => {
		// ⛔ THE DEFECT VERBATIM. Both lists rendered `<code>{f.rule}</code> {f.message}` — the
		// backend's English — beside a localized counter. A module nothing calls fixes nothing, and a
		// third list added later would reintroduce the exact bug, so the count is pinned.
		const page = stripComments(
			readFileSync(new URL('../../routes/block-edit/+page.svelte', import.meta.url), 'utf8')
		);
		expect([...page.matchAll(/scanFindingLabel\(f\)/g)]).toHaveLength(2);
		expect(page).toContain("from '$lib/i18n/scan-finding-label'");
		expect(page, 'a findings list still renders the backend English directly').not.toMatch(
			/\{f\.message\}/
		);
	});
});
