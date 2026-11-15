// src/lib/test/bidi.ts — the bidi isolate characters, named once for every test that asserts on
// copy which interpolates a backend-supplied value.
//
// ⛔ WHY THIS IS A SHARED MODULE AND NOT A LOCAL CONST PER FILE. U+2068 and U+2069 are INVISIBLE.
// A test that pastes them raw shows a reviewer `'Het blok "llm-summarize" …'` and a diff that
// appears to change nothing, and the next author "tidies up" what looks like a stray character.
// Worse, three files each holding their own copy drift independently — which is how the same
// literal ends up spelled two ways. One named export, imported everywhere, is reviewable.
//
// The producer is `iso()` in `$lib/api/error-message.ts` (and its character-for-character twins in
// `i18n/graph-issue-label.ts` and `i18n/connection-test-label.ts`). Read `iso`'s doc comment before
// changing anything here: a COMPOUND is wrapped WHOLE, never one isolate per part.

/** FIRST STRONG ISOLATE — what `<bdi>` compiles down to. */
export const FSI = '⁨';
/** POP DIRECTIONAL ISOLATE. */
export const PDI = '⁩';

/**
 * A single readable token as `iso()` emits it.
 *
 * ⚠️ ONE isolate around the WHOLE value. Do not call this per field of a joined compound — that
 * REVERSES the halves under UAX#9, which is the defect `i18n/graph-issue-label.bidi.test.ts`
 * measured on `“{sourceNode}.{sourceHandle}”`.
 */
export const iso = (v: string): string => `${FSI}${v}${PDI}`;
