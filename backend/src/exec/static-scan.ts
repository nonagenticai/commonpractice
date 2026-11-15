// src/exec/static-scan.ts
// Save-time static analysis for block source — the minimal v1 seed of SPEC §5's
// sandbox rails. It enforces, before a draft is written or run, that a block only
// imports the SDK and never reaches for network / process / dynamic-eval escape
// hatches. Best-effort regex + transpile, not a security boundary.
//
// ⛔ THIS FUNCTION IS NOW A HARD GATE (blocks/source-gate.ts), NOT AN ADVISORY REPORT.
// Until this change it ran at PUBLISH only, so a false positive cost the author a confusing
// publish error. It now runs on every draft write and every draft run.
//
// ⛔⛔ EVERY RULE MATCHES A PARSED PROJECTION, NEVER THE RAW TEXT — AND THE PARSER IS NOT OPTIONAL.
// Two code paths in this product GENERATE block source by interpolating USER-CONTROLLED ENGLISH
// into the generated file, and the raw regexes flagged that English. Measured on main, through the
// real generators, not on hand-written fixtures:
//
//   ontology/data-block-compiler.ts compileDataBlock() — an attribute `description` lands inside
//   `JSON.stringify(descriptor)` in the emitted source:
//     description 'Set on import from the broker feed.'   -> import-not-allowlisted
//     description 'Populated by the nightly fetch() job.'  -> no-fetch
//     description 'Do not eval() this value.'              -> no-eval
//     a dataset COLUMN named `import "x"`                  -> import-not-allowlisted
//
//   db/seed-templates.ts renderSource() — a template step `detail` lands verbatim in a
//   `// N. label: detail` comment:
//     detail 'Call the nightly fetch() job here.'          -> no-fetch
//     detail 'Never eval() untrusted input.'               -> no-eval
//
// `deriveDataBlock` ALREADY calls `lintBlock` and throws `derived_lint_failed`, so this is a LIVE
// defect on main, not a hypothetical: a tenant whose ontology attribute description contains the
// word "import" cannot derive a data block at all. Widening the scan to `createTemplate` and to
// every draft save and every draft run — which is what this workstream does — would turn ordinary
// English prose into hard 422s across a dozen more call sites.
//
// ⛔ AND IT MUST BE A REAL PARSER, NOT A HAND-ROLLED MASKER. A previous attempt shipped a
// left-to-right state machine over the raw text. It produced SEVEN distinct false negatives across
// four mechanisms — all of them in the dangerous direction, all of them silent, because the machine
// still reported itself reliable so the raw fallback never fired:
//
//   const APOS = /(\w)'(\w)/g; const leak = eval("2+2"); const DASH = '-';   machine:[] real:[no-eval]
//   const R = /it's/g; const fs = require('node:fs');                       machine:[] real:[no-require]
//
// A bare `ts.createScanner()` does not fix it either: without the parser's `reScanSlashToken` the
// scanner cannot tell a regex literal from division and reproduces the same misses. `maskNonCode`
// below therefore runs `ts.createSourceFile` — the same `typescript` dependency `blocks/type-check.ts`
// already uses. It is HOST-ONLY: `static-scan.ts` is imported by `blocks/lint.ts` and
// `blocks/source-gate.ts` and by nothing the runner bundles, which keeps using `Bun.Transpiler`.
//
// ⛔ FAIL SAFE, IN THE FALSE-POSITIVE DIRECTION. If the parse throws, reports diagnostics, or the
// projection fails its own length/newline invariant, the mask is DISCARDED and the rules run on the
// RAW source. Over-reporting costs an author a confusing refusal; under-reporting lets banned code
// run. `scanBlockSource` reports the unparseable case as `syntax` anyway.

import ts from 'typescript';

