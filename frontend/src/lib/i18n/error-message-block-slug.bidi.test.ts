// src/lib/i18n/error-message-block-slug.bidi.test.ts — the six refusals that NAME a block must
// name it isolated, so an Arabic or Hebrew reader is shown the slug the backend actually refused.
//
// ⛔ THE DEFECT. `api/error-message.ts`'s `naming()` (:316-321) was the ONE interpolation site in
// that file that handed a backend string to a catalog pattern RAW:
//
//     return block === null ? null : render(block);        // ← was
//     return block === null ? null : render(iso(block));   // ← is
//
// Every sibling isolates: `carrying` at :412 does `render(iso(v))`, and so do :731, :1049 and
// :1056. The `ar` and `he` catalogs embed `{block}` inside `«…»` guillemets, i.e. inside an RTL
// run bounded by neutrals. A slug is Latin (`llm-summarize`, `http-fetch`) — a strong-LTR run
// dropped into strong-RTL text with no directional boundary — so UAX#9's implicit levels move it
// and drag the adjacent neutrals (the guillemets, any digits, any punctuation in the slug) with
// it. The sentence's whole job is to say WHICH block to go and fix.
//
// ⛔ WHY THIS IS ITS OWN FILE AND NOT A CASE IN `api/error-message.test.ts`. That file
// `vi.mock`s `$lib/paraglide/messages` down to sentinels like `BLOCK_ARCHIVED:${i.block}`, which
// is right for what it tests (WHICH message the mapper picks) and structurally blind to this
// (what the CATALOG does with the value). Nothing is mocked here: the REAL compiled catalogs are
// driven through `overwriteGetLocale`, the same lever `$lib/stores/locale.svelte.ts` pulls in the
// running app — so a translator who rewrites the `he` pattern must red this file.
//
// ⛔ WHY THE ASSERTION IS ON THE SOURCE STRING AND NOT ON PIXELS — the reasoning
// `graph-issue-label.bidi.test.ts` measured, applied rather than rediscovered. jsdom does no
// layout and cannot resolve bidi at all, and `bidi-js` exists in node_modules only as a transitive
// dependency of jsdom, so importing it would red this file on an unrelated jsdom bump. What is
// asserted instead is the property UAX#9 makes sufficient: text between an isolate initiator and
// its matching PDI resolves independently and is rendered as a unit at the surrounding level. An
// unbroken FSI…PDI FIXES the slug's internal order and its position — that is a theorem about the
// algorithm, not a heuristic.
//
// ⚠️ ONE isolate around the WHOLE slug, per `iso`'s doc comment (:322-335). A slug is a single
// readable token — there are no parts to isolate separately, so the compound-reversal trap
// `graph-issue-label.ts` hit on `“{sourceNode}.{sourceHandle}”` cannot arise here. The forbidden
// shape is nonetheless asserted, because a future author "improving" this by isolating a slug's
// hyphen-separated parts would reintroduce exactly that bug.
import { describe, it, expect, afterEach } from 'vitest';
import { overwriteGetLocale } from '$lib/paraglide/runtime';
import { writeErrorText } from '$lib/api/error-message';
import { FSI, PDI } from '$lib/test/bidi';

// FSI/PDI come from `$lib/test/bidi` — one definition for invisible characters.

/** Hyphens on purpose: a neutral INSIDE the token, which is what strays without an isolate. */
const BLOCK = 'llm-summarize';

/**
 * The six codes routed through `naming()`. Named individually rather than derived, because the
 * point is that these SIX are affected — `error-message.ts:1180-1194` — and a seventh added to the
 * map without an isolate is a new instance of this bug that a derived list would absorb silently.
 */
const NAMING_CODES = [
	'missing_block_version',
	'block_version_mismatch',
	'block_archived',
	'block_version_unpublished',
	'policy_network_blocked',
	'policy_pii_violation'
] as const;

