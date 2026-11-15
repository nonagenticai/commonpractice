// tests/block-i18n-tenant-key.test.ts — the block-translation tenant leak (migrations 0060/0061).
//
// THE BUG. `content_translations` (0008_ai-substrate.sql:181-189) is
// PRIMARY KEY (entity_type, entity_id, locale, field) with no tenant column and no RLS — it is on
// 0028_rls.sql:23's explicit platform-exemption list, written when `building_blocks` was global and
// its slug was globally UNIQUE. 0037 changed both halves of that premise and left this table
// behind: it moved blocks into RLS with dual ownership AND DELIBERATELY DROPPED global slug
// uniqueness (0037:32-34) so two tenants may own the same slug. Block translations stayed keyed by
// the BARE SLUG, so tenant B publishing `invoice-parser` overwrote tenant A's row and A's users on
// any non-`en` locale were served B's `docs_md` — the whole document.
//
// ⛔ THIS TEST MUST BE ROUTE-LEVEL, AND THAT IS NOT A STYLE PREFERENCE.
// `content_translations` is outside RLS BY DESIGN, so there is no policy for a raw-SQL isolation
// test (the tests/rls-*.test.ts shape) to violate — such a test passes identically against the
// broken and the fixed code, i.e. it is vacuous by construction. The isolation here is a property
// of the ROUTE's key derivation, so the route is what has to be driven.
//
// ⛔ AND IT MUST RUN UNDER cp_app. Backend tests connect as the table OWNER (`rolbypassrls`), where
// RLS is inert — and `loadBlockBySlug` (blocks/authoring-service.ts:102-110) has NO tenant
// predicate: it relies entirely on RLS to scope which of the two same-slug rows it returns. On the
// owner connection it would happily return the other tenant's block, so the test would be
// measuring the wrong thing entirely. `withTenantDbAsRuntimeRoleForTests` SET ROLEs cp_app, which
// is what makes these assertions mean what they say.
//
// Fixture ids use the `…00000b60…` prefix (0060), which no other test file uses — see
// tests/fixture-id-collisions.test.ts for why that matters (bun runs files against ONE database).
//
// ⛔ Deliberately asserts NOTHING about `translation_jobs`: tests/translation-pipeline.test.ts does
// an unconditional table-wide `db.delete(translationJobs)` in its `beforeEach`, so any cross-file
// assertion on that table is a guaranteed flake. The publish→job-key assertion lives there instead.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerBlockRoutes } from '../src/routes/blocks';
import {
  db,
  tenants,
  users,
  buildingBlocks,
  blockVersions,
  contentTranslations,
  withTenantDbAsRuntimeRoleForTests,
} from '../src/db/client';
import { emptyDescriptor } from '../src/db/block-types';
import type { User } from '../src/types';

const TENANT_A = '00000000-0000-0000-0000-00000b60a001';
const TENANT_B = '00000000-0000-0000-0000-00000b60b001';
const USER_A = '00000000-0000-0000-0000-00000b60a0a1';
const USER_B = '00000000-0000-0000-0000-00000b60b0a1';
const BLK_A = '00000000-0000-0000-0000-00000b60a01a';
const BLK_B = '00000000-0000-0000-0000-00000b60b01a';
const VER_A = '00000000-0000-0000-0000-00000b60a01b';
const VER_B = '00000000-0000-0000-0000-00000b60b01b';

/** The whole point: ONE slug, owned by BOTH tenants. Legal since 0037. */
const SLUG = 'b60-invoice-parser';

const userA: User = { id: USER_A, email: 'b60a@test', name: 'A', roles: ['developer'] };
const userB: User = { id: USER_B, email: 'b60b@test', name: 'B', roles: ['developer'] };

function asUser(u: User) {
  __setAuthOverridesForTests({
    validateAuth: async () => u,
    requireRole: async () => u,
  });
}

const router = new Router();
registerBlockRoutes(router);

async function call(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, { method, headers });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const NL = { 'accept-language': 'nl' };

