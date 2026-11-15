// src/lib/i18n/flow-summary-label.backend-contract.test.ts — the snapshot-summary vocabulary is
// COMPLETE, and the machine fields it interpolates are really on the wire.
//
// THE DEFECT THIS PINS is the one that only appears LATER. `flowSummaryLabel` falls back to the
// backend's English whenever the code is unknown or a param is absent — deliberately, and
// PERMANENTLY (pre-0071 rows and user-typed checkpoints both live in that branch forever). That
// fallback is a safety net, not a destination, and it is INVISIBLE when it fires: add a TENTH edit
// template to backend/src/ai/flow-edit-service.ts — an `ungroup`, a `renamed node`, a `duplicated
// subgraph` — and its summary reaches a Dutch /build panel in English, with every frontend unit
// test still green (they build their own fixtures) and nothing in CI saying a word. Same for
// renaming `sourceHandle` to `srcHandle` in `FlowSummaryParams`. This is the file that reds.
//
// backend/ and frontend/ are two separate Bun projects — no workspaces, no shared package, no
// codegen — so, exactly as `graph-issue-label.backend-contract.test.ts` and
// `notification-label.backend-contract.test.ts` do, this walks BACKEND SOURCE TEXT on disk with
// plain `fs` and diffs the sets. It reads the FRONTEND switch as text too rather than calling it:
// "is there a case for this code" is a question about source, and mocking the answer would make it
// vacuous.
//
// ⛔ THE ONE THING IT DOES DRIVE is the fallback table at the bottom, because "returns the English"
// is a question about BEHAVIOUR that no amount of source reading can answer. The catalog is mocked
// to a loud sentinel there, so a message reached by mistake shows up in the diff by name.
//
// ⚠️ THE KNOWN HOLE IN THE SIBLINGS IS NOT INHERITED HERE. `quotedLiterals` in
// `notification-label.backend-contract.test.ts` (and in `data-finding-label` / `policy-label`) is
// SINGLE-QUOTE-ONLY: a union member or a `case` written with double quotes is invisible to it,
// which `graph-issue-label.backend-contract.test.ts` measured and fixed for itself. There is no
// prettier and no eslint config anywhere in this repo, so nothing normalises quote style and a
// double-quoted literal is an ordinary thing for the next author to write. The scrapers below are
// quote-agnostic from the start, and the last test in the first block drives them over a synthetic
// double-quoted fixture to prove it rather than asserting it.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const MOCK = vi.hoisted(() => {
	const keys = [
		'flow_summary_added',
		'flow_summary_connected',
		'flow_summary_disconnected',
		'flow_summary_removed',
		'flow_summary_configured',
		'flow_summary_moved',
		'flow_summary_inserted',
		'flow_summary_manual_checkpoint',
		'flow_summary_restored'
	];
	return Object.fromEntries(keys.map((k) => [k, () => `CATALOG(${k})`]));
});
vi.mock('$lib/paraglide/messages', () => MOCK);
// `fullDate` is the shared formatter; stub it so the driven table below cannot pass or fail on
// Intl output. Its real behaviour is `format.ts`'s business, not this contract's.
vi.mock('$lib/utils/format', () => ({ fullDate: (v: unknown) => `DATE(${String(v)})` }));

const { flowSummaryLabel } = await import('./flow-summary-label');

const BACKEND = fileURLToPath(new URL('../../../../backend', import.meta.url));
const EDIT = join(BACKEND, 'src', 'ai', 'flow-edit-service.ts');
const ROUTE = join(BACKEND, 'src', 'routes', 'flows.ts');

const editSrc = readFileSync(EDIT, 'utf8');
const routeSrc = readFileSync(ROUTE, 'utf8');
const labelSrc = readFileSync(new URL('./flow-summary-label.ts', import.meta.url), 'utf8');
const typesSrc = readFileSync(new URL('../types/flows.ts', import.meta.url), 'utf8');
const enCatalog = JSON.parse(
	readFileSync(fileURLToPath(new URL('../../../messages/en.json', import.meta.url)), 'utf8')
) as Record<string, unknown>;

// ---------------------------------------------------------------- shared scrapers

/**
 * Every quoted string literal in a chunk of TypeScript, SINGLE **OR DOUBLE** QUOTED.
 *
 * ⛔ THE DOUBLE-QUOTE HALF IS THE MEASURED FIX `graph-issue-label.backend-contract.test.ts`
 * documents, not defensive programming. Its single-quote-only ancestor let a whole union member
 * through invisibly while every assertion stayed green. Backticks are deliberately NOT matched:
 * a template literal in a union declaration is not a thing, and matching them would swallow the
 * `summary:` templates this file counts separately.
 */
