// @vitest-environment jsdom
//
// src/lib/components/build/challenge-data.sample-test.render.test.ts — W8/P4 "Test with this
// challenge's sample data" in the /build data panel.
//
// What a member sees after the one-click test: which step read which sample data, each finding as a
// plain sentence ("Amount is not a number in 3 rows.") under the step's name, and the raw
// `dataset.column → attribute` reference ONLY behind "Details". With nothing linked, the prompt to
// link sample data — and the link itself only for a reader who may link (creator / admin, W8/F1).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BuilderStore, ChallengeContext } from '$lib/stores/builder.svelte';
import type { SampleTestView } from './sample-test';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	const fill = (text: string, params?: Record<string, unknown>) =>
		text.replace(/\{(\w+)\}/g, (whole: string, name: string) => {
			if (name === 'countNum' && params && 'count' in params) return String(params.count);
			return params && name in params ? String(params[name]) : whole;
		});
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		const v = catalog[key];
		mod[key] = (params?: Record<string, unknown>) => {
			if (typeof v === 'string') return fill(v, params);
			// A plural message: pick `one` for 1, else `other` — enough for English.
			const match = (v as Array<{ match: Record<string, string> }>)[0]!.match;
			return fill(params?.count === 1 ? match['countPlural=one']! : match['countPlural=other']!, params);
		};
	}
	return mod;
});
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'en' } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
vi.mock('$lib/api/datasets', () => ({ datasetsApi: { listAll: vi.fn(), list: vi.fn(), get: vi.fn() } }));

import ChallengeDataPanel from './ChallengeDataPanel.svelte';

const SLUG = 'zz-claims-internal-2026';

function ctx(canEditDatasets: boolean, withData = true): ChallengeContext {
	return {
		id: 'ch-1',
		title: 'Claims wait four days',
		datasets: withData ? [{ slug: SLUG, name: 'Claims April', rowCount: 3, note: '', columns: [] } as never] : [],
		involves: [],
		canEditDatasets
	};
}

function builder(c: ChallengeContext): BuilderStore {
	return {
		challengeContext: c,
		selectedNode: null,
		readOnly: false,
		nodes: [{ id: 'n1', data: { slug: 'read-claims', label: 'Load claims', kind: 'block', config: { source: SLUG } } }],
		updateConfig: vi.fn()
	} as unknown as BuilderStore;
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
});

function render(c: ChallengeContext, sample: SampleTestView | null, extra: Record<string, unknown> = {}) {
	app = mount(ChallengeDataPanel, {
		target: host,
		props: { builder: builder(c), onClose: () => {}, sample, onSampleTest: vi.fn(), onAddBlock: vi.fn(), ...extra }
	}) as Record<string, unknown>;
	flushSync();
}

const FINDING = {
	rule: 'type_mismatch',
	dataset: SLUG,
	column: 'amt_col',
	attribute: 'claimAmount',
	message: 'Column amt_col has 3 values…',
	count: 3,
	expected: 'number'
};

const nodeStart = { type: 'node_start', runId: 'r1', ts: 1, nodeId: 'n1', slug: 'read-claims' } as const;
const nodeOk = {
	type: 'node_success', runId: 'r1', ts: 2, nodeId: 'n1', slug: 'read-claims', durationMs: 5,
	cost: { llmCalls: 0, tokensIn: 0, tokensOut: 0, usd: 0 }, outputPreview: '{}'
} as never;
const nodeFail = {
	type: 'node_error', runId: 'r1', ts: 2, nodeId: 'n1', slug: 'read-claims', durationMs: 5,
	error: "'amount' must be a finite number", kind: 'validation', rule: 'field_must_be_number', detail: { field: 'amount' }
} as never;
const complete = (status: 'ok' | 'failed') =>
	({ type: 'run_complete', runId: 'r1', ts: 3, totalMs: 9, status, totals: { llmCalls: 0, tokensIn: 0, tokensOut: 0, usd: 0 } }) as never;

