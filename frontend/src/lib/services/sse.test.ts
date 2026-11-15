import { afterEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

import { parseBlock, streamRun } from './sse';
import * as m from '$lib/paraglide/messages';

function streamResponse(text: string): Response {
	const bytes = new TextEncoder().encode(text);
	return new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		}
	}), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => {
	authFetch.mockReset();
	vi.useRealTimers();
});

describe('run SSE transport', () => {
	it('parses CRLF framing and joins multiple data lines', () => {
		expect(parseBlock('id: 7\r\nevent: node_log\r\ndata: {"a":\r\ndata: 1}')).toEqual({
			id: 7,
			event: 'node_log',
			data: '{"a":\n1}'
		});
	});

	it('treats a transient clean disconnect as non-terminal and resumes from Last-Event-ID', async () => {
		vi.useFakeTimers();
		authFetch
			.mockResolvedValueOnce(streamResponse(
				'id: 1\r\nevent: node_start\r\ndata: {"type":"node_start","runId":"r","ts":1,"nodeId":"n","slug":"s"}\r\n\r\n'
			))
			.mockResolvedValueOnce(streamResponse(
				'id: 2\r\nevent: run_complete\r\ndata: {"type":"run_complete","runId":"r","ts":2,"totalMs":1,"status":"ok","totals":{"usd":0,"tokensIn":0,"tokensOut":0,"llmCalls":0}}\r\n\r\nevent: end\r\n\r\n'
			));
		const events: unknown[] = [];
		const onError = vi.fn();
		const onEnd = vi.fn();
		const control = streamRun('r', { onEvent: (event) => events.push(event), onError, onEnd });

		for (let i = 0; i < 10 && authFetch.mock.calls.length < 1; i++) await Promise.resolve();
		expect(authFetch).toHaveBeenCalledTimes(1);
		expect(onError).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(500);
		for (let i = 0; i < 10 && onEnd.mock.calls.length < 1; i++) await Promise.resolve();

		expect(authFetch).toHaveBeenCalledTimes(2);
		expect(authFetch.mock.calls[1]![0]).toBe('/api/runs/r/stream?lastEventId=1');
		expect(events).toHaveLength(2);
		expect(onError).not.toHaveBeenCalled();
		expect(onEnd).toHaveBeenCalledTimes(1);
		control.close();
	});

	it('keeps the structured non-2xx message and request id, in a LOCALIZED frame', async () => {
		// ⛔ THIS TEST USED TO PIN THE DEFECT. It asserted exactly
		// `'That run is unavailable. (request req-42)'` — a hardcoded English suffix this module
		// appends itself, on a tenant-facing /build failure, in all eight locales. The frame is now
		// a catalog key and the two foreign values are bidi-isolated; the REQUEST ID IS DELIBERATELY
		// STILL THERE, because it is the only thing the reader can act on (quote it to support).
		authFetch.mockResolvedValueOnce(new Response(JSON.stringify({
			error: 'run_not_found',
			message: 'That run is unavailable.',
			requestId: 'req-42'
		}), { status: 404 }));
		const onError = vi.fn();
		streamRun('missing', { onEvent: vi.fn(), onError });
		for (let i = 0; i < 20 && onError.mock.calls.length < 1; i++) await Promise.resolve();
		const msg = (onError.mock.calls[0]![0] as Error).message;
		// Both facts survive the reframing …
		expect(msg).toContain('That run is unavailable.');
		expect(msg).toContain('req-42');
		// … inside the catalog frame, not the hand-built English one.
		expect(msg).toBe(m.run_stream_failed_request({ detail: '⁨That run is unavailable.⁩', id: '⁨req-42⁩' }));
		// ⛔ The English suffix this module used to author is gone.
		expect(msg).not.toContain(' (request req-42)');
	});

	it('without a requestId it uses the id-less frame, and never leaks the raw status sentence', async () => {
		authFetch.mockResolvedValueOnce(new Response(JSON.stringify({
			error: 'run_not_found',
			message: 'That run is unavailable.'
		}), { status: 404 }));
		const onError = vi.fn();
		streamRun('missing', { onEvent: vi.fn(), onError });
		for (let i = 0; i < 20 && onError.mock.calls.length < 1; i++) await Promise.resolve();
		const msg = (onError.mock.calls[0]![0] as Error).message;
		expect(msg).toBe(m.run_stream_failed({ detail: '⁨That run is unavailable.⁩' }));
		expect(msg).not.toContain('request');
	});

	it('a non-JSON ingress/proxy body still carries the status, in the same localized frame', async () => {
		// The mid-roll / ingress case: an HTML error page. `Run stream failed (503)` was ALSO
		// hardcoded English; the status is now interpolated into the catalog frame as a technical
		// token, which is the house idiom for a fact no catalog can contain.
		authFetch.mockResolvedValueOnce(new Response('<html>502 Bad Gateway</html>', { status: 502 }));
		const onError = vi.fn();
		streamRun('missing', { onEvent: vi.fn(), onError });
		for (let i = 0; i < 20 && onError.mock.calls.length < 1; i++) await Promise.resolve();
		const msg = (onError.mock.calls[0]![0] as Error).message;
		expect(msg).toBe(m.run_stream_failed({ detail: '⁨HTTP 502⁩' }));
		expect(msg).not.toContain('Run stream failed');
	});
});
