// @vitest-environment jsdom
//
// src/lib/components/block-edit/block-fix-seed.i18n.test.ts — the first message of a "Fix with AI"
// session, in Dutch, with its machine-readable payload intact.
//
// ⛔ THE DEFECT. `BlockFixAssistant.buildSeed()` composed a raw ENGLISH prompt — "Fix this block.
// slug=…", "Failure (…)", "Output diffs (expected vs actual):", "Lint findings:", "Auto-iterate is
// ON", "current source_ts:" — and `chat.send()` (agent-chat.svelte.ts) pushes it into the feed as a
// USER message, which `ChatPanel.svelte` renders VERBATIM inside fully-Dutch chrome. So this was
// not a hidden prompt: it was English paragraphs on a primary Dutch authoring surface, printed in
// the reader's own chat history. The sibling `BlockAuthorAssistant.start()` already did this
// correctly with `blockauthor_seed_goal` / `_cell` / `_dataset`.
//
// ⚠️ HALF THIS FILE IS THE OTHER HALF OF THE CONTRACT: the seed is ALSO the LLM's brief. A
// "localization" that translated the slug, the version, the `descriptor` JSON, the raw diff
// payload, each lint finding's `rule`/`message`, or `source_ts` would hand the model names that
// exist nowhere in the block it is being asked to repair. Every one of those is asserted to survive
// the change byte-for-byte — a test that only checked for Dutch words would pass a fix that broke
// the tool.
//
// ⚠️ THE SEAM IS `$lib/api/agent`, as in `block-fix-assistant.render.test.ts`: the real module
// pulls in auth-fetch → keycloak.ts, which calls `new Keycloak(...)` at module load and throws
// outside a browser. The message asserted below is the one really handed to `streamAgentChat`, AND
// the one really painted into the feed — both, because either alone can pass while the other lies.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockDescriptor } from '$lib/types/blocks';
import type { BlockFixContext } from '$lib/agent/block-fix-driver';

const { issueAgentTokenMock, streamAgentChatMock, postToolResultMock, closeMock } = vi.hoisted(
	() => ({
		issueAgentTokenMock: vi.fn(),
		streamAgentChatMock: vi.fn(),
		postToolResultMock: vi.fn(),
		closeMock: vi.fn()
	})
);

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

// The REAL nl catalog, read from disk — so this measures the strings that actually ship,
// and goes red the day a key is dropped instead of quietly asserting a copy of itself.
vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = (params?: Record<string, unknown>) =>
			catalog[key].replace(/\{(\w+)\}/g, (whole: string, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	return mod;
});
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'nl' } }));

import BlockFixAssistant from './BlockFixAssistant.svelte';

const SLUG = 'btw-berekenen';
const VERSION = '0.2.0';
const SOURCE = 'export default { run: () => ({ totaal: 0 }) };';
const DESCRIPTOR: BlockDescriptor = {
	inputs: { bedrag: { type: 'number', required: true } },
	outputs: { totaal: { type: 'number' } },
	capabilities: { network: false, llm: false, mockData: false }
} as unknown as BlockDescriptor;

/** Every English fragment the old `buildSeed()` emitted. None may survive. */
const OLD_ENGLISH = [
	'Fix this block.',
	'draft version=',
	'Failure (',
	'Output diffs (expected vs actual)',
	'Lint findings:',
	'Auto-iterate is',
	'current source_ts:'
];

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
	issueAgentTokenMock.mockReset().mockResolvedValue('tok');
	postToolResultMock.mockReset().mockResolvedValue(undefined);
	closeMock.mockReset();
	streamAgentChatMock.mockReset().mockImplementation(() => ({ close: closeMock }));
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

/** Mount the panel, press its Start button, and return the seed really sent. */
async function seedFor(context: BlockFixContext): Promise<string> {
	app = mount(BlockFixAssistant, {
		target: host,
		props: {
			slug: SLUG,
			version: VERSION,
			sourceTs: SOURCE,
			descriptor: DESCRIPTOR,
			context,
			onApply: () => {},
			onClose: () => {}
		}
	}) as Record<string, unknown>;
	flushSync();
	const start = [...host.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === 'Vraag AI dit te repareren'
	) as HTMLButtonElement | undefined;
	expect(start, 'no Start button — the seed is never composed and this case tests nothing').toBeTruthy();
	start!.click();
	for (let i = 0; i < 12; i++) await Promise.resolve();
	flushSync();
	expect(streamAgentChatMock, 'no turn was started').toHaveBeenCalledTimes(1);
	return (streamAgentChatMock.mock.calls[0]![0] as { message: string }).message;
}