describe('ChallengeDataPanel — sample test (W8/P4)', () => {
	it('the button runs the test', () => {
		const onSampleTest = vi.fn();
		render(ctx(false), null, { onSampleTest });
		const btn = host.querySelector('[data-testid="sample-test-run"]') as HTMLButtonElement;
		expect(btn.textContent).toContain('Test with this challenge’s sample data');
		btn.click();
		expect(onSampleTest).toHaveBeenCalledTimes(1);
	});

	it('results read as plain sentences per step; the raw reference is only behind Details', () => {
		render(ctx(false), {
			state: 'done',
			binding: { nodeId: 'n1', input: 'source', slug: SLUG, source: 'challenge' },
			findings: [FINDING]
		});
		expect(host.querySelector('[data-testid="sample-used"]')!.textContent).toBe('Tested with “Claims April” in step “Load claims”.');
		const list = host.querySelector('[data-testid="sample-findings"]')!;
		expect(list.textContent).toContain('Load claims');
		expect(list.textContent).toContain('Claim amount is not a number in 3 rows.');
		// No keys outside "Details".
		expect(list.textContent).not.toContain(SLUG);
		expect(list.textContent).not.toContain('amt_col');
		const details = host.querySelector('[data-testid="sample-details"]')!;
		expect(details.tagName).toBe('DETAILS');
		expect(details.textContent).toContain(`${SLUG}.amt_col → claimAmount`);
	});

	it('a clean test says so — once the run has FINISHED ok', () => {
		render(ctx(false), { state: 'done', binding: null, findings: [], runId: 'r1' }, {
			sampleRun: { runId: 'r1', events: [nodeStart, nodeOk, complete('ok')], active: false }
		});
		expect(host.querySelector('[data-testid="sample-ok"]')!.textContent).toBe('The sample data matches what each step expects.');
		expect(host.querySelector('[data-testid="sample-failed"]')).toBeNull();
	});

	// ⛔ THE DEFECT (live walk 2026-10-15): the success line rendered as soon as the start request
	// answered with no findings — above a run whose step had failed "'amount' must be a number".
	it('a step that FAILS shows the plain-language failure under the step name — never the success line', () => {
		render(ctx(false), { state: 'done', binding: { nodeId: 'n1', input: 'source', slug: SLUG, source: 'challenge' }, findings: [], runId: 'r1' }, {
			sampleRun: { runId: 'r1', events: [nodeStart, nodeFail, complete('failed')], active: false }
		});
		expect(host.querySelector('[data-testid="sample-ok"]')).toBeNull();
		expect(host.querySelector('[data-testid="sample-failed"]')!.textContent).toBe('The test with the sample data did not pass:');
		const list = host.querySelector('[data-testid="sample-failures"]')!;
		expect(list.textContent).toContain('Load claims');
		expect(list.textContent).toContain('amount');
		expect(list.textContent).not.toContain('field_must_be_number');
	});

	it('while the run is still going: "Testing…", no verdict either way', () => {
		render(ctx(false), { state: 'done', binding: null, findings: [], runId: 'r1' }, {
			sampleRun: { runId: 'r1', events: [nodeStart], active: true }
		});
		expect(host.querySelector('[data-testid="sample-ok"]')).toBeNull();
		expect(host.querySelector('[data-testid="sample-failed"]')).toBeNull();
		expect((host.querySelector('[data-testid="sample-test-run"]') as HTMLButtonElement).textContent).toContain('Testing…');
	});

	it('a trace of ANOTHER run (or none) gives no verdict — the success line is never assumed', () => {
		render(ctx(false), { state: 'done', binding: null, findings: [], runId: 'r1' }, {
			sampleRun: { runId: 'r2', events: [nodeStart, nodeOk, complete('ok')], active: false }
		});
		expect(host.querySelector('[data-testid="sample-ok"]')).toBeNull();
		unmount(app!);
		app = null;
		render(ctx(false), { state: 'done', binding: null, findings: [] });
		expect(host.querySelector('[data-testid="sample-ok"]')).toBeNull();
	});

	it('nothing linked: the prompt, and the link only for a reader who may link', () => {
		render(ctx(true), { state: 'none_linked' });
		const note = host.querySelector('[data-testid="sample-none-linked"]')!;
		expect(note.textContent).toContain('No sample data is linked to this challenge.');
		expect((host.querySelector('[data-testid="sample-link"]') as HTMLAnchorElement).getAttribute('href')).toBe('/challenges/ch-1');
		unmount(app!);
		app = null;
		render(ctx(false), { state: 'none_linked' });
		expect(host.querySelector('[data-testid="sample-none-linked"]')).toBeTruthy();
		expect(host.querySelector('[data-testid="sample-link"]')).toBeNull();
	});

	it('no step reads data: offers the data block a developer already derived, by name', () => {
		const onAddBlock = vi.fn();
		render(ctx(false), { state: 'no_input', dataBlock: { slug: 'data-claim', name: 'Claim data' } }, { onAddBlock });
		expect(host.querySelector('[data-testid="sample-no-input"]')!.textContent).toBe('Add a step that reads data, then test again.');
		const add = host.querySelector('[data-testid="sample-add-block"]') as HTMLButtonElement;
		expect(add.textContent).toContain('Add “Claim data”');
		add.click();
		expect(onAddBlock).toHaveBeenCalledWith('data-claim');
	});

	it('the empty challenge list links to the challenge only for a reader who may link', () => {
		render(ctx(true, false), null);
		expect(host.querySelector('[data-testid="empty-link"]')).toBeTruthy();
		unmount(app!);
		app = null;
		render(ctx(false, false), null);
		expect(host.querySelector('[data-testid="empty-link"]')).toBeNull();
	});
});
