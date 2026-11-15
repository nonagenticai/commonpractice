// src/lib/i18n/graph-issue-label.test.ts — a graph-validation issue is rendered from its RULE, and
// only ever falls back to the backend's English when there is nothing else to say.
//
// The messages module is mocked so each key returns its own name plus its arguments: the assertions
// are about WHICH MESSAGE is selected and WHAT IS INTERPOLATED, not about English copy a translator
// may legitimately reword. Same technique as `data-finding-label.test.ts` and `stage-label.test.ts`.
import { describe, it, expect, vi } from 'vitest';
import type { GraphIssue } from '$lib/types/flows';

vi.mock('$lib/paraglide/messages', () => ({
	graph_issue_cycle: () => 'M_CYCLE()',
	graph_issue_duplicate_node_id: (p: Record<string, unknown>) => `M_DUPNODE(${p.ref})`,
	graph_issue_duplicate_edge_id: (p: Record<string, unknown>) => `M_DUPEDGE(${p.ref})`,
	graph_issue_edge_missing_source: (p: Record<string, unknown>) => `M_NOSRC(${p.sourceNode})`,
	graph_issue_edge_missing_target: (p: Record<string, unknown>) => `M_NOTGT(${p.targetNode})`,
	graph_issue_unknown_source_handle: (p: Record<string, unknown>) =>
		`M_BADSRCH(${p.sourceNode},${p.sourceHandle})`,
	graph_issue_unknown_target_handle: (p: Record<string, unknown>) =>
		`M_BADTGTH(${p.targetNode},${p.targetHandle})`,
	// ⚠️ FOUR INPUTS, NOT SIX. The catalog names the two `slug.handle` COMPOUNDS as single
	// placeholders (`{source}` / `{target}`) so the dot sits inside one bidi isolate — see the `iso`
	// header in graph-issue-label.ts and `graph-issue-label.bidi.test.ts` for what per-field
	// isolation rendered to an Arabic reader.
	graph_issue_incompatible_handle_type: (p: Record<string, unknown>) =>
		`M_TYPE(${p.source},${p.sourceType},${p.target},${p.targetType})`,
	graph_issue_missing_required_input: (p: Record<string, unknown>) => `M_REQ(${p.node},${p.handle})`,
	graph_issue_missing_descriptor: (p: Record<string, unknown>) =>
		`M_NODESC(${p.node},${p.blockVersion})`,
	graph_issue_nested_foreach: (p: Record<string, unknown>) => `M_NESTED(${p.node},${p.parent})`,
	graph_issue_orphan_loop_body: (p: Record<string, unknown>) => `M_ORPHAN(${p.node},${p.parent})`
}));

const { graphIssueLabel } = await import('./graph-issue-label');

const PROSE = 'BACKEND ENGLISH — must not be reached';

/** The bidi isolate `graphIssueLabel` wraps every identifier in — `<bdi>` in two characters. */
const I = (s: string) => `⁨${s}⁩`;

/** One issue of `rule`, carrying `detail` and the English message the backend always ships. */
const issue = (rule: string, detail?: Record<string, string>, ref = 'e1'): GraphIssue => ({
	rule,
	message: PROSE,
	ref,
	detail
});

