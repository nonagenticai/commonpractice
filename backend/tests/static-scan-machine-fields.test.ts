// tests/static-scan-machine-fields.test.ts — the scanner puts the MACHINE FIELDS on the wire, not
// only inside its English sentence. Pure unit, no DB.
//
// ⛔ WHY THIS FILE EXISTS AND WHY IT IS THE ONE THAT CANNOT BE SKIPPED. `/block-edit` no longer
// renders `finding.message`; it renders `scanFindingLabel(finding)`, which builds the reader's
// sentence from the RULE plus these fields (frontend/src/lib/i18n/scan-finding-label.ts). Four of
// the eleven rules interpolate one — `no-require`, `banned-import` and `import-not-allowlisted`
// need `spec`, `syntax` needs `detail` — and each has a deliberate `if (!field) return
// finding.message` branch for the rolling-deploy window when an old backend ships neither.
//
// That branch is what makes this test load-bearing. If the backend silently stopped emitting
// `spec`, the frontend would take the fallback FOREVER: those four findings would render the
// backend's English in all eight locales, and EVERY frontend test would stay green, because
// returning the English is a legitimate, tested behaviour. Nothing on the frontend side can tell
// "mid-roll" from "permanently broken". This side can, and does.
//
// The specifier and the parser text are ALSO still inside `message` — deliberately, byte-identical
// to before this change, because `message` is the fallback. So the assertions below are on the
// FIELDS, never on the sentence.
import { test, expect } from 'bun:test';
import { scanBlockSource } from '../src/exec/static-scan';
import { lintBlock } from '../src/blocks/lint';

/**
 * The widest shape both `ScanFinding` and `LintFinding` satisfy.
 *
 * Declared rather than cast: `as Record<string, unknown>` does not even compile against either
 * interface (no index signature), and `as unknown as …` would silence the compiler on exactly the
 * fields this file exists to check. This way `f.spec` is type-checked all the way down.
 */
type AnyFinding = {
  rule: string;
  message: string;
  source?: string;
  spec?: string;
  detail?: string;
};

/** The one finding for `rule`, or a failure that names what was actually produced. */
function only(findings: readonly AnyFinding[], rule: string): AnyFinding {
  const hit = findings.filter((f) => f.rule === rule);
  expect(hit.length, `expected exactly one \`${rule}\`, got ${findings.map((f) => f.rule).join(', ')}`).toBe(1);
  return hit[0]!;
}

test('no-require ships the module specifier as `spec`', () => {
  const r = scanBlockSource('const fs = require("node:fs");\nexport default {};');
  const f = only(r.findings, 'no-require');
  expect(f.spec).toBe('node:fs');
  // The English sentence is UNCHANGED — it is the mid-roll fallback and must keep working.
  expect(f.message).toContain('node:fs');
});

test('banned-import ships the module specifier as `spec`', () => {
  const r = scanBlockSource('import net from "node:net";\nexport default {};');
  const f = only(r.findings, 'banned-import');
  expect(f.spec).toBe('node:net');
  expect(f.message).toContain('node:net');
});

test('import-not-allowlisted ships the module specifier as `spec`', () => {
  const r = scanBlockSource('import x from "lodash";\nexport default {};');
  const f = only(r.findings, 'import-not-allowlisted');
  expect(f.spec).toBe('lodash');
  expect(f.message).toContain('lodash');
});

test('syntax ships the transpiler text as `detail`, and the catalog can WRAP it', () => {
  const r = scanBlockSource('export default { async run( {{{ ;');
  const f = only(r.findings, 'syntax');
  expect(typeof f.detail).toBe('string');
  expect((f.detail as string).length).toBeGreaterThan(0);
  // ⛔ `detail` is the parser's text ALONE — the frame is the frontend's ("Deze code parseert niet:
  // {detail}"). If `detail` carried the English frame too, the Dutch reader would get BOTH frames.
  expect(f.detail).not.toContain('Source does not parse');
  // …and `message` is still frame + text, byte-identical to before, for the fallback.
  expect(f.message).toBe(`Source does not parse: ${f.detail}`);
});

