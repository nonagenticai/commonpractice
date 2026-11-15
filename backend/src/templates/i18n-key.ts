// src/templates/i18n-key.ts — the content_translations key for a block TEMPLATE's prose.
//
// ⛔ THE KEY IS THE NATURAL KEY, NEVER `block_templates.id`. This is the whole reason this file
// exists rather than a one-line `entity_id: row.id`.
//
// `block_templates.id` is `UUID PRIMARY KEY DEFAULT uuidv7()` (0043_block_templates.sql:19). It is
// minted by the INSERT, and the seeder (db/seed-templates.ts) inserts on every database that has
// never seen the row — so prod, CI, and each of ~N developer databases each hold a DIFFERENT uuid
// for the SAME shipped template. `content_translations` has no foreign key to anything
// (0008_ai-substrate.sql), so a uuid-keyed translation is not an integrity error anywhere; it is
// simply a row that matches nothing. Committing a migration full of prod's uuids would therefore
// ship 560 rows that light up in exactly one database and are dead weight in every other — the
// silent, green-looking failure mode. It also breaks in the other direction: re-seeding a template
// (drop + seed) mints a fresh uuid and orphans its own translations in place.
//
// The natural key `${category}/${domain ?? ''}/${name}` mirrors the UNIQUE INDEX the table already
// enforces — `block_templates_natural_uq (category, coalesce(domain, ''), name, coalesce(tenant_id,
// zero-uuid))` at 0043:48-53 — so it is exactly as unique as the row itself, and it is stable
// across databases because it is authored in `src/templates/seed/*.json`, not generated. The
// `coalesce(domain,'')` is matched deliberately: all 20 shipped templates have a NULL domain, so
// every shipped key reads `ai//x`, `logic//x` or `ui//x`, and `null` vs `''` must not be able to
// produce two spellings of one key.
//
// ⛔ WHY A SEPARATE TENANT ENTITY TYPE. The natural key's uniqueness index is scoped by
// `coalesce(tenant_id, zero-uuid)` — i.e. 0043 DELIBERATELY lets a tenant author a template with
// the same `(category, domain, name)` as a shipped global one, exactly as 0037 does for block
// slugs. A bare natural key would therefore collide, and a tenant's own template would be served
// the platform's curated Dutch prose (or worse, one tenant's prose would be served to another).
// This mirrors blocks/i18n-key.ts, which spells out the same data loss for `building_blocks` in
// full; the reasoning is identical here and is not restated.
//
// ⛔ THERE IS NO GLOBAL FALLBACK FOR A TENANT TEMPLATE, AND THERE MUST NEVER BE ONE — it would
// re-serve precisely the row the split exists to keep separate. It costs nothing: a missing
// translation already degrades to the base `label`/`description`/`docs_md` columns, which are the
// author's own English, and `getTranslationsBatch` short-circuits `en` to an empty map
// (db/translations.ts:118-121) so no `en` row exists for either entity type.

/** content_translations entity_type for GLOBAL (shipped) template prose — keyed by the natural key. */
export const TEMPLATE_I18N = 'block_template';

/** entity_type for TENANT-authored template prose. A tenant may reuse a global's
 *  `(category, domain, name)` (0043:48-53 scopes the unique index by tenant), so the id is
 *  tenant-scoped to keep the two apart. */
export const TEMPLATE_TENANT_I18N = 'block_template_tenant';

/**
 * The cross-database-stable identity of one template: `${category}/${domain ?? ''}/${name}`.
 *
 * ⛔ `domain ?? ''` MIRRORS `coalesce(domain, '')` IN THE DB'S OWN UNIQUE INDEX (0043:48-53). An
 * empty-string domain and a NULL domain are the SAME template to Postgres, so they must be the
 * same key here — otherwise one row could acquire two translation keys and half its prose would
 * go missing depending on which code path wrote it.
 */
export function templateNaturalKey(t: {
  category: string;
  domain?: string | null;
  name: string;
}): string {
  return `${t.category}/${t.domain ?? ''}/${t.name}`;
}

/** Tenant-isolated content_translations id for a tenant-authored template. */
export function tenantTemplateI18nId(tenantId: string, natural: string): string {
  return `${tenantId}:${natural}`;
}

/**
 * The (entity_type, entity_id) pair under which one template's prose is stored.
 *
 * ⛔ Derive this from the TEMPLATE ROW's own `tenant_id`, never from the reader's active tenant.
 * The gallery serves global ∪ own-tenant in one list, so keying the globals by the reader's tenant
 * would mint a private, permanently-untranslated copy of the whole shipped catalog per tenant.
 */
export function templateI18nKey(t: {
  tenant_id: string | null;
  category: string;
  domain?: string | null;
  name: string;
}): { entityType: string; entityId: string } {
  const natural = templateNaturalKey(t);
  return t.tenant_id === null
    ? { entityType: TEMPLATE_I18N, entityId: natural }
    : { entityType: TEMPLATE_TENANT_I18N, entityId: tenantTemplateI18nId(t.tenant_id, natural) };
}

/**
 * `tags` is a `string[]` column, but `content_translations` is a flat (entity, locale, field) →
 * TEXT table with no array support. The localized tag list is therefore stored NEWLINE-JOINED in
 * the single `tags` cell and split back on read. Newline is the separator because a tag may
 * legitimately contain a comma or a space ("hr, payroll"), and `block_templates.tags` is authored
 * in JSON where a literal newline inside a tag cannot occur.
 */
export const TAGS_SEPARATOR = '\n';

export function joinTags(tags: string[]): string {
  return tags.join(TAGS_SEPARATOR);
}

export function splitTags(value: string): string[] {
  return value
    .split(TAGS_SEPARATOR)
    .map((t) => t.trim())
    .filter((t) => t !== '');
}
