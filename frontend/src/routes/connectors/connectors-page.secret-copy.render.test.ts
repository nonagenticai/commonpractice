// @vitest-environment jsdom
//
// src/routes/connectors/connectors-page.secret-copy.render.test.ts — the once-only webhook secret
// must be recoverable by the reader, not just visible to them.
//
// ⛔ THE DEFECT. `rotateEventSecret` stores a HASH; the plaintext exists for exactly one render and
// the only way back is another rotation, which invalidates whatever the caller already wired up.
// The drawer put it in a bare readonly `<input>` with no copy control, so "select the text in a
// narrow drawer without dropping a character" was the ONLY way to keep it.
//
// ⚠️ THE FAILURE BRANCH IS HALF THE FILE, DELIBERATELY. `navigator.clipboard` is undefined outside
// a secure context and rejects when the document is not focused. A copy button that answers a
// rejection by doing nothing is WORSE than no button: the reader believes they have the secret,
// closes the drawer, and it is gone. Assertions are on message tokens (catalog mocked key→key).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { ConnectorList } from '$lib/types/connectors';

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
			params && Object.keys(params).length ? `${key}:${Object.values(params).join('|')}` : key;
	}
	return mod;
});

const { list, rotateSecret } = vi.hoisted(() => ({ list: vi.fn(), rotateSecret: vi.fn() }));

// Every name below is a real `connectorsApi` method — a stub for one that does not exist resolves
// to `undefined`, the page's catch swallows the TypeError, and the rest of the case is vacuous.
vi.mock('$lib/api/connectors', () => ({
	connectorsApi: {
		list,
		get: vi.fn(),
		sync: vi.fn(),
		create: vi.fn(),
		test: vi.fn(),
		remove: vi.fn(),
		rotateSecret,
		reregisterNotifications: vi.fn(),
		verifyNotifications: vi.fn(),
		reconcileNotifications: vi.fn()
	},
	streamConnectors: () => ({ close: () => {} }),
	ApiError: class ApiError extends Error {}
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback,
	// ⚠️ THE LEGACY-TEXT ARM ONLY — every fixture in THIS file sets `syncError: null`, so the stub
	// is never asked for a sentence. The real catalog path (a wire code → the reader's own
	// language) is asserted in connectors.sync-error-dutch.render.test.ts, which deliberately does
	// NOT mock this module. Do not add a non-null `syncError` fixture here expecting localization.
	syncErrorText: (_code: string | null | undefined, legacy: string | null | undefined) =>
		legacy ?? ''
}));
vi.mock('$lib/stores/confirm.svelte', () => ({ confirmDialog: vi.fn(async () => true) }));

import Page from './+page.svelte';

const SECRET = 'whsec_9f2b41c0e7a84d55b1c3';

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle(until: () => boolean, tries = 60) {
	for (let i = 0; i < tries && !until(); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	flushSync();
}

const WEBHOOK_CONNECTOR = {
	id: 'c1',
	slug: 'hook',
	name: 'Hook',
	sourceType: 'http' as const,
	status: 'ready',
	eventSource: 'webhook' as const,
	meta: { kind: 'http' as const, host: 'example.test' },
	columns: [],
	rowCount: 0,
	sizeBytes: 0,
	sandboxId: null,
	lastSyncedAt: null,
	syncError: null,
	syncErrorCode: null,
	syncErrorDetail: null,
	createdAt: '2026-08-01T00:00:00Z',
	updatedAt: '2026-08-01T00:00:00Z'
};

/** Rotate, so the once-only secret drawer is on screen. */
async function revealSecret() {
	list.mockResolvedValue({
		items: [WEBHOOK_CONNECTOR],
		total: 1,
		page: 1,
		pageSize: 12,
		canManage: true
	} as ConnectorList);
	rotateSecret.mockResolvedValue({ ingestUrl: 'https://cp.test/api/connectors/events?connector=c1', eventSecret: SECRET });

	app = mount(Page, { target: host }) as Record<string, unknown>;
	await settle(() => !!host.querySelector('tbody tr'));

	const rotateBtn = [...host.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'connectors_rotate'
	) as HTMLButtonElement | undefined;
	expect(rotateBtn, 'no Rotate button — this case tests nothing').toBeTruthy();
	rotateBtn!.click();
	await settle(() => !!host.querySelector('.secret-row'));
}

function copyButton(): HTMLButtonElement {
	const btn = host.querySelector('.secret-row button') as HTMLButtonElement | null;
	expect(btn, 'the once-only secret renders with no copy control').not.toBeNull();
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
	list.mockReset();
	rotateSecret.mockReset();
	// jsdom has no clipboard; each case installs its own.
	Reflect.deleteProperty(navigator, 'clipboard');
});

describe('/connectors — the once-only webhook secret can be copied', () => {
	it('⛔ a copy control exists and writes the EXACT secret to the clipboard', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

		await revealSecret();
		// The value is on screen at all — otherwise "copied it" would be a claim about nothing.
		expect((host.querySelector('.secret-row input') as HTMLInputElement).value).toBe(SECRET);

		copyButton().click();
		await settle(() => writeText.mock.calls.length > 0);
		expect(writeText).toHaveBeenCalledWith(SECRET);
	});

	it('confirms in the reader’s language, and announces it rather than only relabelling the button', async () => {
		Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
		await revealSecret();
		copyButton().click();
		await settle(() => !!host.querySelector('[role="status"]'));

		expect(copyButton().textContent!.trim()).toBe('connectors_secret_copied');
		const status = host.querySelector('.drawer [role="status"]');
		expect(status, 'the confirmation is invisible to a screen reader that is not on the button').not.toBeNull();
		expect(status!.textContent).toContain('connectors_secret_copied');
	});

	it('⛔ SAYS SO WHEN IT FAILS — a rejected write must never look like a successful copy', async () => {
		Object.defineProperty(navigator, 'clipboard', {
			value: { writeText: async () => { throw new Error('Document is not focused'); } },
			configurable: true
		});
		await revealSecret();
		copyButton().click();
		await settle(() => !!host.querySelector('.notice.error'));

		const notice = host.querySelector('.drawer .notice.error');
		expect(notice, 'a rejected clipboard write left the drawer silent').not.toBeNull();
		expect(notice!.textContent).toContain('connectors_secret_copy_failed');
		// …and the button must NOT be sitting there reading "Copied".
		expect(copyButton().textContent!.trim()).toBe('connectors_secret_copy');
	});

	it('a missing clipboard API (an insecure context) is reported, not swallowed', async () => {
		await revealSecret(); // no `navigator.clipboard` installed at all
		copyButton().click();
		await settle(() => !!host.querySelector('.notice.error'));
		expect(host.querySelector('.drawer .notice.error')!.textContent).toContain(
			'connectors_secret_copy_failed'
		);
	});
});
