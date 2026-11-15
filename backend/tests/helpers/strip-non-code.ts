// tests/helpers/strip-non-code.ts — remove COMMENTS from TS source, preserving code and string
// literals verbatim.
//
// ⛔ WHY THIS EXISTS. Two ratchets in this suite (`logging-discipline`, `rls-bypass-discipline`)
// scan source text for call sites. A bare regex over raw source ALSO matches the thing being
// discussed in a comment, and this codebase comments heavily and precisely: `runAsSystem (owner
// pool, bypasses RLS)` in prose is indistinguishable from a call to a naive scan, and `console.log`
// is QUOTED in several explanations of why a particular stream is not a log stream.
//
// Measured: scanning raw source reported 9 offending files for the RLS ratchet, every one a false
// positive from prose. A ratchet that cries wolf gets its ceiling raised or gets deleted, so the
// scan has to see only code.
//
// ⚠️ STRING CONTENTS ARE KEPT. The RLS ratchet's whole job is to read the reason LITERAL out of
// `runAsSystem('platform-admin', …)`, so a stripper that blanked string bodies would make it
// report every call as "no literal reason" — which is how the first version of this helper was
// wrong. Comments are the only thing removed. A string-mode state machine is still required, so
// that a `//` inside a string is not mistaken for the start of a comment.
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'tick';
  let mode: Mode = 'code';
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'tick';
      out += c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; i += 2; continue; }
      if (c === '\n') out += '\n'; // keep line numbers roughly aligned for error messages
      i += 1;
      continue;
    }
    // inside a string/template literal — copy through, honouring escapes
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
    if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'tick' && c === '`')) {
      mode = 'code';
    }
    out += c;
    i += 1;
  }
  return out;
}
