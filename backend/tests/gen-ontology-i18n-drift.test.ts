// tests/gen-ontology-i18n-drift.test.ts — the execution path for `gen-ontology-i18n.ts --check`,
// modelled on tests/gen-template-i18n-drift.test.ts.
//
// ⛔ WHY THIS FILE EXISTS. `migrations/0080_ontology_i18n.sql` is GENERATED from
// `src/ontology/i18n-seed.ts`, and `--check` exists to prove the committed SQL still matches that
// content. A `--check` nobody runs is a comment. And this content is expected to receive edits
// repeatedly — every relation label still missing today is a future edit by someone who reads the
// language — so a stale migration is the DEFAULT outcome, not an edge case. The stale half is
// also the half that reaches production: `seedOntologyI18n()` writes from the TS on a fresh boot,
// the migration writes from the SQL on an existing cluster, and the two would disagree with no
// symptom anywhere (a wrong or missing translation and an absent row look identical to the
// reader — both fall back to English).
//
// It rides the `bun test` gate the backend job already runs: no workflow edit, no new CI minute.
//
// ⛔ AND IT CARRIES ITS OWN NEGATIVE CONTROL. A `--check` that exits 0 is worth exactly as much as
// the proof that it can exit non-zero, and "the script ran and said fine" is satisfiable by a
// script that compares nothing. The second case stages a COPY of the generator over a MUTATED copy
// of 0080 and requires the real refusal. It mutates only files under a temp directory — never the
// tracked tree — so a killed run cannot leave the repo perturbed.
//
// NOTE: no database. The builder and the generator are pure functions over the repo's own files.
import { test, expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildOntologyI18nRows, canonicalOntologyKeys, ONTOLOGY_LOCALES } from '../src/ontology/i18n-seed';

const BACKEND = join(import.meta.dir, '..');
const SCRIPT = join(BACKEND, 'scripts', 'gen-ontology-i18n.ts');
const MIGRATION = join(BACKEND, 'migrations', '0080_ontology_i18n.sql');
/** The VALUES-row prefix of every generated line. All three ontology entity_types start with it. */
const ROW_PREFIX = "  ('ontology_";

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

test('0080_ontology_i18n.sql is byte-identical to what src/ontology/i18n-seed.ts generates today', () => {
  const r = check(SCRIPT);
  expect(
    r.code,
    `0080_ontology_i18n.sql has DRIFTED from src/ontology/i18n-seed.ts — re-run ` +
      `\`bun run scripts/gen-ontology-i18n.ts\` and commit the result:\n${r.out}`,
  ).toBe(0);
  expect(r.out).toContain('0080_ontology_i18n.sql is up to date');

  // ⛔ NOT VACUOUS ON THE COUNT EITHER. `--check` exits 1 on zero rows, but it would still print
  // "up to date" for a generator that produced a handful. The row count it reports is
  // cross-checked against the VALUES lines in the COMMITTED file, so the two sides have to agree
  // about how much content is actually there.
  const reported = Number(/up to date \((\d+) rows\)/.exec(r.out)?.[1] ?? '0');
  const committed = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith(ROW_PREFIX)).length;
  expect(committed, 'the committed migration has no VALUES rows to compare against').toBeGreaterThan(0);
  expect(reported, 'the row count --check reports does not match the committed migration').toBe(committed);
});

