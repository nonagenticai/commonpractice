// @vitest-environment jsdom
//
// src/lib/components/build/build-topbar.save-template.render.test.ts — "Save as template" in ⋯ exists
// only when /build passes `onSaveTemplate` (developer / admin), and calls it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { FlowStatus } from '$lib/types/flows';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		const v = catalog[key];
		mod[key] = () => (typeof v === 'string' ? v : key);
	}
	return mod;
});

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
});

async function render(extra: Record<string, unknown>) {
	const { default: BuildTopbar } = await import('./BuildTopbar.svelte');
	app = mount(BuildTopbar, {
		target: host,
		props: {
			name: 'My flow',
			status: 'draft' as FlowStatus,
			nodeCount: 3,
			saveLabel: 'Saved',
			saving: false,
			flows: [],
			currentId: 'flow-1',
			challengeId: null,
			challengeClosed: false,
			flowLoaded: true,
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
			onRedo: () => {},
			...extra
		}
	}) as Record<string, unknown>;
	flushSync();
}

const entry = () => host.querySelector<HTMLButtonElement>('[data-testid="save-as-template"]');

describe('BuildTopbar — Save as template', () => {
	it('is absent when /build does not offer it (a member)', async () => {
		await render({});
		// Anti-vacuity: the ⋯ menu itself rendered.
		expect(host.querySelector('#build-more-menu')).toBeTruthy();
		expect(entry()).toBeNull();
	});

	it('is present for an author and calls the handler', async () => {
		const onSaveTemplate = vi.fn();
		await render({ onSaveTemplate });
		expect(entry()!.textContent!.trim()).toBe('Save as template');
		entry()!.click();
		expect(onSaveTemplate).toHaveBeenCalledTimes(1);
	});

	it('is disabled on an empty canvas', async () => {
		await render({ onSaveTemplate: vi.fn(), nodeCount: 0 });
		expect(entry()!.disabled).toBe(true);
	});
});
