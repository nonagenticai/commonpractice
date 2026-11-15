// @vitest-environment jsdom
//
// src/routes/challenges/[id]/challenge-detail.information.render.test.ts — W8 "Information involved"
// on the challenge page: plain cards (name + description) from GET /api/challenges/:id/entities, and
// a "Sample data" row that no longer prints the internal dataset slug.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ChallengeDetail, ChallengeInformation } from '$lib/types/challenges';

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
vi.mock('$app/state', () => ({
	page: { params: { id: 'ch-info-1' }, url: new URL('http://localhost/challenges/ch-info-1') }
}));
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { getChallenge, getComments, currentCycle, getEntities, putEntities, entityOptions, suggestEntities } = vi.hoisted(() => ({
	getChallenge: vi.fn(),
	getComments: vi.fn(),
	currentCycle: vi.fn(),
	getEntities: vi.fn(),
	putEntities: vi.fn(),
	entityOptions: vi.fn(),
	suggestEntities: vi.fn()
}));
vi.mock('$lib/api/challenges', () => ({
	ApiError: class ApiError extends Error {},
	challengesApi: {
		get: getChallenge,
		comments: getComments,
		entities: getEntities,
		updateEntities: putEntities,
		entityOptions,
		suggestEntities,
		vote: vi.fn(),
		unvote: vi.fn(),
		updateDatasets: vi.fn(),
		postComment: vi.fn()
	}
}));
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: currentCycle } }));
vi.mock('$lib/api/datasets', () => ({ datasetsApi: { list: vi.fn(), get: vi.fn(), listAll: vi.fn() } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

const SLUG = 'claims-2026-internal';

function detail(over: Partial<ChallengeDetail> = {}): ChallengeDetail {
	return {
		id: 'ch-info-1',
		code: 'CH-1',
		title: 'Claims intake takes four days',
		description: 'A description.',
		businessImpact: '',
		workArea: 'Claims',
		status: 'voting',
		week: '2026-W42',
		cycleClosed: false,
		tags: [],
		metrics: {},
		votesCount: 1,
		hasVoted: false,
		submitter: { name: 'Sam Submitter', initials: 'SS' },
		createdAt: '2026-10-12T00:00:00.000Z',
		commentCount: 0,
		datasets: [{ slug: SLUG, name: 'Claims 2026', note: '', rowCount: 12, columns: [] }],
		canEditDatasets: false,
		involves: [],
		solutions: [],
		similar: [],
		...over
	};
}

const INFO: ChallengeInformation = {
	items: [
		{ id: 'e-1', label: 'Claim', description: 'A request for payment' },
		{ id: 'e-2', label: 'Policy', description: null }
	],
	canEdit: false
};

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

async function open(info: ChallengeInformation | Error, over: Partial<ChallengeDetail> = {}) {
	getChallenge.mockResolvedValue(detail(over));
	getComments.mockResolvedValue({ items: [], total: 0 });
	currentCycle.mockResolvedValue(null);
	if (info instanceof Error) getEntities.mockRejectedValue(info);
	else getEntities.mockResolvedValue(info);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	// Anti-vacuity: the page itself rendered.
	expect(host.querySelector('h1')?.textContent).toBe('Claims intake takes four days');
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [getChallenge, getComments, currentCycle, getEntities, putEntities, entityOptions, suggestEntities]) fn.mockReset();
});

const card = () => host.querySelector('[data-testid="information-card"]');

describe('/challenges/[id] — Information involved', () => {
	it('shows one card per type of information, with its name and description', async () => {
		await open(INFO);
		expect(getEntities).toHaveBeenCalledWith('ch-info-1');
		expect(card()?.querySelector('h2')?.textContent).toBe('challenge_info_title');
		const names = [...host.querySelectorAll('.info-name')].map((n) => n.textContent);
		expect(names).toEqual(['Claim', 'Policy']);
		const descs = [...host.querySelectorAll('.info-desc')].map((n) => n.textContent);
		expect(descs).toEqual(['A request for payment']);
	});

	it('with nothing linked and no edit right, the card is not shown at all', async () => {
		await open({ items: [], canEdit: false });
		expect(card()).toBeNull();
	});

	it('with nothing linked, the creator sees the card with a one-line empty state', async () => {
		await open({ items: [], canEdit: true });
		expect(card()?.querySelector('.empty')?.textContent).toBe('challenge_info_none');
	});

	it('a failed load says so in the card and leaves the page in place', async () => {
		await open(new Error('boom'));
		expect(host.textContent).toContain('challenge_info_load_failed');
		expect(host.querySelector('h1')).not.toBeNull();
	});

	it('the sample-data row shows the name and row count, never the internal slug', async () => {
		await open(INFO);
		const row = host.querySelector(`.ds-list li[data-slug="${SLUG}"]`);
		expect(row?.querySelector('.ds-name')?.textContent).toBe('Claims 2026');
		expect(row?.querySelector('.ds-meta')?.textContent).toContain('12');
		expect(row?.textContent).not.toContain(SLUG);
	});
});

describe('/challenges/[id] — editing the information links (W8/P2)', () => {
	const OPTIONS = [
		{ id: 'e-1', label: 'Claim', description: 'A request for payment', synonyms: [] },
		{ id: 'e-2', label: 'Policy', description: null, synonyms: ['contract'] },
		{ id: 'e-3', label: 'Customer', description: null, synonyms: [] }
	];

	it('a reader without the edit right gets no edit control', async () => {
		await open({ ...INFO, canEdit: false });
		expect(card()).not.toBeNull();
		expect(host.querySelector('[data-testid="information-edit"]')).toBeNull();
	});

	it('the creator edits: options follow the work area, direct links are pre-ticked, save sends the new set', async () => {
		await open({
			items: [
				{ id: 'e-1', label: 'Claim', description: null, linked: true },
				{ id: 'e-2', label: 'Policy', description: null, linked: false }
			],
			canEdit: true
		});
		entityOptions.mockResolvedValue({ items: OPTIONS });
		(host.querySelector('[data-testid="information-edit"]') as HTMLButtonElement).click();
		await settle();
		expect(entityOptions).toHaveBeenCalledWith('Claims');
		const boxes = [...host.querySelectorAll('.options input[type="checkbox"]')] as HTMLInputElement[];
		expect(boxes.map((b) => b.checked)).toEqual([true, false, false]);

		// Tick "Customer".
		boxes[2]!.checked = true;
		boxes[2]!.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		putEntities.mockResolvedValue({
			items: [
				{ id: 'e-1', label: 'Claim', description: null, linked: true },
				{ id: 'e-3', label: 'Customer', description: null, linked: true }
			],
			canEdit: true
		});
		(host.querySelector('[data-testid="information-save"]') as HTMLButtonElement).click();
		await settle();
		expect(putEntities).toHaveBeenCalledWith('ch-info-1', ['e-1', 'e-3']);
		expect([...host.querySelectorAll('.info-name')].map((n) => n.textContent)).toEqual(['Claim', 'Customer']);
	});

	it('the search narrows the options by name or synonym', async () => {
		await open({ items: [], canEdit: true });
		entityOptions.mockResolvedValue({ items: OPTIONS });
		(host.querySelector('[data-testid="information-edit"]') as HTMLButtonElement).click();
		await settle();
		const search = host.querySelector('input.search') as HTMLInputElement;
		search.value = 'contract';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		expect([...host.querySelectorAll('.opt-name')].map((n) => n.textContent)).toEqual(['Policy']);
	});
});
