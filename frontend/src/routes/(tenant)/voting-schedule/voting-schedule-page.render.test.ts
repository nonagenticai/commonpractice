// @vitest-environment jsdom
//
// src/routes/(tenant)/voting-schedule/voting-schedule-page.render.test.ts — the workspace's own
// voting schedule (W7). GET/PATCH /api/tenant/cycle-cadence.
//
// Pinned here, each at its call site:
//   1. a pending change shows BOTH what runs now and what follows, with "Takes effect on {date}"
//      (a change waits for the next period boundary — showing only the new value would claim it
//      is already in force);
//   2. "Use platform default" sends `{ value: null }` — never the default's CURRENT value, which
//      would pin the workspace to it and stop it following later platform changes;
//   3. the platform default is named in its option, and the history renders who/what/when.
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

const { getFn, setFn } = vi.hoisted(() => ({ getFn: vi.fn(), setFn: vi.fn() }));
vi.mock('$lib/api/cycle', () => ({
	cycleApi: { tenantCadence: getFn, setTenantCadence: setFn },
	ApiError: class ApiError extends Error {
		status = 0;
	}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';
import { boundaryDate } from '$lib/utils/format';
import { locale } from '$lib/stores/locale.svelte';

const BASE = {
	value: null,
	platformDefault: 'week',
	effectiveValue: 'week',
	pendingValue: null,
	effectiveFrom: null,
	followsPlatform: true,
	history: []
};

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle(until: () => boolean, tries = 40) {
	for (let i = 0; i < tries && !until(); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	flushSync();
}

async function render(payload: Record<string, unknown>) {
	getFn.mockResolvedValue({ ...BASE, ...payload });
	host = document.createElement('div');
	document.body.appendChild(host);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle(() => !!host.querySelector('[data-testid="vschedule-status"]'));
}
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
	getFn.mockReset();
	setFn.mockReset();
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host?.remove();
});

describe('voting schedule page', () => {
	it('renders the options with the platform default named, and the current value', async () => {
		await render({});
		expect(q('vschedule-current')?.textContent).toContain('vschedule_current:policy_option_cadence_week');
		for (const v of ['off', 'week', 'month', 'quarter', 'year', 'platform']) {
			expect(q(`vschedule-option-${v}`), v).not.toBeNull();
		}
		expect(host.textContent).toContain('vschedule_option_platform:policy_option_cadence_week');
		// Follows the platform → the platform option is the selected one.
		expect((q('vschedule-option-platform') as HTMLInputElement).checked).toBe(true);
		// Nothing pending → no "Takes effect on".
		expect(q('vschedule-effective-from')).toBeNull();
	});

	it('⛔ pending: shows what runs now AND what follows, with "Takes effect on {date}"', async () => {
		await render({
			value: 'month',
			followsPlatform: false,
			effectiveValue: 'week',
			pendingValue: 'month',
			effectiveFrom: '2026-11-02T00:00:00.000Z'
		});
		expect(q('vschedule-current')?.textContent).toContain('policy_option_cadence_week');
		expect(q('vschedule-upcoming')?.textContent).toContain('vschedule_upcoming:policy_option_cadence_month');
		expect(q('vschedule-effective-from')?.textContent?.trim()).toBe(
			`governance_cadence_effective_from:${boundaryDate('2026-11-02T00:00:00.000Z', locale.current)}`
		);
		expect((q('vschedule-option-month') as HTMLInputElement).checked).toBe(true);
	});

	it('⛔ "Use platform default" sends { value: null }, not the default\'s current value', async () => {
		await render({ value: 'month', followsPlatform: false, effectiveValue: 'month' });
		setFn.mockResolvedValue({ ...BASE, changed: true });
		const radio = q('vschedule-option-platform') as HTMLInputElement;
		radio.click();
		flushSync();
		(q('vschedule-save') as HTMLButtonElement).click();
		await settle(() => !!q('vschedule-banner'));
		expect(setFn).toHaveBeenCalledTimes(1);
		expect(setFn).toHaveBeenCalledWith(null);
		expect(q('vschedule-banner')?.textContent).toBe('vschedule_saved');
	});

	it('choosing a cadence sends that value; Save is disabled until the choice differs', async () => {
		await render({});
		const save = q('vschedule-save') as HTMLButtonElement;
		expect(save.disabled).toBe(true);
		(q('vschedule-option-quarter') as HTMLInputElement).click();
		flushSync();
		expect(save.disabled).toBe(false);
		setFn.mockResolvedValue({ ...BASE, value: 'quarter', followsPlatform: false, changed: true });
		save.click();
		await settle(() => !!q('vschedule-banner'));
		expect(setFn).toHaveBeenCalledWith('quarter');
	});

	it('history: actor (or System), old → new, platform default marked', async () => {
		await render({
			history: [
				{ id: 'h2', oldValue: 'month', newValue: 'week', followsPlatform: true, effectiveFrom: null, createdAt: '2026-10-14T10:00:00.000Z', actorName: null },
				{ id: 'h1', oldValue: 'week', newValue: 'month', followsPlatform: false, effectiveFrom: '2026-11-01T00:00:00.000Z', createdAt: '2026-10-10T10:00:00.000Z', actorName: 'Ada Admin' }
			]
		});
		const rows = host.querySelectorAll('[data-testid="vschedule-history-row"]');
		expect(rows).toHaveLength(2);
		expect(rows[0]!.textContent).toContain('audit_actor_system');
		expect(rows[0]!.textContent).toContain('vschedule_platform_default (policy_option_cadence_week)');
		expect(rows[1]!.textContent).toContain('Ada Admin');
		expect(rows[1]!.textContent).toContain('policy_option_cadence_month');
	});
});
