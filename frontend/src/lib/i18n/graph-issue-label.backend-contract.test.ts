// src/lib/i18n/graph-issue-label.backend-contract.test.ts — the graph-validation vocabulary is
// COMPLETE, and the machine fields it interpolates are really on the wire.
//
// THE DEFECT THIS PINS is the one that only appears LATER. `graphIssueLabel` falls back to the
// backend's English whenever the rule is unknown or a `detail` field is absent — deliberately, so
// a rule shipped backend-first and an old pod mid-roll both degrade instead of vanishing. That
// fallback is a safety net, not a destination, and it is INVISIBLE when it fires: rename
// `sourceHandle` to `srcHandle` in backend/src/exec/flow-validate.ts and every handle issue in
// every locale quietly reverts to English, with every frontend unit test still green (they build
// their own fixtures) and nothing in CI saying a word. Same for a THIRTEENTH `GraphIssueRule`.
// This is the file that reds.
//
// backend/ and frontend/ are two separate Bun projects — no workspaces, no shared package, no
// codegen — so, exactly as `data-finding-label.backend-contract.test.ts` and
// `notification-label.backend-contract.test.ts` do, this walks BACKEND SOURCE TEXT on disk with
// plain `fs` and diffs the sets. It reads the FRONTEND switch as text too rather than calling it:
// "is there a case for this rule" is a question about source, and mocking the answer would make it
// vacuous.
//
// ⛔ THE ONE THING IT DOES DRIVE is the mid-roll table at the bottom, because "returns the English"
// is a question about BEHAVIOUR that no amount of source reading can answer. The catalog is mocked
// to a loud sentinel there, so a message reached by mistake shows up in the diff by name.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const MOCK = vi.hoisted(() => {
	const keys = [
		'graph_issue_edge_missing_source',
		'graph_issue_edge_missing_target',
		'graph_issue_duplicate_node_id',
		'graph_issue_duplicate_edge_id',
		'graph_issue_cycle',
		'graph_issue_unknown_source_handle',
		'graph_issue_unknown_target_handle',
		'graph_issue_incompatible_handle_type',
		'graph_issue_missing_required_input',
		'graph_issue_missing_descriptor',
		'graph_issue_nested_foreach',
		'graph_issue_orphan_loop_body'
	];
	return Object.fromEntries(keys.map((k) => [k, () => `CATALOG(${k})`]));
});
vi.mock('$lib/paraglide/messages', () => MOCK);

const { graphIssueLabel } = await import('./graph-issue-label');

const BACKEND = fileURLToPath(new URL('../../../../backend', import.meta.url));
const VALIDATE = join(BACKEND, 'src', 'exec', 'flow-validate.ts');

const backendSrc = readFileSync(VALIDATE, 'utf8');
const labelSrc = readFileSync(new URL('./graph-issue-label.ts', import.meta.url), 'utf8');
const enCatalog = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../../messages/en.json', import.meta.url)), 'utf8')
) as Record<string, unknown>;

// ---------------------------------------------------------------- backend readers

/**
 * Every quoted string literal in a chunk of TypeScript, SINGLE **OR DOUBLE** QUOTED.
 *
 * ⛔⛔ THE DOUBLE-QUOTE HALF IS NOT DEFENSIVE PROGRAMMING, IT IS A MEASURED HOLE. This scrape used
 * to be `/'([^']+)'/g`. Adding `| "unreachable-node";` to the backend union — one member, one pair
 * of double quotes — left ALL EIGHT assertions in this file GREEN, and the non-vacuity anchor still
 * read `12`, because the invisible member never entered the parsed set at all. There is NO prettier
 * and NO eslint config anywhere in this repo (verified: no `.prettierrc*`, `prettier.config*`,
 * `.eslintrc*`, `eslint.config*` outside node_modules), so nothing normalises quote style in
 * `backend/` and a double-quoted literal is a perfectly ordinary thing for the next author to write.
 *
 * ⚠️ THE SAME HOLE IS OPEN IN FOUR SIBLING CONTRACT TESTS — `data-finding-label`, `policy-label`,
 * `notification-label` and (until it was fixed alongside this one) `scan-finding-label`. They are
 * NOT touched here on purpose: widening a house-wide gap belongs in its own change, not smuggled
 * into an i18n branch. Reported for follow-up.
 */
function quotedLiterals(chunk: string): string[] {
	return [...chunk.matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => (x[1] ?? x[2])!);
}

/**
 * The members of the `GraphIssueRule` union, out of the backend's `export type` line.
 *
 * ⛔ IT DOES NOT PARSE TYPESCRIPT. A union assembled from another type, or one wrapped in a shape
 * this regex misses, is invisible to it — which is why the first assertion below pins the parsed
 * set to an exact width and to two named members. If the declaration is ever reshaped, that
 * assertion fails loudly rather than every later comparison passing vacuously against an empty set.
 */
