// @vitest-environment jsdom
//
// src/lib/components/build/disabled-control-reason.render.test.ts — two disabled controls whose
// only explanation could never render.
//
// ⛔ THE DEFECT, AND IT IS THE SAME ONE TWICE:
//
//     ChallengeDataPanel.svelte   <button disabled={!datasetInput}
//                                          title={datasetInput ? '' : m.build_data_select_node_first()}>
//     routes/ontology/+page.svelte <button disabled={deriveBusy || samples.length === 0}
//                                          title={samples.length === 0 ? m.…no_sample() : ''}>
//
// A DISABLED BUTTON FIRES NO POINTER EVENTS, so a `title` on the button itself never surfaces a
// tooltip. Both sentences were translated into eight languages, shipped, and unreachable by every
// reader by every means — they existed only in the source. `VoteButton.svelte` states this rule for
// this codebase in writing ("The reason lives on a WRAPPER, not on the button: a disabled button
// fires no pointer events, so a `title` on it never surfaces a tooltip"); both sites predate it.
//
// ⛔ AND THE WRAPPER ALONE IS ONLY HALF THE FIX — the same paragraph says so: "a tooltip alone is
// not reachable by keyboard", so the fact must ALSO be on screen. Both halves are asserted here,
// because moving the `title` and stopping is a fix that a mouse user can see and nobody else can.
//
// ⚠️ ONE FILE FOR TWO COMPONENTS. They are one defect with one house rule and one repair; splitting
// them would duplicate the rule's statement and let a future edit fix one site while the other's
// spec sits in a directory nobody opens.
//
// ⚠️ ASSERTS DUTCH WORDS, NOT KEY NAMES — same choice as the sibling specs here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BuilderStore } from '$lib/stores/builder.svelte';
import type { AllDatasets } from '$lib/api/datasets';
import type { DatasetRow } from '$lib/types/datasets';

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
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

const { listAll, listPaged, getDataset } = vi.hoisted(() => ({
	listAll: vi.fn(),
	listPaged: vi.fn(),
	getDataset: vi.fn()
}));
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { listAll, list: listPaged, get: getDataset, listMappings: vi.fn() }
}));

import ChallengeDataPanel from './ChallengeDataPanel.svelte';

/** `messages/nl.json` — the sentence that could never reach a reader. */
const SELECT_NODE_NL = 'Selecteer eerst een blok';
/** …and what it says when a block IS selected but takes no dataset. */
const NO_DATASET_NL = 'Dit blok gebruikt geen voorbeelddata';

function dataset(slug: string, name: string): DatasetRow {
	return {
		id: `id-${slug}`,
		slug,
		name,
		sourceType: 'csv',
		columns: [{ name: 'bedrag', type: 'number' }],
		rowCount: 42,
		sizeBytes: 1024,
		status: 'ready',
		sandboxId: null,
		createdAt: '2026-05-20T00:00:00.000Z',
		updatedAt: '2026-05-20T00:00:00.000Z'
	} as DatasetRow;
}

function allDatasets(items: DatasetRow[], extra: Partial<AllDatasets> = {}): AllDatasets {
	return { items, total: items.length, capped: false, ...extra };
}

/**
 * A builder in browse mode. `selected` decides whether a node with a dataset-typed input is picked
 * on the canvas — which is the ONLY thing that opens this gate.
 */
function browseBuilder(selected: boolean): BuilderStore {
	const node = {
		id: 'n1',
		data: {
			slug: 'flag-claims',
			label: 'Markeer claims',
			kind: 'block',
			config: {},
			descriptor: { inputs: { rows: { type: 'dataset', required: true } } }
		}
	};
	return {
		challengeContext: null,
		selectedNode: selected ? node : null,
		nodes: selected ? [node] : [],
		isInputConnected: () => false,
		updateConfig: vi.fn()
	} as unknown as BuilderStore;
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function render(selected: boolean) {
	listAll.mockResolvedValue(allDatasets([dataset('claims-2026', 'Claims 2026')]));
	app = mount(ChallengeDataPanel, {
		target: host,
		props: { builder: browseBuilder(selected), onClose: () => {} }
	}) as Record<string, unknown>;
	await settle();
}

/**
 * ⛔ THE ANTI-VACUITY GATE. "The button carries no title" is true of a panel that rendered no
 * button. Nothing is asserted until the Use control is proved on screen.
 */
function useButton(): HTMLButtonElement {
	const btn = [...host.querySelectorAll('button.dp-use')][0] as HTMLButtonElement | undefined;
	expect(btn, 'the Use control never rendered — this case tests nothing').toBeTruthy();
	return btn!;
}
const gateLine = () => host.querySelector('[data-testid="use-gate"]');

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [listAll, listPaged, getDataset]) fn.mockReset();
});

