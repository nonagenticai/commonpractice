// tests/pool-budget.test.ts — the connection-budget ceilings, and the cross-repo tripwire.
//
// CP opens THREE pools across TWO pgbouncers (full arithmetic in src/config.ts):
//   queryClient + txClient  → DATABASE_URL        → pgbouncer-session   (poolMax + txPoolMax)
//   ownerClient             → MIGRATE_DATABASE_URL → pgbouncer (txn)    (ownerPoolMax)
// Each per-pod number is multiplied by the HPA replica count (min 2, max 4), because pgbouncer's
// `pool_size` is per (database, user) and shared by every replica — not per pod.
import { test, expect } from 'bun:test';
import { config } from '../src/config';
import { ownerClient } from '../src/db/client';

/** Import a fresh process under the given env and print a probe expression. The config module is a
 *  const evaluated once at import, so a subprocess is the only honest way to observe a different
 *  DB_OWNER_POOL_MAX from inside a suite that has already imported it. Same idiom as
 *  tests/seed-fabrication-guard.test.ts. */
async function probeUnder(expr: string, env: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(['bun', '-e', `console.log(${expr})`], {
    cwd: `${import.meta.dir}/..`,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      // The probe imports db/client, which CONNECTS — give it the same database this suite uses.
      DATABASE_URL: config.database.url,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = (await new Response(proc.stdout).text()).trim();
  const err = (await new Response(proc.stderr).text()).trim();
  await proc.exited;
  if (!out) throw new Error(`probe produced no stdout (stderr=${err})`);
  return out;
}

const CONFIG_PROBE = '(await import("./src/config")).config.database.ownerPoolMax';
// `.options.max` is what postgres-js actually pools on — the effective ceiling, not the input.
const CLIENT_PROBE = '(await import("./src/db/client")).ownerClient.options.max';

// ---- T2: the owner pool's ceiling is configurable, and the CLIENT honours it ----
//
// This pool was a bare `max: 4` LITERAL in db/client.ts with no env var, which made the one pool on
// the MORE oversubscribed pooler the only one that could not be retuned without a code deploy.
//
// ⛔ WITHOUT THE SECOND HALF OF THIS TEST THE GITOPS ENV VAR IS JUST A COMMENT. Asserting only
// `config.database.ownerPoolMax === 7` passes perfectly while db/client.ts still hard-codes 4 —
// the config would be read by nobody. The `"7"` case has to be observed ON THE CLIENT.
//
// REVERT THAT REDS THIS: restore the literal `max: 4` on `ownerClient` in src/db/client.ts → the
// third case fails (`7` expected, `4` received). The first two keep passing, which is the point.

test('DB_OWNER_POOL_MAX unset defaults to 4 — the exact literal it replaced, so this is a no-op change', async () => {
  expect(config.database.ownerPoolMax).toBe(4);
  expect(await probeUnder(CONFIG_PROBE, {})).toBe('4');
  expect(await probeUnder(CLIENT_PROBE, {})).toBe('4');
}, 30_000);

test('DB_OWNER_POOL_MAX="7" is read into config', async () => {
  expect(await probeUnder(CONFIG_PROBE, { DB_OWNER_POOL_MAX: '7' })).toBe('7');
}, 30_000);

test("ownerClient's effective max TRACKS config.database.ownerPoolMax, it is not a literal", async () => {
  // In-process: the client agrees with the config it was built from.
  expect(ownerClient.options.max).toBe(config.database.ownerPoolMax);
  // Out-of-process: and it MOVES when the env moves. A literal `max: 4` reds here and only here.
  expect(await probeUnder(CLIENT_PROBE, { DB_OWNER_POOL_MAX: '7' })).toBe('7');
}, 30_000);

// ---- T4: cross-repo tripwire ----
//
// ⚠️ READ THIS BEFORE TRUSTING IT. This is a TRIPWIRE, NOT A PROOF. The other half of the invariant
// lives in a DIFFERENT REPOSITORY (gitops-production, clusters/strato/services/pgbouncer-session/
// pgbouncer.ini and .../pgbouncer/pgbouncer.ini), and that repo is NOT part of commonpractice's CI.
// Nothing here can read those files, and a green run here says NOTHING about what the poolers are
// actually configured with. What this test does is narrower and still worth having: it fails the
// moment somebody raises CP's side of the budget, so that the person raising it is told, in the
// diff, that a second change is required in another repo. It cannot tell them whether that change
// was made.
test('CP-side session-pooler demand is 10 per pod — raising it REQUIRES a gitops change', () => {
  const perPod = config.database.poolMax + config.database.txPoolMax;
  // Asserted as a STRING so the diff itself carries the instruction. A bare `expect(perPod).toBe(10)`
  // fails with "Expected: 10 / Received: 12" — true, useless, and the reader has no idea another
  // repo is involved. Whoever reds this needs the filename, not the number.
  const summary =
    `DB_POOL_MAX(${config.database.poolMax}) + DB_TX_POOL_MAX(${config.database.txPoolMax})` +
    ` = ${perPod} per pod x 4 HPA replicas = ${perPod * 4} on pgbouncer-session` +
    ` — must be <= gitops clusters/strato/services/pgbouncer-session/pgbouncer.ini` +
    ` "commonpractice = … pool_size" (44), which THIS REPO CANNOT READ. Raise both or neither.`;
  expect(summary).toBe(
    'DB_POOL_MAX(6) + DB_TX_POOL_MAX(4) = 10 per pod x 4 HPA replicas = 40 on pgbouncer-session' +
      ' — must be <= gitops clusters/strato/services/pgbouncer-session/pgbouncer.ini' +
      ' "commonpractice = … pool_size" (44), which THIS REPO CANNOT READ. Raise both or neither.',
  );
  expect(perPod).toBe(10);
  expect(config.database.ownerPoolMax).toBe(4);
});

test('the per-pod budget fits the pooler ceilings AT 4 REPLICAS, not just at the steady 2', () => {
  // maxReplicas: 4 in clusters/strato/services/commonpractice/hpa.yaml. Four is the DESIGN POINT,
  // not a rare burst: the HPA target is computed against the container CPU *request* (25m backend /
  // 20m frontend), and was measured sitting at 26% of a 70% target with essentially no traffic.
  const HPA_MAX_REPLICAS = 4;
  // ⛔ A ROLLING DEPLOY AT MAX IS 5 PODS, NOT 4. deployment.yaml sets `maxSurge: 1` /
  // `maxUnavailable: 0`, so the new pod starts before an old one goes away. An earlier version of
  // this test modelled 4 and therefore certified a pool_size that was one pod short on BOTH
  // poolers — the exact class of "the arithmetic in the comment does not match the manifest" that
  // this whole change exists to stop. The surge pod also runs its transient `cp-migrate` client
  // before its pools warm, which is why the owner term carries the +1.
  const PEAK_PODS = HPA_MAX_REPLICAS + 1;
  // The values these must not exceed. Both are in gitops, both are per (database, user), and NEITHER
  // is readable from here — they are transcribed, and that transcription is the thing that rots.
  const SESSION_POOL_SIZE = 50; // pgbouncer-session/pgbouncer.ini  `commonpractice = … pool_size`
  const TXN_POOL_SIZE = 25; //     pgbouncer/pgbouncer.ini          `commonpractice = … pool_size`

  const sessionDemand = (config.database.poolMax + config.database.txPoolMax) * PEAK_PODS;
  // +1 per pod for the transient `cp-migrate` runner every pod opens at boot — the connection that
  // took the transaction pooler from 8/8 to 9/8 during a rolling deploy.
  const txnDemand = (config.database.ownerPoolMax + 1) * PEAK_PODS;

  expect(sessionDemand).toBeLessThanOrEqual(SESSION_POOL_SIZE);
  expect(txnDemand).toBeLessThanOrEqual(TXN_POOL_SIZE);

  // Stated so the failure message names the file to change, not just the number that broke.
  expect({ sessionDemand, txnDemand }).toEqual({ sessionDemand: 50, txnDemand: 25 });
});