/** Every rule with a COMPLETE `detail`, and the sentinel it must produce. */
const COMPLETE: [string, GraphIssue, string][] = [
	['cycle', issue('cycle', undefined, undefined), 'M_CYCLE()'],
	['duplicate-node-id', issue('duplicate-node-id', undefined, 'n1'), `M_DUPNODE(${I('n1')})`],
	['duplicate-edge-id', issue('duplicate-edge-id', undefined, 'e1'), `M_DUPEDGE(${I('e1')})`],
	[
		'edge-missing-source',
		issue('edge-missing-source', { sourceNode: 'n9' }),
		`M_NOSRC(${I('n9')})`
	],
	[
		'edge-missing-target',
		issue('edge-missing-target', { targetNode: 'n9' }),
		`M_NOTGT(${I('n9')})`
	],
	[
		'unknown-source-handle',
		issue('unknown-source-handle', { sourceNode: 'http-fetch', sourceHandle: 'rows' }),
		`M_BADSRCH(${I('http-fetch')},${I('rows')})`
	],
	[
		'unknown-target-handle',
		issue('unknown-target-handle', { targetNode: 'llm-summarize', targetHandle: 'promt' }),
		`M_BADTGTH(${I('llm-summarize')},${I('promt')})`
	],
	[
		'incompatible-handle-type',
		issue('incompatible-handle-type', {
			sourceNode: 'http-fetch',
			sourceHandle: 'rows',
			sourceType: 'json',
			targetNode: 'llm-summarize',
			targetHandle: 'prompt',
			targetType: 'string'
		}),
		`M_TYPE(${I('http-fetch.rows')},${I('json')},${I('llm-summarize.prompt')},${I('string')})`
	],
	[
		'missing-required-input',
		issue('missing-required-input', { node: 'llm-summarize', handle: 'prompt' }, 'n2'),
		`M_REQ(${I('llm-summarize')},${I('prompt')})`
	],
	[
		'missing-descriptor',
		issue('missing-descriptor', { node: 'llm-summarize', blockVersion: 'v7' }, 'n2'),
		`M_NODESC(${I('llm-summarize')},${I('v7')})`
	],
	[
		'nested-foreach',
		issue('nested-foreach', { node: 'inner-loop', parent: 'outer-loop' }, 'n3'),
		`M_NESTED(${I('inner-loop')},${I('outer-loop')})`
	],
	[
		'orphan-loop-body',
		issue('orphan-loop-body', { node: 'stray', parent: 'not-a-loop' }, 'n4'),
		`M_ORPHAN(${I('stray')},${I('not-a-loop')})`
	]
];

describe('graphIssueLabel — the catalog path', () => {
	it('covers ALL TWELVE rules, so this table cannot silently shrink', () => {
		// ⛔ NON-VACUITY. Every `it.each` below only tests the rows that exist; a row deleted with a
		// case is invisible. The backend union is 12 wide (`graph-issue-label.backend-contract.test.ts`
		// pins that against the source) and so is this table.
		expect(COMPLETE).toHaveLength(12);
		expect(new Set(COMPLETE.map(([r]) => r)).size).toBe(12);
	});

	it.each(COMPLETE)('%s renders its own catalog sentence, never the backend prose', (_r, i, want) => {
		expect(graphIssueLabel(i)).toBe(want);
		expect(graphIssueLabel(i)).not.toContain(PROSE);
	});

	it('maps every rule onto a DIFFERENT message', () => {
		// A copy-paste in the switch (two cases returning the same `m.*`) would leave one rule
		// describing another rule's problem, in perfect Dutch.
		const rendered = COMPLETE.map(([, i]) => graphIssueLabel(i));
		expect(new Set(rendered).size).toBe(12);
	});
});

describe('graphIssueLabel — identifiers are bidi-isolated', () => {
	it('wraps every interpolated token in U+2068/U+2069, and the COMPOUND as ONE token', () => {
		// ⛔ THE RTL GUARD — and the shape of it is the whole point. This used to be a PRESENCE
		// COUNT (`six isolate opens, six isolate closes`), which is exactly what let the defect ship:
		// per-field isolation produces six pairs too, and reverses `http-fetch.rows` into
		// `rows.http-fetch` for an ar/he reader. A count is blind to order. The ORDER assertion lives
		// in `graph-issue-label.bidi.test.ts` against the real catalogs; this pins the shape here so
		// the sentinel table above cannot be "fixed" back to six.
		const out = graphIssueLabel(COMPLETE[7]![1]);
		expect(out).toContain(I('http-fetch.rows'));
		expect(out).toContain(I('llm-summarize.prompt'));
		expect(out).toContain(I('json'));
		// ⛔ …and the dot is INSIDE the isolate, never between two of them.
		expect(out, 'the compound was split across two isolates — ar/he will reverse it').not.toMatch(/⁩\.⁨/);
		// Four tokens in, four isolate pairs out — no token slipped through unwrapped.
		expect([...out].filter((c) => c === '⁨')).toHaveLength(4);
		expect([...out].filter((c) => c === '⁩')).toHaveLength(4);
	});

	it('isolates the `ref` on the duplicate-* rules too', () => {
		expect(graphIssueLabel(issue('duplicate-node-id', undefined, 'n1'))).toContain(I('n1'));
	});
});

