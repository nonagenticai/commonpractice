// src/lib/stores/agent-chat.broker-rejection.test.ts — the AI chat must report a metered-broker
// refusal in the reader's language, not in the broker's English.
//
// ⛔ THE DEFECT. `backend/src/host/llm-broker.ts` refuses a brokered call with a `BrokerRejection`
// carrying a CLOSED 3-member `kind` (llm_capped / model_not_allowed / budget_exhausted) plus
// hardcoded English prose — for budget_exhausted, two sentences naming "Administer → LLM settings"
// (`BUDGET_EXHAUSTED_MESSAGE`). The RUN path already maps that `kind` to catalog copy (RunConsole.svelte:76,
// BlockResultView.svelte:36-49). The CHAT path did not: `backend/src/ai/agent.ts`'s catch read only
// `err.message`, dropped `.kind` on the floor, and this store rendered the surviving English string
// raw. A Dutch author who hit their workspace's cap got an English paragraph in the chat panel.
//
// ⛔ THIS IS A SEPARATE FILE FROM `agent-chat.flow-guard.test.ts` ON PURPOSE, AND THE REASON IS THE
// MESSAGE MOCK. That file replaces `$lib/paraglide/messages` wholesale with five sentinel functions
// — correct for it (it asserts turn/abort mechanics, where the words are noise) and fatal here,
// where the words ARE the subject: with the catalog mocked, this file would pass against a store
// that emitted key names, and would say nothing about whether `nl.json` has copy or whether it ever
// renders. So: the REAL compiled catalog, and `overwriteGetLocale` — the same lever
// `$lib/stores/locale.svelte.ts` pulls in the running app.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { issueAgentTokenMock, streamAgentChatMock, postToolResultMock } = vi.hoisted(() => ({
	issueAgentTokenMock: vi.fn(),
	streamAgentChatMock: vi.fn(),
	postToolResultMock: vi.fn()
}));

// ⛔ THE ONE MODULE THAT MUST BE MOCKED, AND ONLY BECAUSE OF ITS IMPORT CHAIN, not its behaviour:
// agent-chat.svelte.ts → $lib/api/agent → auth-fetch.ts → $lib/services/keycloak.ts → `new
// Keycloak(...)` at module load, a browser-only call that throws under plain node. Nothing about
// the message layer is mocked (see the header).
vi.mock('$lib/api/agent', () => ({
	issueAgentToken: issueAgentTokenMock,
	streamAgentChat: streamAgentChatMock,
	postToolResult: postToolResultMock,
	AgentApiError: class AgentApiError extends Error {
		constructor(
			readonly status: number,
			message: string,
			readonly code?: string
		) {
			super(message);
		}
	}
}));

import { AgentChatStore } from './agent-chat.svelte';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';
import { llmSettingsPath } from '$lib/i18n/llm-settings-path';
import type { AgentEvent } from '$lib/types/agent';

/** The verbatim English paragraph `llm-broker.ts`'s `BUDGET_EXHAUSTED_MESSAGE` puts on the wire for
 *  a budget refusal — on BOTH paths. `runMetered` returns it as a value; `brokerChatStream` throws
 *  it inside a `BrokerRejection('budget_exhausted', …)` when the provider answers 402/403/429, which
 *  is what makes this the frame THIS surface can actually receive rather than a hypothetical one.
 *  Covered end-to-end by backend `agent-loop.test.ts` ("reaches the browser as kind=budget_exhausted"). */
const WIRE_BUDGET_EN =
	'The LLM budget for this workspace is exhausted. Add your own provider key in ' +
	'Settings → Organisation → LLM settings, or ask your Common Practice contact to top up the budget.';
/** llm-broker.ts, reserveCall's allowlist gate. */
const WIRE_MODEL_EN = "model 'gpt-5-mini' is not allowlisted";
/** llm-broker.ts, reserveCall's daily-cap gate. */
const WIRE_CAP_EN = 'daily LLM call cap reached (50)';

function driverStub() {
	return { apply: vi.fn().mockResolvedValue({ ok: true, output: {} }) };
}

/** Captures the handlers `streamAgentChat` was given so a test can push events into the store
 *  exactly as the real SSE reader loop would. */
