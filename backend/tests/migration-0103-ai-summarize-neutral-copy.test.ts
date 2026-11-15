// tests/migration-0103-ai-summarize-neutral-copy.test.ts
//
// Migration 0103: the GLOBAL `ai-summarize` block no longer says it runs on "Claude Sonnet" — in the
// `en` base columns (building_blocks.description, every block_versions.docs_md) nor in the 7 non-en
// `content_translations` editions 0073 committed. Since 0102 the block names no model; the broker runs
// the tenant's configured model or AGENT_MODEL (the platform's local router), never a fixed commercial one.
//
// Measured by EXECUTING the migrations against a scratch database (the shared test DB is not touched).
// NON-VACUITY: delete 0103 and the first test reds (applyMigrations leaves 0073's 14 rows); restore
// the old seed literal and the seed test reds.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { applyMigrations } from '../src/db/migration-runner';
import { config } from '../src/config';

const MIGRATION = join(import.meta.dir, '..', 'migrations', '0103_ai_summarize_neutral_model_copy.sql');
const migrationSql = () => readFileSync(MIGRATION, 'utf8');

const SCRATCH_DB = 'cp_m0103_ai_summarize_copy_scratch';
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

// Fixture ids unique to this file (tests/fixture-id-collisions.test.ts).
const T_OWNER = '00000000-0000-4000-8000-000001030101';
const B_GLOBAL = '00000000-0000-4000-8000-000001030110';
const B_TENANT = '00000000-0000-4000-8000-000001030111';
const V_GLOBAL_1 = '00000000-0000-4000-8000-000001030120';
const V_GLOBAL_2 = '00000000-0000-4000-8000-000001030121';
const V_TENANT = '00000000-0000-4000-8000-000001030122';

const OLD_DESC = 'Calls Claude Sonnet to produce a length-controlled summary. Configurable: tone, max lines, language.';
const OLD_DOCS = '# ai-summarize\n\nProduces a length-controlled summary via Claude Sonnet. Configure `tone` and `max_lines`.';
const NEW_DESC = 'Calls the configured LLM to produce a length-controlled summary. Configurable: tone, max lines, language.';
const NEW_DOCS = '# ai-summarize\n\nProduces a length-controlled summary via the configured LLM. Configure `tone` and `max_lines`.';
const LOCALES = ['nl', 'de', 'fr', 'es', 'pl', 'ar', 'he'];

type Row = { locale: string; field: string; value: string };
const translations = async (): Promise<Row[]> =>
  (await scratch.unsafe(
    `SELECT locale, field, value FROM content_translations
      WHERE entity_type = 'block' AND entity_id = 'ai-summarize' AND field IN ('description', 'docs_md')
      ORDER BY field, locale`,
  )) as unknown as Row[];

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

test('after all migrations, no ai-summarize description/docs_md translation names Claude Sonnet — in all 7 locales', async () => {
  const rows = await translations();
  // NON-VACUITY: 0073 seeds 7 locales x 2 fields; an empty set would pass the sweep for free.
  expect(rows.map((r) => `${r.field}/${r.locale}`).sort()).toEqual(
    [...LOCALES.map((l) => `description/${l}`), ...LOCALES.map((l) => `docs_md/${l}`)].sort(),
  );
  for (const r of rows) {
    expect(r.value, `${r.field}/${r.locale}`).not.toMatch(/claude|sonnet/i);
    expect(r.value, `${r.field}/${r.locale} must still name the LLM it uses`).toContain('LLM');
  }
  // docs keep their heading (the slug is a stable identifier).
  for (const r of rows.filter((x) => x.field === 'docs_md')) expect(r.value.startsWith('# ai-summarize\n\n')).toBe(true);
});

test('the GLOBAL base rows are rewritten to the seed literal (every version); a tenant block is untouched; idempotent', async () => {
  await scratch.unsafe(`DELETE FROM building_blocks WHERE id IN ('${B_GLOBAL}', '${B_TENANT}')`);
  await scratch.unsafe(`DELETE FROM tenants WHERE id = '${T_OWNER}'`);
  await scratch.unsafe(`INSERT INTO tenants (id, name, slug) VALUES ('${T_OWNER}', 'm0103 owner', 'm0103-owner')`);
  for (const [id, tenant] of [
    [B_GLOBAL, null],
    [B_TENANT, T_OWNER],
  ] as const) {
    await scratch.unsafe(
      `INSERT INTO building_blocks (id, slug, name, description, category, tenant_id)
       VALUES ($1, 'ai-summarize', 'Summarize with AI', $2, 'ai', $3)`,
      [id, OLD_DESC, tenant],
    );
  }
  for (const [vid, bid, ver] of [
    [V_GLOBAL_1, B_GLOBAL, '3.0.0'],
    [V_GLOBAL_2, B_GLOBAL, '3.1.0'],
    [V_TENANT, B_TENANT, '1.0.0'],
  ] as const) {
    await scratch.unsafe(
      `INSERT INTO block_versions (id, block_id, version, status, source_ts, docs_md, descriptor)
       VALUES ($1, $2, $3, 'stable', 'export default {}', $4, '{}'::text::jsonb)`,
      [vid, bid, ver, OLD_DOCS],
    );
  }
  // Put the old claim back into the translations too: what an existing (prod) database holds.
  await scratch.unsafe(
    `UPDATE content_translations SET value = value || ' Claude Sonnet'
      WHERE entity_type = 'block' AND entity_id = 'ai-summarize' AND field IN ('description', 'docs_md')`,
  );
  expect((await translations()).every((r) => r.value.includes('Claude Sonnet'))).toBe(true);

  await scratch.unsafe(migrationSql());
  await scratch.unsafe(migrationSql()); // idempotent: a second run must not fail its own post-check

  const blocks = (await scratch.unsafe(
    `SELECT id::text, description FROM building_blocks WHERE id IN ('${B_GLOBAL}', '${B_TENANT}')`,
  )) as unknown as { id: string; description: string }[];
  expect(blocks.find((b) => b.id === B_GLOBAL)!.description).toBe(NEW_DESC);
  expect(blocks.find((b) => b.id === B_TENANT)!.description).toBe(OLD_DESC);
  const versions = (await scratch.unsafe(
    `SELECT id::text, docs_md FROM block_versions WHERE id IN ('${V_GLOBAL_1}', '${V_GLOBAL_2}', '${V_TENANT}')`,
  )) as unknown as { id: string; docs_md: string }[];
  expect(versions.find((v) => v.id === V_GLOBAL_1)!.docs_md).toBe(NEW_DOCS);
  expect(versions.find((v) => v.id === V_GLOBAL_2)!.docs_md).toBe(NEW_DOCS);
  expect(versions.find((v) => v.id === V_TENANT)!.docs_md).toBe(OLD_DOCS);
  for (const r of await translations()) expect(r.value, `${r.field}/${r.locale}`).not.toMatch(/claude sonnet/i);
});

test('the seed literal (fresh databases) carries the SAME neutral copy and no Claude Sonnet', () => {
  // Read as TEXT (as tests/seed-block-copy-honesty.test.ts does): `getSeedBlock` exposes no prose, and
  // the point is that the two routes (seed for a fresh DB, 0103 for an existing one) cannot drift.
  const text = readFileSync(join(import.meta.dir, '..', 'src', 'db', 'seed.ts'), 'utf8');
  expect(text.length).toBeGreaterThan(1000);
  expect(text).not.toContain('Claude Sonnet');
  expect(text).toContain(`'${NEW_DESC}'`);
  expect(text).toContain(`'${NEW_DOCS.replace(/\n/g, '\\n')}'`);
});
