// tests/migration-0117-block-copy-jobs.test.ts — the hand-written block descriptions of 0117 survive
// an admin "Backfill all content".
//
// ⛔ WHY. The translation pipeline decides a cell is stale by `translation_jobs.source_hash` versus
// the sha256 of the current `en` text (host/translation-service.ts `enqueueTranslations`: the UPSERT
// resets a job to pending only `WHERE source_hash <> excluded.source_hash`). 0117 rewrote the `en`
// base and the 7 translations; had it left the jobs at the OLD source, a backfill would re-queue all
// 112 cells and the worker would overwrite the reviewed translations with machine output. 0117
// therefore stamps each job with the new text + a hash computed IN SQL. This pins that the SQL hash
// equals the service's `sourceHash()` of the rewritten base — i.e. exactly the comparison a
// backfill makes — and that a pre-existing stale job is overwritten, not left behind.
//
// ⛔ SCRATCH DATABASE (migration-0078 idiom). The first version ran on the shared test DB and went
// red in CI: tests/translation-pipeline.test.ts does a table-wide `DELETE FROM translation_jobs` in
// its `beforeEach`, concurrently. Delete section 3 of 0117 and this file goes red.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { applyMigrations } from '../src/db/migration-runner';
import { config } from '../src/config';
import { sourceHash } from '../src/host/translation-service';

const SLUGS = [
  'extract-fields', 'lookup-policy', 'flag-anomalies', 'format-output', 'classify', 'if-else',
  'review-panel', 'compare-docs', 'read-customer-record', 'filter-rows', 'group-and-count',
  'triage-claim', 'table-view', 'record-form', 'summary-card', 'load-dataset',
];
const LOCALES = ['nl', 'de', 'fr', 'es', 'pl', 'ar', 'he'];
const MIGRATION = readFileSync(join(import.meta.dir, '..', 'migrations', '0117_block_descriptions_plain_language.sql'), 'utf8');

const SCRATCH_DB = 'cp_m0117_block_jobs_scratch';
function withDatabase(dsn: string, database: string): string {
  const u = new URL(dsn);
  u.pathname = `/${database}`;
  return u.toString();
}
const OWNER_DSN = config.database.migrateUrl;
const SCRATCH_DSN = withDatabase(OWNER_DSN, SCRATCH_DB);
const MAINTENANCE_DSN = withDatabase(OWNER_DSN, 'postgres');
let scratch: postgres.Sql;

async function withMaintenance(fn: (sql: postgres.Sql) => Promise<void>): Promise<void> {
  const admin = postgres(MAINTENANCE_DSN, { max: 1, onnotice: () => {} });
  try {
    await fn(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
  });
  await applyMigrations(SCRATCH_DSN, { logger: { log: () => {}, warn: () => {}, error: console.error } });
  scratch = postgres(SCRATCH_DSN, { max: 1, onnotice: () => {} });
}, 180_000);

afterAll(async () => {
  await scratch?.end({ timeout: 5 });
  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  });
}, 60_000);

test('0117 stamps every rewritten cell’s job with the live base text’s hash, as done — no backfill re-queue', async () => {
  // Prod's shape: the global blocks carry the OLD text and their jobs the OLD hash.
  for (const slug of SLUGS) {
    await scratch.unsafe(
      `INSERT INTO building_blocks (slug, name, category, description) VALUES ($1, $1, 'logic', 'OLD jargon copy')`,
      [slug],
    );
  }
  await scratch.unsafe(
    `INSERT INTO translation_jobs (entity_type, entity_id, field, target_locale, source_text, source_hash, status)
     VALUES ('block', 'flag-anomalies', 'description', 'nl', 'OLD jargon copy', $1, 'done')
     ON CONFLICT (entity_type, entity_id, field, target_locale)
       DO UPDATE SET source_text = EXCLUDED.source_text, source_hash = EXCLUDED.source_hash`,
    [sourceHash('OLD jargon copy')],
  );

  await scratch.unsafe(MIGRATION);

  const blocks = (await scratch.unsafe(
    `SELECT slug, description FROM building_blocks WHERE tenant_id IS NULL`,
  )) as unknown as { slug: string; description: string }[];
  const live = new Map(blocks.map((b) => [b.slug, b.description]));
  expect(live.get('flag-anomalies')).not.toBe('OLD jargon copy');

  const jobs = (await scratch.unsafe(
    `SELECT entity_id, target_locale, source_text, source_hash, status FROM translation_jobs
      WHERE entity_type = 'block' AND field = 'description'`,
  )) as unknown as { entity_id: string; target_locale: string; source_text: string; source_hash: string; status: string }[];
  expect(jobs.length).toBe(SLUGS.length * LOCALES.length);
  for (const j of jobs) {
    const key = `${j.entity_id}/${j.target_locale}`;
    expect(j.status, key).toBe('done');
    expect(j.source_text, key).toBe(live.get(j.entity_id)!);
    // The comparison `enqueueTranslations` makes: equal ⇒ a backfill leaves the cell alone.
    expect(j.source_hash, key).toBe(sourceHash(live.get(j.entity_id)!));
  }
});