async function cleanup(): Promise<void> {
  await db
    .delete(contentTranslations)
    .where(
      inArray(contentTranslations.entity_id, [
        SLUG,
        `${TENANT_A}:${SLUG}`,
        `${TENANT_B}:${SLUG}`,
      ]),
    );
  // Drop the back-pointer before the versions, else `building_blocks_current_version_fk` blocks it.
  await db
    .update(buildingBlocks)
    .set({ current_version_id: null })
    .where(inArray(buildingBlocks.id, [BLK_A, BLK_B]));
  await db.delete(blockVersions).where(inArray(blockVersions.id, [VER_A, VER_B]));
  await db.delete(buildingBlocks).where(inArray(buildingBlocks.id, [BLK_A, BLK_B]));
  await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'B60 A', slug: 'b60-tenant-a' },
    { id: TENANT_B, name: 'B60 B', slug: 'b60-tenant-b' },
  ]);
  await db.insert(users).values([
    { id: USER_A, email: 'b60a@test', name: 'A', tenant_id: TENANT_A },
    { id: USER_B, email: 'b60b@test', name: 'B', tenant_id: TENANT_B },
  ]);
  // `building_blocks.current_version_id` and `block_versions.block_id` reference each other, so
  // the blocks go in first WITHOUT a current version, then the versions, then the back-pointer.
  //
  // ⛔ These two INSERTs are themselves an assertion: they are only legal because 0037 dropped
  // global slug uniqueness. If either ever raises a unique violation the premise of this whole
  // file has changed, and it should fail loudly here rather than silently pass later.
  await db.insert(buildingBlocks).values([
    {
      id: BLK_A, slug: SLUG, name: 'A Parser', description: 'A desc', category: 'logic',
      tenant_id: TENANT_A, maintainer_id: USER_A,
    },
    {
      id: BLK_B, slug: SLUG, name: 'B Parser', description: 'B desc', category: 'logic',
      tenant_id: TENANT_B, maintainer_id: USER_B,
    },
  ]);
  await db.insert(blockVersions).values([
    {
      id: VER_A, block_id: BLK_A, version: '1.0.0', docs_md: 'EN-A-DOCS',
      status: 'stable', descriptor: emptyDescriptor(),
    },
    {
      id: VER_B, block_id: BLK_B, version: '1.0.0', docs_md: 'EN-B-DOCS',
      status: 'stable', descriptor: emptyDescriptor(),
    },
  ]);
  await db.update(buildingBlocks).set({ current_version_id: VER_A }).where(eq(buildingBlocks.id, BLK_A));
  await db.update(buildingBlocks).set({ current_version_id: VER_B }).where(eq(buildingBlocks.id, BLK_B));

  // What a real drain leaves behind once both tenants have published: a correct row per tenant
  // under the new key, PLUS the legacy bare-slug row that 0060 leaves in place for the rolling
  // window — here holding B's value, because B published last and won the upsert. Written
  // directly rather than through the queue so this file never races translation-pipeline.test.ts.
  await db.insert(contentTranslations).values([
    { entity_type: 'block_tenant', entity_id: `${TENANT_A}:${SLUG}`, locale: 'nl', field: 'docs_md', value: 'NL-A-DOCS' },
    { entity_type: 'block_tenant', entity_id: `${TENANT_A}:${SLUG}`, locale: 'nl', field: 'name', value: 'NL-A-NAME' },
    { entity_type: 'block_tenant', entity_id: `${TENANT_B}:${SLUG}`, locale: 'nl', field: 'docs_md', value: 'NL-B-DOCS' },
    { entity_type: 'block_tenant', entity_id: `${TENANT_B}:${SLUG}`, locale: 'nl', field: 'name', value: 'NL-B-NAME' },
    { entity_type: 'block', entity_id: SLUG, locale: 'nl', field: 'docs_md', value: 'NL-B-DOCS' },
    { entity_type: 'block', entity_id: SLUG, locale: 'nl', field: 'name', value: 'NL-B-NAME' },
  ]);
}, 30_000);

afterAll(cleanup, 30_000);
afterEach(() => __setAuthOverridesForTests(undefined));

test('detail route: tenant A is served A’s document, never B’s — THE LEAK', async () => {
  asUser(userA);
  const { json } = await withTenantDbAsRuntimeRoleForTests(TENANT_A, () =>
    call('GET', `/api/blocks/${SLUG}`, NL),
  );
  const current = json.versions.find((v: { id: string }) => v.id === VER_A);
  expect(
    current?.docs_md,
    "tenant A must be served A's docs_md. Pre-fix the overlay read the bare slug and returned " +
      "B's entire document.",
  ).toBe('NL-A-DOCS');
  expect(current?.docs_md).not.toBe('NL-B-DOCS');
  expect(json.name).toBe('NL-A-NAME');
});

test('detail route: tenant B still gets its own — the symmetric direction', async () => {
  // ⛔ This case PASSES pre-fix, because B is the poisoner: the bare-slug row already holds B's
  // value. It is kept as a no-regression check, but the case above is the one carrying the proof.
  // Do not "simplify" this file down to this test.
  asUser(userB);
  const { json } = await withTenantDbAsRuntimeRoleForTests(TENANT_B, () =>
    call('GET', `/api/blocks/${SLUG}`, NL),
  );
  const current = json.versions.find((v: { id: string }) => v.id === VER_B);
  expect(current?.docs_md).toBe('NL-B-DOCS');
  expect(json.name).toBe('NL-B-NAME');
});

