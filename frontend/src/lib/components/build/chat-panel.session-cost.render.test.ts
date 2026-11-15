// @vitest-environment jsdom
//
// src/lib/components/build/chat-panel.session-cost.render.test.ts — the assistant's running LLM
// spend is an administrator's number. A member building a flow sees the assistant, not its bill.
//
// ⛔ THE LINE THIS IS BUILT AGAINST: the `.quota` span rendered unconditionally in the chat header.
// Restore it and the "hidden" cases below go red.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

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

import ChatPanel from './ChatPanel.svelte';
import { canSeeSessionCost } from './session-cost-visibility';

const chat = { messages: [], busy: false, costUsd: 0.0041, send: vi.fn(), stop: vi.fn() };

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

function render(props: Record<string, unknown>): void {
	app = mount(ChatPanel, { target: host, props: { chat, ...props } as never });
	flushSync();
}
const costShown = () => host.querySelector('.quota') !== null || (host.textContent ?? '').includes('chat_session_cost');

describe('canSeeSessionCost', () => {
	it.each([
		[['member'], false],
		[['developer'], false],
		[[], false],
		[['tenant_admin'], true],
		[['super_admin'], true],
		[['developer', 'tenant_admin'], true]
	])('%j → %s', (roles, expected) => {
		expect(canSeeSessionCost(roles)).toBe(expected);
	});
});

describe('the chat header cost figure', () => {
	it('non-vacuity: the panel header rendered', () => {
		render({ showCost: false });
		expect(host.querySelector('.chat-head'), 'the panel did not mount').not.toBeNull();
	});

	it('⛔ hidden from a member', () => {
		render({ showCost: canSeeSessionCost(['member']) });
		expect(costShown()).toBe(false);
	});

	it('⛔ hidden when the mount site passes nothing', () => {
		render({});
		expect(costShown()).toBe(false);
	});

	it('shown to a tenant admin', () => {
		render({ showCost: canSeeSessionCost(['tenant_admin']) });
		expect(costShown()).toBe(true);
	});

	it('⛔ hidden at $0 (platform-paid local inference), even for a tenant admin', () => {
		// Prod 2026-10-16: "$ ~0,0000 AI-gebruik deze sessie" on a local-llm workspace.
		app = mount(ChatPanel, {
			target: host,
			props: { chat: { ...chat, costUsd: 0 }, showCost: canSeeSessionCost(['tenant_admin']) } as never
		});
		flushSync();
		expect(host.querySelector('.chat-head'), 'the panel did not mount').not.toBeNull();
		expect(costShown()).toBe(false);
	});
});
