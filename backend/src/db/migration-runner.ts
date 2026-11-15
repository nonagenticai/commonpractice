// src/db/migration-runner.ts
// Sequential SQL migration runner — the robust core of fr's runner without the
// fr-specific probe/backfill/rename history (Common Practice starts clean):
//   * reads migrations/NNN_*.sql in numeric order,
//   * tracks applied filenames in a `_migrations` table,
//   * holds a Postgres session advisory lock so concurrent pods serialize,
//   * applies each file in a SAVEPOINT (per-file rollback inside one outer tx).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';

const ADVISORY_LOCK_KEY = 730294; // arbitrary, constant across pods
const DEFAULT_MIGRATIONS_DIR = path.resolve(import.meta.dir, '..', '..', 'migrations');
const MIGRATION_FILE_RE = /^(\d{3,})_.*\.sql$/;

/**
 * THE definition of "what is a migration file, and where does it sort", as PRODUCTION sees it.
 *
 * ⛔ WHY THIS IS EXPORTED RATHER THAN PRIVATE. Three predicates for one question used to live in
 * this repo at once: this regex (the only one production obeys), a fixed 4-char prefix slice in
 * `tests/migration-0077-runner-wedge.test.ts` (which reads `00100_x.sql` as 10, not 100, and
 * yields `NaN` — not an error — for anything else), and a bare `.endsWith('.sql')` in four more
 * places. A file the runner declined was INVISIBLE to the runner and VISIBLE to every looser
 * consumer, so the preflight would call the schema current and the runner would never apply a
 * line of it.
 *
 * ⛔ WHAT ACTUALLY CHANGED, PRECISELY — AND IT IS NOT "EVERY CONSUMER NOW CALLS THIS".
 * An earlier version of this comment claimed the three predicates had been consolidated into one.
 * That was FALSE and is exactly the class of defect this file's comments exist to prevent: only
 * the wedge test was migrated. `tests/migration-guc-reset.test.ts:163`,
 * `tests/db-preflight-target.test.ts:156` and `:236`, and `scripts/db-preflight.sh:207` still use
 * `.endsWith('.sql')` / `ls -1 *.sql`.
 *
 * What removed the hazard is not consolidation, it is `discoverMigrationFiles` REFUSING to run at
 * all when it meets a `.sql` file it cannot parse. The looser predicates can no longer disagree
 * with this one about a file that reaches production, because no such file can reach production —
 * the process aborts at boot and CI reds before an image is built.
 *
 * ⛔ AND THE THREE THAT REMAIN ARE CORRECT WHERE THEY ARE — do not "finish the job" by pointing
 * them here. Each was checked:
 *
 *   * `migration-guc-reset.test.ts` scans every file for an unguarded `SET LOCAL`. It wants a
 *     SUPERSET: narrowing it to this predicate would make it scan FEWER files, i.e. skip exactly
 *     the odd-named file most likely to have been written in a hurry. Looser is safer there.
 *   * `db-preflight-target.test.ts` (both sites) asserts the behaviour of `db-preflight.sh`, whose
 *     own file list is `ls -1 *.sql` (`:207`). The test's predicate must match the TOOL UNDER
 *     TEST, not this one — if they diverged, the test would be asserting against a file list the
 *     script never produces, which is a worse bug than the one it would be "fixing".
 *   * `db-preflight.sh` itself is a shell script with no access to this module, and its job is to
 *     report a STALE schema. Listing a badly-named file as unapplied is the RIGHT answer: that
 *     file genuinely is not applied and never will be.
 *
 * So the honest summary is: one source of truth for what production APPLIES, a loud refusal when
 * anything else is present, and three deliberately-looser readers that are each looser for a
 * stated reason.
 *
 * @returns the numeric ordinal, or `null` if the name is not a migration filename at all.
 */
export function migrationOrdinal(name: string): number | null {
  const match = MIGRATION_FILE_RE.exec(name);
  if (!match) return null;
  return Number.parseInt(match[1]!, 10);
}

