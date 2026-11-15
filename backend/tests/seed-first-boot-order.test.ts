// tests/seed-first-boot-order.test.ts — what a seeded tenant looks like after ONE boot.
//
// ⛔ WHY A REAL SCRATCH DATABASE AND NOT A FIXTURE. The two edits this guards are ORDERING and
// FIRST-BOOT edits, and both were measured as GREEN mutations against the ordinary suite:
// reverting the `seed.ts` reorder alone left 1350/0 passing, and reverting `seed-datasets.ts` to
// main entirely left 1360/0 passing. They survive because every other test runs against a database
// that has ALREADY been seeded at least once, where the second boot hides the defect completely.
// So this file migrates and seeds a throwaway database in a subprocess and looks at boot #1. It
// costs about two seconds.
//
// ⛔ WHAT IT DOES *NOT* CLAIM. The reorder is not "the real reason the seed could never link
// anything" — read-time mapping resolution is. Measured, on a fresh database:
//
//     boot | seedEntitySamples BEFORE seedExampleBlocks | AFTER (shipped)
//     -----|-------------------------------------------|-----------------
//       1  | 1 binding,  0 with a confirmed mapping     | 4 bindings, 3 mapped
//       2  | 4 bindings, 3 with a confirmed mapping     | 4 bindings, 3 mapped
//
// The reorder converts "dead until the next pod boot" into "live on the first boot". That is worth
// keeping and worth a test, and it is all it is.
//
// ⛔ PROD IS NOT AFFECTED EITHER WAY, and the mechanism is worth stating precisely because the
// short version of it is wrong. `SEED_DEMO_DATA` does not make `seedAll` a no-op — it gates the
// BOOT-TIME CALL to it in src/server.ts:106 (`if (config.seedDemoData)`), and `bun run seed` calls
// `seedAll` unconditionally regardless of the flag. The prod deployment sets it to "false"
// (gitops-production/clusters/strato/services/commonpractice/deployment.yaml), so prod never runs
// seedAll on a rollout at all. This file is about dev, CI and throwaway demo databases.
//
// ⛔ WHAT REDS THIS FILE:
//   • moving `seedEntitySamples()` back above `seedExampleBlocks()` in `seedAll`  → 1 binding, 0 mapped
//   • reverting `seed-datasets.ts`'s confirmed-mapping binding loop               → 1 binding, 0 mapped
import { test, expect, beforeAll, afterAll } from 'bun:test';
import postgres from 'postgres';

const BACKEND_ROOT = new URL('..', import.meta.url).pathname;
const SCRATCH_DB = 'cp_seed_first_boot_test';
const DEMO_TENANT_SLUG = 'common-practice-demo'; // mirrors seed-platform.ts

/** The dataset the seed binds with NO mapping — deliberately, see seed-datasets.ts. */
const UNMAPPED_DATASET = 'sample-claims';
/** The datasets `seedExampleBlocks` writes confirmed mappings for, which the bind loop then picks up. */
const MAPPED_DATASETS = ['example-claims', 'example-customers', 'example-policies'];

