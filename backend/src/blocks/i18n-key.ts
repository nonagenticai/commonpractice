// src/blocks/i18n-key.ts — the content_translations key for a block's prose.
//
// ⛔ WHY A TENANT-SCOPED KEY IS NEEDED AT ALL. `content_translations`
// (0008_ai-substrate.sql:181-189) is PRIMARY KEY (entity_type, entity_id, locale, field) with no
// tenant column and no RLS — it is on 0028_rls.sql:23's explicit platform-exemption list. That
// exemption was written when `building_blocks` was global and its slug was globally UNIQUE.
//
// 0037 changed BOTH halves of that premise and left this table behind: it moved blocks into RLS
// with dual ownership AND DELIBERATELY DROPPED global slug uniqueness (0037:32-34,
// `building_blocks_slug_owner_uq` keys on (slug, coalesce(tenant_id, zero-uuid))) so that each
// tenant gets its own slot for a slug. Block translations, however, were still keyed by the BARE
// SLUG. So tenant B publishing `invoice-parser` OVERWROTE tenant A's row for the same slug, and a
// user at tenant A on any non-`en` locale was served B's `docs_md` — the whole document — because
// the overlay lookup has no tenant predicate and, this table being outside RLS by design, no
// database backstop to fall back on. Sharing a slug is not exotic: 0037 exists to enable it.
//
// This mirrors the pattern already in this repo for the identical shape —
// ontology-service.ts:40-55 (`ONTOLOGY_ENTITY_TENANT_I18N` + `tenantEntityI18nId`), resolved in two
// passes on read at ontology-service.ts:337-368.
//
// ⛔ THERE IS NO BARE-SLUG FALLBACK FOR A TENANT BLOCK, AND THERE MUST NEVER BE ONE. A fallback
// would re-serve exactly the poisoned row this split exists to stop serving. It costs nothing:
// no `en` row for entity_type 'block' has ever existed — `enqueueTranslations` only mints
// TARGET_LOCALES (SUPPORTED_LOCALES minus 'en', translation-service.ts:37-39), and
// `getTranslationsBatch` short-circuits to an empty map for 'en' (db/translations.ts:118-121).
// The English base prose lives on `building_blocks.name`/`.description` and
// `block_versions.docs_md`, and a missing translation already degrades to those columns. A tenant
// block with no row under the new key therefore reads exactly like one that was never translated.

/** content_translations entity_type for GLOBAL (platform) block prose — keyed by the bare slug. */
export const BLOCK_I18N = 'block';

/** entity_type for TENANT-authored block prose. Two tenants may own the same slug since 0037, so
 *  the id is tenant-scoped to keep them isolated. */
export const BLOCK_TENANT_I18N = 'block_tenant';

/** Tenant-isolated content_translations id for a tenant-authored block. */
export function tenantBlockI18nId(tenantId: string, slug: string): string {
  return `${tenantId}:${slug}`;
}

/**
 * The (entity_type, entity_id) pair under which one block's prose is stored.
 *
 * ⛔ Derive this from the BLOCK ROW's own `tenant_id`, never from the caller's active tenant. A
 * tenant admin browsing the marketplace sees global blocks too; keying those by the reader's
 * tenant would mint a private, permanently-untranslated copy of every platform block.
 */
export function blockI18nKey(block: { tenant_id: string | null; slug: string }): {
  entityType: string;
  entityId: string;
} {
  return block.tenant_id === null
    ? { entityType: BLOCK_I18N, entityId: block.slug }
    : { entityType: BLOCK_TENANT_I18N, entityId: tenantBlockI18nId(block.tenant_id, block.slug) };
}
