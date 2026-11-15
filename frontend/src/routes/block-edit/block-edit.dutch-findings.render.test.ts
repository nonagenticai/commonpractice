// @vitest-environment jsdom
//
// src/routes/block-edit/block-edit.dutch-findings.render.test.ts — THE DEFECT, at the surface it
// happened on: a Dutch block author pastes bad code and reads the scan findings.
//
// ⛔ WHY THIS FILE EXISTS WHEN scan-finding-label.test.ts ALREADY PINS THE MAPPING. That file mocks
// `$lib/paraglide/messages` with sentinels, so it proves `rule → which message key`, and nothing
// about what a human sees. A key can exist in all eight catalogs, pass key-parity, pass
// placeholder-parity, and still never reach the screen — because nothing rendered it. That is
// precisely what was true here before this change: `blockedit_lint_issues` ("3 problemen") was
// localized and rendered right beside `{f.message}`, the backend's raw English. Half a screen.
//
// ⛔ NOTHING ABOUT THE MESSAGE LAYER IS MOCKED HERE. Not the catalog, not the compiler output.
// `overwriteGetLocale` is the same lever `$lib/stores/locale.svelte.ts` pulls in the running app,
// so the compiled paraglide functions resolve `nl` exactly as they do in a browser. The sibling
// spec in this directory stubs messages to their KEY NAMES — correct for it (it asserts which key,
// not which words) and useless here, where the words are the subject.
//
// ⛔ BOTH RENDER SITES, IN ONE MOUNT. `/block-edit` has TWO findings lists and both carried the
// defect: the live-lint list under the Implementation editor, and the publish-refusal list under
// the topbar. Fixing one and shipping the other is the obvious way to half-fix this, so both are
// driven in the same page instance and both are asserted.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockDetail, BlockVersion, LintFinding } from '$lib/types/blocks';

vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/block-edit?slug=claims-triage'), params: {} }
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const { getBlock, saveVersion, publishVersion, lint } = vi.hoisted(() => ({
	getBlock: vi.fn(),
	saveVersion: vi.fn(),
	publishVersion: vi.fn(),
	lint: vi.fn()
}));
// ⛔ `ApiError` MUST BE A REAL CLASS with `code` / `findings`: the publish-refusal list is only
// filled by `e instanceof ApiError && e.code === 'lint_failed'`. A plain object falls through to
// the generic banner branch and the second render site never appears.
vi.mock('$lib/api/blocks', () => ({
	// ⚠️ THE PARAMETER ORDER MUST MIRROR THE REAL CLASS — `details` is 4th, `findings` 5th. It used
	// to be `(status, code, message, findings)`, and when `details` was inserted at position 4 in all
	// four duplicated ApiError classes this stub silently kept reading the bag as `findings`: the
	// publish-refusal list stopped rendering and three assertions below went red for a reason that
	// had nothing to do with what they test. A stub that drifts from the class it stands in for is
	// worth less than no stub at all.
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			public code = 'error',
			message = 'error',
			public details?: Record<string, unknown>,
			public findings?: unknown
		) {
			super(message);
		}
	},
	blocksApi: {
		get: getBlock,
		saveVersion,
		publish: publishVersion,
		lint,
		createVersion: vi.fn(),
		create: vi.fn(),
		remove: vi.fn()
	}
}));
vi.mock('$lib/api/templates', () => ({ templatesApi: { create: vi.fn(), list: vi.fn() } }));
vi.mock('$lib/api/ontology', () => ({
	ApiError: class ApiError extends Error {},
	ontologyApi: {
		matrix: vi.fn().mockResolvedValue({ industries: [], departments: [], cells: [] }),
		get: vi.fn()
	}
}));
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: { isDeveloper: true, isSuperAdmin: true, isTenantAdmin: true }
}));

import { ApiError } from '$lib/api/blocks';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';
import Page from './+page.svelte';