test('the nine rules with no machine field ship neither — nothing is invented', () => {
  // ⛔ THE OVER-CORRECTION GUARD. "Put `spec` on everything" would satisfy the four tests above and
  // would make the frontend's mid-roll branches unreachable for rules that have nothing to name.
  // ⚠️ NOT ONE QUOTED STRING IN THIS FIXTURE, on purpose and the hard way: `IMPORT_RE` is
  // `/\bimport\b[^'"]*['"]([^'"]+)['"]/`, so ANY quoted literal anywhere after the word `import`
  // becomes a "specifier" and adds an `import-not-allowlisted`. That is a real (if sloppy)
  // behaviour of the scanner, but it is not the one under test here, and the first draft of this
  // case tripped over it.
  //
  // ⚠️ `new Function(` and `globalThis[` JOINED THIS FIXTURE WITH THE GATE. They are the two escapes
  // that reached eval-equivalent power without the token `eval`, and they were added to
  // `AMBIENT_GLOBALS` when the scan stopped being advisory. They carry no machine field either, so
  // they belong to exactly this over-correction guard.
  const r = scanBlockSource(
    'export default { async run(mod){ eval(String(mod)); await fetch(mod); const s = new WebSocket(mod); const x = XMLHttpRequest; process.env; Bun.connect(); await import(mod); const f = new Function(mod); const g = globalThis[mod]; } };',
  );
  const seen = r.findings.map((f) => f.rule).sort();
  expect(seen).toEqual(
    ['no-bun-socket', 'no-computed-global', 'no-dynamic-import', 'no-eval', 'no-fetch', 'no-function-constructor', 'no-process', 'no-websocket', 'no-xhr'].sort(),
  );
  for (const f of r.findings as AnyFinding[]) {
    expect(f.spec, `${f.rule} invented a \`spec\``).toBeUndefined();
    expect(f.detail, `${f.rule} invented a \`detail\``).toBeUndefined();
  }
});

test('⛔ lintBlock FORWARDS `spec` and `detail` onto the wire shape the browser reads', () => {
  // The scanner is not what /block-edit calls — `POST /api/blocks/:slug/versions/:v/lint` returns
  // `lintBlock`'s findings, which are rebuilt FIELD BY FIELD from the scan findings. A forward that
  // drops a field is invisible to every test above and puts the browser back on English forever.
  const r = lintBlock('import net from "node:net";\nconst fs = require("node:fs");\nexport default {};');
  const banned = only(r.findings, 'banned-import');
  const req = only(r.findings, 'no-require');
  expect(banned.source).toBe('scan');
  expect(banned.spec).toBe('node:net');
  expect(req.spec).toBe('node:fs');
}, 30_000);

test('⛔ lintBlock forwards `detail` too, and leaves the `type` half untouched', () => {
  // The other half of the design: `source: 'type'` findings carry tsc's OWN English in `message`
  // and are NOT translated. This pins that they still arrive with `source: 'type'` and a `TS####`
  // rule, which is the discriminant `scanFindingLabel` branches on before anything else.
  const r = lintBlock('export default { async run( {{{ ;');
  const syntax = only(r.findings, 'syntax');
  expect(syntax.source).toBe('scan');
  expect(typeof syntax.detail).toBe('string');

  const typed = lintBlock(`export default {
  descriptor: { inputs: {}, outputs: {}, capabilities: {} },
  async run(inputs, ctx) { const x: number = "not a number"; return { x }; }
};`);
  const t = typed.findings.filter((f) => f.source === 'type');
  expect(t.length, 'no type finding at all — this case would prove nothing').toBeGreaterThan(0);
  expect(t[0]!.rule).toMatch(/^TS\d+$/);
  expect(t[0]!.message.length).toBeGreaterThan(0);
  // A type finding has no machine fields to forward; inventing them would send the frontend into
  // the rule switch with fields that mean nothing.
  expect((t[0]! as AnyFinding).spec).toBeUndefined();
  expect((t[0]! as AnyFinding).detail).toBeUndefined();
}, 60_000);
