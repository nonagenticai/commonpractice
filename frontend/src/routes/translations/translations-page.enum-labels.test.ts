// src/routes/translations/translations-page.enum-labels.test.ts — a TEXT guard that the
// /translations job table renders LABELS and keeps RAW values where raw values are load-bearing.
//
// ⚠️ BE HONEST ABOUT WHAT THIS TEST IS. It is a GREP, not a behavioural assertion. It cannot prove
// the screen reads "Uitdaging"; it only stops the two specific regressions that matter here. The
// behavioural half is next door in `labels.test.ts`, which drives the mappers directly.
//
// Reading source text from disk in a vitest test is an established pattern in this repo — see
// `src/routes/build/build-page.submit.test.ts` and
// `src/lib/api/error-message.backend-contract.test.ts`, which document why.
//
// TWO regressions, pulling in opposite directions, which is exactly why both are pinned:
//   1. rendering the RAW value as the visible text  → an untranslated screen (the original defect);
//   2. localizing the CSS HOOK `class="status {j.status}"` → `.status.pending/.done/.failed/
//      .skipped` stop matching and every pill goes colourless, in whichever locale the reader
//      happens to use. "Fixing" #1 carelessly causes #2.
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

describe('the /translations job table shows labels, not raw enums', () => {
	it('is the file we think it is (or every assertion below passes vacuously)', () => {
		const src = code();
		expect(src).toContain('sortedJobs');
		expect(src).toContain("from './labels'");
	});

	it('renders the status pill through statusLabel, never the raw value', () => {
		const src = code();
		expect(
			src,
			'the status pill is back to `{j.status}` — a Dutch operator reads "pending" and "failed" ' +
				'on a screen whose own filter chips, seventeen lines above, say "In behandeling" and ' +
				'"Mislukt".'
		).toContain('>{statusLabel(j.status)}<');
		expect(src).not.toMatch(/>\{j\.status\}</);
	});

	it('renders the entity kind through entityLabel, never the raw value', () => {
		const src = code();
		expect(src).toContain('{entityLabel(j.entity_type)}');
		expect(src).not.toMatch(/>\{j\.entity_type\}/);
	});

	it('KEEPS the raw status in the CSS hook — that is what colours the pill', () => {
		expect(
			code(),
			'`class="status {j.status}"` is gone. `.status.pending/.done/.failed/.skipped` are the ' +
				'colour hooks, so localizing the class name makes every pill grey — and only for ' +
				'readers who are not in English, which is nobody who tests it.'
		).toContain('class="status {j.status}"');
	});

	it('adds no `skipped` FILTER chip', () => {
		// Nothing writes `skipped` today. A filter for an unreachable state is a new dead control —
		// the precise defect class this change exists to remove. The pill and its colour hook stay,
		// because a value that DOES appear must be readable; the chip does not.
		expect(
			code(),
			'a `skipped` filter chip was added. Nothing in the backend writes that status, so the ' +
				'chip can only ever return an empty table.'
		).not.toContain("setFilter('skipped')");
	});
});
