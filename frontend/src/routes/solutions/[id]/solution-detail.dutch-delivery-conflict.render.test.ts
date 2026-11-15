// @vitest-environment jsdom
//
// src/routes/solutions/[id]/solution-detail.dutch-delivery-conflict.render.test.ts — THE DEFECT, at
// the surface it happens on: a Dutch tenant admin presses Deliver on a solution that already has an
// open delivery, and reads the refusal.
//
// ⛔ THE DEFECT. `backend/src/routes/delivery.ts` answers both the forward (:472) and the retry
// (:726) with `409 { error: 'delivery_already_live', message: 'This solution already has a live
// delivery to that connector' }`. The page hands that error to `writeErrorText`
// (+page.svelte:269), whose 409 branch had NO `VALIDATION_MESSAGES` entry for the code, so it fell
// through to the backend's own sentence — English, inside a Dutch frame, on the second click of an
// ordinary demo action. The fix is one entry in that map plus `error_delivery_already_live` in all
// eight catalogs.
//
// ⛔ NOTHING ABOUT THE MESSAGE LAYER IS MOCKED HERE — not the catalog, not the compiled paraglide
// functions, and NOT `writeErrorText`, which is the unit under test. The sibling specs in this
// directory stub `$lib/paraglide/messages` to key NAMES and `writeErrorText` to its fallback, which
// is right for them (they assert WHICH key) and would be fatal here, where the words are the whole
// subject: a stubbed `writeErrorText` returns the fallback for every error and this file would pass
// with the map entry deleted. `overwriteGetLocale` is the same lever `$lib/stores/locale.svelte.ts`
// pulls in the running app, so `nl` resolves exactly as it does in a browser. Same construction as
// `src/routes/build/build-page.dutch-refusal.render.test.ts`.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { SolutionDetail } from '$lib/types/solutions';
import type { DeliveryTarget } from '$lib/api/delivery';

// ⚠️ The id is a LITERAL inside the factory: `vi.mock` is hoisted above every const in this file.
vi.mock('$app/state', () => ({
	page: { params: { id: 'sol-del-9' }, url: new URL('http://localhost/solutions/sol-del-9') }
}));
const SOL_ID = 'sol-del-9';
vi.mock('$lib/i18n/reload-on-locale.svelte', () => ({ reloadOnLocaleChange: () => {} }));

const { getSolution, deliveryList, listForSolution, forwardMock } = vi.hoisted(() => ({
	getSolution: vi.fn(),
	deliveryList: vi.fn(),
	listForSolution: vi.fn(),
	forwardMock: vi.fn()
}));
vi.mock('$lib/api/solutions', () => ({
	solutionsApi: { get: getSolution, vote: vi.fn(), unvote: vi.fn() }
}));
vi.mock('$lib/api/cycle', () => ({ cycleApi: { current: vi.fn().mockResolvedValue(null) } }));
// ⛔ PARTIAL, and `ApiError` is the REAL class. The page's error reading is under test, and
// `writeErrorText` keys off `.status`/`.code` — a hand-rolled stand-in that happened to omit either
// would make the fall-through look like the fix. Only the network call is replaced.
vi.mock('$lib/api/delivery', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		deliveryApi: {
			list: deliveryList,
			listForSolution,
			forward: forwardMock,
			retry: vi.fn()
		}
	};
});
vi.mock('$lib/api/runs', () => ({
	RunApiError: class RunApiError extends Error {},
	runErrorDataFindings: () => [],
	runsApi: {
		getMySandbox: vi.fn().mockResolvedValue(null),
		startSolution: vi.fn(),
		resumeMySandbox: vi.fn()
	}
}));
// ⛔ THE WHOLE FORWARD CARD IS BEHIND THIS FLAG. `false` and every assertion here is vacuous.
vi.mock('$lib/stores/auth.svelte', () => ({ auth: { isTenantAdmin: true } }));
vi.mock('$lib/services/sse', () => ({ streamRun: vi.fn(() => ({ close: () => {} })) }));

import { ApiError } from '$lib/api/delivery';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';
import Page from './+page.svelte';

/** The verbatim English sentence `routes/delivery.ts` puts on the wire. */
const WIRE_EN = 'This solution already has a live delivery to that connector';
/** The wire `code` — `body.error`, read off the backend, not invented here. */
const WIRE_CODE = 'delivery_already_live';

function detail(): SolutionDetail {
	return {
		id: SOL_ID,
		title: 'Schadeclaim in drie blokken',
		status: 'voting',
		week: '2026-W33',
		cycleClosed: false,
		votesCount: 3,
		hasVoted: false,
		demoMs: 0,
		blocksUsed: [],
		createdAt: '2026-08-10T00:00:00.000Z',
		author: { name: 'Bea Builder', initials: 'BB' },
		challenge: null,
		flow: { id: 'f1', name: 'Triage flow', chain: ['load-dataset'] },
		comparison: []
	};
}

