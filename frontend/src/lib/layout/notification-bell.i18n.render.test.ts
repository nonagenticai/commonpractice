// @vitest-environment jsdom
//
// src/lib/layout/notification-bell.i18n.render.test.ts — the topbar bell panel, in Dutch, with the
// backend answering exactly what production answers.
//
// ⛔ THE DEFECT, end to end. `NotificationBell.svelte:90-91` rendered `{n.title}` and `{n.body}`
// verbatim, and `backend/src/routes/notifications.ts` `toView` passed both through with no locale
// negotiation at all. Those sentences are composed in `backend/src/host/budget-service.ts`
// `alertCopy` as ENGLISH, so a Dutch reader got "90% of the welcome budget used" under a heading
// reading "Meldingen", beside a button reading "Alles als gelezen markeren". The sharpest edge is
// the last sentence of every body: "open Administer → LLM settings", pointing at a sidebar that
// says "Beheren → LLM-instellingen".
//
// ⚠️ THIS FILE MOCKS THE MESSAGES MODULE FROM `messages/nl.json` AND INTERPOLATES FOR REAL — unlike
// `it-dash-page.i18n.render.test.ts`, which returns each key's own NAME. That technique states
// which message a region resolved without pinning copy a translator may reword, and it is the right
// one there. It cannot answer the question THIS file exists to ask, which is "does a Dutch reader
// see Dutch": a document full of `notification_budget_low_body` tokens contains no English prose
// either, so every `not.toContain(english)` would pass on a build that renders nothing but keys.
// The cost is that reworded Dutch copy reddens this file. That is the intended trade: the
// assertions below are the copy's contract with the reader, and the DUTCH WORDS are the subject.
// Message SELECTION, plural categories and the fallback ladder are pinned key-by-key in
// `i18n/notification-label.test.ts`, which is where a copy edit is free.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { AppNotification } from '$lib/types/admin';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(catalog)) {
		if (key === '$schema') continue;
		// A plural entry is an ARRAY of ICU variants in these catalogs. None of the bell's keys are
		// plural, and turning one into a marker rather than guessing a category keeps that true
		// loudly: a `[plural:…]` in the document is a signal to come back here, not a silent pass.
		if (typeof value !== 'string') {
			mod[key] = () => `[plural:${key}]`;
			continue;
		}
		mod[key] = (params?: Record<string, unknown>) =>
			value.replace(/\{(\w+)\}/g, (whole, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	// ⛔ NO DEFAULT-EXPORT PROXY AND NO FALLBACK. A key missing from nl.json is `undefined` here, and
	// calling it throws — which is what should happen. Returning the key name instead would let a
	// message that exists in en.json and NOT in nl.json render as a token and pass every assertion
	// below. (`i18n/catalogs.test.ts` guards the key sets; this is the second lock on the same door.)
	return mod;
});

