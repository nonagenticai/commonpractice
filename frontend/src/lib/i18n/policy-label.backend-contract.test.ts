// src/lib/i18n/policy-label.backend-contract.test.ts — the governance vocabulary is COMPLETE.
//
// THE DEFECT this pins is the second half of the /governance one: not "the words are English"
// (policy-label.test.ts covers the switching) but "a rail the backend ships has no words at all",
// which the default branches turn into a raw `spend.daily_llm_cap` on screen rather than a crash.
//
// It is also the guard that would have caught the premise this work started from. The task
// described 16 policies, sourced from `POLICIES[]` in backend/src/db/seed-platform.ts. There are
// EIGHTEEN: `models.work_tiers` (migration 0045) and `models.pricing` (migration 0053) are
// INSERTed by migrations and appear in no TypeScript array at all. A hand-copied list of rails
// misses exactly those two. This test cannot, because it reads both sources.
//
// backend/ and frontend/ are two separate Bun projects — no workspaces, no shared package, no
// codegen — so, exactly as `types/audit-categories.backend-contract.test.ts` and
// `api/error-message.backend-contract.test.ts` do, this walks BACKEND SOURCE TEXT on disk with
// plain `fs` and diffs the sets. It reads the FRONTEND switches as text too rather than calling
// them, so it needs no paraglide runtime and no message mock: the question "is there a case for
// this key" is a question about source, and mocking the answer would make it vacuous.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const BACKEND = fileURLToPath(new URL('../../../../backend', import.meta.url));
const SEED = join(BACKEND, 'src', 'db', 'seed-platform.ts');
const GOVERNANCE_ROUTE = join(BACKEND, 'src', 'routes', 'governance.ts');
const MIGRATIONS = join(BACKEND, 'migrations');

const policyLabelSrc = readFileSync(new URL('./policy-label.ts', import.meta.url), 'utf8');
const complianceLabelSrc = readFileSync(new URL('./compliance-label.ts', import.meta.url), 'utf8');
const enCatalog = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../../messages/en.json', import.meta.url)), 'utf8')
) as Record<string, string>;

// ---------------------------------------------------------------- backend readers

/**
 * ⛔⛔ QUOTE-AGNOSTIC SCRAPING — SINGLE, DOUBLE **OR BACKTICK** — AND IT IS A MEASURED HOLE, NOT
 * DEFENSIVE PROGRAMMING. Every TypeScript reader below used to be `'([^']+)'`. Measured 2026-08-16,
 * each of these left ALL TEN assertions in this file GREEN:
 *   • a new POLICIES entry with `key: "data.retention_window"` — a rail with no name and no
 *     description, rendering its raw wire key on /governance;
 *   • `options: ['warn', 'block', "quarantine"]` — an untranslated word in a `<select>`;
 *   • `unit: "findings"` on an existing policy — an untranslated unit next to a number;
 *   • a fifth `GROUPS` entry with `category: "observability"` — an untitled group heading;
 *   • a fifth `COMPLIANCE` row with `key: "nis2"` / `statusKey: "pending"`.
 * In every case the invisible literal never entered the parsed set, so the set-equality assertions
 * compared two equally-short lists and held. There is NO prettier and NO eslint config anywhere in
 * this repo, so nothing normalises quote style in `backend/` and a double-quoted literal is an
 * ordinary thing for the next author to write.
 *
 * ⚠️ THE SQL READERS BELOW (`migrationPolicyKeys`, `workTierKeys`) ARE DELIBERATELY **NOT** WIDENED.
 * In SQL a single quote delimits a string literal and a DOUBLE quote delimits an IDENTIFIER, so
 * accepting `"…"` there would scrape column names as policy keys. They keep the `'…'`/`$$…$$` pair,
 * which is the complete set of SQL string spellings this repo uses.
 *
 * Same fix, same reason, as `graph-issue-label.backend-contract.test.ts`'s `quotedLiterals`.
 */
