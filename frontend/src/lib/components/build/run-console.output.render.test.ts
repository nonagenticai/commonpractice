// @vitest-environment jsdom
//
// src/lib/components/build/run-console.output.render.test.ts — a member reads a step's output in
// words, and Details in their own language.
//
// ⛔ THE DEFECT (live member test run, nl). Each step row printed the runner's output preview as is:
// `{"rows":[{"id":"value-1",…`. Details mixed English and Dutch and named blocks by identifier:
// "run gestart · 2 blokken", "→ load-dataset bezig…", "[info] loaded dataset rows", "uitvoering ok".
// A member now reads "3 rijen" plus the first rows as a table, block names, no block log lines and
// no raw output; a developer and above (`showInternalErrors`) keeps all three under Details.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { TraceEvent } from '$lib/types/trace';
import { outputView, parsePreview, MAX_COLUMNS, MAX_ROWS } from './run-output';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')) as Record<string, unknown>;
	const fill = (text: string, params?: Record<string, unknown>) =>
		text.replace(/\{(\w+)\}/g, (whole: string, name: string) => {
			if (name === 'countNum' && params && 'count' in params) return String(params.count);
			return params && name in params ? String(params[name]) : whole;
		});
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		const v = catalog[key];
		mod[key] = (params?: Record<string, unknown>) => {
			if (typeof v === 'string') return fill(v, params);
			// A plural message: nl has only `one` and `other`.
			const match = (v as { match: Record<string, string> }[])[0].match;
			return fill(params?.count === 1 ? match['countPlural=one'] : match['countPlural=other'], params);
		};
	}
	return mod;
});
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'nl' } }));

import RunConsole from './RunConsole.svelte';

const R = 'run-1';
const noCost = { usd: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0 };
const ROWS = [
	{ id: 'value-1', name: 'Anna', amount: 12.5 },
	{ id: 'value-2', name: 'Bram', amount: 7 },
	{ id: 'value-3', name: 'Cees', amount: 1200 }
];
const ROWS_JSON = JSON.stringify({ rows: ROWS });
const BLOCK_LOG = 'loaded dataset rows';

/** The member's live run: a dataset block, then a block that writes a sentence. */
const EVENTS: TraceEvent[] = [
	{ type: 'run_start', runId: R, ts: 1, nodeCount: 2 },
	{ type: 'node_start', runId: R, ts: 2, nodeId: 'n1', slug: 'load-dataset' },
	{ type: 'log', runId: R, ts: 3, nodeId: 'n1', level: 'info', msg: BLOCK_LOG },
	{ type: 'node_success', runId: R, ts: 4, nodeId: 'n1', slug: 'load-dataset', durationMs: 40, cost: noCost, outputPreview: ROWS_JSON },
	{ type: 'node_start', runId: R, ts: 5, nodeId: 'n2', slug: 'summarise' },
	{ type: 'node_success', runId: R, ts: 6, nodeId: 'n2', slug: 'summarise', durationMs: 30, cost: noCost, outputPreview: '"Drie claims, totaal 1219,5"' },
	{ type: 'run_complete', runId: R, ts: 7, totalMs: 70, status: 'ok', totals: noCost }
] as TraceEvent[];

const NAMES: Record<string, string> = { n1: 'Dataset laden', n2: 'Samenvatten' };

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

function render(events: TraceEvent[], showInternalErrors: boolean) {
	app = mount(RunConsole, {
		target: host,
		props: {
			events,
			status: 'ok' as const,
			nodeCount: 2,
			stepName: (id: string, slug: string) => NAMES[id] ?? slug,
			showInternalErrors
		}
	});
	flushSync();
	expect(host.querySelectorAll('.steps .step').length, 'no step rows rendered — this case tests nothing').toBeGreaterThan(0);
}
const resultText = () => [...host.querySelectorAll('.result > :not(details)')].map((e) => e.textContent).join(' ');
const detailLines = () => [...host.querySelectorAll('details.trace .line')].map((e) => e.textContent ?? '');

