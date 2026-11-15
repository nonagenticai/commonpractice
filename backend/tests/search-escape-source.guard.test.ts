// tests/search-escape-source.guard.test.ts — a ratchet against the EIGHTH copy of the raw
// ILIKE pattern.
//
// ⛔ WHAT IT BOUNDS. `src/utils/search.ts` exports `likeTerm(q)`, which escapes the three
// characters that mean something to ILIKE (`\ % _`) before wrapping the query in `%…%`. It
// exists because the three-character escape kept being re-typed slightly differently or not at
// all: at the moment it was extracted, exactly TWO call sites used it (routes/search.ts and
// routes/connectors.ts) and ELEVEN other predicates across seven files interpolated the user's
// raw query straight into `` `%${q}%` ``. A tenant searching their block library for
// `Korting 100% eraf` matched every row containing `Korting 100`; an auditor pasting the action
// `dataset_created` back into the audit box also matched `dataset<any char>created`. The
// companion behavioural proof is tests/search-wildcard-escape.test.ts. THIS file is the part
// that stops the defect coming back — a behavioural test only covers the four surfaces it
// happens to seed, and the raw pattern was never confined to those four.
//
// ⛔ TWO WAYS A GUARD LIKE THIS GOES VACUOUS. Both are handled explicitly and both are PROVEN
// below rather than asserted in prose:
//
//   (i) COMMENTS. Every one of the seven fixed files now carries a comment that literally spells
//       `` `%${q}%` `` to say what NOT to write — including this file's own header. A naive
//       `grep '%${'` over src/ therefore reports seven violations forever, and the only way to
//       make it green is to delete the explanations. So the scanner strips `//` and `/* */`
//       before matching. That stripping is itself the thing most likely to be silently broken
//       (an over-eager stripper that ate real code would make the guard pass on ANY source), so
//       `test('the comment stripper is load-bearing…')` asserts BOTH halves against the REAL
//       tree: the raw bytes DO contain the banned spelling (so the scan is not looking at an
//       empty haystack) and the stripped bytes do not.
//
//  (ii) IT BANS A SPELLING, NOT A PROPERTY. This is a limitation, stated rather than papered
//       over. The rules below match a TEMPLATE LITERAL — one whose whole body is wildcards and
//       `${}` interpolations, plus (on ILIKE lines only) the looser "mixes `%` with `${`".
//
//       ⚠️ THE EVASION SET BELOW WAS MEASURED, not guessed — an earlier revision of this note
//       listed `String.raw` and "a helper three files away" as escapes and BOTH were wrong,
//       which is worse than no note at all: it tells a reviewer to hand-check a case the guard
//       already covers while leaving the real holes unnamed.
//
//         EVADES (measured):  `'%' + q + '%'`            — string concatenation, no template
//                             `'%'.concat(q, '%')`       — same, via a method
//                             a template SPLIT ACROSS LINES (`TEMPLATE` is line-bounded on
//                               purpose, so the reported line number stays honest)
//                             `['%', q, '%'].join('')`
//                             a `%` that arrives already inside `q`
//                             a helper OUTSIDE the two scanned roots (src/routes, src/ai)
//
//         CAUGHT (measured):  the inline `ilike(x, `%${q}%`)`
//                             the HOISTED `const like = `%${q}%`` two lines above the ilike
//                             `String.raw`%${q}%`` (the literal is still the banned shape)
//                             a template built inside a helper that lives in a scanned file
//
//       So this is a tripwire on the shape the defect actually took eleven times, not a proof
//       of absence. The real invariant — "every ILIKE pattern in this codebase came out of
//       `likeTerm`" — is not decidable by reading source, and a reviewer must still check that
//       a new search box imports it.
//
// ⚠️ The scanner is a small state machine, NOT a regex over lines: it has to know it is inside a
// string/template so that `'https://…'` is not read as the start of a line comment, and it has
// to survive `${}` nesting so the template that IS the violation is not mistaken for its own
// terminator. Regex literals are the one JS token type it does not model — a `//` inside a
// regex would be read as a comment. No file under scan contains one, and the load-bearing test
// below would fail loudly (raw-contains-banned but stripped-is-empty is not a state it accepts)
// if a future one truncated a file.
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');
const ROOTS = [join(SRC, 'routes'), join(SRC, 'ai')];