const SLUG = 'claims-triage';
/** Bun's transpiler text, verbatim in shape — the catalog entry WRAPS it, never translates it. */
const PARSE_DETAIL = "Expected ';' but found '}'";
/** A tsc diagnostic, verbatim — the `type` half is deliberately NOT translated. */
const TSC_EN = "Type 'string' is not assignable to type 'number'.";
/**
 * The bidi isolate `scanFindingLabel` wraps every interpolated token in — `<bdi>` in two characters.
 *
 * ⛔ IT IS PART OF THE RENDERED STRING, so every expectation below has to build the same one. It is
 * not cosmetic: `scan_finding_syntax` frames a latin LTR diagnostic in ar/he prose, and without the
 * isolate the diagnostic's trailing `.` resolves to the RTL base level and migrates to the far end
 * of the line. Measured in `scan-finding-label.test.ts`.
 */
const I = (s: string) => `\u2068${s}\u2069`;

/** What the live-lint endpoint answers: three scan rules covering all three shapes, plus a type. */
const LINT_FINDINGS: LintFinding[] = [
	{ source: 'scan', rule: 'no-eval', message: 'eval() is forbidden.', line: 3 },
	{
		source: 'scan',
		rule: 'import-not-allowlisted',
		message: "Import of 'lodash' is not allowed; blocks may only import the Common Practice SDK.",
		line: 1,
		spec: 'lodash'
	},
	{
		source: 'scan',
		rule: 'syntax',
		message: `Source does not parse: ${PARSE_DETAIL}`,
		detail: PARSE_DETAIL
	},
	{ source: 'type', rule: 'TS2322', message: TSC_EN, line: 5, col: 11 }
];

/** What a 422 `lint_failed` puts on `ApiError.findings` — the OTHER list. */
const PUBLISH_FINDINGS: LintFinding[] = [
	{ source: 'scan', rule: 'no-eval', message: 'eval() is forbidden.', line: 3 },
	{
		source: 'scan',
		rule: 'banned-import',
		message: "Import of 'node:net' is forbidden in the sandbox.",
		line: 1,
		spec: 'node:net'
	}
];

function version(): BlockVersion {
	return {
		id: 'v-draft-1',
		block_id: 'b1',
		version: '3',
		status: 'draft',
		language: 'typescript',
		docs_md: '# Claims triage',
		source_ts: 'export default function () {}',
		descriptor: { inputs: {}, outputs: {}, capabilities: { network: false } },
		examples: [],
		changelog: '',
		tests_passing: true,
		usage_count: 0,
		published_by: null,
		published_at: null,
		created_at: '2026-08-01T00:00:00.000Z',
		author: null
	};
}

