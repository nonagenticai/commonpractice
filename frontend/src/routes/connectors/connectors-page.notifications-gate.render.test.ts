// @vitest-environment jsdom
//
// src/routes/connectors/connectors-page.notifications-gate.render.test.ts — three controls that
// could only ever fail.
//
// ⛔ THE DEFECT. "Verifiëren", "Opnieuw registreren" and "Meldingen afstemmen" all call routes that
// throw `400 notifications_disabled` unless `CP_CONNECTOR_NOTIFICATIONS_ENABLED === 'true'`
// (backend/src/routes/connectors.ts :857, :1020, :1065) — and that variable is absent from `.env`,
// `.env.example`, `.env.local` and `docker-compose.yml`, so it is off everywhere the demo runs.
// The state is reachable rather than theoretical: `POST /api/connectors` accepts
// `eventSource: 'webhook'` unconditionally — only the auto-registration is gated — and the create
// modal offers it, so a tenant admin can build exactly the connector these three act on.
//
// ⛔ AND THE PAGE HAD NO WAY TO KNOW. There is no `/api/config`, no `/api/capabilities`, and
// `/api/me` carries no flags — so the only way to discover the truth was to press a button and read
// a refusal. `canManage`, already on this same list body, is the precedent the fix follows:
// `notificationsEnabled` is now server-computed and shipped beside it.
//
// ⛔ TWO INDEPENDENT HALVES, BOTH ASSERTED.
//   1. The controls are DISABLED with a reason — not hidden. `VoteButton.svelte` states both rules
//      for this codebase: a control that goes inert without saying why is the defect, and the
//      `title` goes on a WRAPPER because a disabled button fires no pointer events.
//   2. The click that still gets through (an older backend omitting the field, a flag flipped
//      mid-session) now reaches the LOCALIZED refusal. `verify` used `errorText`, which maps no 400
//      at all, so it produced the bare `error_action_failed` while its two siblings — same wire
//      code, same row — produced the correct sentence through `writeErrorText`.
//
// ⚠️ THIS FILE DOES NOT MOCK `$lib/api/error-message`, deliberately, and that is the only way half 2
// can be seen: a flattened `errorText: (_e, fallback) => fallback` stub makes the broken and the
// fixed versions render the identical string. Same choice, same reason, as
// `connectors.sync-error-dutch.render.test.ts` one file over.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Connector, ConnectorList } from '$lib/types/connectors';

// Real `en` catalog, each key resolving to its own name — so an assertion names a MESSAGE KEY and no
// reworded translation can red this file. (The Dutch wording of the refusal is `error-message`'s own
// subject; what matters here is WHICH key is chosen.)
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

const { list, verifyNotifications } = vi.hoisted(() => ({
	list: vi.fn(),
	verifyNotifications: vi.fn()
}));
// ⛔ ALIAS ids, never relative ones. And `ApiError` is imported as a VALUE by the page, so a mock
// that omits it fails at import — it also has to carry `status`/`code`, because that is what
// `error-message.ts` reads to pick a sentence.
vi.mock('$lib/api/connectors', () => ({
	connectorsApi: {
		list,
		get: vi.fn(),
		sync: vi.fn(),
		create: vi.fn(),
		test: vi.fn(),
		rotateSecret: vi.fn(),
		reregisterNotifications: vi.fn(),
		verifyNotifications,
		reconcileNotifications: vi.fn(),
		remove: vi.fn()
	},
	streamConnectors: () => ({ close: () => {} }),
	ApiError: class ApiError extends Error {
		constructor(
			readonly status: number,
			readonly code: string,
			message: string,
			readonly details?: Record<string, unknown>
		) {
			super(message);
		}
	}
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn(async () => true) }));

import Page from './+page.svelte';
import { ApiError } from '$lib/api/connectors';

/** storage + webhook + a FAILED registration — the one shape that renders all three gated controls. */
const CONNECTOR: Connector = {
	id: 'c-1',
	slug: 'claims-drop',
	name: 'Claims drop bucket',
	sourceType: 'storage',
	status: 'ready',
	eventSource: 'webhook',
	meta: { kind: 'storage', host: 'storage.example.com', bucket: 'claims', notifyRegistered: false },
	columns: [],
	rowCount: 120,
	sizeBytes: 4096,
	sandboxId: null,
	lastSyncedAt: '2026-08-09T10:00:00.000Z',
	syncError: null,
	syncErrorCode: null,
	syncErrorDetail: null,
	createdAt: '2026-08-01T00:00:00.000Z',
	updatedAt: '2026-08-09T10:00:00.000Z'
};

/** The three controls the flag gates, by the key each renders. */
const GATED = ['connectors_verify', 'connectors_reregister', 'connectors_reconcile'] as const;
/** …and one that it does NOT. Sync answers no `notifications_disabled`; greying it out would be a
 *  new defect wearing this fix's clothes. */
const UNGATED = 'connectors_sync';

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 12; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/**
 * Mount the page with the capability in a given state.
 *
 * `undefined` is the third, real case: a backend one roll behind that does not send the field.
 */
async function render(notificationsEnabled: boolean | undefined) {
	list.mockResolvedValue({
		items: [{ ...CONNECTOR }],
		total: 1,
		page: 1,
		pageSize: 20,
		canManage: true,
		...(notificationsEnabled === undefined ? {} : { notificationsEnabled })
	} satisfies ConnectorList);
	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle();
	// ⛔ POSITIVE ANCHOR. Without a rendered row every "…is disabled" assertion below is a claim
	// about an element that does not exist, and `byKey` would throw for the wrong reason.
	expect(host.querySelectorAll('td.row-actions').length, 'the table never rendered its row').toBe(1);
}

