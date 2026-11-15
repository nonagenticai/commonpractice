// @vitest-environment jsdom
//
// src/lib/components/build/flow-history-panel.i18n.render.test.ts — the /build flow-history drawer,
// in a non-English locale, fed the exact snapshot rows `GET /api/flows/:id/snapshots` returns.
//
// ⛔ THE DEFECT. The drawer's chrome — title, checkpoint button, "AI"/"Manual" badges, the
// "3 nodes · 2 edges" line, the relative timestamps — was already translated. The line that carries
// the CONTENT was not:
//     connected n_4f1a.text → n_9c02.text
//     configured n_9c02.model
//     Restored snapshot from 2026-08-07T09:12:44.031Z
// English sentences plus raw graph-internal ids, sitting between two Dutch lines, on the product's
// primary authoring surface. And it rendered TWICE per row: `{s.summary}` in the body AND
// `title={s.summary}` as the tooltip — which is the copy a reader actually hovers, because `.sum`
// is `text-overflow: ellipsis` and truncates the body.
//
// Messages are mocked from the base catalog with each key returning ITS OWN NAME, so the assertions
// state WHICH message resolved without pinning copy. Same technique as
// `run-console.i18n.render.test.ts`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { FlowSnapshotSummary } from '$lib/types/flows';

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

// The drawer loads through the API on mount; every test here supplies its own rows.
const listSnapshots = vi.fn();
vi.mock('$lib/api/flows', () => ({
	flowsApi: {
		listSnapshots: (...a: unknown[]) => listSnapshots(...a),
		checkpoint: vi.fn(),
		restoreSnapshot: vi.fn()
	}
}));

// ⛔ THE LOCALE IS `nl`, NOT `en`. `num()` and `fullDate()` are the REAL implementations here — this
// is the one thing the message mock cannot stand in for, and a `.` where a Dutch reader expects a
// `,` is the exact class of defect `format.ts` exists to prevent.
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'nl' } }));

import FlowHistoryPanel from './FlowHistoryPanel.svelte';

/** Every English fragment the panel used to compose, anchored on the template's own separators. */
const ENGLISH = [
	'connected ',
	'configured ',
	'added ',
	'inserted ',
	'disconnected edge ',
	'removed node ',
	'moved node ',
	'Manual checkpoint',
	'Restored snapshot from '
];

