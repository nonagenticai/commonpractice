-- 0060 — EXPAND half of an expand/contract: give block translations a tenant-aligned key.
--
-- THE BUG
-- -------
-- `content_translations` (0008_ai-substrate.sql:181-189) is PRIMARY KEY
-- (entity_type, entity_id, locale, field) with no tenant column and no RLS — it sits on 0028's
-- explicit platform-exemption list (0028_rls.sql:23). That exemption was written when
-- `building_blocks` was global and its slug was globally UNIQUE.
--
-- 0037 changed BOTH halves of that premise and left this table behind: it moved blocks into RLS
-- with dual ownership AND DELIBERATELY DROPPED global slug uniqueness (0037:32-34,
-- `building_blocks_slug_owner_uq` keys on (slug, coalesce(tenant_id, zero-uuid))) so each tenant
-- gets its own slot for a slug. Block translations, however, were still keyed by the BARE SLUG.
--
-- Consequence, with no exotic preconditions — 0037 exists precisely to ENABLE shared slugs:
--   * tenant B publishes `invoice-parser`; the drainer's upsert
--     (host/translation-service.ts:262-278) arbitrates on (entity_type, entity_id, locale, field)
--     and OVERWRITES tenant A's row for the same slug;
--   * a user at tenant A on any non-`en` locale is then served B's `docs_md` — the whole document —
--     because the overlay lookup (routes/blocks.ts) had no tenant predicate and, this table being
--     outside RLS by design, no database backstop to fall back on.
-- `translation_jobs` was poisoned the same way: its UNIQUE (entity_type, entity_id, field,
-- target_locale) means B's publish also overwrote A's queued source_text AND `requested_by`, so
-- the LLM spend for A's document was metered against B.
--
-- THE FIX — the pattern already in this repo for the identical shape
-- -----------------------------------------------------------------
-- ontology-service.ts:40-55 solved this for tenant-authored ontology entities: a distinct
-- entity_type (`ontology_entity_tenant`) alongside the global one, with ids `${tenantId}:${key}`,
-- resolved in two passes on read (ontology-service.ts:337-368). Mirrored here (blocks/i18n-key.ts):
--     GLOBAL block  → entity_type 'block',        entity_id = slug             (UNCHANGED)
--     TENANT block  → entity_type 'block_tenant', entity_id = tenantId||':'||slug
--
-- ⛔ MEASURED AGAINST PROD BEFORE WRITING THIS (2026-08-07). Both mutating branches below are
-- currently NO-OPS, and that is stated here rather than assumed:
--     building_blocks WHERE tenant_id IS NOT NULL  ->  0 rows
--     slugs owned by more than one row             ->  0 rows
--     content_translations WHERE entity_type='block' -> 14 rows, all global blocks
-- So the leak is REAL IN CODE but has never fired: no tenant has authored a block yet. The value
-- of this release is the CODE change — every block published from here on is keyed correctly — and
-- this migration is the durable data contract for the day those counts stop being zero. The
-- classification logic is written for the general case regardless, because a tenant could author a
-- block between this measurement and the deploy.
--
-- WHY THIS FILE ONLY EXPANDS, AND WHY IT IS PURE DML
-- -------------------------------------------------
-- Migrations run at backend STARTUP (server.ts:102) with 2-4 replicas rolling, so old and new code
-- run against one schema for the whole deploy window. This file therefore only COPIES rows to the
-- new key and leaves the legacy bare-slug rows in place, so a replica still running old code keeps
-- reading exactly what it read before. 0061 deletes the legacy rows in the NEXT release, once every
-- replica reads the new key. Same discipline as 0058 → 0059.
--
-- There is NO DDL here on purpose. The runner applies every pending file in ONE transaction with
-- per-file savepoints (db/migration-runner.ts:48-73), so a lock taken here would be held until the
-- last pending file commits. Pure DML takes ROW EXCLUSIVE only; no reader is ever blocked. The
-- existing PRIMARY KEY already indexes the new lookups (entity_type is its leading column), so
-- nothing needs to be added.
--
-- ⛔ THE ONE-WAY DOOR IS THE AMBIGUOUS SET, AND IT IS IN *THIS* FILE, NOT 0061.
-- A slug owned by more than one row (two tenants, or a tenant plus a platform block) has exactly
-- ONE bare-slug translation row, written by whichever publisher won the last upsert. Which one that
-- was is NOT RECOVERABLE from the data. Those rows are DELETED, not guessed — serving the wrong
-- tenant's document is the bug, and a heuristic that picked an owner would only make the wrong
-- answer harder to notice. Fresh jobs are minted from `building_blocks` + `block_versions` (which
-- DO carry ownership) so the loss is a re-translation, not a permanent gap. Today this set is
-- empty in prod (see the measurement above), so the destructive branch is a proven no-op.
--
-- ⛔ NO BARE-SLUG FALLBACK ON READ. The application must NOT fall back from 'block_tenant' to
-- 'block' for a tenant block — that fallback re-serves the poisoned row and reinstates the bug.
-- It costs nothing: no `en` row for entity_type 'block' has ever existed. enqueueTranslations only
-- mints TARGET_LOCALES = SUPPORTED_LOCALES minus 'en' (translation-service.ts:37-39);
-- getTranslationsBatch short-circuits to an empty map for 'en' (db/translations.ts:118-121); and no
-- seed or migration writes 'block' rows (0010 writes 'book', seed-marketplace-i18n writes
-- 'challenge'/'solution', seed-ontology-i18n writes 'ontology_entity'). The `en` base prose lives
-- on building_blocks.name/.description and block_versions.docs_md, and a missing translation
-- already degrades to those base columns. A tenant block with no row under the new key therefore
-- reads exactly like one that was never translated.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Classify every slug by ownership. `building_blocks_slug_owner_uq` (0037:33) guarantees at most
--    one global row per slug, so n_rows > 1 always implies at least one TENANT owner.
--    ⛔ archived blocks are INCLUDED: routes/blocks.ts archives rather than deletes, so an archived
--    block still holds its slug. Excluding it would mis-read an ambiguous slug as decidable and
--    attribute a row to the wrong tenant — the exact failure being fixed.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _b60_class ON COMMIT DROP AS
SELECT slug,
       count(*)                                                        AS n_rows,
       count(*) FILTER (WHERE tenant_id IS NULL)                       AS n_global,
       (array_agg(tenant_id) FILTER (WHERE tenant_id IS NOT NULL))[1]  AS sole_tenant
