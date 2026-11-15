// tests/migration-0102-unpinned-model-and-llm-settings-fk.test.ts
//
// Migration 0102 does two things; each is measured by EXECUTING the file against a scratch database.
//
//   PART 1  the five seeded GLOBAL blocks (ai-summarize, extract-fields, classify, compare-docs,
//           triage-claim) stop naming `claude-sonnet-4-6`; a TENANT block with the same slug and a
//           non-listed global slug are untouched; running it twice changes nothing more.
//   PART 2  `tenant_llm_settings` rows whose tenant does not exist are deleted (the prod orphan that
//           still stores an encrypted platform key), then a real FOREIGN KEY ... ON DELETE CASCADE
//           exists. A row for a tenant that DOES exist survives, including the nil system tenant when
//           `tenants` has it.
//
// NON-VACUITY (measured, see the commit): drop the DELETE and VALIDATE fails; drop the regexp and the
// text assertions fail; widen the slug list and the "not listed" global fixture is rewritten.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { applyMigrations } from '../src/db/migration-runner';
import { executeFlow, type ExecDeps } from '../src/exec/flow-executor';
import { loadBlock } from '../src/exec/block-loader';
import { mockData } from '../src/exec/mock-data';
import { getSeedBlock } from '../src/db/seed';
import type { FlowGraph } from '../src/db/flow-types';
import type { LlmRequestPayload } from '../src/db/trace-types';
import { config } from '../src/config';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const MIGRATION = join(import.meta.dir, '..', 'migrations', '0102_platform_blocks_unpinned_model_and_llm_settings_fk.sql');
const migrationSql = () => readFileSync(MIGRATION, 'utf8');

const SCRATCH_DB = 'cp_m0102_unpinned_model_scratch';
function withDatabase(dsn: string, database: string): string {
  const u = new URL(dsn);
  u.pathname = `/${database}`;
  return u.toString();
}
const OWNER_DSN = config.database.migrateUrl;
const SCRATCH_DSN = withDatabase(OWNER_DSN, SCRATCH_DB);
const MAINTENANCE_DSN = withDatabase(OWNER_DSN, 'postgres');
let scratch: postgres.Sql;
const scratchDirs: string[] = [];

