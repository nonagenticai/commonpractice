// src/blocks/block-display-names.ts — slug → the READER'S name for a published library block.
//
// ⛔ WHY THIS IS SERVER-SIDE AND NOT A SECOND `block-catalog` STORE IN THE BROWSER.
// The SPA already owns a live slug→name lookup (`frontend/src/lib/stores/block-catalog.svelte.ts`),
// but it is fed by exactly ONE call site: `routes/build/+page.svelte`'s `loadPalette()`. On
// `/solutions` and `/solutions/[id]` the store is EMPTY, so routing those screens through
// `nodeDisplayName` would print the English hyphenated slug — the very defect it exists to remove —
// unless every marketplace route grew its own `GET /api/blocks` fetch. The block catalogue, the
// tenant-ownership key and the locale negotiation all already live HERE, on the request that is
// serving the row, so the name rides down on the DTO instead.
//
// ⛔ THE OVERLAY IS THE ONE IN routes/blocks.ts `listBlocks`, NOT A SECOND SPELLING OF IT. Two
// passes keyed by the BLOCK ROW's ownership: 0037 dropped global slug uniqueness, so a bare-slug
// batch would serve one tenant's prose for another tenant's row (blocks/i18n-key.ts spells out the
// data loss in full, and why there is deliberately no bare-slug fallback for a tenant block).
import { inArray } from 'drizzle-orm';
import { db, buildingBlocks } from '../db/client';
import { getTranslationsBatch } from '../db/translations';
import { BLOCK_I18N, BLOCK_TENANT_I18N, blockI18nKey, tenantBlockI18nId } from './i18n-key';

/** Is this a NAME, or an absence wearing a name's type? Mirrors `has()` in the SPA's
 *  `i18n/block-node-label.ts`: a blank `name` renders as a chip with no title, which is worse than
 *  the slug it would have replaced, and `??` cannot tell the two apart. */
function has(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The current reader's display name for each of `slugs` that the block library actually holds.
 *
 * A slug with no row (archived since the flow was saved, a control-flow token, a tenant block this
 * reader cannot see through RLS) is simply ABSENT from the map — never mapped to `''` and never to
 * itself. The caller decides the fallback, exactly as `blockNodeLabel`'s rungs do browser-side.
 *
 * ⚠️ A TENANT ROW WINS OVER THE GLOBAL ROW OF THE SAME SLUG. `db` is RLS-scoped to global ∪
 * own-tenant, so since 0037 a reader can legitimately match TWO rows for one slug. The tenant's own
 * block is the one their flow instantiated and the one their library screen shows, so it is written
 * second and overwrites. Without an explicit order this map's contents would be row order, i.e.
 * whichever the planner handed back.
 */
export async function blockDisplayNames(
  slugs: readonly string[],
  locale: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(slugs.filter(has))];
  if (!unique.length) return out;

  const rows = await db
    .select({
      slug: buildingBlocks.slug,
      name: buildingBlocks.name,
      tenant_id: buildingBlocks.tenant_id,
    })
    .from(buildingBlocks)
    .where(inArray(buildingBlocks.slug, unique));

  const globalRows = rows.filter((r) => r.tenant_id === null);
  const ownedRows = rows.filter((r) => r.tenant_id !== null);
  const globalTx = globalRows.length
    ? await getTranslationsBatch(BLOCK_I18N, globalRows.map((r) => r.slug), locale, ['name'])
    : new Map<string, Record<string, string>>();
  const ownedTx = ownedRows.length
    ? await getTranslationsBatch(
        BLOCK_TENANT_I18N,
        ownedRows.map((r) => tenantBlockI18nId(r.tenant_id!, r.slug)),
        locale,
        ['name'],
      )
    : new Map<string, Record<string, string>>();

  // Global first, own-tenant second — see the ⚠️ above. Not a `sort`: two filtered passes are
  // already in hand and a comparator would have to re-state the same rule.
  for (const r of [...globalRows, ...ownedRows]) {
    const key = blockI18nKey(r);
    const t = (r.tenant_id === null ? globalTx : ownedTx).get(key.entityId) ?? {};
    const name = t.name ?? r.name;
    if (has(name)) out.set(r.slug, name);
  }
  return out;
}
