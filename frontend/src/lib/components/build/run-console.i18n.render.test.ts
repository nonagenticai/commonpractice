// @vitest-environment jsdom
//
// src/lib/components/build/run-console.i18n.render.test.ts — the run console, in a non-English
// locale, fed the exact TraceEvent stream the runner emits.
//
// ⛔ THE DEFECT. The console's chrome — empty state, "run started", "node running", "node skipped"
// — was already translated. The lines that carry the RESULT were not:
//     ● run ok · 1240ms · 3 llm · 812+204 tok · $0.0041
//     ✗ fetch-claims · block_throw: Cannot read property 'id' of undefined
//     ⊘ join-rows skipped (upstream node 'n3' did not produce output)
// English words plus TWO raw enums (`run_complete.status`, `node_error.kind`), and the last one is
// worse than the other two: the FRAME is Dutch and the reason inside it is English, with a raw
// graph-internal node id the builder canvas never shows.
//
// Messages are mocked from the base catalog with each key returning ITS OWN NAME, so the assertions
// state WHICH message resolved without pinning copy. Same technique as
// routes/governance/governance-page.i18n.render.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { TraceEvent } from '$lib/types/trace';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

import RunConsole from './RunConsole.svelte';

const RUN = 'run-1';
const cost = { usd: 0.0041, tokensIn: 812, tokensOut: 204, llmCalls: 3 };
const noCost = { usd: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0 };

/** Every English fragment this component used to compose. */
// ⚠️ Anchored on the SEPARATORS the pre-change lines used, not on the bare words: the mocked
// message key `console_error_kind_block_throw` legitimately CONTAINS "block_throw", so a loose
// probe reds on the fix rather than on the defect.
const ENGLISH = [' run ok · ', ' llm · ', ' tok · ', ' · block_throw:', "upstream node 'n3'"];

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

function render(events: TraceEvent[]) {
	app = mount(RunConsole, {
		target: host,
		// `showCost`: the cost suffix is an administrator's view (run-console.cost.render.test.ts
		// covers who sees it); this file checks how it is worded when shown.
		props: { events, status: 'idle' as const, nodeCount: 3, showCost: true }
	});
	flushSync();
	return [...host.querySelectorAll('.line')].map((n) => n.textContent ?? '');
}