describe('the "Fix with AI" seed — Dutch prose, verbatim payload', () => {
	it('⛔ a SIMULATE failure seeds Dutch, and the reader sees that Dutch in their own feed', async () => {
		// REVERT THAT TURNS THIS RED: put the English template back in `buildSeed()`. Every
		// `toContain` below inverts and the OLD_ENGLISH scan fires.
		const seed = await seedFor({
			origin: 'simulate',
			errorKind: 'validation',
			errorMessage: 'bedrag ontbreekt',
			diffs: [{ path: 'totaal', kind: 'value', expected: 121, actual: 0 }]
		});

		expect(seed).toContain('Herstel dit blok.');
		// `simulate` → "simulatie": the origin enum is a wire token, not a word, and is asserted
		// specifically because its `lint` and `test` spellings happen to be identical in nl.
		expect(seed).toContain('simulatie');
		expect(seed).toContain('Verschillen in de uitvoer');
		expect(seed).toContain('Huidige source_ts:');
		for (const frag of OLD_ENGLISH) {
			expect(seed, `the seed still carries the English fragment "${frag}"`).not.toContain(frag);
		}

		// ⛔ THE OTHER HALF: the identifiers and the payload are UNTOUCHED.
		expect(seed, 'the block slug was mangled').toContain(SLUG);
		expect(seed, 'the version was mangled').toContain(VERSION);
		expect(seed, 'the source field name is an identifier and must survive').toContain('source_ts');
		expect(seed, 'the source itself was mangled').toContain(SOURCE);
		expect(seed, 'the descriptor JSON was mangled').toContain(JSON.stringify(DESCRIPTOR));
		expect(seed, 'the raw diff payload was mangled').toContain('"totaal"');
		expect(seed, 'the backend’s own error sentence was dropped').toContain('bedrag ontbreekt');
		expect(seed, 'the backend error KIND is a code and must survive').toContain('[validation]');

		// ⛔ AND IT IS ON SCREEN. `chat.send()` pushes the seed into the feed as a user message and
		// ChatPanel prints it verbatim — which is why English here was English *text*, not a hidden
		// prompt. An assertion on the wire alone would not have seen that.
		expect(host.textContent, 'the seed never reached the feed').toContain('Herstel dit blok.');
	});

	it('⛔ a LINT failure seeds Dutch prose around VERBATIM rule ids and messages', async () => {
		const seed = await seedFor({
			origin: 'lint',
			lint: [{ rule: 'no-network-without-capability', message: 'fetch() zonder capability', line: 12 }]
		});

		expect(seed).toContain('Lint-bevindingen:');
		expect(seed).toContain('(regel 12)');
		// The rule id is the linter's own identifier — the model needs the exact token to act on it.
		expect(seed, 'the lint rule id was mangled').toContain('no-network-without-capability');
		expect(seed).toContain('fetch() zonder capability');
		for (const frag of OLD_ENGLISH) {
			expect(seed, `the seed still carries the English fragment "${frag}"`).not.toContain(frag);
		}
	});

	it('⛔ the auto-iterate line is Dutch in BOTH states', async () => {
		// THE COMPLEMENT. Localizing only the ON arm leaves "Auto-iterate is OFF." — the DEFAULT
		// state, and therefore the one nearly every reader sees.
		const off = await seedFor({ origin: 'test', testName: 'telt btw op' });
		expect(off).toContain('Automatisch herhalen staat uit.');
		expect(off).not.toContain('Auto-iterate');
		// The test's own name is the author's string and is passed through untouched.
		expect(off).toContain('telt btw op');

		unmount(app!);
		app = undefined;
		streamAgentChatMock.mockClear();
		host.remove();
		host = document.createElement('div');
		document.body.appendChild(host);

		app = mount(BlockFixAssistant, {
			target: host,
			props: {
				slug: SLUG,
				version: VERSION,
				sourceTs: SOURCE,
				descriptor: DESCRIPTOR,
				context: { origin: 'test' } as BlockFixContext,
				onApply: () => {},
				onClose: () => {}
			}
		}) as Record<string, unknown>;
		flushSync();
		const toggle = host.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
		expect(toggle, 'no auto-iterate toggle — the ON arm is unreachable and untested').not.toBeNull();
		toggle!.checked = true;
		toggle!.dispatchEvent(new Event('change', { bubbles: true }));
		toggle!.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		const start = [...host.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'Vraag AI dit te repareren'
		) as HTMLButtonElement;
		start.click();
		for (let i = 0; i < 12; i++) await Promise.resolve();
		flushSync();
		const on = (streamAgentChatMock.mock.calls[0]![0] as { message: string }).message;
		expect(on).toContain('Automatisch herhalen staat aan.');
		expect(on).not.toContain('Auto-iterate');
	});
});