FROM building_blocks
GROUP BY slug;

CREATE TEMP TABLE _b60_decidable ON COMMIT DROP AS
SELECT slug, sole_tenant AS tenant_id FROM _b60_class WHERE n_rows = 1 AND n_global = 0;

CREATE TEMP TABLE _b60_ambiguous ON COMMIT DROP AS
SELECT slug FROM _b60_class WHERE n_rows > 1;

DO $$
DECLARE d int; a int;
BEGIN
  SELECT count(*) INTO d FROM _b60_decidable;
  SELECT count(*) INTO a FROM _b60_ambiguous;
  RAISE NOTICE '[0060] slugs: % decidable tenant-owned, % AMBIGUOUS (their rows will be DELETED)', d, a;
END $$;

-- ---------------------------------------------------------------------------
-- 2. COPY the decidable tenant-owned rows to the new key. Legacy rows stay put for 0061.
--    ⛔ DO NOTHING, never DO UPDATE: by the time this runs a new-code replica may already have
--    written the authoritative value under the new key, and the legacy row is then the STALE one.
-- ---------------------------------------------------------------------------
INSERT INTO content_translations (entity_type, entity_id, locale, field, value, updated_at)
SELECT 'block_tenant', d.tenant_id::text || ':' || ct.entity_id, ct.locale, ct.field, ct.value, ct.updated_at
FROM content_translations ct
JOIN _b60_decidable d ON d.slug = ct.entity_id
WHERE ct.entity_type = 'block'
ON CONFLICT (entity_type, entity_id, locale, field) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. Re-key the decidable QUEUE rows. The drainer (translation-service.ts:262-278) and the admin
--    override (routes/translations.ts) both write job.entity_type/entity_id VERBATIM, so a re-keyed
--    job lands under the new key with no code change at all.
--    Delete any legacy row that would collide with a job a new-code replica already enqueued
--    (translation_jobs_cell is UNIQUE) — the new one is authoritative.
-- ---------------------------------------------------------------------------
DELETE FROM translation_jobs j
USING _b60_decidable d
WHERE j.entity_type = 'block' AND j.entity_id = d.slug
  AND EXISTS (SELECT 1 FROM translation_jobs k
              WHERE k.entity_type = 'block_tenant'
                AND k.entity_id   = d.tenant_id::text || ':' || d.slug
                AND k.field = j.field AND k.target_locale = j.target_locale);

