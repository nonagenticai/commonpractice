// src/db/translation-search.ts — the MATCH side of the §5B overlay, the sibling of
// db/translations.ts's `getTranslationsBatch` (the RENDER side).
//
// ⛔ WHY THIS EXISTS. Every discover surface renders text that was overlaid from
// `content_translations` — routes/challenges.ts, routes/solutions.ts, routes/blocks.ts and
// routes/marketplace-summary.ts all negotiate a locale and batch-overlay before returning.
// The SEARCH predicates behind those same routes ILIKEd the ENGLISH base column and nothing
// else, so a reader on `nl` typing a word they could see on their own screen matched zero
// rows: the text they read had never been in a column any query looked at. This builds the
// missing arm — "…or a translation of this row, in THIS reader's locale, contains the term".
//
// SHAPE: a correlated `EXISTS` over `content_translations`, so it is one extra predicate on
// the query the caller was already running — no join that can duplicate or drop a row (which
// on the two ranked boards would RENUMBER the leaderboard; see host/challenge-board.ts), no
// second round trip, and no N+1. Callers keep using `getTranslationsBatch` to RENDER the rows
// that survive: matching in Dutch and then painting English is only half a fix.
//
// ⛔ IT RETURNS `undefined` FOR THE DEFAULT LOCALE, on purpose and for the same reason
// `getTranslationsBatch` short-circuits there: the base columns ARE the `en` edition and no
// `en` row is ever minted (translation-service.ts mints SUPPORTED_LOCALES minus 'en'). So the
// English predicate is byte-for-byte what it was before this file existed — `or()`/`and()`
// drop an undefined arm — and every English behaviour is unchanged by construction.
//
// TENANCY: `content_translations` carries no tenant column and no RLS (0028's explicit
// platform-exemption list). That is safe HERE because the EXISTS only ever narrows an
// already-RLS-scoped base row — it can reveal no row the caller could not already see. It is
// NOT safe for blocks keyed by a bare slug, which is why `translatedBlockMatchSql` mirrors
// blocks/i18n-key.ts's ownership split rather than matching on the slug alone.
import { sql, type SQL, type AnyColumn } from 'drizzle-orm';
import { BLOCK_I18N, BLOCK_TENANT_I18N } from '../blocks/i18n-key';
import { DEFAULT_LOCALE } from '../utils/locale';

type Expr = AnyColumn | SQL | SQL.Aliased;

/** `ct.field IN (…)` as a bound-parameter list. */
function fieldList(fields: string[]): SQL {
  return sql.join(
    fields.map((f) => sql`${f}`),
    sql`, `,
  );
}

/**
 * "Does a `locale` translation of one of `fields` for this row contain `term`?"
 *
 * `idExpr` is the row's id column — cast to text because `content_translations.entity_id` is
 * `text` while challenge/solution ids are `uuid`. `term` is a complete ILIKE pattern (the
 * caller owns the `%`-wrapping and any wildcard escaping, so this arm matches exactly what
 * the caller's base-column arm matches).
 *
 * Returns `undefined` for the default locale — see the header.
 */
export function translatedMatchSql(
  entityType: string,
  idExpr: Expr,
  locale: string,
  fields: string[],
  term: string,
): SQL | undefined {
  if (locale === DEFAULT_LOCALE || fields.length === 0) return undefined;
  return sql`EXISTS (SELECT 1 FROM content_translations ct
    WHERE ct.entity_type = ${entityType}
      AND ct.entity_id = (${idExpr})::text
      AND ct.locale = ${locale}
      AND ct.field IN (${fieldList(fields)})
      AND ct.value ILIKE ${term})`;
}

/**
 * The block variant. A block's prose is keyed by its OWNERSHIP, never by the bare slug —
 * 0037 dropped global slug uniqueness, so two tenants may own `invoice-parser` and a
 * bare-slug match would let one tenant's Dutch prose surface the other's row. See
 * blocks/i18n-key.ts for the full story; this is the predicate form of `blockI18nKey`.
 */
export function translatedBlockMatchSql(
  slugExpr: Expr,
  tenantIdExpr: Expr,
  locale: string,
  fields: string[],
  term: string,
): SQL | undefined {
  if (locale === DEFAULT_LOCALE || fields.length === 0) return undefined;
  return sql`EXISTS (SELECT 1 FROM content_translations ct
    WHERE ct.locale = ${locale}
      AND ct.field IN (${fieldList(fields)})
      AND ct.value ILIKE ${term}
      AND (
        (${tenantIdExpr} IS NULL AND ct.entity_type = ${BLOCK_I18N} AND ct.entity_id = ${slugExpr})
        OR (${tenantIdExpr} IS NOT NULL AND ct.entity_type = ${BLOCK_TENANT_I18N}
            AND ct.entity_id = (${tenantIdExpr})::text || ':' || ${slugExpr})
      ))`;
}
