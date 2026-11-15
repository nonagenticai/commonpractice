// src/lib/stores/agent-chat.refusal-copy.wire.test.ts — the co-pilot chat bubble must not be the
// backend's English sentence, and the proof must survive THE REAL CLIENT.
//
// ⛔ THE DEFECT. `AgentChatStore.send`'s `onError` handler read
//     licenseOrPermissionMessage(e) ?? (e instanceof Error ? e.message : m.chat_error_generic())
// and `licenseOrPermissionMessage` (api/error-message.ts) answers ONLY 402 / 403 / 409
// `seat_limit_reached`. Every other failure of `POST /api/agent/chat` therefore printed
// `e.message` — the backend's English string — into a chat bubble on `/build` and `/block-edit`,
// the two surfaces an ORDINARY author lives on. The fix routes the same error through
// `writeErrorText`, the strict superset that consults `VALIDATION_MESSAGES` for 400/422/409 first
// and falls through to `licenseOrPermissionMessage`.
//
// ⚠️ THE CASE THAT ORIGINALLY PROVED THIS WAS A 400, AND IT IS NOW A 401 — the refusal was
// RENAMED ACROSS A STATUS CLASS, not deleted. `routes/agent.ts:102` used to throw
// `badRequest('no_home_tenant', 'User has no home tenant')` when `users.tenant_id` was NULL; the
// workspace now rides in the agent token as a `tid` claim and the route fails closed with 401
// `agent_token_no_tenant` (:129, and :264 on the tool-result POST). Measured: `no_home_tenant`
// appears nowhere in `backend/src` outside a comment, so a case still feeding that body through
// this route would be the "only the test can make this" wire the header condemns below. Because
// `writeErrorText` routes by STATUS before it reads the code, the successor's copy lives in
// `AGENT_SESSION_MESSAGES` (api/error-message.ts) behind a 401 lookup arm, NOT in
// `VALIDATION_MESSAGES` — an entry there would have been unreachable.
//
// ⛔ WHAT THIS FILE MAY ASSERT IS BOUNDED BY WHAT THE ROUTE CAN THROW, and that bound is why two
// cases were REMOVED from it. `POST /api/agent/chat` emits 401 `agent_token_no_tenant`
// (routes/agent.ts:129), 422 `validation` (the `route()` wrapper's ZodError branch), 404
// `flow_not_found`, other 401s from `verifyAgentToken`, and 5xx — and nothing else. It cannot emit `block_archived`, which
// is thrown in exactly ONE place, `backend/src/host/publication-service.ts:64`, on the
// `POST /api/solutions` path. Two cases here nonetheless fed a `block_archived` body through this
// route to exercise `writeErrorText`'s `naming(...)` branch and its no-`blockSlug` fall-through:
// real client, IMPOSSIBLE WIRE — the same "only the test can make this" sin this header condemns
// two paragraphs down, one level up. They now live in `api/solutions.create.test.ts`, against the
// client for the route that really throws it, at its real 422.
//
// ⚠️ SO NO `naming(...)` ENTRY IS REACHABLE ON THIS ROUTE AT ALL, and the framing that shipped with
// this file said otherwise. "The English sentence is deliberately preserved where the catalog
// cannot name the offender" is a real and deliberate property OF `writeErrorText` — pinned where it
// is live, in `solutions.create.test.ts` — but on THIS surface it is dead code, because not one of
// the five codes above interpolates a value. Nothing here may be read as evidence for it.
//
// ⛔ WHY THIS FILE MOCKS `$lib/api/auth-fetch` AND NOT `$lib/api/agent`, WHICH IS THE WHOLE POINT.
// Its sibling `agent-chat.broker-rejection.test.ts` replaces `$lib/api/agent` with three `vi.fn()`s
// — correct for it (it drives `onEvent` frames, where the client is not the subject) and FATAL
// here. A hand-built `new AgentApiError(401, …, 'agent_token_no_tenant', { … })` is a shape only
// the test can produce, and PR #309 shipped an inert fix on exactly that vacuity: the catalog arithmetic was
// green while the class in between dropped the field the catalog asked for. So every case below
// starts from a REAL `Response`, goes through the REAL `streamAgentChat` — hence through agent.ts's
// own `readErrorBody` and its own `new AgentApiError(status, message ?? …, code, details)` — and
// what the PRODUCT throws is what the store's `onError` receives. `authFetch` is mocked because it
// is the one browser-only link in the chain (`services/keycloak.ts` calls `new Keycloak(...)` at
// module load, which throws under plain node); `globalThis.fetch` is stubbed because that is the
// wire. Nothing in the message layer is mocked: the assertions call the REAL compiled catalog, so
// an English fallback cannot satisfy them.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ⛔ The ALIAS id, never a relative specifier — `mock-specifiers.test.ts` enforces it, and the
// relative form silently fails to apply (see error-message.wire.test.ts's header).
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('$lib/api/auth-fetch', () => ({ authFetch }));