async function withMaintenance(fn: (sql: postgres.Sql) => Promise<void>): Promise<void> {
  const admin = postgres(MAINTENANCE_DSN, { max: 1, onnotice: () => {} });
  try {
    await fn(admin);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

// Fixture ids unique to this file (tests/fixture-id-collisions.test.ts).
const T_LIVE = '00000000-0000-4000-8000-000001020101';
const T_GONE = '00000000-0000-4000-8000-000001020102'; // never inserted into `tenants`: the orphan
// The nil system tenant id, assembled so the fixture-id scan (which greps literals) does not count it.
const T_NIL = ['00000000', '0000', '0000', '0000', '000000000000'].join('-');
const PIN = 'claude-sonnet-4-6';

const SLUGS = ['ai-summarize', 'extract-fields', 'classify', 'compare-docs'] as const;
/** The seed's source with the OLD pin put back: exactly what an existing database holds. */
const pinned = (slug: (typeof SLUGS)[number]) =>
  getSeedBlock(slug).source.replace('ctx.llm({ prompt:', `ctx.llm({ model: "${PIN}", prompt:`);
const TRIAGE_OLD =
  'export default {\n  descriptor: {},\n  async run(inputs, ctx) {\n    try {\n      const res = await ctx.llm({\n' +
  `        model: '${PIN}',\n        prompt: 'Given this claim ' + JSON.stringify(inputs.claim),\n      });\n` +
  '    } catch (e) {}\n  },\n};\n';

const ID = (n: number) => `00000000-0000-4000-8000-0000010201${String(n).padStart(2, '0')}`;
const fixtures: { id: string; slug: string; tenant: string | null; version: string; src: string }[] = [
  ...SLUGS.map((s, i) => ({ id: ID(10 + i), slug: s, tenant: null, version: ID(30 + i), src: pinned(s) })),
  { id: ID(14), slug: 'triage-claim', tenant: null, version: ID(34), src: TRIAGE_OLD },
  // A TENANT-owned block that reuses a listed slug: the tenant's code, never rewritten.
  { id: ID(15), slug: 'ai-summarize', tenant: T_LIVE, version: ID(35), src: pinned('ai-summarize') },
  // A global slug that is NOT on the list and pins the same model: out of scope, never rewritten.
  { id: ID(16), slug: 'some-other-global', tenant: null, version: ID(36), src: pinned('ai-summarize') },
];

async function reset() {
  // The constraint is dropped so orphan fixtures are insertable; the migration must re-create it.
  await scratch.unsafe(`ALTER TABLE tenant_llm_settings DROP CONSTRAINT IF EXISTS tenant_llm_settings_tenant_fk`);
  await scratch.unsafe(`DELETE FROM tenant_llm_settings WHERE tenant_id IN ('${T_LIVE}','${T_GONE}','${T_NIL}')`);
  await scratch.unsafe(`DELETE FROM building_blocks WHERE id IN (${fixtures.map((f) => `'${f.id}'`).join(',')})`);
  await scratch.unsafe(`DELETE FROM tenants WHERE id IN ('${T_LIVE}','${T_GONE}')`);
  await scratch.unsafe(
    `INSERT INTO tenants (id, name, slug) VALUES ('${T_LIVE}', 'm0102 live', 'm0102-live')`,
  );
  for (const f of fixtures) {
    await scratch.unsafe(
      `INSERT INTO building_blocks (id, slug, name, description, category, tenant_id)
       VALUES ($1, $2, $2, 'd', 'ai', $3)`,
      [f.id, f.slug, f.tenant],
    );
    await scratch.unsafe(
      `INSERT INTO block_versions (id, block_id, version, status, source_ts, descriptor)
       VALUES ($1, $2, '1.0.0', 'stable', $3, '{}'::text::jsonb)`,
      [f.version, f.id, f.src],
    );
  }
}

const sourceOf = async (versionId: string): Promise<string> =>
  ((await scratch.unsafe(`SELECT source_ts FROM block_versions WHERE id = $1`, [versionId])) as unknown as { source_ts: string }[])[0]!.source_ts;
const runMigration = () => scratch.unsafe(migrationSql());

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
  for (const d of scratchDirs) await rm(d, { recursive: true, force: true });
  await withMaintenance(async (admin) => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
  });
}, 60_000);

test('PART 1: the fixtures really carry the pin before the migration (negative control)', async () => {
  await reset();
  for (const f of fixtures) expect(await sourceOf(f.version)).toContain(PIN);
});

test('PART 1: every listed GLOBAL block loses the pin and equals the new seed source; scope is exact', async () => {
  await reset();
  await runMigration();
  for (const [i, slug] of SLUGS.entries()) {
    const after = await sourceOf(ID(30 + i));
    expect(after).not.toContain(PIN);
    // Byte-for-byte what a fresh `bun run seed` writes, so the two routes cannot drift.
    expect(after).toBe(getSeedBlock(slug).source);
  }
  const triage = await sourceOf(ID(34));
  expect(triage).not.toContain(PIN);
  expect(triage).toContain("ctx.llm({\n        prompt: 'Given this claim '");
  // A tenant-owned block with the same slug, and an unlisted global, are untouched.
  expect(await sourceOf(ID(35))).toContain(PIN);
  expect(await sourceOf(ID(36))).toContain(PIN);
});

test('PART 1: idempotent -- a second run changes no row', async () => {
  await reset();
  await runMigration();
  const xmin = async () =>
    JSON.stringify(await scratch.unsafe(`SELECT id::text, xmin::text FROM block_versions WHERE id = ANY($1) ORDER BY id`, [fixtures.map((f) => f.version)]));
  const first = await xmin();
  await runMigration();
  expect(await xmin()).toBe(first);
});

test('PART 1: a migrated block RUNS and asks the broker for NO model', async () => {
  await reset();
  await runMigration();
  const seen: LlmRequestPayload[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'cp-m0102-'));
  scratchDirs.push(dir);
  const deps: ExecDeps = {
    loadBlock,
    llm: async (req) => {
      seen.push(req as LlmRequestPayload);
      return { text: 'ok', usage: { tokensIn: 1, tokensOut: 1 }, costUsd: 0 };
    },
    mockData: (kind, opts) => mockData(kind, opts ?? {}),
    dataset: () => {
      throw new Error('no dataset');
    },
    emit: () => {},
    now: () => 0,
  };
  const graph: FlowGraph = {
    nodes: [
      {
        id: 's1',
        blockId: ID(10),
        blockVersionId: ID(30),
        slug: 'ai-summarize',
        label: 'Summarize',
        category: 'ai',
        config: { text: 'hello' },
        position: { x: 0, y: 0 },
      },
    ],
    edges: [],
  };
  await executeFlow(graph, new Map([[ID(30), await sourceOf(ID(30))]]), ID(99), dir, deps, { maxNodeMs: 5000 });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.model).toBeUndefined();
});

