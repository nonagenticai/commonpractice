// src/lib/i18n/ontology-action-label.test.ts — /ontology's "Recent changes" panel resolves its
// vocabulary from the audit ENUM, and refuses to print a uuid where a name belongs.
//
// The messages module is mocked so each key returns its own name: the assertions are about WHICH
// MESSAGE is selected, not about copy a translator may reword. (Same technique as
// stage-label.test.ts and work-area-label.test.ts.)
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ACTIONS = [
	'entity_create',
	'entity_update',
	'entity_delete',
	'entity_hide',
	'entity_unhide',
	'entity_translate',
	'sample_bind',
	'sample_unbind',
	'derive_block',
	'relation_create',
	'relation_delete'
] as const;

vi.mock('$lib/paraglide/messages', () => {
	const mod: Record<string, () => string> = {};
	for (const a of [
		'entity_create',
		'entity_update',
		'entity_delete',
		'entity_hide',
		'entity_unhide',
		'entity_translate',
		'sample_bind',
		'sample_unbind',
		'derive_block',
		'relation_create',
		'relation_delete'
	]) {
		mod[`ontology_action_${a}`] = () => `M_${a.toUpperCase()}`;
	}
	return mod;
});

const { ontologyActionLabel, ontologyTargetLabel } = await import('./ontology-action-label');

const BACKEND = resolve(process.cwd(), '../backend/src/routes/ontology.ts');

describe('ontologyActionLabel', () => {
	it('resolves every action to its own message', () => {
		for (const a of ACTIONS) {
			expect(ontologyActionLabel(`ontology.${a}`)).toBe(`M_${a.toUpperCase()}`);
		}
	});

	it('covers exactly the actions the backend records — scraped, not hand-listed', () => {
		// ⛔ THE NON-VACUITY POINT. The switch is a copy of a list that lives in another package and
		// grows whenever someone adds a mutation route. Scraping it means a twelfth `recordAudit`
		// call in ontology.ts reddens here instead of quietly shipping `ontology.entity_merge` into
		// the panel as raw text.
		const src = readFileSync(BACKEND, 'utf8');
		const found = [...src.matchAll(/action: '(ontology\.[a-z_]+)'/g)].map((mm) => mm[1]!);
		expect(found.length, 'no `action: \'ontology.*\'` literals found — did the file move?').toBeGreaterThan(0);

		const unique = [...new Set(found)].sort();
		expect(unique).toEqual(ACTIONS.map((a) => `ontology.${a}`).sort());

		// …and every one of them resolves, i.e. none falls through to the raw-id default.
		const labels = unique.map(ontologyActionLabel);
		for (const [i, label] of labels.entries()) {
			expect(label, `${unique[i]} has no catalog key`).toMatch(/^M_/);
		}
		// No two actions collapse onto one message: "added" and "deleted" must stay distinguishable.
		expect(new Set(labels).size).toBe(unique.length);
	});

	it('every key it reaches exists in all eight catalogs', () => {
		const LOCALES = ['en', 'nl', 'pl', 'fr', 'es', 'de', 'ar', 'he'];
		for (const locale of LOCALES) {
			const catalog = JSON.parse(
				readFileSync(resolve(process.cwd(), `messages/${locale}.json`), 'utf8')
			) as Record<string, unknown>;
			for (const a of ACTIONS) {
				const key = `ontology_action_${a}`;
				expect(typeof catalog[key], `${key} is missing from ${locale}.json`).toBe('string');
			}
		}
	});

	it('returns the RAW ACTION ID for anything it does not know — never English prose', () => {
		// The feed's `q=ontology` also matches `target_id` and the actor's NAME (audit.ts:72-74), so
		// a non-ontology row can legitimately reach this panel. It must read as an id, not as a
		// label — the old `.replace()` pair made every unknown enum look like translated copy.
		expect(ontologyActionLabel('ontology.entity_merge')).toBe('ontology.entity_merge');
		expect(ontologyActionLabel('block.publish')).toBe('block.publish');
		expect(ontologyActionLabel('')).toBe('');
		// ⛔ Specifically NOT the old cosmetic transform, which is what made "entity create" pass for
		// a Dutch label. Nothing may strip the prefix or swap the underscores any more.
		expect(ontologyActionLabel('ontology.entity_merge')).not.toBe('entity merge');
	});
});

