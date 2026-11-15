// @vitest-environment jsdom
//
// src/routes/submit/submit-page.information.render.test.ts — W8 "Information involved" on /submit:
// the picker offers the workspace's types of information for the chosen work area (P2) and the
// chosen ids travel as `entities` on the create call.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

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
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const { listAll, createChallenge, entityOptions, suggestEntities } = vi.hoisted(() => ({
	listAll: vi.fn(),
	createChallenge: vi.fn(),
	entityOptions: vi.fn(),
	suggestEntities: vi.fn()
}));
vi.mock('$lib/api/datasets', () => ({ datasetsApi: { list: vi.fn(), listAll, get: vi.fn() } }));
vi.mock('$lib/api/challenges', () => ({
	ApiError: class ApiError extends Error {},
	challengesApi: { create: createChallenge, entityOptions, suggestEntities }
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

const CLAIMS = [
	{ id: 'e-1', label: 'Claim', description: 'A request for payment', synonyms: [] },
	{ id: 'e-2', label: 'Policy', description: null, synonyms: [] }
];
const SALES = [{ id: 'e-9', label: 'Lead', description: null, synonyms: [] }];

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** The reader picks a work area — the form no longer picks one for them. */
async function pickArea(area: string) {
	const select = host.querySelector('#domain') as HTMLSelectElement;
	select.value = area;
	select.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
}

async function open(area: string | null = 'Claims') {
	listAll.mockResolvedValue({ items: [], total: 0, capped: false });
	entityOptions.mockImplementation(async (a: string) => ({ items: a === 'Sales' ? SALES : CLAIMS }));
	createChallenge.mockResolvedValue({ id: 'new-1' });
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	expect(host.querySelector('[data-testid="submit-information"]'), 'the field never rendered').not.toBeNull();
	if (area) await pickArea(area);
}

function fillRequired() {
	type('#title', 'T');
	type('#frustration', 'D');
	const ack = host.querySelector('.ack input') as HTMLInputElement;
	ack.checked = true;
	ack.dispatchEvent(new Event('change', { bubbles: true }));
}

const field = () => host.querySelector('[data-testid="submit-information"]') as HTMLElement;
const optionNames = () => [...field().querySelectorAll('.opt-name')].map((n) => n.textContent);

function type(sel: string, value: string) {
	const el = host.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement;
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [listAll, createChallenge, entityOptions, suggestEntities]) fn.mockReset();
});

// ⛔ A brand-new org's first challenge form came up as "Schadeclaims" — the demo insurer's
// department — without the reader choosing it (prod walk 2026-10-16). The form now starts with no
// work area: nothing is asked of the server for one, and Submit / Suggest wait for the reader.
describe('/submit — no preselected work area', () => {
	it('starts empty: placeholder selected, no options request, Submit and Suggest disabled until a pick', async () => {
		await open(null);
		const select = host.querySelector('#domain') as HTMLSelectElement;
		expect(select.value).toBe('');
		expect(select.selectedOptions[0]!.textContent!.trim()).toBe('submit_field_domain_placeholder');
		expect(select.required).toBe(true);
		expect(entityOptions).not.toHaveBeenCalled();
		expect(host.querySelector('.pv-meta')!.textContent).not.toContain('domain_claims');

		fillRequired();
		await settle();
		const submitBtn = host.querySelector('button[type="submit"]') as HTMLButtonElement;
		expect(submitBtn.disabled, 'Submit with no work area').toBe(true);
		expect((host.querySelector('[data-testid="info-suggest"]') as HTMLButtonElement).disabled).toBe(true);
		(host.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(createChallenge).not.toHaveBeenCalled();

		await pickArea('Sales');
		expect(entityOptions).toHaveBeenCalledWith('Sales');
		expect(submitBtn.disabled).toBe(false);
		(host.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(createChallenge.mock.calls[0]![0].work_area).toBe('Sales');
	});
});

describe('/submit — Information involved', () => {
	it('offers the types of information for the chosen work area, by name and description', async () => {
		await open();
		expect(entityOptions).toHaveBeenCalledWith('Claims');
		expect(optionNames()).toEqual(['Claim', 'Policy']);
		expect(field().textContent).toContain('A request for payment');

		await pickArea('Sales');
		expect(entityOptions).toHaveBeenLastCalledWith('Sales');
		expect(optionNames()).toEqual(['Lead']);
	});

	it('the chosen ids travel as `entities` on submit', async () => {
		await open();
		const box = field().querySelectorAll('.options input[type="checkbox"]')[1] as HTMLInputElement;
		box.checked = true;
		box.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(field().querySelector('.chip')?.textContent).toContain('Policy');

		type('#title', 'Claims wait four days');
		type('#frustration', 'Every claim waits for a manual check.');
		const ack = host.querySelector('.ack input') as HTMLInputElement;
		ack.checked = true;
		ack.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		(host.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(createChallenge).toHaveBeenCalledTimes(1);
		expect(createChallenge.mock.calls[0]![0].entities).toEqual(['e-2']);
	});

	it('with nothing chosen, no `entities` field is sent', async () => {
		await open();
		type('#title', 'T');
		type('#frustration', 'D');
		const ack = host.querySelector('.ack input') as HTMLInputElement;
		ack.checked = true;
		ack.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		(host.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(createChallenge.mock.calls[0]![0].entities).toBeUndefined();
	});

	it('a failed options load says so instead of an empty list', async () => {
		listAll.mockResolvedValue({ items: [], total: 0, capped: false });
		entityOptions.mockRejectedValue(new Error('boom'));
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle();
		await pickArea('Claims');
		expect(field().textContent).toContain('challenge_info_options_failed');
		expect(field().querySelector('[data-testid="info-options-empty"]')).toBeNull();
	});
});

describe('/submit — AI suggestions (W8/P3)', () => {
	const btn = () => host.querySelector('[data-testid="info-suggest"]') as HTMLButtonElement;
	const suggestionNames = () =>
		[...host.querySelectorAll('[data-testid="info-suggestion"]')].map((n) => n.firstChild?.textContent?.trim());

	it('is offered only once there is a title or description', async () => {
		await open();
		expect(btn().disabled).toBe(true);
		type('#title', 'Claims wait four days');
		await settle();
		expect(btn().disabled).toBe(false);
	});

	it('sends ONLY title, description and work area; suggestions wait for the reader to add each one', async () => {
		await open();
		type('#title', 'Claims wait four days');
		type('#frustration', 'Every claim waits for a manual check.');
		await settle();
		suggestEntities.mockResolvedValue({ items: [{ id: 'e-2', label: 'Policy', description: null }, { id: 'e-1', label: 'Claim', description: null }] });
		btn().click();
		await settle();
		expect(suggestEntities).toHaveBeenCalledWith({
			title: 'Claims wait four days',
			description: 'Every claim waits for a manual check.',
			work_area: 'Claims'
		});
		expect(suggestionNames()).toEqual(['Policy', 'Claim']);
		// Nothing was chosen for the reader.
		expect(field().querySelector('.chip')).toBeNull();

		// Add one.
		(host.querySelector('[data-testid="info-suggestion"] button') as HTMLButtonElement).click();
		await settle();
		expect(field().querySelector('.chip')?.textContent).toContain('Policy');
		expect(suggestionNames()).toEqual(['Claim']);

		const ack = host.querySelector('.ack input') as HTMLInputElement;
		ack.checked = true;
		ack.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		(host.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(createChallenge.mock.calls[0]![0].entities).toEqual(['e-2']);
	});

	it('a failure is silent: "No suggestions", no error, the picker still works', async () => {
		await open();
		type('#title', 'T');
		await settle();
		suggestEntities.mockRejectedValue(new Error('budget'));
		btn().click();
		await settle();
		expect(host.textContent).toContain('submit_info_no_suggestions');
		expect(host.querySelector('.form-error')).toBeNull();
		expect(optionNames()).toEqual(['Claim', 'Policy']);
	});
});
