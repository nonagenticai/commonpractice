// tests/migration-guc-reset.test.ts — a `SET LOCAL` must not outlive the file that set it.
//
// ⛔ THE MECHANISM.
// `runMigrations` (src/db/migration-runner.ts) applies EVERY pending file inside ONE `sql.begin()`,
// with one `tx.savepoint()` per file. `SET LOCAL` is scoped to the TRANSACTION, and `RELEASE
// SAVEPOINT` does not undo it — only `ROLLBACK TO SAVEPOINT` does. So on a FRESH-CLUSTER FIRST BOOT,
// where every migration is pending at once, a file that sets a GUC without resetting it imposes that
// setting on every later file in the run.
//
// Live instance at the time of writing: `0059` and `0060` each `SET LOCAL lock_timeout = '5s'` with
// no RESET; `0061`–`0066` all pair theirs. So 0059's ceiling silently applied to 0060 and on into
// 0061 up to 0061's own RESET.
//
// ⛔ SEVERITY TODAY IS LOW, AND SAYING SO IS PART OF THE POINT: 0059, 0060 and 0061 all set the SAME
// 5s, so nothing is currently misbehaving. What is broken is the INVARIANT — the containment
// depended on six consecutive authors remembering a footgun documented only in prose, and the next
// author to set `statement_timeout` (or `5min` instead of `5s`) would leak something that matters
// into files written years earlier, on cold boot only, with no error.
//
// ⛔ WHY THE FIX IS IN THE RUNNER AND NOT IN A NEW MIGRATION. A forward-only `0067` runs AFTER 0060,
// so it cannot contain 0060's leak; and an APPLIED migration file may never be edited, because
// `_migrations` is keyed on filename and an applied file is never read again — the edit would reach
// only clusters that have not booted yet, i.e. precisely not the ones already wrong.
import { test, expect } from 'bun:test';
import { readdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import { applyMigrations, MIGRATION_RESET_GUCS } from '../src/db/migration-runner';
import { config } from '../src/config';

const MIGRATIONS_DIR = new URL('../migrations', import.meta.url).pathname;

/**
 * ⛔ THE SCAN, AND WHY IT IS THIS ELABORATE.
 *
 * The first version was `^\s*SET\s+LOCAL\s+(\w+)\s*=` over lines that do not start with `--`. Every
 * one of the following was dropped on the floor, and each was then dropped into `migrations/` and
 * run through the REAL two-file runner, where file B measurably observed `statement_timeout='5s'`
 * against a session baseline of `0`:
 *
 *     SET LOCAL statement_timeout TO '5s';                      -- standard Postgres `TO` spelling
 *     SET statement_timeout = '5s';                             -- no LOCAL: leaks even harder
 *     SELECT set_config('statement_timeout','5s',true);         -- idiomatic inside a DO block
 *     SET LOCAL "statement_timeout" = '5s';                     -- quoted identifier
 *     SELECT 1; SET LOCAL statement_timeout = '5s';             -- not at the start of a line
 *
 * And it produced FALSE POSITIVES, which are worse than a miss because they block a legitimate
 * migration and get "fixed" by editing the comment: a `SET LOCAL` inside a block comment, or inside
 * a `$doc$…$doc$` documentation literal, both matched — only `--` lines were stripped.
 *
 * So: comments (line + nested block) and non-executable dollar-quoted literals are removed;
 * statements are split on `;` AFTER string literals are blanked; and a GUC is recognised by being
 * at the START of a statement, which is the only thing that distinguishes `SET LOCAL x = …` from
 * the `SET` clause of an `UPDATE` — of which this tree has ~20, several of them at column 0.
 */

/** True when `word` (case-insensitive) is the token immediately before position `i`. */
function precededBy(src: string, i: number, words: string[]): boolean {
  const before = src.slice(0, i).replace(/\s+$/, '');
  return words.some((w) => new RegExp(`(?:^|[^a-zA-Z0-9_])${w}$`, 'i').test(before));
}

/**
 * SQL with comments removed and non-executable dollar-quoted bodies blanked.
 *
 * ⛔ A DOLLAR-QUOTED BODY IS NOT ALWAYS INERT. `COMMENT ON TABLE t IS $doc$…$doc$` is documentation
 * and must NOT be scanned; `DO $$ … $$` and `CREATE FUNCTION … AS $$ … $$` are EXECUTABLE and a
 * `SET LOCAL` in there leaks exactly like one at the top level. Blanket-stripping every dollar body
 * would trade the reported false positive for a brand-new false negative in the one construct the
 * reviewer named as idiomatic. The discriminator is the preceding keyword: `AS` or `DO` means code.
 */
function stripSqlNoise(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('--', i)) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (src.startsWith('/*', i)) {
      // Postgres block comments NEST, unlike C's.
      let depth = 0;
      while (i < src.length) {
        if (src.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (src.startsWith('*/', i)) {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else i++;
      }
      continue;
    }
    const dollar = /^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(src.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = src.indexOf(tag, i + tag.length);
      const bodyEnd = end === -1 ? src.length : end;
      const body = src.slice(i + tag.length, bodyEnd);
      // Executable body → keep it (recursively cleaned) so a `SET LOCAL` inside a DO block counts.
      out += precededBy(src, i, ['AS', 'DO']) ? `;${stripSqlNoise(body)};` : '';
      i = end === -1 ? src.length : end + tag.length;
      continue;
    }
    if (src[i] === "'") {
      // Preserved verbatim — `set_config('guc', …)` reads its name out of one of these.
      out += "'";
      i++;
      while (i < src.length) {
        out += src[i];
        if (src[i] === "'") {
          i++;
          if (src[i] === "'") {
            out += "'";
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

/** Every GUC name a piece of migration SQL sets, however it spells it. */
function gucsSetBy(sqlText: string): string[] {
  const code = stripSqlNoise(sqlText);
  const found: string[] = [];

  // `set_config('guc', value, is_local)` — both `true` and `false` matter: a SESSION-scoped one
  // leaks past the transaction entirely.
  for (const m of code.matchAll(/\bset_config\s*\(\s*'([^']+)'/gi)) found.push(m[1]!.toLowerCase());

  // A GUC assignment is only a GUC assignment at the START of a statement — `UPDATE t\nSET x = y`
  // puts `SET` at column 0 all over this tree. Blank string literals first so a `;` inside one
  // cannot manufacture a fake statement boundary.
  const noStrings = code.replace(/'(?:[^']|'')*'/g, "''");
  // plpgsql block keywords are statement boundaries too — `DO $$ BEGIN SET LOCAL … ; END $$` puts
  // the GUC assignment right after `BEGIN`, with no `;` in front of it.
  for (const stmt of noStrings.split(/;|\b(?:BEGIN|END|THEN|ELSE|LOOP)\b/gi)) {
    const m = /^\s*SET\s+(?:LOCAL\s+|SESSION\s+)?(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_.]*))\s*(?:=|\bTO\b)/i.exec(
      stmt,
    );
    if (!m) continue;
    const guc = (m[1] ?? m[2]!).toLowerCase();
    // `SET TRANSACTION …` / `SET CONSTRAINTS …` are statements, not GUC assignments.
    if (guc === 'transaction' || guc === 'constraints' || guc === 'role' || guc === 'session') continue;
    found.push(guc);
  }
  return found;
}

/** GUC → the migration files that set it. */
function settersInMigrations(): Map<string, string[]> {
  const byGuc = new Map<string, string[]>();
  for (const name of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
    for (const guc of gucsSetBy(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))) {
      byGuc.set(guc, [...(byGuc.get(guc) ?? []), name]);
    }
  }
  return byGuc;
}

test('⛔ every GUC any migration SETs LOCAL is on the runner reset list', () => {
  const found = settersInMigrations();

  // ⛔ NON-VACUITY. If the scan stopped matching (directory moved, statement re-spelled), an empty
  // map would satisfy the assertion below while guarding nothing. The repo demonstrably contains
  // `SET LOCAL lock_timeout` in eight files.
  expect([...found.keys()]).toContain('lock_timeout');

  const allowed = new Set<string>(MIGRATION_RESET_GUCS);
  const unguarded = [...found.keys()].filter((g) => !allowed.has(g)).sort();
  expect(
    unguarded,
    unguarded.length
      ? `migration(s) SET LOCAL ${JSON.stringify(unguarded)} — a GUC the runner does not RESET. ` +
          `SET LOCAL survives RELEASE SAVEPOINT, so on a fresh-cluster first boot (where every file ` +
          `is pending in ONE transaction) it leaks into every later migration. Add it to ` +
          `MIGRATION_RESET_GUCS in src/db/migration-runner.ts. Files: ` +
          JSON.stringify(Object.fromEntries([...found].filter(([g]) => !allowed.has(g))))
      : undefined,
  ).toEqual([]);
});

/**
 * ⛔ THE SCAN'S OWN TEST. A guard whose scanner silently matches nothing is not a weak guard, it is
 * an absent one that reports green — and this scanner shipped with FIVE proven blind spots and two
 * false positives. Each case below was verified against the real two-file runner before being
 * written down: in every "must be caught" row, file B observed `statement_timeout='5s'` where the
 * session baseline was `0`.
 */
test('⛔ the SET LOCAL scan catches every spelling that actually leaks', () => {
  const CAUGHT: [string, string][] = [
    ['SET LOCAL, the shape already in migrations/', `SET LOCAL statement_timeout = '5s';`],
    ['the standard Postgres `TO` spelling', `SET LOCAL statement_timeout TO '5s';`],
    ['no LOCAL at all — leaks past the transaction', `SET statement_timeout = '5s';`],
    ['SESSION, spelled out', `SET SESSION statement_timeout = '5s';`],
    ['a quoted identifier', `SET LOCAL "statement_timeout" = '5s';`],
    ['not at the start of a LINE, only of a statement', `SELECT 1; SET LOCAL statement_timeout = '5s';`],
    ['set_config, transaction-scoped', `SELECT set_config('statement_timeout','5s',true);`],
    ['set_config, SESSION-scoped (worse)', `SELECT set_config('statement_timeout','5s',false);`],
    [
      'set_config inside a DO block — executable, so NOT a literal',
      `DO $$ BEGIN PERFORM set_config('statement_timeout','5s',true); END $$;`,
    ],
    [
      'SET LOCAL inside a DO block',
      `DO $$ BEGIN\n  SET LOCAL statement_timeout = '5s';\nEND $$;`,
    ],
    ['lower case', `set local statement_timeout = '5s';`],
  ];
  for (const [why, sql] of CAUGHT) {
    expect(gucsSetBy(sql), `MISSED (${why}): ${sql}`).toContain('statement_timeout');
  }

  const IGNORED: [string, string][] = [
    // ⛔ FALSE POSITIVES BLOCK A LEGITIMATE MIGRATION, and the cheapest way out is always to edit
    // the prose rather than the scanner — so the guard starts eating its own documentation.
    [
      'inside a block comment',
      `/*\n  Historical note:\nSET LOCAL statement_timeout = '5s';\n*/\nCREATE TABLE t(a int);`,
    ],
    [
      'inside a $doc$ documentation literal',
      `COMMENT ON TABLE t IS $doc$\nSET LOCAL statement_timeout = '5s';\n$doc$;`,
    ],
    ['inside a `--` comment', `-- SET LOCAL statement_timeout = '5s';\nCREATE TABLE t(a int);`],
    // ⛔ AND THE ONE THAT MAKES THE STATEMENT-BOUNDARY RULE NECESSARY: ~20 files in migrations/
    // have an UPDATE whose `SET` clause starts at column 0.
    [
      "an UPDATE's SET clause at column 0",
      `UPDATE things\nSET statement_timeout = 1\nWHERE id = 2;`,
    ],
    ["a string literal that merely mentions it", `INSERT INTO t (v) VALUES ('SET LOCAL statement_timeout = 1');`],
  ];
  for (const [why, sql] of IGNORED) {
    expect(gucsSetBy(sql), `FALSE POSITIVE (${why}): ${sql}`).not.toContain('statement_timeout');
  }

  // ⛔ NON-VACUITY for the IGNORED half: "return nothing, ever" would satisfy all of it.
  expect(gucsSetBy(`SET LOCAL lock_timeout = '5s';`)).toEqual(['lock_timeout']);
});

test('the reset list is narrow — never RESET ALL', () => {
  // `RESET ALL` would also clobber `search_path` / `role`, which the migrate DSN may legitimately
  // set for the whole run (`?options=-c search_path=…`) and which the remaining files depend on.
  // Comment lines are stripped first — the runner's own docblock says "NOT `RESET ALL`", and a
  // guard that reddens on its own rationale would just get the rationale deleted.
  const code = readFileSync(new URL('../src/db/migration-runner.ts', import.meta.url).pathname, 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  expect(code).not.toContain('RESET ALL');
  // The executable reset is driven by the list, so the list is the whole surface.
  expect(code).toContain('for (const guc of MIGRATION_RESET_GUCS)');
  expect([...MIGRATION_RESET_GUCS].map((g) => g.toLowerCase())).not.toContain('all');
});

/**
 * ⛔ THE BEHAVIOURAL HALF. The scan above pins a LIST; it cannot prove the runner acts on it —
 * deleting the RESET loop leaves it perfectly green. This runs the real runner over a temp
 * migrations dir: file A sets `lock_timeout`, file B records what it sees. Without the reset, B
 * observes A's value.
 */
test('⛔ THE DEFECT — a SET LOCAL in one migration file must not reach the next', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-migrate-guc-'));
  const A = '9901_ws4_guc_setter.sql';
  const B = '9902_ws4_guc_reader.sql';
  const PROBE = '_ws4_guc_probe';

  writeFileSync(
    join(dir, A),
    `-- sets a transaction-scoped GUC and, like migrations 0059/0060, never resets it.\nSET LOCAL lock_timeout = '5s';\n`,
  );
  writeFileSync(
    join(dir, B),
    `CREATE TABLE IF NOT EXISTS ${PROBE} (seen text);\n` +
      `INSERT INTO ${PROBE} (seen) VALUES (current_setting('lock_timeout'));\n`,
  );

  const url = config.database.migrateUrl || config.database.url;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // The value the session starts with — asserting against THIS rather than a hard-coded '0' keeps
    // the test honest if the migrate DSN ever ships its own lock_timeout.
    const shown = await sql<{ lock_timeout: string }[]>`SHOW lock_timeout`;
    const baseline = shown[0]!.lock_timeout;

    await applyMigrations(url, { migrationsDir: dir, logger: { log() {}, warn() {}, error() {} } });

    const rows = await sql<{ seen: string }[]>`SELECT seen FROM ${sql(PROBE)}`;
    expect(rows).toHaveLength(1);
    // ⛔ '5s' here means file A's ceiling is governing file B. Both assertions matter: the first
    // names the leak, the second proves the RESET restored the real default rather than some third
    // value.
    expect(rows[0]!.seen).not.toBe('5s');
    expect(rows[0]!.seen).toBe(baseline);
  } finally {
    await sql.unsafe(`DROP TABLE IF EXISTS ${PROBE}`);
    await sql`DELETE FROM _migrations WHERE filename IN (${A}, ${B})`;
    await sql.end({ timeout: 5 });
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

/**
 * ⛔ THE NARROWNESS OF THE LIST, BEHAVIOURALLY — the half `the reset list is narrow` cannot reach.
 *
 * That test greps `migration-runner.ts` for the literal string `RESET ALL`, which says nothing
 * about what the runner DOES and is defeated by any indirection (`RESET ${'ALL'}`, a constant, a
 * loop over a wider list). This drives the real runner and asserts the shape of the behaviour: the
 * GUC on the list is contained, and a GUC NOT on the list is left exactly where the migration put
 * it. `RESET ALL` reddens the second assertion; deleting the reset loop reddens the first.
 *
 * ⚠️ AND THE LEAK IN THE SECOND ASSERTION IS DELIBERATE, NOT AN OVERSIGHT. It is why the static scan
 * above exists: the runner does not guess, it contains a NAMED list, and the scan guarantees no file
 * in `migrations/` sets anything outside it — so the leak this test pins is unreachable in
 * production and stays a decision someone has to make on purpose. Widening the list is a legitimate
 * change; it just has to be a change, made here, rather than a silent side effect.
 *
 * ⚠️ THIS REPLACES A TEST THAT COULD NOT FAIL. Its predecessor ("the reset does not disarm the file
 * that set it") documented itself as catching a runner that RESET BEFORE each file. Measured: with
 * the reset moved above `sp.unsafe(sqlText)` the file stayed 4 pass / 0 fail, and with the reset
 * loop DELETED ENTIRELY it was one of the two tests that still PASSED. Both are inevitable — the
 * file sets the GUC itself, after any reset, so it always observes its own value — and reset-before
 * is anyway functionally equivalent for containment, which is why the original commit recorded that
 * mutation as a deliberate NEGATIVE. There was no defect left for it to detect.
 */
test('⛔ the RESET is NARROW — it contains the listed GUC and leaves an unlisted one alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cp-migrate-guc-narrow-'));
  const A = '9903_ws4_guc_setter.sql';
  const B = '9904_ws4_guc_reader.sql';
  const PROBE = '_ws4_guc_narrow_probe';

  expect([...MIGRATION_RESET_GUCS]).toContain('lock_timeout');
  expect([...MIGRATION_RESET_GUCS]).not.toContain('statement_timeout');

  writeFileSync(
    join(dir, A),
    `SET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '7s';\n`,
  );
  writeFileSync(
    join(dir, B),
    `CREATE TABLE IF NOT EXISTS ${PROBE} (guc text, seen text);\n` +
      `INSERT INTO ${PROBE} VALUES ('lock_timeout', current_setting('lock_timeout'));\n` +
      `INSERT INTO ${PROBE} VALUES ('statement_timeout', current_setting('statement_timeout'));\n`,
  );

  const url = config.database.migrateUrl || config.database.url;
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const lockBaseline = (await sql<{ lock_timeout: string }[]>`SHOW lock_timeout`)[0]!.lock_timeout;

    await applyMigrations(url, { migrationsDir: dir, logger: { log() {}, warn() {}, error() {} } });

    const rows = await sql<{ guc: string; seen: string }[]>`SELECT guc, seen FROM ${sql(PROBE)}`;
    const seen = new Map(rows.map((r) => [r.guc, r.seen]));
    // On the list → contained, exactly as `⛔ THE DEFECT` above asserts.
    expect(seen.get('lock_timeout')).toBe(lockBaseline);
    // NOT on the list → untouched. `RESET ALL` would make this `0` and turn the runner from
    // "contain the GUCs we named" into "silently undo whatever any file did" — a far larger
    // behaviour change than the one that was reviewed, arriving as a two-word edit.
    expect(seen.get('statement_timeout')).toBe('7s');
  } finally {
    await sql.unsafe(`DROP TABLE IF EXISTS ${PROBE}`);
    await sql`DELETE FROM _migrations WHERE filename IN (${A}, ${B})`;
    await sql.end({ timeout: 5 });
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
