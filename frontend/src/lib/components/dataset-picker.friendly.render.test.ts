// @vitest-environment jsdom
//
// src/lib/components/dataset-picker.friendly.render.test.ts — W8/F3: the dataset picker on /submit
// (multi-select) and in /build (single-select) names each dataset by its friendly name and row count.
// The slug is an internal key: it stays on `data-slug` for tests and never reaches the visible text.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

vi.mock('$lib/paraglide/messages', () => ({ connectors_rows_word: () => 'rows' }));

import DatasetPicker from './DatasetPicker.svelte';
import type { DatasetRow } from '$lib/types/datasets';

const DS = {
	id: 'd1',
	slug: 'zz-claims-2026-internal',
	name: 'Claims April',
	rowCount: 12480
} as unknown as DatasetRow;

let app: Record<string, unknown> | null = null;
let host: HTMLElement;

afterEach(() => {
	if (app) unmount(app);
	app = null;
	host?.remove();
});

function render(multiple: boolean) {
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(DatasetPicker, { target: host, props: { datasets: [DS], multiple, onchange: () => {} } }) as Record<string, unknown>;
	flushSync();
}

describe('DatasetPicker shows names, not slugs (W8/F3)', () => {
	it('multi-select: name + row count; the slug only on data-slug', () => {
		render(true);
		const row = host.querySelector(`.picker-item[data-slug="${DS.slug}"]`);
		expect(row, 'no row addressable by data-slug').toBeTruthy();
		expect(row!.textContent).toContain('Claims April');
		expect(row!.textContent).toMatch(/12[,.  ]?480 rows/);
		expect(host.textContent).not.toContain(DS.slug);
	});

	it('single-select: the option reads name + row count; the slug is only its value', () => {
		render(false);
		const opt = host.querySelector(`option[data-slug="${DS.slug}"]`) as HTMLOptionElement | null;
		expect(opt).toBeTruthy();
		expect(opt!.value).toBe(DS.slug);
		expect(opt!.textContent).toContain('Claims April');
		expect(opt!.textContent).toContain('rows');
		expect(host.textContent).not.toContain(DS.slug);
	});
});