function quotedLiterals(chunk: string): string[] {
	return [...chunk.matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => (x[1] ?? x[2])!);
}

// ---------------------------------------------------------------- backend readers

/**
 * The members of the `FlowSummaryCode` union, out of the backend's `export type` line.
 *
 * ⛔ IT DOES NOT PARSE TYPESCRIPT. A union assembled from another type, or one wrapped in a shape
 * this regex misses, is invisible to it — which is why the first assertion below pins the parsed
 * set to an exact width and to two named members. If the declaration is ever reshaped, that
 * assertion fails loudly rather than every later comparison passing vacuously against an empty set.
 */
function backendCodes(src: string = editSrc): string[] {
	const decl = src.match(/export type FlowSummaryCode\s*=([^;]+);/);
	if (!decl) throw new Error('FlowSummaryCode not found in backend/src/ai/flow-edit-service.ts');
	return quotedLiterals(decl[1]!);
}

/**
 * Every field declared on the backend's `FlowSummaryParams`.
 *
 * ⚠️ `export type`, not `export interface`, and the backend says why beside it: TypeScript gives an
 * object type ALIAS an implicit index signature and refuses one to an interface, so the drizzle
 * `jsonb().$type<Record<string, unknown>>()` insert only typechecks against the alias (measured:
 * TS2769). Accept both spellings here so this parser reports a RENAME rather than dying on a legal
 * refactor — the same accommodation `backendDataFields()` makes for `BudgetAlertData`.
 */
function backendParamFields(src: string = editSrc): string[] {
	const at = src.search(/export (?:type|interface) FlowSummaryParams\s*=?\s*\{/);
	if (at === -1) throw new Error('FlowSummaryParams not found in backend/src/ai/flow-edit-service.ts');
	// `\n}` terminates both spellings — the alias closes `};`, the interface `}`.
	const body = src.slice(at, src.indexOf('\n}', at));
	return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]!);
}

/**
 * Every place the backend AUTHORS a snapshot sentence: a `summary:` property whose value is a
 * literal (template or quoted). This is the population that must be code-covered.
 *
 * ⛔ IT COUNTS THE *TEMPLATES*, NOT THE CODES, AND THAT IS THE WHOLE GUARD. Diffing codes against
 * switch cases (the block above) only notices a tenth template if its author remembered to mint a
 * tenth CODE. The failure this file exists for is the author who does not — who copies an existing
 * arm, edits the sentence, and ships `summary: \`renamed ${old} to ${next}\`` with no `code:` at
 * all. That row then has `summary_code IS NULL` and renders English forever, and nothing else in
 * either project can see it. Counting authored sentences and requiring one `code:` apiece is what
 * catches it.
 *
 * ⚠️ It deliberately does NOT match `summary: summary` / `summary: body.summary` / `summary: s.summary`
 * — a variable being PASSED ALONG is not a template being authored. `createCheckpoint` composes its
 * literal into `const summary = body.summary?.trim() || 'Manual checkpoint'`, which the
 * `authoredSummaries` caller handles by scanning that assignment form too.
 */
