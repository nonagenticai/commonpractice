// src/lib/i18n/block-test-error-label.backend-contract.test.ts — the block-run refusal vocabulary
// is COMPLETE, the machine fields it interpolates are really on the wire, and a NEW
// product-authored refusal cannot be written without a rule.
//
// THE DEFECT THIS PINS is the one that only appears LATER. `blockTestErrorLabel` falls back to the
// backend's English whenever the rule is unknown or a `detail` field is absent — deliberately, so
// an archived trace, an old pod mid-roll, and a BLOCK AUTHOR'S OWN THROW all degrade to raw text
// instead of vanishing. That fallback is a safety net, not a destination, and it is INVISIBLE when
// it fires. Two ways to fall into it silently:
//
//   1. Rename `detail.expectedKind` in the backend → every wrong-error-kind failure in every locale
//      quietly reverts to English, with every frontend unit test still green on its own fixtures.
//   2. Add a 29th product refusal — `throw new Error('the runner refused X')` — and it ships as
//      untranslatable English into seven non-English locales, forever, silently.
//
// (2) is the one no sibling contract test in this repo guards, because the sibling vocabularies
// (graph issues, lint findings, scan findings) are CLOSED unions the backend already declares. This
// one is not: `classify()` funnels a block author's arbitrary `throw` through the SAME `ev.error`
// field as the runner's own refusals, so "is this string a product rule or an author's sentence?"
// is answered by the PRESENCE OF `rule` and by nothing else. The three assertions under "no
// unruled product site" are what keep that answer true as the executor grows.
//
// backend/ and frontend/ are two separate Bun projects — no workspaces, no shared package, no
// codegen — so, exactly as `graph-issue-label.backend-contract.test.ts` does, this walks BACKEND
// SOURCE TEXT on disk with plain `fs` and diffs the sets.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { stripComments } from '$lib/test/source-scan';

const MOCK = vi.hoisted(() => {
	// Reached only by the mid-roll table at the bottom; a message resolved by mistake shows up in
	// the diff BY NAME rather than as plausible English copy.
	//
	// ⛔ `then` AND EVERY SYMBOL MUST RETURN `undefined`, AND THE SYMPTOM IS A HANG, NOT A FAILURE.
	// A module namespace whose `then` is callable is THENABLE, so vitest's `await import(…)` of the
	// mocked module awaits itself forever: the suite reported "(0 test)" and then never terminated
	// (measured — `vitest run` on this one file had to be SIGTERM'd at 100s). Returning a function
	// for literally every key is the shape that makes a Proxy mock convenient AND is the shape that
	// deadlocks it.
	return new Proxy({} as Record<string, unknown>, {
		get: (_t, k) => {
			if (typeof k !== 'string' || k === 'then' || k === '__esModule') return undefined;
			return (i?: Record<string, unknown>) =>
				`CATALOG(${k})${i ? `[${Object.values(i).join('|')}]` : ''}`;
		},
		has: (_t, k) => typeof k === 'string' && k !== 'then' && k !== '__esModule'
	});
});
vi.mock('$lib/paraglide/messages', () => MOCK);

const { blockTestErrorLabel } = await import('./block-test-error-label');

