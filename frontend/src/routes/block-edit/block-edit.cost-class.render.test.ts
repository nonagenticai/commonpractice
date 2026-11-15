// @vitest-environment jsdom
//
// src/routes/block-edit/block-edit.cost-class.render.test.ts — the Details card on /block-edit says
// what a block costs in the reader's language.
//
// ⛔ THE DEFECT, MEASURED IN THE LIVE APP. The card is a definition list whose every TERM is
// localized — Beheerder / Aangemaakt / Licentie / Regio / Kostenklasse — and whose cost-class VALUE
// was the raw database column:
//
//     <dt>{m.blockedit_meta_cost_class()}</dt><dd>{detail.cost_class ?? '—'}</dd>
//
// so a Dutch reader got "Kostenklasse  low". Not an edge case: `backend/src/db/seed.ts` writes
// `cost_class` on every one of the twelve seeded blocks (`low` ×6, `medium` ×6), and the live
// database answers `low` 18 / `medium` 6 — every block detail page in the catalogue carried it.
//
// ⚠️ WHY THIS FILE EXISTS WHEN `$lib/i18n/block-cost-label.test.ts` ALREADY PINS THE MAPPING. That
// file mocks the catalog to key NAMES, so it proves `class → which message key` and nothing about
// what a human sees. A key can exist in all eight catalogs, pass `catalogs.test.ts` key-parity,
// pass placeholder-parity, and never reach the screen — because nothing rendered it. That is
// exactly what was true here: the localized `<dt>` beside the raw `<dd>`, half a row.
//
// ⛔ NOTHING ABOUT THE MESSAGE LAYER IS MOCKED. `overwriteGetLocale` is the same lever
// `$lib/stores/locale.svelte.ts` pulls in the running app, so the compiled paraglide functions
// resolve `nl` exactly as they do in a browser — the seam its sibling `block-edit.dutch-findings`
// spec in this directory uses, for the same reason.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { BlockDetail, BlockVersion } from '$lib/types/blocks';

vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/block-edit?slug=claims-triage'), params: {} }
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const { getBlock } = vi.hoisted(() => ({ getBlock: vi.fn() }));
vi.mock('$lib/api/blocks', () => ({
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			public code = 'error',
			message = 'error',
			public findings?: unknown
		) {
			super(message);
		}
	},
	blocksApi: {
		get: getBlock,
		saveVersion: vi.fn(),
		publish: vi.fn(),
		lint: vi.fn(),
		createVersion: vi.fn(),
		create: vi.fn(),
		remove: vi.fn()
	}
}));
vi.mock('$lib/api/templates', () => ({ templatesApi: { create: vi.fn(), list: vi.fn() } }));
vi.mock('$lib/api/ontology', () => ({
	ApiError: class ApiError extends Error {},
	ontologyApi: {
		matrix: vi.fn().mockResolvedValue({ industries: [], departments: [], cells: [] }),
		get: vi.fn()
	}
}));
vi.mock('$lib/stores/auth.svelte', () => ({
	auth: { isDeveloper: true, isSuperAdmin: true, isTenantAdmin: true }
}));

import { overwriteGetLocale } from '$lib/paraglide/runtime';
import * as m from '$lib/paraglide/messages';
import Page from './+page.svelte';

function version(): BlockVersion {
	return {
		id: 'v1',
		block_id: 'b1',
		version: '3',
		status: 'draft',
		language: 'typescript',
		docs_md: '# Claims triage',
		source_ts: 'export default function () {}',
		descriptor: { inputs: {}, outputs: {}, capabilities: { network: false } },
		examples: [],
		changelog: '',
		tests_passing: true,
		usage_count: 0,
		published_by: null,
		published_at: null,
		created_at: '2026-08-01T00:00:00.000Z',
		author: null
	};
}

function detail(cost_class: string | null): BlockDetail {
	return {
		id: 'b1',
		slug: 'claims-triage',
		name: 'Claims triage',
		description: 'Triage a claim',
		category: 'logic',
		current_version_id: null,
		maintainer_id: null,
		owner: 'tenant',
		region: 'eu-west-1',
		cost_class,
		license: 'MIT',
		archived: false,
		created_at: '2026-08-01T00:00:00.000Z',
		updated_at: '2026-08-01T00:00:00.000Z',
		maintainer: null,
		versions: [version()]
	} as BlockDetail;
}

let target: HTMLElement;
let component: Record<string, unknown> | null = null;

