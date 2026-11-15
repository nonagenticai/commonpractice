// @vitest-environment jsdom
//
// src/lib/layout/notification-bell.load-failure.render.test.ts — what the panel says when the feed
// could not be fetched.
//
// ⛔ THE DEFECT: A BADGE READING "3" OVER THE WORDS "GEEN MELDINGEN".
//
// `stores/notifications.svelte.ts` had two catch blocks that disagreed without anyone noticing:
//
//   refreshCount()  catch → keep the last known count      (correct, and deliberate)
//   load()          catch → "leave whatever was already shown"
//
// ⚠️ THE SECOND COMMENT IS NOT WRONG, IT IS INCOMPLETE, and the distinction matters because the
// naive fix is to delete the behaviour it describes. On a REPEAT open it is exactly right: the
// reader had a list a moment ago, the refresh failed, and blanking a readable list to report a
// transient fetch would be a regression. What it never considered is the FIRST open, where
// "whatever was already shown" is the initial `items = []`. The panel's branches were
// loading → empty → list, so an empty list after a FAILED load took the empty branch and stated,
// as a fact, "Niets nieuws." — while the badge above it, kept alive by the other catch, still read
// the unread count the poll had already succeeded in fetching.
//
// The store now carries `error`, and the panel reads it TOGETHER WITH `items`, because "there is
// nothing to show" and "what is shown is stale" are two different facts and deserve two different
// sentences. Both are asserted here.
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
		if (typeof value !== 'string') {
			mod[key] = () => `[plural:${key}]`;
			continue;
		}
		mod[key] = (params?: Record<string, unknown>) =>
			value.replace(/\{(\w+)\}/g, (whole, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	// A key missing from nl.json is `undefined` here and calling it throws — see the long note in
	// `notification-bell.i18n.render.test.ts`.
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

/** The Dutch the panel is supposed to say, straight out of `messages/nl.json`. */
const NL = {
	empty: 'Niets nieuws.',
	failed: 'Meldingen konden niet worden geladen.',
	stale: 'Vernieuwen is mislukt — dit is de laatst geladen lijst.'
};

const TS = new Date(Date.now() - 5 * 60_000).toISOString();

/**
 * A feed row, deliberately WITHOUT `data`.
 *
 * ⚠️ Not an oversight and not a shortcut. This file's assertions are about row IDENTITY — "are
 * these two specific rows still on screen after the failed refresh" — and a row that carries `data`
 * renders the catalog sentence for its rung, so two rows would render identical text and prove
 * nothing about which of them survived. With no `data` the label module returns `title` verbatim
 * (the pre-0066 fallback, and a perfectly real wire shape), so each row is legible and distinct.
 * The localized path is `notification-bell.i18n.render.test.ts`'s subject, not this file's.
 */
function row(id: string, title: string): AppNotification {
	return {
		id,
		kind: 'budget.threshold',
		severity: 'warn',
		title,
		body: null,
		href: '/llm-settings',
		read: false,
		createdAt: TS
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	list.mockReset();
	unreadCount.mockReset();
	markRead.mockReset();
	markAllRead.mockReset();
	// ⚠️ THE POLL SUCCEEDS. That is the whole shape of the bug: the count and the list are two
	// different requests, and the one that feeds the badge is the cheap one that keeps working.
	unreadCount.mockResolvedValue({ unread: 3 });
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

async function mountBell() {
	app = mount(Bell, { target: host, props: {} });
	flushSync();
	// onMount → start() → refreshCount(); let the badge's own request land.
	await Promise.resolve();
	await Promise.resolve();
	flushSync();
	return host;
}

/** Open the panel through the real path: toggle → store.load → API → render. */
async function open(el: HTMLElement) {
	await notifications.toggle();
	flushSync();
	await Promise.resolve();
	flushSync();
	return el;
}

/**
 * ⛔ THE ANTI-VACUITY GATE. The panel lives behind `{#if notifications.open}`. If `toggle()` never
 * resolved, the document contains neither "Niets nieuws." nor the error line, and an assertion that
 * the empty text is absent passes while proving nothing. So: prove the panel is OPEN, and that the
 * failing call was actually made.
 */
function assertPanelOpen(el: HTMLElement) {
	expect(list, 'the list API was never called').toHaveBeenCalled();
	expect(el.querySelector('.panel'), 'the panel never opened').not.toBeNull();
	expect(el.querySelector('.panel-title')?.textContent).toBe('Meldingen');
	expect(el.querySelector('.msg')?.textContent ?? '', 'still in the loading branch').not.toBe(
		'Laden…'
	);
}

// ==================================================================================================
// 1. THE FIRST OPEN. `items` is `[]` because nothing has ever loaded — not because there is nothing.
// ==================================================================================================
describe('a FIRST open whose load fails', () => {
	it('⛔ says the list could not be loaded — NOT "Niets nieuws."', async () => {
		// RED AGAINST THE ORIGINAL `catch {}`: with no `error` state and only a
		// loading → empty → list ladder, this renders "Niets nieuws." and the two assertions below
		// invert. Measured by reverting both files, not assumed.
		list.mockRejectedValue(new Error('Failed to fetch'));
		const el = await open(await mountBell());
		assertPanelOpen(el);

		expect(el.textContent).toContain(NL.failed);
		expect(
			el.textContent,
			'the panel told the reader there is nothing to catch up on, when in fact it never found out'
		).not.toContain(NL.empty);
	});

	it('⛔ does it while the badge still reads 3 — the combination that made it a lie', async () => {
		// The two halves are what make this worth a test rather than a comment. Either alone is
		// defensible; together they are a screen that contradicts itself in 340px.
		list.mockRejectedValue(new Error('Failed to fetch'));
		const el = await open(await mountBell());
		assertPanelOpen(el);

		expect(unreadCount, 'the cheap poll never ran, so the badge proves nothing').toHaveBeenCalled();
		expect(el.querySelector('.badge')?.textContent, 'no unread badge was rendered').toBe('3');
		expect(el.textContent).toContain(NL.failed);
		expect(el.textContent).not.toContain(NL.empty);
	});

	it('marks the failure as an alert for a screen reader, not a silent paragraph', async () => {
		list.mockRejectedValue(new Error('Failed to fetch'));
		const el = await open(await mountBell());
		assertPanelOpen(el);
		expect(el.querySelector('[role="alert"]')?.textContent).toBe(NL.failed);
	});

	it('renders NO row and no half-built message', async () => {
		list.mockRejectedValue(new Error('Failed to fetch'));
		const el = await open(await mountBell());
		assertPanelOpen(el);
		expect(el.querySelectorAll('.item')).toHaveLength(0);
		expect(el.textContent).not.toContain('undefined');
	});

	it('still says "Niets nieuws." when the load SUCCEEDS and there is genuinely nothing', async () => {
		// ⛔ THE COMPLEMENT, AND THE REASON THE FIX IS `error && length === 0` RATHER THAN JUST
		// REPLACING THE EMPTY BRANCH. An empty feed is a real, common, correct state — a new
		// workspace has no notifications — and it must keep saying so. A fix that reports a fetch
		// failure to every new user would be a worse bug than the one being fixed.
		list.mockResolvedValue({ notifications: [], unread: 0 });
		const el = await open(await mountBell());
		assertPanelOpen(el);
		expect(el.textContent).toContain(NL.empty);
		expect(el.textContent).not.toContain(NL.failed);
	});
});

// ==================================================================================================
// 2. THE REPEAT OPEN. This is the case the original comment was protecting, and it must not regress.
// ==================================================================================================
describe('a REPEAT open whose refresh fails', () => {
	it('⛔ KEEPS the rows it already had — the behaviour the original comment was right about', async () => {
		// REVERT THAT TURNS THIS RED: `catch { this.items = []; this.error = true; }`. Blanking a
		// readable list to report a transient fetch destroys content the reader can still use, and is
		// the obvious over-correction to make while fixing the first-open case.
		list.mockResolvedValueOnce({
			notifications: [row('a', 'Welkomstbudget bijna op'), row('b', 'Tweede melding')],
			unread: 2
		});
		const el = await mountBell();
		await open(el); // first open succeeds
		expect(el.querySelectorAll('.item')).toHaveLength(2);

		notifications.open = false;
		flushSync();
		list.mockRejectedValue(new Error('Failed to fetch'));
		await open(el); // second open fails
		assertPanelOpen(el);

		expect(el.querySelectorAll('.item'), 'the preserved list was thrown away').toHaveLength(2);
		expect(el.textContent).toContain('Welkomstbudget bijna op');
		expect(el.textContent).toContain('Tweede melding');
		// …and it does NOT claim there is nothing, nor that nothing could be loaded: something was.
		expect(el.textContent).not.toContain(NL.empty);
		expect(el.textContent).not.toContain(NL.failed);
	});

	it('says the rows are STALE — the honest half of preserving them', async () => {
		// Preserving the list silently is the OTHER dishonest option: the reader is looking at a
		// snapshot and has no way to tell. Two states, two sentences.
		list.mockResolvedValueOnce({ notifications: [row('a', 'Welkomstbudget bijna op')], unread: 1 });
		const el = await mountBell();
		await open(el);
		notifications.open = false;
		flushSync();
		list.mockRejectedValue(new Error('Failed to fetch'));
		await open(el);
		assertPanelOpen(el);

		expect(el.querySelector('.msg.stale')?.textContent).toBe(NL.stale);
		expect(el.querySelector('[role="status"]')?.textContent).toBe(NL.stale);
		// The note is a caveat ON the rows, so the rows are still there and still first-class.
		expect(el.querySelectorAll('.item')).toHaveLength(1);
	});

	it('shows NO stale note while the rows are fresh', async () => {
		// The complement: a note that is always on says nothing.
		list.mockResolvedValue({ notifications: [row('a', 'Welkomstbudget bijna op')], unread: 1 });
		const el = await open(await mountBell());
		assertPanelOpen(el);
		expect(el.querySelector('.msg.stale')).toBeNull();
		expect(el.textContent).not.toContain(NL.stale);
	});

	it('CLEARS the failure once a later open succeeds', async () => {
		// `error` is a fact about the LAST load, not a sticky flag — a recovered panel must stop
		// apologising. REVERT THAT TURNS THIS RED: drop `this.error = false` from the try block.
		list.mockRejectedValueOnce(new Error('Failed to fetch'));
		const el = await mountBell();
		await open(el);
		expect(el.textContent).toContain(NL.failed);

		notifications.open = false;
		flushSync();
		list.mockResolvedValue({ notifications: [row('a', 'Welkomstbudget bijna op')], unread: 1 });
		await open(el);
		assertPanelOpen(el);

		expect(el.textContent).not.toContain(NL.failed);
		expect(el.textContent).not.toContain(NL.stale);
		expect(el.querySelectorAll('.item')).toHaveLength(1);
	});
});

// ==================================================================================================
// 3. THE POLL'S OWN catch IS UNCHANGED, and that is deliberate.
// ==================================================================================================
describe('the unread poll stays quiet on its own', () => {
	it('does not put the panel into the error state when only the COUNT fails', async () => {
		// A failed background poll is genuinely invisible: the badge keeps its last value and no panel
		// is open to say anything in. Wiring `refreshCount` into `error` would make an open panel
		// full of perfectly good rows start apologising once a minute.
		unreadCount.mockRejectedValue(new Error('Failed to fetch'));
		list.mockResolvedValue({ notifications: [row('a', 'Welkomstbudget bijna op')], unread: 1 });
		const el = await open(await mountBell());
		assertPanelOpen(el);

		expect(notifications.error).toBe(false);
		expect(el.textContent).not.toContain(NL.failed);
		expect(el.textContent).not.toContain(NL.stale);
		expect(el.querySelectorAll('.item')).toHaveLength(1);
	});
});
