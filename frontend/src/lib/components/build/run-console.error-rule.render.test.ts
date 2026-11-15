// @vitest-environment jsdom
//
// src/lib/components/build/run-console.error-rule.render.test.ts — the run console's node_error
// line, in a non-English locale, fed the exact `node_error` events the runner emits.
//
// ⛔ THE DEFECT. `run-console.i18n.render.test.ts` fixed the KIND half of
//     ✗ fetch-claims · block_throw: Cannot read property 'id' of undefined
// and wrote, beside its last assertion, "⚠️ `ev.error` is the block author's own message …
// There is nothing to localise it FROM." That sentence is true of an AUTHOR'S throw and FALSE of
// most of the line's real traffic: `classify()` funnels the runner's OWN refusals through the same
// field — `block 'x' lacks the llm capability`, `foreach input 'in' must be an array`,
// `no source for block version …`, `run wall-clock budget exceeded`. Those are PRODUCT English,
// composed at a known site, and they rendered raw in all eight locales.
//
// ⛔ THE DISCRIMINATOR IS THE PRESENCE OF `ev.rule`, NOT `ev.kind`. `flow-executor.ts:115` makes
// `block_throw` the DEFAULT for any error carrying no kind, so `kind` means "unclassified", not
// "authored by the block". `rule` is attached ONLY at product throw sites, by a class the block's
// module scope cannot reach — so "rule absent ⇒ render raw" localizes author text NEVER, by
// construction rather than by heuristic. The last test in this file is that property.
//
// Messages are mocked from the base catalog with each key returning ITS OWN NAME, so the assertions
// state WHICH message resolved without pinning copy — the same technique as the sibling file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { TraceEvent } from '$lib/types/trace';

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

import RunConsole from './RunConsole.svelte';

const RUN = 'run-1';

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

/** One node_error line, rendered. `error` is always the backend's English, byte for byte. */
function errorLine(ev: Partial<Extract<TraceEvent, { type: 'node_error' }>>): string {
	app = mount(RunConsole, {
		target: host,
		props: {
			events: [
				{
					type: 'node_error',
					runId: RUN,
					ts: 1,
					nodeId: 'n1',
					slug: 'fetch-claims',
					durationMs: 90,
					kind: 'block_throw',
					error: 'SOME ENGLISH',
					...ev
				} as TraceEvent
			],
			status: 'idle' as const,
			nodeCount: 1
		}
	});
	flushSync();
	const lines = [...host.querySelectorAll('.line')].map((n) => n.textContent ?? '');
	// ⛔ NON-VACUITY: one event in, one line out, before anything is asserted about its contents.
	expect(lines, 'the console rendered no lines at all').toHaveLength(1);
	return lines[0]!;
}

describe('the run console localizes the product half of a node_error message', () => {
	it('⛔ a capability refusal reads from the catalog, not the backend English', () => {
		// REVERT THAT TURNS THIS RED: put `${ev.error}` back in place of `blockTestErrorLabel(…)`.
		const line = errorLine({
			kind: 'block_throw',
			error: "block 'fetch-claims' lacks the llm capability",
			rule: 'capability_missing_llm',
			detail: { slug: 'fetch-claims' }
		});
		expect(line).toContain('blockerr_capability_missing_llm:');
		expect(line, 'the backend English is still on screen').not.toContain('lacks the llm capability');
		// The KIND half stays on the shared `errorKindLabel` — one enum, one mechanism.
		expect(line).toContain('console_error_kind_block_throw');
	});

	it('a foreach-shape refusal names the PORT as a machine token, not as prose', () => {
		const line = errorLine({
			kind: 'validation',
			error: "foreach input 'rows' must be an array",
			rule: 'foreach_input_not_array',
			detail: { port: 'rows' }
		});
		// The port survives verbatim — it is an identifier — but the sentence around it is a key.
		expect(line).toContain('blockerr_foreach_input_not_array:');
		expect(line).toContain('rows');
		expect(line).not.toContain('must be an array');
	});

	it('⛔ THE ARCHIVE-REPLAY CASE: a rule with an INCOMPLETE detail bag keeps the English', () => {
		// `flow_runs.trace` is a jsonb ARCHIVE. A run recorded before `detail` grew a field replays
		// through here with the rule and half the bag; interpolating anyway renders
		// "block “undefined” lacks…", a localized sentence that says strictly LESS than the English.
		const line = errorLine({
			error: "block 'fetch-claims' lacks the llm capability",
			rule: 'capability_missing_llm',
			detail: {}
		});
		expect(line).toContain("block 'fetch-claims' lacks the llm capability");
		expect(line).not.toContain('blockerr_capability_missing_llm');
		expect(line).not.toContain('undefined');
	});

	it('a rule this build does not recognise falls back to the English, never to a bare token', () => {
		const line = errorLine({
			error: 'the runner refused for a reason this bundle predates',
			rule: 'some_rule_shipped_backend_first',
			detail: { field: 'x' }
		});
		expect(line).toContain('the runner refused for a reason this bundle predates');
		expect(line).not.toContain('some_rule_shipped_backend_first');
	});

	it('⛔⛔ THE CRUX: a block author’s OWN throw is rendered RAW and is never localized', () => {
		// The author wrote this sentence, in their own language, inside their own block. There is no
		// code behind it and no catalog entry for it. `rule` is ABSENT — which is simultaneously the
		// author-text signal AND the correct backend-first fallback, so author text can never be
		// localized by accident.
		const line = errorLine({ kind: 'block_throw', error: 'mijn eigen fout', rule: undefined });
		expect(line).toBe('  ✗ fetch-claims · console_error_kind_block_throw: mijn eigen fout');
		expect(line).not.toContain('blockerr_');
	});

	it('…and an archived trace with no `rule` at all still renders its message', () => {
		// Every `node_error` written before this change carries `error` and nothing else. That is not
		// a rolling-deploy window; it lasts as long as the retained run history does.
		const line = errorLine({ error: 'Cannot read property ‘id’ of undefined' });
		expect(line).toContain('Cannot read property ‘id’ of undefined');
		expect(line).not.toContain('undefined:');
	});
});