const BASE: FlowSnapshotSummary = {
	id: 's1',
	source: 'ai',
	summary: 'BACKEND ENGLISH',
	summary_code: null,
	summary_params: null,
	created_by: null,
	created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
	node_count: 3,
	edge_count: 2
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	listSnapshots.mockReset();
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

/** Mount the open drawer over `items` and return every row's summary element. */
async function render(items: Partial<FlowSnapshotSummary>[]): Promise<HTMLElement[]> {
	listSnapshots.mockResolvedValue({ items: items.map((i) => ({ ...BASE, ...i })), readOnly: false });
	app = mount(FlowHistoryPanel, {
		target: host,
		props: { flowId: 'f1', open: true, onClose: () => {}, onRestored: () => {} }
	});
	flushSync();
	// `load()` is async; let the promise settle, then flush the resulting state change.
	await Promise.resolve();
	await Promise.resolve();
	flushSync();
	return [...host.querySelectorAll('.sum')] as HTMLElement[];
}

const body = (el: HTMLElement) => el.textContent ?? '';
const tip = (el: HTMLElement) => el.getAttribute('title') ?? '';

describe('the flow-history drawer leaves no English on its summary lines', () => {
	it('⛔ localizes BOTH the row body AND the `title=` tooltip', () => {
		// REVERT THAT TURNS THIS RED: put `title={s.summary}>{s.summary}` back. The tooltip half is
		// the one a naive fix forgets, and it is the half a reader opens on purpose when the body is
		// ellipsised.
		return render([
			{
				summary_code: 'flow_summary_added',
				summary_params: { slug: 'ai-summarize' },
				summary: 'added ai-summarize'
			}
		]).then((rows) => {
			expect(rows, 'the drawer rendered no rows').toHaveLength(1);
			expect(body(rows[0]!)).toContain('flow_summary_added');
			expect(tip(rows[0]!)).toContain('flow_summary_added');
			expect(body(rows[0]!)).not.toContain('added ai-summarize');
			expect(tip(rows[0]!)).not.toContain('added ai-summarize');
			// The slug is an IDENTIFIER and stays verbatim — only the words are the catalog's.
			expect(body(rows[0]!)).toContain('ai-summarize');
		});
	});

	it('renders every one of the nine codes from the catalog, none in English', async () => {
		// ⛔ ONE ROW PER CODE, in one mount, so the assertion is about the whole vocabulary rather
		// than a sampled member. A tenth code with no `case` shows up here as its own English line.
		const rows = await render([
			{ id: 'a', summary_code: 'flow_summary_added', summary_params: { slug: 'ai-summarize' }, summary: 'added ai-summarize' },
			{
				id: 'b',
				summary_code: 'flow_summary_connected',
				summary_params: { source: 'n_4f1a', sourceHandle: 'text', target: 'n_9c02', targetHandle: 'text' },
				summary: 'connected n_4f1a.text → n_9c02.text'
			},
			{ id: 'c', summary_code: 'flow_summary_disconnected', summary_params: { edgeId: 'e_11' }, summary: 'disconnected edge e_11' },
			{ id: 'd', summary_code: 'flow_summary_removed', summary_params: { nodeId: 'n_9c02' }, summary: 'removed node n_9c02' },
			{ id: 'e', summary_code: 'flow_summary_configured', summary_params: { nodeId: 'n_9c02', key: 'model' }, summary: 'configured n_9c02.model' },
			{ id: 'f', summary_code: 'flow_summary_moved', summary_params: { nodeId: 'n_9c02' }, summary: 'moved node n_9c02' },
			{ id: 'g', summary_code: 'flow_summary_inserted', summary_params: { slug: 'ai-summarize', edgeId: 'e_11' }, summary: 'inserted ai-summarize into edge e_11' },
			{ id: 'h', source: 'manual', summary_code: 'flow_summary_manual_checkpoint', summary_params: null, summary: 'Manual checkpoint' },
			{
				id: 'i',
				source: 'manual',
				summary_code: 'flow_summary_restored',
				summary_params: { at: '2026-08-07T09:12:44.031Z' },
				summary: 'Restored snapshot from 2026-08-07T09:12:44.031Z'
			}
		]);
		// ⛔ NON-VACUITY FIRST: nine rows in, nine rendered, and a positive marker present.
		expect(rows).toHaveLength(9);
		const all = rows.map((r) => `${body(r)}\n${tip(r)}`).join('\n');
		expect(all).toContain('flow_summary_connected');

		for (const key of [
			'flow_summary_added',
			'flow_summary_connected',
			'flow_summary_disconnected',
			'flow_summary_removed',
			'flow_summary_configured',
			'flow_summary_moved',
			'flow_summary_inserted',
			'flow_summary_manual_checkpoint',
			'flow_summary_restored'
		]) {
			expect(all, `${key} did not resolve`).toContain(key);
		}
		expect(ENGLISH.filter((s) => all.includes(s))).toEqual([]);
	});

	it('⛔ joins the compound refs itself and wraps EACH COMPOUND in ONE bidi isolate', async () => {
		// THE BIDI CONTRACT, ASSERTED ON ORDER RATHER THAN ON A COUNT OF ISOLATE CHARACTERS — a
		// presence count passes the reversed string, which is the measured mistake
		// `graph-issue-label.ts` documents. `n_4f1a.text` must arrive as ONE ⁨…⁩ run, dot included;
		// isolating the two halves separately leaves the `.` outside both and ar/he swap them.
		const rows = await render([
			{
				summary_code: 'flow_summary_connected',
				summary_params: { source: 'n_4f1a', sourceHandle: 'text', target: 'n_9c02', targetHandle: 'out' },
				summary: 'connected n_4f1a.text → n_9c02.out'
			},
			{
				id: 's2',
				summary_code: 'flow_summary_configured',
				summary_params: { nodeId: 'n_9c02', key: 'model' },
				summary: 'configured n_9c02.model'
			}
		]);
		expect(rows).toHaveLength(2);
		expect(body(rows[0]!)).toContain('⁨n_4f1a.text⁩');
		expect(body(rows[0]!)).toContain('⁨n_9c02.out⁩');
		// ⛔ THE HALVES ARE NOT ISOLATED SEPARATELY. `⁨n_4f1a⁩.⁨text⁩` is the defect shape.
		expect(body(rows[0]!)).not.toContain('⁨n_4f1a⁩');
		expect(body(rows[0]!)).not.toContain('⁨text⁩');
		expect(body(rows[1]!)).toContain('⁨n_9c02.model⁩');
		expect(body(rows[1]!)).not.toContain('⁨model⁩');
		// The tooltip carries the same isolates — it is the same string.
		expect(tip(rows[0]!)).toContain('⁨n_4f1a.text⁩');
	});

	it('⛔ a row with `summary_code: null` renders the backend ENGLISH — the permanent branch', async () => {
		// NOT only a rolling-deploy window. `flow_snapshots` is a STORED table and 0071 ships no
		// backfill, so every pre-0071 row carries null forever; `SNAPSHOT_KEEP = 50` only ages them
		// out on a flow that keeps being edited. Opening a year-old flow's history must not blank it.
		const rows = await render([{ summary_code: null, summary_params: null, summary: 'added ai-summarize' }]);
		expect(rows).toHaveLength(1);
		expect(body(rows[0]!)).toBe('added ai-summarize');
		expect(tip(rows[0]!)).toBe('added ai-summarize');
		expect(body(rows[0]!)).not.toContain('flow_summary_');
		expect(body(rows[0]!)).not.toContain('undefined');
	});

	it("⛔ a checkpoint the USER labelled comes back in the USER's words, never translated", async () => {
		// The backend emits NO code when `body.summary` has text, precisely so this holds — and it
		// holds even when the words the user typed are, exactly, the English default.
		const rows = await render([
			{ source: 'manual', summary_code: null, summary_params: null, summary: 'voor de demo van dinsdag' },
			{ id: 's2', source: 'manual', summary_code: null, summary_params: null, summary: 'Manual checkpoint' }
		]);
		expect(body(rows[0]!)).toBe('voor de demo van dinsdag');
		expect(body(rows[1]!)).toBe('Manual checkpoint');
		expect(body(rows[1]!)).not.toContain('flow_summary_manual_checkpoint');
	});

	it('falls back when the code arrived but its params did not', async () => {
		// An old pod mid-roll, and a template that grows a field. Interpolating anyway would print
		// "connected undefined.undefined → undefined.undefined" — a localized sentence that says
		// strictly less than the English one it replaced.
		const rows = await render([
			{ summary_code: 'flow_summary_connected', summary_params: null, summary: 'connected n_4f1a.text → n_9c02.text' },
			{ id: 's2', summary_code: 'flow_summary_added', summary_params: { slug: '' }, summary: 'added ai-summarize' }
		]);
		expect(body(rows[0]!)).toBe('connected n_4f1a.text → n_9c02.text');
		expect(body(rows[1]!)).toBe('added ai-summarize');
		expect(rows.map(body).join('\n')).not.toContain('undefined');
	});

	it('falls back for a code this build does not recognise, never a bare token', async () => {
		const rows = await render([
			{ summary_code: 'flow_summary_forked', summary_params: { slug: 'x' }, summary: 'forked x' }
		]);
		expect(body(rows[0]!)).toBe('forked x');
		expect(body(rows[0]!)).not.toContain('flow_summary_forked');
	});

	it('formats the restored-from instant with the shared date formatter, in the row locale', async () => {
		// ⛔ THE REAL `fullDate` RUNS HERE (only `$lib/paraglide/messages` is mocked). The wire
		// carries a raw ISO; a Dutch reader must not see `2026-08-07T09:12:44.031Z`.
		//
		// ⚠️ AND THE ROW'S OWN TIME STAYS RELATIVE. `fmtAgo()` renders "5m ago" two lines below from
		// `created_at`; this sentence renders an absolute DATE for a different instant. Two
		// timestamps of the same shape two lines apart would read as one of them being wrong —
		// relative-when above, absolute-what below, is the pairing that reads as two facts.
		const rows = await render([
			{
				source: 'manual',
				summary_code: 'flow_summary_restored',
				summary_params: { at: '2026-08-07T09:12:44.031Z' },
				summary: 'Restored snapshot from 2026-08-07T09:12:44.031Z'
			}
		]);
		expect(body(rows[0]!)).toContain('flow_summary_restored');
		expect(body(rows[0]!)).not.toContain('2026-08-07T09:12:44.031Z');
		// `fullDate(…, 'nl')` → "7 aug 2026". Assert the LOCALE-SPECIFIC parts, not the exact
		// punctuation Intl chooses (which moves with ICU versions).
		expect(body(rows[0]!)).toMatch(/7 aug\.? 2026/);
		// The row's own timestamp is still the relative message, not a second absolute date.
		const sub = host.querySelector('.sub')?.textContent ?? '';
		expect(sub).toContain('flow_history_ago_min');
		expect(sub).not.toContain('2026');
	});

	it('the rest of the row is still localized and still numeric-formatted for nl', async () => {
		// Guards against a fix that localizes the summary by breaking the line around it.
		await render([{ summary_code: 'flow_summary_manual_checkpoint', summary_params: null, source: 'manual' }]);
		const sub = host.querySelector('.sub')?.textContent ?? '';
		expect(sub).toContain('flow_history_nodes');
		expect(host.querySelector('.badge')?.textContent?.trim()).toBe('flow_history_source_manual');
		expect(host.querySelector('.ttl')?.textContent).toBe('flow_history_title');
	});
});