function connector(): DeliveryTarget {
	return {
		id: 't1',
		name: 'Jira · Claims',
		kind: 'jira',
		enabled: true,
		config: {},
		createdAt: '2026-08-01T00:00:00.000Z'
	} as DeliveryTarget;
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/**
 * Mount /solutions/[id], press Deliver, and hand back the whole forward card.
 *
 * ⛔ THREE POSITIVE MARKERS BEFORE ANY "NOT ENGLISH" ASSERTION RUNS. This page mounts behind
 * `{#if data}` → `{#if auth.isTenantAdmin}` → `{#if backlogTargets.length}`; if `solutionsApi.get`
 * had rejected, or the connector list were empty, the document would contain neither the Dutch
 * sentence nor the English one, and `not.toContain(WIRE_EN)` would pass against a blank page. So:
 * the solution's own <h1> is on screen, the card rendered, and the button was really clicked
 * (`forwardMock` was called).
 */
async function deliverAndReadCard(err: unknown): Promise<HTMLElement> {
	getSolution.mockResolvedValue(detail());
	deliveryList.mockResolvedValue([connector()]);
	// Empty history, so `liveForSelected` is false and the Deliver button is ARMED. (The 409 is what
	// a second click races: the first delivery exists server-side before this client refetches.)
	listForSolution.mockResolvedValue([]);
	forwardMock.mockRejectedValue(err);

	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();

	const h1 = target.querySelector('h1');
	expect(h1, 'the solution page rendered no header — this file would test nothing').not.toBeNull();
	expect(h1!.textContent, 'the header is not this solution').toContain('Schadeclaim in drie blokken');

	const card = target.querySelector('.delivery-card') as HTMLElement | null;
	expect(card, 'the forward card never rendered — this file would test nothing').not.toBeNull();

	const btn = card!.querySelector('button.btn-forward') as HTMLButtonElement | null;
	expect(btn, 'the Deliver button is missing (no connector in the picker?)').not.toBeNull();
	expect(btn!.disabled, 'Deliver is disabled, so the 409 path was never entered').toBe(false);

	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();

	expect(forwardMock, 'Deliver was clicked but nothing was posted').toHaveBeenCalled();
	return card!;
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	overwriteGetLocale(() => 'nl');
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	overwriteGetLocale(() => 'en');
	for (const fn of [getSolution, deliveryList, listForSolution, forwardMock]) fn.mockReset();
});

describe('a Dutch tenant admin reads the delivery 409 in Dutch', () => {
	it('the fixture really is Dutch, and really differs from English', () => {
		// ⛔ NON-VACUITY, AND NOT A FORMALITY. Every assertion below is "the card contains the nl
		// string". If `overwriteGetLocale` stopped working, `m.*()` would return ENGLISH, the card
		// would contain it, and the whole file would pass while proving the opposite.
		overwriteGetLocale(() => 'nl');
		const nlCopy = m.error_delivery_already_live();
		const nlFrame = m.delivery_forward_error({ error: 'X' });
		overwriteGetLocale(() => 'en');
		expect(nlCopy).not.toBe(m.error_delivery_already_live());
		expect(nlFrame).not.toBe(m.delivery_forward_error({ error: 'X' }));
		// …and the Dutch copy is not accidentally the English wire sentence in disguise.
		expect(nlCopy).not.toContain(WIRE_EN);
	});

	it('⛔ delivery_already_live — Dutch copy, never the English wire sentence', async () => {
		// The verbatim 409 the SPA's own `unwrap()` builds from `routes/delivery.ts`'s body.
		const card = await deliverAndReadCard(new ApiError(409, WIRE_CODE, WIRE_EN));
		const text = card.textContent ?? '';

		overwriteGetLocale(() => 'nl');
		// PRESENT — the localized refusal, inside the Dutch frame. An English frame around Dutch copy
		// is still an English screen, so both halves are asserted together.
		expect(text, 'the refusal never reached the card').toContain(m.error_delivery_already_live());
		expect(text).toContain(
			m.delivery_forward_error({ error: m.error_delivery_already_live() })
		);
		// ABSENT — the sentence a Dutch reader used to get. REVERT THAT TURNS THIS RED: delete the
		// `delivery_already_live` entry from `VALIDATION_MESSAGES`; `writeErrorText`'s 409 branch then
		// falls through to `messageOf(e)` and hands this exact string to the card.
		expect(text, 'the English wire sentence is still on the Dutch screen').not.toContain(WIRE_EN);
		expect(text).not.toContain('already has a live delivery');
	});

	it('an UNCATALOGUED 409 still shows the backend sentence — the fall-through is not collateral', async () => {
		// ⛔ THE COMPLEMENT, AND THE REASON THE FIX IS ONE MAP ENTRY RATHER THAN "localize all 409s".
		// `writeErrorText`'s doctrine is that an uncatalogued 4xx keeps the backend's sentence,
		// because that sentence names the offender and no static translation can. A "fix" that
		// swallowed every 409 into generic localized copy would destroy that. `target_disabled` is a
		// real delivery.ts refusal with no catalog entry.
		const wire = "Connector 'Jira · Claims' is disabled";
		const card = await deliverAndReadCard(new ApiError(409, 'target_disabled', wire));
		expect(card.textContent).toContain(wire);
	});
});
