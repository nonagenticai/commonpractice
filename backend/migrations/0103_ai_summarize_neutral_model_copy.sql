-- 0103_ai_summarize_neutral_model_copy.sql — `ai-summarize` stops claiming it runs on Claude Sonnet,
-- in the `en` base columns AND in the 7 non-en editions migration 0073 promoted into git.
--
-- WHAT WAS WRONG
-- --------------
-- The block's description read "Calls Claude Sonnet to produce a length-controlled summary…" and its
-- docs "…via Claude Sonnet." Since 0102 the block names no model at all: the broker resolves it to the
-- tenant's own configured model when the tenant brought a key, otherwise to AGENT_MODEL (`local-llm`,
-- the platform's in-cluster router). Owner rule 2026-10-13: the platform never pays for a commercial
-- model. So for almost every reader the sentence named a model the block does not, and may not, call.
-- The neutral wording is "the configured LLM", which is true for both kinds of tenant.
--
-- ⛔ WHY A MIGRATION AS WELL AS THE SEED EDIT — same split as 0076. `seed()` skips a slug that already
-- exists and prod runs with SEED_DEMO_DATA off, so the seed literal (src/db/seed.ts, corrected in the
-- same change) repairs only a database with no row yet. On a fresh CI database `bun run migrate` runs
-- BEFORE `bun run seed`, so the base-column UPDATEs below match 0 rows there; the INSERT still lands.
--
-- SCOPE. GLOBAL block only (`building_blocks.tenant_id IS NULL`; `entity_type='block'` with the bare
-- slug as `entity_id`, 0060's key contract). `block_tenant` rows and tenant forks are never touched.
-- EVERY version's docs_md is rewritten (the version picker serves any of them). No `en` row is inserted
-- into `content_translations`: `en` is served from the base columns.
--
-- PURE DML. Dollar-quoted `$t$…$t$` values. IDEMPOTENT: absolute assignments + `ON CONFLICT … DO
-- UPDATE`, matching 0073/0076. The trailing check refuses to finish with a 'Claude Sonnet' left in any
-- of the rows this file owns.

-- ---------------------------------------------------------------------------
-- 1. The `en` base — building_blocks.description and every version's docs_md.
-- ---------------------------------------------------------------------------
UPDATE building_blocks
SET description = $t$Calls the configured LLM to produce a length-controlled summary. Configurable: tone, max lines, language.$t$,
    updated_at = now()
WHERE slug = 'ai-summarize' AND tenant_id IS NULL;

UPDATE block_versions
SET docs_md = $t$# ai-summarize

Produces a length-controlled summary via the configured LLM. Configure `tone` and `max_lines`.$t$
WHERE block_id IN (SELECT id FROM building_blocks WHERE slug = 'ai-summarize' AND tenant_id IS NULL)
  AND docs_md ILIKE '%claude sonnet%';  -- same case-insensitive predicate as the post-condition

-- ---------------------------------------------------------------------------
-- 2. The 7 non-en editions. Overwrites the 0073 rows for these cells.
-- ---------------------------------------------------------------------------
INSERT INTO content_translations (entity_type, entity_id, locale, field, value) VALUES
  -- ai-summarize · description
  ('block', 'ai-summarize', 'nl', 'description', $t$Roept het geconfigureerde LLM aan om een samenvatting met een gecontroleerde lengte te genereren. Configureerbaar: toon, max regels, taal.$t$),
  ('block', 'ai-summarize', 'de', 'description', $t$Ruft das konfigurierte LLM auf, um eine längenkontrollierte Zusammenfassung zu erstellen. Konfigurierbar: Tonfall, maximale Zeilenanzahl, Sprache.$t$),
  ('block', 'ai-summarize', 'fr', 'description', $t$Appelle le LLM configuré pour produire un résumé à longueur contrôlée. Configurable : ton, nombre maximum de lignes, langue.$t$),
  ('block', 'ai-summarize', 'es', 'description', $t$Llama al LLM configurado para producir un resumen de longitud controlada. Configurable: tono, líneas máximas, idioma.$t$),
  ('block', 'ai-summarize', 'pl', 'description', $t$Wywołuje skonfigurowany model LLM w celu wygenerowania podsumowania o kontrolowanej długości. Konfigurowalne: ton, maksymalna liczba linii, język.$t$),
  ('block', 'ai-summarize', 'ar', 'description', $t$يستدعي نموذج LLM المُهيَّأ لإنتاج ملخص محكوم الطول. قابل للضبط: النبرة، الحد الأقصى للأسطر، واللغة.$t$),
  ('block', 'ai-summarize', 'he', 'description', $t$מפעיל את מודל ה-LLM שהוגדר כדי להפיק סיכום מוגבל אורך. ניתן להגדרה: טון, מקסימום שורות, שפה.$t$),

  -- ai-summarize · docs_md
  ('block', 'ai-summarize', 'nl', 'docs_md', $t$# ai-summarize

Genereert een samenvatting met gecontroleerde lengte via het geconfigureerde LLM. Configureer `tone` en `max_lines`.$t$),
  ('block', 'ai-summarize', 'de', 'docs_md', $t$# ai-summarize

Erzeugt eine längengesteuerte Zusammenfassung über das konfigurierte LLM. Konfiguriere `tone` und `max_lines`.$t$),
  ('block', 'ai-summarize', 'fr', 'docs_md', $t$# ai-summarize

Produit un résumé de longueur contrôlée via le LLM configuré. Configurez `tone` et `max_lines`.$t$),
  ('block', 'ai-summarize', 'es', 'docs_md', $t$# ai-summarize

Produce un resumen de longitud controlada a través del LLM configurado. Configura `tone` y `max_lines`.$t$),
  ('block', 'ai-summarize', 'pl', 'docs_md', $t$# ai-summarize

Generuje streszczenie o kontrolowanej długości za pomocą skonfigurowanego modelu LLM. Skonfiguruj `tone` oraz `max_lines`.$t$),
  ('block', 'ai-summarize', 'ar', 'docs_md', $t$# ai-summarize

ينتج ملخصاً محكوماً بالطول عبر نموذج LLM المُهيَّأ. قم بتكوين `tone` و `max_lines`.$t$),
  ('block', 'ai-summarize', 'he', 'docs_md', $t$# ai-summarize

מייצר סיכום מבוקר אורך באמצעות מודל ה-LLM שהוגדר. הגדר את `tone` ו-`max_lines`.$t$)
ON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- ---------------------------------------------------------------------------
-- 3. Post-condition: nothing this file owns still names Claude Sonnet.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  left_over int;
BEGIN
  SELECT
    (SELECT count(*) FROM content_translations
      WHERE entity_type = 'block' AND entity_id = 'ai-summarize'
        AND field IN ('description', 'docs_md') AND value ILIKE '%claude sonnet%')
  + (SELECT count(*) FROM building_blocks
      WHERE slug = 'ai-summarize' AND tenant_id IS NULL AND description ILIKE '%claude sonnet%')
  + (SELECT count(*) FROM block_versions v JOIN building_blocks b ON b.id = v.block_id
      WHERE b.slug = 'ai-summarize' AND b.tenant_id IS NULL AND v.docs_md ILIKE '%claude sonnet%')
  INTO left_over;
  IF left_over > 0 THEN
    RAISE EXCEPTION '0103: % ai-summarize row(s) still name Claude Sonnet after the rewrite', left_over;
  END IF;
END $$;
