// @vitest-environment jsdom
//
// src/lib/components/block-edit/block-simulate.error-kind.render.test.ts — the Simulate tab's
// "save this as a test that expects the error" note, in DUTCH.
//
// ⛔ THE DEFECT. The note was
//
//     m.blocksim_save_expect_error_note({ kind: result.error?.kind ?? 'error' })
//
// and `kind` is an `ErrorKind` off the wire. So the sentence a Dutch author reads before confirming
// what their saved test will assert was
//
//     "Deze run gaf een fout — hij wordt opgeslagen als test die deze fout verwacht (block_throw)."
//
// — the product's own chrome, in the reader's language, with an English enum member in its
// parentheses. It is the SAME defect `error-kind-label.ts` was extracted to close on
// `BlockResultView` (which rendered `BLOCK_THROW` in a coral pill over a fully Dutch paragraph),
// and this call site was the one holdout: `RunConsole`, `BlockResultView` and
// `i18n/block-test-error-label.ts` all already go through `errorKindLabel`.
//
// ⛔ NO NEW KEYS, AND THAT IS A DECISION, NOT A SHORTCUT. Two catalog families describe an
// `ErrorKind`: `console_error_kind_*` are SHORT NAMES ("blokfout", "time-out") and
// `blockresult_errkind_*` are PARAGRAPHS. A parenthetical takes the short name — which is what
// `errorKindLabel` returns — so the note and the result pill three elements above it can no longer
// print two different words for one value.
//
// ⚠️ ASSERTS DUTCH WORDS, NOT KEY NAMES — same choice as every sibling spec in this directory. The
// reader-visible defect IS an English token in a Dutch sentence; a key-name stub renders both the
// broken and the fixed version as the same key name and can see nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockDescriptor, SimulateResult } from '$lib/types/blocks';
import type { ErrorKind } from '$lib/types/trace';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		// The parameter is really interpolated — that is the whole subject of this file. A stub that
		// discards its arguments renders the note as the literal "({kind})" and can tell the defect
		// from the fix in neither direction.
		mod[key] = (params?: Record<string, unknown>) =>
			catalog[key].replace(/\{(\w+)\}/g, (whole: string, name: string) =>
				params && name in params ? String(params[name]) : whole
			);
	}
	return mod;
});
vi.mock('$lib/stores/locale.svelte', () => ({ locale: { current: 'nl' } }));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));
vi.mock('$lib/api/datasets', () => ({
	datasetsApi: { listAll: vi.fn(), list: vi.fn(), get: vi.fn(), listMappings: vi.fn() }
}));

const { simulate } = vi.hoisted(() => ({ simulate: vi.fn() }));
vi.mock('$lib/api/blocks', () => ({
	blocksApi: {
		simulate,
		listTests: vi.fn(),
		createTest: vi.fn(),
		patchTest: vi.fn(),
		deleteTest: vi.fn(),
		streamTests: vi.fn(() => ({ close: () => {} }))
	},
	ApiError: class ApiError extends Error {
		status = 500;
	}
}));

import BlockSimulate from './BlockSimulate.svelte';

/** The short names, straight out of `messages/nl.json` — the family `errorKindLabel` reaches. */
const BLOCK_THROW_NL = 'blokfout';
const TIMEOUT_NL = 'time-out';
const UNKNOWN_NL = 'onbekende fout';

/** A block with no dataset input, so nothing in this file depends on the dataset list. */
const DESCRIPTOR: BlockDescriptor = {
	inputs: { bedrag: { type: 'number', required: true } },
	outputs: { totaal: { type: 'number' } },
	capabilities: { network: false, llm: false, mockData: false }
} as unknown as BlockDescriptor;

function errored(kind: ErrorKind | null): SimulateResult {
	return {
		status: 'error',
		durationMs: 42,
		outputs: null,
		logs: [],
		error: kind ? { kind, message: 'boom' } : null
	} as unknown as SimulateResult;
}

const ok: SimulateResult = {
	status: 'ok',
	durationMs: 42,
	outputs: { totaal: 3 },
	logs: [],
	error: null
} as unknown as SimulateResult;

