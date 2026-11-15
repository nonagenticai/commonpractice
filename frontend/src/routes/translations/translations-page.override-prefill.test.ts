// src/routes/translations/translations-page.override-prefill.test.ts — a TEXT guard that the
// /translations override editor opens on the EXISTING translation and shows it.
//
// THE DEFECT THIS PINS. `startEdit` used to be `draft = ''`, unconditionally. A job row carries
// `source_text` (the ENGLISH source) and nothing else — the translated value lives in the separate
// `content_translations` table — so the editor showed English beside an empty box on cells that
// were already translated (in prod: 728 jobs `done`, 0 pending, `nl` the primary demo locale).
// Saving then replaced a good translation with whatever was typed, and the operator was never
// shown what they destroyed. The fix is two halves and BOTH are pinned here, because either half
// alone reinstates the trap: the jobs route LEFT JOINs the current value (`current_value`), and
// this page seeds `draft` from it while keeping the old value visible next to the draft.
//
// ⚠️ BE HONEST ABOUT WHAT THIS TEST IS. It is a GREP over the component source, like its
// neighbour `translations-page.enum-labels.test.ts` (which documents why that pattern is used
// here). It cannot prove the box renders filled; it stops the specific regression from returning.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PAGE = fileURLToPath(new URL('./+page.svelte', import.meta.url));

/** The page source with comments stripped — a guard a comment can trip is a guard nobody keeps. */
function code(): string {
	return readFileSync(PAGE, 'utf-8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^[ \t]*\/\/.*$/gm, '')
		.replace(/<!--[\s\S]*?-->/g, '');
}

describe('the /translations override editor opens on the existing translation', () => {
	it('is the file we think it is (or every assertion below passes vacuously)', () => {
		const src = code();
		expect(src).toContain('function startEdit');
		expect(src).toContain('saveOverride');
	});

	it('seeds the draft from current_value, never from a bare empty string', () => {
		const src = code();
		expect(
			src,
			'`draft = j.current_value ?? \'\'` is gone from startEdit. An empty draft on a `done` job ' +
				'is a data-loss affordance: the operator sees English source beside an empty box and ' +
				'saves over a translation they were never shown.'
		).toMatch(/draft\s*=\s*j\.current_value\s*\?\?\s*''/);
		expect(src).not.toMatch(/function startEdit[\s\S]{0,200}?draft\s*=\s*''/);
	});

	it('renders the current value AND a distinct empty-state, so the two never look alike', () => {
		const src = code();
		// The value the save will overwrite stays on screen while the draft is edited.
		expect(src).toMatch(/\{current\}/);
		// …and "nothing stored yet" is its own branch with its own wording, not an empty div.
		expect(
			src,
			'the null branch is gone — "no translation yet" and "the translation is now blank" are ' +
				'back to looking identical, which is what made the empty box unreadable in the first place.'
		).toContain('m.tr_editor_none()');
		expect(src).toMatch(/\{#if current === null\}/);
	});

	it('uses a textarea, not an <input>, for the draft', () => {
		const src = code();
		// `docs_md` translations are multi-line and <input type=text> DROPS newlines from the value
		// it is assigned — with the draft prefilled, an <input> would flatten a whole document on save.
		expect(src).toMatch(/<textarea bind:value=\{draft\}/);
		expect(src).not.toMatch(/<input bind:value=\{draft\}/);
	});

	it('states how much of the job list is actually on screen', () => {
		const src = code();
		// The list is truncated server-side at jobsLimit while the coverage matrix above it counts
		// every job. Two numbers that disagree, with the truncation unstated, is the second defect.
		expect(src).toContain('m.tr_jobs_truncated(');
		expect(src).toMatch(/data\.jobsTotal > data\.jobs\.length/);
	});
});
