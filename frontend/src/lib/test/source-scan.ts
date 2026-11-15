// src/lib/test/source-scan.ts — the shared primitive behind this repo's SOURCE guards: read a file
// from `src/`, with its comments removed.
//
// ⛔ WHY THIS EXISTS, MEASURED. `icu-number-params.sites.test.ts` asserted on raw source text with
// `src.indexOf('m.<key>({')` — the FIRST textual occurrence, comments included — and never counted
// the occurrences. Five reverts of ONE line in `lib/components/ui/Pager.svelte` were then run
// against it. A plain revert reds it (good); every one of these passed the full suite:
//
//   1. revert the call, and put the OLD GOOD CALL in an HTML comment above it        → 922/922 green
//   2. keep the good call and add a SECOND, bad `m.pager_showing({ shown, total })`  → 922/922 green
//   3. `shown: String(shown) /* num( locale.current */`                              → 922/922 green
//
// The first two are closed by stripping comments and by asserting the call appears EXACTLY ONCE
// (the fourth and fifth evasions — a faked argument and a wrong VARIABLE — are closed by pinning
// the argument expression, which is the caller's job, not this module's).
//
// ⚠️ THIS GUARDS A WRONG-DATA DEFECT WITH NO BACKUP, WHICH IS WHY IT IS WORTH A REAL STRIPPER.
// TypeScript structurally cannot see the mistake these guards catch: a paraglide message input
// compiles to `NonNullable<unknown>`, so putting `num()` on a plural key's `count` — which makes
// German print "1 Ereignis" for 1000, because `registry.plural` runs `Number("1.000")` — passes
// `svelte-check` with 2857 files / 0 errors. Measured. The source grep is the only mechanism that
// sees it at all.
//
// ⚠️ THE FAILURE DIRECTION IS DELIBERATE. Stripping is textual, not a full lexer, so it can in
// principle remove something that merely LOOKS like a comment. That direction is safe: the call
// then vanishes and the guard reds loudly ("no call found"). The direction that must never happen
// is under-stripping, which is the evasion above. Every consumer additionally asserts the call
// count is exactly 1, so an over-eager strip cannot silently pass either.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Remove `<!-- … -->`, `/* … *\/` and `// …` comments from a `.svelte` / `.ts` source.
 *
 * ⛔ ONE PASS WITH A STATE MACHINE, NOT THREE `.replace()` CALLS — AND THAT IS NOT A STYLE CHOICE.
 * The three-regex version of this function was written first and was measurably WORSE THAN USELESS
 * on the very file the licence guard scans. `licenseGate.svelte.ts`'s header comment contains the
 * literal text `` `$app/*` `` (naming a mock specifier). Stripping block comments with
 * `/\/\*[\s\S]*?\*\//` sees that `/*` — inside a `//` line comment it had not processed yet —
 * opens a block there and closes it at the first `*\/` FORTY LINES LOWER, swallowing every import
 * statement and the whole `LicenseGateState` union. A `not.toContain('$lib/paraglide')` assertion
 * over that output passes because the import was eaten, not because it is absent: a guard reporting
 * GREEN for the exact condition it exists to catch. Measured, and it is why the consumers below
 * also assert a positive anchor.
 *
 * A comment state therefore recognises ONLY its own terminator: nothing inside `//…` can open a
 * block, and nothing inside `/*…*\/` can open a line comment or eat a `-->`.
 *
 * ⚠️ THE `//` RULE SKIPS A `:` OR `\` PREFIX, which is what keeps two real things intact:
 * `postgres://user:pass@host/db` and `https://…` (three such placeholders really do ship in
 * `routes/connectors/+page.svelte`), and the escaped pair in a regex literal like
 * `/^(https?:)?\/\//i`. String literals are otherwise NOT tracked — deliberately: Svelte markup is
 * full of prose apostrophes, and a naive quote tracker would swallow the rest of a file at the
 * first "reader's".
 */
export function stripComments(src: string): string {
	let out = '';
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (c === '<' && src.startsWith('<!--', i)) {
			const end = src.indexOf('-->', i + 4);
			i = end === -1 ? src.length : end + 3;
			out += ' ';
		} else if (c === '/' && next === '*') {
			const end = src.indexOf('*/', i + 2);
			i = end === -1 ? src.length : end + 2;
			out += ' ';
		} else if (c === '/' && next === '/' && src[i - 1] !== ':' && src[i - 1] !== '\\') {
			const end = src.indexOf('\n', i);
			i = end === -1 ? src.length : end;
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

/** A file under `frontend/src`, comments removed. */
export function readSource(rel: string): string {
	return stripComments(readFileSync(resolve(process.cwd(), 'src', rel), 'utf8'));
}

/** The same file, verbatim — for the few assertions that are ABOUT the comments. */
export function readRaw(rel: string): string {
	return readFileSync(resolve(process.cwd(), 'src', rel), 'utf8');
}
