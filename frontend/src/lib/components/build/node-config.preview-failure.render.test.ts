// @vitest-environment jsdom
//
// src/lib/components/build/node-config.preview-failure.render.test.ts — the /build inspector's
// inline dataset preview stops rendering a failure as "still loading".
//
// ⛔ THE DEFECT, AND IT IS THE FOURTH COPY OF ONE THIS REPO HAS ALREADY FIXED THREE TIMES.
// `loadPreview` ended in a bare `catch { /* leave un-previewed */ }`, and the table is behind
// `{#if preview}` — so a 500, a 403 or a dropped connection produced exactly the same pixels as a
// request still in flight: the picker, and then nothing. `/submit`
// (submit-page.failure-honesty.render.test.ts), `ChallengeDataPanel`
// (challenge-data.failure-honesty.render.test.ts) and `/challenges/[id]`
// (challenge-detail.preview-failure.render.test.ts) each closed this against this same component.
// The inspector was missed.
//
// ⛔ WHY IT MATTERS MORE HERE THAN ON THE OTHER THREE. Those three sit behind an explicit "Preview"
// toggle, so the reader has at least asked a question. This one loads automatically from the
// `$effect` the moment a dataset input is configured, and it is the panel where a builder decides
// which data a block reads. The silence is the default state, not a state they walked into.
//
// ⚠️ ASSERTS DUTCH WORDS, NOT KEY NAMES — same choice, same reason, as every sibling spec here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BuilderStore } from '$lib/stores/builder.svelte';
import type { AllDatasets } from '$lib/api/datasets';
import type { DatasetDetail, DatasetRow } from '$lib/types/datasets';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			catalog[key].replace(/\{(\w+)\}/g, (whole: string, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	return mod;
});
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'nl' } }));
// Which sentence a 403 resolves to is `error-message.ts`'s own subject. Flattened to "the caller's
// fallback wins", so these assertions are about WHETHER a failure is stated at all.
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

const { listAll, listPaged, getDataset, listMappings } = vi.hoisted(() => ({
	listAll: vi.fn(),
	listPaged: vi.fn(),
	getDataset: vi.fn(),
	listMappings: vi.fn()
}));
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { listAll, list: listPaged, get: getDataset, listMappings }
}));

import NodeConfigPanel from './NodeConfigPanel.svelte';

const SLUG = 'claims-2026';
/** `messages/nl.json` — the sentence the three sibling mount sites already render. */
const PREVIEW_FAILED_NL = 'Het voorbeeld van deze dataset kon niet worden geladen.';
const RETRY_NL = 'Opnieuw proberen';

function dataset(): DatasetRow {
	return {
		id: `id-${SLUG}`,
		slug: SLUG,
		name: 'Claims 2026',
		sourceType: 'csv',
		columns: [{ name: 'bedrag', type: 'number' }],
		rowCount: 12_480,
		sizeBytes: 512_000,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-05-20T00:00:00.000Z',
		updatedAt: '2026-05-20T00:00:00.000Z'
	} as DatasetRow;
}

function detail(): DatasetDetail {
	const d = dataset();
	return {
		...d,
		columns: [{ name: 'bedrag', type: 'number', pii: false }],
		rows: [{ bedrag: 1 }, { bedrag: 2 }],
		offset: 0,
		limit: 5
	} as DatasetDetail;
}

function allDatasets(items: DatasetRow[], extra: Partial<AllDatasets> = {}): AllDatasets {
	return { items, total: items.length, capped: false, ...extra };
}

