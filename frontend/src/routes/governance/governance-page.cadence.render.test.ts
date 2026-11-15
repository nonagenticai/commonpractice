// @vitest-environment jsdom
//
// src/routes/governance/governance-page.cadence.render.test.ts — the voting-cycle cadence rail.
//
// ⛔ TWO DEFECTS FOUND BY A BROWSER WALK (2026-10-14):
//   1. GET /api/cycle/cadence answers `effectiveFrom` (e.g. 2026-11-01) and the screen never showed
//      a date: after switching week → month an admin could not tell WHEN it takes over.
//   2. The rail sat in the `applied` band, whose note says an edit "changes the next run or call" —
//      while the rail's own description says a change waits for the next period. One screen, two
//      contradictory claims about one rail. It now has its own band with its own note.
// ⛔ AND A THIRD (2026-10-15, W7): the date came from GET /api/cycle/cadence, which since 0110 answers
//    for the operator's OWN WORKSPACE. An operator whose workspace overrides the cadence saw that
//    workspace's switch date under the PLATFORM rail. The date now rides on the rail itself
//    (`effectiveFrom`, from the platform policy row) and the tenant endpoint is never read here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Governance, Policy, PolicyEnforcement } from '$lib/types/governance';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

const { getGovernance, updateGovernance, getCadence, FakeApiError } = vi.hoisted(() => ({
	getGovernance: vi.fn(),
	updateGovernance: vi.fn(),
	getCadence: vi.fn(),
	FakeApiError: class extends Error {
		status = 0;
	}
}));
vi.mock('$lib/api/governance', () => ({
	governanceApi: { get: getGovernance, update: updateGovernance, exportNow: vi.fn() },
	ApiError: FakeApiError
}));
vi.mock('$lib/api/cycle', () => ({ cycleApi: { cadence: getCadence, current: vi.fn() } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';
import { boundaryDate } from '$lib/utils/format';
import { locale } from '$lib/stores/locale.svelte';

function policy(key: string, enforcement: PolicyEnforcement, extra: Partial<Policy> = {}): Policy {
	return {
		key,
		category: 'marketplace',
		label: 'SEEDER ENGLISH',
		description: 'SEEDER ENGLISH DESCRIPTION',
		control: 'toggle',
		value: true,
		options: null,
		unit: null,
		enabled: true,
		enforcement,
		...extra
	};
}
const cadenceRail = (value: string, effectiveFrom: string | null) =>
	policy('cycle.cadence', 'applied', { control: 'select', value, options: ['off', 'week', 'month', 'year'], effectiveFrom });
function dto(value = 'week', effectiveFrom: string | null = null): Governance {
	return {
		groups: [
			{
				category: 'marketplace',
				title: 'Marketplace',
				policies: [policy('models.work_tiers', 'applied'), cadenceRail(value, effectiveFrom)]
			}
		],
		compliance: [],
		recentChanges: [],
		exportStatus: { enabled: false, bucket: 'compliance', hourUtc: 2, lastRun: null, recent: [] }
	};
}
/** What the TENANT-scoped GET /api/cycle/cadence would say — a different date, on purpose. */
const tenantStatus = {
	setting: 'quarter',
	effective: 'week',
	pending: true,
	effectiveFrom: '2027-01-01T00:00:00.000Z'
};

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
beforeEach(() => {
	getGovernance.mockReset();
	updateGovernance.mockReset();
	getCadence.mockReset();
	updateGovernance.mockResolvedValue(undefined);
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});
async function settle() {
	for (let i = 0; i < 8; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}
async function render() {
	app = mount(Page, { target: host, props: {} });
	await settle();
	expect(host.querySelector('.policy-name'), 'the rails never rendered').not.toBeNull();
	return host;
}
const effective = () => host.querySelector('[data-testid="cadence-effective-from"]')?.textContent?.trim() ?? null;

describe('the cadence rail', () => {
	it('⛔ sits in its OWN band — never under the applied note that says "changes the next run or call"', async () => {
		getGovernance.mockResolvedValue(dto());
		getCadence.mockResolvedValue(tenantStatus);
		const el = await render();
		const bandOf = new Map<string, string>();
		let band = '(none)';
		for (const node of el.querySelectorAll('.section-head h3, .policy-name')) {
			if (node.classList.contains('policy-name')) bandOf.set(node.textContent!, band);
			else band = node.textContent!;
		}
		expect(bandOf.get('policy_label_cycle_cadence')).toBe('governance_enforcement_scheduled');
		expect(bandOf.get('policy_label_models_work_tiers')).toBe('governance_enforcement_applied');
		expect(el.textContent).toContain('governance_enforcement_scheduled_note');
	});

	it('⛔ shows "Takes effect on {date}" from the PLATFORM rail — never the operator’s own workspace (GET /api/cycle/cadence)', async () => {
		getGovernance.mockResolvedValue(dto('month', '2026-11-01T00:00:00.000Z'));
		getCadence.mockResolvedValue(tenantStatus);
		await render();
		expect(effective()).toBe(
			`governance_cadence_effective_from:${boundaryDate('2026-11-01T00:00:00.000Z', locale.current)}`
		);
		expect(getCadence).not.toHaveBeenCalled();
	});

	it('shows no date when the platform has nothing pending — even if the operator’s workspace does', async () => {
		getGovernance.mockResolvedValue(dto());
		getCadence.mockResolvedValue(tenantStatus);
		await render();
		expect(effective()).toBeNull();
	});

	it('⛔ after a change it REFETCHES the rails and shows the new date', async () => {
		getGovernance.mockResolvedValue(dto('week'));
		await render();
		expect(effective()).toBeNull();
		getGovernance.mockResolvedValue(dto('month', '2026-11-01T00:00:00.000Z'));
		const select = [...host.querySelectorAll('.policy-row')]
			.find((r) => r.querySelector('.policy-name')?.textContent === 'policy_label_cycle_cadence')!
			.querySelector('select')!;
		select.value = 'month';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();
		expect(updateGovernance).toHaveBeenCalledWith('cycle.cadence', 'month');
		expect(getGovernance).toHaveBeenCalledTimes(2);
		expect(effective()).toBe(
			`governance_cadence_effective_from:${boundaryDate('2026-11-01T00:00:00.000Z', locale.current)}`
		);
	});

	it('the date is the boundary’s UTC day — never the day before for a reader west of UTC', () => {
		expect(boundaryDate('2026-11-01T00:00:00.000Z', 'en')).toBe('November 1, 2026');
		expect(boundaryDate('2026-11-01T00:00:00.000Z', 'nl')).toBe('1 november 2026');
	});
});