describe('ontologyTargetLabel', () => {
	it('omits a uuid — the shape ten of the eleven actions record', () => {
		// `targetId: row.id` / `targetId: id!` / `targetId: sampleId!` are all `ontology_entity`,
		// `ontology_relation` or `ontology_entity_sample` primary keys.
		expect(ontologyTargetLabel('3f1c8b2e-9d44-4a17-a8b2-6c0f21d5e7aa')).toBeNull();
		expect(ontologyTargetLabel('3F1C8B2E-9D44-4A17-A8B2-6C0F21D5E7AA')).toBeNull(); // case-insensitive
		expect(ontologyTargetLabel(' 3f1c8b2e-9d44-4a17-a8b2-6c0f21d5e7aa ')).toBeNull(); // and padded
	});

	it('keeps a readable target — the one action that records a name', () => {
		// `ontology.derive_block` records `result.block.slug` (ontology.ts:~300). It survives the
		// filter for free, which is why the rule is "is it a uuid" and not an action allowlist.
		expect(ontologyTargetLabel('claims-intake-entity')).toBe('claims-intake-entity');
		expect(ontologyTargetLabel('Policy')).toBe('Policy');
	});

	it('omits an absent or blank target rather than rendering an empty chip', () => {
		expect(ontologyTargetLabel(null)).toBeNull();
		expect(ontologyTargetLabel(undefined)).toBeNull();
		expect(ontologyTargetLabel('')).toBeNull();
		expect(ontologyTargetLabel('   ')).toBeNull();
	});

	it('does not over-reach: an id-ish string that is not a uuid still renders', () => {
		// The rule has to be narrow. A slug with digits, a short code, or a hyphenated name are all
		// things a person reads; widening this to "looks technical" would start hiding real names.
		expect(ontologyTargetLabel('claims-2026')).toBe('claims-2026');
		expect(ontologyTargetLabel('CH-243')).toBe('CH-243');
		expect(ontologyTargetLabel('3f1c8b2e9d444a17a8b26c0f21d5e7aa')).toBe('3f1c8b2e9d444a17a8b26c0f21d5e7aa');
	});
});

describe('the ontology page does not render either raw value any more', () => {
	// ⛔ SOURCE GUARD. The defect was one line of Svelte, not a function — mounting /ontology (matrix
	// fetch, compiled-graph fetch, SvelteFlow, dataset picker, audit feed) to assert one `<span>`
	// would cost far more than it proves. These two patterns are byte-for-byte what was there.
	const route = readFileSync(resolve(process.cwd(), 'src/routes/ontology/+page.svelte'), 'utf8');

	it('the action is not cosmetically de-prefixed in the template', () => {
		expect(route).not.toContain(".replace('ontology.', '')");
	});

	it('the target id is not rendered unconditionally', () => {
		expect(route).not.toMatch(/\{#if c\.targetId\}[\s\S]{0,80}\{c\.targetId\}/);
	});

	it('…and both patterns match the real pre-fix source, so neither is a regex that never fired', () => {
		const PRE_FIX =
			'<span class="ch-action">{c.action.replace(\'ontology.\', \'\').replace(/_/g, \' \')}</span>\n' +
			'{#if c.targetId}<span class="ch-target" dir="ltr">{c.targetId}</span>{/if}';
		expect(PRE_FIX).toContain(".replace('ontology.', '')");
		expect(PRE_FIX).toMatch(/\{#if c\.targetId\}[\s\S]{0,80}\{c\.targetId\}/);
	});
});
