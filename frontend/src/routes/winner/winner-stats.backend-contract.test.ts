// src/routes/winner/winner-stats.backend-contract.test.ts — "The week in numbers" may state only
// what the product can actually compute.
//
// ⛔ THE DEFECT. `/winner` rendered FOUR figures in one list, in one typography: `totalVotesCast`
// and `solutionsSubmitted` — which `periodSolutionStats` measures — beside `firstTimeBuilders` and
// `crossDomain`, which NOTHING in this codebase can produce. There is no first-time flag on a
// solution and no cross-domain relation; migration 0064_reconcile_vote_counts.sql:184-191 states
// exactly that. Their only writer is the two seeders' `fabricate` branch, and
// `config.seedFabricatedTelemetry` is true whenever `NODE_ENV !== 'production'` — so every
// non-production database put "Nieuwe bouwers 9" and "Domeinoverstijgende oplossingen 11" on the
// payoff screen of the whole product, presented as measurements. Measured in the browser
// 2026-08-15, in Dutch, beside the two real ones.
//
// ⚠️ THE FIX IS NOT "DELETE THEM EVERYWHERE", AND THIS TEST EXISTS PARTLY TO SAY SO. Those two keys
// are the ONLY marker distinguishing a seeder artifact from a close-written one in
// `weekly_winners.stats` — they are the entire predicate of migration 0064 step 3
// (`jsonb_exists(stats,'firstTimeBuilders') OR jsonb_exists(stats,'crossDomain')`), and the shipped
// `COMMENT ON COLUMN` names both seeder line numbers. Stripping them from the seeders would leave
// `{totalVotesCast: 1207, solutionsSubmitted: 17}` — fabricated totals byte-indistinguishable from
// a real artifact — and make any future reconciliation impossible. They stay in the database and in
// the backend type. What was wrong is narrower: the BROWSER could render them.
//
// So the rule this pins is a contract between two files, not a key blacklist: whatever
// `periodSolutionStats` returns is what the winner screen may show. Add a third computed figure and
// this test tells you to render it; render a fourth invented one and it tells you not to.
//
// backend/ and frontend/ are two separate Bun projects — no workspaces, no shared package, no
// codegen — so this walks BACKEND SOURCE TEXT on disk, exactly as
// `policy-label.backend-contract.test.ts` and `api/error-message.backend-contract.test.ts` do.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BACKEND = fileURLToPath(new URL('../../../../backend', import.meta.url));
const read = (rel: string) => readFileSync(`${BACKEND}/${rel}`, 'utf8');

const pageSrc = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const typesSrc = readFileSync(new URL('../../lib/types/marketplace.ts', import.meta.url), 'utf8');

/**
 * The body of `periodSolutionStats`, BRACE-MATCHED to its closing `}`.
 *
 * ⛔ THE FIRST VERSION SLICED TO END OF FILE and worked only by accident — `periodSolutionStats`
 * happens to be the last function in `cycle-eligibility.ts`. Append anything below it and its
 * `return`s would have polluted the key set. Caught by adversarial review.
 */
function aggregateBody(): string {
	const src = read('src/host/cycle-eligibility.ts');
	const at = src.indexOf('export async function periodSolutionStats');
	expect(at, 'periodSolutionStats not found — the scan read the wrong file').toBeGreaterThan(-1);
	let depth = 0;
	let i = src.indexOf('{', at);
	const from = i;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}' && --depth === 0) break;
	}
	const body = src.slice(from, i + 1);
	expect(body.length, 'brace matching ran off the end of the file').toBeGreaterThan(20);
	return body;
}

/**
 * The keys the aggregate actually returns, re-derived from its own source rather than listed here.
 *
 * ⛔⛔ THE REGEX-ONLY VERSION OF THIS WAS VACUOUS, AND ADVERSARIAL REVIEW PROVED IT. It matched only
 * `return {...}` object literals with no nested brace, so the single most common refactor there is —
 *
 *     const stats = { …, firstTimeBuilders: 9 };
 *     return stats;
 *
 * — made the real aggregate INVISIBLE, and the derivation silently fell back to the
 * `if (!week) return { solutionsSubmitted: 0, totalVotesCast: 0 }` short-circuit. 5/5 PASSED with a
 * fabricated figure restored. I reproduced it before believing it.
 *
 * Two changes: `return <identifier>;` now resolves that identifier's object literal, and — more
 * importantly — the DIRECT assertion below no longer depends on this parse succeeding at all.
 */