UPDATE translation_jobs j
SET entity_type = 'block_tenant',
    entity_id   = d.tenant_id::text || ':' || j.entity_id,
    updated_at  = now()
FROM _b60_decidable d
WHERE j.entity_type = 'block' AND j.entity_id = d.slug;

-- ---------------------------------------------------------------------------
-- 4. AMBIGUOUS + ORPHANED: delete. See the one-way-door note above.
--    Orphans (no building_blocks row at all) go too: they are unreachable, and leaving them means
--    the next block to take that slug silently inherits a stranger's prose.
-- ---------------------------------------------------------------------------
DELETE FROM content_translations ct
WHERE ct.entity_type = 'block'
  AND (EXISTS (SELECT 1 FROM _b60_ambiguous a WHERE a.slug = ct.entity_id)
       OR NOT EXISTS (SELECT 1 FROM building_blocks b WHERE b.slug = ct.entity_id));

DELETE FROM translation_jobs j
WHERE j.entity_type = 'block'
  AND (EXISTS (SELECT 1 FROM _b60_ambiguous a WHERE a.slug = j.entity_id)
       OR NOT EXISTS (SELECT 1 FROM building_blocks b WHERE b.slug = j.entity_id));

-- ---------------------------------------------------------------------------
-- 5. RE-QUEUE the ambiguous slugs, one job per owner × field × target locale, each under ITS OWN
--    key. Done in SQL rather than by asking an operator to hit POST /api/admin/translations/queue,
--    because backfillTranslations reads `building_blocks` through the request's RLS scope (global ∪
--    the admin's own tenant), so no admin request can reach another tenant's blocks. This migration
--    runs as the table OWNER and can.
--
--    source_hash must match host/translation-service.ts sourceHash() =
--    sha256(text, 'utf8').digest('hex') so a later enqueue with unchanged source is a no-op (its
--    `source_hash <> excluded.source_hash` guard). encode(sha256($$::bytea),'hex') is
--    byte-identical on a UTF8 database. sha256() is a core builtin since PG 11 — no pgcrypto.
--
--    requested_by = the block's own maintainer (a user of the OWNING tenant), NOT the legacy job's
--    requester, which for an ambiguous cell is the WRONG tenant's user and would meter the
--    re-translation against them. A block with no maintainer mints no job (processPendingBatch
--    fails such a job 'no metering actor'); it re-enqueues on its next publish.
--
--    Locales are the literal TARGET_LOCALES set: SUPPORTED_LOCALES (utils/locale.ts) minus 'en'.
--    Adding a locale to that array means adding it here too — or just re-running the admin
--    backfill, which is the normal path for a new locale anyway.
-- ---------------------------------------------------------------------------
INSERT INTO translation_jobs
  (entity_type, entity_id, field, target_locale, source_text, source_hash, status, attempts, requested_by)
SELECT
  CASE WHEN b.tenant_id IS NULL THEN 'block' ELSE 'block_tenant' END,
  CASE WHEN b.tenant_id IS NULL THEN b.slug ELSE b.tenant_id::text || ':' || b.slug END,
  f.field,
  loc.locale,
  f.value,
  encode(sha256(f.value::bytea), 'hex'),
  'pending', 0,
  b.maintainer_id
FROM building_blocks b
JOIN _b60_ambiguous a ON a.slug = b.slug
LEFT JOIN block_versions v ON v.id = b.current_version_id
CROSS JOIN LATERAL (VALUES ('name', b.name), ('description', b.description), ('docs_md', v.docs_md))
       AS f(field, value)
CROSS JOIN (VALUES ('nl'),('pl'),('fr'),('es'),('de'),('ar'),('he')) AS loc(locale)
WHERE b.archived = false
  AND b.maintainer_id IS NOT NULL
  AND f.value IS NOT NULL AND btrim(f.value) <> ''
ON CONFLICT (entity_type, entity_id, field, target_locale) DO NOTHING;

DO $$
DECLARE legacy int; fresh int;
BEGIN
  SELECT count(*) INTO legacy FROM content_translations WHERE entity_type = 'block';
  SELECT count(*) INTO fresh  FROM content_translations WHERE entity_type = 'block_tenant';
  RAISE NOTICE '[0060] content_translations after expand: % legacy ''block'' rows (0061 prunes the tenant-owned ones), % ''block_tenant'' rows', legacy, fresh;
END $$;
