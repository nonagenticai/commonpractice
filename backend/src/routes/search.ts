// src/routes/search.ts — the global topbar search (challenges / solutions / blocks).
// A single tenant-scoped ILIKE over the three discover surfaces, capped per group, so
// the topbar's "Search challenges, solutions, blocks…" box actually resolves. RLS binds
// the tenant for the whole request (server.ts), so plain `db` reads are tenant-confined.
// Registered via registerSearchRoutes(router) in server.ts.
//
// ⛔ THE BOX SEARCHES — AND ANSWERS IN — THE READER'S LOCALE. It used to do neither. Every
// surface this box links to overlays its text from `content_translations` (§5B), so a reader
// on `nl` saw "Schadeformulieren automatisch samenvatten" on the board, typed
// `schadeformulieren` here, and got `{challenges:[],solutions:[],blocks:[]}` — the text on
// their screen had never been in a column this file looked at. Both halves are now wired:
//   • MATCH — each group's predicate carries a `translatedMatchSql` arm alongside its base
//     ILIKE, so the Dutch title matches AND the English base still does (a reader may type
//     the English product term). One correlated EXISTS, no extra round trip, no join.
//   • RENDER — the surviving rows are overlaid with `getTranslationsBatch`, the SAME machinery
//     routes/challenges.ts:~400 uses, so a dropdown entry reads identically to the row it
//     navigates to. Matching in Dutch and painting English is only half a fix.
// For `en` both are no-ops by construction (both helpers short-circuit on the default locale),
// so English behaviour is byte-for-byte what it was.
import { and, asc, desc, eq, ilike, isNotNull, or } from 'drizzle-orm';
import { db, challenges, solutions, buildingBlocks } from '../db/client';
import { BLOCK_I18N, BLOCK_TENANT_I18N, blockI18nKey } from '../blocks/i18n-key';
import { getTranslationsBatch } from '../db/translations';
import { translatedBlockMatchSql, translatedMatchSql } from '../db/translation-search';
import { validateAuth } from '../middleware/auth';
import { negotiateLocale } from '../utils/locale';
import { jsonResponse, route } from '../utils/http';
import { likeTerm } from '../utils/search';
import type { Router } from '../utils/router';

const GROUP_LIMIT = 5;
const MAX_Q = 100;

const search = route(async (req) => {
  await validateAuth(req);
  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, MAX_Q);
  // Below 2 chars the result set is noise — return empty so the dropdown stays quiet.
  if (q.length < 2) {
    return jsonResponse({ q, challenges: [], solutions: [], blocks: [] });
  }
  const term = likeTerm(q);
  const locale = negotiateLocale(req);

  const [chRows, solRows, blkRows] = await Promise.all([
    db
      .select({ id: challenges.id, title: challenges.title, code: challenges.code })
      .from(challenges)
      .where(
        or(
          ilike(challenges.title, term),
          ilike(challenges.code, term),
          // The reader's own edition of the title. `code` is a locale-free identifier (CH-243)
          // and is never translated, so it has no translated arm.
          translatedMatchSql('challenge', challenges.id, locale, ['title'], term),
        ),
      )
      .orderBy(desc(challenges.votes_count))
      .limit(GROUP_LIMIT),
    db
      .select({ id: solutions.id, title: solutions.title })
      .from(solutions)
      .where(
        or(
          ilike(solutions.title, term),
          translatedMatchSql('solution', solutions.id, locale, ['title'], term),
        ),
      )
      .orderBy(desc(solutions.votes_count))
      .limit(GROUP_LIMIT),
    // Only published blocks are user-navigable from the library.
    //
    // ⛔ The predicate now MATCHES that sentence. It did not: the comment claimed a filter the
    // query never had, so the topbar happily surfaced never-published drafts and archived blocks,
    // every one of which dead-ends — the library page they link to only lists published,
    // non-archived rows. "Published" is `current_version_id IS NOT NULL` (the block has a current
    // version), and `archived = false` because routes/blocks.ts ARCHIVES rather than deletes, so
    // an archived block keeps its row, its slug and its name forever.
    db
      .select({
        slug: buildingBlocks.slug,
        name: buildingBlocks.name,
        // Carried ONLY so the overlay below can key on ownership (blocks/i18n-key.ts); it is
        // not part of the response shape.
        tenant_id: buildingBlocks.tenant_id,
      })
      .from(buildingBlocks)
      .where(
        and(
          or(
            ilike(buildingBlocks.name, term),
            ilike(buildingBlocks.slug, term),
            // Keyed by ownership, not by the bare slug — 0037 dropped global slug uniqueness.
            translatedBlockMatchSql(
              buildingBlocks.slug,
              buildingBlocks.tenant_id,
              locale,
              ['name'],
              term,
            ),
          ),
          isNotNull(buildingBlocks.current_version_id),
          eq(buildingBlocks.archived, false),
        ),
      )
      .orderBy(asc(buildingBlocks.name))
      .limit(GROUP_LIMIT),
  ]);

  // Localized overlay of the rows that survived — after the LIMIT, keyed by id, so this is a
  // bounded lookup over at most GROUP_LIMIT rows per group and never an N+1. All four calls
  // short-circuit to an empty map on `en`.
  const globalBlocks = blkRows.filter((b) => b.tenant_id === null);
  const ownedBlocks = blkRows.filter((b) => b.tenant_id !== null);
  const [chTx, solTx, globalTx, ownedTx] = await Promise.all([
    getTranslationsBatch('challenge', chRows.map((r) => r.id), locale, ['title']),
    getTranslationsBatch('solution', solRows.map((r) => r.id), locale, ['title']),
    getTranslationsBatch(BLOCK_I18N, globalBlocks.map((b) => b.slug), locale, ['name']),
    getTranslationsBatch(
      BLOCK_TENANT_I18N,
      ownedBlocks.map((b) => blockI18nKey(b).entityId),
      locale,
      ['name'],
    ),
  ]);

  return jsonResponse({
    q,
    challenges: chRows.map((r) => ({ ...r, title: chTx.get(r.id)?.title ?? r.title })),
    solutions: solRows.map((r) => ({ ...r, title: solTx.get(r.id)?.title ?? r.title })),
    blocks: blkRows.map((b) => {
      const k = blockI18nKey(b);
      const t = (b.tenant_id === null ? globalTx : ownedTx).get(k.entityId) ?? {};
      return { slug: b.slug, name: t.name ?? b.name };
    }),
  });
});

export function registerSearchRoutes(router: Router): void {
  router.add('GET', '/api/search', search);
}