function detail(): BlockDetail {
	return {
		id: 'b1',
		slug: SLUG,
		name: 'Claims triage',
		description: 'Triage a claim',
		category: 'logic',
		current_version_id: null,
		maintainer_id: null,
		owner: 'tenant',
		region: null,
		cost_class: null,
		license: null,
		archived: false,
		created_at: '2026-08-01T00:00:00.000Z',
		updated_at: '2026-08-01T00:00:00.000Z',
		maintainer: null,
		versions: [version()]
	} as BlockDetail;
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

function click(el: Element) {
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
	el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function buttonLabelled(label: string): HTMLButtonElement | undefined {
	return [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
}

/** Both findings lists on the page, in document order. */
function findingLists(): HTMLElement[] {
	return [...target.querySelectorAll('.findings')] as HTMLElement[];
}

function rowsOf(list: HTMLElement): string[] {
	return [...list.querySelectorAll('li')].map((li) => li.textContent ?? '');
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	overwriteGetLocale(() => 'nl');
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	overwriteGetLocale(() => 'en');
	for (const fn of [getBlock, saveVersion, publishVersion, lint]) fn.mockReset();
});

/**
 * Mount /block-edit, open Implementation so the debounced live lint fires, then press Publish onto
 * a `lint_failed` 422 so the second list appears too. Returns with BOTH lists on screen.
 */
async function mountWithBothLists() {
	getBlock.mockResolvedValue(detail());
	lint.mockResolvedValue({ ok: false, findings: LINT_FINDINGS });
	saveVersion.mockResolvedValue(version());
	publishVersion.mockRejectedValue(
		// `details` is now the 4th parameter and `findings` the 5th — `details` was added at
		// position 4 across all four duplicated ApiError classes so a future `unwrap` cannot fill the
		// wrong slot in one of them. This site passes no bag; the publish path carries `findings`.
		new ApiError(422, 'lint_failed', 'Block failed lint', undefined, PUBLISH_FINDINGS)
	);

	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();

	const tab = buttonLabelled(m.blockedit_tab_implementation());
	expect(tab, 'the Implementation tab never rendered — the live-lint list is unreachable').toBeDefined();
	click(tab!);
	await settle();

	// ⚠️ THE LINT IS DEBOUNCED BY 700 ms IN A `$effect`. `settle()` flushes microtasks and one
	// macrotask; it does not move the clock past the timer. Real time, once, deliberately: fake
	// timers here would also freeze Svelte's own scheduling.
	await new Promise((r) => setTimeout(r, 900));
	await settle();
	expect(lint, 'the debounced live lint never ran, so the first list is empty').toHaveBeenCalled();

	const publish = buttonLabelled(m.blockedit_publish());
	expect(publish, 'the Publish button never rendered — the refusal list is unreachable').toBeDefined();
	expect(publish!.disabled, 'Publish is disabled, so the refusal path is never entered').toBe(false);
	click(publish!);
	await settle();
	expect(publishVersion, 'Publish was clicked but nothing was posted').toHaveBeenCalled();
}

describe('a Dutch author reads /block-edit scan findings in Dutch', () => {
	it('the fixture really is Dutch, and really differs from English', () => {
		// ⛔ NON-VACUITY, AND NOT A FORMALITY. Every assertion below is of the form "the row contains
		// the nl string". If `overwriteGetLocale` stopped working, `m.*()` would return ENGLISH, the
		// rows would contain it, and all of them would pass while proving the exact opposite.
		overwriteGetLocale(() => 'nl');
		const nlEval = m.scan_finding_no_eval();
		const nlSpec = m.scan_finding_import_not_allowlisted({ spec: I('lodash') });
		const nlSyntax = m.scan_finding_syntax({ detail: I(PARSE_DETAIL) });
		overwriteGetLocale(() => 'en');
		expect(nlEval).not.toBe(m.scan_finding_no_eval());
		expect(nlSpec).not.toBe(m.scan_finding_import_not_allowlisted({ spec: I('lodash') }));
		expect(nlSyntax).not.toBe(m.scan_finding_syntax({ detail: I(PARSE_DETAIL) }));
		// …and the placeholders really interpolate rather than emitting a literal `{spec}`.
		expect(nlSpec).toContain('lodash');
		expect(nlSpec).not.toContain('{spec}');
		expect(nlSyntax).toContain(PARSE_DETAIL);
		expect(nlSyntax).not.toContain('{detail}');
	});

	it('⛔ the live-lint list under the editor is Dutch — all three scan shapes', async () => {
		await mountWithBothLists();
		overwriteGetLocale(() => 'nl');

		const lists = findingLists();
		// ⛔ THE POSITIVE MARKER. /block-edit mounts a dozen components; one that throws and the page
		// renders nothing, `querySelectorAll` returns [], and "no English on screen" passes against an
		// empty DOM. The list must EXIST and hold exactly the rows the endpoint answered with.
		expect(lists, 'both findings lists must be on screen').toHaveLength(2);
		const rows = rowsOf(lists[1]!);
		expect(rows, 'the live-lint list rendered the wrong number of rows').toHaveLength(
			LINT_FINDINGS.length
		);

		expect(rows[0]).toContain(m.scan_finding_no_eval());
		expect(rows[1]).toContain(m.scan_finding_import_not_allowlisted({ spec: I('lodash') }));
		expect(rows[2]).toContain(m.scan_finding_syntax({ detail: I(PARSE_DETAIL) }));
		// The rule token is still there beside the sentence — it is an identifier, not prose.
		expect(rows[0]).toContain('no-eval');
		// …and the English the backend shipped is GONE. Red by reverting either render site to
		// `{f.message}`: these are the exact strings the wire fixtures carry.
		const text = lists[1]!.textContent ?? '';
		expect(text).not.toContain('eval() is forbidden.');
		expect(text).not.toContain('blocks may only import the Common Practice SDK');
		expect(text).not.toContain('Source does not parse');
	});

	it('⛔ …and the tsc diagnostic in the SAME list is passed through untranslated', async () => {
		await mountWithBothLists();

		const rows = rowsOf(findingLists()[1]!);
		// The half-open vocabulary, on screen: `TS2322` has no catalog entry and must not get one.
		expect(rows[3]).toContain(TSC_EN);
		expect(rows[3]).toContain('TS2322');
		// The row is still FRAMED in Dutch — the `scan`/`type` tag beside it is localized copy.
		expect(rows[3]).toContain(m.blockedit_lint_src_type());
	});

	it('⛔ the publish-refusal list under the topbar is Dutch too', async () => {
		// The SECOND render site. It is fed by `ApiError.findings`, typed as `ScanFinding[]` and cast
		// to `LintFinding[]` — a shape whose `source` may be absent — so it also proves the label's
		// `source === 'type'` test is an equality check and not a truthiness one.
		await mountWithBothLists();
		overwriteGetLocale(() => 'nl');

		const list = findingLists()[0]!;
		expect(list.querySelector('strong')?.textContent).toBe(m.blockedit_findings_title());
		const rows = rowsOf(list);
		expect(rows, 'the refusal list rendered the wrong number of rows').toHaveLength(
			PUBLISH_FINDINGS.length
		);
		expect(rows[0]).toContain(m.scan_finding_no_eval());
		expect(rows[1]).toContain(m.scan_finding_banned_import({ spec: I('node:net') }));
		expect(rows[1]).toContain('node:net');

		const text = list.textContent ?? '';
		expect(text).not.toContain('eval() is forbidden.');
		expect(text).not.toContain('is forbidden in the sandbox');
	});

	it('both lists isolate the sentence for bidi, and anchor the row LTR', async () => {
		// ⚠️ `dir="ltr"` on the list (rule tokens and line numbers are latin identifiers) and `<bdi>`
		// around the SENTENCE, which is `dir="auto"` — so an ar/he translation gets its own RTL base
		// direction instead of inheriting the container's, and the module specifier it interpolates
		// cannot reorder the prose around it. The live-lint list already had the `dir`; the refusal
		// list did not, and its rows now interpolate specifiers too.
		await mountWithBothLists();
		for (const list of findingLists()) {
			expect(list.getAttribute('dir')).toBe('ltr');
			expect(list.querySelectorAll('li > bdi').length).toBe(list.querySelectorAll('li').length);
		}

		// ⛔ …AND THE SECOND LAYER, WHICH `<bdi>` ALONE DOES NOT GIVE YOU. `<bdi>` is `dir="auto"`, so
		// in ar/he the SENTENCE gets RTL base direction — which is exactly what makes the latin
		// diagnostic inside it reorder. Only the character-level isolate around the interpolated
		// token fixes that, and it has to be in the rendered text node, not just in the label module.
		// Red by making `iso` the identity function.
		const rows = rowsOf(findingLists()[1]!);
		expect(rows[1], 'the module specifier reached the DOM unisolated').toContain(I('lodash'));
		expect(rows[2], 'the transpiler diagnostic reached the DOM unisolated').toContain(
			I(PARSE_DETAIL)
		);
		// The `type` half is passed through verbatim — isolating tsc's own diagnostic would be
		// inventing a wrapper around a string this module deliberately does not touch.
		expect(rows[3]).toContain(TSC_EN);
		expect(rows[3], 'the untranslated tsc diagnostic was wrapped anyway').not.toContain('⁨');
	});
});
