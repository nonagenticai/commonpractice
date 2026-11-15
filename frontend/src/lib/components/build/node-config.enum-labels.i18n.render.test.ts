// @vitest-environment jsdom
//
// src/lib/components/build/node-config.enum-labels.i18n.render.test.ts — the /build Details pane shows
// words, not codes, for an enum input, and no "JSON" placeholder.
//
// Found on a live walk of prod in nl (2026-10-15): the "Rijen filteren" block's Vergelijking dropdown
// listed `eq neq gte lte contains`, and its Rijen input had the placeholder "JSON". The option VALUE
// must stay the code (the block reads it and saved flows hold it); only the shown text changes.
//
// Mutations this is built against: put `{opt}` back as the option text (the label assertions fail),
// or the literal 'JSON' back as the placeholder (the placeholder assertion fails).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BuilderStore } from '$lib/stores/builder.svelte';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = () => catalog[key];
	}
	return mod;
});
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'nl' } }));
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
import { fieldTypes } from '$lib/stores/field-types.svelte';
import { LABELLED_ENUM_VALUES } from '$lib/i18n/enum-option-label';

const NL: Record<string, string> = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8'));
const LOCALES = ['en', 'nl', 'de', 'fr', 'es', 'pl', 'ar', 'he'];

type Node = { id: string; data: Record<string, unknown> };

/** The shape of the seeded "Rijen filteren" block: a rows input, a column, a comparison enum. */
function filterNode(): Node {
	return {
		id: 'n1',
		data: {
			slug: 'filter-rows',
			label: 'Rijen filteren',
			kind: 'block',
			config: { op: 'gte' },
			descriptor: {
				inputs: {
					rows: { type: 'json', required: true },
					op: { type: 'enum', enum: ['eq', 'neq', 'gte', 'lte', 'contains', 'starts_with'] }
				}
			}
		}
	};
}

const updateConfig = vi.fn();
function storeWith(node: Node): BuilderStore {
	return {
		selectedNode: node,
		nodes: [node],
		isInputConnected: () => false,
		updateConfig,
		removeNode: vi.fn(),
		setLoopConfig: vi.fn(),
		assignToLoop: vi.fn(),
		removeFromLoop: vi.fn()
	} as unknown as BuilderStore;
}

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

beforeEach(() => {
	fieldTypes.allowed = false;
	fieldTypes.preference = false;
	vi.clearAllMocks();
	listAll.mockResolvedValue({ items: [], total: 0, truncated: false });
	listPaged.mockResolvedValue({ items: [], total: 0 });
	listMappings.mockResolvedValue([]);
	getDataset.mockResolvedValue({ columns: [], rows: [] });
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
});

async function render(): Promise<void> {
	app = mount(NodeConfigPanel, { target: host, props: { builder: storeWith(filterNode()) } }) as Record<string, unknown>;
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

function options(): HTMLOptionElement[] {
	return [...host.querySelectorAll<HTMLOptionElement>('[data-field-name="op"] select option')];
}

describe('enum inputs show labels, not codes', () => {
	it('each option shows the Dutch label and keeps the code as its value', async () => {
		await render();
		const opts = options().filter((o) => o.value !== '');
		expect(opts.map((o) => o.value)).toEqual(['eq', 'neq', 'gte', 'lte', 'contains', 'starts_with']);
		expect(opts.map((o) => o.textContent)).toEqual([
			'is gelijk aan',
			'is niet gelijk aan',
			'is ten minste',
			'is hoogstens',
			'bevat',
			// No catalog entry: the humanised value, never the raw code.
			'Starts with'
		]);
	});

	it('the stored value is selected and a change writes the CODE, not the label', async () => {
		await render();
		const select = host.querySelector<HTMLSelectElement>('[data-field-name="op"] select')!;
		expect(select.value).toBe('gte');
		select.value = 'lte';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		expect(updateConfig).toHaveBeenCalledWith('n1', 'op', 'lte');
	});

	it('the rows input has plain guidance, not "JSON"', async () => {
		await render();
		const input = host.querySelector<HTMLInputElement>('[data-field-name="rows"] input')!;
		expect(input).not.toBeNull();
		expect(input.placeholder).toBe(NL.nodecfg_value_ph);
		expect(input.placeholder).not.toMatch(/json/i);
	});

	it('every labelled value has a non-empty label in all 8 locales', () => {
		expect(LABELLED_ENUM_VALUES.length).toBeGreaterThanOrEqual(5);
		for (const loc of LOCALES) {
			const cat = JSON.parse(readFileSync(resolve(process.cwd(), `messages/${loc}.json`), 'utf8')) as Record<string, string>;
			for (const v of LABELLED_ENUM_VALUES) {
				expect(cat[`nodecfg_opt_${v}`], `${loc}: nodecfg_opt_${v}`).toBeTruthy();
			}
			expect(cat.nodecfg_value_ph, `${loc}: nodecfg_value_ph`).toBeTruthy();
		}
	});
});
