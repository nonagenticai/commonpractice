// @vitest-environment jsdom
//
// W8/P5 on the challenge page: a member asks for missing information / uploads example records and
// sees their own requests with each one's status and the reviewer's note.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema' || typeof catalog[key] !== 'string') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			(catalog[key] as string).replace(/\{(\w+)\}/g, (w: string, n: string) => (params && n in params ? String(params[n]) : w));
	}
	return mod;
});
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'en' } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
const { forChallenge, requestMissing, uploadRecords } = vi.hoisted(() => ({
	forChallenge: vi.fn(),
	requestMissing: vi.fn(),
	uploadRecords: vi.fn()
}));
vi.mock('$lib/api/information-requests', () => ({
	informationRequestsApi: { forChallenge, requestMissing, uploadRecords }
}));

import InformationRequests from './InformationRequests.svelte';

const REQ = (over: Record<string, unknown> = {}) => ({
	id: 'r1', challengeId: 'c1', challengeTitle: null, kind: 'missing_information', status: 'pending', name: 'Policy holder',
	description: null, fieldNames: [], fileName: null, columns: [], rowCount: null, createdByName: null, mine: true,
	createdAt: '2026-10-14T00:00:00Z', reviewedAt: null, reviewNote: null, ...over
});

let host: HTMLElement;
let app: Record<string, unknown> | null = null;
async function settle() {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}
beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	forChallenge.mockReset();
	requestMissing.mockReset();
	uploadRecords.mockReset();
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
});

async function render() {
	app = mount(InformationRequests, { target: host, props: { challengeId: 'c1' } }) as Record<string, unknown>;
	await settle();
}

function type(testid: string, value: string) {
	const el = host.querySelector(`[data-testid="${testid}"]`) as HTMLInputElement;
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

describe('InformationRequests (W8/P5)', () => {
	it('lists the member\'s requests with plain status words and the reviewer\'s note', async () => {
		forChallenge.mockResolvedValue({
			items: [
				REQ({ id: 'a', name: 'Policy holder', status: 'pending' }),
				REQ({ id: 'b', name: 'Claims sheet', kind: 'example_records', status: 'rejected', rowCount: 12, reviewNote: 'Already in Claims April' })
			],
			canReview: false
		});
		await render();
		const statuses = [...host.querySelectorAll('[data-testid="request-status"]')].map((e) => e.textContent);
		expect(statuses).toEqual(['Pending', 'Not approved']);
		expect(host.textContent).toContain('Example records');
		expect(host.textContent).toContain('Note: Already in Claims April');
	});

	it('"Request missing information" sends the name, description and the field names split on commas', async () => {
		forChallenge.mockResolvedValue({ items: [], canReview: false });
		requestMissing.mockResolvedValue(REQ());
		await render();
		(host.querySelector('[data-testid="request-missing"]') as HTMLButtonElement).click();
		flushSync();
		const send = host.querySelector('[data-testid="request-send"]') as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		type('request-name', 'Policy holder');
		type('request-description', 'Who owns the policy');
		type('request-fields', 'policy number, start date ,');
		expect(send.disabled).toBe(false);
		(host.querySelector('[data-testid="request-missing-form"]') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await settle();
		expect(requestMissing).toHaveBeenCalledWith('c1', {
			name: 'Policy holder',
			description: 'Who owns the policy',
			fieldNames: ['policy number', 'start date']
		});
		expect(host.querySelector('[data-testid="request-sent"]')!.textContent).toBe('Request sent. An admin reviews it.');
		expect(forChallenge).toHaveBeenCalledTimes(2);
	});

	it('the upload form tells the member to use made-up examples and needs a file', async () => {
		forChallenge.mockResolvedValue({ items: [], canReview: false });
		await render();
		(host.querySelector('[data-testid="request-upload"]') as HTMLButtonElement).click();
		flushSync();
		expect(host.textContent).toContain('Use made-up examples only, no real customer data.');
		expect((host.querySelector('[data-testid="request-file"]') as HTMLInputElement).accept).toBe('.csv,.xlsx,.xls');
		expect((host.querySelector('[data-testid="request-send"]') as HTMLButtonElement).disabled).toBe(true);
		expect(uploadRecords).not.toHaveBeenCalled();
	});
});
