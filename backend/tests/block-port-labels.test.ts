// tests/block-port-labels.test.ts — localized labels for block inputs/outputs (ports).
//
// What is pinned:
//   1. the descriptor schema accepts an optional `label` and still rejects unknown keys;
//   2. GET /api/blocks/:slug serves `portLabels` for the request locale, falling back to the
//      author's descriptor label, then to `en`, then to nothing (the client humanizes the key);
//   3. every port of every seeded global block has a label in all 8 locales (seeded-port-labels.ts),
//      and the seed put them in the database;
//   4. the seeder is INSERT-IF-MISSING: it restores a deleted cell and never rewrites an existing one
//      (a translator's correction survives every boot).
//
// REQUIRES a migrated + seeded database — the CI shape (`bun run migrate`, `bun run seed`, `bun run test`).
// Fixture ids use the `…0000b9a1e…` prefix, which no other test file uses (fixture-id-collisions.test.ts).
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { Router } from '../src/utils/router';
import { registerBlockRoutes } from '../src/routes/blocks';
import { db, buildingBlocks, blockVersions, contentTranslations } from '../src/db/client';
import type { BlockDescriptor } from '../src/db/block-types';
import type { User } from '../src/types';
import { descriptorSchema, fieldSpecSchema } from '../src/blocks/descriptor-schema';
import { SEEDED_GLOBAL_BLOCK_SLUGS } from '../src/blocks/seeded-global-blocks';
import { SEEDED_PORT_LABELS } from '../src/blocks/seeded-port-labels';
import { BLOCK_PORT_I18N, BLOCK_PORT_TENANT_I18N, blockPortI18nKey } from '../src/blocks/port-labels';
import { seedBlockPortLabels, seededPortLabelCells } from '../src/db/seed-block-port-labels';
import { SUPPORTED_LOCALES } from '../src/utils/locale';

const BLK = '00000000-0000-0000-0000-0000b9a1e001';
const VER_OLD = '00000000-0000-0000-0000-0000b9a1e002';
const VER_NEW = '00000000-0000-0000-0000-0000b9a1e003';
const VER_DRAFT = '00000000-0000-0000-0000-0000b9a1e004';
const SLUG = 'b9a1e-port-label-probe';

const reader: User = { id: '00000000-0000-0000-0000-0000b9a1e0a1', email: 'b9a1e@test', name: 'R', roles: ['member'] };

const router = new Router();
registerBlockRoutes(router);

async function getBlock(locale: string): Promise<{ status: number; json: any }> {
  const matched = router.match('GET', `/api/blocks/${SLUG}`);
  if (!matched) throw new Error('no route');
  const req = new Request(`http://localhost/api/blocks/${SLUG}`, { headers: { 'accept-language': locale } });
  const res = await matched.handler(req, ...matched.params);
  return { status: res.status, json: JSON.parse(await res.text()) };
}

const DESC_OLD: BlockDescriptor = {
  // An older, superseded version: its labels must NOT be served (the author removed `file`'s label
  // in the current version; `legacy_flag` no longer exists there).
  inputs: { legacy_flag: { type: 'boolean', label: 'Old author label' }, file: { type: 'string', label: 'Old file label' } },
  outputs: {},
  capabilities: {},
};
// The newest version, still a DRAFT and not current: its labels must not reach any reader.
const DESC_DRAFT: BlockDescriptor = {
  inputs: { force_ocr: { type: 'boolean', label: 'Draft label' }, file: { type: 'string' } },
  outputs: { text: { type: 'string', label: 'Draft text' }, pages: { type: 'number', label: 'Draft pages' } },
  capabilities: {},
};
const DESC_NEW: BlockDescriptor = {
  inputs: { force_ocr: { type: 'boolean' }, file: { type: 'string' } },
  outputs: { text: { type: 'string', label: 'Author text' }, pages: { type: 'number' } },
  capabilities: {},
};

