// @vitest-environment jsdom
//
// src/lib/components/build/block-node.run-status.i18n.render.test.ts — the /build canvas node's
// status dot, in DUTCH, while a flow runs.
//
// ⛔ THE DEFECT. `BlockNode.svelte` rendered
//
//     <span class="cp-node-status {data.runtimeStatus}" title={data.runtimeStatus}></span>
//
// so hovering the dot on a node mid-run produced `running` / `ok` / `error` / `skipped` — on the
// product's PRIMARY authoring surface, on a node whose port badges two lines below already go
// through `fieldTypeLabel` and whose header already goes through `nodeDisplayName`. The dot has NO
// TEXT OF ITS OWN, so that tooltip is the only thing on screen saying what the colour means.
//
// ⛔ AND `runStatusLabel` IS THE WRONG LABELLER, WHICH IS WHY THIS FIX ADDS ONE. The two enums are
//
//     flow_run_status    running | ok | partial | failed   ← run-status-label.ts
//     NodeRuntimeStatus  running | ok | error   | skipped  ← builder-graph.ts:93
//
// Routing the dot through `runStatusLabel` returns the RAW ENUM for `error` and `skipped` (its
// `default:` arm) — the exact defect, for half the value set — and adding two arms to it would put
// members into a labeller for a vocabulary that has neither, the coercion its own header rejects in
// writing. The `error`/`skipped` cases below are what make that concrete.
//
// ⚠️ ASSERTS DUTCH WORDS, NOT KEY NAMES — same choice, same reason, as `block-node.port-types` next
// door: the reader-visible failure IS an English token, and a key-name stub cannot tell "the
// tooltip is Dutch" from "the tooltip is a key that contains the word running".
//
// ⚠️ `@xyflow/svelte` is stubbed for the reason that file records: `Handle` needs the SvelteFlow
// store context a bare `mount` cannot provide, and the handles carry no text.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockNodeData } from '$lib/stores/builder.svelte';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/nl.json'), 'utf8')
	) as Record<string, string>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = () => catalog[key];
	}
	return mod;
});
vi.mock('@xyflow/svelte', () => ({
	Handle: () => ({}),
	Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' }
}));

import BlockNode from './BlockNode.svelte';

/** The whole closed vocabulary — `NodeRuntimeStatus`, `$lib/stores/builder-graph.ts`. */
const STATUSES = ['running', 'ok', 'error', 'skipped'] as const;

/** What a Dutch builder must read on the dot. The values live in `messages/nl.json`. */
const DUTCH: Record<string, string> = {
	running: 'Bezig',
	ok: 'Gelukt',
	error: 'Mislukt',
	skipped: 'Overgeslagen'
};

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

function render(runtimeStatus?: string) {
	const data = {
		blockId: 'b1',
		blockVersionId: 'v1',
		slug: 'triage-claims',
		label: 'Triage claims',
		category: 'data',
		descriptor: { inputs: {}, outputs: {}, capabilities: {} },
		config: {},
		...(runtimeStatus === undefined ? {} : { runtimeStatus })
	} as unknown as BlockNodeData;
	app = mount(BlockNode, { target: host, props: { data, selected: false } as never });
	flushSync();
}

/**
 * ⛔ THE ANTI-VACUITY GATE. Every "no English token" assertion is about ONE `<span>`; on a node that
 * rendered no dot at all they all pass for free.
 */
function dot(): HTMLElement {
	const el = host.querySelector('.cp-node-status');
	expect(el, 'the status dot never rendered — this case tests nothing').not.toBeNull();
	return el as HTMLElement;
}

describe('the /build node status dot says its status in the reader’s language', () => {
	for (const status of STATUSES) {
		it(`⛔ "${status}" reads "${DUTCH[status]}"`, () => {
			// REVERT THAT TURNS THIS RED: `title={data.runtimeStatus}`.
			render(status);
			expect(dot().getAttribute('title')).toBe(DUTCH[status]);
			expect(
				dot().getAttribute('title'),
				'the wire token is still the only explanation the dot has'
			).not.toBe(status);
		});
	}

	it('⛔ THE FOUR WORDS ARE FOUR DIFFERENT WORDS', () => {
		// A labeller wired to one key for every arm — or two catalog entries pasted alike — reads as
		// "every node is Bezig" and would pass all four cases above.
		const titles = STATUSES.map((s) => {
			render(s);
			const t = dot().getAttribute('title');
			unmount(app!);
			app = undefined;
			host.innerHTML = '';
			return t;
		});
		expect(new Set(titles).size).toBe(4);
	});

	it('⚠️ THE CLASS STAYS THE ENUM — it is a CSS hook, not copy', () => {
		// The over-correction guard: localizing the class would silently drop every `.cp-node-status.ok`
		// style rule and take the colour off the dot this tooltip exists to explain.
		render('error');
		expect(dot().classList.contains('error')).toBe(true);
		expect(dot().classList.contains('Mislukt')).toBe(false);
	});

	it('⛔ AN UNKNOWN STATUS DEGRADES TO ITSELF — never to an empty tooltip', () => {
		// `runtimeStatus` is written from a trace stream the browser does not own, so a fifth status
		// deployed one roll ahead is real. An EMPTY title on a bare dot is worse than an ugly one: it
		// removes the only explanation the dot has.
		render('cancelled');
		expect(dot().getAttribute('title')).toBe('cancelled');
	});

	it('no status, no dot — the tooltip is not rendered onto nothing', () => {
		// The `{#if data.runtimeStatus}` guard, pinned: a node that is not in a run has no dot, and a
		// fix that rendered one with an empty or defaulted title would put a permanent grey mark on
		// every node on the canvas.
		render(undefined);
		expect(host.querySelector('.cp-node-status')).toBeNull();
	});
});