describe('the run console leaves no English on its result lines', () => {
	it('renders the run-complete line from the catalog, reusing `runStatusLabel`', () => {
		const lines = render([
			{ type: 'run_complete', runId: RUN, ts: 1, totalMs: 1240, status: 'ok', totals: cost }
		]);
		// ⛔ NON-VACUITY: assert the component rendered a line at all before asserting what is absent.
		expect(lines, 'the console rendered no lines').toHaveLength(1);
		// `run_status_ok` is `run-status-label.ts`'s key — REUSE, not a second status vocabulary.
		// REVERT THAT TURNS THIS RED: pass `ev.status` instead of `runStatusLabel(ev.status)`.
		expect(lines[0]).toBe(
			'● console_trace_run_complete:run_status_ok,1.24s · console_trace_cost:3,812,204,$0.0041'
		);
	});

	it('maps each run status through the SHARED label, not a new key family', () => {
		for (const [status, key] of [
			['ok', 'run_status_ok'],
			['partial', 'run_status_partial'],
			['failed', 'run_status_failed']
		] as const) {
			const lines = render([
				{ type: 'run_complete', runId: RUN, ts: 1, totalMs: 900, status, totals: noCost }
			]);
			expect(lines[0]).toContain(key);
			if (app) unmount(app);
			app = undefined;
		}
	});

	it('renders the node-success line with the SHARED `ms()` formatter and the cost message', () => {
		const lines = render([
			{
				type: 'node_success',
				runId: RUN,
				ts: 1,
				nodeId: 'n1',
				slug: 'fetch-claims',
				durationMs: 412,
				cost,
				outputPreview: '{}'
			}
		]);
		expect(lines).toHaveLength(1);
		// The slug is an IDENTIFIER and stays verbatim; only the unit and the cost words are owned
		// by the catalog. `412ms` is `ms()`'s output, the same one /it-dash's P95 card uses.
		expect(lines[0]).toBe('  ✓ fetch-claims · 412ms · console_trace_cost:3,812,204,$0.0041');
	});

	it('omits the cost tail entirely when the node made no LLM calls', () => {
		const lines = render([
			{
				type: 'node_success',
				runId: RUN,
				ts: 1,
				nodeId: 'n1',
				slug: 'fetch-claims',
				durationMs: 412,
				cost: noCost,
				outputPreview: '{}'
			}
		]);
		expect(lines[0]).toBe('  ✓ fetch-claims · 412ms');
		expect(lines[0]).not.toContain('console_trace_cost');
	});

	it('⛔ names the error KIND from the catalog instead of printing the raw enum', () => {
		// REVERT THAT TURNS THIS RED: put `${ev.kind}` back in place of `errorKindLabel(ev.kind)`.
		const lines = render([
			{
				type: 'node_error',
				runId: RUN,
				ts: 1,
				nodeId: 'n1',
				slug: 'fetch-claims',
				durationMs: 90,
				error: "Cannot read property 'id' of undefined",
				kind: 'block_throw'
			}
		]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe(
			"  ✗ fetch-claims · console_error_kind_block_throw: Cannot read property 'id' of undefined"
		);
		// ⚠️ `ev.error` is the block author's own message — arbitrary text with no code behind it.
		// It stays verbatim, knowingly; there is nothing to localise it FROM.
		expect(lines[0]).toContain("Cannot read property 'id' of undefined");
	});

	it('has a case for EVERY ErrorKind the backend can emit', () => {
		// Nine kinds in backend/src/db/trace-types.ts. A tenth added there without a case here falls
		// through to the raw enum, which this test names one by one so the gap is visible.
		const kinds = [
			'timeout',
			'validation',
			'block_throw',
			'network_blocked',
			'llm_capped',
			'model_not_allowed',
			'budget_exhausted',
			'flow_error',
			'internal'
		] as const;
		for (const kind of kinds) {
			const lines = render([
				{
					type: 'node_error',
					runId: RUN,
					ts: 1,
					nodeId: 'n1',
					slug: 's',
					durationMs: 1,
					error: 'e',
					kind
				}
			]);
			expect(lines[0], `${kind} rendered its raw enum`).toContain(`console_error_kind_${kind}`);
			if (app) unmount(app);
			app = undefined;
		}
	});

	it('⛔ an unrecognised kind renders a GENERIC LOCALIZED word, never the raw value', () => {
		// ⛔⛔ THIS ASSERTION WAS INVERTED ON 2026-08-24, AND THE OLD ONE WAS A SECURITY HOLE IT
		// PINNED IN PLACE. It used to read `.toBe('  ✗ s · quota_exceeded: e')` — "falls back to the
		// RAW enum, never a blank" — reasoning that a tenth kind added backend-first should still
		// say something. But `kind` is NOT a closed enum on the wire: `flow-executor.ts` copied any
		// string off a caught error, so a block author's
		//     throw Object.assign(new Error('x'), {kind: 'WAARSCHUWING: uw account wordt geblokkeerd'})
		// rendered their sentence as product chrome in the reader's language. The backend now
		// allowlists at both entry points; this is the archive-replay backstop, and a generic word
		// is the only fallback an author cannot author.
		const lines = render([
			{
				type: 'node_error',
				runId: RUN,
				ts: 1,
				nodeId: 'n1',
				slug: 's',
				durationMs: 1,
				error: 'e',
				kind: 'WAARSCHUWING: uw account wordt geblokkeerd' as never
			}
		]);
		expect(lines[0]).toBe('  ✗ s · console_error_kind_unknown: e');
		expect(lines[0]).not.toContain('WAARSCHUWING');
	});

	it('shows no English fragment across a whole realistic stream', () => {
		const lines = render([
			{ type: 'run_start', runId: RUN, ts: 1, nodeCount: 3 },
			{ type: 'node_start', runId: RUN, ts: 2, nodeId: 'n1', slug: 'fetch-claims' },
			{
				type: 'node_success',
				runId: RUN,
				ts: 3,
				nodeId: 'n1',
				slug: 'fetch-claims',
				durationMs: 412,
				cost,
				outputPreview: '{}'
			},
			{
				type: 'node_error',
				runId: RUN,
				ts: 4,
				nodeId: 'n2',
				slug: 'triage',
				durationMs: 90,
				error: 'boom',
				kind: 'block_throw'
			},
			{
				type: 'node_skipped',
				runId: RUN,
				ts: 5,
				nodeId: 'n4',
				slug: 'join-rows',
				reason: "upstream node 'n3' did not produce output",
				reasonCode: 'upstream_no_output',
				upstreamSlug: 'triage'
			},
			{ type: 'run_complete', runId: RUN, ts: 6, totalMs: 1240, status: 'partial', totals: cost }
		]);
		// ⛔ NON-VACUITY FIRST: six events in, six lines out, and a positive marker present.
		expect(lines).toHaveLength(6);
		const all = lines.join('\n');
		expect(all).toContain('console_trace_run_complete');

		expect(ENGLISH.filter((s) => all.includes(s))).toEqual([]);
	});
});

describe('node_skipped — the reason is a CODE now, and the old prose is still the fallback', () => {
	function skipped(extra: Partial<Extract<TraceEvent, { type: 'node_skipped' }>>): string[] {
		return render([
			{
				type: 'node_skipped',
				runId: RUN,
				ts: 1,
				nodeId: 'n4',
				slug: 'join-rows',
				reason: "upstream node 'n3' did not produce output",
				...extra
			} as TraceEvent
		]);
	}

	it('localizes the reason and names the upstream BLOCK, not its node id', () => {
		// ⛔ The whole line is now one language. REVERT THAT TURNS THIS RED: return `ev.reason`
		// unconditionally from `skipReason` — the English sentence and the raw `n3` come back inside
		// the Dutch frame.
		const lines = skipped({ reasonCode: 'upstream_no_output', upstreamSlug: 'triage' });
		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe(
			'  ⊘ console_trace_node_skipped:join-rows,console_trace_reason_upstream_no_output:triage'
		);
		expect(lines[0]).not.toContain('n3');
	});

	it('⛔ falls back to the backend prose for an ARCHIVED trace with no reasonCode', () => {
		// This is NOT only a rolling-deploy window: `flow_runs.trace` is a jsonb ARCHIVE, so every
		// run recorded before this change replays through here with `reason` and nothing else.
		// Reopening a week-old run must not show a blank skip line.
		const lines = skipped({});
		expect(lines[0]).toBe(
			"  ⊘ console_trace_node_skipped:join-rows,upstream node 'n3' did not produce output"
		);
		expect(lines[0]).not.toContain('console_trace_reason_upstream_no_output');
		expect(lines[0]).not.toContain('undefined');
	});

	it('falls back when the code arrived but the slug did not', () => {
		// A half-populated event: interpolating anyway prints "…block undefined produced no output".
		const lines = skipped({ reasonCode: 'upstream_no_output' });
		expect(lines[0]).toContain("upstream node 'n3' did not produce output");
		expect(lines[0]).not.toContain('undefined');
	});

	it('falls back for a reasonCode this build does not recognise', () => {
		const lines = skipped({
			reasonCode: 'foreach_body_error' as never,
			upstreamSlug: 'triage'
		});
		expect(lines[0]).toContain("upstream node 'n3' did not produce output");
	});
});
