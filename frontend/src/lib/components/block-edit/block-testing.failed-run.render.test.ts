// @vitest-environment jsdom
//
// src/lib/components/block-edit/block-testing.failed-run.render.test.ts — the Testen tab must come
// back after a run that FAILS, not only after one that finishes.
//
// ⛔ THE DEFECT, MEASURED IN THE LIVE APP. `/block-edit?slug=…` → Testen → "Alle tests uitvoeren",
// with the request refused (402 licence, 403, a 500 from the runner) or the connection dropped.
// The button switches to "Bezig…", `disabled={running || …}`, and never comes back: `running` was
// set before the call and cleared ONLY inside `onEnd`, while `streamTests` reached `onError` and
// returned without ever calling `onEnd`. The suite cannot be re-run for the rest of the session —
// switching tabs (which unmounts the component) or F5 are the only ways out, and neither is
// discoverable from a screen that says "Bezig…" about a run that ended seconds ago.
//
// ⚠️ THE SEAM IS `authFetch`, NOT `blocksApi`. Mocking `blocksApi.streamTests` would let the test
// choose which callbacks fire, and the defect IS which callbacks fire — a mock that politely calls
// `onError` then `onEnd` passes against the unfixed component. So the real client runs here and
// only the transport is stubbed; the two halves (`streamTests`'s terminal contract and the
// component's use of it) are measured together, which is the only way this wedge is reachable.
//
// `blocks.stream-tests-terminal.test.ts` pins the producer's half in isolation (exactly-once
// `onEnd`, on every terminal outcome, plus the localized failure text).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

import BlockTesting from './BlockTesting.svelte';
import type { BlockDescriptor, BlockTest } from '$lib/types/blocks';

const DESCRIPTOR: BlockDescriptor = {
	inputs: { bedrag: { type: 'number', required: true } },
	outputs: { totaal: { type: 'number' } },
	capabilities: { network: false, llm: false, mockData: false }
};

const TEST_ROW: BlockTest = {
	id: 't-1',
	name: 'telt btw op',
	description: null,
	inputs: { bedrag: 100 },
	datasets: [],
	expected: { totaal: 121 },
	assert_mode: 'subset',
	expect_error: false,
	expected_error_kind: null,
	enabled: true,
	created_at: '2026-08-01T00:00:00Z',
	updated_at: '2026-08-01T00:00:00Z',
	last_result: null
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	authFetch.mockReset();
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

/** Drain the component's detached promises (load, datasets, the stream reader) and re-render. */
async function settle(rounds = 60) {
	for (let i = 0; i < rounds; i++) {
		await Promise.resolve();
		flushSync();
	}
}

function runButton(): HTMLButtonElement {
	const btns = [...host.querySelectorAll('button.btn-primary')] as HTMLButtonElement[];
	expect(btns.length, 'the "run all" button is not on screen').toBeGreaterThan(0);
	return btns[0]!;
}

/** Routes the component's real API calls; `runResponse` decides how the test run ends. */
function stubTransport(runResponse: () => Response | Promise<Response>) {
	authFetch.mockImplementation(async (url: string) => {
		if (url.startsWith('/api/datasets')) return json({ items: [], total: 0 });
		if (url.includes('/tests')) return json({ items: [TEST_ROW], total: 1, version_id: 'v1' });
		if (url.includes('/test')) return runResponse();
		throw new Error(`[test] unrouted request: ${url}`);
	});
}

async function render() {
	app = mount(BlockTesting, {
		target: host,
		// `canAuthor: true` — this file is about an AUTHOR's failed run. WHO may see the run control
		// at all is pinned where the prop comes from, in
		// src/routes/block-edit/block-edit.author-gate.render.test.ts.
		props: {
			slug: 'btw-berekenen',
			version: '1.0.0',
			descriptor: DESCRIPTOR,
			isDraft: true,
			canAuthor: true
		}
	});
	flushSync();
	await settle();
	// ⛔ POSITIVE ANCHOR. Without a loaded test the button is disabled for an unrelated reason
	// (`tests.length === 0`) and every assertion below would be vacuous.
	expect(host.textContent).toContain(TEST_ROW.name);
	expect(runButton().disabled, 'the run button must start enabled').toBe(false);
}

describe('a failed test run releases the Testen tab', () => {
	it('⛔ a 500 from the runner does not wedge the run button', async () => {
		stubTransport(() => new Response('', { status: 500 }));
		await render();

		runButton().click();
		flushSync();
		expect(runButton().disabled, 'the click did not start a run — the test proves nothing').toBe(true);

		await settle();
		expect(
			runButton().disabled,
			'the run button is still "Bezig…" after the run failed — the tab is wedged for the session'
		).toBe(false);
		// ⛔ AND THE REASON SURVIVES. Measured while fixing this: the terminal handler ends with a
		// `load()`, and `load()` clears the component's `error` — so the first cut of the fix
		// re-enabled the button and then wiped the explanation off the screen half a tick later,
		// trading a wedged button for a silent failure. The run's failure now has its own state.
		expect(host.querySelector('.banner.error'), 'no failure banner').not.toBeNull();
	});

	it('⛔ a dropped connection does not wedge the run button', async () => {
		stubTransport(() => Promise.reject(new TypeError('Failed to fetch')));
		await render();

		runButton().click();
		flushSync();
		expect(runButton().disabled).toBe(true);

		await settle();
		expect(runButton().disabled).toBe(false);
		// And the banner speaks the product's language, not the fetch API's.
		expect(host.querySelector('.banner.error')?.textContent ?? '').not.toContain('Failed to fetch');
	});

	it('a run that completes normally also releases the button', async () => {
		stubTransport(
			() =>
				new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(
								new TextEncoder().encode(
									'event: summary\ndata: {"testsPassing":true,"total":1,"passed":1,"failed":0,"errored":0}\n\n' +
										'event: end\ndata: {}\n\n'
								)
							);
							c.close();
						}
					}),
					{ status: 200, headers: { 'content-type': 'text/event-stream' } }
				)
		);
		await render();

		runButton().click();
		flushSync();
		expect(runButton().disabled).toBe(true);

		await settle();
		expect(runButton().disabled).toBe(false);
		expect(host.querySelector('.banner.error')).toBeNull();
	});
});