const BACKEND = fileURLToPath(new URL('../../../../backend', import.meta.url));
const TRACE_TYPES = join(BACKEND, 'src', 'db', 'trace-types.ts');
const DESCRIPTOR = join(BACKEND, 'src', 'exec', 'descriptor.ts');
const EXECUTOR = join(BACKEND, 'src', 'exec', 'flow-executor.ts');
const TEST_RUNNER = join(BACKEND, 'src', 'blocks', 'test-runner.ts');
// ⛔⛔ THE THREE FILES ABOVE WERE ONCE CLAIMED — IN THIS FILE, IN PROSE — TO "compose EVERY product
// English sentence that can reach `ev.error` / `outcome.error`". THEY DID NOT, AND THE CLAIM IS WHY
// NOBODY LOOKED. Six product sentences lived outside them and shipped raw into seven non-English
// locales for as long as the feature existed:
//   • block-loader.ts   ×3  `block v0: module has no default export object`, and its two siblings
//   • dataset-resolver.ts   `dataset 'x' is not available in this workspace. Point the block's…`
//   • runner-entry.ts   ×2  the `host closed stdin` rejection, and — the worst of them — the LLM
//                           broker's GOVERNANCE COPY relayed verbatim: `daily LLM call cap reached
//                           (200)` and `Add your own provider key in Administer → LLM settings`.
// A comment asserting a completeness it does not have is worse than no comment: every assertion
// below was green the whole time, on a set that was missing a fifth of the vocabulary's producers.
// The set is now SIX FILES, and `attachedRules` + the unruled-prose guard walk all six.
const BLOCK_LOADER = join(BACKEND, 'src', 'exec', 'block-loader.ts');
const DATASET_RESOLVER = join(BACKEND, 'src', 'exec', 'dataset-resolver.ts');
const LLM_BROKER = join(BACKEND, 'src', 'host', 'llm-broker.ts');
const RUNNER_ENTRY = join(BACKEND, 'src', 'exec', 'runner-entry.ts');
/** Every file that may give birth to a product refusal, and the factory each one must use. */
const PRODUCT_FILES: { path: string; factories: string[] }[] = [
	{ path: EXECUTOR, factories: ['productError', 'foreachRefusal', 'skipReason'] },
	{ path: DESCRIPTOR, factories: ['issue'] },
	{ path: TEST_RUNNER, factories: ['testError'] },
	{ path: BLOCK_LOADER, factories: ['BlockModuleError'] },
	{ path: DATASET_RESOLVER, factories: ['DatasetUnavailableError'] }
];

const read = (p: string) => readFileSync(p, 'utf8');
/**
 * ⛔ COMMENTS STRIPPED BEFORE ANY SCRAPE, AND THIS WAS MEASURED, NOT PRECAUTIONARY. The backend's
 * `BlockErrorRule` union is annotated section by section, and one of those annotations reads
 * `// exec/flow-executor.ts — the runner's own refusals`. `quotedLiterals` is quote-agnostic by
 * design, so that lone APOSTROPHE opened a single-quoted literal that ran to the next apostrophe
 * many lines later — swallowing sixteen of the twenty-eight members and emitting garbage entries
 * like `"s own refusals\n  | "` into the parsed set. The non-vacuity anchor caught it (it was the
 * first assertion to red), which is exactly what that anchor is for.
 */
const traceSrc = stripComments(read(TRACE_TYPES));
const labelSrc = stripComments(
	readFileSync(new URL('./block-test-error-label.ts', import.meta.url), 'utf8')
);
const enCatalog = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../../messages/en.json', import.meta.url)), 'utf8')
) as Record<string, unknown>;

// ---------------------------------------------------------------- readers

/**
 * Every quoted string literal in a chunk of TypeScript — SINGLE, DOUBLE **OR BACKTICK**.
 *
 * ⛔ THE BACKTICK ARM IS THE BUG THIS FILE REFUSED TO INHERIT. `graph-issue-label.backend-contract
 * .test.ts` widened its own helper from single-quote-only to single-or-double after measuring that
 * a double-quoted union member was invisible to it — and stopped there. Nothing in this repo
 * normalises quote style (no prettier, no eslint config anywhere outside node_modules), and a
 * template literal is what an author reaches for the moment a rule name is assembled or a message
 * interpolates. A member written `` `field_must_be_string` `` would have been silently dropped from
 * every set below, and every assertion would have stayed green against the smaller set.
 */
