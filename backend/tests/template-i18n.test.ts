// tests/template-i18n.test.ts — the starter-template catalog, in the reader's language.
//
// ⛔ THE DEFECT. `/block-edit` → "From template" renders 20 seeded starter templates. In PRODUCTION
// `block_templates` held 20 rows and `content_translations` held ZERO template rows;
// routes/templates.ts had no locale handling at all, and templates-service sorted on
// `a.label.localeCompare(b.label)` over the ENGLISH label. So a Dutch author was shown English
// cards titled `validate-record`, `route-by-rule`, `approve-reject`. Picking one then COPIED that
// English label into their new block's name, the description into its description and the docs into
// its docs (frontend applyTemplate), so the miss was written permanently into the author's own work.
//
// ⛔ WHAT EACH CASE IS ACTUALLY GUARDING — THE PLACEMENT, NOT THE EXISTENCE, OF THE OVERLAY.
// "Dutch labels come back" is satisfied by an overlay applied anywhere in `listTemplates`, including
// the two places that are silently wrong. The two ORDERING cases below are the real subjects:
//   * `q` must be matched against the LOCALIZED prose. An overlay applied AFTER the filter answers
//     an empty gallery for text the reader can see on their screen.
//   * the sort must run on the LOCALIZED label. An overlay applied AFTER the sort produces cards
//     alphabetized in a language the reader is not reading.
// Both were driven RED against a deliberately-misplaced overlay before this file was committed.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, isNull, notLike, sql } from 'drizzle-orm';
import { db, runAsSystem, withTenantDb, blockTemplates, contentTranslations, tenants, users } from '../src/db/client';
import { listTemplates, getTemplate, invalidateTemplatesCache } from '../src/templates/templates-service';
import { seedTemplates } from '../src/db/seed-templates';
import { TEMPLATE_I18N, TEMPLATE_TENANT_I18N, templateNaturalKey, tenantTemplateI18nId } from '../src/templates/i18n-key';
import { TEMPLATE_LOCALES, readLocaleFile } from '../src/templates/i18n-seed';
import { DOCS_HEADINGS } from '../src/templates/i18n-docs';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE } from '../src/utils/locale';
import type { BlockDescriptor } from '../src/db/block-types';

const REPO = path.join(import.meta.dir, '..', '..');
const MIGRATION = path.join(import.meta.dir, '..', 'migrations', '0079_template_i18n.sql');
const I18N_DIR = path.join(import.meta.dir, '..', 'src', 'templates', 'seed', 'i18n');

const TENANT = '00000000-0000-0000-0000-0000007719a1';
const DESCRIPTOR = { inputs: {}, outputs: {}, capabilities: {} } as unknown as BlockDescriptor;

// ---------------------------------------------------------------------------
// Fixtures. Three GLOBAL templates the catalog does not ship, so the ordering cases below are
// driven by values this file controls end-to-end rather than by prose a content session may revise.
// Namespaced `zzz-i18n-*` so they sort last in `en` and cannot be confused with a shipped row.
// ---------------------------------------------------------------------------

/** ⛔ THE DUTCH-ONLY NEEDLE. Asserted (not assumed) to be absent from the ENGLISH prose in the
 *  vacuity case below — otherwise "found on nl, not on en" is satisfiable by the base columns and
 *  the case proves nothing about the overlay at all. */
const NL_NEEDLE = 'sleutelwoord';