test('a missing tenant translation falls through to the EN base, NOT to the bare-slug row', async () => {
  // ⛔ THE REGRESSION GUARD. This is the test that fails if someone later adds a
  // `?? globalTx.get(b.slug)` "for safety" — a bare-slug fallback re-serves the poisoned row and
  // silently reinstates the entire bug. Removing A's rows leaves the legacy ('block', SLUG) row —
  // still holding B's value — as the only thing a fallback could find.
  await db
    .delete(contentTranslations)
    .where(
      and(
        eq(contentTranslations.entity_type, 'block_tenant'),
        eq(contentTranslations.entity_id, `${TENANT_A}:${SLUG}`),
      ),
    );

  asUser(userA);
  const { json } = await withTenantDbAsRuntimeRoleForTests(TENANT_A, () =>
    call('GET', `/api/blocks/${SLUG}`, NL),
  );
  const current = json.versions.find((v: { id: string }) => v.id === VER_A);
  expect(
    current?.docs_md,
    'an untranslated tenant block must degrade to its EN base column, never to the bare-slug row',
  ).toBe('EN-A-DOCS');
  expect(json.name).toBe('A Parser');

  // restore for any later test in this file
  await db.insert(contentTranslations).values([
    { entity_type: 'block_tenant', entity_id: `${TENANT_A}:${SLUG}`, locale: 'nl', field: 'docs_md', value: 'NL-A-DOCS' },
    { entity_type: 'block_tenant', entity_id: `${TENANT_A}:${SLUG}`, locale: 'nl', field: 'name', value: 'NL-A-NAME' },
  ]);
});

test('list route is keyed by ownership too — catches a detail-only fix', async () => {
  // The list read site is separate from the detail one, and `blocks` there is the RLS-scoped
  // global ∪ own-tenant set, so a single bare-slug batch mixes both ownerships. A fix applied only
  // to the detail route leaves this leaking.
  asUser(userA);
  const { json } = await withTenantDbAsRuntimeRoleForTests(TENANT_A, () =>
    call('GET', '/api/blocks', NL),
  );
  const mine = (json.items as { slug: string; name: string }[]).find((b) => b.slug === SLUG);
  expect(mine, `tenant A should see its own '${SLUG}' in the list`).toBeDefined();
  expect(mine!.name, "the list overlay must use A's translation, not B's").toBe('NL-A-NAME');
});

test('GLOBAL blocks keep the bare-slug key — no regression for platform i18n', async () => {
  // ⛔ Guards the opposite mistake: rewriting EVERY block read to the tenant key, which would
  // silently kill localization for every platform block (they have tenant_id NULL and their rows
  // are, correctly, keyed by the bare slug).
  const [globalBlock] = await db
    .select({ slug: buildingBlocks.slug, name: buildingBlocks.name })
    .from(buildingBlocks)
    .where(isNull(buildingBlocks.tenant_id))
    .limit(1);
  if (!globalBlock) {
    throw new Error(
      'no global block in the seeded DB — this case would assert nothing. Run `bun run seed`.',
    );
  }

  // ⛔ THE FIXTURE IS A REAL, SHARED ROW — CAPTURE IT BEFORE CLOBBERING IT.
  // `limit(1)` with no ORDER BY picks an ARBITRARY seeded platform block, and this case overwrites
  // that block's nl `name` translation. When this file was written no such row existed (0060's own
  // measurement: 14 block rows, none seeded by any migration), so the cleanup below could simply
  // DELETE. Migration 0073 changed that premise: every global block now ships a real nl name, and
  // an unconditional delete silently destroyed one of them for every later test file in the run —
  // making tests/block-i18n-coverage.test.ts red or green purely on bun's file ordering. Restore
  // what was there; delete only when there genuinely was nothing.
  const [priorGlobalName] = await db
    .select({ value: contentTranslations.value })
    .from(contentTranslations)
    .where(
      and(
        eq(contentTranslations.entity_type, 'block'),
        eq(contentTranslations.entity_id, globalBlock.slug),
        eq(contentTranslations.locale, 'nl'),
        eq(contentTranslations.field, 'name'),
      ),
    );

  await db
    .insert(contentTranslations)
    .values({
      entity_type: 'block',
      entity_id: globalBlock.slug,
      locale: 'nl',
      field: 'name',
      value: 'NL-GLOBAL-NAME',
    })
    .onConflictDoUpdate({
      target: [
        contentTranslations.entity_type,
        contentTranslations.entity_id,
        contentTranslations.locale,
        contentTranslations.field,
      ],
      set: { value: 'NL-GLOBAL-NAME' },
    });

  asUser(userA);
  const { json } = await withTenantDbAsRuntimeRoleForTests(TENANT_A, () =>
    call('GET', `/api/blocks/${globalBlock.slug}`, NL),
  );
  expect(json.name, 'a global block must still resolve its bare-slug translation').toBe(
    'NL-GLOBAL-NAME',
  );

  if (priorGlobalName) {
    await db
      .update(contentTranslations)
      .set({ value: priorGlobalName.value })
      .where(
        and(
          eq(contentTranslations.entity_type, 'block'),
          eq(contentTranslations.entity_id, globalBlock.slug),
          eq(contentTranslations.locale, 'nl'),
          eq(contentTranslations.field, 'name'),
        ),
      );
  } else {
    await db
      .delete(contentTranslations)
      .where(
        and(
          eq(contentTranslations.entity_type, 'block'),
          eq(contentTranslations.entity_id, globalBlock.slug),
          eq(contentTranslations.locale, 'nl'),
          eq(contentTranslations.field, 'name'),
        ),
      );
  }
});
