// tests/migration-runner-discovery.test.ts — the runner must REFUSE a migration it cannot see.
//
// ⛔ WHAT THIS GUARDS, AND WHY IT IS NOT A REPAIR. All 78 files in `backend/migrations/` match
// `/^(\d{3,})_.*\.sql$/` today, so nothing on disk is broken and this file fixes nothing. It
// guards the NEXT filename. `discoverMigrationFiles` used to `continue` past any name the regex
// declined — no log, no throw — so `0076a_hotfix.sql` (a plausible spelling for a fix squeezed
// between two ordinals) would sit in the migrations directory, be read as a migration by every
// human and by all four looser `.endsWith('.sql')` consumers, be counted CURRENT by
// `scripts/db-preflight.sh`, and never have a single line of it executed in production. The
// eventual symptom is a missing column that is indistinguishable from a code bug.
//
// ⛔ AND THE DUPLICATE ORDINAL. The sort is `a.order - b.order || a.name.localeCompare(b.name)`,
// which does not error on two files claiming 76 — it silently resolves them by their alphabetical
// suffix. Two branches merging is exactly how that happens, and neither author chose that order.
//
// ⛔ THE BAD NAMES ARE CREATED IN A TEMP FIXTURE DIR, NEVER IN backend/migrations/. Writing one
// there would red the sibling suites (the GUC scan, the preflight tests, the 0077 wedge) for
// everyone sharing this box, and a test that has to be cleaned up by hand is a test that will
// one day not be.
import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import postgres from 'postgres';
import {
  applyMigrations,
  discoverMigrationFiles,
  migrationOrdinal,
} from '../src/db/migration-runner';
import { config } from '../src/config';

const QUIET = { log: () => {}, warn: () => {}, error: () => {} };
const SCRATCH_DB = 'cp_migration_discovery_scratch';

function withDatabase(dsn: string, database: string): string {
  const u = new URL(dsn);
  u.pathname = `/${database}`;
  return u.toString();
}
const OWNER_DSN = config.database.migrateUrl;
const SCRATCH_DSN = withDatabase(OWNER_DSN, SCRATCH_DB);
const MAINTENANCE_DSN = withDatabase(OWNER_DSN, 'postgres');

const staged: string[] = [];

