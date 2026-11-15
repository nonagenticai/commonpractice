// src/lib/i18n/agent-edit-label.test.ts — the chat activity feed's vocabulary, in Dutch.
//
// ⛔ THE DEFECT. `driver.ts:describeEdit` composed the feed line in ENGLISH — `add ${slug}`,
// `insert ${slug}`, `remove a node`, `connect ${sourceHandle} → ${targetHandle}`, `disconnect an
// edge`, `set ${key}`, `move a node`, and a bare tool name as the default. `agent-chat.svelte.ts`
// pushes that string into the feed and `ChatPanel.svelte` renders it verbatim inside fully-Dutch
// chrome. `/build` IS UNGATED: a Dutch demo meets this on the first copilot prompt, which made it
// the most-seen English text in the product. `block-author-driver.ts` ('draft a block') and
// `block-fix-driver.ts` ('propose a fix') were the same defect on the block surfaces.
//
// ⚠️ THE THREE DRIVERS ARE ASSERTED TO DELEGATE, not merely to be localizable. Each used to own
// its own English fragment; a fix that localized `agentEditLine` and left `describeBlockFix`
// returning `'propose a fix'` would satisfy every assertion about this module alone.
//
// ⛔ IDENTIFIERS ARE ASSERTED TO SURVIVE VERBATIM. `slug`, `key`, `sourceHandle` and
// `targetHandle` name real things in `flows.graph` and on the canvas. A "translation" that touched
// them would print a node the reader cannot find, which is worse than English.
import { describe, it, expect, vi } from 'vitest';

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

import { agentEditLine } from './agent-edit-label';
import { describeEdit } from '$lib/agent/driver';
import { describeBlockEdit } from '$lib/agent/block-author-driver';
import { describeBlockFix } from '$lib/agent/block-fix-driver';

/** Every fragment `describeEdit` used to emit. None may survive anywhere in a localized line. */
const ENGLISH_FRAGMENTS = [
	'add ',
	'insert ',
	'remove a node',
	'connect ',
	'disconnect an edge',
	'set ',
	'move a node',
	'draft a block',
	'propose a fix'
];

/** name → an input the real tool would carry. */
const CALLS: [string, unknown][] = [
	['add_node', { slug: 'btw-berekenen' }],
	['insert_node', { slug: 'btw-berekenen' }],
	['remove_node', { nodeId: 'n1' }],
	['connect_nodes', { source: 'n1', sourceHandle: 'rijen', target: 'n2', targetHandle: 'invoer' }],
	['disconnect_nodes', { edgeId: 'e1' }],
	['configure_node', { nodeId: 'n1', key: 'drempel', value: 12 }],
	['move_node', { nodeId: 'n1', position: { x: 1, y: 2 } }],
	['propose_block_draft', null],
	['propose_block_patch', null]
];

describe('agentEditLine — the activity feed speaks the reader’s language', () => {
	for (const [name, input] of CALLS) {
		it(`⛔ ${name} renders Dutch, with no English fragment left`, () => {
			const line = agentEditLine(name, input);
			expect(line, `${name} produced nothing`).toBeTruthy();
			// REVERT THAT TURNS THIS RED: put the English switch back in `describeEdit` and delete
			// this module's arm — the line becomes `add btw-berekenen` and the fragment scan catches it.
			for (const frag of ENGLISH_FRAGMENTS) {
				expect(line.toLowerCase(), `${name} still emits the English fragment "${frag}"`).not.toContain(
					frag
				);
			}
			// …and it is not the raw tool name either, which is what the old default arm produced.
			expect(line, `${name} degraded to its own wire token`).not.toBe(name);
		});
	}

	it('⛔ interpolates the block slug VERBATIM — it is an identifier, not a word', () => {
		expect(agentEditLine('add_node', { slug: 'btw-berekenen' })).toContain('btw-berekenen');
		expect(agentEditLine('insert_node', { slug: 'btw-berekenen' })).toContain('btw-berekenen');
	});

	it('⛔ interpolates the config key and both port handles VERBATIM', () => {
		expect(agentEditLine('configure_node', { key: 'drempel' })).toContain('drempel');
		const line = agentEditLine('connect_nodes', { sourceHandle: 'rijen', targetHandle: 'invoer' });
		expect(line).toContain('rijen');
		expect(line).toContain('invoer');
		// The direction is part of the fact: source first, then target.
		expect(line.indexOf('rijen')).toBeLessThan(line.indexOf('invoer'));
	});

	it('a connect call with no handles names the NODES rather than printing "undefined"', () => {
		// The old English version interpolated `undefined` straight into the feed.
		const line = agentEditLine('connect_nodes', { source: 'n1', target: 'n2' });
		expect(line).not.toContain('undefined');
		expect(line).toContain('n1');
		expect(line).toContain('n2');
	});

	it('⛔ an UNKNOWN tool degrades to prose that names it, not to a bare wire token', () => {
		// A tool added backend-first reaches this before the catalog knows its name. The old code
		// returned the token itself, which is unreadable; the fallback must still be a sentence.
		const line = agentEditLine('summon_a_dragon', {});
		expect(line).toContain('summon_a_dragon');
		expect(line, 'the fallback is still the raw token').not.toBe('summon_a_dragon');
	});

	it('⛔ all THREE drivers delegate here — none keeps its own English fragment', () => {
		// REVERT THAT TURNS THIS RED: restore `return name === 'propose_block_patch' ? 'propose a
		// fix' : name;` in block-fix-driver.ts (or the English switch in driver.ts).
		expect(describeEdit('add_node', { slug: 'btw-berekenen' })).toBe(
			agentEditLine('add_node', { slug: 'btw-berekenen' })
		);
		expect(describeBlockEdit('propose_block_draft')).toBe(agentEditLine('propose_block_draft', null));
		expect(describeBlockFix('propose_block_patch')).toBe(agentEditLine('propose_block_patch', null));
		for (const s of [
			describeBlockEdit('propose_block_draft'),
			describeBlockFix('propose_block_patch')
		]) {
			expect(s.toLowerCase()).not.toContain('draft a block');
			expect(s.toLowerCase()).not.toContain('propose a fix');
		}
	});
});