/** Every locale the catalogs ship, RTL first — the property must hold in all eight. */
const LOCALES = ['ar', 'he', 'en', 'nl', 'de', 'es', 'fr', 'pl'] as const;
const RTL = ['ar', 'he'] as const;

const details = { nodeId: 'n1', blockId: 'b1', versionId: 'v1', blockSlug: BLOCK };
const render = (code: string) =>
	writeErrorText({ status: 422, code, message: `Block '${BLOCK}' is unusable.`, details }, 'FALLBACK');

afterEach(() => overwriteGetLocale(() => 'en'));

describe('a block slug in a refusal survives an RTL sentence', () => {
	it('the fixture really reaches the catalog — not the backend English, not the fallback', () => {
		// ⛔ NON-VACUITY, FIRST, AND IT IS LOAD-BEARING HERE. Every assertion below is "the rendered
		// string contains X". `writeErrorText` prefers the BACKEND MESSAGE for most codes and falls
		// through to `'FALLBACK'`; the backend message contains `llm-summarize` verbatim, so if the
		// mapper ever stopped routing these six through `naming()` the positive half of every case
		// below would still be satisfiable while proving nothing about the catalog at all.
		overwriteGetLocale(() => 'he');
		for (const code of NAMING_CODES) {
			const out = render(code);
			expect(out, `${code}: fell through to the generic fallback`).not.toBe('FALLBACK');
			expect(out, `${code}: shipped the backend English verbatim`).not.toContain('is unusable');
			// …and it really is the Hebrew pattern. `הבלוק` ("the block") opens all six.
			expect(out, `${code}: not the Hebrew catalog string`).toContain('הבלוק');
		}
	});

	it('⛔ the slug is wrapped in ONE isolate, in every locale', () => {
		for (const locale of LOCALES) {
			overwriteGetLocale(() => locale);
			for (const code of NAMING_CODES) {
				const out = render(code);
				// THE POSITIVE HALF: present, and wrapped as a single unit.
				expect(out, `${locale}/${code}: slug is not inside an FSI…PDI pair`).toContain(
					`${FSI}${BLOCK}${PDI}`
				);
				// THE FORBIDDEN SHAPE, BY NAME: `⁨llm⁩-⁨summarize⁩`. Per-part isolation is what
				// reverses a compound under UAX#9 — the lesson `graph-issue-label.ts` paid for.
				expect(out, `${locale}/${code}: the slug is split across two isolates`).not.toMatch(
					/⁩[^⁨⁩]{0,3}⁨/
				);
			}
		}
	});

	it('⛔ the RTL catalogs put the isolate INSIDE the guillemets, not around them', () => {
		// The guillemets are the catalog's own punctuation and must stay outside the isolate: an
		// isolate that swallowed them would make `«` and `»` part of the LTR run and render them
		// mirrored relative to the surrounding Hebrew/Arabic sentence.
		for (const locale of RTL) {
			overwriteGetLocale(() => locale);
			for (const code of NAMING_CODES) {
				const out = render(code);
				expect(out, `${locale}/${code}`).toContain(`«${FSI}${BLOCK}${PDI}»`);
			}
		}
	});

	it('an ABSENT slug still yields no stray isolate — the null path is untouched', () => {
		// `naming` returns `null` without a `blockSlug`, and the mapper then falls back to the
		// backend's NAMED English (see `ValidationCopy`'s doc comment for why that is deliberate).
		// A guard that emitted `⁨⁩` around nothing would be a new defect, so it is pinned.
		overwriteGetLocale(() => 'he');
		for (const code of NAMING_CODES) {
			const out = writeErrorText(
				{ status: 422, code, message: `Block '${BLOCK}' is unusable.` },
				'FALLBACK'
			);
			expect(out, `${code}: lost the backend's named English`).toContain(BLOCK);
			expect(out, `${code}: emitted an isolate with no value in it`).not.toContain(FSI);
		}
	});
});