import { AgentChatStore } from './agent-chat.svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';

function driverStub() {
	return { apply: vi.fn().mockResolvedValue({ ok: true, output: {} }) };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

const realFetch = globalThis.fetch;

/**
 * Drive one real turn whose `POST /api/agent/chat` is answered by `res`, and hand back the text of
 * the error bubble the reader actually sees.
 *
 * ⚠️ The `kind === 'error'` and `busy === false` assertions are not padding: "the bubble is not
 * English" is satisfied by a store that pushed nothing at all. Same non-vacuity marker
 * `agent-chat.broker-rejection.test.ts`'s `endTurnWith` carries.
 */
async function bubbleFor(res: Response | (() => Promise<never>)): Promise<string> {
	globalThis.fetch = vi.fn(typeof res === 'function' ? res : async () => res) as typeof fetch;
	const chat = new AgentChatStore({ driver: driverStub() });
	await chat.send('vat dit samen');
	await vi.waitFor(() => {
		expect(chat.messages[chat.messages.length - 1]!.kind).toBe('error');
	});
	expect(chat.busy, 'the turn never ended').toBe(false);
	return chat.messages[chat.messages.length - 1]!.text;
}

beforeEach(() => {
	// The agent-token exchange succeeds in every case here — the refusal under test is the CHAT
	// POST's, one layer further in.
	authFetch.mockReset().mockResolvedValue(jsonResponse(200, { accessToken: 'tok' }));
	overwriteGetLocale(() => 'nl');
});
afterEach(() => {
	globalThis.fetch = realFetch;
	overwriteGetLocale(() => 'en');
});

describe('the chat bubble speaks the reader’s language, through the real agent client', () => {
	it('the nl fixtures really are Dutch (the assertions below are not English-satisfiable)', () => {
		overwriteGetLocale(() => 'nl');
		const nl = [m.error_agent_token_no_tenant(), m.chat_error_generic()];
		overwriteGetLocale(() => 'en');
		const en = [m.error_agent_token_no_tenant(), m.chat_error_generic()];
		// ⛔ NON-VACUITY. If `overwriteGetLocale` stopped working every case would compare English to
		// English and pass while proving the opposite of its name.
		expect(nl).not.toEqual(en);
	});

	it('⛔ a 401 the chat route really throws (`agent_token_no_tenant`) renders the CATALOG sentence', async () => {
		// backend/src/routes/agent.ts:129 — `new HttpError(401, 'agent_token_no_tenant', …)`, thrown by
		// the chat handler itself when the agent token carries no `tid` claim, so this is the live
		// shape and not a hypothetical one.
		//
		// ⛔ AND IT IS THE ONE CASE THAT WOULD HAVE STAYED SILENT. `writeErrorText` routes by STATUS:
		// before the 401 arm existed, this body fell past the 400/422 and 409 branches into
		// `licenseOrPermissionMessage`, which answered 402/403/409-seat/503 and `null` for everything
		// else — so the reader got `chat_error_generic` ("the assistant could not complete that
		// request"), true and useless, and never the one gesture that repairs it. Both assertions are
		// the point: the second is what fails if the copy is ever moved into `VALIDATION_MESSAGES`,
		// where no 401 can reach it.
		const english = 'This copilot session predates workspace-scoped tokens. Reload to start a new one.';
		const text = await bubbleFor(
			jsonResponse(401, { error: 'agent_token_no_tenant', message: english })
		);
		expect(text).toBe(m.error_agent_token_no_tenant());
		expect(text).not.toBe(english);
		expect(text).not.toBe(m.chat_error_generic());
	});

	it('⛔ a body with NO `message` never leaks agent.ts’s own English placeholder', async () => {
		// An ingress/Istio 400, or any refusal whose body carries a code but no sentence:
		// `readErrorBody` yields no `message`, so `AgentApiError.message` is agent.ts's synthetic
		// fallback. That string is the machine-readable half and must stay English — but it must
		// never reach a chat bubble.
		const text = await bubbleFor(new Response('Bad Request', { status: 400 }));
		expect(text).toBe(m.chat_error_generic());
		expect(text).not.toMatch(/chat failed/);
	});

	it('a network-level failure gets the localized generic, not the browser’s English', async () => {
		const text = await bubbleFor(async () => {
			throw new TypeError('Failed to fetch');
		});
		expect(text).toBe(m.chat_error_generic());
		expect(text).not.toBe('Failed to fetch');
	});

	it('⛔ the error object still reaches the console — an outage must not read as a refusal', async () => {
		// ⛔ THE COST OF THE LOCALIZED GENERIC, AND THE REASON IT IS NOT A REGRESSION. Routing the
		// bubble through `writeErrorText` collapsed FOUR different failures onto ONE sentence
		// (`chat_error_generic`): a 500 whose body is `{error:'Internal Server
		// Error'}` and carries no `message` at all, a 401 whose code is NOT `agent_token_no_tenant`
		// (`Invalid or expired agent token`), a 502
		// from the keycloak hop, and a `TypeError: Failed to fetch` when the tab lost the network.
		// That is the RIGHT thing to show a non-technical author — and it means the console line
		// below is the ONLY remaining record of WHICH of the four it was. Without it, `/build` being
		// down and the model declining a turn are the same event to everyone looking at it.
		//
		// `console.error` with a `[chat] …` prefix is this store's own idiom — `report()` already
		// logs `'[chat] could not report a frontend tool result'` the same way.
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const text = await bubbleFor(jsonResponse(500, { error: 'Internal Server Error' }));
			// The READER's half is unchanged: still the localized generic, never the wire string.
			expect(text).toBe(m.chat_error_generic());

			const call = spy.mock.calls.find((c) => String(c[0]).includes('[chat] turn failed'));
			expect(
				call,
				'the error was dropped on the floor — a 500 on /build is now indistinguishable from a ' +
					'model refusal, for the reader AND for whoever is paged about it'
			).toBeDefined();
			// ⛔ NON-VACUITY: a log line that prints only its own prefix records nothing. The ERROR
			// OBJECT has to be in it, carrying the status that names the outage.
			const logged = call![1] as { status?: number };
			expect(logged, 'the log line carried no error object').toBeInstanceOf(Error);
			expect(logged.status).toBe(500);
		} finally {
			spy.mockRestore();
		}
	});

	it('REGRESSION GUARD: 402 keeps the licence copy `licenseOrPermissionMessage` owns', async () => {
		const text = await bubbleFor(
			jsonResponse(402, { error: 'license_required', message: 'No active licence for this app' })
		);
		expect(text).toBe(m.error_license_required());
	});

	it('REGRESSION GUARD: 403 keeps the permission copy', async () => {
		const text = await bubbleFor(
			jsonResponse(403, { error: 'developer_required', message: 'Developer role required' })
		);
		expect(text).not.toBe('Developer role required');
		expect(text).toBe(m.error_developer_required());
	});
});
