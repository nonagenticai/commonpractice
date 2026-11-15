// @vitest-environment jsdom
//
// src/lib/components/build/flow-template-gallery.render.test.ts — the /build "Pick a template" modal.
//
// Pinned: starters and the organisation's own templates render in two sections; a template whose
// blocks the reader cannot use is DISABLED with its reason (not hidden, not clickable); "Use" asks the
// backend for a new flow and hands the result to the page; an empty catalogue says so.
// Real nl catalog (the shipped strings), with ICU plurals reduced to their `other` arm.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { FlowTemplateSummary } from '$lib/types/flow-templates';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		const pattern =
			typeof catalog[key] === 'string'
				? (catalog[key] as string)
				: (Object.values(((catalog[key] as { match: Record<string, string> }[])[0] ?? { match: {} }).match).pop() ?? key);
		mod[key] = (params?: Record<string, unknown>) =>
			pattern.replace(/\{(\w+)\}/g, (whole: string, name: string) => {
				if (params && name in params) return String(params[name]);
				const base = name.replace(/(Num|Plural)$/, '');
				return params && base in params ? String(params[base]) : whole;
			});
	}
	return mod;
});

const { list, use, archive } = vi.hoisted(() => ({ list: vi.fn(), use: vi.fn(), archive: vi.fn() }));
vi.mock('$lib/api/flow-templates', () => ({
	flowTemplatesApi: { list, use, archive, create: vi.fn(), useSolution: vi.fn() }
}));

const nl = JSON.parse(
	(await import('node:fs')).readFileSync((await import('node:path')).resolve(process.cwd(), 'messages/nl.json'), 'utf8')
) as Record<string, string>;

function tpl(over: Partial<FlowTemplateSummary>): FlowTemplateSummary {
	return {
		id: 'x',
		name: 'X',
		description: '',
		category: '',
		scope: 'global',
		blockCount: 3,
		available: true,
		missingBlocks: [],
		createdBy: null,
		createdAt: '2026-10-14T00:00:00Z',
		canArchive: false,
		...over
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	list.mockReset();
	use.mockReset();
	archive.mockReset();
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

async function settle(until: () => boolean, tries = 40) {
	for (let i = 0; i < tries && !until(); i++) {
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
	}
	flushSync();
}

async function render(onUsed = vi.fn(), onClose = vi.fn(), intoFlowId: string | null = null) {
	const { default: Gallery } = await import('./FlowTemplateGallery.svelte');
	app = mount(Gallery, { target: host, props: { open: true, onClose, onUsed, intoFlowId } }) as Record<string, unknown>;
	flushSync();
	await settle(() => host.querySelectorAll('[data-testid="flow-tpl-card"]').length > 0 || host.textContent!.includes(nl.build_tpl_empty));
	return { onUsed, onClose };
}

const cards = () => [...host.querySelectorAll<HTMLElement>('[data-testid="flow-tpl-card"]')];
const useButton = (card: HTMLElement) =>
	[...card.querySelectorAll('button')].find((b) => b.textContent!.trim() === nl.build_tpl_use) as HTMLButtonElement;

describe('FlowTemplateGallery', () => {
	it('renders starters and organisation templates in their own sections, with category + block count', async () => {
		list.mockResolvedValue([
			tpl({ id: 's1', name: 'Samenvatting schadeformulier', category: 'claims', blockCount: 4 }),
			tpl({ id: 'o1', name: 'Ons eigen proces', scope: 'tenant', category: 'Inkoop' })
		]);
		await render();
		expect(host.querySelector('[role="dialog"][aria-modal="true"]')).toBeTruthy();
		const headings = [...host.querySelectorAll('h3')].map((h) => h.textContent!.trim());
		expect(headings).toEqual([nl.build_tpl_starters, nl.build_tpl_org]);
		const [starter, own] = cards();
		expect(starter!.closest('section')!.querySelector('h3')!.textContent).toBe(nl.build_tpl_starters);
		expect(own!.closest('section')!.querySelector('h3')!.textContent).toBe(nl.build_tpl_org);
		expect(starter!.textContent).toContain(nl.build_tpl_cat_claims); // a starter's category key is translated
		expect(starter!.textContent).toContain('4 blokken');
		expect(own!.textContent).toContain('Inkoop'); // an organisation's own category is shown as typed
	});

	it('an unavailable template is disabled and says why; Use does nothing', async () => {
		list.mockResolvedValue([tpl({ id: 'off', available: false, missingBlocks: ['ftpl-x'] })]);
		await render();
		const card = cards()[0]!;
		const btn = useButton(card);
		expect(btn.disabled).toBe(true);
		expect(card.textContent).toContain(nl.build_tpl_unavailable);
		expect(btn.getAttribute('aria-describedby')).toBe('tpl-off-off');
		btn.click();
		flushSync();
		expect(use).not.toHaveBeenCalled();
	});

	it('Use asks for a new flow and hands the result to the page', async () => {
		list.mockResolvedValue([tpl({ id: 's1' })]);
		use.mockResolvedValue({ flowId: 'new-flow', missingBlocks: [] });
		const { onUsed } = await render();
		useButton(cards()[0]!).click();
		await settle(() => onUsed.mock.calls.length > 0);
		expect(use).toHaveBeenCalledWith('s1', { into: null });
		expect(onUsed).toHaveBeenCalledWith({ flowId: 'new-flow', missingBlocks: [] });
	});

	// ⛔ The empty draft on the canvas is handed to the server, so a first template does not leave a
	// blank "Untitled flow" behind next to it (new org on prod, 2026-10-16).
	it('Use passes the empty draft on the canvas as `into`', async () => {
		list.mockResolvedValue([tpl({ id: 's1' })]);
		use.mockResolvedValue({ flowId: 'blank-1', missingBlocks: [] });
		const { onUsed } = await render(vi.fn(), vi.fn(), 'blank-1');
		useButton(cards()[0]!).click();
		await settle(() => onUsed.mock.calls.length > 0);
		expect(use).toHaveBeenCalledWith('s1', { into: 'blank-1' });
		expect(onUsed).toHaveBeenCalledWith({ flowId: 'blank-1', missingBlocks: [] });
	});

	it('an empty catalogue says so, and Escape closes', async () => {
		list.mockResolvedValue([]);
		const { onClose } = await render();
		expect(cards()).toHaveLength(0);
		expect(host.textContent).toContain(nl.build_tpl_empty);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		expect(onClose).toHaveBeenCalled();
	});

	it('Remove is offered only where the reader may remove', async () => {
		list.mockResolvedValue([tpl({ id: 'a', canArchive: true, scope: 'tenant' }), tpl({ id: 'b', canArchive: false })]);
		await render();
		const removeIn = (c: HTMLElement) => [...c.querySelectorAll('button')].some((b) => b.textContent!.trim() === nl.build_tpl_remove);
		const all = cards();
		const own = all.find((c) => c.closest('section')!.querySelector('h3')!.textContent === nl.build_tpl_org)!;
		const starter = all.find((c) => c !== own)!;
		expect(removeIn(own)).toBe(true);
		expect(removeIn(starter)).toBe(false);
	});
});