const FIXTURES = [
  {
    // Case: SORT. English "Alpha …" < "Beta …"; Dutch "Alfa …" is the translation of BETA, so the
    // Dutch order INVERTS. An overlay applied after the sort leaves the English order in place.
    name: 'zzz-i18n-alpha',
    label: 'Zzz Alpha ordering probe',
    description: 'English ordering probe A.',
    tags: ['probe'],
    nl: { label: 'Zzz Omega ordeningsproef', description: 'Nederlandse ordeningsproef A.', tags: ['proef'] },
  },
  {
    name: 'zzz-i18n-beta',
    label: 'Zzz Beta ordering probe',
    description: 'English ordering probe B.',
    tags: ['probe'],
    nl: { label: 'Zzz Alfa ordeningsproef', description: 'Nederlandse ordeningsproef B.', tags: ['proef'] },
  },
  {
    // Case: SEARCH. The Dutch label carries a needle that appears nowhere in the English row.
    name: 'zzz-i18n-search',
    label: 'Zzz Search probe',
    description: 'English search probe.',
    tags: ['probe'],
    nl: { label: `Zzz Zoekproef ${NL_NEEDLE}`, description: 'Nederlandse zoekproef.', tags: ['proef'] },
  },
] as const;

const FIXTURE_NAMES = FIXTURES.map((f) => f.name);
const naturalOf = (name: string) => templateNaturalKey({ category: 'logic', domain: null, name });

// ⛔ `runAsSystem`, NOT the plain request connection. The harness DATABASE_URL is `cp_app`, which
// is `rolbypassrls=f` — PRODUCTION'S SHAPE — and 0043's INSERT policy is
// `WITH CHECK (tenant_id = app_current_tenant_uuid())`, so a GLOBAL (NULL-tenant) row is rejected
// for exactly the same reason it is in prod: globals are seed-only. This is the seam
// `seedTemplates()` itself runs under.
async function insertFixtures(): Promise<void> {
  await runAsSystem('boot-seed', async () => {
  for (const f of FIXTURES) {
    await db
      .insert(blockTemplates)
      .values({
        category: 'logic',
        domain: null,
        name: f.name,
        label: f.label,
        description: f.description,
        tags: [...f.tags],
        descriptor: DESCRIPTOR,
        docs_md: `# ${f.label}\n\nEnglish body.`,
        tenant_id: null,
      })
      .onConflictDoNothing();
    for (const [field, value] of [
      ['label', f.nl.label],
      ['description', f.nl.description],
      ['tags', f.nl.tags.join('\n')],
      ['docs_md', `# ${f.nl.label}\n\nNederlandse tekst.`],
    ] as const) {
      await db
        .insert(contentTranslations)
        .values({ entity_type: TEMPLATE_I18N, entity_id: naturalOf(f.name), locale: 'nl', field, value })
        .onConflictDoUpdate({
          target: [
            contentTranslations.entity_type,
            contentTranslations.entity_id,
            contentTranslations.locale,
            contentTranslations.field,
          ],
          set: { value },
        });
    }
  }
  });
  invalidateTemplatesCache();
}

async function cleanup(): Promise<void> {
  await runAsSystem('boot-seed', async () => {
  await db.delete(blockTemplates).where(inArray(blockTemplates.name, [...FIXTURE_NAMES, 'zzz-i18n-tenant']));
  await db
    .delete(contentTranslations)
    .where(
      inArray(contentTranslations.entity_id, [
        ...FIXTURE_NAMES.map(naturalOf),
        ...FIXTURE_NAMES.map((n) => tenantTemplateI18nId(TENANT, naturalOf(n))),
      ]),
    );
  await db.delete(users).where(eq(users.tenant_id, TENANT));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
  });
  invalidateTemplatesCache();
}

beforeAll(async () => {
  await seedTemplates(); // idempotent; also writes the curated global translations
  await cleanup();
  await insertFixtures();
}, 60_000);

afterAll(async () => {
  await cleanup();
}, 30_000);

// ---------------------------------------------------------------------------
// 1. The overlay reaches the reader — with the SHIPPED content, not a fixture.
// ---------------------------------------------------------------------------

