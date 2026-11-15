// src/lib/api/connectors.test.ts — the two halves of the connector client that were missing.
//
// ⛔ 1. THE PREVIEW WINDOW WAS NOT ON THE WIRE. `GET /api/connectors/:slug` hard-read 50 rows and
// `connectorsApi.get` sent no query at all, so a 10 000-row connector previewed 50 rows beside its
// own `rowCount` field saying 10 000 — the dataset picker's silent stop-at-12 (PR #309) on another
// screen. The sibling `datasetsApi.get` has taken `{ offset, limit }` since Phase 2.0.
//
// ⛔ 2. AN `error` FRAME WAS A FRAME NOTHING LISTENED FOR. `streamConnectors` only ever matched
// `block.event === 'synced'`; every other frame fell through the `if` and was dropped in silence.
// That is what makes the backend's new `event: error` frame worth emitting at all — a frame no
// client handles is a fix that changes nothing. The page's optimistic "Syncing" pill only leaves
// that state on a frame, so this callback is the whole mechanism by which a lost push stops
// spinning a row forever.
import { afterEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

import { connectorsApi, streamConnectors } from './connectors';

function sseResponse(text: string): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(text));
				controller.close();
			}
		}),
		{ status: 200, headers: { 'content-type': 'text/event-stream' } }
	);
}

/** Let the detached async reader inside `streamConnectors` run to completion. */
async function settle(pred: () => boolean) {
	for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 0));
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

afterEach(() => authFetch.mockReset());

describe('connectorsApi.get asks for a row window', () => {
	it('sends no query when the caller wants the default window', async () => {
		authFetch.mockResolvedValueOnce(jsonResponse({ slug: 'a', rows: [] }));
		await connectorsApi.get('a');
		expect(authFetch).toHaveBeenCalledWith('/api/connectors/a');
	});

	it('⛔ puts `limit` (and `offset`) on the wire — without this the drawer can only ever see 50 rows', async () => {
		authFetch.mockResolvedValueOnce(jsonResponse({ slug: 'a', rows: [] }));
		await connectorsApi.get('a', { limit: 200, offset: 200 });
		const url = authFetch.mock.calls[0]![0] as string;
		expect(url).toContain('limit=200');
		expect(url).toContain('offset=200');
	});

	it('escapes the slug rather than pasting it into the path', async () => {
		authFetch.mockResolvedValueOnce(jsonResponse({ slug: 'a b', rows: [] }));
		await connectorsApi.get('a b', { limit: 200 });
		expect(authFetch.mock.calls[0]![0]).toContain('a%20b');
	});
});

describe('streamConnectors reports a failed server-side push', () => {
	it('⛔ an `error` frame reaches the caller — the frame the backend emits is one this client handles', async () => {
		authFetch
			.mockResolvedValueOnce(sseResponse('event: error\ndata: {"code":"push_failed"}\n\n'))
			// The reader loop reconnects when a stream ends without the caller closing it; a non-2xx
			// on the second attempt is its clean exit, so this test cannot hang on the retry timer.
			.mockResolvedValue(new Response('', { status: 500 }));

		const onSynced = vi.fn();
		const onPushError = vi.fn();
		const s = streamConnectors(onSynced, onPushError);
		await settle(() => onPushError.mock.calls.length > 0);
		s.close();

		expect(onPushError, 'the error frame was dropped — the "Syncing" pill spins forever').toHaveBeenCalledTimes(1);
		// A `synced` handler must NOT be fired by an error frame: it takes a `Connector` and would
		// splice `{code:'push_failed'}` into the table as a row.
		expect(onSynced).not.toHaveBeenCalled();
	});

	it('a `synced` frame still routes to `onSynced` only — the error path did not swallow the happy one', async () => {
		authFetch
			.mockResolvedValueOnce(sseResponse('event: synced\ndata: {"id":"c1","slug":"c"}\n\n'))
			.mockResolvedValue(new Response('', { status: 500 }));

		const onSynced = vi.fn();
		const onPushError = vi.fn();
		const s = streamConnectors(onSynced, onPushError);
		await settle(() => onSynced.mock.calls.length > 0);
		s.close();

		expect(onSynced).toHaveBeenCalledTimes(1);
		expect(onSynced.mock.calls[0]![0]).toMatchObject({ id: 'c1' });
		expect(onPushError).not.toHaveBeenCalled();
	});

	it('the callback is optional — an older caller that passes one argument still works', async () => {
		authFetch
			.mockResolvedValueOnce(sseResponse('event: error\ndata: {"code":"push_failed"}\n\n'))
			.mockResolvedValue(new Response('', { status: 500 }));
		const onSynced = vi.fn();
		const s = streamConnectors(onSynced);
		await settle(() => authFetch.mock.calls.length > 1);
		s.close();
		expect(onSynced).not.toHaveBeenCalled();
	});
});
