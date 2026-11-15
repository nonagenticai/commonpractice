// src/lib/i18n/block-cost-label.test.ts — a block's cost class resolves to catalog copy, and a
// value the ladder does not know degrades to itself rather than to nothing.
//
// ⛔ WHAT THE `default:` ARM IS FOR, AND WHY IT IS TESTED HARDER THAN THE THREE MAPPED VALUES.
// `blocks.cost_class` is a nullable bare `text` column with no pg enum and no zod union behind it
// (`backend/src/db/schema.ts:369`, `backend/src/routes/blocks.ts:88` → `z.string().optional()`), so
// unlike `dataset-label.ts` there is no contract file to pin the list against and the open arm is a
// LIVE path, not a deploy-skew net. The failure it prevents is specific: the caller renders this
// into a `<dd>` whose `<dt>` says "Kostenklasse", and an empty `<dd>` under a populated `<dt>`
// states that the block has no cost class — a different, and false, thing to say about the block.
//
// ⚠️ THE CATALOG IS MOCKED TO KEY NAMES ON PURPOSE. This file's subject is WHICH key each class
// reaches, never the wording; the Dutch words a reader actually gets are driven end to end against
// the real compiled messages in `routes/block-edit/block-edit.cost-class.render.test.ts`. Both are
// needed — a key can exist in all eight catalogs, pass key-parity, and never reach a screen.
import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', async () => {
	const { readFileSync } = await import('node:fs');
	const { resolve } = await import('node:path');
	const catalog = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	) as Record<string, unknown>;
	const mod: Record<string, unknown> = {};
	for (const key of Object.keys(catalog)) {
		if (key === '$schema') continue;
		mod[key] = () => key;
	}
	return mod;
});

import { costClassLabel } from './block-cost-label';

/** The two the live database holds (`low` 18, `medium` 6, measured), plus the rung that closes the
 *  ladder — the authoring route already accepts it as a string. */
const CLASSES = ['low', 'medium', 'high'];

describe('costClassLabel', () => {
	it.each(CLASSES)('`%s` resolves to its own catalog key', (c) => {
		expect(costClassLabel(c)).toBe(`blocks_cost_${c}`);
	});

	it('covers the whole ladder — three rungs, three distinct keys', () => {
		// ⛔ A count and a set size, not a spot check: `it.each` over a list written by hand is
		// satisfied by a list that is missing a member, and two rungs sharing one key would satisfy
		// every assertion above while printing the same word for a cheap block and an expensive one.
		expect(CLASSES).toHaveLength(3);
		expect(new Set(CLASSES.map(costClassLabel)).size).toBe(3);
	});

	it('⛔ AN UNKNOWN CLASS DEGRADES TO ITSELF — never to empty', () => {
		expect(costClassLabel('gpu_heavy')).toBe('gpu_heavy');
		// The empty string is the failure this arm prevents, stated as its own assertion: it is what
		// would leave a blank `<dd>` under the "Kostenklasse" term.
		expect(costClassLabel('gpu_heavy')).not.toBe('');
	});

	it('…and it is not silently prefixing an absent key', () => {
		// A `default:` that returned `blocks_cost_${c}` would look identical under the mock above for
		// the three mapped values and produce a DANGLING key name for an unmapped one — which
		// paraglide resolves to `undefined`, i.e. the blank the arm above exists to prevent.
		expect(costClassLabel('gpu_heavy')).not.toContain('blocks_cost_');
	});

	it('the empty string is returned as-is — NULL is the caller’s decision, not this module’s', () => {
		// `/block-edit`'s Details list renders `?? '—'` for `license`, `region` and `cost_class`
		// alike. Swallowing absence in here would put one of those three em dashes in a different
		// place from the other two, and would hide a blank column behind a mapped-looking value.
		expect(costClassLabel('')).toBe('');
	});
});