test('listTemplates(nl) serves the shipped Dutch labels, and `en` still serves the base column', async () => {
  const nlFile = readLocaleFile('nl');
  expect(nlFile, 'src/templates/seed/i18n/nl.json is missing — this file would test nothing').not.toBeNull();

  // ⛔ EXPECTATIONS READ FROM THE CONTENT FILE, NOT TYPED HERE. A hardcoded Dutch string would
  // couple this test to one revision of the prose and would go red on an improvement to it. What
  // is being asserted is that the value in the JSON is the value the READER gets.
  const key = 'logic//validate-record';
  const expected = nlFile!.templates[key];
  expect(expected, `nl.json has no '${key}' — the catalog and the translations disagree`).toBeTruthy();

  const [category, , name] = key.split('/');
  const nl = await listTemplates({ locale: 'nl' });
  const row = nl.templates.find((t) => t.name === name && t.category === category);
  expect(row, `'${key}' is not in the catalog`).toBeTruthy();
  expect(row!.label).toBe(expected!.label);
  expect(row!.description).toBe(expected!.description);
  // `tags` round-trips through a newline-joined cell — the split has to give the array back.
  expect(row!.tags).toEqual(expected!.tags);

  // ⛔ THE NON-VACUITY HALF. If the base column already held the Dutch label, everything above
  // would pass against no overlay at all.
  const en = await listTemplates({ locale: 'en' });
  const enRow = en.templates.find((t) => t.name === name)!;
  expect(enRow.label).not.toBe(expected!.label);
  expect(enRow.label).toBe('Validate record');

  // IDENTIFIERS are never translated: `name`, `category` and `domain` must survive verbatim, since
  // `domain` round-trips as `?domain=` and `name` is the slug the author's block is derived from.
  expect(row!.name).toBe(enRow.name);
  expect(row!.category).toBe(enRow.category);
  expect(row!.domain).toBe(enRow.domain);
});

// ---------------------------------------------------------------------------
// 2. NEGATIVE CONTROL: the overlay must run BEFORE the `q` filter.
// ---------------------------------------------------------------------------

test('⛔ a Dutch-only search term finds the template on nl and nothing on en', async () => {
  const fixture = FIXTURES[2]!;

  // ⛔ THE NEEDLE IS PROVEN DUTCH-ONLY. Without this, "no hit on en" could simply mean the English
  // row happens not to match for an unrelated reason, and the case would be unfalsifiable.
  const englishProse = [fixture.label, fixture.description, ...fixture.tags, fixture.name].join(' ');
  expect(
    englishProse.toLowerCase().includes(NL_NEEDLE.toLowerCase()),
    `'${NL_NEEDLE}' appears in the English prose — pick a needle that does not`,
  ).toBe(false);

  const nl = await listTemplates({ locale: 'nl', q: NL_NEEDLE });
  expect(
    nl.templates.map((t) => t.name),
    'searching the Dutch label found nothing — the overlay runs AFTER the q filter',
  ).toEqual([fixture.name]);

  // The same needle on `en` finds nothing: there is no English text to match, which is exactly why
  // the `nl` hit above can only have come from the overlay.
  const en = await listTemplates({ locale: 'en', q: NL_NEEDLE });
  expect(en.templates).toHaveLength(0);

  // The base `name` arm STAYS — a reader who types the technical identifier finds the card in any
  // language. (Deleting that arm is a plausible "simplification" of the fix.)
  const byName = await listTemplates({ locale: 'nl', q: fixture.name });
  expect(byName.templates.map((t) => t.name)).toEqual([fixture.name]);
});

// ---------------------------------------------------------------------------
// 3. NEGATIVE CONTROL: the overlay must run BEFORE the sort.
// ---------------------------------------------------------------------------