/** The banned spelling, as it appears in raw bytes — used by the non-vacuity proof below. */
const BANNED_RAW = '`%${';

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFilesUnder(p));
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out.sort();
}

/**
 * Blank out `//` line comments and `/* *\/` blocks, replacing each stripped character with a
 * space (or a newline) so that byte offsets and LINE NUMBERS are preserved — a violation must be
 * reportable at the line the author will see in their editor.
 *
 * Tracks single-quoted, double-quoted and template strings (including `${…}` nesting) so that a
 * `//` or `/*` inside a string is left alone.
 */
export function stripComments(src: string): string {
  const out: string[] = [];
  // Stack of open template-literal contexts; an entry is the `${` brace depth at which the
  // template resumes. Empty = not inside a template.
  const tmpl: number[] = [];
  let braceDepth = 0;
  let i = 0;
  const keep = (n = 1) => {
    out.push(src.slice(i, i + n));
    i += n;
  };
  // ⚠️ INDEXED, NOT `for…of`. `for (const c of str)` iterates CODE POINTS, so one astral
  // character (an emoji — `\u{1F6D1}` is two UTF-16 units) yielded ONE space and the stripped
  // text came out SHORTER than the raw. Every line number after it still lined up (the loss is
  // within a line), but the length/offset invariant this function promises did not, and the
  // fixture test below measured RAW 55 / STRIPPED 54 before this loop was indexed. No file under
  // scan contains an emoji in a comment today; the first one pasted in would have broken it.
  const blank = (n: number) => {
    const chunk = src.slice(i, i + n);
    for (let k = 0; k < chunk.length; k++) out.push(chunk[k] === '\n' ? '\n' : ' ');
    i += n;
  };
  while (i < src.length) {
    const c = src[i]!;
    const inTemplateText = tmpl.length > 0 && tmpl[tmpl.length - 1] === braceDepth;

    if (inTemplateText) {
      if (c === '\\') { keep(2); continue; }
      if (c === '`') { tmpl.pop(); keep(); continue; }
      if (c === '$' && src[i + 1] === '{') { braceDepth++; keep(2); continue; }
      keep();
      continue;
    }

    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      blank((nl === -1 ? src.length : nl) - i);
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      blank((end === -1 ? src.length : end + 2) - i);
      continue;
    }
    if (c === "'" || c === '"') {
      keep();
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') keep(2);
        else if (src[i] === '\n') break; // unterminated — bail rather than eat the file
        else keep();
      }
      if (i < src.length && src[i] === c) keep();
      continue;
    }
    if (c === '`') { tmpl.push(braceDepth); keep(); continue; }
    if (c === '{') { braceDepth++; keep(); continue; }
    if (c === '}') {
      braceDepth--;
      // Closing the `${…}` of an open template hands control back to the template's text.
      keep();
      continue;
    }
    keep();
  }
  return out.join('');
}