export interface ScanFinding {
  rule: string;
  /**
   * The ENGLISH sentence, kept byte-identical on purpose.
   *
   * ⛔ IT IS NOT THE THING THE READER SEES ANY MORE — it is the FALLBACK. The browser owns the
   * words (frontend/src/lib/i18n/scan-finding-label.ts renders `rule` + the machine fields below
   * into the reader's locale, same split as `data-finding-label.ts`). This string stays because
   * the Service load-balances a new frontend onto an OLD backend for the length of a rolling
   * deploy, and because a rule shipped backend-first must degrade to a readable sentence instead
   * of vanishing.
   */
  message: string;
  /** 1-based line number when locatable. */
  line?: number;
  /**
   * The module specifier the finding is about — `no-require`, `banned-import`,
   * `import-not-allowlisted`.
   *
   * On the wire as its own field rather than only inside `message`, because the localized sentence
   * has to interpolate it and no browser can extract it back out of an English sentence. Absent
   * for every rule that is not about an import.
   */
  spec?: string;
  /**
   * The transpiler's OWN error text, for `syntax`.
   *
   * ⛔ THE CATALOG ENTRY WRAPS THIS, IT DOES NOT REPLACE IT. Bun's parser message is an unbounded
   * English vocabulary that cannot be translated; what CAN be translated is the frame around it
   * ("Deze code parseert niet: {detail}"). Same reason `lint.ts` hands tsc diagnostics straight
   * through.
   */
  detail?: string;
}

export interface ScanResult {
  ok: boolean;
  findings: ScanFinding[];
}

// Only these module specifiers may be imported by block source. The SDK is the
// single capability surface (ctx); everything else is ambient and forbidden.
const IMPORT_ALLOWLIST = new Set([
  './sdk',
  '../sdk',
  '@commonpractice/sdk',
  'commonpractice',
]);

// Banned bare-module / node-builtin specifiers (matched as a prefix).
const BANNED_MODULE_PREFIXES = [
  'node:net',
  'node:dgram',
  'node:tls',
  'node:http',
  'node:https',
  'node:child_process',
  'node:fs',
  'node:dns',
  'node:cluster',
  'node:worker_threads',
  'node:vm',
  'bun:',
];