function quotedLiterals(chunk: string): string[] {
	return [...chunk.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((x) => (x[1] ?? x[2] ?? x[3])!);
}

/**
 * The members of the backend's `BlockErrorRule` union.
 *
 * ⛔ IT DOES NOT PARSE TYPESCRIPT — which is why the first assertion pins the parsed set to an
 * exact width and to two named members. A reshaped declaration then fails loudly rather than making
 * every later comparison pass vacuously against an empty set.
 */
function backendRules(src: string = traceSrc): string[] {
	const decl = src.match(/export type BlockErrorRule\s*=([^;]+);/);
	if (!decl) throw new Error('BlockErrorRule not found in backend/src/db/trace-types.ts');
	return quotedLiterals(decl[1]!).filter((s) => s !== '');
}

/** Every field declared on the backend's `BlockErrorDetail` interface. */
function backendDetailFields(src: string = traceSrc): string[] {
	const at = src.indexOf('export interface BlockErrorDetail {');
	if (at === -1) throw new Error('BlockErrorDetail interface not found');
	const body = src.slice(at, src.indexOf('\n}', at));
	return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]!);
}

/** The `case '…':` labels inside one exported function of the label module. Quote-agnostic. */
function switchCases(fn: string, src: string = labelSrc): string[] {
	const at = src.indexOf(`export function ${fn}(`);
	if (at === -1) throw new Error(`${fn} not found`);
	const next = src.indexOf('\nexport function ', at + 1);
	const body = src.slice(at, next === -1 ? src.length : next);
	return [...body.matchAll(/case\s*['"`]([^'"`]*)['"`]\s*:/g)].map((x) => x[1]!);
}

/** Every `detail` field the module READS — `d.<field>` plus the names quoted in `has(d, …)`. */
function frontendDetailFields(src: string = labelSrc): string[] {
	const direct = [...src.matchAll(/\bd\.([A-Za-z]\w*)/g)].map((x) => x[1]!);
	const guarded = [...src.matchAll(/\bhas\(d,([^)]*)\)/g)].flatMap((x) => quotedLiterals(x[1]!));
	return [...new Set([...direct, ...guarded])].filter((f) => f !== '');
}

/**
 * Every rule name the backend ATTACHES at a throw/return site, across the three product files.
 *
 * ⛔ TWO SHAPES, AND MISSING THE SECOND MADE THE COVERAGE ASSERTION LIE. The factories cover every
 * THROW, but a foreach refuses by RETURNING a `ForeachResult` and `TimeoutError` declares its rule
 * as a class field — four of the twenty-eight rules (`node_timeout`, `foreach_input_not_array`,
 * `run_wall_clock_exceeded`, `foreach_event_budget_exceeded`) are attached that way and a
 * factory-only scrape reported all four as dead vocabulary. So `rule:` assignments are read too,
 * bounded to the expression (no comma, no newline) so a neighbouring property cannot leak in.
 */
function attachedRules(): string[] {
	const out: string[] = [];
	for (const p of [DESCRIPTOR, EXECUTOR, TEST_RUNNER, BLOCK_LOADER, DATASET_RESOLVER, LLM_BROKER, RUNNER_ENTRY]) {
		const src = stripComments(read(p));
		// Every factory takes the rule as its FIRST argument.
		//
		// ⚠️ `skipReason` IS DELIBERATELY ABSENT FROM THIS ALTERNATION while being present in
		// `PRODUCT_FILES`. Its first argument is a `reasonCode` (`upstream_no_output`), which is a
		// node_skipped vocabulary and NOT a `BlockErrorRule` — scraping it would inject a
		// non-member and red the "every attached rule is declared in the union" assertion. The two
		// lists answer two different questions: "where may a sentence be born" and "what rules does
		// a birth site attach".
		for (const m of src.matchAll(
			/\b(?:issue|productError|testError|foreachRefusal|BlockModuleError|DatasetUnavailableError)\(\s*['"`]([a-z_]+)['"`]/g
		))
			out.push(m[1]!);
		// `rule: 'x'`, `rule: cond ? 'a' : 'b'`, `readonly rule: BlockErrorRule = 'x'`. A bare
		// `rule?: BlockErrorRule;` type declaration yields nothing, which is correct.
		for (const m of src.matchAll(/\brule\??:[^,;\n]*/g)) out.push(...quotedLiterals(m[0]));
	}
	return [...new Set(out.filter(Boolean))];
}