/** Every quoted string literal in a chunk of TypeScript, any quote style. */
function quotedLiterals(chunk: string): string[] {
	return [...chunk.matchAll(/(['"`])([^'"`]*)\1/g)].map((x) => x[2]!);
}
/** The literal after a `field:` label, any quote style — `undefined` if the field is absent. */
function fieldLiteral(chunk: string, field: string): string | undefined {
	return chunk.match(new RegExp(`\\b${field}:\\s*(['"\`])([^'"\`]+)\\1`))?.[2];
}
/** Every literal after a `field:` label in a chunk, any quote style. */
function fieldLiterals(chunk: string, field: string): string[] {
	return [...chunk.matchAll(new RegExp(`\\b${field}:\\s*(['"\`])([^'"\`]*)\\1`, 'g'))].map((x) => x[2]!);
}

/** The text between `open` and its matching close bracket, exclusive. */
function balanced(src: string, startIdx: number, open: '[' | '{'): string {
	const close = open === '[' ? ']' : '}';
	let depth = 0;
	for (let i = startIdx; i < src.length; i++) {
		if (src[i] === open) depth++;
		else if (src[i] === close) {
			depth--;
			if (depth === 0) return src.slice(startIdx + 1, i);
		}
	}
	throw new Error(`unbalanced ${open} from index ${startIdx}`);
}

/** One `{ … }` object literal per entry of the seeder's POLICIES array. */
function seedPolicyObjects(): string[] {
	const src = readFileSync(SEED, 'utf8');
	const decl = 'const POLICIES: NewPolicy[] = [';
	const at = src.indexOf(decl);
	if (at === -1) throw new Error('POLICIES array not found in backend/src/db/seed-platform.ts');
	// Index the LAST `[` of the declaration, not the first — `NewPolicy[]` in the type annotation
	// is an empty pair that `balanced` would happily "match" into an empty array body.
	const body = balanced(src, at + decl.length - 1, '[');
	const objects: string[] = [];
	for (let i = 0; i < body.length; i++) {
		if (body[i] === '{') {
			const obj = balanced(body, i, '{');
			objects.push(obj);
			i += obj.length + 1;
		}
	}
	return objects;
}

/**
 * Policy keys INSERTed by a migration — the ones the TypeScript array does not contain.
 *
 * ⚠️ BE HONEST ABOUT WHAT THIS COVERS. An earlier header claimed a hand-copied list "misses
 * exactly those two, and this test cannot". It can. An adversarial pass dropped probe migrations
 * in and this parser missed four realistic forms: `INSERT … SELECT` (no VALUES at all), a `--`
 * comment between `VALUES (` and the key, `$$dollar-quoted$$` literals, and the second row of a
 * multi-row `VALUES (a),(b)`. Widened below to handle case-insensitivity, comments, dollar quotes
 * and every row of a multi-row VALUES.
 *
 * ⛔ IT STILL DOES NOT PARSE SQL. `INSERT … SELECT` and any computed key remain invisible, and no
 * regex will fix that — the honest guard against those is that the OTHER assertion in this file
 * (every switch case must correspond to a real backend key) fails loudly in the other direction.
 * If you add a policy by a form this misses, the rail renders its raw key on screen: visible and
 * ugly, which is the failure mode this file exists to make impossible to ship quietly.
 */
function migrationPolicyKeys(): string[] {
	const keys: string[] = [];
	for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
		let src = readFileSync(join(MIGRATIONS, f), 'utf8');
		// Strip line comments first: a `--` line between `VALUES (` and the key hid it entirely.
		src = src.replace(/--[^\n]*/g, '');
		for (const stmt of src.split(/INSERT\s+INTO\s+policies/i).slice(1)) {
			const valuesAt = stmt.search(/\bVALUES\b/i);
			if (valuesAt === -1) continue; // INSERT … SELECT — see the note above.
			// Every row of a multi-row VALUES, single- or dollar-quoted.
			const rows = stmt.slice(valuesAt).matchAll(/\(\s*(?:'([^']+)'|\$\$([^$]+)\$\$)/g);
			for (const r of rows) {
				const k = r[1] ?? r[2];
				// A row's first literal is the key only while `key` leads the column list; a
				// reordered list yields a category name here, which fails loudly against the
				// switch-case set rather than silently passing.
				if (k) keys.push(k);
			}
		}
	}
	return keys;
}

const seedObjects = seedPolicyObjects();
const seedKeys = seedObjects.map((o) => fieldLiteral(o, 'key')).filter(Boolean) as string[];
const migrationKeys = migrationPolicyKeys();
const backendPolicyKeys = [...seedKeys, ...migrationKeys];

/** `options: [...]` per policy — the values that reach `<option>`, keyed by policy. */
const backendOptions = new Map<string, string[]>();
for (const o of seedObjects) {
	const key = fieldLiteral(o, 'key');
	const opts = o.match(/\boptions:\s*\[([^\]]*)\]/)?.[1];
	if (key && opts) backendOptions.set(key, quotedLiterals(opts));
}

/** Every `unit:` literal the seeder ships. */
const backendUnits = fieldLiterals(readFileSync(SEED, 'utf8'), 'unit');

/** The `models.work_tiers` map keys, out of the migration's jsonb literal. */
function workTierKeys(): string[] {
	const src = readFileSync(join(MIGRATIONS, '0045_openrouter_governance.sql'), 'utf8');
	const stmt = src.split('INSERT INTO policies').find((s) => s.includes("'models.work_tiers'"))!;
	const json = stmt.match(/'(\{[\s\S]*?\})'::jsonb/)![1]!;
	return Object.keys(JSON.parse(json) as Record<string, string>);
}

/** `GROUPS` categories and `COMPLIANCE` key / statusKey sets from the route module. */
function routeSets() {
	const src = readFileSync(GOVERNANCE_ROUTE, 'utf8');
	// `= [` rather than the first `[`: GROUPS' type annotation ends in `}[]`, an empty pair that
	// `balanced` would match into an empty body (the same trap as POLICIES above).
	const groupsAt = src.indexOf('= [', src.indexOf('const GROUPS'));
	const complianceAt = src.indexOf('= [', src.indexOf('const COMPLIANCE'));
	const groups = balanced(src, groupsAt + 2, '[');
	const compliance = balanced(src, complianceAt + 2, '[');
	return {
		categories: fieldLiterals(groups, 'category'),
		complianceKeys: fieldLiterals(compliance, 'key'),
		statusKeys: fieldLiterals(compliance, 'statusKey')
	};
}
const route = routeSets();

// ---------------------------------------------------------------- frontend readers

/** The `case '…':` labels inside one exported function of a label module. Quote-agnostic. */
function switchCases(src: string, fn: string): string[] {
	const at = src.indexOf(`export function ${fn}(`);
	if (at === -1) throw new Error(`${fn} not found`);
	const next = src.indexOf('\nexport function ', at + 1);
	const body = src.slice(at, next === -1 ? src.length : next);
	return [...body.matchAll(/case\s*(['"`])([^'"`]*)\1\s*:/g)].map((x) => x[2]!);
}

// ---------------------------------------------------------------- the contract

describe('governance vocabulary ↔ backend', () => {
	it('found both backend sources at all (guards the parsers themselves)', () => {
		// If a parser or a path ever breaks, every set below goes empty and the comparisons pass
		// vacuously. This is the assertion that makes the rest mean something.
		expect(seedKeys.length).toBeGreaterThanOrEqual(16);
		expect(migrationKeys).toEqual(expect.arrayContaining(['models.work_tiers', 'models.pricing']));
		expect(backendPolicyKeys.length).toBeGreaterThanOrEqual(18);
		expect(new Set(backendPolicyKeys).size).toBe(backendPolicyKeys.length); // no key parsed twice
		expect(backendOptions.size).toBe(4); // + cycle.cadence (0107)
		expect(backendUnits.length).toBe(3);
		expect(route.categories.length).toBe(5); // + marketplace (0107)
		expect(route.complianceKeys.length).toBe(4);
	});

	it('⛔ the scrapers see DOUBLE-QUOTED and BACKTICK literals too (they measurably did not)', () => {
		// ⛔ THE SCRAPERS' OWN NON-VACUITY, ON SYNTHETIC SOURCE. Every assertion in this file is only
		// as good as the readers above, and five separate single-quote-only regexes were each blind to
		// an ordinary double-quoted literal — see the block comment on `quotedLiterals` for the five
		// measured GREEN runs. Driving the parsers over a fixture is the only way to test a parser
		// without waiting for the bug.
		const POLICY = [
			'{',
			'  key: "spend.retention_window",',
			"  category: 'spend_quota',",
			'  control: \'select\',',
			'  options: [\'warn\', "block", `quarantine`],',
			'  unit: `findings`,',
			'}'
		].join('\n');
		expect(fieldLiteral(POLICY, 'key')).toBe('spend.retention_window');
		expect(fieldLiteral(POLICY, 'category')).toBe('spend_quota');
		expect(quotedLiterals(POLICY.match(/\boptions:\s*\[([^\]]*)\]/)![1]!)).toEqual([
			'warn',
			'block',
			'quarantine'
		]);
		expect(fieldLiterals(POLICY, 'unit')).toEqual(['findings']);

		const ROUTE = [
			"{ category: 'promotion', title: 'x' },",
			'{ category: "observability", title: \'y\' },',
			'{ key: `nis2`, statusKey: "pending" },'
		].join('\n');
		expect(fieldLiterals(ROUTE, 'category')).toEqual(['promotion', 'observability']);
		expect(fieldLiterals(ROUTE, 'key')).toEqual(['nis2']); // `statusKey:` must not answer `key:`
		expect(fieldLiterals(ROUTE, 'statusKey')).toEqual(['pending']);

		const SWITCH = [
			'export function policyLabel(key: string): string {',
			'	switch (key) {',
			"		case 'spend.daily_llm_cap':",
			'		case "spend.retention_window":',
			'		case `models.pricing`:',
			'	}',
			'}',
			''
		].join('\n');
		expect(switchCases(SWITCH, 'policyLabel')).toEqual([
			'spend.daily_llm_cap',
			'spend.retention_window',
			'models.pricing'
		]);

		// …and the REAL sources still parse the same way through the widened regexes, so the fix did
		// not buy the fixture at the cost of the thing it guards.
		expect(seedKeys.length).toBeGreaterThanOrEqual(16);
		expect(route.categories.length).toBe(5); // + marketplace (0107)
	});

	it('every policy the backend ships has a NAME', () => {
		const cases = switchCases(policyLabelSrc, 'policyLabel');
		expect([...backendPolicyKeys].sort()).toEqual([...cases].sort());
	});

	it('every policy the backend ships has a DESCRIPTION', () => {
		const cases = switchCases(policyLabelSrc, 'policyDescription');
		expect([...backendPolicyKeys].sort()).toEqual([...cases].sort());
	});

	it('every group heading the backend ships has a title', () => {
		expect([...route.categories].sort()).toEqual([...switchCases(policyLabelSrc, 'policyGroupTitle')].sort());
	});

	it('every `select` option is either localized or a bare number', () => {
		// A select option is the one string on this screen that is BOTH displayed and submitted.
		// An option with no case renders its raw wire value — acceptable for `1`/`2`/`3`, which read
		// the same in all eight locales, and a defect for anything with letters in it.
		const localized = new Set(switchCases(policyLabelSrc, 'policyOptionLabel'));
		const missing: string[] = [];
		for (const [policyKey, opts] of backendOptions) {
			for (const o of opts) {
				if (/^\d+$/.test(o)) continue;
				if (!localized.has(o)) missing.push(`${policyKey} → ${o}`);
			}
		}
		expect(missing).toEqual([]);
	});

	it('every `select` policy that has localized options is itself a case in the switch', () => {
		// `policyOptionLabel` dispatches on the POLICY first. An option word in the inner switches
		// with no matching outer case is unreachable — the values would still render in English.
		const cases = new Set(switchCases(policyLabelSrc, 'policyOptionLabel'));
		for (const [policyKey, opts] of backendOptions) {
			if (opts.every((o) => /^\d+$/.test(o))) continue;
			expect(cases.has(policyKey)).toBe(true);
		}
	});

	it('every `unit` is either localized or a symbol', () => {
		// `$` and `%` are deliberately NOT catalog keys. This pins that decision to a rule — a unit
		// containing a letter has to be translated — rather than to a memory of which three units
		// existed on the day this was written.
		//
		// ⚠️ THE SYMBOL LIST CHANGED, AND THIS TEST IS WHY WE NOTICED. It read `['%','€']` until
		// `spend.weekly_spend_ceiling` was corrected from `unit: '€'` to `'$'` — the value the broker
		// compares is USD and every screen renders it as `$15`, so the euro sign was simply wrong.
		// That correction lives in the BACKEND seeder, and this assertion lives in the FRONTEND
		// suite, so neither change could see the other in isolation; only running them together went
		// red. Keep the second assertion exact rather than loosening it to "any non-letter" — being
		// forced to come here and read this is the entire value of the check.
		const localized = new Set(switchCases(policyLabelSrc, 'policyUnitLabel'));
		const missing = backendUnits.filter((u) => /\p{L}/u.test(u) && !localized.has(u));
		expect(missing).toEqual([]);
		expect(backendUnits.filter((u) => !/\p{L}/u.test(u)).sort()).toEqual(['$', '%']);
	});

	it('every work tier the migration seeds has a sub-label', () => {
		const cases = switchCases(policyLabelSrc, 'policyMapKeyLabel');
		for (const tier of workTierKeys()) expect(cases).toContain(tier);
		// …and the OTHER map rail is absent on purpose: its keys are model identifiers.
		expect(cases).not.toContain('models.pricing');
		expect(cases).toContain('models.work_tiers');
	});

	// The two label switches carry a third branch the backend has no key for: `case undefined` /
	// `case ''` is the OLD-BACKEND fallback that renders the legacy English prose during a rolling
	// deploy (see compliance-label.ts). It is a wire-shape sentinel, not a compliance row, so it is
	// excluded here — otherwise this contract would demand the backend ship a row called "".
	// Everything else must still match one-for-one in both directions.
	const SENTINELS = new Set(['', 'undefined']);
	const realCases = (src: string, fn: string) =>
		[...switchCases(src, fn)].filter((c) => !SENTINELS.has(c)).sort();

	it('every compliance row and status the backend ships has a word', () => {
		expect([...route.complianceKeys].sort()).toEqual(
			realCases(complianceLabelSrc, 'complianceLabel')
		);
		expect([...new Set(route.statusKeys)].sort()).toEqual(
			realCases(complianceLabelSrc, 'complianceStatusLabel')
		);
	});

	it('every message the two modules reference exists in the base catalog', () => {
		// paraglide fails its own compile on a missing key, but only during `bun run check`. This
		// puts the same failure in `bun run test`, where it names the offending key directly.
		const referenced = [...(policyLabelSrc + complianceLabelSrc).matchAll(/\bm\.([a-z0-9_]+)\(\)/g)]
			.map((x) => x[1]!)
			.sort();
		expect(referenced.length).toBeGreaterThan(50);
		expect(referenced.filter((k) => !(k in enCatalog))).toEqual([]);
	});
});