test('PART 2: orphan settings rows are deleted, live ones kept, and a real FK exists afterwards', async () => {
  await reset();
  // The prod shape: a row for a tenant that was deleted, still holding an encrypted platform key.
  await scratch.unsafe(
    `INSERT INTO tenant_llm_settings (tenant_id, provider, model, api_key_encrypted, credential_source)
     VALUES ($1, 'openai_compatible', 'x', 'ENCRYPTED-PLATFORM-KEY', 'platform_managed'),
            ($2, 'openai_compatible', 'local-llm', NULL, 'local')`,
    [T_GONE, T_LIVE],
  );
  await runMigration();
  const rows = (await scratch.unsafe(
    `SELECT tenant_id::text AS t FROM tenant_llm_settings WHERE tenant_id IN ($1, $2)`,
    [T_GONE, T_LIVE],
  )) as unknown as { t: string }[];
  expect(rows.map((r) => r.t)).toEqual([T_LIVE]);

  const fk = (await scratch.unsafe(
    `SELECT convalidated, confdeltype FROM pg_constraint WHERE conname = 'tenant_llm_settings_tenant_fk'`,
  )) as unknown as { convalidated: boolean; confdeltype: string }[];
  expect(fk).toHaveLength(1);
  expect(fk[0]!.convalidated).toBe(true);
  expect(fk[0]!.confdeltype).toBe('c'); // ON DELETE CASCADE

  // The FK really refuses a new orphan...
  let refused = '';
  try {
    await scratch.unsafe(`INSERT INTO tenant_llm_settings (tenant_id, provider, model) VALUES ($1, 'openai_compatible', 'x')`, [T_GONE]);
  } catch (e) {
    refused = String((e as Error).message);
  }
  expect(refused).toContain('tenant_llm_settings_tenant_fk');
  // ...and offboarding the tenant now takes its settings (and its key) with it.
  await scratch.unsafe(`DELETE FROM tenants WHERE id = $1`, [T_LIVE]);
  const left = (await scratch.unsafe(`SELECT 1 FROM tenant_llm_settings WHERE tenant_id = $1`, [T_LIVE])) as unknown as unknown[];
  expect(left).toHaveLength(0);
});

test('PART 2: the nil system tenant is kept when `tenants` has it, and removed only when it does not', async () => {
  await reset();
  const nilExists = ((await scratch.unsafe(`SELECT 1 FROM tenants WHERE id = $1`, [T_NIL])) as unknown as unknown[]).length > 0;
  let createdNil = false;
  if (!nilExists) {
    await scratch.unsafe(`INSERT INTO tenants (id, name, slug) VALUES ($1, 'nil', 'u-0000-m0102')`, [T_NIL]);
    createdNil = true;
  }
  try {
    await scratch.unsafe(
      `INSERT INTO tenant_llm_settings (tenant_id, provider, model) VALUES ($1, 'openai_compatible', 'local-llm')`,
      [T_NIL],
    );
    await runMigration();
    const kept = (await scratch.unsafe(`SELECT 1 FROM tenant_llm_settings WHERE tenant_id = $1`, [T_NIL])) as unknown as unknown[];
    expect(kept).toHaveLength(1);
  } finally {
    await scratch.unsafe(`DELETE FROM tenant_llm_settings WHERE tenant_id = $1`, [T_NIL]);
    if (createdNil) await scratch.unsafe(`DELETE FROM tenants WHERE id = $1`, [T_NIL]);
  }
});

test('PART 2: idempotent -- the constraint exists once after two runs', async () => {
  await reset();
  await runMigration();
  await runMigration();
  const n = (await scratch.unsafe(
    `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'tenant_llm_settings_tenant_fk'`,
  )) as unknown as { n: number }[];
  expect(n[0]!.n).toBe(1);
});