function backendRules(src: string = backendSrc): string[] {
	const decl = src.match(/export type GraphIssueRule\s*=([^;]+);/);
	if (!decl) throw new Error('GraphIssueRule not found in backend/src/exec/flow-validate.ts');
	return quotedLiterals(decl[1]!);
}

/**
 * Every field declared on the backend's `GraphIssueDetail` interface.
 *
 * Cloned from `backendFindingFields()` in `notification-label.backend-contract.test.ts` — same
 * two-space-indent `name?:` scrape, same reason.
 */
function backendDetailFields(): string[] {
	const at = backendSrc.indexOf('export interface GraphIssueDetail {');
	if (at === -1) throw new Error('GraphIssueDetail interface not found');
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
	return [...body.matchAll(/case\s*['"]([^'"]*)['"]\s*:/g)].map((x) => x[1]!);
}

/**
 * Every `detail` field the module actually READS — both the `d.<field>` interpolations and the
 * names quoted inside the `has(d, …)` guards, which are the fields it refuses to render without.
 *
 * Quote-agnostic for the same measured reason as `quotedLiterals` above.
 */
function frontendDetailFields(src: string = labelSrc): string[] {
	const direct = [...src.matchAll(/\bd\.([A-Za-z]\w*)/g)].map((x) => x[1]!);
	const guarded = [...src.matchAll(/\bhas\(d,([^)]*)\)/g)].flatMap((x) => quotedLiterals(x[1]!));
	return [...new Set([...direct, ...guarded])];
}

const rules = backendRules();
const cases = switchCases('graphIssueLabel');

// ---------------------------------------------------------------- the contract