/** A throwaway migrations directory holding exactly the given `name -> sql` files. */
function stage(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-migrations-'));
  staged.push(dir);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

async function withMaintenance(fn: (sql: postgres.Sql) => Promise<void>): Promise<void> {
  const admin = postgres(MAINTENANCE_DSN, { max: 1, onnotice: () => {} });
  try {
    await fn(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

afterAll(() => {
  for (const dir of staged) rmSync(dir, { recursive: true, force: true });
});

test('migrationOrdinal is the ONE predicate, and it reads more than four digits', () => {
  expect(migrationOrdinal('0077_split_dataset_capability.sql')).toBe(77);
  expect(migrationOrdinal('0001_init.sql')).toBe(1);
  // ⛔ THE FIXED-4-CHAR BUG, PINNED. `name.slice(0, 4)` — which is what the 0077 wedge test used
  // to do — reads this as 10 and sorts a five-digit migration BEFORE 0011. The regex reads 100.
  expect(migrationOrdinal('00100_later.sql')).toBe(100);
  // Declined, one and all — and `null`, not `NaN`, so a caller cannot arithmetic its way past it.
  expect(migrationOrdinal('0076a_hotfix.sql')).toBeNull();
  expect(migrationOrdinal('76_too_few_digits.sql')).toBeNull();
  expect(migrationOrdinal('fixup.sql')).toBeNull();
  expect(migrationOrdinal('0080-dash-not-underscore.sql')).toBeNull();
  expect(migrationOrdinal('README.md')).toBeNull();
});

test('⛔ a .sql file the predicate declines makes the runner THROW, and NAMES it', async () => {
  const dir = stage({
    '0001_ok.sql': 'SELECT 1;',
    '0076a_hotfix.sql': 'SELECT 1;',
  });

  // The negative control is the same directory WITHOUT the bad name: if `discoverMigrationFiles`
  // stopped throwing (the pre-fix `continue`), this test would pass on the arm below, so the arm
  // above is what carries it — and it is asserted on the MESSAGE, not merely on "it threw".
  const ok = await discoverMigrationFiles(stage({ '0001_ok.sql': 'SELECT 1;' }));
  expect(ok.map((f) => f.name)).toEqual(['0001_ok.sql']);

  await expect(discoverMigrationFiles(dir)).rejects.toThrow(/0076a_hotfix\.sql/);
  await expect(discoverMigrationFiles(dir)).rejects.toThrow(/refusing to run/);

  // …and it escapes the RUNNER, not just the helper — the boot path is what production runs.
  // No connection is opened: discovery happens before `sql.begin`, so this needs no database.
  let message: string | null = null;
  try {
    await applyMigrations(SCRATCH_DSN, { migrationsDir: dir, logger: QUIET });
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message, 'the runner accepted a directory holding a .sql file it will never apply').not.toBeNull();
  expect(message!).toContain('0076a_hotfix.sql');
});

test('⛔ the migrationOrdinal docstring still describes the code that exists', () => {
  // ⛔ WHY A TEST FOR A COMMENT. The first version of that docstring said the three disagreeing
  // predicates had been CONSOLIDATED into one exported function. They had not — only the 0077
  // wedge test was migrated, and three `.endsWith('.sql')` readers remained. The claim was false
  // the moment it was written, and a false comment is a defect generator: the next author reads
  // "one source of truth", does not check, and reasons about a repo that does not exist.
  //
  // The docstring now states the true thing (the runner REFUSES what it cannot parse, so the
  // looser readers can no longer disagree about a file that reaches production) and names the
  // three that remain, WITH the reason each is correct where it is. This pins that pairing: if
  // someone migrates one of them, or moves it, this reds and sends them to the comment.
  const runner = readFileSync(join(import.meta.dir, '..', 'src', 'db', 'migration-runner.ts'), 'utf8');
  const doc = runner.slice(0, runner.indexOf('export function migrationOrdinal'));

  // NON-VACUITY: the slice must actually contain the docstring, or every `toContain` below is
  // satisfied by an empty search over the whole file.
  expect(doc, 'could not isolate the migrationOrdinal docstring').toContain('WHAT ACTUALLY CHANGED');

  const LOOSE: [file: string, sites: number][] = [
    ['tests/migration-guc-reset.test.ts', 1],
    ['tests/db-preflight-target.test.ts', 2],
  ];
  for (const [rel, sites] of LOOSE) {
    const src = readFileSync(join(import.meta.dir, '..', rel), 'utf8');
    const found = [...src.matchAll(/\.endsWith\('\.sql'\)/g)].length;
    expect(
      found,
      `${rel} no longer has ${sites} \`.endsWith('.sql')\` site(s). If that is deliberate, the ` +
        'migrationOrdinal docstring names it as a deliberately-looser reader and must be updated ' +
        'in the same commit.',
    ).toBe(sites);
    // …and the docstring actually names the file it is making a claim about.
    expect(doc, `the docstring does not name ${rel}`).toContain(rel.replace('tests/', ''));
  }

  // The shell script is the reason db-preflight-target's predicate must stay loose, so its own
  // spelling is pinned too — the test must match the TOOL UNDER TEST, not the runner.
  const sh = readFileSync(join(import.meta.dir, '..', 'scripts', 'db-preflight.sh'), 'utf8');
  expect(sh, 'db-preflight.sh no longer lists migrations with `ls -1 *.sql`').toContain('ls -1 *.sql');
  expect(doc).toContain('db-preflight.sh');

  // ⛔ AND THE CLAIM IT MUST *NOT* MAKE AGAIN.
  expect(doc, 'the docstring is claiming a consolidation that did not happen').not.toMatch(
    /one exported function is the fix/,
  );
});

test('⛔ the boot abort NAMES the file — it does not just say "a migration is bad"', async () => {
  // ⛔ WHY THIS IS ITS OWN TEST AND NOT A THIRD `expect` ABOVE. This throw stops the POD from
  // starting (`src/server.ts:102`). An operator reading a crash-loop has the message and nothing
  // else — no shell in the container, no `ls` of the image. "invalid migration filename" sends
  // them reading 78 files; "0076a_hotfix.sql" ends the outage in one rename. The difference
  // between those two messages is hours, so it is pinned as a property in its own right, and it
  // must survive anyone rewording the refusal.
  const dir = stage({ '0001_ok.sql': 'SELECT 1;', '0076a_hotfix.sql': 'SELECT 1;' });
  let message = '';
  try {
    await discoverMigrationFiles(dir);
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  expect(message, 'discovery accepted a .sql file it will never apply').not.toBe('');
  expect(message, 'the abort does not name the offending file').toContain('0076a_hotfix.sql');
  // …and the DIRECTORY, so an operator knows which of the (temp fixture / image) trees it means.
  expect(message).toContain(dir);
  // NON-VACUITY: a message that just dumped every entry would satisfy the assertions above while
  // naming nothing in particular. The GOOD file must not be in the refusal.
  expect(message, 'the refusal names an innocent file, which sends the operator to the wrong one')
    .not.toContain('0001_ok.sql');
});

test('a non-.sql file in the migrations dir is NOT an error', async () => {
  // Refusing on a README or an editor swapfile would make the runner unbootable for no reason.
  // This is the false-positive half of the guard above, and it has to be measured too.
  const dir = stage({
    '0001_ok.sql': 'SELECT 1;',
    'README.md': '# migrations',
    '.0002_swap.sql.swp': 'junk',
  });
  mkdirSync(join(dir, 'archive'));
  const files = await discoverMigrationFiles(dir);
  expect(files.map((f) => f.name)).toEqual(['0001_ok.sql']);
});

test('⛔ two files claiming the same ordinal make the runner THROW', async () => {
  const dir = stage({
    '0001_init.sql': 'SELECT 1;',
    '0002_alpha.sql': 'SELECT 1;',
    '0002_beta.sql': 'SELECT 1;',
  });
  // Pre-fix, this returned [init, alpha, beta] — an apply order chosen by `localeCompare`, i.e. by
  // whichever author's word sorted first. Both names must appear in the refusal.
  await expect(discoverMigrationFiles(dir)).rejects.toThrow(/duplicate migration ordinal/);
  await expect(discoverMigrationFiles(dir)).rejects.toThrow(/0002_alpha\.sql/);
  await expect(discoverMigrationFiles(dir)).rejects.toThrow(/0002_beta\.sql/);

  // A DIFFERENT ordinal with the same stem is fine — the guard is on the number, not the words.
  const fine = await discoverMigrationFiles(
    stage({ '0001_init.sql': 'SELECT 1;', '0002_alpha.sql': 'SELECT 1;', '0003_beta.sql': 'SELECT 1;' }),
  );
  expect(fine.map((f) => f.name)).toEqual(['0001_init.sql', '0002_alpha.sql', '0003_beta.sql']);
});

test('a normal set still applies, in NUMERIC order, through the real runner', async () => {
  // The happy path is not decoration: a guard that refuses everything is also "green" on the two
  // tests above. This is the arm that says the runner still boots.
  const dir = stage({
    '0001_first.sql': 'CREATE TABLE discovery_probe (n int);',
    '0002_second.sql': "INSERT INTO discovery_probe (n) VALUES (2);",
    // ⛔ FIVE DIGITS, ON PURPOSE. Lexically `00010_…` sorts BEFORE `0002_…`; numerically it is
    // last. This row's position is the difference between the two orderings.
    // ⛔ CONDITIONAL ON ITS PREDECESSOR, so the row it writes is a PROOF of order and not a
    // coincidence: if 00010 ran before 0002 (i.e. lexically), the row 0002 writes does not exist
    // yet, the `WHERE EXISTS` is false, and no row 10 is ever written.
    '00010_tenth.sql':
      'INSERT INTO discovery_probe (n) SELECT 10 WHERE EXISTS (SELECT 1 FROM discovery_probe WHERE n = 2);',
  });
  expect((await discoverMigrationFiles(dir)).map((f) => f.name)).toEqual([
    '0001_first.sql',
    '0002_second.sql',
    '00010_tenth.sql',
  ]);

  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  try {
    await applyMigrations(SCRATCH_DSN, { migrationsDir: dir, logger: QUIET });
    const scratch = postgres(SCRATCH_DSN, { max: 1, onnotice: () => {} });
    try {
      const applied = (await scratch.unsafe(
        `SELECT filename FROM _migrations`,
      )) as unknown as { filename: string }[];
      // ⛔ A SET, NOT A SEQUENCE. All three land in ONE transaction, so `applied_at` is the same
      // `now()` for all three and any ORDER BY here degenerates to a tiebreak on the filename —
      // which is the LEXICAL order this test exists to distinguish from. The ordering claim is
      // made below, against data the migrations wrote, where it is real.
      expect(applied.map((r) => r.filename).sort()).toEqual(
        ['0001_first.sql', '0002_second.sql', '00010_tenth.sql'].sort(),
      );
      // 0001 creates the table, 0002 writes 2, and 00010 writes 10 ONLY IF 2 is already there.
      // Both rows present is therefore 0001 → 0002 → 00010, measured, not assumed.
      const rows = (await scratch.unsafe(
        `SELECT n FROM discovery_probe ORDER BY n`,
      )) as unknown as { n: number }[];
      expect(rows.map((r) => r.n), 'numeric order broke: 00010 ran before 0002').toEqual([2, 10]);
    } finally {
      await scratch.end({ timeout: 5 });
    }
  } finally {
    await withMaintenance(async (admin) => {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    });
  }
}, 120_000);