test('⛔ NEGATIVE CONTROL: --check refuses an 0080 that is one byte off the generated output', () => {
  const root = mkdtempSync(join(tmpdir(), 'cp-onto-i18n-drift-'));
  try {
    // A tree the generator resolves the SAME WAY it resolves the real one: it reads
    // `../src/ontology/i18n-seed` and compares `../migrations/0080_ontology_i18n.sql` relative to
    // its own file. `src` is a symlink to the real sources, so the GENERATED side is byte-for-byte
    // what a real run produces; only the COMMITTED side is perturbed.
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'migrations'));
    symlinkSync(join(BACKEND, 'src'), join(root, 'src'));
    copyFileSync(SCRIPT, join(root, 'scripts', 'gen-ontology-i18n.ts'));

    const staged = join(root, 'migrations', '0080_ontology_i18n.sql');
    const original = readFileSync(MIGRATION, 'utf8');

    // Sanity: the staged tree reproduces the real verdict BEFORE it is perturbed. Without this, a
    // staging mistake (wrong path, unreadable src) would produce the same exit 1 as real drift and
    // the case would pass for the wrong reason.
    writeFileSync(staged, original, 'utf8');
    const clean = check(join(root, 'scripts', 'gen-ontology-i18n.ts'));
    expect(clean.code, `the staged tree does not reproduce a clean check:\n${clean.out}`).toBe(0);

    // The perturbation: one translated value, one character, INSIDE the dollar-quoted prose. That
    // is the shape of the real edit this guards — someone correcting a Dutch label and not
    // regenerating — inverted so the tracked content is never touched.
    const idx = original.indexOf(ROW_PREFIX);
    expect(idx, 'no VALUES row found to perturb').toBeGreaterThan(-1);
    const lineEnd = original.indexOf('\n', idx);
    const pos = original.indexOf('$t$', idx) + 3;
    expect(pos, 'no dollar-quoted value on the first VALUES row').toBeGreaterThan(idx);
    expect(pos, 'the dollar quote is not on the first VALUES row').toBeLessThan(lineEnd);
    const ch = original[pos] === 'x' ? 'y' : 'x';
    const perturbed = original.slice(0, pos) + ch + original.slice(pos + 1);
    expect(perturbed, 'the perturbation changed nothing').not.toBe(original);
    writeFileSync(staged, perturbed, 'utf8');

    const r = check(join(root, 'scripts', 'gen-ontology-i18n.ts'));
    expect(r.code, `--check accepted a perturbed 0080 — it is not comparing:\n${r.out}`).toBe(1);
    expect(r.out).toContain('is stale');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------

test('⛔ the relation coverage gate PASSES on its own merits — all 60 keys, all 7 locales', () => {
  const canonical = canonicalOntologyKeys();

  // The gate defaults to ON, so this call is already gated. If a seeded edge loses its label the
  // build fails here rather than shipping an English predicate into a Dutch graph.
  const rows = buildOntologyI18nRows();
  expect(rows.length).toBeGreaterThan(0);

  // The expansion is the load-bearing part: 30 seeded edges, 15 of them generic-layer, fanned
  // across 3 industries = 60 keys. A collapsed expansion (the bug the design exists to prevent)
  // would show up as a much smaller number here rather than as English edges on two verticals.
  expect(canonical.industries).toEqual(['banking', 'healthcare', 'insurance']);
  expect(canonical.relations.size, 'the compile-industry expansion produced the wrong key count').toBe(60);

  const relRows = rows.filter((r) => r.entityType === 'ontology_relation');
  expect(relRows.length, '60 canonical keys x 7 non-en locales').toBe(420);
  // Every canonical key, in every locale — asserted directly rather than trusting the count, which
  // 61 keys in 6 locales would also satisfy.
  const have = new Set(relRows.map((r) => `${r.entityId} ${r.locale}`));
  const gaps: string[] = [];
  for (const key of canonical.relations) {
    for (const locale of ONTOLOGY_LOCALES) if (!have.has(`${key} ${locale}`)) gaps.push(`${key} ${locale}`);
  }
  expect(gaps, `relation labels missing: ${gaps.slice(0, 10).join(', ')}`).toEqual([]);
});

test('⛔ NEGATIVE CONTROL: the coverage gate still REFUSES an untranslated edge', () => {
  // ⛔ WITHOUT THIS THE CASE ABOVE IS DECORATION. "The gate did not throw" is satisfied by a gate
  // that cannot throw, and a gate that cannot throw is exactly what this file exists to prevent —
  // the whole defect was 17 English edges that nothing complained about. So: add ONE canonical
  // relation key that no entry translates, which is precisely what adding a 61st edge to
  // src/ontology/seed/*.json would do, and require the refusal.
  const real = canonicalOntologyKeys();
  const withExtraEdge = {
    ...real,
    relations: new Set([...real.relations, 'banking:Account->Ledger:reconciledWith']),
  };

  let thrown: Error | null = null;
  try {
    buildOntologyI18nRows({ canonical: withExtraEdge });
  } catch (e) {
    thrown = e as Error;
  }
  expect(
    thrown,
    'the coverage gate accepted an untranslated relation key — it is not gating, and the 17 ' +
      'English edges on the Dutch graph can come straight back',
  ).not.toBeNull();
  expect(thrown!.message).toContain('requireAllLocales');
  // It must name the offending key. A count alone ("1 of 61 missing") sends the next reader
  // hunting; the message is the only place the key is visible.
  expect(thrown!.message).toContain('banking:Account->Ledger:reconciledWith');
  // And it must fail on the ONE key that is genuinely uncovered, not on a wholesale miscount.
  expect(thrown!.message).toContain('1 of 61');

  // Passing `false` still disables it — that escape hatch exists, which is why the generator is
  // asserted NOT to use it.
  expect(buildOntologyI18nRows({ canonical: withExtraEdge, requireAllLocales: false }).length).toBeGreaterThan(0);
});

test('⛔ the generator does not switch the coverage gate off', () => {
  // The gate defaults to on, so the only way to lose it is for someone to pass `false` while
  // chasing a red build. That edit is invisible in a migration diff — the SQL would simply have
  // fewer rows — so it is asserted here, in the file whose job is to notice.
  const gen = readFileSync(join(BACKEND, 'scripts', 'gen-ontology-i18n.ts'), 'utf8');
  // Pin the call itself. Anything added to that options object changes this string.
  expect(gen, 'the generator no longer calls the builder with a bare options object').toContain(
    'const rows = buildOntologyI18nRows({ canonical });',
  );
  // And belt-and-braces on the executable lines only: the generator's own prose contains the
  // phrase `requireAllLocales: false` as the thing NOT to do, so a naive substring search over the
  // whole file matches its own warning and fails for the wrong reason.
  const code = gen
    .split('\n')
    .filter((l) => !/^\s*(\/\/|--|\*)/.test(l))
    .join('\n');
  expect(code, 'the generator disables the coverage gate').not.toContain('requireAllLocales: false');
});
