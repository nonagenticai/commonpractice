// tests/migration-0116-platform-block-author.test.ts — platform blocks never credit a seeded person.
//
// ⛔ WHAT WENT WRONG. seed.ts stamped every GLOBAL catalog block with an invented "maintainer" —
// Mo Hassan, Tom Kemper, Peter Janssen, Hannah Vos — as `maintainer_id` and as each version's
// `published_by`. Every tenant, including a brand-new external org on its first login (prod walk
// 2026-10-16), read "Tom Kemper" on the shared block cards as the author. Tom Kemper is a real
// person (memory: the 2026-08-09 fabricated-history purge). A platform block is authored by the
// platform; with both columns NULL every surface renders "Platform".
//
// Two halves, two databases:
//   • SEED (shared, freshly seeded test DB): every global block the seeders ship has no person as
//     maintainer or publisher. Restore `maintainer_id: maintainerIds.get(b.maintainer)` in seed.ts
//     and this goes red.
//   • MIGRATION 0116 (scratch DB, real runner): the PRE-fix rows are planted and the shipped SQL is
//     executed. It clears exactly the seed identities on GLOBAL blocks, keeps a tenant's own author,
//     keeps a real (Keycloak-linked) maintainer of a global block, and is idempotent.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { and, inArray, isNull } from 'drizzle-orm';
import { applyMigrations } from '../src/db/migration-runner';
import { config } from '../src/config';
import { db, buildingBlocks, blockVersions } from '../src/db/client';
import { SEED_CATALOG_BLOCK_SLUGS } from '../src/db/seed';

// The example blocks seed-example-blocks.ts / seed-datasets.ts ship as GLOBAL rows.
const EXAMPLE_SLUGS = ['filter-rows', 'group-and-count', 'triage-claim', 'rows-to-csv', 'compose-claim-decision', 'table-view', 'record-form', 'summary-card', 'load-dataset'];

test('SEED: no platform block shipped by the seeders names a person as maintainer or publisher', async () => {
  const slugs = [...SEED_CATALOG_BLOCK_SLUGS, ...EXAMPLE_SLUGS];
  const blocks = await db
    .select({ id: buildingBlocks.id, slug: buildingBlocks.slug, maintainer: buildingBlocks.maintainer_id })
    .from(buildingBlocks)
    .where(and(inArray(buildingBlocks.slug, slugs), isNull(buildingBlocks.tenant_id)));
  // Not vacuous: the catalog really is seeded in this database.
  expect(blocks.length).toBeGreaterThanOrEqual(SEED_CATALOG_BLOCK_SLUGS.length);
  expect(blocks.filter((b) => b.maintainer !== null).map((b) => b.slug)).toEqual([]);
  const versions = await db
    .select({ block: blockVersions.block_id, by: blockVersions.published_by })
    .from(blockVersions)
    .where(inArray(blockVersions.block_id, blocks.map((b) => b.id)));
  expect(versions.length).toBeGreaterThan(0);
  expect(versions.filter((v) => v.by !== null)).toEqual([]);
});

// ---------------------------------------------------------------------------------------------
// MIGRATION 0116 — scratch database (migration-0078 idiom), never the shared one.
// ---------------------------------------------------------------------------------------------

const SCRATCH_DB = 'cp_m0116_block_author_scratch';
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

// Fixture ids unique to this file — see tests/fixture-id-collisions.test.ts.
const TENANT = '00000000-0000-4000-8000-000001160101';
const U_TOM = '00000000-0000-4000-8000-000001160110'; // the seed identity
const U_REAL = '00000000-0000-4000-8000-000001160111'; // a real, Keycloak-linked platform author
const B_GLOBAL_SEEDED = '00000000-0000-4000-8000-000001160120';
const B_TENANT_SEEDED = '00000000-0000-4000-8000-000001160121';
const B_GLOBAL_REAL = '00000000-0000-4000-8000-000001160122';
const V_GLOBAL_SEEDED = '00000000-0000-4000-8000-000001160130';
const V_TENANT_SEEDED = '00000000-0000-4000-8000-000001160131';
const V_GLOBAL_REAL = '00000000-0000-4000-8000-000001160132';

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