async function cleanup(): Promise<void> {
  await db.delete(contentTranslations).where(eq(contentTranslations.entity_id, SLUG));
  await db.update(buildingBlocks).set({ current_version_id: null }).where(eq(buildingBlocks.id, BLK));
  await db.delete(blockVersions).where(inArray(blockVersions.id, [VER_OLD, VER_NEW, VER_DRAFT]));
  await db.delete(buildingBlocks).where(eq(buildingBlocks.id, BLK));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(buildingBlocks).values({
    id: BLK, slug: SLUG, name: 'Port label probe', description: 'probe', category: 'logic', tenant_id: null,
  });
  await db.insert(blockVersions).values([
    { id: VER_OLD, block_id: BLK, version: '1.0.0', status: 'stable', descriptor: DESC_OLD, created_at: new Date('2026-01-01') },
    { id: VER_NEW, block_id: BLK, version: '1.1.0', status: 'stable', descriptor: DESC_NEW, created_at: new Date('2026-02-01') },
    { id: VER_DRAFT, block_id: BLK, version: '1.2.0', status: 'draft', descriptor: DESC_DRAFT, created_at: new Date('2026-03-01') },
  ]);
  await db.update(buildingBlocks).set({ current_version_id: VER_NEW }).where(eq(buildingBlocks.id, BLK));
  await db.insert(contentTranslations).values([
    { entity_type: BLOCK_PORT_I18N, entity_id: SLUG, locale: 'nl', field: 'in.force_ocr', value: 'Altijd OCR gebruiken' },
    { entity_type: BLOCK_PORT_I18N, entity_id: SLUG, locale: 'en', field: 'in.force_ocr', value: 'Always use OCR' },
    { entity_type: BLOCK_PORT_I18N, entity_id: SLUG, locale: 'en', field: 'out.pages', value: 'Pages' },
    { entity_type: BLOCK_PORT_I18N, entity_id: SLUG, locale: 'nl', field: 'out.text', value: 'Herkende tekst' },
    { entity_type: BLOCK_PORT_I18N, entity_id: SLUG, locale: 'nl', field: 'in.legacy_flag', value: 'Oude vlag' },
    // An input and an output may share a key; the output row must not label the input.
    { entity_type: BLOCK_PORT_I18N, entity_id: SLUG, locale: 'nl', field: 'out.file', value: 'NOT-AN-INPUT-LABEL' },
    // A tenant-keyed row for the same slug must never be served on the global block.
    { entity_type: BLOCK_PORT_TENANT_I18N, entity_id: SLUG, locale: 'nl', field: 'in.file', value: 'TENANT-LEAK' },
  ]);
  __setAuthOverridesForTests({ validateAuth: async () => reader, requireRole: async () => reader });
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 30_000);

afterEach(() => {
  __setAuthOverridesForTests({ validateAuth: async () => reader, requireRole: async () => reader });
});

// ---- 1. schema ----

test('descriptor schema accepts an optional port label and still rejects unknown keys', () => {
  expect(fieldSpecSchema.safeParse({ type: 'boolean', label: 'Always use OCR' }).success).toBe(true);
  expect(fieldSpecSchema.safeParse({ type: 'boolean' }).success).toBe(true);
  expect(fieldSpecSchema.safeParse({ type: 'boolean', label: '   ' }).success).toBe(false);
  expect(fieldSpecSchema.safeParse({ type: 'boolean', label: 'x'.repeat(81) }).success).toBe(false);
  expect(fieldSpecSchema.safeParse({ type: 'boolean', labels: { nl: 'x' } }).success).toBe(false);
  expect(descriptorSchema.safeParse(DESC_NEW).success).toBe(true);
});

// ---- 2. route ----

test('nl request: the nl label is served', async () => {
  const { status, json } = await getBlock('nl');
  expect(status).toBe(200);
  expect(json.portLabels.inputs.force_ocr).toBe('Altijd OCR gebruiken');
  expect(json.portLabels.outputs.text).toBe('Herkende tekst');
});

test('nl request with no nl row: author label, then en, then nothing', async () => {
  const { json } = await getBlock('nl');
  expect(json.portLabels.outputs.pages, 'no nl row and no author label → the en row').toBe('Pages');
  expect(json.portLabels.inputs.legacy_flag, 'a superseded version’s port gets its translated label').toBe('Oude vlag');
  expect(json.portLabels.inputs, 'no label anywhere → absent (client humanizes the key)').not.toHaveProperty('file');
  expect(JSON.stringify(json.portLabels)).not.toContain('TENANT-LEAK');
  expect(JSON.stringify(json.portLabels.inputs)).not.toContain('NOT-AN-INPUT-LABEL');
});

test('pl request (no pl rows at all) falls back to en and the author label', async () => {
  const { json } = await getBlock('pl');
  expect(json.portLabels.inputs.force_ocr).toBe('Always use OCR');
  expect(json.portLabels.outputs.text).toBe('Author text');
});

test('the author label comes ONLY from the current version — not a newer draft, not an older version', async () => {
  const { json } = await getBlock('pl');
  // A draft (newer, not current) must not override the published label for every reader.
  expect(json.portLabels.inputs.force_ocr).toBe('Always use OCR');
  expect(json.portLabels.outputs.text).toBe('Author text');
  expect(json.portLabels.outputs.pages).toBe('Pages');
  expect(JSON.stringify(json.portLabels)).not.toContain('Draft');
  // A label the author removed in the current version must not come back from an older one.
  expect(json.portLabels.inputs).not.toHaveProperty('file');
  expect(json.portLabels.inputs, 'old-only port, no translation for pl/en, no current author label').not.toHaveProperty('legacy_flag');
  expect(JSON.stringify(json.portLabels)).not.toContain('Old ');
});