test('⛔ two templates whose Dutch labels invert their English order come back in Dutch order', async () => {
  const [a, b] = [FIXTURES[0]!, FIXTURES[1]!];

  // The premise, asserted rather than assumed: English A<B, Dutch B<A.
  expect(a.label.localeCompare(b.label, 'en')).toBeLessThan(0);
  expect(b.nl.label.localeCompare(a.nl.label, 'nl')).toBeLessThan(0);

  const order = (r: { templates: { name: string }[] }) =>
    r.templates.map((t) => t.name).filter((n) => n === a.name || n === b.name);

  expect(order(await listTemplates({ locale: 'en' })), 'the English order is not A then B').toEqual([
    a.name,
    b.name,
  ]);
  expect(
    order(await listTemplates({ locale: 'nl' })),
    'the Dutch order is still the English one — the overlay runs AFTER the sort',
  ).toEqual([b.name, a.name]);
});

// ---------------------------------------------------------------------------
// 4. getTemplate overlays docs_md — the field the editor COPIES into the author's block.
// ---------------------------------------------------------------------------

test('getTemplate(nl) serves the Dutch docs_md, rendered with localized headings', async () => {
  const [row] = await db
    .select({ id: blockTemplates.id })
    .from(blockTemplates)
    .where(and(eq(blockTemplates.name, 'validate-record'), isNull(blockTemplates.tenant_id)));
  expect(row, 'the shipped `validate-record` template is not seeded').toBeTruthy();

  const nl = await getTemplate(row!.id, { locale: 'nl' });
  const en = await getTemplate(row!.id, { locale: 'en' });
  expect(nl).toBeTruthy();

  const expected = readLocaleFile('nl')!.templates['logic//validate-record']!;
  expect(nl!.docs_md).toContain(`# ${expected.label}`);
  expect(nl!.docs_md).toContain(expected.description);
  // The `##` headings are localized too — not an English skeleton around translated bullets.
  expect(nl!.docs_md).toContain(`## ${DOCS_HEADINGS.nl.preconditions}`);
  expect(nl!.docs_md).toContain(`## ${DOCS_HEADINGS.nl.steps}`);
  expect(nl!.docs_md).not.toContain(`## ${DOCS_HEADINGS.en.preconditions}`);

  // Non-vacuity: `en` really is a different document.
  expect(en!.docs_md).toContain(`## ${DOCS_HEADINGS.en.preconditions}`);
  expect(en!.docs_md).not.toBe(nl!.docs_md);
});

// ---------------------------------------------------------------------------
// 5. A tenant template must NOT inherit a global's translation.
// ---------------------------------------------------------------------------

