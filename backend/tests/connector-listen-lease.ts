// tests/connector-listen-lease.ts — shared teardown for the ONE process-wide LISTEN client.
// Not a `.test.ts`, so neither the hook-timeout scanner nor the fixture-id scanner picks it up.
//
// ⛔ WHY THIS EXISTS, AND WHY `listenClient.end()` IS THE WRONG TEARDOWN.
//
// `listenClient` (db/client.ts) is a MODULE SINGLETON, and bun runs every test file in ONE process
// (verified: two files report the same `process.pid`). `postgres.end()` is TERMINAL — an ended
// client answers every later query with `CONNECTION_ENDED` and can never be reopened. So when two
// files each ended it in `afterAll`, whichever finished first killed the listener for the other:
// connector-sse-cross-tenant.test.ts passed alone and failed in the full suite, with tenant A's
// stream receiving nothing at all. That reads like a fan-out regression and is not one, which is
// exactly the kind of misdiagnosis that costs a session.
//
// Simply not ending it is not the fix either. This client is `max: 1, idle_timeout: null,
// max_lifetime: null` — nothing will EVER close that connection on its own, so it would sit pinned
// against the shared test database for the rest of the run.
//
// So: stop the supervisor, then drop the SERVER side. The client object stays usable (postgres-js
// reconnects on demand for the next file that starts a listener), and no connection is parked in
// between. With the supervisor stopped, `onClose` is disarmed and nothing races to reconnect.
import { listenClient, queryClient } from '../src/db/client';
import { stopConnectorListener } from '../src/datasets/connector-listener';

/** Release the shared LISTEN client at the end of a test file. Safe to call when no listener was
 *  ever started, and safe to call from more than one file in any order. */
export async function releaseConnectorListener(): Promise<void> {
  stopConnectorListener();
  const [row] = await queryClient<{ pid: number | null }[]>`
    SELECT min(pid) AS pid
      FROM pg_stat_activity
     WHERE application_name = 'cp-listen'
       AND datname = current_database()`;
  if (row?.pid) await queryClient`SELECT pg_terminate_backend(${row.pid})`;
  // Give postgres-js's socket the tick it needs to observe the close, so the next file's
  // `startConnectorListener()` opens a fresh connection instead of writing to a dying one.
  await new Promise((r) => setTimeout(r, 50));
  void listenClient; // documents the ownership: this module is the only place that tears it down
}