function computedStatKeys(): string[] {
	const body = aggregateBody();
	const keys = new Set<string>();
	const add = (lit: string) => {
		for (const k of lit.match(/(\w+)\s*:/g) ?? []) keys.add(k.replace(/\s*:$/, ''));
	};
	// `return { … }` — the inline form.
	for (const r of body.match(/return\s*\{[^{}]*\}/g) ?? []) add(r);
	// `return <ident>;` — resolve the identifier's own object literal. This is the refactor that
	// made the first version of this test vacuous.
	for (const m2 of body.matchAll(/return\s+(\w+)\s*;/g)) {
		const decl = new RegExp(`(?:const|let|var)\\s+${m2[1]}\\s*(?::[^=]*)?=\\s*(\\{[^{}]*\\})`).exec(body);
		if (decl) add(decl[1]);
	}
	expect(keys.size, 'the scan derived no keys at all from periodSolutionStats').toBeGreaterThan(0);
	return [...keys].sort();
}

/** Every `data.stats.X` the winner page reads, in markup or in `hasNumbers`. */
function renderedStatKeys(): string[] {
	return [...new Set((pageSrc.match(/data\.stats\.(\w+)/g) ?? []).map((s) => s.split('.')[2]))].sort();
}

describe('/winner states only what the product can compute', () => {
	it('the aggregate the close stamps has exactly two keys', () => {
		// Anchors the derivation: if this ever legitimately grows, the equality below is the thing
		// that must be re-read, not silently widened.
		expect(computedStatKeys()).toEqual(['solutionsSubmitted', 'totalVotesCast']);
	});

	// ⛔⛔ THE ASSERTION THAT ACTUALLY CATCHES THE MUTATION THAT DEFEATED THE FIRST VERSION.
	// It depends on NO parsing: whatever shape the aggregate is written in — an inline literal, a
	// variable, a spread, a helper — its source may not so much as MENTION a key the product cannot
	// compute. That is the real invariant, and it survives every refactor the derivation above does
	// not. Reproduced before it was written: `const stats = {…, firstTimeBuilders: 9}; return stats;`
	// left the whole file 5/5 GREEN.
	it('⛔ the aggregate cannot even name a figure nothing can compute', () => {
		const body = aggregateBody();
		for (const dead of ['firstTimeBuilders', 'crossDomain']) {
			expect(body, `periodSolutionStats mentions ${dead}, which nothing in the codebase can compute`).not.toContain(
				dead
			);
		}
	});

	it('⛔ every figure the winner screen renders is one the backend measures', () => {
		expect(renderedStatKeys()).toEqual(computedStatKeys());
	});

	it('⛔ the wire-facing type cannot describe an uncomputable figure', () => {
		// `hasNumbers` and the markup both read through this type, so narrowing it is what makes the
		// render site a tsc error rather than a silent `undefined`.
		const stats = typesSrc.slice(typesSrc.indexOf('\tstats: {'));
		const block = stats.slice(0, stats.indexOf('\t};'));
		expect(block, 'the scan read no stats block').toContain('totalVotesCast');
		expect(block).not.toContain('firstTimeBuilders');
		expect(block).not.toContain('crossDomain');
	});

	it('⛔ the catalog no longer carries words for figures nothing can produce', () => {
		const en = readFileSync(new URL('../../../messages/en.json', import.meta.url), 'utf8');
		expect(en).not.toContain('winner_num_first_time_builders');
		expect(en).not.toContain('winner_num_cross_domain');
	});

	// ⚠️ THE OTHER HALF OF THE DECISION, PINNED SO NOBODY "FINISHES THE JOB". The seeders must KEEP
	// writing both keys: they are migration 0064's forensic marker. A future reader who greps for
	// `firstTimeBuilders`, finds it only in the seeders, and deletes it as dead would silently
	// destroy the one signal that separates fabricated history from real.
	it('⛔ the seeders still write the forensic marker migration 0064 matches on', () => {
		for (const f of ['src/db/seed-marketplace.ts', 'src/db/seed-tenant-showcase.ts']) {
			const src = read(f);
			expect(src, `${f}: the scan read an empty file`).toContain('periodSolutionStats');
			expect(src, `${f} stopped writing firstTimeBuilders — that is migration 0064's marker`).toContain(
				'firstTimeBuilders',
			);
			expect(src, `${f} stopped writing crossDomain — that is migration 0064's marker`).toContain('crossDomain');
		}
		// And the migration that depends on it still does.
		expect(read('migrations/0064_reconcile_vote_counts.sql')).toContain("jsonb_exists(w.stats, 'firstTimeBuilders')");
	});
});