describe('the Result panel, as a member', () => {
	it('⛔ a rows output reads as a row count and a table, not JSON', () => {
		render(EVENTS, false);
		const step = host.querySelectorAll('.steps .step')[0];
		expect(step.querySelector('.out-count')?.textContent).toBe('3 rijen');
		const table = step.querySelector('table.out-table');
		expect(table, 'no table under the step').not.toBeNull();
		expect([...table!.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['ID', 'Name', 'Amount']);
		const cells = [...table!.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
		expect(cells).toEqual([
			['value-1', 'Anna', '12,5'],
			['value-2', 'Bram', '7'],
			['value-3', 'Cees', '1.200']
		]);
		expect(resultText()).not.toContain('{');
		expect(resultText()).not.toContain('"rows"');
	});

	it('a text output reads as the text, without quotes', () => {
		render(EVENTS, false);
		const step = host.querySelectorAll('.steps .step')[1];
		expect(step.querySelector('.out-text')?.textContent).toBe('Drie claims, totaal 1219,5');
	});

	it('⛔ Details names blocks, drops block log lines and raw output, and is all Dutch', () => {
		render(EVENTS, false);
		const lines = detailLines();
		const all = lines.join('\n');
		for (const slug of ['load-dataset', 'summarise']) expect(all, `slug ${slug} shown to a member`).not.toContain(slug);
		expect(all).not.toContain('[info]');
		expect(all).not.toContain(BLOCK_LOG);
		expect(all).not.toContain('{');
		expect(all).toContain('Dataset laden');
		expect(all).toContain('Samenvatten');
		expect(lines[0]).toContain('uitvoering gestart · 2 blokken');
		expect(lines[lines.length - 1]).toContain('uitvoering geslaagd');
		expect(all).not.toMatch(/\brun\b|\bok\b/);
	});
});

describe('the Result panel, as a developer', () => {
	it('keeps identifiers, block log lines and the raw output under Details', () => {
		render(EVENTS, true);
		const all = detailLines().join('\n');
		expect(all).toContain('load-dataset');
		expect(all).toContain(`[info] ${BLOCK_LOG}`);
		expect(all).toContain(ROWS_JSON);
	});

	it('still reads the plain table in the Result view', () => {
		render(EVENTS, true);
		expect(host.querySelector('.steps .step table.out-table')).not.toBeNull();
		expect(resultText()).not.toContain('"rows"');
	});
});

describe('a cut preview', () => {
	// The runner cuts the JSON text at 2048 bytes and appends `…` (flow-executor `truncatePreview`).
	const many = Array.from({ length: 60 }, (_, i) => ({ id: `value-${i + 1}`, name: `Naam ${i + 1}`, note: 'x'.repeat(20) }));
	const cut = `${JSON.stringify({ rows: many }).slice(0, 2048)}…`;

	it('is repaired to its complete rows and counted as "at least"', () => {
		const parsed = parsePreview(cut);
		expect(parsed?.cut).toBe(true);
		const view = outputView(cut);
		expect(view.table?.atLeast).toBe(true);
		expect(view.table!.count).toBeGreaterThan(MAX_ROWS);
		expect(view.table!.count).toBeLessThan(60);
		expect(view.table!.rows).toHaveLength(MAX_ROWS);
	});

	it('renders for a member as rows and a table, never as JSON', () => {
		const events = EVENTS.map((ev) => (ev.type === 'node_success' && ev.nodeId === 'n1' ? { ...ev, outputPreview: cut } : ev));
		render(events as TraceEvent[], false);
		const step = host.querySelectorAll('.steps .step')[0];
		expect(step.querySelector('.out-count')?.textContent).toMatch(/^Rijen: ten minste \d+$/);
		expect(step.querySelectorAll('tbody tr')).toHaveLength(MAX_ROWS);
		expect(resultText()).not.toContain('{');
	});
});

describe('a rows array the cut emptied', () => {
	it('reads "Rijen niet volledig zichtbaar" next to the other fields', () => {
		const events = EVENTS.map((ev) =>
			ev.type === 'node_success' && ev.nodeId === 'n1' ? { ...ev, outputPreview: '{"count":3,"rows":[{"id":"va…' } : ev
		);
		render(events as TraceEvent[], false);
		const step = host.querySelectorAll('.steps .step')[0];
		const lines = [...step.querySelectorAll('.out-field')].map((f) => [f.querySelector('dt')?.textContent, f.querySelector('dd')?.textContent]);
		expect(lines).toEqual([
			['Count', '3'],
			['Rows', 'Rijen niet volledig zichtbaar']
		]);
	});
});

describe('outputView', () => {
	it('an object reads as label → value lines', () => {
		const v = outputView(JSON.stringify({ total: 3, approved: true, owner: { name: 'Anna' } }));
		expect(v.table).toBeNull();
		expect(v.fields.map((f) => [f.key, f.value.kind === 'text' ? f.value.text : f.value.kind])).toEqual([
			['total', '3'],
			['approved', 'true'],
			['owner', 'Anna']
		]);
	});

	it(`shows at most ${MAX_COLUMNS} columns and counts the rest`, () => {
		const row = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`c${i}`, i]));
		const v = outputView(JSON.stringify([row]));
		expect(v.table?.columns).toHaveLength(MAX_COLUMNS);
		expect(v.table?.hiddenColumns).toBe(3);
	});

	it('a cut text that cannot be repaired shows its words, never JSON', () => {
		expect(outputView('{"a…').text).toBe('a…');
	});
});
