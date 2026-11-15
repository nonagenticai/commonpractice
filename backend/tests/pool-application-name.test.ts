// tests/pool-application-name.test.ts — every postgres client CP opens must name itself.
//
// WHY THIS IS WORTH A TEST. CP opens SEVEN distinct connections/pools across two pgbouncers
// (`cp-query`, `cp-tx`, `cp-probe` and `cp-metrics` on DATABASE_URL → the session pooler,
// `cp-listen` on the direct DSN, `cp-owner` and the transient `cp-migrate` on the owner/transaction
// one — the count was "five" here until `cp-probe` and `cp-metrics` were counted). Only `cp-query`,
// `cp-tx`, `cp-owner`, `cp-listen` and `cp-migrate` are covered by the table below; `cp-probe` is
// exercised through `validateConnection()` elsewhere. Until this change only `cp-listen` was
// named, which meant that when a pool saturated — and one already has, live, as an
// `08P01 server conn crashed?` FATAL out of runSystemTick — `pg_stat_activity` and pgbouncer's
// `SHOW POOLS` showed N anonymous `commonpractice` connections and NOTHING to attribute them to.
// Request traffic, in-request transactions, a scheduler storm on the owner pool, and a migration
// runner that failed to exit are four different bugs with four different fixes, and they were
// indistinguishable. The names are the whole diagnostic surface.
//
// ⛔ ASSERTED VIA A SERVER ROUND-TRIP, NOT VIA THE OPTIONS OBJECT. Reading back
// `client.options.connection.application_name` would pass for a MISSPELLED option key
// (`applicationName`, `application-name`), because postgres-js passes unknown keys through to the
// startup packet where the server ignores them — precisely the failure this is meant to catch. Only
// `SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()` proves the server
// actually received it.
//
// REVERT THAT REDS THIS: misspell any of the six keys (e.g. `applicationName` on queryClient), or
// drop the `connection` block from any client → that client's case fails with the empty/default
// name instead of its own.
//
// ⚠️ SCOPE: this runs against a DIRECT postgres connection, which is what CI and dev have. It does
// NOT prove pgbouncer FORWARDS these names to the server connection in prod. `application_name` is
// absent from both poolers' `ignore_startup_parameters`, so it should pass through on connect, but
// that is unverified against the live poolers — see the note on `resilientOptions` in db/client.ts.
import { test, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { queryClient, txClient, ownerClient, listenClient, metricsClient } from '../src/db/client';
import { releaseConnectorListener } from './connector-listen-lease';
import { applyMigrations } from '../src/db/migration-runner';
import { config } from '../src/config';

/** The one query that proves the server received the name: ask the backend about ITSELF. */
async function nameOnServer(sql: postgres.Sql): Promise<string> {
  const rows = await sql<
    { application_name: string }[]
  >`SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()`;
  return rows[0]?.application_name ?? '';
}

test.each([
  ['queryClient', 'cp-query', () => queryClient],
  ['txClient', 'cp-tx', () => txClient],
  ['ownerClient', 'cp-owner', () => ownerClient],
  // `listenClient` was the ONLY named client before this change; it is included so a future edit
  // that reshapes this options object cannot silently drop the one name that already worked.
  ['listenClient', 'cp-listen', () => listenClient],
  // The `/metrics` scheduler-freshness read's own `max: 1` client. It is the one client whose whole
  // reason to exist is that a stalled read must be attributable AND containable — an unnamed
  // connection wedged on `scheduler_ticks` is indistinguishable from a leaked request connection,
  // which is exactly the confusion that let the abandoned-query defect ship.
  ['metricsClient', 'cp-metrics', () => metricsClient],
] as const)('%s announces itself to postgres as %s', async (_label, expected, get) => {
  expect(await nameOnServer(get())).toBe(expected);
});

// ⛔ `cp-metrics` IS `max: 1` BY CONSTRUCTION, AND THAT IS THE BLAST-RADIUS BOUND, NOT A PREFERENCE.
// `Promise.race` cannot cancel a postgres-js query, so a stalled freshness read holds its connection
// until the server ends the statement. On the shared request pool that was 6 connections — the whole
// pod's request capacity (see tests/scheduler-freshness.test.ts §5b). `max: 1` makes the worst case
// one connection no matter what the timeout does. REVERT THAT REDS THIS: raise `max` on
// `metricsClient` in src/db/client.ts.
test('metricsClient can never hold more than ONE connection', () => {
  expect(metricsClient.options.max).toBe(1);
});

// The migration runner's client is TRANSIENT and built inside `applyMigrations`, so there is no
// object to interrogate — the only honest probe is to run a migration and have the migration itself
// report the name the server saw. This is the client that pushes the transaction pooler from 8/8 to
// 9/8 during a rolling deploy, and an unnamed stuck migration looks exactly like an owner-pool leak,
// so it is the single most valuable name of the five.
const PROBE_TABLE = '_appname_probe';
const PROBE_FILE = '900_appname_probe.sql';

afterAll(async () => {
  await queryClient.unsafe(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
  await queryClient`DELETE FROM _migrations WHERE filename = ${PROBE_FILE}`;
  // `nameOnServer(listenClient)` above OPENS the process-wide `cp-listen` connection, and nothing
  // else ever closes it (max:1, no idle/lifetime timeout). Left open, a later file in the same bun
  // process inherits a LISTEN session born BEFORE its own start, and
  // connector-listen-isolation.test.ts — which counts `cp-listen` backends newer than its import —
  // reads 0. Whether that bites depends only on the order bun discovers files in. See
  // connector-listen-lease.ts.
  await releaseConnectorListener();
}, 30_000);

test('the transient migration-runner client announces itself as cp-migrate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cp-appname-'));
  try {
    // Runs ON the migration runner's own connection, inside its transaction — so the row it writes
    // is that connection's view of itself, not the test's.
    await writeFile(
      path.join(dir, PROBE_FILE),
      `DROP TABLE IF EXISTS ${PROBE_TABLE};
       CREATE TABLE ${PROBE_TABLE} AS
         SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid();`,
    );
    await applyMigrations(config.database.migrateUrl, {
      migrationsDir: dir,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    const rows = await queryClient.unsafe<{ application_name: string }[]>(
      `SELECT application_name FROM ${PROBE_TABLE}`,
    );
    expect(rows[0]?.application_name).toBe('cp-migrate');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