function authoredSummaries(src: string): string[] {
	const out: string[] = [];
	// `summary: \`…\`` / `summary: '…'` / `summary: "…"` — a property with a literal value.
	for (const m of src.matchAll(/\bsummary:\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) out.push(m[1]!);
	// `const summary = <literal>` / `… || <literal>` — the routes/flows.ts spelling.
	for (const m of src.matchAll(/\bconst summary\s*=\s*([^;]+);/g)) {
		for (const lit of m[1]!.matchAll(/(`[^`]*`|'[^']*'|"[^"]*")/g)) out.push(lit[1]!);
	}
	return out;
}

/**
 * Every `flow_summary_*` literal the backend actually EMITS — anywhere, in any spelling.
 *
 * ⛔ IT DOES NOT LOOK FOR `code:`. The two callers spell it differently on purpose — one assigns
 * `const code: FlowSummaryCode | null = …` because it has to decide, the other passes the literal
 * straight into `writeSnapshot(...)` as a positional argument — and a scraper keyed on the property
 * name silently read ONE of the two (measured: it reported 1 of routes/flows.ts's 2). Matching the
 * literal itself is spelling-agnostic; the `FlowSummaryCode` union declaration is cut out first so
 * its nine members are not miscounted as nine emissions.
 */
function emittedCodes(src: string): string[] {
	const withoutUnion = src.replace(/export type FlowSummaryCode\s*=[^;]+;/, '');
	return [...withoutUnion.matchAll(/['"](flow_summary_\w+)['"]/g)].map((x) => x[1]!);
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
 * Every param the module actually READS — the `p.<field>` interpolations plus the names quoted
 * inside the `has(p, …)` guards, which are the fields it refuses to render without.
 */
function frontendParamFields(src: string = labelSrc): string[] {
	const direct = [...src.matchAll(/\bp\.([A-Za-z]\w*)/g)].map((x) => x[1]!);
	const guarded = [...src.matchAll(/\bhas\(p,([^)]*)\)/g)].flatMap((x) => quotedLiterals(x[1]!));
	return [...new Set([...direct, ...guarded])];
}

const codes = backendCodes();
const cases = switchCases('flowSummaryLabel');

// ---------------------------------------------------------------- the contract

describe('snapshot-summary vocabulary ↔ backend', () => {
	it('found the backend declarations at all (guards the parsers themselves)', () => {
		// ⛔ THE NON-VACUITY ANCHOR, AND IT COMES FIRST ON PURPOSE. If a parser or a path breaks,
		// every set below goes empty and each comparison passes against nothing.
		expect(codes).toHaveLength(9);
		expect(codes).toEqual(
			expect.arrayContaining(['flow_summary_connected', 'flow_summary_manual_checkpoint'])
		);
		expect(cases).toHaveLength(9);
		expect(backendParamFields()).toHaveLength(9);
	});

	it('every code the backend can write has a SENTENCE — none renders English by default', () => {
		// ⛔ THIS IS THE GUARD. Add a tenth `FlowSummaryCode` backend-first and this goes red here,
		// naming it, instead of shipping an English sentence into seven non-English locales on the
		// product's primary authoring surface.
		expect([...codes].sort()).toEqual([...new Set(cases)].sort());
	});

	it('every case in the switch is a code the backend actually writes', () => {
		// The other direction: a case for a code nothing emits is dead code carrying a dead catalog
		// key in eight languages. Implied by the equality above; asserted separately so the failure
		// message says which direction broke.
		for (const c of cases) expect(codes).toContain(c);
	});

	it('⛔ EVERY authored `summary` template also emits a code — all NINE, across BOTH files', () => {
		// ⛔ THE ONE THAT CATCHES THE TENTH TEMPLATE. The equality above only fires if the author
		// minted a code; this fires if they wrote a sentence and did not. Seven templates live in
		// flow-edit-service.ts and TWO in routes/flows.ts — an earlier handoff into this work said
		// "seven" and was wrong, which is precisely why the count is asserted per file.
		const editTemplates = authoredSummaries(editSrc);
		const routeTemplates = authoredSummaries(routeSrc);
		expect(editTemplates).toHaveLength(7);
		expect(routeTemplates).toHaveLength(2);

		expect(emittedCodes(editSrc)).toHaveLength(7);
		expect(emittedCodes(routeSrc)).toHaveLength(2);
		expect([...emittedCodes(editSrc), ...emittedCodes(routeSrc)].sort()).toEqual([...codes].sort());
	});

	it('the templates the scrape found are the real sentences, not something else', () => {
		// Anchors `authoredSummaries` to recognisable content, so "found 9" cannot mean "found 9 of
		// the wrong thing". Matched on the STEM only — the interpolations differ per template.
		//
		// ⛔ EACH STEM STARTS AT THE LITERAL'S OPENING QUOTE, AND THAT IS NOT COSMETIC. The first
		// version of this list used bare words, and `'moved node '` IS A SUBSTRING OF
		// `'removed node '` ("re" + "moved node") — measured: deleting the `moveNode` template
		// entirely left this assertion GREEN, matching on `removeNode`'s sentence instead. Anchoring
		// on the backtick makes every stem unique to the template it names.
		const all = [...authoredSummaries(editSrc), ...authoredSummaries(routeSrc)].join('\n');
		const STEMS = [
			'`added ${',
			'`connected ${',
			'`disconnected edge ${',
			'`removed node ${',
			'`configured ${',
			'`moved node ${',
			'`inserted ${',
			"'Manual checkpoint'",
			'`Restored snapshot from ${'
		];
		// Nine stems for nine templates, and no stem is a substring of another — the property the
		// bare-word version silently lacked.
		expect(STEMS).toHaveLength(9);
		for (const a of STEMS) {
			for (const b of STEMS) {
				if (a !== b) expect(b, `stem ${a} is contained in ${b}`).not.toContain(a);
			}
		}
		for (const stem of STEMS) {
			expect(all, `no authored summary contains ${JSON.stringify(stem)}`).toContain(stem);
		}
	});

	it('⛔ the English `summary` is still WRITTEN and still SHIPPED beside the code', () => {
		// The prose is not deprecated and must not be tidied away: it is the only thing a pre-0071
		// row carries, the only thing a user-typed checkpoint carries, and the correct output for
		// the MCP/LLM reader (src/ai/mcp/tools.ts returns `EditResult` straight to the model).
		expect(editSrc).toContain('summary,\n    created_by: createdBy,\n    summary_code: code,');
		expect(routeSrc).toContain('summary: s.summary,');
		expect(routeSrc).toContain('summary_code: s.summary_code,');
		expect(routeSrc).toContain('summary_params: s.summary_params ?? null,');
		// ⛔ AND `EditResult` MUST NOT HAVE GROWN THE TWO FIELDS. Widening it would push
		// `flow_summary_*` tokens at an LLM client that wants the English sentence.
		const at = editSrc.indexOf('export interface EditResult {');
		expect(at).toBeGreaterThan(-1);
		const shape = editSrc.slice(at, editSrc.indexOf('\n}', at));
		expect(shape).not.toContain('code');
		expect(shape).not.toContain('params');
	});

	it('⛔ `getSnapshot` PROJECTS its row — it must not ship the raw record again', () => {
		// It used to be `jsonResponse(snap)`, i.e. the whole drizzle row: `tenant_id` included, and
		// 0071's two columns would have arrived un-declared on the frontend type. A projection is
		// also what keeps list and detail rendering through the SAME label module.
		expect(routeSrc).toContain('jsonResponse(snapshotDetail(snap))');
		expect(routeSrc).not.toMatch(/return jsonResponse\(snap\);/);
	});

	it('⛔ every param this module reads is DECLARED on the backend type', () => {
		// THE RENAME GUARD. `flowSummaryLabel` reads `p.sourceHandle` and refuses to render without
		// it. If the backend drops or renames that field the switch takes the fallback branch
		// FOREVER — silently, because that branch is a legitimate runtime state and nothing throws.
		// Every frontend unit test would stay green on its own fixtures.
		const declared = backendParamFields();
		const read = frontendParamFields();
		expect(read).toHaveLength(9);
		expect(read.filter((f) => !declared.includes(f))).toEqual([]);
		// …and the reverse: a field the backend persists that the browser never reads is a sentence
		// the reader could have had in their own language and did not.
		expect(declared.filter((f) => !read.includes(f))).toEqual([]);
	});

	it('the wire fields are declared on the FRONTEND type too', () => {
		// tsc cannot see across the two projects, so `FlowSnapshotSummary` is a hand-written
		// transcription. This is the only thing that notices when it stops matching.
		expect(typesSrc).toContain('summary_code?: string | null;');
		expect(typesSrc).toContain('summary_params?: Record<string, unknown> | null;');
	});

	it('every message the module references exists in the base catalog', () => {
		// paraglide fails its own compile on a missing key, but only during `bun run check`. This
		// puts the same failure in `bun run test`, where it names the offending key directly.
		const referenced = [...labelSrc.matchAll(/\bm\.([a-z0-9_]+)\(/g)].map((x) => x[1]!);
		expect(referenced).toHaveLength(9);
		expect(referenced.filter((k) => !(k in enCatalog))).toEqual([]);
		// …and the mock above really shadows every one of them, or the driven table below would be
		// calling the REAL catalog and asserting against English copy.
		expect(referenced.filter((k) => !(k in MOCK))).toEqual([]);
	});

	it('⛔⛔ the two COMPOUND placeholders are compounds in every catalog', () => {
		// THE BIDI CONTRACT, AS A SOURCE FACT. `connected` and `configured` join two fields with a
		// `.` before isolating, because isolating each field separately leaves the dot outside both
		// isolates and ar/he swap the halves (measured in graph-issue-label.ts). That only works if
		// the CATALOGS name the compound as ONE placeholder. A translator — or a future author
		// "restoring the machine fields" — who writes `{source}.{sourceHandle}` in a pattern
		// reintroduces the exact defect, in that locale only, invisibly to every render test in the
		// five LTR locales.
		for (const locale of ['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he']) {
			const cat = JSON.parse(
				readFileSync(
					fileURLToPath(new URL(`../../../messages/${locale}.json`, import.meta.url)),
					'utf8'
				)
			) as Record<string, string>;
			const connected = cat.flow_summary_connected!;
			const configured = cat.flow_summary_configured!;
			expect(connected, `${locale} lost a compound ref`).toContain('{sourceRef}');
			expect(connected, `${locale} lost a compound ref`).toContain('{targetRef}');
			expect(configured, `${locale} lost the compound ref`).toContain('{nodeRef}');
			// ⛔ and no pattern may name the RAW halves — that IS the reversal.
			for (const raw of ['{source}', '{sourceHandle}', '{target}', '{targetHandle}', '{key}']) {
				expect(connected, `${locale}/connected split the compound into ${raw}`).not.toContain(raw);
				expect(configured, `${locale}/configured split the compound into ${raw}`).not.toContain(
					raw
				);
			}
			// The arrow is the catalog's to choose — `→` in LTR, `←` in ar/he — but it must be THERE,
			// or the sentence stops saying which end is which.
			expect(connected, `${locale}/connected lost its direction marker`).toMatch(/→|←/);
		}
		// …and ar/he really did take the mirrored one, which is the point of catalog-owned punctuation.
		for (const locale of ['ar', 'he']) {
			const cat = JSON.parse(
				readFileSync(
					fileURLToPath(new URL(`../../../messages/${locale}.json`, import.meta.url)),
					'utf8'
				)
			) as Record<string, string>;
			expect(cat.flow_summary_connected, `${locale} kept the LTR arrow`).toContain('←');
			expect(cat.flow_summary_connected).not.toContain('→');
		}
	});

	it('⛔ the scrapers see a DOUBLE-QUOTED declaration too', () => {
		// ⛔ THE SCRAPER'S OWN NON-VACUITY, ON A SYNTHETIC SOURCE. Every other assertion in this file
		// is only as good as the regexes above, and the single-quote-only ancestor of
		// `quotedLiterals` was measurably blind to a member written with double quotes: it left all
		// assertions green while the invisible member never entered the parsed set. Nothing in this
		// repo normalises quote style — no prettier config, no eslint config — so it is a shape the
		// next author can write by accident.
		const FIXTURE = [
			'export type FlowSummaryCode =',
			"  | 'flow_summary_added'",
			'  | "flow_summary_forked"',
			"  | 'flow_summary_moved';",
			''
		].join('\n');
		expect(backendCodes(FIXTURE)).toEqual([
			'flow_summary_added',
			'flow_summary_forked',
			'flow_summary_moved'
		]);

		const SWITCH = [
			'export function flowSummaryLabel(s: X, locale: string): string {',
			'	switch (s.summary_code) {',
			"		case 'flow_summary_added':",
			'		case "flow_summary_forked":',
			'			if (!has(p, \'slug\', "edgeId")) return s.summary;',
			'	}',
			'}',
			''
		].join('\n');
		expect(switchCases('flowSummaryLabel', SWITCH)).toEqual([
			'flow_summary_added',
			'flow_summary_forked'
		]);
		expect(frontendParamFields(SWITCH).sort()).toEqual(['edgeId', 'slug']);

		// The `summary:` / code scrapes must see both quote styles too — a tenth template written
		// with double quotes is exactly the case the count guard exists for.
		const TEMPLATES = [
			'      summary: "forked ${slug}",',
			"      code: 'flow_summary_forked',",
			'      summary: `renamed ${a}`,',
			'      code: "flow_summary_renamed",'
		].join('\n');
		expect(authoredSummaries(TEMPLATES)).toHaveLength(2);
		expect(emittedCodes(TEMPLATES)).toEqual(['flow_summary_forked', 'flow_summary_renamed']);

		// …and the REAL sources still parse the same way through the widened regexes, so the fixture
		// was not bought at the cost of the thing it guards.
		expect(codes).toHaveLength(9);
		expect(cases).toHaveLength(9);
	});
});

// ==================================================================================================
// ⛔ BEHAVIOURAL, and DRIVEN FROM THE BACKEND'S OWN UNION rather than from a hand-written list. A
// tenth code that forgets its fallback guard is caught here the moment it joins the union.
// ==================================================================================================
describe('⛔ the three-branch fallback, driven from the scrape', () => {
	const PROSE = 'BACKEND ENGLISH — the only thing a pre-0071 row ships';
	const row = (code: string | null, params: Record<string, unknown> | null) => ({
		summary: PROSE,
		summary_code: code,
		summary_params: params
	});

	it('a KNOWN code with NO params renders the backend English', () => {
		// The one exception is `flow_summary_manual_checkpoint`: it interpolates nothing, so the
		// backend persists `summary_params = NULL` for it deliberately and it must NOT fall back.
		const noParamsNeeded = new Set(['flow_summary_manual_checkpoint']);
		let asserted = 0;
		for (const code of codes) {
			const out = flowSummaryLabel(row(code, null), 'nl');
			if (noParamsNeeded.has(code)) {
				expect(out, `${code} needs no params and must NOT fall back`).not.toBe(PROSE);
				continue;
			}
			expect(out, `${code} rendered the catalog with no params on the wire`).toBe(PROSE);
			asserted++;
		}
		expect(asserted).toBe(codes.length - noParamsNeeded.size);
		expect(asserted).toBeGreaterThanOrEqual(8);
	});

	it('a HALF-populated bag falls back too — never "connected undefined.undefined"', () => {
		// A template that grows a field ships exactly this shape from an old pod mid-roll.
		expect(
			flowSummaryLabel(row('flow_summary_connected', { source: 'n1', sourceHandle: 'text' }), 'nl')
		).toBe(PROSE);
		expect(flowSummaryLabel(row('flow_summary_configured', { nodeId: 'n1' }), 'nl')).toBe(PROSE);
		expect(flowSummaryLabel(row('flow_summary_inserted', { slug: 'ai-summarize' }), 'nl')).toBe(
			PROSE
		);
	});

	it('an EMPTY-STRING field is an absence wearing a different hat', () => {
		// `added ⁨⁩` names no block. Same call `has()` makes in graph-issue-label.ts.
		expect(flowSummaryLabel(row('flow_summary_added', { slug: '' }), 'nl')).toBe(PROSE);
	});

	it('⛔ `summary_code: null` renders the English — the PERMANENT branch', () => {
		// Not a rolling-deploy window: every snapshot written before 0071 carries null forever (no
		// backfill), and so does every manual checkpoint whose text the USER typed.
		expect(flowSummaryLabel(row(null, null), 'nl')).toBe(PROSE);
		expect(flowSummaryLabel(row(null, { slug: 'ai-summarize' }), 'nl')).toBe(PROSE);
		// A user who literally types the words gets their own words back, NOT the catalog sentence.
		expect(
			flowSummaryLabel(
				{ summary: 'Manual checkpoint', summary_code: null, summary_params: null },
				'nl'
			)
		).toBe('Manual checkpoint');
	});

	it('an UNRECOGNISED code renders the English, never a bare token', () => {
		const out = flowSummaryLabel(row('flow_summary_forked', { slug: 'x' }), 'nl');
		expect(out).toBe(PROSE);
		expect(out).not.toContain('flow_summary_forked');
	});

	it('a field the frontend never declared cannot be missing (undefined) either', () => {
		// An old pod ships the property NOT AT ALL, which is a different runtime shape from `null`.
		expect(flowSummaryLabel({ summary: PROSE }, 'nl')).toBe(PROSE);
	});

	it('and the fully-populated rows really do reach the catalog', () => {
		// Without this, a `flowSummaryLabel` that returned `s.summary` unconditionally would pass
		// every assertion above.
		expect(flowSummaryLabel(row('flow_summary_added', { slug: 'ai-summarize' }), 'nl')).toBe(
			'CATALOG(flow_summary_added)'
		);
		expect(
			flowSummaryLabel(
				row('flow_summary_connected', {
					source: 'n1',
					sourceHandle: 'text',
					target: 'n2',
					targetHandle: 'text'
				}),
				'nl'
			)
		).toBe('CATALOG(flow_summary_connected)');
		expect(flowSummaryLabel(row('flow_summary_manual_checkpoint', null), 'nl')).toBe(
			'CATALOG(flow_summary_manual_checkpoint)'
		);
		expect(
			flowSummaryLabel(row('flow_summary_restored', { at: '2026-08-07T09:12:44.031Z' }), 'nl')
		).toBe('CATALOG(flow_summary_restored)');
	});
});
