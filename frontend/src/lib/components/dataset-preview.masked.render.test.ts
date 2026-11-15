// @vitest-environment jsdom
//
// src/lib/components/dataset-preview.masked.render.test.ts — W8/P7: a column the reader may not see
// renders as "•••" with the "Hidden personal data" tooltip, never as the server's placeholder text.
// The backend blanks the values (backend/src/datasets/member-view.ts); this pins how they LOOK on
// the five screens that mount DatasetPreviewTable.
//
// Non-vacuity: every case asserts the visible cells positively (the shown column's real value AND
// the masked glyph), so an empty render cannot pass.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { DatasetColumn } from '$lib/types/datasets';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import DatasetPreviewTable from './DatasetPreviewTable.svelte';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

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

const columns: DatasetColumn[] = [
	{ name: 'claim_id', type: 'string' },
	{ name: 'holder', type: 'string' }
];
const rows = [{ claim_id: 'CLM-1', holder: '[redacted]' }];
const cells = () => [...host.querySelectorAll('tbody td')].map((n) => n.textContent?.trim());

describe('masked values in the sample-data preview', () => {
	it('a masked column renders "•••" with the hidden-personal-data tooltip', () => {
		app = mount(DatasetPreviewTable, { target: host, props: { columns, rows, maskedColumns: ['holder'] } });
		flushSync();
		expect(cells()).toEqual(['CLM-1', '•••']);
		const masked = host.querySelector('tbody .masked');
		expect(masked?.getAttribute('title')).toBe('dataset_preview_masked');
		expect(host.textContent).not.toContain('[redacted]');
	});

	it('without a masked list (a data manager, or an older backend) every value renders as sent', () => {
		app = mount(DatasetPreviewTable, {
			target: host,
			props: { columns, rows: [{ claim_id: 'CLM-1', holder: 'Anna de Vries' }] }
		});
		flushSync();
		expect(cells()).toEqual(['CLM-1', 'Anna de Vries']);
		expect(host.querySelector('.masked')).toBeNull();
	});
});

// ⛔ THE CALL SITES. The component can only draw "•••" for a list it is handed, and each of the five
// screens builds its own preview cache — dropping `maskedColumns` from one of them would show the
// server's placeholder text there and nothing would fail above. Source guard, house pattern
// (cp-tests-that-cannot-go-red): file non-empty first, then every mount passes the list.
describe('every screen that mounts the preview passes the masked list', () => {
	// `true` = the screen keeps its own preview cache, which must copy the field off the response.
	// /datasets holds the whole `DatasetDetail` response instead, so the field rides along.
	const SITES: Array<[string, boolean]> = [
		['src/routes/datasets/+page.svelte', false],
		['src/routes/submit/+page.svelte', true],
		['src/routes/challenges/[id]/+page.svelte', true],
		['src/lib/components/build/NodeConfigPanel.svelte', true],
		['src/lib/components/build/ChallengeDataPanel.svelte', true]
	];
	for (const [site, cached] of SITES) {
		it(site, () => {
			const src = readFileSync(resolve(process.cwd(), site), 'utf8');
			expect(src.length).toBeGreaterThan(1000);
			const mounts = src.split('<DatasetPreviewTable').slice(1).map((m) => m.slice(0, m.indexOf('/>')));
			expect(mounts.length).toBeGreaterThan(0);
			for (const m of mounts) expect(m).toContain('maskedColumns=');
			// …and the cache that feeds it keeps the field from the API response.
			if (cached) expect(src).toContain('maskedColumns: d.maskedColumns');
		});
	}
});