describe('graph-issue vocabulary ↔ backend', () => {
	it('found the backend declarations at all (guards the parsers themselves)', () => {
		// ⛔ THE NON-VACUITY ANCHOR, AND IT COMES FIRST ON PURPOSE. If a parser or a path breaks,
		// every set below goes empty and each comparison passes against nothing. This is the
		// assertion that makes the rest mean something.
		expect(rules).toHaveLength(12);
		expect(rules).toEqual(expect.arrayContaining(['cycle', 'incompatible-handle-type']));
		expect(cases.length).toBeGreaterThanOrEqual(12);
		expect(backendDetailFields().length).toBeGreaterThanOrEqual(10);
	});

	it('every rule the backend can emit has a SENTENCE — no rule renders English by default', () => {
		// ⛔ THIS IS THE GUARD. Add a thirteenth `GraphIssueRule` backend-first and this goes red
		// here, naming it, instead of shipping an English sentence into seven non-English locales
		// at the exact moment a demo goes wrong.
		expect([...rules].sort()).toEqual([...new Set(cases)].sort());
	});

	it('every case in the switch is a rule the backend actually emits', () => {
		// The other direction: a case for a rule that no longer exists is dead code carrying a dead
		// catalog key in eight languages. Implied by the equality above; asserted separately so the
		// failure message says which direction broke.
		for (const c of cases) expect(rules).toContain(c);
	});

	it('every message the module references exists in the base catalog', () => {
		// paraglide fails its own compile on a missing key, but only during `bun run check`. This
		// puts the same failure in `bun run test`, where it names the offending key directly.
		const referenced = [...labelSrc.matchAll(/\bm\.([a-z0-9_]+)\(/g)].map((x) => x[1]!);
		expect(referenced).toHaveLength(12);
		expect(referenced.filter((k) => !(k in enCatalog))).toEqual([]);
		// …and the mock above really shadows every one of them, or the driven table below would be
		// calling the REAL catalog and asserting against English copy.
		expect(referenced.filter((k) => !(k in MOCK))).toEqual([]);
	});

	it('⛔ every `detail` field this module reads is DECLARED on the backend interface', () => {
		// THE RENAME GUARD. `graphIssueLabel` reads `d.sourceHandle` and refuses to render without
		// it. If the backend drops or renames that field the switch takes the mid-roll branch
		// FOREVER — silently, because that branch is a legitimate runtime state and nothing throws.
		// Every frontend unit test would stay green on its own fixtures. Pin the names to the source.
		const declared = backendDetailFields();
		const read = frontendDetailFields();
		expect(read.length).toBeGreaterThanOrEqual(10);
		expect(read.filter((f) => !declared.includes(f))).toEqual([]);
	});

	it('the wire shape itself is still declared — `rule` and `detail` on `GraphIssue`', () => {
		// ⛔ THE `detail:` OCCURRENCE COUNT THAT USED TO LIVE HERE IS GONE, DELIBERATELY, AND MUST NOT
		// COME BACK. It asserted `[...backendSrc.matchAll(/detail:\s*\{/g)].length >= 9` — a COUNT,
		// not a contract. Measured: deleting `unknown-source-handle`'s bag AND adding one to
		// `duplicate-node-id` keeps the count at nine and left the ENTIRE repo green (backend 53/0,
		// frontend 30 files / 451 tests), while silently reverting a rule to English in all eight
		// locales forever. Substituting `src!.id` for `src!.slug` was invisible to it too.
		//
		// The real guard is PER RULE, BY NAME, ON THE VALUE, and it has to run the validator rather
		// than read it: `backend/tests/graph-issue-machine-fields.test.ts` — the same standard
		// `backend/tests/static-scan-machine-fields.test.ts` set for the lint vocabulary. What is
		// left here is the part a source scrape genuinely answers: the two fields exist on the wire
		// type at all.
		expect(backendSrc).toContain('rule: GraphIssueRule');
		expect(backendSrc).toContain('detail?: GraphIssueDetail');
	});

	it('⛔ the scrapers see a DOUBLE-QUOTED declaration too (they measurably did not)', () => {
		// ⛔ THE SCRAPER'S OWN NON-VACUITY, ON A SYNTHETIC SOURCE. Every other assertion in this file
		// is only as good as the regexes above, and `/'([^']+)'/` was blind to a member written with
		// double quotes: adding `| "unreachable-node";` to the real backend union left all eight
		// assertions green and the anchor still reading 12. Nothing in the repo normalises quote
		// style — there is no prettier and no eslint config anywhere — so this is a shape the next
		// author can write by accident. Driving the parsers over a fixture is the only way to test a
		// parser without waiting for the bug.
		const FIXTURE = [
			"export type GraphIssueRule =",
			"  | 'edge-missing-source'",
			'  | "unreachable-node"',
			"  | 'cycle';",
			''
		].join('\n');
		expect(backendRules(FIXTURE)).toEqual(['edge-missing-source', 'unreachable-node', 'cycle']);

		const SWITCH = [
			'export function graphIssueLabel(issue: GraphIssue): string {',
			"	switch (issue.rule) {",
			"		case 'cycle':",
			'		case "unreachable-node":',
			"			if (!has(d, 'node', \"parent\")) return issue.message;",
			'	}',
			'}',
			''
		].join('\n');
		expect(switchCases('graphIssueLabel', SWITCH)).toEqual(['cycle', 'unreachable-node']);
		expect(frontendDetailFields(SWITCH).sort()).toEqual(['node', 'parent']);

		// …and the REAL sources still parse the same way through the widened regexes, so the fix did
		// not buy the fixture at the cost of the thing it guards.
		expect(rules).toHaveLength(12);
		expect(cases).toHaveLength(12);
	});
});

describe('⛔ the mid-roll shape: a KNOWN rule with no `detail` renders the backend English', () => {
	const PROSE = 'BACKEND ENGLISH — the only thing an old pod ships';

	it('holds for every rule the backend declares, driven from the scrape', () => {
		// ⛔ DRIVEN FROM `rules`, NOT FROM A HAND-WRITTEN LIST. A thirteenth rule that forgets its
		// mid-roll guard is caught here the moment it is added to the union — the hand-written table
		// in `graph-issue-label.test.ts` would not have a row for it.
		//
		// The three rules that take no `detail` at all are the deliberate exceptions: `cycle` has no
		// parameters, and the duplicate-* pair reads `ref`, which predates this change. Everything
		// else must return the English byte for byte.
		expect(rules).toHaveLength(12);
		const noDetailNeeded = new Set(['cycle', 'duplicate-node-id', 'duplicate-edge-id']);
		let asserted = 0;
		for (const rule of rules) {
			const out = graphIssueLabel({ rule, message: PROSE, ref: 'e1' });
			if (noDetailNeeded.has(rule)) {
				expect(out, `${rule} needs no detail and must NOT fall back`).not.toBe(PROSE);
				continue;
			}
			expect(out, `${rule} rendered the catalog with no detail on the wire`).toBe(PROSE);
			asserted++;
		}
		// The loop asserted something for every rule, and the fallback half is the majority of them.
		expect(asserted).toBe(rules.length - noDetailNeeded.size);
		expect(asserted).toBeGreaterThanOrEqual(9);
	});

	it('and the exceptions really do reach the catalog, so the table is not trivially true', () => {
		// Without this, a `graphIssueLabel` that returned `issue.message` unconditionally would pass
		// every assertion above.
		expect(graphIssueLabel({ rule: 'cycle', message: PROSE })).toBe('CATALOG(graph_issue_cycle)');
		expect(graphIssueLabel({ rule: 'duplicate-node-id', message: PROSE, ref: 'n1' })).toBe(
			'CATALOG(graph_issue_duplicate_node_id)'
		);
	});
});
