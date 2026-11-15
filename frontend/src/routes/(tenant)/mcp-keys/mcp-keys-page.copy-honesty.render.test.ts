// @vitest-environment jsdom
//
// src/routes/(tenant)/mcp-keys/mcp-keys-page.copy-honesty.render.test.ts — the once-only MCP key
// must be recoverable by the reader, not merely believed to be copied.
//
// ⛔ THE DEFECT WAS A LITERAL NO-OP. `copyKey()` ended in
//     catch { copied = false; }
// where `copied` was ALREADY false. So a rejected `navigator.clipboard.writeText` changed nothing
// on screen: the button stayed reading "Kopiëren", no message appeared, and the reader had no way
// to tell a successful copy from a failed one. `navigator.clipboard` is undefined outside a secure
// context and rejects when the document is not focused, so this branch really fires.
//
// ⛔ AND THE COST IS TOTAL. `cp_mcp_…` is shown EXACTLY ONCE — the server keeps only a hash — and
// the panel is dismissible. A reader who believes they copied the key, closes the panel and did
// not, has lost it: the only way back is issuing a new key and re-wiring whatever used the old one.
// /connectors' once-only webhook secret carries the tri-state this ports.
//
// ⚠️ THE SUCCESS BRANCH IS ASSERTED TOO. "Always say it failed" would satisfy the failure case and
// is a worse lie than silence.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

// The REAL nl catalog, read from disk — so this measures the strings that actually ship,
// and goes red the day a key is dropped instead of quietly asserting a copy of itself.
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			catalog[key].replace(/\{(\w+)\}/g, (whole: string, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	return mod;
});

const { currentTenant, listKeys, issueKey, revokeKey } = vi.hoisted(() => ({
	currentTenant: vi.fn(),
	listKeys: vi.fn(),
	issueKey: vi.fn(),
	revokeKey: vi.fn()
}));
vi.mock('$lib/api/admin', () => ({
	adminApi: { currentTenant },
	ApiError: class ApiError extends Error {
		status = 500;
	}
}));
vi.mock('$lib/api/mcpKeys', () => ({
	mcpKeysApi: { list: listKeys, issue: issueKey, revoke: revokeKey }
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn(async () => true) }));

import Page from './+page.svelte';

const RAW_KEY = 'cp_mcp_9f2b41c0e7a84d55b1c3aa77';
/** `admin_keys_copy_failed` / `admin_keys_copied` in nl. */
const COPY_FAILED_NL = 'Kopiëren mislukt — selecteer de waarde en kopieer die handmatig.';
const COPIED_NL = 'Gekopieerd';
const COPY_NL = 'Kopiëren';

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle(until: () => boolean, tries = 60) {
	for (let i = 0; i < tries && !until(); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	flushSync();
}

/** Issue a key, so the once-only panel is on screen. */
async function revealKey() {
	currentTenant.mockResolvedValue({ tenant: { id: 't1', name: 'Acme', slug: 'acme' } });
	listKeys.mockResolvedValue({ keys: [] });
	issueKey.mockResolvedValue({ id: 'k1', name: 'ci', key: RAW_KEY });

	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle(() => !!host.querySelector('form.addbar'));

	const input = host.querySelector('form.addbar input') as HTMLInputElement | null;
	expect(input, 'no issue form — this case tests nothing').not.toBeNull();
	input!.value = 'ci';
	input!.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	const submit = host.querySelector('form.addbar button') as HTMLButtonElement;
	expect(submit.disabled, 'the issue button never enabled').toBe(false);
	submit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle(() => !!host.querySelector('.fresh-row'));
	// The key is really on screen — otherwise "you copied it" would be a claim about nothing, and
	// "copy it by hand" would be an instruction nobody could follow.
	expect(host.querySelector('.fresh-row code')!.textContent).toBe(RAW_KEY);
}

function copyButton(): HTMLButtonElement {
	const btn = host.querySelector('.fresh-row button') as HTMLButtonElement | null;
	expect(btn, 'the once-only key renders with no copy control').not.toBeNull();
	return btn!;
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	for (const fn of [currentTenant, listKeys, issueKey, revokeKey]) fn.mockReset();
	// jsdom has no clipboard; each case installs its own.
	Reflect.deleteProperty(navigator, 'clipboard');
});

describe('/mcp-keys — the once-only key’s Copy button tells the truth', () => {
	it('⛔ SAYS SO WHEN THE WRITE IS REJECTED — the old catch was a literal no-op', async () => {
		// REVERT THAT TURNS THIS RED: `catch { copied = false; }` with the boolean `copied`. Nothing
		// is rendered, `[data-testid="key-copy-failed"]` never appears, and the reader is told
		// nothing about a key they cannot get back.
		Object.defineProperty(navigator, 'clipboard', {
			value: {
				writeText: async () => {
					throw new Error('Document is not focused');
				}
			},
			configurable: true
		});
		await revealKey();
		copyButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle(() => !!host.querySelector('[data-testid="key-copy-failed"]'));

		const notice = host.querySelector('[data-testid="key-copy-failed"]');
		expect(notice, 'a rejected clipboard write left the panel silent').not.toBeNull();
		expect(notice!.textContent).toContain(COPY_FAILED_NL);
		// role="status": the button's own label is invisible to a screen reader that is not on it.
		expect(notice!.getAttribute('role')).toBe('status');
		// …and the button must NOT be sitting there reading "Gekopieerd".
		expect(copyButton().textContent!.trim()).toBe(COPY_NL);
		// The key is still on screen, so "copy it by hand" is an instruction the reader can follow.
		expect(host.querySelector('.fresh-row code')!.textContent).toBe(RAW_KEY);
	});

	it('a missing clipboard API (an insecure context) is reported, not swallowed', async () => {
		await revealKey(); // no `navigator.clipboard` installed at all
		copyButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle(() => !!host.querySelector('[data-testid="key-copy-failed"]'));
		expect(host.querySelector('[data-testid="key-copy-failed"]')!.textContent).toContain(
			COPY_FAILED_NL
		);
	});

	it('⛔ a SUCCESSFUL copy confirms, and writes the EXACT key', async () => {
		// THE COMPLEMENT. "Always report a failure" would pass both cases above while lying to every
		// reader whose clipboard works.
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		await revealKey();
		copyButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle(() => writeText.mock.calls.length > 0);

		expect(writeText).toHaveBeenCalledWith(RAW_KEY);
		await settle(() => !!host.querySelector('[data-testid="key-copy-ok"]'));
		expect(host.querySelector('[data-testid="key-copy-ok"]')!.textContent).toContain(COPIED_NL);
		expect(host.querySelector('[data-testid="key-copy-failed"]')).toBeNull();
		expect(copyButton().textContent!.trim()).toBe(COPIED_NL);
	});
});
