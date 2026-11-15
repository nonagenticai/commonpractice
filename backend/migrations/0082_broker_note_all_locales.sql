-- 0082_broker_note_all_locales.sql — the demo tenant's own ontology entity, `BrokerNote`, in the
-- five locales it was missing (fr, es, pl, ar, he). Hand-written, not generated: this is a single
-- entity from `src/db/seed-ontology-tenant.ts`, which has no generator.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- Measured in the production database, this was the ONLY asymmetry left in the whole translation
-- corpus:
--
--     nl | 350 rows | 9 entity types          ar | 346 rows | 8 entity types
--     de | 350 rows | 9 entity types          he | 346 rows | 8 entity types
--                                             es / fr / pl | 346 | 8
--
-- The entire difference is `ontology_entity_tenant` — this entity's `label` and `description`, 4
-- rows, present for nl/de and absent for the other five. So an Arabic or Hebrew reader browsing
-- the demo org's ontology saw the English "Broker Note" while a Dutch reader saw theirs. Arabic
-- and Hebrew are primary markets.
--
-- It was not a decision. `seed-ontology-tenant.ts` carried the comment "a couple of locales … so
-- `?locale=nl` shows a localized *custom* object" — an honest Phase 3.7 proof-of-concept that
-- picked nl/de because Dutch was the locale the product was demoed in, and then stayed.
--
-- ⛔ AND FIXING THE SEED ALONE WOULD HAVE CHANGED NOTHING IN PRODUCTION — the same trap
-- 0080_ontology_i18n.sql documents at length. The live Deployment sets `SEED_DEMO_DATA=false`
-- (verified on the running deploy, not assumed), so `src/server.ts` never calls `seedAll()` there.
-- `applyMigrations()` runs on every boot; the seed does not. A seed-only fix is inert in prod while
-- looking complete in the diff.
--
-- ⚠️ THE TENANT ID IS DERIVED, NOT PASTED. The i18n key is `tenantEntityI18nId(tenantId, key)` =
-- `<tenant uuid>:industry_dept:insurance:Claims:BrokerNote`, so the ids differ per environment.
-- Selecting from `ontology_entities` rather than hard-coding the production UUID means this
-- migration is correct on a fresh CI database, on a developer's box and in prod, and — because it
-- is keyed on rows that actually exist — it inserts nothing for a tenant that has no BrokerNote
-- rather than creating orphan translations for an entity nobody has.
--
-- ⚠️ THOSE 4 ROWS SPAN TWO entity_ids BUT ONLY ONE LIVE TENANT — checked, because "two tenants"
-- was the obvious reading and it is wrong. `ontology_entities` holds exactly ONE BrokerNote, for
-- `common-practice-demo` (00000000-…-0001). The other id, `9d65c57a-…:…:BrokerNote`, references a
-- tenant that is NOT in `tenants` at all — orphan translations left by a tenant that was removed.
-- They are unreachable: the read path derives the key from a live tenant id, so nothing ever looks
-- them up. This migration therefore writes 10 rows (1 tenant × 5 locales × 2 fields), verified by
-- running its SELECT read-only against production before committing. The orphans are left alone:
-- deleting production rows is not this change's business, and they cost a reader nothing.
--
-- ⚠️ `en` IS DELIBERATELY ABSENT. `getTranslationsBatch` short-circuits the base locale and returns
-- an empty map, so an `en` row here would be unreachable by construction — coverage that does
-- nothing, which is worse than a visible gap.

INSERT INTO content_translations (entity_type, entity_id, locale, field, value)
SELECT
  'ontology_entity_tenant',
  e.tenant_id::text || ':industry_dept:insurance:Claims:BrokerNote',
  v.locale,
  v.field,
  v.value
FROM ontology_entities e
CROSS JOIN (VALUES
  ('fr', 'label',       $t$Note du courtier$t$),
  ('fr', 'description', $t$La note d'un courtier jointe à un sinistre — le type d'objet propre à cette organisation.$t$),
  ('es', 'label',       $t$Nota del corredor$t$),
  ('es', 'description', $t$La nota de un corredor adjunta a un siniestro: el tipo de objeto propio de esta organización.$t$),
  ('pl', 'label',       $t$Notatka brokera$t$),
  ('pl', 'description', $t$Notatka brokera dołączona do szkody — własny typ obiektu tej organizacji.$t$),
  ('ar', 'label',       $t$ملاحظة الوسيط$t$),
  ('ar', 'description', $t$ملاحظة من الوسيط مرفقة بمطالبة — نوع الكائن الخاص بهذه المؤسسة.$t$),
  ('he', 'label',       $t$הערת סוכן$t$),
  ('he', 'description', $t$הערה של סוכן המצורפת לתביעה — סוג האובייקט הייחודי של הארגון הזה.$t$)
) AS v(locale, field, value)
WHERE e.scope = 'industry_dept'
  AND e.industry = 'insurance'
  AND e.department = 'Claims'
  AND e.name = 'BrokerNote'
  AND e.tenant_id IS NOT NULL

ON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();
