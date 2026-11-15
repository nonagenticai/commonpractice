// tests/gen-template-i18n-drift.test.ts — the execution path for `gen-template-i18n.ts --check`.
//
// ⛔ WHY THIS FILE EXISTS. `migrations/0079_template_i18n.sql` is GENERATED from
// `src/templates/seed/i18n/*.json`, and `scripts/gen-template-i18n.ts --check` exists to prove the
// committed SQL still matches that JSON. It was wired into NOTHING: not `.github/workflows/`, not
// `package.json`, not a test. A `--check` nobody runs is a comment. So editing a translation —
// which is the ONE thing this content is expected to receive, repeatedly, from reviewers who read
// the language — left 0079 silently stale, and the stale half is the half that reaches production:
// `seedTemplateTranslations()` writes from the JSON on a fresh boot, the migration writes from the
// SQL on an existing cluster, and the two would disagree with no symptom anywhere.
//
// This gives it the cheapest honest path: it rides the `bun test` gate the backend job already
// runs, so no workflow edit and no new CI minute.
//
// ⛔ AND IT CARRIES ITS OWN NEGATIVE CONTROL. A `--check` that exits 0 is worth exactly as much as
// the proof that it can exit non-zero, and "the script ran and said fine" is satisfiable by a
// script that compares nothing. The second case therefore stages a COPY of the generator over a
// MUTATED copy of 0079 and requires the real refusal. It mutates only files under a temp
// directory — never the tracked tree — so a killed run cannot leave the repo perturbed.
import { test, expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BACKEND = join(import.meta.dir, '..');
const SCRIPT = join(BACKEND, 'scripts', 'gen-template-i18n.ts');
const MIGRATION = join(BACKEND, 'migrations', '0079_template_i18n.sql');

function check(scriptPath: string): { code: number; out: string } {
  const p = Bun.spawnSync(['bun', 'run', scriptPath, '--check'], {
    cwd: BACKEND,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: p.exitCode,
    out: new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr),
  };
}

test('0079_template_i18n.sql is byte-identical to what the seed JSON generates today', () => {
  const r = check(SCRIPT);
  expect(
    r.code,
    `0079_template_i18n.sql has DRIFTED from src/templates/seed/i18n/*.json — re-run ` +
      `\`bun run scripts/gen-template-i18n.ts\` and commit the result:\n${r.out}`,
  ).toBe(0);
  expect(r.out).toContain('0079_template_i18n.sql is up to date');

  // ⛔ NOT VACUOUS ON THE COUNT EITHER. `--check` short-circuits to exit 1 on zero rows, but it
  // would still print "up to date" for a generator that produced a handful. The row count it
  // reports is cross-checked against the VALUES lines in the COMMITTED file, so the two sides have
  // to agree about how much content is actually there.
  const reported = Number(/up to date \((\d+) rows\)/.exec(r.out)?.[1] ?? '0');
  const committed = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith("  ('block_template',")).length;
  expect(committed, 'the committed migration has no VALUES rows to compare against').toBeGreaterThan(0);
  expect(reported, 'the row count --check reports does not match the committed migration').toBe(committed);
});

test('⛔ NEGATIVE CONTROL: --check refuses a 0079 that is one byte off the generated output', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-i18n-drift-'));
  try {
    // A tree the generator resolves the SAME WAY it resolves the real one: it reads
    // `../src/templates/…` and writes/compares `../migrations/0079_template_i18n.sql` relative to
    // its own file. `src` is a symlink to the real sources, so the GENERATED side is byte-for-byte
    // what the real run produces; only the COMMITTED side is perturbed.
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'migrations'));
    symlinkSync(join(BACKEND, 'src'), join(root, 'src'));
    copyFileSync(SCRIPT, join(root, 'scripts', 'gen-template-i18n.ts'));

    const staged = join(root, 'migrations', '0079_template_i18n.sql');
    const original = readFileSync(MIGRATION, 'utf8');

    // Sanity: the staged tree reproduces the real verdict before it is perturbed. Without this,
    // a staging mistake (wrong path, unreadable src) would produce the same exit 1 as real drift
    // and the case would pass for the wrong reason.
    writeFileSync(staged, original, 'utf8');
    const clean = check(join(root, 'scripts', 'gen-template-i18n.ts'));
    expect(clean.code, `the staged tree does not reproduce a clean check:\n${clean.out}`).toBe(0);

    // The perturbation: one translated value, one character. This is the shape of a real edit —
    // someone fixing a Dutch string in the JSON and not regenerating — inverted so that the tracked
    // JSON is never touched.
    const idx = original.indexOf("  ('block_template',");
    expect(idx, 'no VALUES row found to perturb').toBeGreaterThan(-1);
    const pos = original.indexOf('\n', idx) - 4;
    const ch = original[pos] === 'x' ? 'y' : 'x';
    const perturbed = original.slice(0, pos) + ch + original.slice(pos + 1);
    expect(perturbed, 'the perturbation changed nothing').not.toBe(original);
    writeFileSync(staged, perturbed, 'utf8');

    const r = check(join(root, 'scripts', 'gen-template-i18n.ts'));
    expect(r.code, `--check accepted a perturbed 0079 — it is not comparing:\n${r.out}`).toBe(1);
    expect(r.out).toContain('is stale');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
