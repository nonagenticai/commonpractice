// @vitest-environment jsdom
//
// src/routes/governance/governance-page.empty-allowlist.render.test.ts — clearing the allowlist box
// must not look like it worked.
//
// ⛔ THE BACKEND HALF IS THE FIX; THIS IS THE HALF THAT MAKES IT LEGIBLE. `validateValue`'s `list`
// branch accepted `[]` with no floor, so emptying the "Allowlisted models" box committed an empty
// array — and the broker's gate is `allowlist && allowlist.length > 0 && !allowlist.includes(model)`,
// so an empty list SKIPS the check and every model becomes permitted. Clearing a text input switched
// the model gate OFF, silently. It is now a 400 with the code `empty_allowlist`
// (backend/src/routes/governance.ts, tests/governance.test.ts).
//
// A refusal the screen swallows is a floor that only exists in the log, so this file drives the real
// path: the row emits `[]`, `update()` PATCHes it, the API refuses, and the page must
//   (a) SAY SO, IN THE READER'S LANGUAGE. `writeErrorText` renders a 400's backend sentence verbatim
//       unless the code has a `VALIDATION_MESSAGES` entry — and this refusal names a POLICY KEY, not
//       a value the admin typed, so there is nothing an English sentence carries that copy cannot.
//       `empty_allowlist` therefore has an entry, and the assertion below names the MESSAGE KEY: a
//       test that pinned the English string would go green on precisely the defect this repo keeps
//       shipping (a Dutch operator reading an English refusal inside a Dutch frame).
//   (b) still show the OLD models. `savedKey` and a re-`load()` both hang off the success path, so a
//       page that reported nothing would leave the reader believing the empty list took.
//
// ⚠️ `$lib/api/error-message` IS DELIBERATELY NOT MOCKED HERE, unlike its sibling
// `governance-page.i18n.render.test.ts`. Stubbing `writeErrorText` to return the caller's fallback is
// exactly what would hide (a) — and it is also what would hide the entry being absent from
// `VALIDATION_MESSAGES`, since the fallback is localized either way.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Governance } from '$lib/types/governance';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			params && Object.keys(params).length ? `${key}:${Object.values(params).join(',')}` : key;
	}
	return mod;
});

const { getGovernance, updateGovernance, FakeApiError } = vi.hoisted(() => ({
	getGovernance: vi.fn(),
	updateGovernance: vi.fn(),
	FakeApiError: class FakeApiError extends Error {
		constructor(
			public status: number,
			public code: string,
			message: string
		) {
			super(message);
		}
	}
}));
vi.mock('$lib/api/governance', () => ({
	governanceApi: { get: getGovernance, update: updateGovernance, exportNow: vi.fn() },
	ApiError: FakeApiError
}));

import Page from './+page.svelte';

const MODELS = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'];

/**
 * The backend's own refusal, copied from `validateValue` in backend/src/routes/governance.ts.
 *
 * ⚠️ It is on the wire so the page has something English to leak — the assertions below check that
 * it does NOT reach the screen. Any distinctive fragment of it works; `cannot be emptied` is the one
 * pinned, so a reworded backend sentence weakens the negative rather than reddening the file.
 */
const REFUSAL =
	"'models.allowlist' cannot be emptied here — an empty list removes the model gate entirely and the broker then permits every model. Keep at least one model on the list.";

function dto(): Governance {
	return {
		groups: [
			{
				category: 'models_tools',
				title: 'Models & tools',
				policies: [
					{
						key: 'models.allowlist',
						category: 'models_tools',
						label: 'Allowlisted models',
						description: 'The broker refuses any model not on this list.',
						control: 'list',
						value: MODELS,
						options: null,
						unit: null,
						enabled: true
					}
				]
			}
		],
		compliance: [],
		recentChanges: [],
		exportStatus: { enabled: false, bucket: 'compliance', hourUtc: 2, lastRun: null, recent: [] }
	} as unknown as Governance;
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

async function settle() {
	for (let i = 0; i < 16; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Open the allowlist editor, replace its contents, and blur — the live gesture, end to end. */
async function clearTheBox() {
	const edit = [...host.querySelectorAll('button')].find((b) => b.textContent === 'ops_policy_edit');
	expect(edit, 'the allowlist rail rendered no Edit control').toBeTruthy();
	edit!.click();
	flushSync();
	const input = host.querySelector<HTMLInputElement>('.list-edit')!;
	expect(input, 'the list editor did not open').not.toBeNull();
	input.value = '';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	input.dispatchEvent(new FocusEvent('blur'));
	await settle();
}

function badges(): string[] {
	return [...host.querySelectorAll('.badge.teal')].map((b) => b.textContent ?? '');
}

beforeEach(() => {
	getGovernance.mockReset();
	updateGovernance.mockReset();
	getGovernance.mockResolvedValue(dto());
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

describe('/governance reports the empty-allowlist refusal instead of absorbing it', () => {
	it('⛔ the 400 reaches the screen in the backend’s own words, and the models stay put', async () => {
		updateGovernance.mockRejectedValue(new FakeApiError(400, 'empty_allowlist', REFUSAL));
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle();
		// Non-vacuity: the rail rendered its three models before anything was cleared.
		expect(badges()).toEqual(MODELS);

		await clearTheBox();

		// The gesture really did reach the API — an emptied box IS a change, so the equality guard in
		// PolicyRow must NOT swallow it.
		expect(updateGovernance).toHaveBeenCalledTimes(1);
		expect(updateGovernance).toHaveBeenCalledWith('models.allowlist', []);
		// The refusal is on screen, and it is the CATALOG entry, not the backend's English. Under this
		// file's message mock every key renders as its own name, so `error_empty_allowlist` on screen
		// means `writeErrorText` consulted `VALIDATION_MESSAGES` and a Dutch reader gets Dutch.
		expect(host.textContent, 'the refusal was swallowed — the reader thinks the box saved').toContain(
			'error_empty_allowlist'
		);
		expect(
			host.textContent,
			'the backend’s English sentence reached the screen — the VALIDATION_MESSAGES entry is missing or not consulted'
		).not.toContain('cannot be emptied');
		// …and the rail still shows what is actually stored.
		expect(badges(), 'the screen showed an empty allowlist the server never accepted').toEqual(MODELS);
		// A refused write must not have looked like a successful one: `savedKey` and the reload both
		// hang off the success path.
		expect(host.querySelector('.row-wrap.saved')).toBeNull();
		expect(getGovernance, 'a refused write re-fetched as though it had landed').toHaveBeenCalledTimes(1);
	});

	it('a NON-empty edit of the same rail still saves', async () => {
		// ⛔ THE COMPLEMENT. Everything above is satisfied by a rail that cannot be edited at all.
		updateGovernance.mockResolvedValue({ key: 'models.allowlist', value: ['claude-opus-4-7'] });
		app = mount(Page, { target: host }) as Record<string, unknown>;
		await settle();

		const edit = [...host.querySelectorAll('button')].find((b) => b.textContent === 'ops_policy_edit')!;
		edit.click();
		flushSync();
		const input = host.querySelector<HTMLInputElement>('.list-edit')!;
		input.value = 'claude-opus-4-7';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		input.dispatchEvent(new FocusEvent('blur'));
		await settle();

		expect(updateGovernance).toHaveBeenCalledWith('models.allowlist', ['claude-opus-4-7']);
		expect(host.textContent).not.toContain('error_empty_allowlist');
	});
});
