// src/lib/api/agent.locale.test.ts — the chat request carries the UI locale.
//
// ⛔ Prod 2026-10-16, after #465: a Dutch UI on an English browser got English block names from the
// copilot. `streamAgentChat` is a raw `fetch` (SSE), not `authFetch`, so it never sent the UI
// locale; the backend fell back to the browser's Accept-Language. REVERT THAT TURNS THIS RED: drop
// `locale: getLocale()` from the request body in api/agent.ts.
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('$lib/paraglide/runtime', () => ({ getLocale: () => 'nl' }));

import { streamAgentChat } from './agent';

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('streamAgentChat', () => {
	it('sends the UI locale in the body', async () => {
		let sent: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			sent = JSON.parse(String(init.body)) as Record<string, unknown>;
			return new Response('', { status: 500 });
		});
		vi.stubGlobal('fetch', fetchMock);
		const done = new Promise<void>((resolve) => {
			streamAgentChat(
				{ message: 'Test deze flow', flowId: '01a1438a-d8a4-73d3-98f6-128b2c03dc29', token: 't' },
				{ onEvent: () => {}, onError: () => resolve(), onEnd: () => resolve() }
			);
		});
		await done;
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock.mock.calls[0]![0]).toBe('/api/agent/chat');
		expect(sent?.locale).toBe('nl');
	});
});