let host: HTMLElement;
let app: Record<string, unknown> | null = null;

async function settle(rounds = 24) {
	for (let i = 0; i < rounds; i++) {
		await Promise.resolve();
		flushSync();
	}
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** Click a button by its exact Dutch label, proving it exists first. */
async function clickLabel(text: string) {
	const btn = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
	expect(btn, `no control labelled "${text}" — this case tests nothing`).toBeTruthy();
	// ⛔ `bubbles: true` — Svelte 5 delegates DOM events to the mount root.
	btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	await settle();
}

/**
 * Run the block, then open the save form — the only path to the note under test.
 *
 * ⛔ BOTH STEPS ARE ASSERTED. The note lives behind `{#if result}` → `{#if saveOpen}` →
 * `{#if result.status === 'error'}`; a mount that never ran, or a save form that never opened,
 * makes "the English token is gone" true for free.
 */
async function openSaveForm(result: SimulateResult) {
	simulate.mockResolvedValue(result);
	app = mount(BlockSimulate, {
		target: host,
		props: { slug: 'flag-claims', version: 'v3', descriptor: DESCRIPTOR, examples: [] }
	}) as Record<string, unknown>;
	await settle();
	await clickLabel('Simulatie uitvoeren');
	expect(simulate, 'the simulate call never happened').toHaveBeenCalledWith('flag-claims', 'v3', expect.anything());
	await clickLabel('Deze run als test opslaan');
}

function note(): HTMLElement {
	const p = host.querySelector('.save-form p.note');
	expect(p, 'the save form’s note never rendered — this case tests nothing').not.toBeNull();
	return p as HTMLElement;
}

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	simulate.mockReset();
});

describe('the Simulate tab’s expect-error note speaks the reader’s language', () => {
	it('⛔ THE DEFECT: "block_throw" is now "blokfout"', async () => {
		// REVERT THAT TURNS THIS RED: `kind: result.error?.kind ?? 'error'`. The note then reads
		// "…die deze fout verwacht (block_throw)." — both assertions invert.
		await openSaveForm(errored('block_throw'));

		expect(note().textContent).toContain(BLOCK_THROW_NL);
		expect(
			note().textContent,
			'the wire token is still in the sentence a Dutch author is asked to confirm'
		).not.toContain('block_throw');
	});

	it('…and every other kind goes through the same labeller, not a special case', async () => {
		// One member proves a `case`; a second proves it is a labeller and not an `if`.
		await openSaveForm(errored('timeout'));
		expect(note().textContent).toContain(TIMEOUT_NL);
		expect(note().textContent).not.toContain('timeout');
	});

	it('⛔ AN ABSENT `error` GETS THE LABELLER’S OWN UNKNOWN WORD, not the literal "error"', async () => {
		// The `?? 'error'` fallback that used to sit here printed the bare English word `error` in the
		// same parentheses — the defect wearing a shorter name. `result.error` is nullable on the type
		// even inside the `status === 'error'` branch, so this arm is live.
		await openSaveForm(errored(null));
		expect(note().textContent).toContain(UNKNOWN_NL);
		expect(note().textContent).not.toContain('(error)');
	});

	it('⚠️ a SUCCESSFUL run gets a different note entirely — this one is not unconditional', async () => {
		// The complement: `{#if result.status === 'error'}` has two siblings, and a fix that rendered
		// this note always would caption every green run with "deze fout verwacht".
		await openSaveForm(ok);
		// This fixture pins a structured output, so `canPin` is true and the ok branch renders the
		// assert-mode select instead of any note. Asserted POSITIVELY first: without it, "the error
		// note is absent" is also true of a save form that never opened.
		expect(
			host.querySelector('.save-form select'),
			'the ok branch rendered neither its select nor a note — the save form never opened'
		).not.toBeNull();
		expect(host.querySelector('.save-form p.note'), 'the error note rendered on a green run').toBeNull();
		expect(host.textContent).not.toContain('deze fout verwacht');
		expect(host.textContent).not.toContain(BLOCK_THROW_NL);
	});
});