export interface ApplyMigrationsOptions {
  migrationsDir?: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * GUCs the runner RESETs at the end of every migration file, inside that file's savepoint.
 *
 * ⛔ WHY THIS IS THE RUNNER'S JOB AND NOT THE MIGRATION AUTHOR'S.
 * `runMigrations` applies ALL pending files inside ONE `sql.begin()`, one savepoint per file.
 * `SET LOCAL` is scoped to the TRANSACTION, and `RELEASE SAVEPOINT` does NOT undo it — so a file
 * that sets a GUC and forgets to reset it silently imposes that setting on every LATER file in the
 * same run. On an existing cluster nobody notices (each file is applied in its own run); on a
 * FRESH-CLUSTER FIRST BOOT every file is pending at once and the leak is real. Live example:
 * `0059` and `0060` each `SET LOCAL lock_timeout = '5s'` with no RESET, so on a cold boot 0059's
 * ceiling applies to 0060 and on into 0061 until 0061's own RESET. (`0061`–`0066` all pair theirs,
 * which is exactly the point — the invariant depended on six authors in a row remembering.)
 *
 * ⛔ AND WHY IT COULD NOT BE FIXED FORWARD. A new `0067` runs AFTER 0060, and an applied migration
 * file may never be edited — `_migrations` is keyed on filename, so an applied file is never read
 * again and the edit would reach only clusters that have not booted yet. The runner is the only
 * place that sees every file.
 *
 * ⛔ NOT `RESET ALL`, BUT NOT FOR THE REASON THIS COMMENT USED TO GIVE.
 * It used to say `RESET ALL` "would clobber `search_path` and `role`, which the migrate DSN is
 * entitled to set (`?options=-c search_path=…`)". ⛔ CORRECTED 2026-08-14 — that is FALSE, measured
 * against postgres 18: `RESET x` means `SET x TO DEFAULT`, and for a connection whose GUCs came in
 * the STARTUP PACKET (which is exactly what `?options=-c …` is) the startup value IS the default.
 * A DSN-supplied `search_path` survives both `RESET search_path` and `RESET ALL` intact. Anyone
 * reasoning from the old sentence would conclude the narrow list is load-bearing for a hazard that
 * does not exist, and would not look for the one that does.
 *
 * The real reason is scope: `RESET ALL` discards EVERY GUC set during the run, including one an
 * earlier file deliberately set for the files after it (`SET LOCAL search_path`, `SET ROLE`) — it
 * turns "contain the GUCs we named" into "silently undo whatever any migration did", which is a
 * much larger and entirely unreviewed change arriving as a two-word edit. So the list stays narrow
 * and EXPLICIT, `tests/migration-guc-reset.test.ts` pins that narrowness behaviourally (not just by
 * grepping for the string `RESET ALL`), and its static scan fails the build if a migration ever
 * sets a GUC that is not on the list — so adding e.g. `statement_timeout` forces a deliberate change
 * here instead of a silent leak.
 *
 * ⚠️ That scan covers `SET [LOCAL|SESSION] guc = …`, the `TO` spelling, quoted identifiers, and
 * `set_config('guc', …)` including inside a `DO $$ … $$` block — every one of which was a proven
 * blind spot in its first version, and every one of which leaks.
 */
export const MIGRATION_RESET_GUCS = ['lock_timeout'] as const;

/** Either the top-level client or a transaction handle — helpers accept both. */
type AnySql = postgres.Sql<{}> | postgres.TransactionSql<{}>;

