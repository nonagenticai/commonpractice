// src/lib/types/block-status-label.test.ts — a block's lifecycle status resolves from the ENUM,
// for all four values, never from the raw database string.
//
// THE DEFECT this pins: the /blocks card grid rendered `{b.status ?? m.blocks_status_draft()}`, so
// the NULL case went through the catalog and the three real `block_status` values did not — a
// Dutch library read "v3 · stable" beside "v1 · concept".
//
// The messages module is mocked so each key returns its own name: the assertions are about WHICH
// MESSAGE is selected, not about English copy a translator may legitimately reword. Same technique
// as i18n/stage-label.test.ts.
import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', () => ({
	blocks_status_draft: () => 'M_DRAFT',
	blocks_status_beta: () => 'M_BETA',
	blocks_status_stable: () => 'M_STABLE',
	blocks_status_deprecated: () => 'M_DEPRECATED',
	// categoryLabel lives in the same module and is imported alongside; unrelated to this suite.
	category_data: () => 'M_CAT_DATA',
	category_ai: () => 'M_CAT_AI',
	category_logic: () => 'M_CAT_LOGIC',
	category_output: () => 'M_CAT_OUTPUT',
	category_ui: () => 'M_CAT_UI'
}));

const { blockStatusLabel } = await import('./blocks');

describe('blockStatusLabel', () => {
	it('resolves every value of the block_status pg enum', () => {
		// backend/src/db/schema.ts `blockStatusEnum` — all four, not just the one the old
		// `?? m.blocks_status_draft()` happened to cover.
		expect(blockStatusLabel('draft')).toBe('M_DRAFT');
		expect(blockStatusLabel('beta')).toBe('M_BETA');
		expect(blockStatusLabel('stable')).toBe('M_STABLE');
		expect(blockStatusLabel('deprecated')).toBe('M_DEPRECATED');
	});

	it('maps no two statuses onto the same message', () => {
		const labels = ['draft', 'beta', 'stable', 'deprecated'].map(blockStatusLabel);
		expect(new Set(labels).size).toBe(4);
	});

	it('treats a missing status as a draft — the established meaning of null on the wire', () => {
		// `BlockListItem.status` is nullable: a block with no published version. The old code said
		// "concept" for exactly this case and that behaviour is preserved on purpose.
		expect(blockStatusLabel(null)).toBe('M_DRAFT');
		expect(blockStatusLabel(undefined)).toBe('M_DRAFT');
	});

	it('returns the RAW value for an unknown status — never an English sentence', () => {
		// The default branch exists so a status added server-side ships an ugly word rather than a
		// blank cell. What it must never do is silently pick one of the four known labels.
		expect(blockStatusLabel('quarantined')).toBe('quarantined');
		expect(blockStatusLabel('')).toBe('');
	});
});