const MIGRATION = readFileSync(join(import.meta.dir, '..', 'migrations', '0116_platform_blocks_no_person_author.sql'), 'utf8');

async function plant(): Promise<void> {
  await scratch.unsafe(`INSERT INTO tenants (id, name, slug) VALUES ('${TENANT}', 'M0116', 'm0116')`);
  await scratch.unsafe(
    `INSERT INTO users (id, email, name, keycloak_sub) VALUES
       ('${U_TOM}', 'tom@commonpractice.local', 'Tom Kemper', NULL),
       ('${U_REAL}', 'platform-author@m0116.test', 'Real Author', 'kc-m0116-real')`,
  );
  const blocks: [string, string, string | null, string][] = [
    [B_GLOBAL_SEEDED, 'm0116-global-seeded', null, U_TOM],
    [B_TENANT_SEEDED, 'm0116-tenant-seeded', TENANT, U_TOM],
    [B_GLOBAL_REAL, 'm0116-global-real', null, U_REAL],
  ];
  for (const [id, slug, tenant, maint] of blocks) {
    await scratch.unsafe(
      `INSERT INTO building_blocks (id, slug, name, category, tenant_id, maintainer_id)
       VALUES ('${id}', '${slug}', '${slug}', 'logic', ${tenant ? `'${tenant}'` : 'NULL'}, '${maint}')`,
    );
  }
  const versions: [string, string, string][] = [
    [V_GLOBAL_SEEDED, B_GLOBAL_SEEDED, U_TOM],
    [V_TENANT_SEEDED, B_TENANT_SEEDED, U_TOM],
    [V_GLOBAL_REAL, B_GLOBAL_REAL, U_REAL],
  ];
  for (const [id, block, by] of versions) {
    await scratch.unsafe(
      `INSERT INTO block_versions (id, block_id, version, descriptor, source_ts, published_by)
       VALUES ('${id}', '${block}', '1.0.0', '{}'::jsonb, '', '${by}')`,
    );
  }
}

async function authorOf(block: string, version: string) {
  const [b] = (await scratch.unsafe(`SELECT maintainer_id::text AS m FROM building_blocks WHERE id = '${block}'`)) as unknown as { m: string | null }[];
  const [v] = (await scratch.unsafe(`SELECT published_by::text AS p FROM block_versions WHERE id = '${version}'`)) as unknown as { p: string | null }[];
  return { maintainer: b!.m, publisher: v!.p };
}

test('0116 clears the seed identity on GLOBAL blocks only, and keeps real and tenant authors', async () => {
  await plant();
  expect(await authorOf(B_GLOBAL_SEEDED, V_GLOBAL_SEEDED)).toEqual({ maintainer: U_TOM, publisher: U_TOM });

  await scratch.unsafe(MIGRATION);
  expect(await authorOf(B_GLOBAL_SEEDED, V_GLOBAL_SEEDED)).toEqual({ maintainer: null, publisher: null });
  // A tenant's own block keeps whoever wrote it, even a seed user.
  expect(await authorOf(B_TENANT_SEEDED, V_TENANT_SEEDED)).toEqual({ maintainer: U_TOM, publisher: U_TOM });
  // A real platform author is not a seed identity.
  expect(await authorOf(B_GLOBAL_REAL, V_GLOBAL_REAL)).toEqual({ maintainer: U_REAL, publisher: U_REAL });

  // Idempotent: a second run (every replica runs migrations at boot) changes nothing.
  await scratch.unsafe(MIGRATION);
  expect(await authorOf(B_TENANT_SEEDED, V_TENANT_SEEDED)).toEqual({ maintainer: U_TOM, publisher: U_TOM });
  expect(await authorOf(B_GLOBAL_REAL, V_GLOBAL_REAL)).toEqual({ maintainer: U_REAL, publisher: U_REAL });
  // The users themselves are untouched (other demo seeders still look tom@… up).
  const [u] = (await scratch.unsafe(`SELECT name FROM users WHERE id = '${U_TOM}'`)) as unknown as { name: string }[];
  expect(u!.name).toBe('Tom Kemper');
});
