// src/lib/i18n/scan-finding-label.test.ts — a scan finding is rendered from its RULE, a type-check
// finding is passed through verbatim, and the backend's English is reached only when there is
// nothing else to say.
//
// The messages module is mocked so each key returns its own name plus its arguments: the assertions
// are about WHICH MESSAGE is selected and WHAT IS INTERPOLATED, not about English copy a translator
// may legitimately reword. Same technique as `data-finding-label.test.ts` and
// `compliance-label.test.ts`. The Dutch WORDS are proven separately, in
// `routes/block-edit/block-edit.dutch-findings.render.test.ts`, against the real catalog.
import { describe, it, expect, vi } from 'vitest';
import type { LintFinding } from '$lib/types/blocks';

vi.mock('$lib/paraglide/messages', () => ({
	scan_finding_no_fetch: () => 'M_FETCH',
	scan_finding_no_websocket: () => 'M_WS',
	scan_finding_no_xhr: () => 'M_XHR',
	scan_finding_no_process: () => 'M_PROC',
	scan_finding_no_bun_socket: () => 'M_BUNSOCK',
	scan_finding_no_eval: () => 'M_EVAL',
	scan_finding_no_function_constructor: () => 'M_FNCTOR',
	scan_finding_no_computed_global: () => 'M_COMPGLOBAL',
	scan_finding_no_dynamic_import: () => 'M_DYNIMPORT',
	scan_finding_no_require: (p: Record<string, unknown>) => `M_REQUIRE(${p.spec})`,
	scan_finding_banned_import: (p: Record<string, unknown>) => `M_BANNED(${p.spec})`,
	scan_finding_import_not_allowlisted: (p: Record<string, unknown>) => `M_NOTALLOWED(${p.spec})`,
	scan_finding_syntax: (p: Record<string, unknown>) => `M_SYNTAX(${p.detail})`
}));

const { scanFindingLabel } = await import('./scan-finding-label');

/** The English the backend ships and the reader must NOT see when the rule is understood. */
const PROSE = 'BACKEND ENGLISH — must not be reached';

/** One scan finding, defaulted to the shape `static-scan.ts` really emits. */
function scan(over: Partial<LintFinding> & { rule: string }): LintFinding {
	return { source: 'scan', message: PROSE, line: 4, ...over };
}

/** The bidi isolate every interpolated token is wrapped in — `<bdi>` in two characters. */
const I = (s: string) => `⁨${s}⁩`;

// The thirteen rules, in the order `static-scan.ts` declares them. Each entry is
// [rule, the finding's extra machine fields, the sentinel the catalog must produce].
const CASES: [string, Partial<LintFinding>, string][] = [
	['no-fetch', {}, 'M_FETCH'],
	['no-websocket', {}, 'M_WS'],
	['no-xhr', {}, 'M_XHR'],
	['no-process', {}, 'M_PROC'],
	['no-bun-socket', {}, 'M_BUNSOCK'],
	['no-eval', {}, 'M_EVAL'],
	['no-function-constructor', {}, 'M_FNCTOR'],
	['no-computed-global', {}, 'M_COMPGLOBAL'],
	['no-require', { spec: 'node:fs' }, `M_REQUIRE(${I('node:fs')})`],
	['no-dynamic-import', {}, 'M_DYNIMPORT'],
	[
		'syntax',
		{ detail: "Expected ';' but found '}'" },
		`M_SYNTAX(${I("Expected ';' but found '}'")})`
	],
	['banned-import', { spec: 'node:net' }, `M_BANNED(${I('node:net')})`],
	['import-not-allowlisted', { spec: 'lodash' }, `M_NOTALLOWED(${I('lodash')})`]
];

describe('scanFindingLabel — the closed `scan` vocabulary', () => {
	it('covers all THIRTEEN rules `static-scan.ts` declares', () => {
		// ⛔ NON-VACUITY. Every `it.each` below is driven by this table; a table that lost entries
		// would make the file shrink silently rather than fail. The count is pinned to the backend's
		// rule count, which `scan-finding-label.backend-contract.test.ts` pins to the source itself.
		expect(CASES).toHaveLength(13);
		expect(new Set(CASES.map(([r]) => r)).size).toBe(13);
	});

	for (const [rule, extra, expected] of CASES) {
		it(`renders \`${rule}\` from the catalog, never the backend prose`, () => {
			const label = scanFindingLabel(scan({ rule, ...extra }));
			expect(label).toBe(expected);
			// The assertion that would go red if someone "simplified" the switch into
			// `return finding.message`.
			expect(label).not.toContain(PROSE);
		});
	}

	it('maps every rule onto a DIFFERENT message', () => {
		// A copy-paste in the switch (two cases returning the same `m.*`) is invisible to the
		// per-rule assertions above, which each only check their own sentinel.
		const labels = CASES.map(([rule, extra]) => scanFindingLabel(scan({ rule, ...extra })));
		expect(new Set(labels).size).toBe(CASES.length);
	});
});