test("⛔ a tenant template sharing a global's (category, domain, name) keeps its OWN prose", async () => {
  // 0043's natural-key unique index is scoped by `coalesce(tenant_id, zero-uuid)`, so this is a
  // LEGAL row — the table is built to let a tenant reuse a shipped name. Under a bare natural key
  // both rows would resolve to the same `content_translations` cell and the tenant would be served
  // the platform's curated prose (or, once tenants translate, one tenant would be served
  // another's). This is the collision templates/i18n-key.ts' tenant entity type exists to stop.
  const shared = FIXTURES[0]!; // already has a curated `nl` label under the GLOBAL key
  const TENANT_NL = 'Zzz Huurdersvertaling';

  await runAsSystem('boot-seed', async () => {
    await db.insert(tenants).values({ id: TENANT, name: 'tpl-i18n', slug: 'tpl-i18n-t' }).onConflictDoNothing();
    await db
      .insert(blockTemplates)
      .values({
        category: 'logic',
        domain: null,
        name: shared.name,
        label: 'Tenant-authored English',
        description: 'The tenant wrote this.',
        tags: ['tenant'],
        descriptor: DESCRIPTOR,
        docs_md: '# Tenant',
        tenant_id: TENANT,
      })
      .onConflictDoNothing();
    // The tenant's OWN translation, under the tenant-scoped key.
    await db
      .insert(contentTranslations)
      .values({
        entity_type: TEMPLATE_TENANT_I18N,
        entity_id: tenantTemplateI18nId(TENANT, naturalOf(shared.name)),
        locale: 'nl',
        field: 'label',
        value: TENANT_NL,
      })
      .onConflictDoNothing();
  });
  invalidateTemplatesCache();

  // ⛔ `withTenantDb` — `listTemplates` reads tenant rows through the RLS-scoped connection, and
  // `cp_app` is `rolbypassrls=f`. Without the GUC bound the tenant row is invisible and this case
  // would pass vacuously on a one-row result.
  const nl = await withTenantDb(TENANT, () => listTemplates({ locale: 'nl', tenantId: TENANT }));
  const rows = nl.templates.filter((t) => t.name === shared.name);
  expect(rows, 'expected the global and the tenant row side by side').toHaveLength(2);

  const tenantRow = rows.find((t) => t.tenantOwned)!;
  const globalRow = rows.find((t) => !t.tenantOwned)!;

  // Both halves. The tenant gets ITS OWN Dutch (so the tenant key positively resolves — a resolver
  // that simply found nothing would also satisfy "not the global's"), and the global keeps the
  // curated one (so the split did not break the platform catalogue).
  expect(
    tenantRow.label,
    "the tenant's template was served the platform's prose — the key is not tenant-scoped",
  ).toBe(TENANT_NL);
  expect(globalRow.label, 'the global lost its curated translation').toBe(shared.nl.label);
  expect(tenantRow.label).not.toBe(globalRow.label);

  // And an UNTRANSLATED tenant field degrades to the tenant's own English — never to the global's
  // Dutch. (`description` has a curated global `nl` cell; the tenant row has none.)
  expect(tenantRow.description).toBe('The tenant wrote this.');
  expect(tenantRow.description).not.toBe(shared.nl.description);
});

// ---------------------------------------------------------------------------
// 6. The migration: shape, size, and that every key still matches a live template.
// ---------------------------------------------------------------------------

test('0079 covers every seeded template × every non-en locale × 4 fields', async () => {
  const sql079 = readFileSync(MIGRATION, 'utf8');

  // ⛔ EVERY EXPECTED NUMBER IS DERIVED, NOT TYPED. A literal `expect(rows).toBe(560)` passes
  // silently on a generation that happened to produce 560 rows from the wrong inputs — and would
  // NOT have caught the real near-miss here, a migration generated while only 3 of the 7 locale
  // files existed. The locale count comes from the app's own SUPPORTED_LOCALES and the template
  // count from the live catalog, so dropping a locale file or a template goes red.
  const localeFiles = readdirSync(I18N_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''));
  expect(
    [...localeFiles].sort(),
    'the i18n directory does not hold exactly one file per non-en supported locale',
  ).toEqual([...TEMPLATE_LOCALES].sort());
  expect(localeFiles).not.toContain(DEFAULT_LOCALE);
  expect(TEMPLATE_LOCALES.length).toBe(SUPPORTED_LOCALES.length - 1);

  const seeded = await db
    .select({ category: blockTemplates.category, domain: blockTemplates.domain, name: blockTemplates.name })
    .from(blockTemplates)
    .where(isNull(blockTemplates.tenant_id));
  const liveKeys = new Set(
    seeded.filter((r) => !r.name.startsWith('zzz-i18n-')).map((r) => templateNaturalKey(r)),
  );
  const FIELDS = ['label', 'description', 'tags', 'docs_md'];

  const rowRe = new RegExp(`^ {2}\\('${TEMPLATE_I18N}', '([^']+)', '([a-z]{2})', '(\\w+)', `, 'gm');
  const parsed = [...sql079.matchAll(rowRe)].map((m) => ({ key: m[1]!, locale: m[2]!, field: m[3]! }));

  expect(parsed.length, 'the migration produced no parseable rows').toBeGreaterThan(0);
  expect(parsed.length).toBe(liveKeys.size * TEMPLATE_LOCALES.length * FIELDS.length);
  expect([...new Set(parsed.map((r) => r.locale))].sort()).toEqual([...TEMPLATE_LOCALES].sort());
  expect([...new Set(parsed.map((r) => r.field))].sort()).toEqual([...FIELDS].sort());

  // ⛔ NO `en` ROWS. `getTranslationsBatch` short-circuits `en` to an empty map, so an `en` row is
  // unreachable dead weight that can only drift from the base column it shadows.
  expect(parsed.filter((r) => r.locale === DEFAULT_LOCALE)).toHaveLength(0);
  expect(sql079).not.toMatch(/, 'en', '/);

  // ⛔ THE ORPHAN CHECK. This is what catches a RENAMED template: the translations keep the old
  // natural key, key to nothing, and every reader silently falls back to English with no error
  // anywhere. Both directions — no key without a template, no template without its 4×7 cells.
  const keysInSql = new Set(parsed.map((r) => r.key));
  const orphans = [...keysInSql].filter((k) => !liveKeys.has(k));
  expect(orphans, 'migration keys that match no live template (renamed or removed?)').toEqual([]);
  const uncovered = [...liveKeys].filter((k) => !keysInSql.has(k));
  expect(uncovered, 'seeded templates with no translations at all').toEqual([]);
  for (const key of liveKeys) {
    expect(parsed.filter((r) => r.key === key), `'${key}' is short of its cells`).toHaveLength(
      TEMPLATE_LOCALES.length * FIELDS.length,
    );
  }
});