const { list, unreadCount, markRead, markAllRead } = vi.hoisted(() => ({
	list: vi.fn(),
	unreadCount: vi.fn(),
	markRead: vi.fn(),
	markAllRead: vi.fn()
}));
vi.mock('$lib/api/notifications', () => ({
	notificationsApi: { list, unreadCount, markRead, markAllRead }
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

import Bell from './NotificationBell.svelte';
import { notifications } from '$lib/stores/notifications.svelte';

const TS = new Date(Date.now() - 5 * 60_000).toISOString(); // "5 min geleden"

/**
 * ⛔ THE ENGLISH `alertCopy` COMPOSES, COPIED VERBATIM out of
 * `backend/src/host/budget-service.ts:538-578`. These are the strings the row really carries — the
 * fixtures below populate `title`/`body` with them, exactly as the backend still writes them, so
 * the "no English" assertions are testing against the real thing and not a strawman.
 */
const EN = {
	title75: '75% of the welcome budget used',
	title90: '90% of the welcome budget used',
	title100: 'Welcome budget used up',
	body75:
		'$12.50 of the $50.00 welcome budget for Acme Verzekeringen is left. Nothing is blocked yet — this is a heads-up so you can plan.',
	body90:
		'$4.10 of the $50.00 welcome budget for Acme Verzekeringen is left. Model calls stop when it reaches zero.',
	body100:
		'The $50.00 welcome budget for Acme Verzekeringen is fully consumed, and model calls on the platform key are now being refused.',
	howTo:
		'To keep working, open Administer → LLM settings and either add your own OpenRouter API key or switch to any other provider (Anthropic, OpenAI, DeepSeek, Grok, Cohere, or your own OpenAI-compatible endpoint). Your flows and blocks keep working unchanged — only the credentials behind them change.'
};

/** The NEW payload: machine `data` AND the English prose, exactly as the backend ships it. */
function dto(): AppNotification[] {
	return [
		{
			id: 'n-100',
			kind: 'budget.threshold',
			severity: 'critical',
			title: EN.title100,
			body: `${EN.body100} ${EN.howTo}`,
			href: '/llm-settings',
			read: false,
			createdAt: TS,
			data: {
				threshold: 100,
				tenantName: 'Acme Verzekeringen',
				limitUsd: 50,
				// ⛔ ZERO, and it is the whole point of this alert. A truthiness presence check in the
				// label module drops this row — the most urgent one CP sends — into English.
				remainingUsd: 0
			}
		},
		{
			id: 'n-90',
			kind: 'budget.threshold',
			severity: 'critical',
			title: EN.title90,
			body: `${EN.body90} ${EN.howTo}`,
			href: '/llm-settings',
			read: false,
			createdAt: TS,
			data: { threshold: 90, tenantName: 'Acme Verzekeringen', limitUsd: 50, remainingUsd: 4.1 }
		},
		{
			id: 'n-75',
			kind: 'budget.threshold',
			severity: 'warn',
			title: EN.title75,
			body: `${EN.body75} ${EN.howTo}`,
			href: '/llm-settings',
			read: true,
			createdAt: TS,
			data: { threshold: 75, tenantName: 'Acme Verzekeringen', limitUsd: 50, remainingUsd: 12.5 }
		}
	];
}

/**
 * ⛔ THE VERBATIM PRE-0066 PAYLOAD. Not "the new DTO with some fields cleared" — the exact object
 * `git show HEAD~:backend/src/routes/notifications.ts` `toView` produces: no `data` key at all.
 *
 * This is what a NEW frontend gets from an OLD pod while the Deployment rolls (the browser reaches
 * the API through the k8s Service, which load-balances across both) — AND, unlike /it-dash, it is
 * also what it gets from a NEW pod forever, for every row inserted before migration 0066. Those
 * rows cannot be backfilled: `remainingUsd` came from a live OpenRouter response at alert time.
 */
function legacyDto(): AppNotification[] {
	return dto().map(({ data: _drop, ...rest }) => rest);
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	list.mockReset();
	unreadCount.mockReset();
	markRead.mockReset();
	markAllRead.mockReset();
	unreadCount.mockResolvedValue({ unread: 2 });
	list.mockResolvedValue({ notifications: dto(), unread: 2 });
	// The store is a module singleton shared by every test in this file — reset the state a previous
	// test left behind, or an assertion here passes on the last test's data.
	notifications.items = [];
	notifications.unread = 0;
	notifications.error = false;
	notifications.open = false;
	notifications.loading = false;
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

/** Mount the bell and OPEN the panel through the real path: toggle → store.load → API → render. */
async function open() {
	app = mount(Bell, { target: host, props: {} });
	flushSync();
	await notifications.toggle();
	flushSync();
	await Promise.resolve();
	flushSync();
	return host;
}

/**
 * ⛔ THE ANTI-VACUITY GATE, used by every assertion in this file.
 *
 * The panel lives behind `{#if notifications.open}` and starts closed. If `toggle()` never resolved,
 * or the mocked API never answered, the document contains none of the English prose — and every
 * `not.toContain` below passes while asserting nothing at all. So: prove the panel is OPEN and has
 * the expected number of ROWS in it, by positive markers only the loaded list renders.
 */
function assertPanelOpen(el: HTMLElement, rows: number) {
	expect(list, 'the list API was never called').toHaveBeenCalled();
	expect(el.querySelector('.panel'), 'the panel never opened').not.toBeNull();
	expect(el.querySelector('.panel-title')?.textContent).toBe('Meldingen');
	expect(el.querySelectorAll('.item')).toHaveLength(rows);
}

describe('the bell panel renders no English inside its Dutch frame', () => {
	it('shows not one of the backend’s English sentences', async () => {
		const el = await open();
		assertPanelOpen(el, 3);
		const offenders = Object.entries(EN).filter(([, s]) => el.textContent!.includes(s));
		expect(offenders.map(([k]) => k)).toEqual([]);
	});

	it('renders each rung’s TITLE in Dutch', async () => {
		const el = await open();
		assertPanelOpen(el, 3);
		expect([...el.querySelectorAll('.title')].map((n) => n.textContent)).toEqual([
			'Welkomstbudget op',
			'90% van het welkomstbudget gebruikt',
			'75% van het welkomstbudget gebruikt'
		]);
	});

	it('renders each rung’s BODY in Dutch, with the real numbers in it', async () => {
		const el = await open();
		assertPanelOpen(el, 3);
		const texts = [...el.querySelectorAll('.text')].map((n) => n.textContent);
		expect(texts[0]).toContain(
			'Het welkomstbudget van $50.00 voor Acme Verzekeringen is volledig verbruikt'
		);
		// The 90 and 75 rungs say DIFFERENT things — not one sentence with a different number.
		expect(texts[1]).toContain('Er is nog $4.10 over van het welkomstbudget van $50.00');
		expect(texts[1]).toContain('Bij nul stoppen de modelaanroepen.');
		expect(texts[2]).toContain('Er is nog $12.50 over van het welkomstbudget van $50.00');
		expect(texts[2]).toContain('Er wordt nog niets geblokkeerd');
		// …and nothing rendered a half-interpolated message.
		for (const t of texts) expect(t).not.toContain('undefined');
		for (const t of texts) expect(t).not.toContain('{');
	});

	it('⛔ points the reader at the DUTCH menu items the sidebar actually shows', async () => {
		// THE SHARPEST EDGE OF THE WHOLE DEFECT: the English body said "open Administer → LLM
		// settings" while the sidebar beside it rendered "Beheren → LLM-instellingen". A wrong
		// instruction, not merely an untranslated one.
		// ⚠️ AND THEN THE MENU MOVED: there is no Beheren group any more. LLM settings sits behind the
		// settings gear → Organisatie, and the sentence is built from those three labels.
		const el = await open();
		assertPanelOpen(el, 3);
		for (const t of [...el.querySelectorAll('.text')].map((n) => n.textContent!)) {
			expect(t).toContain('Instellingen → Organisatie → LLM-instellingen');
			expect(t).not.toContain('Beheren');
			expect(t).not.toContain('Administer → LLM settings');
		}
	});

	it('⛔ renders the 100 % rung, whose `remainingUsd` is 0, from the catalog', async () => {
		// The truthiness trap, at render level: `!d.remainingUsd` would send exactly this row — the
		// one that says model calls have STOPPED — back to English.
		const el = await open();
		assertPanelOpen(el, 3);
		const first = el.querySelector('.item .text')!.textContent!;
		expect(first).toContain('volledig verbruikt');
		expect(first).not.toContain('fully consumed');
	});

	it('leaves the surrounding chrome localized too', async () => {
		const el = await open();
		assertPanelOpen(el, 3);
		expect(el.textContent).toContain('Alles als gelezen markeren');
		expect(el.textContent).toContain('5 min geleden');
	});
});

// ==================================================================================================
// ⛔ THE MIDDLE BRANCH — an OLD pod mid-roll, and every row written before 0066, forever.
// ==================================================================================================
describe('⛔ a notification with NO `data`', () => {
	it('renders the backend English — every row present and non-blank', async () => {
		list.mockResolvedValue({ notifications: legacyDto(), unread: 2 });
		const el = await open();

		// 1. The panel did not collapse, and all three rows are there. A duplicate-key or a throw in
		//    the label module shows up as rows COLLAPSING, so count them rather than trusting the
		//    absence of an exception (there is no <svelte:boundary> anywhere in this tree).
		assertPanelOpen(el, 3);

		// 2. Every row says something the reader can act on. The catalog messages cannot resolve
		//    without `data`, so the English IS the correct answer here — blank rows would be a
		//    different failure wearing the same green.
		const rowText = [...el.querySelectorAll('.item')].map((n) => n.textContent ?? '');
		expect(rowText.every((t) => t.trim().length > 0), 'a row rendered blank').toBe(true);
		expect(rowText[1]).toContain(EN.title90);
		expect(rowText[1]).toContain('Model calls stop when it reaches zero.');
		expect(rowText.join(' | ')).not.toContain('undefined');
		// ⛔ NOT the raw kind. An alerting surface that degrades to `budget.threshold` tells the
		// reader nothing; the English sentence tells them everything except in their own language.
		expect(rowText.join(' | ')).not.toContain('budget.threshold');

		// 3. And the frame around them is still Dutch — the fallback is scoped to the rows.
		expect(el.textContent).toContain('Meldingen');
		expect(el.textContent).toContain('Alles als gelezen markeren');
	});

	it('falls back per-ROW, not per-panel, when only some rows are old', async () => {
		// The genuinely mixed feed: one row written before 0066 sitting above two written after. This
		// is the ordinary state of a workspace's history, not an edge case.
		const mixed = [{ ...legacyDto()[1]!, id: 'n-old' }, ...dto().slice(0, 2)];
		list.mockResolvedValue({ notifications: mixed, unread: 3 });
		const el = await open();
		assertPanelOpen(el, 3);
		const titles = [...el.querySelectorAll('.title')].map((n) => n.textContent);
		expect(titles).toEqual([
			EN.title90, // no data → prose
			'Welkomstbudget op', // data → Dutch
			'90% van het welkomstbudget gebruikt'
		]);
	});
});

describe('⛔ a notification of an UNRECOGNISED kind', () => {
	it('renders its prose, because a kind can ship backend-first', async () => {
		// `notifications.kind` is a bare `text()` column with no enum and no CHECK, and 0044 kept the
		// table generic on purpose. A second alert kind WILL arrive before this file knows it.
		list.mockResolvedValue({
			notifications: [
				{
					id: 'n-x',
					kind: 'member.invited',
					severity: 'info',
					title: 'Lisa de Vries was invited',
					body: 'They will appear in Members once they accept.',
					href: '/members',
					read: false,
					createdAt: TS
				}
			] as unknown as AppNotification[],
			unread: 1
		});
		const el = await open();
		assertPanelOpen(el, 1);
		expect(el.querySelector('.title')!.textContent).toBe('Lisa de Vries was invited');
		expect(el.querySelector('.text')!.textContent).toBe(
			'They will appear in Members once they accept.'
		);
		expect(el.textContent).not.toContain('member.invited');
		// The Dutch frame is untouched — an unknown row does not take the panel down with it.
		expect(el.querySelector('.panel-title')!.textContent).toBe('Meldingen');
		expect(el.textContent).toContain('5 min geleden');
	});
});
