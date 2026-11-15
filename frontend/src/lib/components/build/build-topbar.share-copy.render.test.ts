// @vitest-environment jsdom
//
// src/lib/components/build/build-topbar.share-copy.render.test.ts — /build's Share button must not
// pretend to have copied a link it did not copy.
//
// ⛔ THE DEFECT. `shareFlow()` was
//     try { await navigator.clipboard.writeText(link); } catch { return; }
// — a bare `return` that left the label reading "Delen" and put nothing on screen. The reader
// clicked Share, saw no change (the confirmation is a 2-second label swap they may well have
// missed), and pasted whatever was on their clipboard BEFORE. `navigator.clipboard` is undefined
// outside a secure context and rejects when the document is not focused, so the branch is real.
//
// ⚠️ AND THE FAILURE MUST BE ACTIONABLE, WHICH IS WHY IT RENDERS THE LINK. "Select the link and
// copy it by hand" is not an instruction anyone can follow against a permalink that exists only
// inside a closure — unlike /connectors' secret and /mcp-keys' key, the value here was never on
// screen at all. Stating the failure without showing the link would be a better-worded dead end.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { FlowListItem, FlowStatus } from '$lib/types/flows';

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
		// ⚠️ ELEVEN nl KEYS ARE ICU PLURAL OBJECTS, NOT STRINGS — and BuildTopbar renders one of
		// them (`build_block_count`). A `String.replace` over the raw value throws on those, which
		// takes down the whole mount and turns every assertion in this file into a mount error
		// rather than a verdict. The `other` arm is used; nothing here is about plural selection.
		const pattern = typeof catalog[key] === 'string'
			? (catalog[key] as string)
			: (Object.values(
					((catalog[key] as unknown as { match: Record<string, string> }[])[0] ?? { match: {} }).match
				).pop() ?? key);
		mod[key] = (params?: Record<string, unknown>) =>
			pattern.replace(/\{(\w+)\}/g, (whole: string, name: string) => {
				if (params && name in params) return String(params[name]);
				// ICU locals are named `<input>Num` / `<input>Plural` — resolve back to the input.
				const base = name.replace(/(Num|Plural)$/, '');
				return params && base in params ? String(params[base]) : whole;
			});
	}
	return mod;
});

const FLOW: FlowListItem = {
	id: 'flow-1',
	name: 'Mijn flow',
	description: '',
	status: 'draft',
	version: '1',
	node_count: 3,
	last_saved_at: null,
	updated_at: '2026-08-09T00:00:00Z'
};

/** `build_share_copy_failed` / `build_share_copied` / `build_share` in nl. */
const COPY_FAILED_NL = 'Kopiëren mislukt. Selecteer de link en kopieer die handmatig.';
const COPIED_NL = 'Link gekopieerd';
const SHARE_NL = 'Delen';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	Reflect.deleteProperty(navigator, 'clipboard');
});

async function render() {
	const { default: BuildTopbar } = await import('./BuildTopbar.svelte');
	app = mount(BuildTopbar, {
		target: host,
		props: {
			name: 'Mijn flow',
			status: 'draft' as FlowStatus,
			nodeCount: 3,
			saveLabel: 'Opgeslagen',
			saving: false,
			flows: [FLOW],
			currentId: 'flow-1',
			challengeId: 'ch-1',
			challengeClosed: false,
			flowLoaded: true,
			// This flow is the caller’s own; the read-only branch has its own specs.
			readOnly: false,
			chatBusy: false,
			submitting: false,
			running: false,
			historyOpen: false,
			canUndo: false,
			canRedo: false,
			onRename: () => {},
			onSelect: () => {},
			onNew: () => {},
			onSubmit: () => {},
			onTestRun: () => {},
			onToggleHistory: () => {},
			onUndo: () => {},
			onRedo: () => {}
		}
	}) as Record<string, unknown>;
	flushSync();
}

function shareButton(): HTMLButtonElement {
	const btn = [...host.querySelectorAll('button')].find((b) =>
		[SHARE_NL, COPIED_NL].includes(b.textContent!.trim())
	) as HTMLButtonElement | undefined;
	// ⛔ ANTI-VACUITY GATE: every assertion below is about this control, and "no failure text" is
	// trivially true of a topbar that rendered no Share button at all.
	expect(btn, 'no Share button in the topbar — this file tests nothing').toBeTruthy();
	return btn!;
}

async function settle(until: () => boolean, tries = 40) {
	for (let i = 0; i < tries && !until(); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	flushSync();
}

describe('/build — the Share button reports a failed copy', () => {
	it('⛔ SAYS SO when the clipboard write is rejected, and shows the link to copy', async () => {
		// REVERT THAT TURNS THIS RED: `catch { return; }`. Nothing renders,
		// `[data-testid="share-copy-failed"]` never appears, and the label stays "Delen" — which is
		// exactly what it looks like before the click, so the reader cannot tell the two apart.
		Object.defineProperty(navigator, 'clipboard', {
			value: {
				writeText: async () => {
					throw new Error('Document is not focused');
				}
			},
			configurable: true
		});
		await render();
		shareButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle(() => !!host.querySelector('[data-testid="share-copy-failed"]'));

		const notice = host.querySelector('[data-testid="share-copy-failed"]');
		expect(notice, 'a rejected clipboard write left the topbar silent').not.toBeNull();
		expect(notice!.textContent).toContain(COPY_FAILED_NL);
		// role="status": a label swap is invisible to a screen reader that is not on the button.
		expect(notice!.getAttribute('role')).toBe('status');
		// ⛔ THE LINK ITSELF, so "copy it by hand" is an instruction the reader can act on.
		const code = notice!.querySelector('code');
		expect(code, 'the failure names no link, so the reader has nothing to copy').not.toBeNull();
		expect(code!.textContent).toContain('/build?id=flow-1');
		// A URL is an opaque token; RTL paragraph direction must not reorder it.
		expect(code!.getAttribute('dir')).toBe('ltr');
		// …and the button must NOT be sitting there reading "Link gekopieerd".
		expect(shareButton().textContent!.trim()).toBe(SHARE_NL);
	});

	it('a missing clipboard API (an insecure context) is reported, not swallowed', async () => {
		await render(); // no `navigator.clipboard` installed at all
		shareButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle(() => !!host.querySelector('[data-testid="share-copy-failed"]'));
		expect(host.querySelector('[data-testid="share-copy-failed"]')!.textContent).toContain(
			COPY_FAILED_NL
		);
	});

	it('⛔ a SUCCESSFUL copy confirms, writes the exact permalink, and shows no failure', async () => {
		// THE COMPLEMENT. "Always report a failure" would satisfy both cases above while lying to
		// every reader whose clipboard works.
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		await render();
		shareButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settle(() => writeText.mock.calls.length > 0);

		expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/build?id=flow-1`);
		await settle(() => shareButton().textContent!.trim() === COPIED_NL);
		expect(shareButton().textContent!.trim()).toBe(COPIED_NL);
		expect(host.querySelector('[data-testid="share-copy-failed"]')).toBeNull();
	});
});