test('the seeded translations are actually in the database, keyed the same way', async () => {
  // The migration is what repairs prod; `seedTemplateTranslations()` is what a fresh developer
  // database gets. Both must produce the SAME keys — this asserts the seeder half landed.
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contentTranslations)
    .where(
      and(
        eq(contentTranslations.entity_type, TEMPLATE_I18N),
        eq(contentTranslations.entity_id, 'logic//validate-record'),
      ),
    );
  expect(row!.n).toBe(TEMPLATE_LOCALES.length * 4);

  // Nothing was written under the TENANT entity type by the SEEDER — the shipped globals stay
  // global, which is what keeps migration 0079 the sole owner of their prose.
  // ⚠️ Scoped past THIS FILE's own tenant fixture: the collision case above deliberately writes one
  // `block_template_tenant` row, and bun runs it first. An unscoped `count = 0` here was red for
  // that reason alone — a test polluted by its own sibling, which is not the property being
  // asserted.
  const [t] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(contentTranslations)
    .where(
      and(
        eq(contentTranslations.entity_type, TEMPLATE_TENANT_I18N),
        notLike(contentTranslations.entity_id, `${TENANT}:%`),
      ),
    );
  expect(t!.n, 'the seeder wrote tenant-scoped rows — globals must stay under block_template').toBe(0);
});

// ---------------------------------------------------------------------------
// 7. The docs headings are carried, not invented.
// ---------------------------------------------------------------------------

test('DOCS_HEADINGS match the reviewed frontend message catalogs', () => {
  // The backend cannot import from `frontend/` at runtime (the image does not ship it), so the
  // three `##` headings are COPIED into i18n-docs.ts. This is what stops the copy going stale: a
  // reviewer improving `blockedit_savetpl_pre_label` in the SPA gets a red test here rather than a
  // silently divergent document.
  const KEYS = {
    preconditions: 'blockedit_savetpl_pre_label',
    steps: 'blockedit_savetpl_steps_label',
    postconditions: 'blockedit_savetpl_post_label',
  } as const;
  for (const locale of SUPPORTED_LOCALES) {
    const catalog = JSON.parse(
      readFileSync(path.join(REPO, 'frontend', 'messages', `${locale}.json`), 'utf8'),
    ) as Record<string, string>;
    for (const [slot, key] of Object.entries(KEYS)) {
      expect(DOCS_HEADINGS[locale][slot as keyof typeof KEYS], `${locale}.${key}`).toBe(catalog[key]!);
    }
  }
});
