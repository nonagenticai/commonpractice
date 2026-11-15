// @vitest-environment jsdom
//
// src/routes/(tenant)/delivery/delivery-page.test-lock.render.test.ts — /delivery's "Test" button
// was inert on every row except the one already in flight.
//
// ⛔ THE DEFECT. `testTarget` takes a single-flight lock (`if (testingId) return;`), but the markup
// only disabled the row that HOLDS it (`disabled={testingId === t.id}`). So while one connector is
// being tested, every OTHER connector's Test button still looks pressable, and pressing it returns
// at the first line: no spinner, no result line, no banner, no request. The control answers the
// click by doing nothing and saying nothing.
//
// ⛔ THE WINDOW IS TEN SECONDS WIDE, which is what turns a race into an everyday experience. Both
// backlog probes are bounded at `timeoutMs: 10_000` (backend/src/host/delivery/jira.ts:160,
// azure-devops.ts:183), so a connector pointed at an unreachable host holds the lock for the full
// ten seconds — precisely the pause during which a user gives up on that row and reaches for the
// other one.
//
// ⛔ THE ASSERTIONS ARE ABOUT THE LOCK, NOT ABOUT ONE BUTTON. Each case reads the buttons of BOTH
// rows, and the resolved-state case proves they come back — a "fix" that hard-disables Test forever
// would satisfy a bare `disabled === true` and is red here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import type { DeliveryTarget } from '$lib/api/delivery';

// Real `en` catalog, each key resolving to its own name — the assertions are about WHICH key a
// button reads, never the wording.
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

const { listTargets, testTargetApi } = vi.hoisted(() => ({
	listTargets: vi.fn(),
	testTargetApi: vi.fn()
}));
// ⛔ ALIAS ids, never relative ones — a relative mock id resolves to a different module record than
// the one the page imports and silently does nothing.
vi.mock('$lib/api/delivery', () => ({
	deliveryApi: {
		list: listTargets,
		create: vi.fn(),
		update: vi.fn(),
		remove: vi.fn(),
		test: testTargetApi
	},
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			message: string
		) {
			super(message);
		}
	}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn() }));

import Page from './+page.svelte';

const target = (id: string, kind: DeliveryTarget['kind'], name: string): DeliveryTarget =>
	({
		id,
		kind,
		name,
		baseUrl: `https://${id}.example`,
		projectKey: 'CP',
		defaultItemType: null,
		config: {},
		enabled: true,
		hasCredentials: true,
		createdAt: '2026-06-01T09:00:00.000Z',
		updatedAt: '2026-06-01T09:00:00.000Z'
	}) as DeliveryTarget;

const JIRA = target('t-jira', 'jira', 'Jira · unreachable host');
const ADO = target('t-ado', 'azure_devops', 'Azure DevOps');

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	listTargets.mockReset();
	testTargetApi.mockReset();
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

async function render(targets: DeliveryTarget[]): Promise<void> {
	listTargets.mockResolvedValue(targets);
	app = mount(Page, { target: host, props: {} }) as Record<string, unknown>;
	for (let i = 0; i < 20 && host.textContent?.includes('delivery_loading') !== false; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	expect(
		host.textContent,
		'the page never left its loading state — nothing below would be a proof'
	).not.toContain('delivery_loading');
	expect(
		host.querySelectorAll('.target-row').length,
		'the connector rows never rendered — this case would prove nothing'
	).toBe(targets.length);
}

/** The Test button of the Nth connector row (the first `.btn-link` in its actions). */
const testButton = (row: number): HTMLButtonElement =>
	host.querySelectorAll('.target-row')[row]!.querySelector('.target-actions .btn-link')!;

/** ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root, so a non-bubbling
 *  synthetic click silently skips the handler and every assertion below passes for free. */
async function click(btn: HTMLButtonElement) {
	btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await tick();
	flushSync();
}

/** A `deliveryApi.test` call the test holds open, standing in for the 10s backend probe. */
function pending(): { resolve: (v: { ok: boolean; detail: string }) => void } {
	let resolve!: (v: { ok: boolean; detail: string }) => void;
	testTargetApi.mockReturnValue(new Promise((r) => (resolve = r)));
	return { resolve };
}

describe('the single-flight Test lock', () => {
	it('THE DEFECT: while one connector is being tested, the OTHER row\'s Test button is disabled', async () => {
		await render([JIRA, ADO]);
		// Both start pressable — otherwise the assertion below is free.
		expect(testButton(0).disabled).toBe(false);
		expect(testButton(1).disabled).toBe(false);

		const inFlight = pending();
		await click(testButton(0));

		expect(testButton(0).disabled, 'the row under test lost its own disabled state').toBe(true);
		expect(testButton(0).textContent?.trim()).toBe('delivery_testing');
		expect(
			testButton(1).disabled,
			'the second connector still offers a Test button that would silently do nothing'
		).toBe(true);

		inFlight.resolve({ ok: true, detail: 'ok' });
		await tick();
		flushSync();
	});

	it('a click on the locked-out row produces no request and no result — the silent no-op it hides', async () => {
		// The reason the disable is required rather than cosmetic: the handler's own guard means a
		// press on the second row is answered with nothing at all. This stays true after the fix
		// (it is the second line of defence) and states what the greyed-out button is protecting.
		await render([JIRA, ADO]);
		const inFlight = pending();
		await click(testButton(0));
		await click(testButton(1));

		expect(testTargetApi.mock.calls.map((c) => c[0])).toEqual(['t-jira']);
		expect(
			host.querySelectorAll('.test-result').length,
			'the second row answered the click with a result it never requested'
		).toBe(0);

		inFlight.resolve({ ok: true, detail: 'ok' });
		await tick();
		flushSync();
	});

	it('BOTH buttons come back once the test settles, and the result lands on the tested row', async () => {
		// ⛔ THE OVER-CORRECTION GUARD. `disabled={true}` satisfies the first case forever; this one
		// is the half that reds on it.
		await render([JIRA, ADO]);
		const inFlight = pending();
		await click(testButton(0));
		inFlight.resolve({ ok: false, detail: 'connect ETIMEDOUT' });
		for (let i = 0; i < 20 && testButton(0).disabled; i++) {
			await new Promise((r) => setTimeout(r, 0));
			flushSync();
		}

		expect(testButton(0).disabled).toBe(false);
		expect(testButton(1).disabled).toBe(false);
		expect(testButton(0).textContent?.trim()).toBe('delivery_test');

		const rows = host.querySelectorAll('.target-row');
		expect(rows[0]!.querySelector('.test-result')?.textContent).toBe('connect ETIMEDOUT');
		expect(rows[1]!.querySelector('.test-result')).toBeNull();
	});
});
