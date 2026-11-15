// @vitest-environment jsdom
//
// src/routes/(tenant)/delivery/delivery-page.jira-partial-credentials.render.test.ts —
// editing ONE of Jira's two credential fields destroyed the stored API token.
//
// ⛔ THE DEFECT. `credentials()` returned `undefined` (= "keep what is stored") only when BOTH
// Jira fields were blank. Fill just the e-mail and the page shipped `{ email, apiToken: '' }`.
// `PATCH /api/delivery-targets/:id` takes `credentials` as an opaque `z.record`
// (backend/src/routes/delivery.ts) and re-encrypts whatever it is handed — so the token was
// REPLACED BY AN EMPTY STRING.
//
// ⛔ EVERY SIGNAL THE ADMIN COULD SEE SAID IT WORKED. The banner read `delivery_saved`; the
// connector row still read `delivery_credentials_set`, because a blob genuinely exists — it is
// merely useless. The failure surfaced later, on another screen, as a Forward that could not
// authenticate. That is the whole reason this file asserts the REQUEST BODY and not the banner:
// the banner was never the thing that lied about the token.
//
// ⛔ THE HINT UNDER THE FIELDS IS PART OF THE CONTRACT. `delivery_credentials_hint` promises
// "Leave blank to keep the current credentials." The blank-both case below is what makes that
// sentence true, and it is asserted as hard as the defect case — a "fix" that simply always sends
// the pair would be red there.
//
// ⛔ `azure_devops` IS THE CONTROL. It has one credential field and its guard was always correct;
// the last case pins that this change did not spill into the kinds that were never broken.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';
import type { DeliveryTarget } from '$lib/api/delivery';

// Real `en` catalog, each key resolving to its own name — the assertions are about WHICH key the
// banner reads, never the wording.
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