describe('graphIssueLabel — the fallback branches', () => {
	it('falls back to the backend prose for an UNRECOGNISED rule', () => {
		// ⛔ THE DELIBERATE DIVERGENCE FROM `complianceLabel`, which returns the raw key. A rule
		// shipped backend-first must still be READABLE: it is the only text explaining why the flow
		// was refused, and a bare `unreachable-node` token tells the author nothing they can act on.
		expect(graphIssueLabel(issue('unreachable-node', { node: 'x' }))).toBe(PROSE);
	});

	it('falls back for an ABSENT rule', () => {
		expect(graphIssueLabel(issue(''))).toBe(PROSE);
		expect(graphIssueLabel(issue(undefined as unknown as string))).toBe(PROSE);
	});

	it('⛔ falls back for EVERY parameterised rule when `detail` is absent — the mid-roll shape', () => {
		// The Service load-balances a new bundle onto an OLD pod for the length of a rolling deploy
		// (`maxSurge: 1`, `maxUnavailable: 0`), so a known rule with NO `detail` is a real wire
		// shape. Interpolating anyway would render `Edge undefined: 'undefined.undefined'` — a
		// localized sentence that says strictly less than the English it replaced.
		for (const [rule, , ] of COMPLETE) {
			if (rule === 'cycle' || rule.startsWith('duplicate-')) continue;
			expect(graphIssueLabel({ rule, message: PROSE, ref: 'e1' }), rule).toBe(PROSE);
		}
	});

	it('falls back when ONE field of a multi-field rule is missing', () => {
		// The partial shape a rule that GROWS a field produces. Six-field
		// `incompatible-handle-type` is the one where "nearly all of them" is most tempting.
		const full = COMPLETE[7]![1].detail as Record<string, string>;
		for (const k of Object.keys(full)) {
			const { [k]: _drop, ...rest } = full;
			expect(graphIssueLabel({ rule: 'incompatible-handle-type', message: PROSE, detail: rest }), k).toBe(PROSE);
		}
		expect(
			graphIssueLabel({ rule: 'missing-required-input', message: PROSE, detail: { node: 'a' } })
		).toBe(PROSE);
		expect(
			graphIssueLabel({ rule: 'nested-foreach', message: PROSE, detail: { parent: 'a' } })
		).toBe(PROSE);
	});

	it('treats an EMPTY STRING as absent', () => {
		// `“” has no output “”` is a worse read than the English sentence it replaced, and it looks
		// like a product bug rather than an authoring mistake.
		expect(
			graphIssueLabel({
				rule: 'unknown-source-handle',
				message: PROSE,
				detail: { sourceNode: '', sourceHandle: 'rows' }
			})
		).toBe(PROSE);
		expect(graphIssueLabel({ rule: 'duplicate-node-id', message: PROSE, ref: '' })).toBe(PROSE);
	});

	it('does NOT fall back for `cycle`, which has no machine fields to be missing', () => {
		// Guards against a copy-paste of the mid-roll guard onto the one rule that cannot need it:
		// an old pod's `cycle` issue is already complete, so English there would be a pure regression.
		expect(graphIssueLabel({ rule: 'cycle', message: PROSE })).toBe('M_CYCLE()');
	});

	it('ignores an UNKNOWN `detail` key rather than falling back', () => {
		// `detail` is backend-first: a thirteenth field must not cost the reader the sentence.
		expect(
			graphIssueLabel({
				rule: 'missing-required-input',
				message: PROSE,
				detail: { node: 'a', handle: 'b', futureField: 'c' } as Record<string, string>
			})
		).toBe(`M_REQ(${I('a')},${I('b')})`);
	});
});