// ⚠️ THE `d` FLAG IS LOAD-BEARING, NOT DECORATION, AND SO IS `*` INSTEAD OF `+`. These two run
// against the MASKED projection, where a module specifier's characters are BLANKS — so the capture
// group's TEXT is useless and only its OFFSETS are. `rawSpec()` slices the specifier back out of the
// RAW source at `match.indices[1]`, which is exact because `maskNonCode` is length-preserving.
// Without `d` there is no per-group offset in JS. `*` because a masked empty specifier (`import x
// from ""`) is a zero-length run of blanks, which `+` would refuse.
const IMPORT_RE = /\bimport\b[^'"]*['"]([^'"]*)['"]/gd;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]*)['"]\s*\)/gd;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(/g;

// ⛔⛔ `ctx.fetch()` WAS FLAGGED BY THE RULE WHOSE MESSAGE TOLD YOU TO CALL IT.
// `no-fetch` read "Use ctx-provided fetch (network capability), not global fetch." and its regex was
// `\bfetch\s*\(` — `\b` matches between `.` and `f`, so ANY member call named `fetch` tripped it,
// `ctx.fetch(` included. The lookbehind is what distinguishes the ambient global from a member.
//
// ⚠️ AND THE MESSAGE ITSELF WAS FALSE. There is no `ctx.fetch`. `BlockContext` (exec/sdk.ts)
// declares exactly `llm, mockData, dataset, log, signal`, and `exec/runner-entry.ts` injects
// `{loadBlock, llm, mockData, dataset, emit, now}`. `capabilities.network` (db/block-types.ts) is
// read in ONE place — `host/run-policy.ts`, which uses it to REFUSE a run when
// `models.external_http` is off — and nothing anywhere implements it. Verified by grepping the whole
// repo (backend, frontend, seed JSON, templates) for `ctx.fetch`: zero hits. So the sentence told an
// author to call a capability that does not exist. It now says what is true: blocks have no network.
//
// `globalThis.fetch(` is the obvious escape from the lookbehind and is matched explicitly.
// `window`/`self` are NOT in the alternation on purpose: both are ordinary local identifier names in
// hand-written code (`const self = this`), so matching them would reintroduce exactly the
// member-access false positive the lookbehind exists to remove.
const NOT_MEMBER = String.raw`(?<![.\w$])`;
const VIA_GLOBAL_THIS = String.raw`\bglobalThis\s*\??\.\s*`;

// ⛔ NO `g` FLAG ON ANY OF THESE. `scanBlockSource` uses a single-shot `.exec` per rule (one finding
// per rule, by design). A `g` flag would carry `lastIndex` across calls on these module-level
// RegExp objects, so the SECOND source scanned in a process would start matching from wherever the
// first one stopped — a silent, order-dependent false negative that needs an explicit
// `re.lastIndex = 0` to compensate. Don't create the need.
//
// Ambient capabilities that are simply not available to a block.
const AMBIENT_GLOBALS: { rule: string; re: RegExp; message: string }[] = [
  {
    rule: 'no-fetch',
    re: new RegExp(`${NOT_MEMBER}fetch\\s*\\(|${VIA_GLOBAL_THIS}fetch\\s*\\(`),
    message: 'Blocks have no network capability; fetch() is not available in the sandbox.',
  },
  { rule: 'no-websocket', re: /\bnew\s+WebSocket\b/, message: 'WebSocket is not available in the sandbox.' },
  {
    rule: 'no-xhr',
    re: new RegExp(`${NOT_MEMBER}XMLHttpRequest\\b|${VIA_GLOBAL_THIS}XMLHttpRequest\\b`),
    message: 'XMLHttpRequest is not available in the sandbox.',
  },
  { rule: 'no-process', re: /\bprocess\s*\.\s*(env|exit|binding)\b/, message: 'process.env/exit/binding is not accessible to blocks.' },
  { rule: 'no-bun-socket', re: /\bBun\s*\.\s*(connect|listen)\b/, message: 'Bun.connect/listen is not available in the sandbox.' },
  {
    // ⛔ THE INDIRECT FORM IS THE SAME RULE, NOT A NEW ONE. `(0, eval)('…')` is eval with a
    // different `this` — the message "eval() is forbidden" is exactly right for it, so folding it in
    // as an alternative costs no catalog key and tells the author the truth.
    rule: 'no-eval',
    // ⛔ `\s*\??\s*\(` — NOT decoration. A fresh verifier EXECUTED `eval?.("2+2")` through the live
    // routes on both trees: optional-call syntax is one character away from `eval(` and walked past
    // a rule whose whole claim is that eval is banned at save time. Measured 0/44 on the shipped
    // corpus, so closing it is free. The tagged-template form ``eval`2+2` `` is closed by the
    // no-backtick alternative below.
    re: new RegExp(
      `${NOT_MEMBER}eval\\s*(?:\\?\\.)?\\s*[(\`]|${VIA_GLOBAL_THIS}eval\\s*(?:\\?\\.)?\\s*[(\`]|\\(\\s*0\\s*,\\s*eval\\s*\\)`,
    ),
    message: 'eval() is forbidden, including the indirect (0, eval)(…) form.',
  },
  {
    // ⛔ ADDED WITH THE GATE, AND ONLY BECAUSE OF IT. `new Function('return process')()` is eval
    // under another name and was missed by every version of this scanner. That was tolerable while
    // the scan was ADVISORY — a rule nobody enforced. It is not tolerable once
    // `models.code_exec_outside_blocks` is classified `enforced`: "arbitrary code/eval is banned at
    // save time" should not have a one-token spelling that walks past it. Measured against all 47
    // sources this product ships: 0 hits, so it costs nothing today.
    //
    // ⚠️ AND THE HONEST BOUND, because the sentence above is weaker than it reads. These were
    // EXECUTED through the live routes by an adversarial verifier and are still missed, here and on
    // main: `eval("2+2")` (unicode-escaped identifier),
    // `Reflect.get(globalThis,"eval")("2+2")`, and `(()=>{}).constructor("return process")()`.
    // `eval?.(` and ``eval`…` `` WERE closed (see the no-eval rule above) because they are a
    // one-character edit; these three cannot be closed by any identifier regex and need a real AST
    // walk over the parsed source — which `maskNonCode` already produces, so the seam exists.
    // Until then this rail catches the ordinary spellings, not a determined author.
    rule: 'no-function-constructor',
    re: new RegExp(`${NOT_MEMBER}new\\s+Function\\s*\\(`),
    message: 'new Function(...) compiles a string into code, exactly like eval(); it is forbidden.',
  },
  {
    // ⛔ THE ONE THAT DEFEATS EVERY IDENTIFIER RULE ABOVE. `globalThis['ev'+'al']('…')` reaches eval
    // without the token `eval` appearing at all, and the same trick reaches `fetch`, `process` and
    // anything else the host happens to leave on the global object. No identifier regex can see it,
    // so the ACCESS FORM is banned instead of the name. Also 0/44 on the shipped corpus.
    rule: 'no-computed-global',
    re: /\bglobalThis\s*(\?\.)?\s*\[/,
    message: 'globalThis[...] computed access is forbidden; it hides which capability is reached for.',
  },
];

/**
 * Blank the CONTENTS of every comment, string, template chunk and regex literal — using TypeScript's
 * own parser, which is the only thing in this process that can tell `/re/` from division.
 *
 * Returns a projection the SAME LENGTH as the input; every masked character becomes a space except
 * `\n`, which is kept so `lineOf()` counts identically. That equality is the whole contract: a match
 * offset in the projection is a valid offset in the original, so line numbers stay exact and a module
 * specifier can be sliced back out of the raw source (see IMPORT_RE).
 *
 * ⛔ INTERIORS ONLY — THE DELIMITERS SURVIVE. `import x from "node:fs"` masks to
 * `import x from "       "`, which still matches IMPORT_RE (the raw slice is what gets reported). A
 * COMMENT saying the same thing masks to `//                       ` and matches nothing, because a
 * comment has no quotes to survive. Same for template chunks: `TemplateHead`/`Middle`/`Tail` are
 * masked but the `${…}` EXPRESSIONS between them are ordinary nodes and are left completely alone,
 * so `` `${eval('x')}` `` is still flagged.
 *
 * ⛔ `endOfFileToken` IS VISITED EXPLICITLY, AND THAT IS A MEASURED BUG FIX, NOT A FLOURISH.
 * `ts.forEachChild(sourceFile, …)` does NOT visit it, and a comment sitting after the last statement
 * is that token's leading trivia — so `const x = 1; /* fetch( *\/` kept its `fetch(` in the
 * projection and was flagged. Pinned in tests/block-source-gate.test.ts §1.
 *
 * `reliable: false` means the projection must NOT be trusted: the parser threw, or it reported parse
 * diagnostics (a source it could not model, so its node positions are guesses), or the projection
 * broke its own length/newline invariant. The caller then scans the RAW source — over-reporting,
 * which is the recoverable direction.
 */
export function maskNonCode(src: string): { masked: string; reliable: boolean } {
  const raw = { masked: src, reliable: false };
  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile('block.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  } catch {
    return raw;
  }
  // ⛔ A SOURCE THE PARSER COULD NOT MODEL GETS NO MASK. `parseDiagnostics` is how `createSourceFile`
  // reports that it recovered from an error rather than understood the file; every node position
  // downstream of the error is then a guess, and a guess that blanks real code is the exact
  // false-negative class this module exists to avoid. `scanBlockSource` reports it as `syntax`
  // regardless, so nothing is lost by scanning it raw.
  const diags = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics;
  if (Array.isArray(diags) && diags.length > 0) return raw;

  const out = src.split('');
  const blank = (from: number, to: number): void => {
    for (let k = Math.max(0, from); k < Math.min(to, out.length); k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  // ⛔ LEADING **AND** TRAILING, AND THAT IS A MEASURED FIX. TypeScript classifies a comment on the
  // SAME LINE as the code before it as a TRAILING comment of that code, not a leading comment of what
  // follows — so `ts.getLeadingCommentRanges(src, 12)` on `const x = 1; /* fetch( */` returns
  // `undefined` and the comment kept its `fetch(` in the projection. Both directions are collected at
  // every node boundary; a node's trivia is re-read by each child that shares it, so `doneComments`
  // makes the double-visiting free.
  const doneComments = new Set<number>();
  const blankCommentsAt = (pos: number): void => {
    for (const ranges of [ts.getLeadingCommentRanges(src, pos), ts.getTrailingCommentRanges(src, pos)]) {
      if (!ranges) continue;
      for (const r of ranges) {
        if (doneComments.has(r.pos)) continue;
        doneComments.add(r.pos);
        blank(r.pos + 2, r.end); // keep `//` / `/*`; everything after it is content
      }
    }
  };

  const visit = (node: ts.Node): void => {
    blankCommentsAt(node.getFullStart());
    blankCommentsAt(node.getEnd());
    switch (node.kind) {
      case ts.SyntaxKind.StringLiteral:
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      case ts.SyntaxKind.RegularExpressionLiteral:
      case ts.SyntaxKind.TemplateHead:
      case ts.SyntaxKind.TemplateMiddle:
      case ts.SyntaxKind.TemplateTail:
        blank(node.getStart(sf) + 1, node.getEnd() - 1);
        break;
      default:
        break;
    }
    ts.forEachChild(node, visit);
  };

  try {
    ts.forEachChild(sf, visit);
    // ⛔ `ts.forEachChild(sourceFile, …)` DOES NOT VISIT `endOfFileToken`, so a comment after the last
    // statement belongs to a node the walk never reaches. Measured: `const x = 1; /* fetch( */` was
    // flagged `no-fetch`. Pinned in tests/block-source-gate.test.ts §1c.
    blankCommentsAt(sf.endOfFileToken.getFullStart());
  } catch {
    return raw;
  }

  const masked = out.join('');
  // The invariant the offset arithmetic rests on, asserted rather than assumed.
  if (masked.length !== src.length) return raw;
  for (let k = 0; k < src.length; k++) {
    if ((src[k] === '\n') !== (masked[k] === '\n')) return raw;
  }
  return { masked, reliable: true };
}

function lineOf(src: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

/**
 * The specifier as the AUTHOR wrote it: sliced from the RAW source at the match's group offsets.
 *
 * The rules match the masked projection, where the specifier is blanks. `maskNonCode` is
 * length-preserving, so the group's offsets are valid in the raw source too. Falls back to `m[1]`
 * for the unreliable-mask path, where the "projection" IS the raw source and the two agree.
 */
function rawSpec(src: string, m: RegExpExecArray | RegExpMatchArray): string {
  const at = (m as RegExpMatchArray & { indices?: Array<[number, number] | undefined> }).indices?.[1];
  return at ? src.slice(at[0], at[1]) : (m[1] ?? '');
}

export function scanBlockSource(source: string): ScanResult {
  const findings: ScanFinding[] = [];
  const src = source ?? '';
  // ⛔ EVERY RULE BELOW READS `scanned`, NEVER `src`. When the parser could not model the file the
  // projection IS the raw source (`reliable: false`), i.e. the module degrades to false positives.
  // Line numbers and specifier offsets are identical either way — `maskNonCode` is length-preserving.
  const { masked: scanned } = maskNonCode(src);

  // 1. Static imports must be on the allowlist.
  for (const m of scanned.matchAll(IMPORT_RE)) {
    flagSpecifier(rawSpec(src, m), m.index ?? 0, src, findings);
  }
  // 2. require(...) — banned outright (ESM-only) but report the specifier too.
  for (const m of scanned.matchAll(REQUIRE_RE)) {
    const spec = rawSpec(src, m);
    findings.push({
      rule: 'no-require',
      message: `require('${spec}') is not allowed; use ESM import of the SDK only.`,
      line: lineOf(src, m.index ?? 0),
      spec,
    });
  }
  // 3. Dynamic import().
  for (const m of scanned.matchAll(DYNAMIC_IMPORT_RE)) {
    findings.push({
      rule: 'no-dynamic-import',
      message: 'Dynamic import() is forbidden.',
      line: lineOf(src, m.index ?? 0),
    });
  }
  // 4. Ambient capability globals.
  for (const g of AMBIENT_GLOBALS) {
    const m = g.re.exec(scanned);
    if (m) findings.push({ rule: g.rule, message: g.message, line: lineOf(src, m.index) });
  }
  // 5. Must transpile (syntactically valid TS).
  try {
    new Bun.Transpiler({ loader: 'ts' }).transformSync(src);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    findings.push({
      rule: 'syntax',
      message: `Source does not parse: ${detail}`,
      detail,
    });
  }

  return { ok: findings.length === 0, findings };
}

function flagSpecifier(
  spec: string,
  index: number,
  src: string,
  findings: ScanFinding[],
): void {
  if (IMPORT_ALLOWLIST.has(spec)) return;
  const banned = BANNED_MODULE_PREFIXES.some((p) => spec === p || spec.startsWith(p));
  if (banned) {
    findings.push({
      rule: 'banned-import',
      message: `Import of '${spec}' is forbidden in the sandbox.`,
      line: lineOf(src, index),
      spec,
    });
    return;
  }
  findings.push({
    rule: 'import-not-allowlisted',
    message: `Import of '${spec}' is not allowed; blocks may only import the Common Practice SDK.`,
    line: lineOf(src, index),
    spec,
  });
}