/** A control by the message key it renders, asserted present first. */
function byKey(key: string): HTMLButtonElement {
	const btn = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === key);
	expect(btn, `the control "${key}" is not on screen — this case tests nothing`).toBeTruthy();
	return btn as HTMLButtonElement;
}
const notice = () => host.querySelector('[data-testid="notifications-disabled"]');
const actionError = () => host.querySelector('.notice.error');

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	list.mockReset();
	verifyNotifications.mockReset();
});

describe('/connectors when self-serve notifications are switched off', () => {
	it('⛔ THE DEFECT: the three controls are inert instead of inviting a refusal', async () => {
		// REVERT THAT TURNS THIS RED: drop `disabled={notifyBlockedReason !== null}` from the three
		// controls. They render live again, and the only way to learn the truth is to press one.
		await render(false);
		for (const key of GATED) {
			expect(byKey(key).disabled, `${key} still invites a click that can only 400`).toBe(true);
		}
	});

	it('⛔ …AND THEY ARE STILL ON SCREEN — hidden would have been the cheaper, worse fix', async () => {
		// A control that vanishes leaves the reader unable to tell "this workspace cannot do that" from
		// "I am looking at the wrong row". `{#if false}` would satisfy nothing here.
		await render(false);
		for (const key of GATED) {
			expect(
				[...host.querySelectorAll('button')].map((b) => b.textContent?.trim()),
				`${key} was hidden rather than explained`
			).toContain(key);
		}
	});

	it('⛔ the REASON is on screen, not only in a title a disabled button cannot fire', async () => {
		// Half of the doctrine `VoteButton.svelte` records: a `title` is neither keyboard-reachable nor
		// reliably announced, and on a DISABLED element it never surfaces at all — which is why the
		// tooltip sits on a wrapper AND the sentence is stated plainly once.
		await render(false);
		const line = notice();
		expect(line, 'nothing on screen says why the three controls are inert').not.toBeNull();
		expect(line!.textContent).toContain('error_notifications_disabled');
		expect(line!.getAttribute('role'), 'nothing failed — this is a capability, not an alert').toBe(
			'status'
		);

		// …and the tooltip is on the WRAPPER, never on the button itself.
		const wrap = byKey('connectors_verify').closest('.gate-wrap');
		expect(wrap, 'the gated control has no wrapper to carry its reason').not.toBeNull();
		expect(wrap!.getAttribute('title')).toBe('error_notifications_disabled');
	});

	it('⚠️ SYNC IS UNTOUCHED — the gate is the capability, not "everything on the row"', async () => {
		// The over-correction guard. `POST /api/connectors/:slug/sync` answers no
		// `notifications_disabled`; disabling it would break a working control to fix a broken one.
		await render(false);
		expect(byKey(UNGATED).disabled, 'a control the flag does not gate was disabled too').toBe(false);
	});
});

describe('/connectors when notifications ARE available', () => {
	it('⛔ all three are live and nothing is explained away', async () => {
		// The complement, and the one a blunt fix breaks: `disabled` unconditionally, or a notice that
		// always renders, satisfies every case above.
		await render(true);
		for (const key of GATED) {
			expect(byKey(key).disabled, `${key} is disabled on a workspace that supports it`).toBe(false);
		}
		expect(notice(), 'a capability that is ON was reported as off').toBeNull();
	});

	it('⚠️ AN OLDER BACKEND THAT OMITS THE FIELD IS TREATED AS ENABLED', async () => {
		// The direction matters. Reading an absent field as `false` would grey out three WORKING
		// controls through every rolling deploy; reading it as `true` costs at worst one click that
		// now lands on a localized refusal (below).
		await render(undefined);
		for (const key of GATED) {
			expect(byKey(key).disabled, `${key} was disabled by a MISSING field`).toBe(false);
		}
		expect(notice()).toBeNull();
	});
});

describe('⛔ and the click that still gets through says WHY', () => {
	it('the 400 renders the notifications sentence, not the generic "action failed"', async () => {
		// REVERT THAT TURNS THIS RED: `actionError = errorText(e, m.error_action_failed())` in
		// `verify`. `errorText` maps no 400 at all — it handles 402/403/409-seat/503/401 — so the
		// refusal came out as `error_action_failed`, "Dat is niet gelukt. Probeer het opnieuw.",
		// advising a retry that can never work.
		//
		// ⚠️ THE PATH IS REAL: `$lib/api/error-message` is NOT mocked in this file, so the sentence
		// below is chosen by the same `VALIDATION_MESSAGES` table production uses.
		await render(undefined); // enabled as far as the client knows — the button is live
		verifyNotifications.mockRejectedValue(
			new ApiError(400, 'notifications_disabled', 'self-serve notifications are not enabled')
		);

		// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
		byKey('connectors_verify').dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle();

		const err = actionError();
		expect(err, 'the refused action reported nothing at all').not.toBeNull();
		expect(err!.textContent).toContain('error_notifications_disabled');
		expect(
			err!.textContent,
			'the reader is still told to try again at something that cannot succeed'
		).not.toContain('error_action_failed');
	});
});