// A template literal, allowed to span nothing but its own line — every real occurrence is
// single-line, and keeping it line-bounded is what makes the reported line number honest.
const TEMPLATE = /`(?:[^`\\\n]|\\.)*`/g;

/**
 * A template literal that is NOTHING BUT ILIKE wildcards and interpolations — `` `%${q}%` ``,
 * `` `${q}%` ``, `` `%${a}%${b}%` ``. That shape has exactly one use in this codebase, and it is
 * the use `likeTerm` exists to own.
 *
 * ⚠️ THE SHAPE, NOT MERELY "% NEAR ${". A first cut banned any template mixing `%` with `${` and
 * immediately flagged `routes/pipeline.ts:540` — `` `Staging · ${updated!.rollout_pct}% canary` ``
 * — which is a percentage in a human sentence, not a pattern. A rule that has to be suppressed
 * on its first real input is a rule people delete. Requiring the ENTIRE body to be wildcards and
 * interpolations separates the two with no exception list. `_` is admitted alongside `%` because
 * it is the other ILIKE metacharacter.
 */
function wildcardPatternLiterals(code: string): { line: number; text: string }[] {
  const SHAPE = /^`[%_]*(?:\$\{[^`]*\}[%_]*)+`$/;
  const hits: { line: number; text: string }[] = [];
  code.split('\n').forEach((line, idx) => {
    for (const m of line.matchAll(TEMPLATE)) {
      if (m[0].includes('%') && SHAPE.test(m[0])) hits.push({ line: idx + 1, text: m[0] });
    }
  });
  return hits;
}

/**
 * The looser reading — any template mixing `%` with `${`. Used ONLY on lines that also call
 * ILIKE, where the surrounding context rules out the percentage-in-a-sentence false positive
 * that makes it unusable on its own. The two rules cover each other: this one catches a pattern
 * with extra literal text glued on (`` `%${q}% ` ``) that the shape rule would let through,
 * while the shape rule catches the HOISTED form — `routes/blocks.ts` and
 * `ai/block-catalog-service.ts` both assigned the pattern to a `const` two to five lines above
 * the `ilike(...)` calls that consumed it, so an ilike-on-the-same-line rule scored both clean.
 */
function looseMixedLiterals(code: string): { line: number; text: string }[] {
  const hits: { line: number; text: string }[] = [];
  code.split('\n').forEach((line, idx) => {
    for (const m of line.matchAll(TEMPLATE)) {
      if (m[0].includes('%') && m[0].includes('${')) hits.push({ line: idx + 1, text: m[0] });
    }
  });
  return hits;
}

const FILES = ROOTS.flatMap(tsFilesUnder);

test('the scan actually reaches the files it claims to (non-vacuity: the haystack exists)', () => {
  expect(FILES.length).toBeGreaterThan(10);
  const names = FILES.map((f) => relative(SRC, f));
  // The seven files the sweep fixed — if a rename ever moves one out of the scanned roots, this
  // guard would silently stop covering it.
  for (const f of [
    'routes/blocks.ts', 'routes/challenges.ts', 'routes/solutions.ts', 'routes/datasets.ts',
    'routes/audit.ts', 'routes/sandboxes.ts', 'routes/search.ts', 'routes/connectors.ts',
    'ai/block-catalog-service.ts',
  ]) {
    expect(names, `${f} is no longer under the scanned roots — the guard has a hole`).toContain(f);
  }
});

test('the comment stripper is load-bearing, and does not eat real code', () => {
  // (i) THE HAYSTACK IS NOT EMPTY. At least one scanned file still contains the banned spelling
  // in its RAW bytes — the "⛔ likeTerm, NOT `%${q}%`" comments. A raw grep would report these
  // as violations, which is precisely why the scanner strips comments; if this expectation ever
  // fails it means the comments were deleted and the stripping is no longer exercised by any
  // real input, so the guard below would be passing for the wrong reason.
  const rawOffenders = FILES.filter((f) => readFileSync(f, 'utf8').includes(BANNED_RAW));
  expect(
    rawOffenders.length,
    'no scanned file contains the banned spelling even in a comment — the stripper is untested',
  ).toBeGreaterThan(0);

  // (ii) THE LINE NUMBERS IT REPORTS ARE HONEST, and the comment really was blanked. For every
  // file whose RAW bytes carry the banned spelling, the line that carries it must (a) still be
  // the SAME line index after stripping — that is what makes a reported `file:line` point at
  // what the author sees in their editor — and (b) be nothing but whitespace there.
  //
  // ⚠️ THIS REPLACED A PAIR OF TAUTOLOGIES. The previous revision asserted, over the same loop,
  // that `stripped.length === raw.length` and that the line count was unchanged. Both are true
  // by construction of `blank()`/`keep()` for the 48 files actually scanned, so they measured
  // nothing — and worse, the length one was not even always true (see the emoji fixture below).
  // The assertions here can fail on a real stripper defect: an over-eager blank that ate a
  // newline moves the index, and a stripper that missed the comment leaves the text behind.
  for (const f of rawOffenders) {
    const rawLines = readFileSync(f, 'utf8').split('\n');
    const strippedLines = stripComments(readFileSync(f, 'utf8')).split('\n');
    expect(strippedLines.length, `${f}: stripping changed the line count`).toBe(rawLines.length);
    const idx = rawLines.findIndex((l) => l.includes(BANNED_RAW));
    expect(idx, `${f}: the banned spelling is in the file but on no single line`).toBeGreaterThan(-1);
    expect(
      strippedLines[idx],
      `${f}:${idx + 1} carried the banned spelling in a comment, but the stripped text at that ` +
        `same line index is not blank — either the comment survived or the offsets shifted`,
    ).toMatch(/^\s*$/);
  }
  // A file that is nothing but comments would strip to whitespace; a file with code must not.
  //
  // ⚠️ ASSERT ON CODE THAT EXISTS IN BOTH THE FIXED AND THE BROKEN TREE. An earlier revision
  // asserted the stripped text contained `import { likeTerm }`, which made THIS test red on
  // origin/main for a reason that has nothing to do with the stripper — a test named for the
  // stripper that actually measures the fix tells you the wrong thing when it fails.
  const blocks = stripComments(readFileSync(join(SRC, 'routes', 'blocks.ts'), 'utf8'));
  expect(blocks).toContain('ilike(buildingBlocks.name, like)');
  expect(blocks).toContain("import { z } from 'zod'");
});

// ---------------------------------------------------------------------------
// ⛔ THE LATENT FALSE RED. `stripComments` blanks a comment character by character, and the loop
// that does it used `for (const c of str)` — which iterates CODE POINTS. A 🛑 in a comment is ONE
// code point but TWO UTF-16 units, so it was replaced by ONE space and the stripped text came out
// a unit short of the raw. Nothing in `src/routes/` or `src/ai/` contains an emoji in a comment
// TODAY, so the invariant the old revision asserted over the real tree passed — and would have
// turned red, with a message about "byte length", the first time somebody pasted one in.
//
// Measured on the pre-fix helper with the fixture below: RAW 65 / STRIPPED 64, DELTA -1.
//
// This is a FIXTURE test rather than a scan, precisely so it does not depend on what the real
// tree happens to contain: it is red on the old helper and green on the indexed one, forever.
// ---------------------------------------------------------------------------
test('an astral character in a comment does not shrink the stripped text', () => {
  const src = ['const a = 1; // 🛑 stop: never write the raw pattern', 'const b = 2;'].join('\n');
  // The fixture is only meaningful if it actually contains a surrogate pair — `.length` (UTF-16
  // units) must exceed the code-point count, or this test is measuring nothing.
  expect([...src].length, 'the fixture has no astral character — it cannot detect the defect').toBeLessThan(
    src.length,
  );

  const stripped = stripComments(src);
  expect(
    stripped.length,
    'THE DEFECT: the comment blanker consumed a surrogate PAIR and emitted ONE space, so every ' +
      'offset after an emoji is wrong and the length invariant this function promises is false',
  ).toBe(src.length);
  expect(stripped.split('\n').length).toBe(2);
  // …and it is still a comment stripper: the code survives, the comment does not.
  expect(stripped.split('\n')[0]).toBe('const a = 1;' + ' '.repeat(src.split('\n')[0]!.length - 12));
  expect(stripped).toContain('const b = 2;');
  expect(stripped).not.toContain('🛑');
});

test('a commented-out example is NOT counted, but the same line uncommented IS', () => {
  const commented = [
    'const a = 1;',
    '// ⛔ never write ilike(x, `%${q}%`) — use likeTerm',
    '/* ilike(y, `%${q}%`) */',
    "const url = 'https://x.invalid/a'; // trailing comment",
    'const b = 2;',
  ].join('\n');
  expect(wildcardPatternLiterals(stripComments(commented))).toEqual([]);
  expect(looseMixedLiterals(stripComments(commented))).toEqual([]);

  const live = ['const a = 1;', 'or(ilike(x, `%${q}%`));', 'const b = 2;'].join('\n');
  const hits = wildcardPatternLiterals(stripComments(live));
  expect(hits.length, 'the detector is dead if it cannot see the literal it bans').toBe(1);
  expect(hits[0]!.line).toBe(2);

  // The hoisted shape — the one an `ilike(`-on-the-same-line rule would miss entirely.
  const hoisted = ['const like = `%${q}%`;', 'or(ilike(x, like));'].join('\n');
  expect(wildcardPatternLiterals(stripComments(hoisted)).length).toBe(1);
  // …and the ilike-adjacent rule alone would have MISSED it — which is why both rules exist.
  expect(
    looseMixedLiterals(stripComments(hoisted)).filter(
      (h) => stripComments(hoisted).split('\n')[h.line - 1]!.includes('ilike('),
    ),
  ).toEqual([]);

  // A percentage in a human sentence is NOT a pattern (routes/pipeline.ts:540 is exactly this).
  expect(wildcardPatternLiterals('const s = `Staging · ${pct}% canary`;')).toEqual([]);

  // A `//` inside a string must not truncate the line that follows it on the same line.
  const urlThenViolation = "fetch('http://x.invalid'); or(ilike(x, `%${q}%`));";
  expect(wildcardPatternLiterals(stripComments(urlThenViolation)).length).toBe(1);
});

// ---------------------------------------------------------------------------
// The header claims a specific evasion set. A prose claim about a guard's blind spots goes stale
// the moment either rule is tightened, and a reviewer who trusts a stale list hand-checks the
// wrong cases. So the claim is PINNED here, in both directions — the shapes that get through and
// the shapes that do not. Tightening a rule until one of the EVADES rows is caught is a WELCOME
// change; it fails this test, which is the prompt to move the row and update the header.
// ---------------------------------------------------------------------------
function isCaught(code: string): boolean {
  const stripped = stripComments(code);
  if (wildcardPatternLiterals(stripped).length > 0) return true;
  const lines = stripped.split('\n');
  return looseMixedLiterals(stripped).some(
    (h) => lines[h.line - 1]!.includes('ilike(') || lines[h.line - 1]!.includes('ILIKE'),
  );
}

test('the evasion set stated in the header is the evasion set the rules actually have', () => {
  const EVADES: [string, string][] = [
    ['string concatenation', "or(ilike(x, '%' + q + '%'));"],
    ['.concat', "or(ilike(x, '%'.concat(q, '%')));"],
    ['a template split across lines', 'const like = `%${q}\n%`;\nor(ilike(x, like));'],
    ['Array#join', "const like = ['%', q, '%'].join('');\nor(ilike(x, like));"],
    ['a `%` already inside q', 'or(ilike(x, likeTerm(q)));'],
  ];
  const CAUGHT: [string, string][] = [
    ['the inline template', 'or(ilike(x, `%${q}%`));'],
    ['the hoisted template', 'const like = `%${q}%`;\nor(ilike(x, like));'],
    ['String.raw', 'or(ilike(x, String.raw`%${q}%`));'],
    ['a helper INSIDE a scanned file', 'function mk(q) { return `%${q}%`; }\nor(ilike(x, mk(q)));'],
  ];
  const escaped = EVADES.filter(([, code]) => isCaught(code)).map(([n]) => n);
  expect(
    escaped,
    'a shape the header calls an EVASION is now caught — good news, but move it to CAUGHT and ' +
      'fix the header, or the next reviewer hand-checks a case the guard already covers',
  ).toEqual([]);
  const missed = CAUGHT.filter(([, code]) => !isCaught(code)).map(([n]) => n);
  expect(
    missed,
    'a shape the header promises is CAUGHT no longer is — the guard just lost coverage it claims',
  ).toEqual([]);
});

test('no ILIKE pattern is hand-rolled anywhere under src/routes or src/ai', () => {
  const violations: string[] = [];
  for (const f of FILES) {
    for (const h of wildcardPatternLiterals(stripComments(readFileSync(f, 'utf8')))) {
      violations.push(`${relative(SRC, f)}:${h.line}  ${h.text.trim()}`);
    }
  }
  expect(
    violations,
    'a search predicate is interpolating the raw query into an ILIKE pattern — `%` and `_` are ' +
      'metacharacters. Import `likeTerm` from src/utils/search.ts instead.\n' +
      violations.join('\n'),
  ).toEqual([]);
});

test('…and the narrower ilike-adjacent statement of the same rule also holds', () => {
  // The subset the original bug report named: a raw pattern on a line that also calls ILIKE.
  // Kept as its own assertion so the failure message can be specific, and so that narrowing the
  // rule above (should it ever produce a false positive) cannot silently drop this floor.
  const violations: string[] = [];
  for (const f of FILES) {
    const code = stripComments(readFileSync(f, 'utf8'));
    const lines = code.split('\n');
    for (const h of looseMixedLiterals(code)) {
      const line = lines[h.line - 1]!;
      if (line.includes('ilike(') || line.includes('ILIKE')) {
        violations.push(`${relative(SRC, f)}:${h.line}  ${line.trim()}`);
      }
    }
  }
  expect(violations, violations.join('\n')).toEqual([]);
});