const { listTargets, updateTarget, createTarget } = vi.hoisted(() => ({
	listTargets: vi.fn(),
	updateTarget: vi.fn(),
	createTarget: vi.fn()
}));
// ⛔ ALIAS ids, never relative ones — a relative mock id resolves to a different module record
// than the one the page imports and silently does nothing.
vi.mock('$lib/api/delivery', () => ({
	deliveryApi: {
		list: listTargets,
		create: createTarget,
		update: updateTarget,
		remove: vi.fn(),
		test: vi.fn()
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
		// The state that makes the destroy possible: a token IS stored, and the form never shows it.
		hasCredentials: true,
		createdAt: '2026-06-01T09:00:00.000Z',
		updatedAt: '2026-06-01T09:00:00.000Z'
	}) as DeliveryTarget;

const JIRA = target('t-jira', 'jira', 'Jira · backlog');
const ADO = target('t-ado', 'azure_devops', 'Azure DevOps');

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	listTargets.mockReset();
	updateTarget.mockReset();
	createTarget.mockReset();
	updateTarget.mockResolvedValue(undefined);
	createTarget.mockResolvedValue(undefined);
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

/** ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root, so a non-bubbling
 *  synthetic event silently skips the handler and every assertion below passes for free. */
async function click(el: HTMLElement) {
	el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await tick();
	flushSync();
}

/** Type into a `bind:value` input the way a user does: assign, then fire `input`. */
async function type(id: string, value: string) {
	const el = host.querySelector<HTMLInputElement>(`#${id}`);
	expect(el, `#${id} is not on the form — the case cannot be what it claims`).not.toBeNull();
	el!.value = value;
	el!.dispatchEvent(new Event('input', { bubbles: true }));
	await tick();
	flushSync();
}

/** Press "Edit" on the Nth connector row (second `.btn-link` in its actions). */
async function startEdit(row: number) {
	const links = host.querySelectorAll<HTMLButtonElement>('.target-row')[row]!
		.querySelectorAll<HTMLButtonElement>('.target-actions .btn-link');
	expect(links.length, 'the row actions changed shape').toBeGreaterThanOrEqual(2);
	await click(links[1]!);
	expect(
		host.querySelector('form h2')?.textContent,
		'the form is not in edit mode — a create body would prove nothing about the stored blob'
	).toBe('delivery_form_edit');
}

async function submit() {
	const form = host.querySelector('form')!;
	form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
}

const bannerText = () => host.querySelector('.banner')?.textContent?.trim() ?? null;
const bannerIsError = () => !!host.querySelector('.banner.error');

describe('the Jira credential pair', () => {
	it('THE DEFECT: filling only the e-mail must never ship an empty apiToken', async () => {
		await render([JIRA]);
		await startEdit(0);
		await type('jira-email', 'new.admin@example.com');
		// jira-token deliberately left blank — the "I only want to change my e-mail" case.
		await submit();

		// The precise destroy: a credentials bag whose apiToken is the empty string.
		const shipped = updateTarget.mock.calls.map((c) => c[1]);
		for (const body of shipped) {
			expect(
				(body as { credentials?: { apiToken?: unknown } }).credentials?.apiToken,
				'the stored Jira API token was overwritten with an empty string'
			).not.toBe('');
		}
		// …and the chosen behaviour: refuse, name the missing field, write nothing.
		expect(updateTarget, 'a half credential reached the server at all').not.toHaveBeenCalled();
		expect(bannerIsError(), 'the refusal was not shown as an error').toBe(true);
		expect(bannerText()).toBe(`blockerr_field_required:\u2068delivery_jira_token_label\u2069`);
		expect(bannerText(), 'the save reported success').not.toBe('delivery_saved');
	});

	it('THE MIRROR CASE: filling only the token must never ship an empty e-mail', async () => {
		await render([JIRA]);
		await startEdit(0);
		await type('jira-token', 'atl-new-token');
		await submit();

		for (const body of updateTarget.mock.calls.map((c) => c[1])) {
			expect(
				(body as { credentials?: { email?: unknown } }).credentials?.email,
				'the stored Jira account e-mail was overwritten with an empty string'
			).not.toBe('');
		}
		expect(updateTarget).not.toHaveBeenCalled();
		expect(bannerText()).toBe(`blockerr_field_required:\u2068delivery_jira_email_label\u2069`);
	});

	it('THE HINT MUST STAY TRUE: both blank saves the rest and sends no credentials key at all', async () => {
		// ⛔ THE OVER-CORRECTION GUARD. "Always require both" satisfies the two cases above and
		// breaks the documented promise under the fields (`delivery_credentials_hint`): an admin
		// renaming a connector would be forced to re-type a token the form never shows them.
		await render([JIRA]);
		await startEdit(0);
		await type('name', 'Jira · renamed');
		await submit();

		expect(updateTarget).toHaveBeenCalledTimes(1);
		const [id, body] = updateTarget.mock.calls[0]!;
		expect(id).toBe('t-jira');
		expect((body as { name: string }).name).toBe('Jira · renamed');
		expect(
			Object.hasOwn(body as object, 'credentials'),
			'a blank-both save still sent a credentials key — the stored blob would be replaced'
		).toBe(false);
		expect(bannerText()).toBe('delivery_saved');
	});

	it('both filled ships the complete pair', async () => {
		await render([JIRA]);
		await startEdit(0);
		await type('jira-email', 'new.admin@example.com');
		await type('jira-token', 'atl-new-token');
		await submit();

		expect(updateTarget).toHaveBeenCalledTimes(1);
		expect((updateTarget.mock.calls[0]![1] as { credentials: unknown }).credentials).toEqual({
			email: 'new.admin@example.com',
			apiToken: 'atl-new-token'
		});
		expect(bannerText()).toBe('delivery_saved');
	});

	it('THE CONTROL: azure_devops, the kind that was never broken, is unchanged', async () => {
		await render([ADO]);
		await startEdit(0);
		await type('ado-pat', 'pat-value');
		await submit();
		expect((updateTarget.mock.calls[0]![1] as { credentials: unknown }).credentials).toEqual({
			pat: 'pat-value'
		});

		updateTarget.mockClear();
		await startEdit(0);
		await type('name', 'ADO renamed');
		await submit();
		expect(Object.hasOwn(updateTarget.mock.calls[0]![1] as object, 'credentials')).toBe(false);
	});

	it('the two Jira inputs advertise that they move together', async () => {
		// The banner is the refusal; `required` is the affordance that stops the admin reaching it.
		await render([JIRA]);
		await startEdit(0);
		const email = () => host.querySelector<HTMLInputElement>('#jira-email')!;
		const token = () => host.querySelector<HTMLInputElement>('#jira-token')!;
		expect(email().required, 'an untouched form must not nag').toBe(false);
		expect(token().required).toBe(false);

		await type('jira-email', 'a@b.c');
		expect(token().required, 'the token is not marked required once the e-mail is filled').toBe(true);
		expect(email().required).toBe(false);

		await type('jira-email', '');
		await type('jira-token', 'atl-x');
		expect(email().required, 'the e-mail is not marked required once the token is filled').toBe(true);
		expect(token().required).toBe(false);
	});
});