function wireStream() {
	let handlers: { onEvent: (ev: AgentEvent) => void };
	streamAgentChatMock.mockImplementation((_a: unknown, h: typeof handlers) => {
		handlers = h;
		return { close: vi.fn() };
	});
	return { emit: (ev: AgentEvent) => handlers!.onEvent(ev) };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** Send one turn, push a `turn-end` error frame, and hand back the text of the error bubble. */
async function endTurnWith(frame: Omit<Extract<AgentEvent, { type: 'turn-end' }>, 'type'>) {
	const { emit } = wireStream();
	const chat = new AgentChatStore({ driver: driverStub() });
	await chat.send('vat dit samen');
	emit({ type: 'turn-end', ...frame });
	await flush();
	const last = chat.messages[chat.messages.length - 1]!;
	// ⛔ THE POSITIVE MARKER. "the text is not English" is satisfied by a store that pushed nothing
	// at all, or that pushed the refusal as a plain assistant bubble. It must be an ERROR bubble,
	// and the turn must be over.
	expect(last.kind, 'the refusal was not rendered as an error message').toBe('error');
	expect(chat.busy, 'the turn never ended').toBe(false);
	return last.text;
}

beforeEach(() => {
	issueAgentTokenMock.mockReset().mockResolvedValue('tok');
	streamAgentChatMock.mockReset();
	postToolResultMock.mockReset().mockResolvedValue(undefined);
	overwriteGetLocale(() => 'nl');
});
afterEach(() => {
	overwriteGetLocale(() => 'en');
});

describe('a Dutch author reads a broker refusal in the chat panel', () => {
	it('the fixture really is Dutch, and really differs from English', () => {
		// ⛔ NON-VACUITY. Every assertion below is "the bubble contains the nl string". If
		// `overwriteGetLocale` stopped working, `m.*()` would return ENGLISH, the bubble would contain
		// it, and the file would pass while proving the exact opposite.
		overwriteGetLocale(() => 'nl');
		const nl = [
			m.blockresult_errkind_budget_exhausted({ path: llmSettingsPath() }),
			m.blockresult_errkind_llm_capped(),
			m.blockresult_errkind_model_not_allowed()
		];
		overwriteGetLocale(() => 'en');
		const en = [
			m.blockresult_errkind_budget_exhausted({ path: llmSettingsPath() }),
			m.blockresult_errkind_llm_capped(),
			m.blockresult_errkind_model_not_allowed()
		];
		expect(nl).not.toEqual(en);
		for (let i = 0; i < nl.length; i++) expect(nl[i]).not.toBe(en[i]);
	});

	it('⛔ budget_exhausted — localized copy, never the broker’s English paragraph', async () => {
		// REVERT THAT TURNS THIS RED (either half): (a) drop `kind` from the `turn-end` emit in
		// backend/src/ai/agent.ts — the frame arrives without it and the store falls back to
		// `message`, i.e. this exact English paragraph; (b) delete the `brokerRejectionCopy` call in
		// agent-chat.svelte.ts — same result from the frontend side.
		const text = await endTurnWith({
			turnId: 't1',
			status: 'error',
			message: WIRE_BUDGET_EN,
			kind: 'budget_exhausted'
		});
		overwriteGetLocale(() => 'nl');
		expect(text).toBe(m.blockresult_errkind_budget_exhausted({ path: llmSettingsPath() }));
		expect(text, 'the English paragraph is still in the chat panel').not.toContain(
			'Organisation → LLM settings'
		);
		expect(text).not.toContain(WIRE_BUDGET_EN);
	});

	it('⛔ llm_capped — localized copy, never the English cap sentence', async () => {
		const text = await endTurnWith({
			turnId: 't1',
			status: 'error',
			message: WIRE_CAP_EN,
			kind: 'llm_capped'
		});
		overwriteGetLocale(() => 'nl');
		expect(text).toBe(m.blockresult_errkind_llm_capped());
		expect(text).not.toContain(WIRE_CAP_EN);
	});

	it('⛔ model_not_allowed — localized copy, never the English allowlist sentence', async () => {
		const text = await endTurnWith({
			turnId: 't1',
			status: 'error',
			message: WIRE_MODEL_EN,
			kind: 'model_not_allowed'
		});
		overwriteGetLocale(() => 'nl');
		expect(text).toBe(m.blockresult_errkind_model_not_allowed());
		expect(text).not.toContain(WIRE_MODEL_EN);
	});

	it('⛔ NO kind at all — the message still renders (the rolling-deploy branch)', async () => {
		// ⛔ THE BRANCH THAT KEEPS THIS FIX FROM BEING AN OUTAGE. `maxSurge: 1 / maxUnavailable: 0`
		// guarantees a window where an OLD backend pod, which has never heard of `kind`, serves this
		// SPA. It emits `turn-end` with `message` only. If the store preferred localized copy
		// unconditionally — or, worse, blanked the bubble when the lookup missed — every chat failure
		// during a deploy would render empty or wrong. English-but-true beats blank.
		const text = await endTurnWith({
			turnId: 't1',
			status: 'error',
			message: 'upstream connect error or disconnect/reset before headers'
		});
		expect(text).toBe('upstream connect error or disconnect/reset before headers');
	});

	it('⛔ an UNKNOWN kind — the message still renders (a future 4th BrokerRejectionKind)', async () => {
		// The same fallback for the forward-compatible case: `BrokerRejectionKind` is closed TODAY at
		// three members, and the day a fourth is added the backend ships first. This SPA must keep
		// rendering something readable rather than going blank on a kind it cannot map — which is why
		// `AgentEvent['kind']` is typed `string` on the wire and not as the literal union.
		const text = await endTurnWith({
			turnId: 't1',
			status: 'error',
			message: 'tenant provider key revoked',
			kind: 'provider_key_revoked'
		});
		expect(text).toBe('tenant provider key revoked');
	});

	it('a NON-broker error end is untouched — the kind path is not a catch-all', async () => {
		// An `error` end with no kind is not a refusal. The mapping must not reach it.
		const text = await endTurnWith({
			turnId: 't1',
			status: 'error',
			message: 'no result from provider'
		});
		expect(text).toBe('no result from provider');
	});
});

describe('a Dutch reader whose question ran out of assistant budget', () => {
	it('⛔ max_iterations renders localized copy, never the loop’s English internals', async () => {
		// Prod, 2026-10-16: the whole reply to "Wat doet deze flow?" was the English string below.
		// An OLD backend mid-roll still sends it, so the frame here carries it on purpose.
		// REVERT THAT TURNS THIS RED: drop the `max_iterations` branch in agent-chat.svelte.ts —
		// the store falls back to `message` and renders this exact English.
		const text = await endTurnWith({
			turnId: 't1',
			status: 'max_iterations',
			message: 'reached max iterations'
		});
		expect(text).toBe(m.chat_turn_incomplete());
		expect(text).not.toMatch(/max iterations/i);
		overwriteGetLocale(() => 'en');
		expect(text, 'the fixture is not Dutch').not.toBe(m.chat_turn_incomplete());
	});

	it('the new backend’s frame (no message) gets the same copy', async () => {
		const text = await endTurnWith({ turnId: 't1', status: 'max_iterations' });
		expect(text).toBe(m.chat_turn_incomplete());
	});
});
