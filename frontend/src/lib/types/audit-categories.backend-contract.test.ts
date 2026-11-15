// src/lib/types/audit-categories.backend-contract.test.ts — the audit chip row is complete.
//
// THE DEFECT this pins: the feed shipped five chips (sandbox, block, policy, deploy, auth) next
// to an "All events" count that sums EVERY category in the table. `data` — the single busiest
// writer in the product — plus `system` and `tenant` had no chip, so the header arithmetic did
// not add up and `?category=data` was discarded twice with no signal.
//
// Three independent lists have to agree and none of them can be derived from the others at build
// time: the categories `recordAudit` is CALLED with (backend, ~107 sites), the `CATEGORIES`
// allowlist that FILTERS (backend/src/routes/audit.ts), and `AUDIT_CATEGORIES` that renders the
// CHIPS (frontend). backend/ and frontend/ are two separate Bun projects — no workspaces, no
// shared package, no codegen step — so, exactly as `api/error-message.backend-contract.test.ts`
// does for 403 codes, this walks BACKEND SOURCE TEXT on disk with plain `fs` (no backend runtime
// import: this is a frontend vitest project) and diffs the three sets.
//
// It reads the call sites by brace-matching the `recordAudit(` argument list rather than by a
// flat line regex, because the call is multi-line at nearly every site. A site whose `category`
// is a runtime expression rather than a literal cannot be resolved statically; those are
// collected separately and asserted to be the ONE known ternary, so a new dynamic site trips
// this test instead of slipping through as "no literal found".
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AUDIT_CATEGORIES, AUDIT_BADGE } from './audit';

const BACKEND_SRC = fileURLToPath(new URL('../../../../backend/src', import.meta.url));

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		const st = statSync(p);
		if (st.isDirectory()) out.push(...listTsFiles(p));
		else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(p);
	}
	return out;
}

/** The full text of every `recordAudit(...)` argument list in the backend. */
function recordAuditCalls(): { file: string; text: string }[] {
	const calls: { file: string; text: string }[] = [];
	for (const file of listTsFiles(BACKEND_SRC)) {
		const src = readFileSync(file, 'utf8');
		let at = 0;
		for (;;) {
			const start = src.indexOf('recordAudit(', at);
			if (start === -1) break;
			let depth = 0;
			let end = -1;
			for (let i = start + 'recordAudit'.length; i < src.length; i++) {
				if (src[i] === '(') depth++;
				else if (src[i] === ')') {
					depth--;
					if (depth === 0) {
						end = i;
						break;
					}
				}
			}
			if (end === -1) break;
			calls.push({ file: file.slice(BACKEND_SRC.length), text: src.slice(start, end + 1) });
			at = end + 1;
		}
	}
	return calls;
}

/**
 * ⛔⛔ BOTH READERS BELOW ARE QUOTE-AGNOSTIC — SINGLE, DOUBLE **OR BACKTICK** — AND THE FIRST ONE IS
 * A MEASURED HOLE, NOT DEFENSIVE PROGRAMMING.
 *
 * `parseCategories` used to be `/'([^']+)'/g`. Measured 2026-08-16: adding `"integration"` to the
 * backend's `CATEGORIES` allowlist — one member, one pair of double quotes — left ALL SEVEN
 * assertions in this file GREEN. That is precisely the defect the file's header describes: a backend
 * category with no chip, unreachable from the UI and visible only inside the "All events" total.
 * There is NO prettier and NO eslint config anywhere in this repo, so nothing normalises quote style
 * in `backend/` and a double-quoted literal is an ordinary thing for the next author to write.
 *
 * ⚠️ `categoryOfCall` WAS **NOT** BLIND, and it is widened for a different reason. Measured on the
 * same day: rewriting a real `category: 'data'` call site to `category: "data"` DID go red — but as
 * `expected [ '/host/run-controller.ts', …(1) ] to deeply equal [ '/host/run-controller.ts' ]`, i.e.
 * accusing the site of taking its category from a RUNTIME EXPRESSION, which is false and sends the
 * reader to check a ternary that does not exist. Reading every quote style makes the literal resolve,
 * so a double-quoted category is checked against the chip row and the allowlist like any other and
 * only reds when it genuinely has no chip.
 */
