// @vitest-environment jsdom
//
// src/lib/components/build/chat-panel.markdown.render.test.ts — the assistant's replies render as
// sanitised Markdown. Prod walk 2026-10-16: `**bold**` and backticks showed as raw text in the panel.
//
// REVERT THAT TURNS THIS RED: put back `<p>{m.text}</p>` for assistant messages — `<strong>` is gone
// and the asterisks are visible again.
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

function render(messages: Array<{ kind: string; text: string }>): void {
	const chat = { messages, busy: false, costUsd: 0, send: vi.fn(), stop: vi.fn() };
	app = mount(ChatPanel, { target: host, props: { chat } as never });
	flushSync();
}

describe('assistant replies are Markdown', () => {
	it('**x** renders as bold and `code` as code, without the raw markers', () => {
		render([{ kind: 'assistant', text: 'De flow **leest** een `formulier`.' }]);
		const msg = host.querySelector('.msg.assistant');
		expect(msg, 'the assistant message did not render').not.toBeNull();
		expect(msg!.querySelector('strong')?.textContent).toBe('leest');
		expect(msg!.querySelector('code')?.textContent).toBe('formulier');
		expect(msg!.textContent).not.toContain('**');
		expect(msg!.textContent).not.toContain('`');
	});

	it('⛔ <script> and raw HTML are never executed or parsed', () => {
		render([
			{
				kind: 'assistant',
				text: 'hi <script>window.__pwned=1</script> <img src=x onerror="window.__pwned=2"> **ok**'
			}
		]);
		const msg = host.querySelector('.msg.assistant')!;
		expect(msg.querySelector('script')).toBeNull();
		expect(msg.querySelector('img')).toBeNull();
		expect(msg.querySelector('strong')?.textContent).toBe('ok');
		// (No `window.__pwned` check: jsdom never executes scripts inserted via innerHTML, so it
		// could not fail. The element checks above are what can.)
	});

	it("the user's own message stays plain text", () => {
		render([{ kind: 'user', text: 'make it **bold**' }]);
		const msg = host.querySelector('.msg.user')!;
		expect(msg.querySelector('strong')).toBeNull();
		expect(msg.textContent).toContain('make it **bold**');
	});
});