export async function applyMigrations(
  databaseUrl: string,
  opts: ApplyMigrationsOptions = {},
): Promise<void> {
  // `application_name` matters here more than anywhere else. This client is transient — one
  // connection, at boot, on the OWNER DSN, i.e. on the TRANSACTION pooler, whose `commonpractice`
  // pool_size is the tightest ceiling CP has. During a rolling deploy every starting pod opens one
  // of these ON TOP OF its `cp-owner` pool, which is exactly what pushed that pooler past its
  // ceiling. Unnamed, a stuck migration is indistinguishable in `pg_stat_activity` from an owner-
  // pool connection leak — the same symptom, the opposite fix.
  const sql = postgres(databaseUrl, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: 'cp-migrate' },
  });
  try {
    await runMigrations(sql, opts);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function runMigrations(
  sql: postgres.Sql,
  opts: ApplyMigrationsOptions = {},
): Promise<void> {
  const migrationsDir = opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const logger = opts.logger ?? console;

  const files = await discoverMigrationFiles(migrationsDir);
  if (files.length === 0) {
    logger.log('[migrations] no migration files found, nothing to do');
    return;
  }

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`;
    await ensureMigrationsTable(tx);
    const applied = await loadApplied(tx);

    const pending = files.filter((f) => !applied.has(f.name));
    if (pending.length === 0) {
      logger.log('[migrations] schema up to date');
      return;
    }

    logger.log(`[migrations] applying ${pending.length} migration(s)`);
    for (const file of pending) {
      const sqlText = await readFile(file.path, 'utf8');
      try {
        await tx.savepoint(async (sp) => {
          await sp.unsafe(sqlText);
          // Contain any `SET LOCAL` this file made to this file — see MIGRATION_RESET_GUCS. Only on
          // the success path: a FAILING file rolls back to its savepoint, and ROLLBACK TO SAVEPOINT
          // *does* undo a SET LOCAL (unlike RELEASE), so there is nothing to clean up there.
          for (const guc of MIGRATION_RESET_GUCS) await sp.unsafe(`RESET ${guc}`);
          await sp`INSERT INTO _migrations (filename) VALUES (${file.name})`;
        });
        logger.log(`[migrations] applied ${file.name}`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`[migrations] failed to apply ${file.name}: ${reason}`);
      }
    }
  });
}

export interface MigrationFile {
  name: string;
  path: string;
  order: number;
}

/**
 * The migration files in `dir`, in apply order.
 *
 * ⛔ THIS FUNCTION REFUSES RATHER THAN SKIPS, AND THAT IS THE WHOLE POINT. It used to `continue`
 * on a name the regex declined — no log, no throw. `0076a_x.sql` is a plausible name (a hotfix
 * squeezed between two ordinals is exactly how people spell it), it is a `.sql` file sitting in
 * `backend/migrations/`, every reviewer reads it as a migration, `db-preflight.sh` counts it, and
 * production would NEVER apply one line of it and would never say so. The failure is silent, it is
 * permanent, and it surfaces later as a missing column that looks like a code bug.
 *
 * ⛔ AND IT REFUSES ON A DUPLICATE ORDINAL. The sort is `a.order - b.order || localeCompare`, so
 * two files claiming ordinal 76 do not error — they get an arbitrary-but-stable apply order decided
 * by their alphabetical suffix. That is the classic two-branches-merged accident: both authors
 * wrote `0079_`, both files apply, and the order they apply in is whatever the letters after the
 * number happen to be rather than anything either author intended.
 *
 * Both refusals name the offending files, because a boot-time abort that does not say WHICH file
 * is a different day-long outage from one that does. `tests/migration-runner-discovery.test.ts`
 * asserts the NAME is in the message, not merely that something threw.
 *
 * ⛔ AND YES, THIS THROWS AT BOOT — `applyMigrations` runs from `src/server.ts:102`, so a refusal
 * here means the pod does not start. This repo has a scar exactly there: a previous session
 * refused to ship a `0077` that `RAISE`d on rows it could not converge, because the rollback took
 * the whole migration transaction with it and the pod crash-looped on every retry. That refusal
 * was right and this throw is still correct, for a reason that is a genuine difference and not a
 * rationalisation:
 *
 *   * 0077's wedge was triggered by DATA that existed only in production. It was invisible to CI
 *     (which migrates a blank database), it differed per cluster, and repairing it needed a
 *     running pod — the thing the wedge had just taken away. Unrecoverable in place.
 *   * This wedge is triggered by A FILE BAKED INTO THE IMAGE. It is deterministic, byte-identical
 *     in CI and in prod, present the moment the branch is pushed, and repaired by renaming a file
 *     in the repo. It cannot appear in production without appearing in CI first.
 *
 * ⛔ AND CI CATCHES IT BEFORE AN IMAGE EXISTS — verified, not assumed, against `.github/workflows/
 * ci-cd.yaml`. The GATING job `pre-build-checks` (`:54`) runs `Apply migrations` (`:150`:
 * `cd backend && bun run migrate`), which is `scripts/migrate.ts` → this function. `build-and-push`
 * (`:293`) is `needs: pre-build-checks` with `if: … needs.pre-build-checks.result == 'success'`
 * (`:295-296`), so a bad filename reds the build before an image is BUILT, let alone promoted.
 * `deploy-and-test` (`:405`, `needs: build-and-push`) then boots the real container, which
 * "self-migrates on boot" (`:514`) — a second, independent catch on the actual artifact — and
 * `promote` (`:574`) is `needs: [build-and-push, deploy-and-test]`. Two gates, both upstream of
 * `:latest`. Measured: the `migrate.ts` shape (top-level await, no try/catch) exits **1** on a
 * directory holding `0076a_hotfix.sql`, with the DSN pointing at a dead port — discovery runs
 * before any connection, so the gate does not even depend on the CI database being reachable.
 *
 * The alternative — log loudly and carry on — is what the bug already was. A `logger.error` at
 * boot is a line in a pod log nobody reads, and the pod comes up serving a schema that is missing
 * the migration, which is precisely the silent-wrong-answer failure this guard exists to convert
 * into a loud one.
 */
export async function discoverMigrationFiles(dir: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const files: MigrationFile[] = [];
  const unrecognized: string[] = [];
  for (const name of entries) {
    const order = migrationOrdinal(name);
    if (order === null) {
      // Only a `.sql` file is a claim to be a migration. A README, a .DS_Store or an editor
      // swapfile is not, and refusing on those would make the runner unbootable for no reason.
      if (name.toLowerCase().endsWith('.sql')) unrecognized.push(name);
      continue;
    }
    files.push({ name, path: path.join(dir, name), order });
  }
  if (unrecognized.length > 0) {
    throw new Error(
      `[migrations] refusing to run: ${unrecognized.length} .sql file(s) in ${dir} are not named ` +
        `NNN_description.sql and would NEVER be applied: ${unrecognized.sort().join(', ')}. ` +
        'Rename to a numeric-ordinal form or move the file out of the migrations directory.',
    );
  }
  files.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  const byOrder = new Map<number, string[]>();
  for (const f of files) byOrder.set(f.order, [...(byOrder.get(f.order) ?? []), f.name]);
  const duplicates = [...byOrder.entries()].filter(([, names]) => names.length > 1);
  if (duplicates.length > 0) {
    throw new Error(
      `[migrations] refusing to run: duplicate migration ordinal(s) in ${dir} — ` +
        duplicates.map(([order, names]) => `${order}: ${names.join(', ')}`).join('; ') +
        '. Apply order between them would be decided by their filenames, not by their authors.',
    );
  }
  return files;
}

async function ensureMigrationsTable(sql: AnySql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

async function loadApplied(sql: AnySql): Promise<Set<string>> {
  const rows = await sql<{ filename: string }[]>`SELECT filename FROM _migrations`;
  return new Set(rows.map((r) => r.filename));
}