function parseCategories(chunk: string): string[] {
	return [...chunk.matchAll(/(['"`])([^'"`]+)\1/g)].map((x) => x[2]!);
}

/** The `category:` literal in one `recordAudit(…)` argument list, or `undefined` if it is dynamic. */
function categoryOfCall(callText: string): string | undefined {
	return callText.match(/category:\s*(['"`])([^'"`]+)\1/)?.[2];
}

/** `CATEGORIES = [...] as const` from backend/src/routes/audit.ts — the filter allowlist. */
function backendFilterCategories(): string[] {
	const src = readFileSync(join(BACKEND_SRC, 'routes', 'audit.ts'), 'utf8');
	const m = src.match(/const CATEGORIES = \[([\s\S]*?)\] as const;/);
	if (!m) throw new Error('CATEGORIES literal not found in backend/src/routes/audit.ts');
	return parseCategories(m[1]!);
}

const calls = recordAuditCalls();
const written = new Set<string>();
const dynamic: string[] = [];
for (const c of calls) {
	// `recordAudit` itself (the definition) has no `category:` in its argument list.
	if (c.file === '/host/audit-service.ts') continue;
	const lit = categoryOfCall(c.text);
	if (lit) written.add(lit);
	else dynamic.push(c.file);
}

describe('audit categories: frontend chips ↔ backend', () => {
	it('found the backend call sites at all (guards the parser itself)', () => {
		// If the brace-matcher or the path ever breaks, every set below goes empty and the
		// comparisons pass vacuously. This is the assertion that makes the rest mean something.
		expect(calls.length).toBeGreaterThan(50);
		expect(written.size).toBeGreaterThan(5);
	});

	it('every category recordAudit writes has a chip', () => {
		const missing = [...written].filter((c) => !AUDIT_CATEGORIES.includes(c as never)).sort();
		expect(missing).toEqual([]);
	});

	it('every category recordAudit writes is filterable by the backend', () => {
		const allow = backendFilterCategories();
		const missing = [...written].filter((c) => !allow.includes(c)).sort();
		expect(missing).toEqual([]);
	});

	it('the chip row and the backend allowlist are the same set', () => {
		// Either direction is a defect: a chip the backend does not filter always reads 0 and
		// silently returns the unfiltered feed when clicked; a backend category with no chip is
		// unreachable and its rows show up only inside the "All events" total.
		expect([...AUDIT_CATEGORIES].sort()).toEqual([...backendFilterCategories()].sort());
	});

	it('the only unresolved call site is the one known runtime ternary', () => {
		// host/run-controller.ts picks `'policy'` or `'system'` from the refusal kind. Both are in
		// the set above; a NEW dynamic site would land here and must be checked by hand.
		expect(dynamic).toEqual(['/host/run-controller.ts']);
	});

	it('every chip has a badge tone, and every tone has a rule in AuditRow', () => {
		// Read the tones out of the component's own stylesheet: a tone with no `.badge.<tone>` rule
		// renders an unstyled, invisible-bordered badge — which is what `emerald` and `slate` would
		// have been had they been added to the map alone.
		const css = readFileSync(
			fileURLToPath(new URL('../components/ops/AuditRow.svelte', import.meta.url)),
			'utf8'
		);
		const tones = new Set([...css.matchAll(/\.badge\.([a-z]+)\s*\{/g)].map((x) => x[1]!));
		expect(tones.size).toBeGreaterThan(3);
		expect(Object.keys(AUDIT_BADGE).sort()).toEqual([...AUDIT_CATEGORIES].sort());
		for (const c of AUDIT_CATEGORIES) {
			expect(tones.has(AUDIT_BADGE[c]!)).toBe(true);
		}
	});

	it('⛔ the scrapers see DOUBLE-QUOTED and BACKTICK literals too (one measurably did not)', () => {
		// ⛔ THE SCRAPERS' OWN NON-VACUITY, ON SYNTHETIC SOURCE. Every assertion above is only as good
		// as the two readers, and `parseCategories` was blind to a double-quoted allowlist member: the
		// whole file stayed green with an unreachable backend category shipped. Driving the parsers
		// over a fixture is the only way to test a parser without waiting for the bug.
		expect(parseCategories(`\n  'sandbox',\n  "integration",\n  \`tenant\`,\n`)).toEqual([
			'sandbox',
			'integration',
			'tenant'
		]);
		expect(categoryOfCall("recordAudit({ action: 'x', category: 'data' })")).toBe('data');
		expect(categoryOfCall('recordAudit({ category: "data" })')).toBe('data');
		expect(categoryOfCall('recordAudit({ category: `data` })')).toBe('data');
		// …and a genuinely dynamic category is still UNRESOLVED, not mis-read as a literal — that is
		// what keeps `the only unresolved call site is the one known runtime ternary` meaningful.
		expect(categoryOfCall("recordAudit({ category: kind === 'x' ? 'policy' : 'system' })")).toBeUndefined();

		// …and the REAL sources still parse the same way through the widened regexes.
		expect(backendFilterCategories().length).toBeGreaterThan(5);
		expect(written.size).toBeGreaterThan(5);
	});

	it('has no duplicate chip keys', () => {
		expect(new Set(AUDIT_CATEGORIES).size).toBe(AUDIT_CATEGORIES.length);
	});
});
