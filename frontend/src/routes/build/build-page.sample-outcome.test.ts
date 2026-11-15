// src/routes/build/build-page.sample-outcome.test.ts — /build hands the sample test's RUN to the
// data panel, so its verdict comes from the run's outcome.
//
// ⛔ THE DEFECT (browser walk, 2026-10-15). "The sample data matches what each step expects" rendered
// as soon as `POST /api/runs` answered with no data-contract findings — before the run executed —
// directly above "Claim data · Failed: 'amount' must be a number". The panel now reads the verdict
// from `sampleRunOutcome` (render-tested in challenge-data.sample-test.render.test.ts); that is only
// worth anything if this page passes it the run it started and the live trace. jsdom cannot mount
// /build cheaply, so this pins the two wiring lines.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const page = readFileSync(resolve(process.cwd(), 'src/routes/build/+page.svelte'), 'utf8');

describe('/build wires the sample test to its run', () => {
	it('the page source is readable (a grep over nothing passes everything)', () => {
		expect(page.length).toBeGreaterThan(10_000);
	});

	it('the "done" view records the run it started', () => {
		const start = page.indexOf('async function testRun(');
		expect(start).toBeGreaterThan(0);
		const body = page.slice(start, page.indexOf('\n\t}\n', start));
		expect(body).toMatch(/sampleTest = \{\s*state: 'done',[^}]*runId: res\.runId\s*\}/);
	});

	it('the panel receives the live trace of that run — not just the start response', () => {
		const tag = page.slice(page.indexOf('<ChallengeDataPanel'), page.indexOf('/>', page.indexOf('<ChallengeDataPanel')));
		expect(tag).toContain('sample={sampleTest}');
		expect(tag).toMatch(/sampleRun=\{\{\s*runId: runTrace\.runId,\s*events: runTrace\.events,\s*active: running\s*\}\}/);
	});
});