describe('scanFindingLabel — the OPEN `type` half is passed through', () => {
	it('⛔ a `source: type` finding returns tsc\'s diagnostic UNCHANGED', () => {
		// ⛔ THE FACT THAT DECIDES THE DESIGN. `lint.ts` emits type findings whose `rule` is a
		// `TS####` code and whose `message` is the TypeScript compiler's own English — thousands of
		// diagnostics, reworded between compiler releases. There is no catalog for that and there
		// must not be one: a developer googles the sentence verbatim. Red by deleting the
		// `if (finding.source === 'type')` line — `TS2345` then falls to `default`, which happens to
		// return the same string, so this case is paired with the one below that CANNOT.
		const tsc = "Argument of type 'string' is not assignable to parameter of type 'number'.";
		expect(scanFindingLabel({ source: 'type', rule: 'TS2345', message: tsc, line: 3, col: 27 })).toBe(
			tsc
		);
	});

	it('⛔ …even when its `rule` collides with a scan rule name', () => {
		// THE CASE THE `default` BRANCH CANNOT SATISFY, and therefore the one that really pins the
		// ORDER of the two branches. A type finding whose rule text happens to equal `no-eval` must
		// still render tsc's message; if the `source` check moved below the switch it would render
		// `M_EVAL` instead and this line goes red.
		const tsc = 'A compiler diagnostic that must survive intact.';
		expect(scanFindingLabel({ source: 'type', rule: 'no-eval', message: tsc })).toBe(tsc);
	});
});