/** A selected block whose one dataset input is already configured — that is what fires the fetch. */
function nodeBuilder(): BuilderStore {
	return {
		selectedNode: {
			id: 'n1',
			data: {
				slug: 'flag-claims',
				label: 'Markeer claims',
				kind: 'block',
				config: { rows: SLUG },
				descriptor: { inputs: { rows: { type: 'dataset', required: true } } }
			}
		},
		nodes: [],
		isInputConnected: () => false,
		updateConfig: vi.fn(),
		removeNode: vi.fn(),
		setLoopConfig: vi.fn(),
		assignToLoop: vi.fn(),
		removeFromLoop: vi.fn()
	} as unknown as BuilderStore;
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 16; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render() {
	listAll.mockResolvedValue(allDatasets([dataset()]));
	listMappings.mockResolvedValue({ mappings: [] });
	app = mount(NodeConfigPanel, { target: host, props: { builder: nodeBuilder() } }) as Record<
		string,
		unknown
	>;
	await settle();
}

/**
 * ⛔ THE ANTI-VACUITY GATE. Every "the failure is stated" and every "it is not stated" assertion
 * below is about one element inside the dataset field; on a panel that rendered no dataset field at
 * all, half of them pass for free and the other half fail for the wrong reason.
 */
function datasetField(): HTMLElement {
	const el = host.querySelector('[data-field-name="rows"]');
	expect(el, 'the dataset field never rendered — this case tests nothing').not.toBeNull();
	return el as HTMLElement;
}
const errorBox = () => datasetField().querySelector(`[data-testid="preview-error-${SLUG}"]`);
const previewTable = () => datasetField().querySelector('table.sample');

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [listAll, listPaged, getDataset, listMappings]) fn.mockReset();
});

describe('the /build inspector, when the inline dataset preview fails', () => {
	it('⛔ THE DEFECT: says the preview could not be loaded instead of rendering as in-flight', async () => {
		// REVERT THAT TURNS THIS RED: `catch { /* leave un-previewed */ }`. There is then no notice
		// and no table — the exact pixels of a request still running.
		getDataset.mockRejectedValue(new Error('Failed to fetch'));
		await render();

		expect(getDataset, 'the preview was never requested').toHaveBeenCalledWith(SLUG, { limit: 5 });
		const err = errorBox();
		expect(err, 'a failed preview is still indistinguishable from one still loading').not.toBeNull();
		expect(err!.textContent).toContain(PREVIEW_FAILED_NL);
		expect(err!.getAttribute('role')).toBe('alert');
		expect(previewTable(), 'a table rendered from a failed fetch').toBeNull();
	});

	it('⛔ …and offers a retry that really re-requests', async () => {
		// `loadPreview` writes no cache entry on failure, so its own `datasetPreviews[slug]` guard
		// cannot short-circuit the second attempt — which is what makes this control honest rather
		// than decorative. Red by omitting the button, or by adding a cache entry in the catch.
		getDataset.mockRejectedValue(new Error('Failed to fetch'));
		await render();
		const retry = errorBox()!.querySelector('button') as HTMLButtonElement | null;
		expect(retry, 'the failure is stated with no way to act on it').not.toBeNull();
		expect(retry!.textContent?.trim()).toBe(RETRY_NL);

		// ⚠️ A BASELINE, NOT A LITERAL — and the reason is worth knowing. The panel's `$effect`
		// reads `datasetMappings` (through `loadMappings`'s own guard), so when the mapping fetch
		// resolves the effect re-runs and `loadPreview` fires a SECOND time on a slug whose preview
		// failed. Measured: exactly 2 calls under a permanent failure, then it converges — the
		// mapping guard is satisfied and nothing writes again. That is pre-existing behaviour, not
		// something this change introduced (the old code made the same two calls), but pinning `2`
		// here would make this spec a hostage to it.
		const before = getDataset.mock.calls.length;
		getDataset.mockResolvedValue(detail());
		// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
		retry!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		expect(
			getDataset.mock.calls.length,
			'the retry did not reach the client'
		).toBeGreaterThan(before);
		expect(errorBox(), 'the notice survived a retry that succeeded').toBeNull();
		expect(previewTable(), 'the recovered preview did not render').not.toBeNull();
	});

	it('⚠️ A HEALTHY PREVIEW SHOWS NO NOTICE AT ALL — it is not unconditional', async () => {
		// The complement. "Render the error always" satisfies both cases above and would caption every
		// working preview in the builder with a failure.
		getDataset.mockResolvedValue(detail());
		await render();
		expect(errorBox(), 'a notice was shown for a preview that loaded').toBeNull();
		expect(previewTable(), 'the healthy preview did not render, so the contrast proves nothing')
			.not.toBeNull();
	});

	it('⚠️ AN IN-FLIGHT PREVIEW IS NOT A FAILURE EITHER', async () => {
		// The other complement, and the one that matters given what this fix is about: a request that
		// has simply not answered yet must NOT be captioned as broken. A promise that never settles is
		// that state held still.
		getDataset.mockReturnValue(new Promise(() => {}));
		await render();
		expect(errorBox(), 'a request still in flight was reported as failed').toBeNull();
		expect(previewTable()).toBeNull();
	});
});