const rules = backendRules();
const cases = switchCases('blockTestErrorLabel');

// ---------------------------------------------------------------- the contract

describe('block-run refusal vocabulary ↔ backend', () => {
	it('found the backend declarations at all (guards the parsers themselves)', () => {
		// ⛔ THE NON-VACUITY ANCHOR, FIRST ON PURPOSE. If a parser or a path breaks, every set below
		// goes empty and each comparison passes against nothing.
		expect(rules.length).toBeGreaterThanOrEqual(20);
		expect(rules).toEqual(
			expect.arrayContaining(['field_must_be_number', 'capability_missing_llm'])
		);
		expect(cases.length).toBe(rules.length);
		expect(backendDetailFields().length).toBeGreaterThanOrEqual(8);
		expect(attachedRules().length).toBeGreaterThanOrEqual(20);
	});

	it('every rule the backend can emit has a SENTENCE — none renders English by default', () => {
		expect([...rules].sort()).toEqual([...new Set(cases)].sort());
	});

	it('every rule ATTACHED at a backend site is declared in the union', () => {
		// The union is the wire contract the frontend switch is diffed against. A site that attaches
		// a rule the union never declares is invisible to the assertion above.
		expect(attachedRules().filter((r) => !rules.includes(r)).sort()).toEqual([]);
	});

	it('every declared rule is actually ATTACHED somewhere — no dead vocabulary', () => {
		// The other direction: a rule nobody emits is a dead catalog key in eight languages.
		expect(rules.filter((r) => !attachedRules().includes(r)).sort()).toEqual([]);
	});

	it('every message the module references exists in the base catalog', () => {
		// Comment-stripped, so the `blockerr_*` names quoted in this module's own header do not
		// inflate the count.
		const referenced = [...labelSrc.matchAll(/\bm\.(blockerr_[a-z0-9_]+)\(/g)].map((x) => x[1]!);
		expect(referenced).toHaveLength(rules.length);
		expect(referenced.filter((k) => !(k in enCatalog))).toEqual([]);
	});

	it('⛔ every `detail` field this module reads is DECLARED on the backend interface', () => {
		// THE RENAME GUARD. Drop or rename a field server-side and the switch takes the mid-roll
		// branch FOREVER — silently, because that branch is a legitimate runtime state.
		const declared = backendDetailFields();
		const read_ = frontendDetailFields();
		expect(read_.length).toBeGreaterThanOrEqual(8);
		expect(read_.filter((f) => !declared.includes(f))).toEqual([]);
	});

	it('the wire shape is declared on `node_error` and on the persisted result', () => {
		expect(traceSrc).toContain('rule?: BlockErrorRule');
		expect(traceSrc).toContain('detail?: BlockErrorDetail');
		// The columns behind the /block-edit list DTO — without these the localized sentence would
		// appear live and REVERT TO ENGLISH ON REFRESH.
		const schema = read(join(BACKEND, 'src', 'db', 'schema.ts'));
		expect(schema).toContain("error_rule: text('error_rule')");
		expect(schema).toContain("error_detail: jsonb('error_detail')");
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE POSITION-AWARE PROSE SCANNER — the half that used to be VACUOUS.
//
// ⛔⛔ WHAT THE OLD GUARDS ACTUALLY CAUGHT, MEASURED: a bare `return \`…\`` in descriptor.ts, a bare
// `new Error(` in flow-executor.ts, and a literal assigned straight to `error:` in test-runner.ts.
// Every one of those is a shape the files' own idioms do not use. Three evasions were written and
// all three stayed GREEN:
//
//   return cond ? null : `…`     ← THE HOUSE IDIOM. Every single check in descriptor.ts is a
//                                  ternary, so the one shape the next author will certainly write
//                                  was the one shape the guard could not see.
//   Error('…')                   ← `new` is optional for Error. `/new Error\(/` misses it.
//   error: cond ? '…' : '…'      ← `/error:\s*['"`]/` needs the quote to be adjacent.
//
// Widening those three regexes would have produced a fourth regex with a fifth evasion. The guard
// now asks a POSITIONAL question instead of a syntactic one: WHERE IS THIS LITERAL. A product
// sentence may be born only INSIDE a call to that file's sanctioned factory; anywhere else in the
// file it is flagged, whatever syntax carries it. Ternaries, `??`, `.join()`, template literals,
// object properties, a helper called from three places — all the same to it.

/**
 * The byte ranges spanned by a call to any of `names`, paren-matched and STRING-AWARE.
 *
 * ⚠️ THE STRING AWARENESS IS NOT DECORATION. `issue('field_must_be_one_of', \`'${name}' must be one
 * of [...]\`, …)` contains an unbalanced `(` inside its own message on other rules, and a naive
 * depth counter closes the range early — leaving the tail of the factory's own arguments looking
 * like top-level prose and reporting the file as broken while it is correct.
 */
function callRanges(src: string, names: string[]): [number, number][] {
	const out: [number, number][] = [];
	const re = new RegExp(`\\b(?:${names.join('|')})\\s*\\(`, 'g');
	let m: RegExpExecArray | null;
	while ((m = re.exec(src))) {
		let i = m.index + m[0].length;
		let depth = 1;
		let q: string | null = null;
		while (i < src.length && depth > 0) {
			const c = src[i]!;
			if (q) {
				if (c === '\\') i++;
				else if (c === q) q = null;
			} else if (c === "'" || c === '"' || c === '`') q = c;
			else if (c === '(') depth++;
			else if (c === ')') depth--;
			i++;
		}
		out.push([m.index, i]);
	}
	return out;
}

/**
 * The byte range of a sanctioned factory's OWN BODY.
 *
 * ⛔ A FACTORY IS ALSO A BIRTH SITE, WHICH IS THE POINT OF HAVING ONE. `skipReason` composes the
 * `node_skipped` sentence ONCE and returns it beside its `reasonCode`, so the literal lives in the
 * declaration and not at either of the two emit sites. Without this the guard reported the very
 * refactor that made the pairing structural as a violation — and the "fix" would have been to copy
 * the sentence back to both call sites, which is worse in every way. Same brace-matching and same
 * string-awareness as `callRanges`.
 */
/** The index of the `}` closing the `{` at `open`, string-aware. */
function matchBrace(src: string, open: number): number {
	let depth = 0;
	let q: string | null = null;
	for (let i = open; i < src.length; i++) {
		const c = src[i]!;
		if (q) {
			if (c === '\\') i++;
			else if (c === q) q = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') q = c;
		else if (c === '{') depth++;
		else if (c === '}' && --depth === 0) return i;
	}
	return src.length;
}

function bodyRanges(src: string, names: string[]): [number, number][] {
	const out: [number, number][] = [];
	for (const name of names) {
		const at = src.indexOf(`function ${name}(`);
		if (at === -1) continue;
		let open = src.indexOf('{', at);
		// ⛔ THE FIRST `{` AFTER THE SIGNATURE IS NOT ALWAYS THE BODY, AND THIS WAS MEASURED, NOT
		// anticipated: `skipReason` returns an inline object TYPE, so the first brace opened
		// `{ reason: string; reasonCode: …; upstreamSlug: … }` and the range covered the annotation
		// while the body — the one place the sentence lives — stayed outside it. The guard then
		// reported the factory's own literal as a violation. A return-type object is always followed
		// by the body brace, so peeking past it settles which is which without parsing types.
		for (let guard = 0; open !== -1 && guard < 4; guard++) {
			const close = matchBrace(src, open);
			const next = src.slice(close + 1).search(/\S/);
			if (next === -1 || src[close + 1 + next] !== '{') break;
			open = close + 1 + next;
		}
		if (open === -1) continue;
		out.push([open, matchBrace(src, open)]);
	}
	return out;
}

/** Every quoted literal WITH ITS POSITION — single, double or backtick. */
function positionedLiterals(src: string): { value: string; index: number }[] {
	return [
		...src.matchAll(/'([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'|"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"|`([^`\\\\]*(?:\\\\.[^`\\\\]*)*)`/g)
	].map((x) => ({ value: (x[1] ?? x[2] ?? x[3])!, index: x.index! }));
}

/**
 * Does this literal read as a SENTENCE rather than as a token?
 *
 * ⚠️ INTERPOLATIONS ARE CUT FIRST. `` `${s.slice(0, BUDGET)}…` `` has a space — inside an
 * expression, not inside prose — and would otherwise be reported as an English sentence forever.
 */
function isProse(v: string): boolean {
	const bare = v.replace(/\$\{[^}]*\}/g, '');
	return /\s/.test(bare.trim()) && /[A-Za-z]{3}/.test(bare);
}

/**
 * The prose literals in `file` that were NOT born inside one of its sanctioned factories.
 *
 * `console.*` arguments are excluded: that output goes to stderr and to the host's logs, never to a
 * browser, so it is not a product sentence in the sense this guard polices. Excluding it by
 * POSITION (the same mechanism) rather than by an allowlist of texts means a diagnostic can be
 * reworded freely and a browser-facing sentence still cannot hide inside one.
 */
function unruledProse(file: string, factories: string[]): string[] {
	const src = stripComments(read(file));
	const safe = [
		...callRanges(src, factories),
		...bodyRanges(src, factories),
		...callRanges(src, ['console\\.\\w+'])
	];
	return positionedLiterals(src)
		.filter((l) => isProse(l.value) && !safe.some(([a, b]) => l.index > a && l.index < b))
		.map((l) => l.value);
}

describe('⛔ NO UNRULED PRODUCT SITE — a new refusal cannot ship as raw English', () => {
	// ⛔ THE FILE LIST IS `PRODUCT_FILES`, NOT A LIST WRITTEN OUT HERE. The previous version of this
	// block hand-listed three files in prose AND in code and asserted they were all of them; see the
	// correction at the top of this file. Adding a producer now means adding it in ONE place.

	/**
	 * Prose that is legitimately not a refusal, per file, byte-exact.
	 *
	 * ⛔ EXACT SET EQUALITY, NOT `toContain`. An allowlist that only has to be a SUBSET is an
	 * allowlist that grows silently. This one reds when a new prose literal appears anywhere in a
	 * guarded file, which is the whole point: the next author must either route it through the
	 * factory or come here and say, by name, why their sentence is not a product sentence.
	 */
	const ALLOWED: Record<string, string[]> = {
		// A PLACEHOLDER FOR A VALUE, not a refusal. It replaces an output that would not serialise,
		// travels in `outputPreview`, and has no rule because it is not a reason for anything.
		[EXECUTOR]: ['[unserialisable output]', '[unserialisable output]'],
		[DESCRIPTOR]: [],
		// Both are thrown to the ROUTE, not into a run: `routes/blocks.ts` turns them into a 404
		// whose body never passes through `blockTestErrorLabel`. They are also not reachable from a
		// run's trace at all — no node has started when they fire.
		[TEST_RUNNER]: [
			// Thrown to the ROUTE, not into a run: `routes/blocks.ts` turns these into a 404 whose
			// body never passes through `blockTestErrorLabel`. No node has started when they fire.
			"block version '${versionId}' not found",
			"block for version '${versionId}' not found",
			// An OPERATOR invariant failure out of the tests_passing rollup, `[block-tests]`-tagged
			// and thrown past every per-test verdict. It is a 500 for whoever is on call, not a
			// sentence a block author reads — and it explicitly must NOT be softened into one.
			'[block-tests] the tests_passing rollup matched ${written.length} block_versions rows for ',
			"version '${versionId}' (expected exactly 1). The result is NOT persisted, so the publish ",
			'gate will keep reading the stale value. Check the tenant scope this run is executing in.'
		],
		[BLOCK_LOADER]: [],
		[DATASET_RESOLVER]: []
	};

	for (const { path, factories } of PRODUCT_FILES) {
		const name = path.slice(path.lastIndexOf('/') + 1);
		it(`${name}: every product sentence is born inside ${factories[0]}(…)`, () => {
			// ⛔ NON-VACUITY FIRST: the factory exists and is really used, so "no unruled prose" is
			// not "no prose at all" on a file whose factory someone deleted.
			const src = stripComments(read(path));
			expect(src, `${name} lost its factory`).toContain(factories[0]!);
			expect(callRanges(src, factories).length).toBeGreaterThanOrEqual(2);
			expect(
				unruledProse(path, factories).sort(),
				`a product English sentence in ${name} that was NOT born inside ` +
					`${factories.join('/')}(…). It reaches the run console / the block-edit panel as ` +
					'untranslatable English in seven locales. Route it through the factory, or — if it ' +
					'is genuinely not a product sentence — add it to ALLOWED with the reason.'
			).toEqual([...(ALLOWED[path] ?? [])].sort());
		});
	}

	it('⛔⛔ THE SCANNER REDS ON ALL THREE MEASURED EVASIONS (it is not vacuous)', () => {
		// THE GUARD'S OWN NON-VACUITY, ON SYNTHETIC SOURCES. Each of these was written against the
		// real files and each was GREEN under the old regexes. `unruledProse` is exercised through
		// the same primitives the assertions above use.
		const scan = (src: string, factories: string[]) => {
			const safe = [...callRanges(src, factories), ...bodyRanges(src, factories)];
			return positionedLiterals(src)
				.filter((l) => isProse(l.value) && !safe.some(([a, b]) => l.index > a && l.index < b))
				.map((l) => l.value);
		};

		// EVASION 1 — the house idiom. descriptor.ts is ternaries end to end.
		expect(
			scan("function f(){ return ok ? null : `'${name}' must be a widget`; }", ['issue'])
		).toEqual(["'${name}' must be a widget"]);

		// EVASION 2 — `new` is optional for Error.
		expect(scan("throw Error('the runner refused to start');", ['productError'])).toEqual([
			'the runner refused to start'
		]);

		// EVASION 3 — a ternary behind `error:`.
		expect(scan("return { error: bad ? 'it went wrong' : 'it went badly' };", ['testError'])).toEqual([
			'it went wrong',
			'it went badly'
		]);

		// …and the sanctioned shape is still accepted, so the scanner is not simply "flag everything".
		expect(scan("return issue('field_must_be_string', `'${n}' must be a string`, f);", ['issue'])).toEqual(
			[]
		);
		// A ternary INSIDE the factory is fine too — the range is the call, not the line.
		expect(
			scan("return issue(r, wall ? 'run budget exceeded' : 'loop budget exceeded');", ['issue'])
		).toEqual([]);
	});

	it('⛔ the scrapers see a BACKTICK declaration too (the sibling helper measurably did not)', () => {
		// THE SCRAPER'S OWN NON-VACUITY, ON A SYNTHETIC SOURCE. Every assertion above is only as good
		// as these regexes, and the helper this one was cloned from was blind to a quote style the
		// next author can write by accident.
		const FIXTURE = [
			'export type BlockErrorRule =',
			"  | 'field_must_be_string'",
			'  | "field_must_be_number"',
			'  | `field_required`;',
			''
		].join('\n');
		expect(backendRules(FIXTURE)).toEqual([
			'field_must_be_string',
			'field_must_be_number',
			'field_required'
		]);

		const SWITCH = [
			'export function blockTestErrorLabel(err: BlockError): string {',
			'	switch (err.rule) {',
			"		case 'field_required':",
			'		case "output_not_object":',
			'		case `field_unknown_type`:',
			"			if (!has(d, 'field', \"options\")) return err.message;",
			'	}',
			'}',
			''
		].join('\n');
		expect(switchCases('blockTestErrorLabel', SWITCH)).toEqual([
			'field_required',
			'output_not_object',
			'field_unknown_type'
		]);
		expect(frontendDetailFields(SWITCH).sort()).toEqual(['field', 'options']);

		// …and the REAL sources still parse the same way through the widened regexes.
		expect(rules.length).toBeGreaterThanOrEqual(20);
		expect(cases.length).toBe(rules.length);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('⛔ the mid-roll shape: a KNOWN rule with no `detail` renders the backend English', () => {
	const PROSE = 'BACKEND ENGLISH — the only thing an archived trace ships';

	it('holds for every rule the backend declares, driven from the scrape', () => {
		// ⛔ DRIVEN FROM `rules`, NOT FROM A HAND-WRITTEN LIST. A 29th rule that forgets its mid-roll
		// guard is caught the moment it enters the union.
		//
		// The parameterless rules are the deliberate exceptions: their sentence names nothing, so an
		// archived event carrying only the rule is already COMPLETE and must reach the catalog.
		const noDetailNeeded = new Set([
			'output_not_object',
			'node_timeout',
			'run_wall_clock_exceeded',
			'foreach_event_budget_exceeded',
			'test_expected_error_but_succeeded',
			'test_no_output',
			'test_output_not_json_object',
			'test_output_mismatch',
			// Added with the `host/` group: both name nothing, so an archived event carrying only
			// the rule is already complete and must reach the catalog.
			'llm_budget_exhausted',
			'llm_host_closed',
			// Same shape: the seat refusal names neither the workspace nor the person — deliberately,
			// because putting an identity into a sentence a block author can read is the leak, and the
			// reader already knows which workspace they are in.
			'llm_seat_required',
			// Spend-posture refusals: parameterless, reuse the `error_llm_*` catalog sentences.
			'llm_platform_local_only',
			'llm_byo_key_required'
		]);
		let asserted = 0;
		for (const rule of rules) {
			const out = blockTestErrorLabel({ rule, message: PROSE }, 'nl');
			if (noDetailNeeded.has(rule)) {
				expect(out, `${rule} needs no detail and must NOT fall back`).not.toBe(PROSE);
				continue;
			}
			expect(out, `${rule} rendered the catalog with no detail on the wire`).toBe(PROSE);
			asserted++;
		}
		expect(asserted).toBe(rules.length - noDetailNeeded.size);
		expect(asserted).toBeGreaterThanOrEqual(15);
	});

	it('and the exceptions really do reach the catalog, so the table is not trivially true', () => {
		// Without this, a `blockTestErrorLabel` that returned `err.message` unconditionally would
		// pass every assertion above.
		expect(blockTestErrorLabel({ rule: 'output_not_object', message: PROSE }, 'nl')).toBe(
			'CATALOG(blockerr_output_not_object)'
		);
		expect(blockTestErrorLabel({ rule: 'node_timeout', message: PROSE }, 'nl')).toBe(
			'CATALOG(blockerr_node_timeout)'
		);
	});

	it('⛔⛔ THE CRUX: no rule at all is the AUTHOR’S text and is returned byte for byte', () => {
		expect(blockTestErrorLabel({ message: 'mijn eigen fout' }, 'nl')).toBe('mijn eigen fout');
		expect(blockTestErrorLabel({ rule: null, message: 'mijn eigen fout' }, 'nl')).toBe(
			'mijn eigen fout'
		);
		// An author who sets `.kind` on their own Error cannot reach a catalog sentence either: the
		// switch reads `rule`, and nothing an author's module scope can touch attaches one.
		expect(blockTestErrorLabel({ message: 'boom', detail: { field: 'x' } }, 'nl')).toBe('boom');
	});
});