async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

/** The `<dd>` under the "Kostenklasse" `<dt>`, found by its TERM rather than by position — an
 *  extra meta row added above it must not silently move this assertion onto another value. */
async function costValue(cost_class: string | null): Promise<string> {
	getBlock.mockResolvedValue(detail(cost_class));
	component = mount(Page, { target }) as Record<string, unknown>;
	await settle();

	const terms = [...target.querySelectorAll('dl.meta dt')];
	// ⛔ THE POSITIVE ANCHOR. /block-edit mounts a dozen components; one that throws and the page
	// renders nothing, `querySelectorAll` returns [] and every "the English token is gone"
	// assertion below passes against an empty DOM.
	expect(terms.length, 'the Details card never rendered').toBeGreaterThan(0);
	const dt = terms.find((t) => t.textContent === m.blockedit_meta_cost_class());
	expect(dt, 'no "Kostenklasse" term on the Details card').toBeDefined();
	return (dt!.nextElementSibling as HTMLElement).textContent ?? '';
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	overwriteGetLocale(() => 'nl');
});
afterEach(() => {
	if (component) unmount(component);
	component = null;
	target.remove();
	overwriteGetLocale(() => 'en');
	getBlock.mockReset();
});

describe('a Dutch reader learns what a block costs, in Dutch', () => {
	it('the fixture really is Dutch, and really differs from English', () => {
		// ⛔ NON-VACUITY, AND NOT A FORMALITY. Every assertion below is "the `<dd>` holds the nl
		// string". If `overwriteGetLocale` stopped working the catalog would answer English, the
		// `<dd>` would hold "Low", and a test written as `not.toContain('low')` would still pass
		// while proving the opposite. So the two catalogs are compared here, once.
		overwriteGetLocale(() => 'nl');
		const nl = [m.blocks_cost_low(), m.blocks_cost_medium(), m.blocks_cost_high()];
		overwriteGetLocale(() => 'en');
		const en = [m.blocks_cost_low(), m.blocks_cost_medium(), m.blocks_cost_high()];
		expect(nl).not.toEqual(en);
		expect(nl).toEqual(['Laag', 'Middel', 'Hoog']);
		// ⚠️ ONLY THE DUTCH SIDE CAN CARRY THIS CLAIM, and that is worth writing down rather than
		// discovering twice: `en`'s `blocks_cost_low` is the word "Low", which is byte-identical to
		// the enum once case is folded. The base locale is therefore structurally incapable of
		// telling this fix from the defect — an English-only spec here would pass on a full revert.
		expect(nl.map((s) => s.toLowerCase())).not.toContain('low');
		expect(en).toEqual(['Low', 'Medium', 'High']);
	});

	it('⛔ a block seeded `low` reads "Laag" — the raw column is gone from the card', async () => {
		expect(await costValue('low')).toBe('Laag');
		// ⛔ THE ASSERTION THAT INVERTS ON A REVERT TO `{detail.cost_class ?? '—'}`. Scoped to the
		// Details card: `low` is a three-letter substring and the page holds a code editor, so a
		// document-wide grep would be a coin toss rather than a guard.
		const card = target.querySelector('dl.meta')!.textContent ?? '';
		expect(card, 'the raw cost class is back on the card').not.toContain('low');
		// The card's neighbours are IDENTIFIERS and stay verbatim — this fix must not spread.
		expect(card).toContain('MIT');
		expect(card).toContain('eu-west-1');
	});

	it('…and a block seeded `medium` reads "Middel" — both seeded values, not just one', async () => {
		expect(await costValue('medium')).toBe('Middel');
		expect(target.querySelector('dl.meta')!.textContent).not.toContain('medium');
	});

	it('ABSENCE IS STILL ABSENCE — a null column keeps the em dash the row always had', async () => {
		// A "fix" that routed null through the labeller would print the empty string into a `<dd>`
		// whose `<dt>` says "Kostenklasse", which reads as a value the page could not load rather
		// than a column nobody filled in. `license` and `region` beside it use the same em dash.
		expect(await costValue(null)).toBe('—');
	});

	it('AN UNKNOWN CLASS KEEPS ITS OWN NAME — the column has no enum behind it', async () => {
		// `blocks.cost_class` is bare `text` and the authoring route takes `z.string().optional()`,
		// so this is a live path. An ugly token beats a blank row.
		expect(await costValue('gpu_heavy')).toBe('gpu_heavy');
	});
});