describe('ChallengeDataPanel — "Gebruiken" with no node selected', () => {
	it('⛔ THE DEFECT: the reason is on a WRAPPER, because the button cannot fire a tooltip', async () => {
		// REVERT THAT TURNS THIS RED: put `title=` back on the `<button>`. A disabled button fires no
		// pointer events, so that title is unreachable — which is what makes this an assertion about
		// the WRAPPER rather than about the string existing somewhere.
		await render(false);
		const btn = useButton();
		expect(btn.disabled, 'the control is not actually gated, so the reason is moot').toBe(true);

		const wrap = btn.closest('.gate-wrap');
		expect(wrap, 'the gated control has no wrapper to carry its reason').not.toBeNull();
		expect(wrap!.getAttribute('title')).toBe(SELECT_NODE_NL);
		expect(
			btn.getAttribute('title'),
			'the reason went back onto the disabled button, where it can never surface'
		).toBeNull();
	});

	it('⛔ …AND IT IS ON SCREEN, because a tooltip is not reachable by keyboard', async () => {
		// The half that a wrapper-only fix leaves out. VoteButton's own note: "It is a supplement in
		// any case — the same fact is always on screen next to it … because a tooltip alone is not
		// reachable by keyboard."
		await render(false);
		const line = gateLine();
		expect(line, 'the reason is a tooltip and nothing else').not.toBeNull();
		expect(line!.textContent).toContain(SELECT_NODE_NL);
		expect(line!.getAttribute('role'), 'nothing failed — this is a gate, not an alert').toBe('status');
	});

	it('⛔ WITH A NODE SELECTED THE CONTROL IS LIVE AND NOTHING IS EXPLAINED AWAY', async () => {
		// The complement. An unconditional notice, or an always-disabled button, satisfies both cases
		// above and would make the panel's whole purpose unreachable.
		await render(true);
		expect(useButton().disabled, 'the Use control stayed inert with a node selected').toBe(false);
		expect(gateLine(), 'a gate that is open was still explained').toBeNull();
		expect(
			useButton().closest('.gate-wrap')!.getAttribute('title'),
			'an open gate still carries a reason'
		).toBeNull();
	});

	it('⚠️ the reason is stated ONCE, not once per dataset row', async () => {
		// It is one fact about the canvas selection, not about any dataset. Three rows must not
		// produce three copies of the same sentence stacked above each other.
		listAll.mockResolvedValue(
			allDatasets([
				dataset('a-2026', 'A 2026'),
				dataset('b-2026', 'B 2026'),
				dataset('c-2026', 'C 2026')
			])
		);
		app = mount(ChallengeDataPanel, {
			target: host,
			props: { builder: browseBuilder(false), onClose: () => {} }
		}) as Record<string, unknown>;
		await settle();

		expect(host.querySelectorAll('button.dp-use'), 'the fixture rendered the wrong row count')
			.toHaveLength(3);
		expect(host.querySelectorAll('[data-testid="use-gate"]')).toHaveLength(1);
	});
});

describe('ChallengeDataPanel — a block is selected, but it takes no dataset', () => {
	function noDatasetBuilder(): BuilderStore {
		const node = {
			id: 'n2',
			data: {
				slug: 'summarise',
				label: 'Samenvatten',
				kind: 'block',
				config: {},
				descriptor: { inputs: { text: { type: 'string', required: true } } }
			}
		};
		return {
			challengeContext: null,
			selectedNode: node,
			nodes: [node],
			isInputConnected: () => false,
			updateConfig: vi.fn()
		} as unknown as BuilderStore;
	}

	it('⛔ says the block uses no sample data — not "select a block first"', async () => {
		// REVERT THAT TURNS THIS RED: `{m.build_data_select_node_first()}` back in the gate line. The
		// reader has a block selected and is told to select one (live walk, nl).
		listAll.mockResolvedValue(allDatasets([dataset('claims-2026', 'Claims 2026')]));
		app = mount(ChallengeDataPanel, {
			target: host,
			props: { builder: noDatasetBuilder(), onClose: () => {} }
		}) as Record<string, unknown>;
		await settle();
		expect(useButton().disabled, 'a block with no dataset input cannot take one').toBe(true);
		expect(gateLine()!.textContent).toContain(NO_DATASET_NL);
		expect(gateLine()!.textContent).not.toContain(SELECT_NODE_NL);
		expect(useButton().closest('.gate-wrap')!.getAttribute('title')).toBe(NO_DATASET_NL);
	});
});
