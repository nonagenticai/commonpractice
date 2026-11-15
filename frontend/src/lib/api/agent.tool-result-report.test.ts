// The browser's half of the cross-replica frontend-tool defect.
//
// ⛔ THE DEFECT. `postToolResult` is a BRAND-NEW `fetch()` — not the SSE stream — so it takes a
// fresh trip through the ClusterIP Service, which fronts 2-4 replicas with no sessionAffinity. When
// it landed on a pod that was not holding the turn, the backend answered 400 `no_pending_tool` and
// the store threw the response away inside `catch { /* non-fatal */ }`. The edit was already on the
// canvas; the assistant was told 30 seconds later that its own tool had timed out; and the ONLY
// evidence anywhere was two rows in prod `chat_messages`. Nothing was logged, nothing was shown.
//
// Two things had to change here and both are pinned below:
//   1. the report RETRIES, because with no sessionAffinity each attempt is an independent draw
//      across the replicas — the only thing that can find the owner while a not-yet-upgraded pod is
//      still in the rotation mid-roll;
//   2. a total failure is SURFACED rather than swallowed.
//
// ⚠️ THE STORE HALF DELIBERATELY DOES NOT MOCK `$lib/api/agent` WHOLESALE THE WAY ITS SIBLING
// FILES DO — it mocks `fetch`, so the retry loop and the store's reaction are exercised as one
// path. Mocking `postToolResult` itself would prove only that the store calls a function.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postToolResult, AgentApiError } from './agent';

function jsonRes(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

const ARGS = { turnId: 't1', callId: 'c1', token: 'tok', payload: { ok: true, output: {} } };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn();
	vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
	vi.unstubAllGlobals();
});

describe('postToolResult reports across replicas', () => {
	it('succeeds on the first attempt without retrying', async () => {
		fetchMock.mockResolvedValue(jsonRes(200, { resolved: true, delivery: 'delivered' }));
		await expect(postToolResult(ARGS)).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('⛔ retries a 400 no_pending_tool — the wrong-replica answer an OLD pod still gives mid-roll', async () => {
		fetchMock
			.mockResolvedValueOnce(
				jsonRes(400, { error: 'no_pending_tool', message: 'No tool call awaiting this turn/call id' }),
			)
			.mockResolvedValueOnce(jsonRes(200, { resolved: true, delivery: 'queued' }));

		await expect(postToolResult(ARGS)).resolves.toBeUndefined();
		// THE POSITIVE OBSERVATION: a second draw actually happened. Before the fix there was
		// exactly one attempt and its rejection was discarded by the caller.
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('retries a network failure (no response at all)', async () => {
		fetchMock
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockResolvedValueOnce(jsonRes(200, { resolved: true }));
		await expect(postToolResult(ARGS)).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('⛔ throws — never resolves silently — once every attempt has failed', async () => {
		fetchMock.mockResolvedValue(jsonRes(400, { error: 'no_pending_tool', message: 'nope' }));
		await expect(postToolResult(ARGS)).rejects.toBeInstanceOf(AgentApiError);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('does NOT retry a 403 — that is about the token, and another replica cannot help', async () => {
		fetchMock.mockResolvedValue(jsonRes(403, { error: 'forbidden', message: 'nope' }));
		await expect(postToolResult(ARGS)).rejects.toBeInstanceOf(AgentApiError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