function withDatabase(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/** Run one of the package scripts against the scratch DB; throw its output if it fails. */
async function runAgainstScratch(script: string, scratchUrl: string): Promise<void> {
  const proc = Bun.spawn(['bun', 'run', script], {
    cwd: BACKEND_ROOT,
    // ⛔ BOTH URLs, NOT JUST `DATABASE_URL`. `config.ts` reads `MIGRATE_DATABASE_URL` and only
    // FALLS BACK to `DATABASE_URL`, so inheriting the parent's environment with one of the two
    // overridden points the migrator at whatever database the DEVELOPER had exported while the
    // seeder runs against the scratch one. The scratch DB then has no schema, the seed writes
    // nothing, and this file reports `[]` bindings — a failure that looks exactly like the ordering
    // defect it exists to catch. Measured: exporting `MIGRATE_DATABASE_URL` before `bun test` turns
    // 3 pass / 0 fail into 1 pass / 2 fail, on unmodified code. CI never sets it, so this was
    // green there and red on a developer machine, for a reason nothing on screen named.
    env: {
      ...process.env,
      DATABASE_URL: scratchUrl,
      MIGRATE_DATABASE_URL: scratchUrl,
      SEED_TENANT_SHOWCASE: 'false',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`\`bun run ${script}\` exited ${code}\n${out}\n${err}`);
}

interface Binding {
  dataset: string;
  storedMappingId: string | null;
  /** A human-confirmed mapping exists for this binding's exact (dataset, entity) pair. */
  pairMapped: boolean;
}

let bindings: Binding[] = [];
let skipped = false;

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks.
beforeAll(async () => {
  const base = process.env.DATABASE_URL;
  if (!base) {
    skipped = true;
    return;
  }
  const adminUrl = withDatabase(base, 'postgres');
  const scratchUrl = withDatabase(base, SCRATCH_DB);

  const admin = postgres(adminUrl, { max: 1 });
  try {
    // FORCE so a leaked connection from an earlier aborted run cannot wedge this (PG 13+).
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  } finally {
    await admin.end();
  }

  await runAgainstScratch('migrate', scratchUrl);
  await runAgainstScratch('seed', scratchUrl); // ← boot #1, and the only boot

  const sql = postgres(scratchUrl, { max: 1 });
  try {
    bindings = (await sql`
      SELECT d.slug AS dataset,
             s.mapping_id AS "storedMappingId",
             EXISTS (
               SELECT 1 FROM dataset_mappings m
               WHERE m.dataset_id = s.dataset_id
                 AND m.entity_id = s.entity_id
                 AND m.confirmed
             ) AS "pairMapped"
        FROM ontology_entity_samples s
        JOIN tenants  t ON t.id = s.tenant_id
        JOIN datasets d ON d.id = s.dataset_id
       WHERE t.slug = ${DEMO_TENANT_SLUG}
       ORDER BY d.slug
    `) as unknown as Binding[];
  } finally {
    await sql.end();
  }
}, 180_000);

afterAll(async () => {
  if (skipped || !process.env.DATABASE_URL) return;
  const admin = postgres(withDatabase(process.env.DATABASE_URL, 'postgres'), { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}, 60_000);

test('ONE boot binds every demo dataset that has a confirmed mapping, not just sample-claims', async () => {
  if (skipped) return;
  // ⛔ REDS IF `seed-datasets.ts`'s binding loop is reverted to main: `seedEntitySamples` then binds
  // exactly one dataset (`sample-claims`) and returns, leaving the three datasets whose confirmed
  // mappings `seedExampleBlocks` had just written unbound — the mappings sat there, reachable by
  // nothing. A seeded tenant could not trip the data contract at all.
  expect(
    bindings.map((b) => b.dataset).sort(),
    'the seed bound fewer datasets than it has confirmed mappings for',
  ).toEqual([...MAPPED_DATASETS, UNMAPPED_DATASET].sort());
});

test('ONE boot is enough — the bindings are LIVE on boot #1, not on boot #2', async () => {
  if (skipped) return;
  // ⛔ REDS IF `seedEntitySamples()` is moved back above `seedExampleBlocks()` in `seedAll`: the
  // example datasets and their confirmed mappings do not exist yet when the bind loop queries for
  // them, so this is 0 on a fresh database and only becomes 3 on the NEXT boot. Every other test
  // in the suite runs against an already-seeded database, which is exactly why reverting the
  // reorder was a green mutation.
  const mapped = bindings.filter((b) => b.pairMapped).map((b) => b.dataset).sort();
  expect(
    mapped,
    'no binding resolves to a confirmed mapping on the first boot — the demo tenant is inert ' +
      'until something reseeds it',
  ).toEqual([...MAPPED_DATASETS].sort());

  // The one that is deliberately NOT mapped stays that way: the Claims-dept overlay's attributes
  // (reserve, fraud_score, adjuster_notes) are not `sample-claims` columns, so there is genuinely
  // nothing to validate against and the validator skipping it is the correct answer, not a gap.
  expect(bindings.find((b) => b.dataset === UNMAPPED_DATASET)!.pairMapped).toBe(false);
});

test('the seed stores NO mapping_id — resolution belongs to the reader', async () => {
  if (skipped) return;
  // The seed passes `{datasetId, isPrimary}` and names no mapping, so there is no explicit override
  // to store. The bindings are live anyway because `validateInjectedAgainstOntology` resolves the
  // confirmed mapping on every run. If this ever goes non-null, write-time resolution has been
  // reintroduced and the bind-before-confirm and ON DELETE SET NULL decay paths are back with it —
  // see tests/ontology-sample-mapping-default.test.ts.
  expect(bindings.every((b) => b.storedMappingId === null)).toBe(true);
});