describe('scanFindingLabel — the fallback branches', () => {
	it('falls back to the backend prose for an UNRECOGNISED rule', () => {
		// A twelfth scan rule shipped backend-first must stay READABLE rather than vanish or become
		// a bare `no-timers` token — the same divergence from `complianceLabel` that
		// `data-finding-label.ts` documents. `backend-contract` is what stops it staying English.
		expect(scanFindingLabel(scan({ rule: 'no-timers' }))).toBe(PROSE);
	});

	it('falls back for an ABSENT rule', () => {
		expect(scanFindingLabel(scan({ rule: '' }))).toBe(PROSE);
		expect(scanFindingLabel(scan({ rule: undefined as unknown as string }))).toBe(PROSE);
	});

	it('⛔ `no-require` with NO `spec` falls back — the rolling-deploy branch', () => {
		// ⛔ THIS IS A REAL WIRE SHAPE, NOT A HYPOTHETICAL. `spec` arrived WITH this change, and the
		// Deployment is `maxSurge: 1 / maxUnavailable: 0` — so a new frontend IS answered by an old
		// pod for the length of every rollout. Interpolating anyway would print
		// "Loading “undefined” with require() is not allowed", a localized sentence that says
		// strictly less than the English it replaced. Red by deleting the `if (!finding.spec)` line.
		expect(scanFindingLabel(scan({ rule: 'no-require' }))).toBe(PROSE);
		expect(scanFindingLabel(scan({ rule: 'no-require', spec: '' }))).toBe(PROSE);
	});

	it('⛔ the other two import rules fall back the same way', () => {
		// Guards against the mid-roll check being pasted onto ONE of the three and forgotten on the
		// others — each has its own `if`, so each needs its own assertion.
		expect(scanFindingLabel(scan({ rule: 'banned-import' }))).toBe(PROSE);
		expect(scanFindingLabel(scan({ rule: 'import-not-allowlisted' }))).toBe(PROSE);
	});

	it('⛔ `syntax` with NO `detail` falls back, because the catalog entry WRAPS it', () => {
		// The Dutch entry is "Deze code parseert niet: {detail}". Without the transpiler's text the
		// frame wraps nothing and the reader learns less than the English sentence told them.
		expect(scanFindingLabel(scan({ rule: 'syntax' }))).toBe(PROSE);
	});

	it('does NOT fall back for the nine rules that carry no machine field', () => {
		// ⛔ THE OVER-CORRECTION GUARD. "Always return `finding.message`" satisfies every fallback
		// assertion above; this is the case that stops it, and it is the DEPLOYABLE CORE of the
		// change — these seven rules need no backend field at all and are correct on day one.
		for (const rule of [
			'no-fetch',
			'no-websocket',
			'no-xhr',
			'no-process',
			'no-bun-socket',
			'no-eval',
			'no-function-constructor',
			'no-computed-global',
			'no-dynamic-import'
		]) {
			expect(scanFindingLabel(scan({ rule })), rule).not.toBe(PROSE);
		}
	});

	it('⛔ a NON-STRING machine field falls back instead of rendering `[object Object]`', () => {
		// ⛔ MEASURED ON THIS MODULE, NOT IMAGINED. Before the `usable` guard:
		//     scanFindingLabel({source:'scan', rule:'banned-import', message:'M', spec:{a:1}})
		//       → "“[object Object]” importeren is verboden in de sandbox."
		// `blocks.ts` builds its `ApiError` from `body?.findings` — the raw response body, CAST to
		// `ScanFinding[]` and never inspected — so `spec: string` is a promise the TYPE makes and
		// nothing enforces. The sibling workstream added `isGraphIssueDetail` for exactly this shape;
		// this branch had nothing, which is an asymmetry with its own doctrine rather than a live
		// backend bug (`static-scan.ts` types both fields `string`, proven at runtime by
		// backend/tests/static-scan-machine-fields.test.ts).
		//
		// Red by relaxing `usable` back to truthiness. The English `message` is strictly more
		// information than `[object Object]`, so it is the right fallback — the same one every other
		// branch of this switch already uses.
		for (const bad of [{ a: 1 }, 42, ['node:net'], true, null]) {
			const label = scanFindingLabel(
				scan({ rule: 'banned-import', spec: bad as unknown as string })
			);
			expect(label, `spec=${JSON.stringify(bad)}`).toBe(PROSE);
			expect(label).not.toContain('[object Object]');
		}
		expect(scanFindingLabel(scan({ rule: 'syntax', detail: { a: 1 } as unknown as string }))).toBe(
			PROSE
		);
		// ⛔ THE POSITIVE HALF: a real string still renders, so the guard is not "always fall back".
		expect(scanFindingLabel(scan({ rule: 'banned-import', spec: 'node:net' }))).toBe(
			`M_BANNED(${I('node:net')})`
		);
	});

	it('⛔ every interpolated token is bidi-isolated, whole, and none is split', () => {
		// ⛔ THE ar/he GUARD, AND THE MEASUREMENT THAT MOTIVATES IT IS `syntax`. `<bdi>` at the render
		// site gives the sentence RTL base direction in ar/he; Bun's parser text is a latin LTR run
		// whose TRAILING `.` is a neutral, so it resolves to the RTL base and migrates to the wrong
		// end of the line:
		//     none → `.Expected ")" but found "{" (2:20) :ةرفيشلا هذه ليلحت رّذعت`
		//     iso  → `Expected ")" but found "{" (2:20). :ةرفيشلا هذه ليلحت رّذعت`
		// Red by making `iso` the identity function.
		const detail = 'Expected ")" but found "{" (2:20).';
		const syntax = scanFindingLabel(scan({ rule: 'syntax', detail }));
		expect(syntax).toBe(`M_SYNTAX(${I(detail)})`);
		// ⛔ ONE token, ONE isolate pair — the sibling workstream shipped a compound wrapped as TWO
		// and REVERSED it for an Arabic reader, so "how many isolates" is a real assertion here.
		for (const [rule, extra] of CASES) {
			const out = scanFindingLabel(scan({ rule, ...extra }));
			const wanted = 'spec' in extra || 'detail' in extra ? 1 : 0;
			expect([...out].filter((c) => c === '⁨'), `${rule} opens`).toHaveLength(wanted);
			expect([...out].filter((c) => c === '⁩'), `${rule} closes`).toHaveLength(wanted);
		}
	});

	it('a scan finding with NO `source` at all still resolves by rule', () => {
		// ⚠️ A REAL SHAPE ON ONE OF THE TWO RENDER SITES. `/block-edit`'s publish path reads
		// `ApiError.findings`, which the backend fills from `lint.findings` but which the frontend
		// types as `ScanFinding[]` — a shape with no `source` — and casts to `LintFinding[]`. So
		// `finding.source` is `undefined` there. The `=== 'type'` test must be an equality check,
		// not a truthiness one, or that whole list would fall through to the English.
		expect(scanFindingLabel({ rule: 'no-eval', message: PROSE } as LintFinding)).toBe('M_EVAL');
	});
});