test('en request: the en row', async () => {
  const { json } = await getBlock('en');
  expect(json.portLabels.inputs.force_ocr).toBe('Always use OCR');
  expect(json.portLabels.outputs.text).toBe('Author text');
});

test('the descriptors in the response are NOT rewritten with resolved labels (the editor saves them back)', async () => {
  const { json } = await getBlock('nl');
  const cur = json.versions.find((v: { id: string }) => v.id === VER_NEW);
  expect(cur.descriptor.inputs.force_ocr).not.toHaveProperty('label');
  expect(cur.descriptor.outputs.text.label).toBe('Author text');
});

test('tenant blocks are keyed by tenant:slug, never by the bare slug', () => {
  expect(blockPortI18nKey({ tenant_id: null, slug: 'x' })).toEqual({ entityType: 'block_port', entityId: 'x' });
  expect(blockPortI18nKey({ tenant_id: 't1', slug: 'x' })).toEqual({ entityType: 'block_port_tenant', entityId: 't1:x' });
});

// ---- 3. coverage ----

test('every port of every seeded global block has a label in all 8 locales', async () => {
  expect(SEEDED_GLOBAL_BLOCK_SLUGS.length).toBeGreaterThanOrEqual(20);
  expect(SUPPORTED_LOCALES).toHaveLength(8);
  const rows = await db
    .select({ slug: buildingBlocks.slug, descriptor: blockVersions.descriptor })
    .from(buildingBlocks)
    .innerJoin(blockVersions, eq(blockVersions.id, buildingBlocks.current_version_id))
    .where(and(isNull(buildingBlocks.tenant_id), inArray(buildingBlocks.slug, [...SEEDED_GLOBAL_BLOCK_SLUGS])));
  expect(rows.length, 'the seeded global blocks must exist (run `bun run seed`)').toBe(SEEDED_GLOBAL_BLOCK_SLUGS.length);
  const missing: string[] = [];
  let ports = 0;
  for (const r of rows) {
    const labels = SEEDED_PORT_LABELS[r.slug];
    for (const [dir, specs] of [['inputs', r.descriptor.inputs], ['outputs', r.descriptor.outputs]] as const) {
      for (const key of Object.keys(specs)) {
        ports++;
        const tuple = labels?.[dir][key];
        if (!tuple || tuple.length !== 8 || tuple.some((v) => v.trim() === '')) missing.push(`${r.slug} ${dir}.${key}`);
      }
    }
  }
  expect(ports).toBeGreaterThan(50);
  expect(missing).toEqual([]);
  // And no label for a slug the seeders do not create (a typo would silently label nothing).
  expect(Object.keys(SEEDED_PORT_LABELS).filter((s) => !SEEDED_GLOBAL_BLOCK_SLUGS.includes(s))).toEqual([]);
});

test('the seed wrote every label cell into content_translations', async () => {
  const cells = seededPortLabelCells();
  expect(cells.length).toBeGreaterThan(400);
  const rows = await db
    .select({ entity_id: contentTranslations.entity_id, locale: contentTranslations.locale, field: contentTranslations.field })
    .from(contentTranslations)
    .where(eq(contentTranslations.entity_type, BLOCK_PORT_I18N));
  const have = new Set(rows.map((r) => `${r.entity_id}|${r.locale}|${r.field}`));
  const absent = cells.filter((c) => !have.has(`${c.entity_id}|${c.locale}|${c.field}`));
  expect(absent).toEqual([]);
});

// ---- 4. seeder never overwrites ----

test('seeding is insert-if-missing: it restores a deleted cell and never rewrites an existing one', async () => {
  const key = (locale: string) =>
    and(
      eq(contentTranslations.entity_type, BLOCK_PORT_I18N),
      eq(contentTranslations.entity_id, 'read-claim-form'),
      eq(contentTranslations.locale, locale),
      eq(contentTranslations.field, 'in.force_ocr'),
    );
  const [orig] = await db.select().from(contentTranslations).where(key('nl'));
  expect(orig?.value).toBe('Altijd OCR gebruiken');
  try {
    // A translator's correction, and a cell that went missing.
    await db.update(contentTranslations).set({ value: 'GECORRIGEERD' }).where(key('nl'));
    await db.delete(contentTranslations).where(key('de'));

    const first = await seedBlockPortLabels();
    expect(first.inserted).toBe(1);
    const [nl] = await db.select().from(contentTranslations).where(key('nl'));
    expect(nl?.value, 'the corrected cell must survive the seed').toBe('GECORRIGEERD');
    const [de] = await db.select().from(contentTranslations).where(key('de'));
    expect(de?.value).toBe('Immer OCR verwenden');

    const second = await seedBlockPortLabels();
    expect(second.inserted, 'a second run writes nothing').toBe(0);
    expect(second.total).toBe(first.total);
  } finally {
    await db.update(contentTranslations).set({ value: orig!.value }).where(key('nl'));
  }
}, 30_000);
