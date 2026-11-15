-- 0073_block_display_names_and_i18n.sql — the block catalogue's display names, in en and in the
-- 7 non-en editions (§5B), promoted from prod-only DB state into git.
--
-- WHY THIS FILE EXISTS AT ALL
-- ---------------------------
-- The 504 `content_translations` rows for `entity_type='block'` were produced on 2026-08-08 by the
-- LLM translation pipeline (host/translation-service.ts) writing straight into PRODUCTION. They
-- were never in git, so CI and every developer database had ZERO of them: the block cards on any
-- non-`en` locale silently degraded to the `en` base columns everywhere except prod. That alone is
-- a reason to commit them — an artifact that exists only as prod row-state is not reviewable, not
-- testable, and not recoverable.
--
-- WHAT WAS BROKEN, MEASURED
-- -------------------------
-- The `description` and `docs_md` translations are good; they are carried below verbatim from the
-- prod export, with EXACTLY ONE stated exception. A byte-for-byte diff of all 336 against live prod
-- was run before this shipped: 335 identical, and `ocr-scan`/`he`/`docs_md` deliberately not.
-- ⛔ THAT ONE ROW IS A HAND-AUTHORED CHANGE, NOT A CARRY, and it has had no translation review.
-- Prod holds the English string there ("Hybrid Tesseract + Claude OCR for messy scans.") — measured
-- as the ONLY one of the 24 `he`/`docs_md` rows containing no Hebrew at all, i.e. a hole the
-- pipeline left, not prose it produced. This fills it. Because these INSERTs are `DO UPDATE`, that
-- distinction is the whole safety argument: every other value here is provably the same bytes prod
-- already serves, so this migration cannot silently rewrite reviewed prose. The `name` translations are not. `name` is a 1-3 word display string, and the
-- pipeline treated the *identifier* as translatable prose, so per locale it produced a mix of:
--   * UNTRANSLATED  — the raw English slug rendered on a localized card (`load-dataset` in all 7);
--   * IDENTIFIER-MANGLED — a translated word forced back into slug shape (nl `ai-samenvatten`,
--     `velden-extraheren`; fr `résumé-ia`; he `סיכום-ai`);
--   * SEMANTICALLY WRONG — `policy` read as governance rather than insurance (nl `Beleidgegevens`,
--     de `Richtliniendaten`, ar `بيانات السياسة`, he `נתוני מדיניות`) even though the block's own
--     translated description says "a contract between the insurer and the policyholder"; and de
--     `compose-claim-decision` = "Bescheid über die Leistungsablehnung erstellen", which invents a
--     DENIAL for a block that composes the decision either way.
-- Measured for nl: 8 of 24 acceptable, 11 untranslated, 3 identifier-mangled, 2 wrong.
-- de 11/24 bad, fr and es ~14/24 bad. All 168 `name` cells below are hand-curated; the ones prod
-- already had right (nl `Rijen filteren`, de `Kundendaten`, …) are preserved unchanged.
--
-- The `en` base was unfinished too: 13 of the 24 `building_blocks.name` values were IDENTICAL to
-- the slug, so the card title was the identifier — while the other 11 carried real display names
-- ("Filter rows", "Compose claim decision", "Summary card"). The UPDATEs below finish the set.
-- `example-claim-data` additionally carried the derivation artifact "Claim (Claims desk) data".
--
-- ⛔ THE UPDATEs BELOW ARE ONLY HALF THE `en` FIX, ON PURPOSE.
-- CI and a fresh developer database run `bun run migrate` BEFORE `bun run seed`, so at the moment
-- this file executes on a new cluster `building_blocks` is EMPTY and every UPDATE matches 0 rows;
-- the seeders then insert the names they were always going to insert. The seed literals are
-- therefore corrected in the same change (src/db/seed.ts, src/db/seed-datasets.ts) — this file is
-- what repairs the EXISTING rows in prod, where `upsertGlobalBlock`/`seedAll` skip a block whose
-- slug already exists and would never overwrite the bad name. Neither half is redundant.
--
-- SCOPE. Global blocks only: `entity_type='block'`, `entity_id` = the bare slug (0060's key
-- contract). Tenant-authored blocks live under `block_tenant` with `tenantId||':'||slug` and are
-- deliberately untouched — no tenant has authored a block, and their prose is not ours to write.
-- No `en` row is inserted: `en` is served from the base columns and getTranslationsBatch
-- short-circuits `en` to an empty map (db/translations.ts:118-121).
--
-- IDEMPOTENT. `ON CONFLICT … DO UPDATE` on the (entity_type, entity_id, locale, field) primary key,
-- so re-applying refreshes rather than fails — matching 0010_book_translations.sql. The runner
-- applies each file exactly once (`_migrations`), so on prod this runs once and overwrites the
-- mangled names in place.
--
-- Every value is dollar-quoted `$t$…$t$` so apostrophes, newlines and markdown backticks survive.
-- Guarded by tests/block-i18n-coverage.test.ts.

-- ---------------------------------------------------------------------------
-- 1. The `en` base display names — the 13 slug-titled blocks plus the one derivation artifact.
-- ---------------------------------------------------------------------------

UPDATE building_blocks SET name = $t$Summarize with AI$t$, updated_at = now() WHERE slug = 'ai-summarize' AND tenant_id IS NULL;
UPDATE building_blocks SET name = $t$Classify text$t$, updated_at = now() WHERE slug = 'classify' AND tenant_id IS NULL;
UPDATE building_blocks SET name = $t$Compare documents$t$, updated_at = now() WHERE slug = 'compare-docs' AND tenant_id IS NULL;
UPDATE building_blocks SET name = $t$Claim data$t$, updated_at = now() WHERE slug = 'example-claim-data' AND tenant_id IS NULL;
UPDATE building_blocks SET name = $t$Extract fields$t$, updated_at = now() WHERE slug = 'extract-fields' AND tenant_id IS NULL;
UPDATE building_blocks SET name = $t$Flag anomalies$t$, updated_at = now() WHERE slug = 'flag-anomalies' AND tenant_id IS NULL;
UPDATE building_blocks SET name = $t$Format output$t$, updated_at = now() WHERE slug = 'format-output' AND tenant_id IS NULL;
UPDATE building_blocks SET name = $t$If / else$t$, updated_at = now() WHERE slug = 'if-else' AND tenant_id IS NULL;
UPDATE building_blocks SET name = $t$Load dataset$t$, updated_at = now() WHERE slug = 'load-dataset' AND tenant_id IS NULL;
UPDATE building_blocks SET name = $t$Look up policy$t$, updated_at = now() WHERE slug = 'lookup-policy' AND tenant_id IS NULL;
UPDATE building_blocks SET name = $t$OCR scan$t$, updated_at = now() WHERE slug = 'ocr-scan' AND tenant_id IS NULL;
UPDATE building_blocks SET name = $t$Read claim form$t$, updated_at = now() WHERE slug = 'read-claim-form' AND tenant_id IS NULL;
UPDATE building_blocks SET name = $t$Read customer record$t$, updated_at = now() WHERE slug = 'read-customer-record' AND tenant_id IS NULL;
UPDATE building_blocks SET name = $t$Review panel$t$, updated_at = now() WHERE slug = 'review-panel' AND tenant_id IS NULL;

-- ---------------------------------------------------------------------------
-- 2. `name` — 24 blocks x 7 locales. HAND-CURATED, not the pipeline output. Display strings in the
--    target language's normal orthography: never an identifier, never a hyphenated slug.
-- ---------------------------------------------------------------------------
INSERT INTO content_translations (entity_type, entity_id, locale, field, value) VALUES
  ('block', 'ai-summarize',            'nl', 'name', $t$Samenvatten met AI$t$),
  ('block', 'ai-summarize',            'de', 'name', $t$Mit KI zusammenfassen$t$),
  ('block', 'ai-summarize',            'fr', 'name', $t$Résumer avec l’IA$t$),
  ('block', 'ai-summarize',            'es', 'name', $t$Resumir con IA$t$),
  ('block', 'ai-summarize',            'pl', 'name', $t$Podsumuj za pomocą AI$t$),
  ('block', 'ai-summarize',            'ar', 'name', $t$التلخيص بالذكاء الاصطناعي$t$),
  ('block', 'ai-summarize',            'he', 'name', $t$סיכום באמצעות AI$t$),
  ('block', 'classify',                'nl', 'name', $t$Tekst classificeren$t$),
  ('block', 'classify',                'de', 'name', $t$Text klassifizieren$t$),
  ('block', 'classify',                'fr', 'name', $t$Classer le texte$t$),
  ('block', 'classify',                'es', 'name', $t$Clasificar texto$t$),
  ('block', 'classify',                'pl', 'name', $t$Klasyfikuj tekst$t$),
  ('block', 'classify',                'ar', 'name', $t$تصنيف النص$t$),
  ('block', 'classify',                'he', 'name', $t$סיווג טקסט$t$),
  ('block', 'compare-docs',            'nl', 'name', $t$Documenten vergelijken$t$),
  ('block', 'compare-docs',            'de', 'name', $t$Dokumente vergleichen$t$),
  ('block', 'compare-docs',            'fr', 'name', $t$Comparer des documents$t$),
  ('block', 'compare-docs',            'es', 'name', $t$Comparar documentos$t$),
  ('block', 'compare-docs',            'pl', 'name', $t$Porównaj dokumenty$t$),
  ('block', 'compare-docs',            'ar', 'name', $t$مقارنة المستندات$t$),
  ('block', 'compare-docs',            'he', 'name', $t$השוואת מסמכים$t$),
  ('block', 'compose-claim-decision',  'nl', 'name', $t$Claimbeslissing opstellen$t$),
  ('block', 'compose-claim-decision',  'de', 'name', $t$Schadenentscheidung erstellen$t$),
  ('block', 'compose-claim-decision',  'fr', 'name', $t$Rédiger la décision de réclamation$t$),
  ('block', 'compose-claim-decision',  'es', 'name', $t$Redactar la decisión de la reclamación$t$),
  ('block', 'compose-claim-decision',  'pl', 'name', $t$Sformułuj decyzję w sprawie roszczenia$t$),
  ('block', 'compose-claim-decision',  'ar', 'name', $t$صياغة قرار المطالبة$t$),
  ('block', 'compose-claim-decision',  'he', 'name', $t$ניסוח החלטה בתביעה$t$),
  ('block', 'example-claim-data',      'nl', 'name', $t$Claimgegevens$t$),
  ('block', 'example-claim-data',      'de', 'name', $t$Schadendaten$t$),
  ('block', 'example-claim-data',      'fr', 'name', $t$Données de sinistre$t$),
  ('block', 'example-claim-data',      'es', 'name', $t$Datos de reclamación$t$),
  ('block', 'example-claim-data',      'pl', 'name', $t$Dane roszczenia$t$),
  ('block', 'example-claim-data',      'ar', 'name', $t$بيانات المطالبة$t$),
  ('block', 'example-claim-data',      'he', 'name', $t$נתוני תביעה$t$),
  ('block', 'example-customer-data',   'nl', 'name', $t$Klantgegevens$t$),
  ('block', 'example-customer-data',   'de', 'name', $t$Kundendaten$t$),
  ('block', 'example-customer-data',   'fr', 'name', $t$Données client$t$),
  ('block', 'example-customer-data',   'es', 'name', $t$Datos del cliente$t$),
  ('block', 'example-customer-data',   'pl', 'name', $t$Dane klienta$t$),
  ('block', 'example-customer-data',   'ar', 'name', $t$بيانات العميل$t$),
  ('block', 'example-customer-data',   'he', 'name', $t$נתוני לקוח$t$),
  ('block', 'example-policy-data',     'nl', 'name', $t$Polisgegevens$t$),
  ('block', 'example-policy-data',     'de', 'name', $t$Policendaten$t$),
  ('block', 'example-policy-data',     'fr', 'name', $t$Données de police d'assurance$t$),
  ('block', 'example-policy-data',     'es', 'name', $t$Datos de póliza$t$),
  ('block', 'example-policy-data',     'pl', 'name', $t$Dane polisy$t$),
  ('block', 'example-policy-data',     'ar', 'name', $t$بيانات وثيقة التأمين$t$),
  ('block', 'example-policy-data',     'he', 'name', $t$נתוני פוליסה$t$),
  ('block', 'extract-fields',          'nl', 'name', $t$Velden extraheren$t$),
  ('block', 'extract-fields',          'de', 'name', $t$Felder extrahieren$t$),
  ('block', 'extract-fields',          'fr', 'name', $t$Extraire les champs$t$),
  ('block', 'extract-fields',          'es', 'name', $t$Extraer campos$t$),
  ('block', 'extract-fields',          'pl', 'name', $t$Wyodrębnij pola$t$),
  ('block', 'extract-fields',          'ar', 'name', $t$استخراج الحقول$t$),
  ('block', 'extract-fields',          'he', 'name', $t$חילוץ שדות$t$),
  ('block', 'filter-rows',             'nl', 'name', $t$Rijen filteren$t$),
  ('block', 'filter-rows',             'de', 'name', $t$Zeilen filtern$t$),
  ('block', 'filter-rows',             'fr', 'name', $t$Filtrer les lignes$t$),
  ('block', 'filter-rows',             'es', 'name', $t$Filtrar filas$t$),
  ('block', 'filter-rows',             'pl', 'name', $t$Filtruj wiersze$t$),
  ('block', 'filter-rows',             'ar', 'name', $t$تصفية الصفوف$t$),
  ('block', 'filter-rows',             'he', 'name', $t$סינון שורות$t$),
  ('block', 'flag-anomalies',          'nl', 'name', $t$Afwijkingen markeren$t$),
  ('block', 'flag-anomalies',          'de', 'name', $t$Anomalien markieren$t$),
  ('block', 'flag-anomalies',          'fr', 'name', $t$Signaler les anomalies$t$),
  ('block', 'flag-anomalies',          'es', 'name', $t$Marcar anomalías$t$),
  ('block', 'flag-anomalies',          'pl', 'name', $t$Oznacz anomalie$t$),
  ('block', 'flag-anomalies',          'ar', 'name', $t$تمييز الحالات الشاذة$t$),
  ('block', 'flag-anomalies',          'he', 'name', $t$סימון חריגות$t$),
  ('block', 'format-output',           'nl', 'name', $t$Uitvoer opmaken$t$),
  ('block', 'format-output',           'de', 'name', $t$Ausgabe formatieren$t$),
  ('block', 'format-output',           'fr', 'name', $t$Formater la sortie$t$),
  ('block', 'format-output',           'es', 'name', $t$Formatear la salida$t$),
  ('block', 'format-output',           'pl', 'name', $t$Sformatuj wynik$t$),
  ('block', 'format-output',           'ar', 'name', $t$تنسيق المخرجات$t$),
  ('block', 'format-output',           'he', 'name', $t$עיצוב הפלט$t$),
  ('block', 'group-and-count',         'nl', 'name', $t$Groeperen en tellen$t$),
  ('block', 'group-and-count',         'de', 'name', $t$Gruppieren und zählen$t$),
  ('block', 'group-and-count',         'fr', 'name', $t$Grouper et compter$t$),
  ('block', 'group-and-count',         'es', 'name', $t$Agrupar y contar$t$),
  ('block', 'group-and-count',         'pl', 'name', $t$Grupuj i licz$t$),
  ('block', 'group-and-count',         'ar', 'name', $t$تجميع وعدّ$t$),
  ('block', 'group-and-count',         'he', 'name', $t$קיבוץ וספירה$t$),
  ('block', 'if-else',                 'nl', 'name', $t$Als / anders$t$),
  ('block', 'if-else',                 'de', 'name', $t$Wenn / sonst$t$),
  ('block', 'if-else',                 'fr', 'name', $t$Si / sinon$t$),
  ('block', 'if-else',                 'es', 'name', $t$Si / si no$t$),
  ('block', 'if-else',                 'pl', 'name', $t$Jeżeli / w przeciwnym razie$t$),
  ('block', 'if-else',                 'ar', 'name', $t$إذا / وإلا$t$),
  ('block', 'if-else',                 'he', 'name', $t$אם / אחרת$t$),
  ('block', 'load-dataset',            'nl', 'name', $t$Dataset laden$t$),
  ('block', 'load-dataset',            'de', 'name', $t$Datensatz laden$t$),
  ('block', 'load-dataset',            'fr', 'name', $t$Charger un jeu de données$t$),
  ('block', 'load-dataset',            'es', 'name', $t$Cargar conjunto de datos$t$),
  ('block', 'load-dataset',            'pl', 'name', $t$Wczytaj zbiór danych$t$),
  ('block', 'load-dataset',            'ar', 'name', $t$تحميل مجموعة البيانات$t$),
  ('block', 'load-dataset',            'he', 'name', $t$טעינת מערך נתונים$t$),
  ('block', 'lookup-policy',           'nl', 'name', $t$Polis opzoeken$t$),
  ('block', 'lookup-policy',           'de', 'name', $t$Police nachschlagen$t$),
  ('block', 'lookup-policy',           'fr', 'name', $t$Rechercher la police d'assurance$t$),
  ('block', 'lookup-policy',           'es', 'name', $t$Buscar póliza$t$),
  ('block', 'lookup-policy',           'pl', 'name', $t$Wyszukaj polisę$t$),
  ('block', 'lookup-policy',           'ar', 'name', $t$البحث عن وثيقة التأمين$t$),
  ('block', 'lookup-policy',           'he', 'name', $t$חיפוש פוליסה$t$),
  ('block', 'ocr-scan',                'nl', 'name', $t$OCR-scan$t$),
  ('block', 'ocr-scan',                'de', 'name', $t$OCR-Scan$t$),
  ('block', 'ocr-scan',                'fr', 'name', $t$Numérisation OCR$t$),
  ('block', 'ocr-scan',                'es', 'name', $t$Escaneo OCR$t$),
  ('block', 'ocr-scan',                'pl', 'name', $t$Skan OCR$t$),
  ('block', 'ocr-scan',                'ar', 'name', $t$مسح ضوئي باستخدام OCR$t$),
  ('block', 'ocr-scan',                'he', 'name', $t$סריקת OCR$t$),
  ('block', 'read-claim-form',         'nl', 'name', $t$Claimformulier lezen$t$),
  ('block', 'read-claim-form',         'de', 'name', $t$Schadenformular lesen$t$),
  ('block', 'read-claim-form',         'fr', 'name', $t$Lire le formulaire de réclamation$t$),
  ('block', 'read-claim-form',         'es', 'name', $t$Leer el formulario de reclamación$t$),
  ('block', 'read-claim-form',         'pl', 'name', $t$Odczytaj formularz roszczenia$t$),
  ('block', 'read-claim-form',         'ar', 'name', $t$قراءة نموذج المطالبة$t$),
  ('block', 'read-claim-form',         'he', 'name', $t$קריאת טופס תביעה$t$),
  ('block', 'read-customer-record',    'nl', 'name', $t$Klantrecord lezen$t$),
  ('block', 'read-customer-record',    'de', 'name', $t$Kundendatensatz lesen$t$),
  ('block', 'read-customer-record',    'fr', 'name', $t$Lire la fiche client$t$),
  ('block', 'read-customer-record',    'es', 'name', $t$Leer la ficha del cliente$t$),
  ('block', 'read-customer-record',    'pl', 'name', $t$Odczytaj rekord klienta$t$),
  ('block', 'read-customer-record',    'ar', 'name', $t$قراءة سجل العميل$t$),
  ('block', 'read-customer-record',    'he', 'name', $t$קריאת רשומת לקוח$t$),
  ('block', 'record-form',             'nl', 'name', $t$Registratieformulier$t$),
  ('block', 'record-form',             'de', 'name', $t$Datensatzformular$t$),
  ('block', 'record-form',             'fr', 'name', $t$Formulaire d’enregistrement$t$),
  ('block', 'record-form',             'es', 'name', $t$Formulario de registro$t$),
  ('block', 'record-form',             'pl', 'name', $t$Formularz rekordu$t$),
  ('block', 'record-form',             'ar', 'name', $t$نموذج السجل$t$),
  ('block', 'record-form',             'he', 'name', $t$טופס רישום$t$),
  ('block', 'review-panel',            'nl', 'name', $t$Beoordelingspaneel$t$),
  ('block', 'review-panel',            'de', 'name', $t$Prüfpanel$t$),
  ('block', 'review-panel',            'fr', 'name', $t$Panneau de révision$t$),
  ('block', 'review-panel',            'es', 'name', $t$Panel de revisión$t$),
  ('block', 'review-panel',            'pl', 'name', $t$Panel przeglądu$t$),
  ('block', 'review-panel',            'ar', 'name', $t$لوحة المراجعة$t$),
  ('block', 'review-panel',            'he', 'name', $t$לוח סקירה$t$),
  ('block', 'rows-to-csv',             'nl', 'name', $t$Rijen naar CSV$t$),
  ('block', 'rows-to-csv',             'de', 'name', $t$Zeilen in CSV$t$),
  ('block', 'rows-to-csv',             'fr', 'name', $t$Lignes vers CSV$t$),
  ('block', 'rows-to-csv',             'es', 'name', $t$Filas a CSV$t$),
  ('block', 'rows-to-csv',             'pl', 'name', $t$Wiersze do CSV$t$),
  ('block', 'rows-to-csv',             'ar', 'name', $t$تحويل الصفوف إلى CSV$t$),
  ('block', 'rows-to-csv',             'he', 'name', $t$שורות ל-CSV$t$),
  ('block', 'summary-card',            'nl', 'name', $t$Samenvattingskaart$t$),
  ('block', 'summary-card',            'de', 'name', $t$Zusammenfassungskarte$t$),
  ('block', 'summary-card',            'fr', 'name', $t$Carte de résumé$t$),
  ('block', 'summary-card',            'es', 'name', $t$Tarjeta de resumen$t$),
  ('block', 'summary-card',            'pl', 'name', $t$Karta podsumowania$t$),
  ('block', 'summary-card',            'ar', 'name', $t$بطاقة الملخص$t$),
  ('block', 'summary-card',            'he', 'name', $t$כרטיס סיכום$t$),
  ('block', 'table-view',              'nl', 'name', $t$Tabelweergave$t$),
  ('block', 'table-view',              'de', 'name', $t$Tabellenansicht$t$),
  ('block', 'table-view',              'fr', 'name', $t$Vue en tableau$t$),
  ('block', 'table-view',              'es', 'name', $t$Vista de tabla$t$),
  ('block', 'table-view',              'pl', 'name', $t$Widok tabeli$t$),
  ('block', 'table-view',              'ar', 'name', $t$عرض الجدول$t$),
  ('block', 'table-view',              'he', 'name', $t$תצוגת טבלה$t$),
  ('block', 'triage-claim',            'nl', 'name', $t$Claim beoordelen$t$),
  ('block', 'triage-claim',            'de', 'name', $t$Schaden einstufen$t$),
  ('block', 'triage-claim',            'fr', 'name', $t$Trier la réclamation$t$),
  ('block', 'triage-claim',            'es', 'name', $t$Priorizar la reclamación$t$),
  ('block', 'triage-claim',            'pl', 'name', $t$Segregacja roszczeń$t$),
  ('block', 'triage-claim',            'ar', 'name', $t$فرز المطالبة$t$),
  ('block', 'triage-claim',            'he', 'name', $t$מיון תביעות$t$)
ON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- ---------------------------------------------------------------------------
-- 3. `description` — 24 x 7, carried VERBATIM from the 2026-08-08 prod rows (good quality).
-- ---------------------------------------------------------------------------
INSERT INTO content_translations (entity_type, entity_id, locale, field, value) VALUES
  ('block', 'ai-summarize',            'nl', 'description', $t$Roept Claude Sonnet aan om een samenvatting met een gecontroleerde lengte te genereren. Configureerbaar: toon, max regels, taal.$t$),
  ('block', 'ai-summarize',            'de', 'description', $t$Ruft Claude Sonnet auf, um eine längenkontrollierte Zusammenfassung zu erstellen. Konfigurierbar: Tonfall, maximale Zeilenanzahl, Sprache.$t$),
  ('block', 'ai-summarize',            'fr', 'description', $t$Appelle Claude Sonnet pour produire un résumé à longueur contrôlée. Configurable : ton, nombre maximum de lignes, langue.$t$),
  ('block', 'ai-summarize',            'es', 'description', $t$Llama a Claude Sonnet para producir un resumen de longitud controlada. Configurable: tono, líneas máximas, idioma.$t$),
  ('block', 'ai-summarize',            'pl', 'description', $t$Wywołuje Claude Sonnet w celu wygenerowania podsumowania o kontrolowanej długości. Konfigurowalne: ton, maksymalna liczba linii, język.$t$),
  ('block', 'ai-summarize',            'ar', 'description', $t$يستدعي Claude Sonnet لإنتاج ملخص محكوم الطول. قابل للضبط: النبرة، الحد الأقصى للأسطر، واللغة.$t$),
  ('block', 'ai-summarize',            'he', 'description', $t$מפעיל את Claude Sonnet כדי להפיק סיכום מוגבל אורך. ניתן להגדרה: טון, מקסימום שורות, שפה.$t$),
  ('block', 'classify',                'nl', 'description', $t$Categoriseer tekst in een vaste lijst van labels. Geeft label + confidence + reasoning terug.$t$),
  ('block', 'classify',                'de', 'description', $t$Kategorisieren Sie Text in eine feste Liste von Labels. Gibt Label + Confidence + Reasoning zurück.$t$),
  ('block', 'classify',                'fr', 'description', $t$Catégorisez le texte en une liste fixe d'étiquettes. Renvoie étiquette + confiance + raisonnement.$t$),
  ('block', 'classify',                'es', 'description', $t$Categorice el texto en una lista fija de etiquetas. Devuelve etiqueta + confianza + razonamiento.$t$),
  ('block', 'classify',                'pl', 'description', $t$Kategoryzuj tekst do stałej listy etykiet. Zwraca etykietę + pewność + uzasadnienie.$t$),
  ('block', 'classify',                'ar', 'description', $t$تصنيف النص إلى قائمة ثابتة من التصنيفات. يعيد التصنيف + درجة الثقة + التعليل.$t$),
  ('block', 'classify',                'he', 'description', $t$סווג טקסט לרשימה קבועה של תוויות. מחזיר תווית + ביטחון + נימוק.$t$),
  ('block', 'compare-docs',            'nl', 'description', $t$Semantisch verschil tussen twee documenten met audit trail. Nuttig voor contractwijzigingen en beleidsverlengingen.$t$),
  ('block', 'compare-docs',            'de', 'description', $t$Semantischer Zwei-Dokument-Vergleich mit Audit-Trail. Nützlich für Vertragsänderungen und Richtlinienverlängerungen.$t$),
  ('block', 'compare-docs',            'fr', 'description', $t$Différence sémantique de deux documents avec piste d'audit. Utile pour les modifications de contrats et les renouvellements de politiques.$t$),
  ('block', 'compare-docs',            'es', 'description', $t$Diferencia semántica de dos documentos con pista de auditoría. Útil para cambios en contratos y renovaciones de políticas.$t$),
  ('block', 'compare-docs',            'pl', 'description', $t$Semantyczna różnica dwóch dokumentów z historią zmian (audit trail). Przydatne przy zmianach w kontraktach i odnawianiu polis.$t$),
  ('block', 'compare-docs',            'ar', 'description', $t$مقارنة دلالية بين مستندين مع سجل تدقيق. مفيدة لتغييرات العقود وتجديدات السياسات.$t$),
  ('block', 'compare-docs',            'he', 'description', $t$השוואה סמנטית בין שני מסמכים עם עקבות ביקורת (audit trail). שימושי לשינויים בחוזים וחידושי מדיניות.$t$),
  ('block', 'compose-claim-decision',  'nl', 'description', $t$Bouwt een duidelijke melding (onderwerp + body) voor een claimbeslissing — klaar om te gebruiken in een email/Slack-stap.$t$),
  ('block', 'compose-claim-decision',  'de', 'description', $t$Erstellt eine klare Benachrichtigung (Betreff + Textkörper) für eine Schadensentscheidung — bereit zur Übergabe an einen E-Mail-/Slack-Schritt.$t$),
  ('block', 'compose-claim-decision',  'fr', 'description', $t$Construit une notification claire (objet + corps) pour une décision de réclamation — prête à être transmise à une étape d'envoi d'e-mail/Slack.$t$),
  ('block', 'compose-claim-decision',  'es', 'description', $t$Construye una notificación clara (asunto + cuerpo) para una decisión de reclamación — lista para entregar a un paso de email/Slack.$t$),
  ('block', 'compose-claim-decision',  'pl', 'description', $t$Tworzy przejrzyste powiadomienie (temat + treść) dotyczące decyzji w sprawie roszczenia — gotowe do przekazania do kroku wysyłki e-mail/Slack.$t$),
  ('block', 'compose-claim-decision',  'ar', 'description', $t$يقوم بإنشاء إشعار واضح (الموضوع + نص الرسالة) لقرار المطالبة — جاهز للتسليم إلى خطوة البريد الإلكتروني/Slack.$t$),
  ('block', 'compose-claim-decision',  'he', 'description', $t$בונה התראה ברורה (נושא + גוף) עבור החלטה על תביעה — מוכנה להעברה לשלב אימייל/Slack.$t$),
  ('block', 'example-claim-data',      'nl', 'description', $t$Een verzoek tot betaling onder een polis na een gedekte schade.$t$),
  ('block', 'example-claim-data',      'de', 'description', $t$Ein Antrag auf Zahlungsleistung im Rahmen einer Versicherung nach einem versicherten Schaden.$t$),
  ('block', 'example-claim-data',      'fr', 'description', $t$Une demande de règlement au titre d'une police après un sinistre couvert.$t$),
  ('block', 'example-claim-data',      'es', 'description', $t$Una solicitud de pago bajo una póliza tras una pérdida cubierta.$t$),
  ('block', 'example-claim-data',      'pl', 'description', $t$Wniosek o wypłatę odszkodowania z polisy po wystąpieniu szkody objętej ochroną.$t$),
  ('block', 'example-claim-data',      'ar', 'description', $t$طلب دفع بموجب وثيقة تأمين بعد وقوع خسارة مغطاة.$t$),
  ('block', 'example-claim-data',      'he', 'description', $t$בקשה לתשלום תחת פוליסה לאחר הפסד מכוסה.$t$),
  ('block', 'example-customer-data',   'nl', 'description', $t$Een persoon of organisatie die het bedrijf bedient.$t$),
  ('block', 'example-customer-data',   'de', 'description', $t$Eine Person oder Organisation, der das Unternehmen dient.$t$),
  ('block', 'example-customer-data',   'fr', 'description', $t$Une personne ou une organisation que l'entreprise sert.$t$),
  ('block', 'example-customer-data',   'es', 'description', $t$Una persona u organización a la que la empresa sirve.$t$),
  ('block', 'example-customer-data',   'pl', 'description', $t$Osoba lub organizacja, której służy firma.$t$),
  ('block', 'example-customer-data',   'ar', 'description', $t$شخص أو منظمة تخدمها الشركة.$t$),
  ('block', 'example-customer-data',   'he', 'description', $t$אדם או ארגון שהחברה משרתת.$t$),
  ('block', 'example-policy-data',     'nl', 'description', $t$Een verzekeringsovereenkomst tussen de verzekeraar en de verzekeringnemer.$t$),
  ('block', 'example-policy-data',     'de', 'description', $t$Ein Versicherungsvertrag zwischen dem Versicherer und dem Versicherungsnehmer.$t$),
  ('block', 'example-policy-data',     'fr', 'description', $t$Un contrat d'assurance entre l'assureur et le preneur d'assurance.$t$),
  ('block', 'example-policy-data',     'es', 'description', $t$Un contrato de seguro entre el asegurador y el tomador de la póliza.$t$),
  ('block', 'example-policy-data',     'pl', 'description', $t$Umowa ubezpieczenia zawarta między ubezpieczycielem a ubezpieczającym.$t$),
  ('block', 'example-policy-data',     'ar', 'description', $t$عقد تأمين بين المؤمن والمؤمن له.$t$),
  ('block', 'example-policy-data',     'he', 'description', $t$חוזה ביטוח בין המבטח לבין בעל הפוליסה.$t$),
  ('block', 'extract-fields',          'nl', 'description', $t$Extraheert benoemde velden uit elk document met confidence scores. Configureerbare veldenlijst + types.$t$),
  ('block', 'extract-fields',          'de', 'description', $t$Extrahiert benannte Felder aus jedem Dokument mit Konfidenzwerten. Konfigurierbare Feldliste + Typen.$t$),
  ('block', 'extract-fields',          'fr', 'description', $t$Extrait les champs nommés de n'importe quel document avec des scores de confiance. Liste de champs + types configurables.$t$),
  ('block', 'extract-fields',          'es', 'description', $t$Extrae campos con nombre de cualquier documento con puntuaciones de confianza. Lista de campos + tipos configurables.$t$),
  ('block', 'extract-fields',          'pl', 'description', $t$Wyodrębnia nazwane pola z dowolnego dokumentu wraz z wynikami pewności (confidence scores). Konfigurowalna lista pól + typy.$t$),
  ('block', 'extract-fields',          'ar', 'description', $t$يستخرج الحقول المسماة من أي مستند مع درجات الثقة. قائمة حقول وأنواع قابلة للتهيئة.$t$),
  ('block', 'extract-fields',          'he', 'description', $t$מחלץ שדות בשם מכל מסמך עם ציוני ביטחון (confidence scores). רשימת שדות וסוגים ניתנים להגדרה.$t$),
  ('block', 'filter-rows',             'nl', 'description', $t$Houd alleen de records die een veld met een voorwaarde overeenstemmen. Werkt op elke rowset (bijv. de rijen van een data block).$t$),
  ('block', 'filter-rows',             'de', 'description', $t$Behalten Sie nur die Datensätze, bei denen ein Feld einer Bedingung entspricht. Funktioniert auf jedem Rowset (z. B. den Zeilen eines Datenblocks).$t$),
  ('block', 'filter-rows',             'fr', 'description', $t$Ne conservez que les enregistrements où un champ correspond à une condition. Fonctionne sur n'importe quel ensemble de lignes (par exemple, les lignes d'un bloc de données).$t$),
  ('block', 'filter-rows',             'es', 'description', $t$Conserva solo los registros donde un campo coincida con una condición. Funciona en cualquier rowset (por ejemplo, las filas de un bloque de datos).$t$),
  ('block', 'filter-rows',             'pl', 'description', $t$Zachowaj tylko te rekordy, w których pole spełnia określony warunek. Działa na dowolnym zbiorze wierszy (np. wierszach bloku danych).$t$),
  ('block', 'filter-rows',             'ar', 'description', $t$احتفظ فقط بالسجلات التي يتطابق فيها حقل ما مع شرط معين. يعمل هذا على أي مجموعة صفوف (على سبيل المثال، صفوف كتلة بيانات).$t$),
  ('block', 'filter-rows',             'he', 'description', $t$שמור רק את הרשומות שבהן שדה תואם לתנאי. עובד על כל rowset (למשל, השורות של data block).$t$),
  ('block', 'flag-anomalies',          'nl', 'description', $t$Configureerbare rule engine voor het markeren van outliers. Threshold-based + LLM-judgement modes.$t$),
  ('block', 'flag-anomalies',          'de', 'description', $t$Konfigurierbare Rule Engine zum Flaggen von Outliern. Threshold-based + LLM-judgement Modi.$t$),
  ('block', 'flag-anomalies',          'fr', 'description', $t$Moteur de règles configurable pour le signalement d'anomalies. Modes basés sur des seuils + jugement par LLM.$t$),
  ('block', 'flag-anomalies',          'es', 'description', $t$Motor de reglas configurable para la detección de valores atípicos. Modos basados en umbrales + juicio de LLM.$t$),
  ('block', 'flag-anomalies',          'pl', 'description', $t$Konfigurowalny silnik reguł do oznaczania wartości odstających. Tryby oparte na progach + ocena za pomocą LLM.$t$),
  ('block', 'flag-anomalies',          'ar', 'description', $t$محرك قواعد قابل للتهيئة لتحديد القيم الشاذة (outliers). أوضاع تعتمد على العتبة (Threshold-based) + حكم النموذج اللغوي الكبير (LLM-judgement).$t$),
  ('block', 'flag-anomalies',          'he', 'description', $t$מנוע חוקים ניתן להגדרה (Configurable rule engine) לסימון חריגים (outliers). מצבי Threshold-based + LLM-judgement.$t$),
  ('block', 'format-output',           'nl', 'description', $t$Renderen naar: markdown, HTML-e-mail, case-file note, slack-bericht. Theming + brand-aware.$t$),
  ('block', 'format-output',           'de', 'description', $t$Render an: markdown, HTML-E-Mail, Aktenvermerk, Slack-Nachricht. Theming + markenbewusst.$t$),
  ('block', 'format-output',           'fr', 'description', $t$Rendu vers : markdown, e-mail HTML, note de dossier, message Slack. Thémage + respect de l'image de marque.$t$),
  ('block', 'format-output',           'es', 'description', $t$Renderizar a: markdown, HTML email, case-file note, slack message. Theming + brand-aware.$t$),
  ('block', 'format-output',           'pl', 'description', $t$Renderuj do: markdown, HTML email, case-file note, slack message. Theming + brand-aware.$t$),
  ('block', 'format-output',           'ar', 'description', $t$التحويل إلى: markdown، وHTML email، وcase-file note، وslack message. مع مراعاة الـ Theming + brand-aware.$t$),
  ('block', 'format-output',           'he', 'description', $t$רינדור ל: markdown, HTML email, case-file note, slack message. עיצוב (Theming) + מודעות למותג (brand-aware).$t$),
  ('block', 'group-and-count',         'nl', 'description', $t$Tel hoeveel records vallen onder elke waarde van een veld — bijv. claims per status. Geeft een { value: count } map terug.$t$),
  ('block', 'group-and-count',         'de', 'description', $t$Zählen Sie, wie viele Datensätze auf jeden Wert eines Feldes entfallen – z. B. Claims pro Status. Gibt eine { value: count } Map aus.$t$),
  ('block', 'group-and-count',         'fr', 'description', $t$Comptez le nombre d'enregistrements pour chaque valeur d'un champ — par exemple, les réclamations par statut. Émet une map { value: count }.$t$),
  ('block', 'group-and-count',         'es', 'description', $t$Contabiliza cuántos registros corresponden a cada valor de un campo — por ejemplo, reclamaciones por estado. Emite un mapa { value: count }.$t$),
  ('block', 'group-and-count',         'pl', 'description', $t$Zlicz liczbę rekordów przypisanych do każdej wartości danego pola — np. liczba roszczeń na status. Zwraca mapę { value: count }.$t$),
  ('block', 'group-and-count',         'ar', 'description', $t$قم بإحصاء عدد السجلات التي تندرج تحت كل قيمة لحقل معين — على سبيل المثال، عدد المطالبات لكل حالة. تُصدر خريطة { value: count }.$t$),
  ('block', 'group-and-count',         'he', 'description', $t$ספור כמה רשומות נופלות תחת כל ערך של שדה — למשל, תביעות לפי סטטוס. פולט מפה מסוג { value: count }.$t$),
  ('block', 'if-else',                 'nl', 'description', $t$Branch op elke voorwaarde. Ondersteunt voorwaarden in natuurlijke taal via LLM-controle.$t$),
  ('block', 'if-else',                 'de', 'description', $t$Verzweigung bei jeder Bedingung. Unterstützt natürlichsprachliche Bedingungen via LLM-Check.$t$),
  ('block', 'if-else',                 'fr', 'description', $t$Effectuez une branche sur n'importe quelle condition. Prend en charge les conditions en langage naturel via une vérification par LLM.$t$),
  ('block', 'if-else',                 'es', 'description', $t$Ramificar bajo cualquier condición. Admite condiciones en lenguaje natural mediante verificación por LLM.$t$),
  ('block', 'if-else',                 'pl', 'description', $t$Rozgałęziaj na podstawie dowolnego warunku. Obsługuje warunki w języku naturalnym dzięki weryfikacji przez LLM.$t$),
  ('block', 'if-else',                 'ar', 'description', $t$التفرع بناءً على أي شرط. يدعم الشروط المكتوبة بلغة طبيعية عبر فحص LLM.$t$),
  ('block', 'if-else',                 'he', 'description', $t$הסתעפות (Branch) על כל תנאי. תומך בתנאים בשפה חופשית באמצעות בדיקת LLM.$t$),
  ('block', 'load-dataset',            'nl', 'description', $t$Laadt een door een developer geleverd dataset op basis van slug en geeft de rijen + count terug.$t$),
  ('block', 'load-dataset',            'de', 'description', $t$Lädt einen vom Entwickler bereitgestellten Datensatz anhand des Slugs und gibt dessen Zeilen + Anzahl aus.$t$),
  ('block', 'load-dataset',            'fr', 'description', $t$Charge un jeu de données fourni par le développeur via un slug et émet ses lignes + son nombre total.$t$),
  ('block', 'load-dataset',            'es', 'description', $t$Carga un conjunto de datos proporcionado por el desarrollador mediante un slug y emite sus filas + recuento.$t$),
  ('block', 'load-dataset',            'pl', 'description', $t$Wczytuje dostarczony przez programistę zestaw danych na podstawie znacznika (slug) i zwraca jego wiersze oraz liczbę rekordów.$t$),
  ('block', 'load-dataset',            'ar', 'description', $t$يقوم بتحميل مجموعة بيانات مقدمة من المطور عبر الـ slug ويقوم بإرسال صفوفها + العدد.$t$),
  ('block', 'load-dataset',            'he', 'description', $t$טוען מערך נתונים (dataset) המסופק על ידי מפתח לפי slug ופולט (emits) את השורות שלו + את הספירה.$t$),
  ('block', 'lookup-policy',           'nl', 'description', $t$Mock policy lookup tegen de sandboxed insurance dataset. Geeft coverage, thresholds, deductibles terug.$t$),
  ('block', 'lookup-policy',           'de', 'description', $t$Simulierter Policy-Lookup gegen den sandboxed Insurance-Datensatz. Liefert Coverage, Thresholds und Deductibles zurück.$t$),
  ('block', 'lookup-policy',           'fr', 'description', $t$Simulation de la recherche de politique par rapport au jeu de données d'assurance en bac à sable. Renvoie la couverture, les seuils, les franchises.$t$),
  ('block', 'lookup-policy',           'es', 'description', $t$Simulación de búsqueda de póliza contra el conjunto de datos de seguros en el sandbox. Devuelve cobertura, umbrales y deducibles.$t$),
  ('block', 'lookup-policy',           'pl', 'description', $t$Symulacja wyszukiwania polityki w piaskownicy zbioru danych ubezpieczeniowych. Zwraca zakres ochrony, progi oraz udziały własne.$t$),
  ('block', 'lookup-policy',           'ar', 'description', $t$محاكاة عملية البحث عن السياسة مقابل مجموعة بيانات التأمين التجريبية (sandboxed insurance dataset). تُرجع التغطية، والحدود الدنيا (thresholds)، والمبالغ المستقطعة (deductibles).$t$),
  ('block', 'lookup-policy',           'he', 'description', $t$סימולציה של חיפוש מדיניות מול מערך נתוני הביטוח בסביבת ה-sandbox. מחזיר כיסוי, ספים וגובה השתתפות עצמית.$t$),
  ('block', 'ocr-scan',                'nl', 'description', $t$Tesseract+Claude hybrid OCR voor rommelige scans. Gepubliceerd door Mo na de #CH-284 solution week.$t$),
  ('block', 'ocr-scan',                'de', 'description', $t$Tesseract+Claude Hybrid-OCR für unordentliche Scans. Veröffentlicht von Mo nach der #CH-284 solution week.$t$),
  ('block', 'ocr-scan',                'fr', 'description', $t$OCR hybride Tesseract+Claude pour les scans de mauvaise qualité. Publié par Mo après la semaine de solution #CH-284.$t$),
  ('block', 'ocr-scan',                'es', 'description', $t$OCR híbrido Tesseract+Claude para escaneos desordenados. Publicado por Mo tras la semana de solución #CH-284.$t$),
  ('block', 'ocr-scan',                'pl', 'description', $t$Hybrydowy OCR Tesseract+Claude dla nieczytelnych skanów. Opublikowane przez Mo po tygodniu rozwiązań #CH-284.$t$),
  ('block', 'ocr-scan',                'ar', 'description', $t$نظام OCR هجين يعتمد على Tesseract+Claude للمسحات الضوئية غير الواضحة. تم نشره بواسطة Mo بعد أسبوع حل #CH-284.$t$),
  ('block', 'ocr-scan',                'he', 'description', $t$OCR היברידי של Tesseract+Claude לסריקות מבולגנות. פורסם על ידי Mo לאחר שבוע הפתרון של #CH-284.$t$),
  ('block', 'read-claim-form',         'nl', 'description', $t$Parseert claim-PDF's (getypt of gescand). Voert automatisch OCR uit wanneer nodig. Geeft gestructureerde tekst + paginametadata terug.$t$),
  ('block', 'read-claim-form',         'de', 'description', $t$Analysiert Schadensmeldungen im PDF-Format (getippt oder gescannt). Führt bei Bedarf eine automatische OCR durch. Liefert strukturierten Text + Metadaten der Seiten zurück.$t$),
  ('block', 'read-claim-form',         'fr', 'description', $t$Analyse les PDF de demandes de remboursement (saisis ou numérisés). Effectue un OCR automatique si nécessaire. Renvoie du texte structuré + les métadonnées des pages.$t$),
  ('block', 'read-claim-form',         'es', 'description', $t$Analiza PDFs de reclamaciones (escritos o escaneados). Realiza OCR automático cuando es necesario. Devuelve texto estructurado + metadatos de página.$t$),
  ('block', 'read-claim-form',         'pl', 'description', $t$Parsuje pliki PDF (pisane lub skanowane). Automatycznie uruchamia OCR w razie potrzeby. Zwraca ustrukturyzowany tekst + metadane stron.$t$),
  ('block', 'read-claim-form',         'ar', 'description', $t$يقوم بتحليل ملفات PDF الخاصة بالمطالبات (سواء كانت مطبوعة أو ممسوحة ضوئياً). يقوم بإجراء OCR تلقائياً عند الحاجة. يعيد نصاً مهيكلاً + metadata للصفحات.$t$),
  ('block', 'read-claim-form',         'he', 'description', $t$מנתח קובצי PDF של תביעות (מוקלדים או סרוקים). מבצע OCR אוטומטי בעת הצורך. מחזיר טקסט מובנה + מטא-דאטה של דפים.$t$),
  ('block', 'read-customer-record',    'nl', 'description', $t$Mock-data customer record lookup met redactie. PII verlaat nooit de sandbox-grens.$t$),
  ('block', 'read-customer-record',    'de', 'description', $t$Mock-Data-Kundenstammdatenabfrage mit Redaktion. PII verlässt niemals die Sandbox-Grenze.$t$),
  ('block', 'read-customer-record',    'fr', 'description', $t$Recherche de dossiers clients avec données fictives et masquage. Les PII ne quittent jamais la limite du sandbox.$t$),
  ('block', 'read-customer-record',    'es', 'description', $t$Búsqueda de registros de clientes con datos simulados y redacción. La PII nunca sale del límite del sandbox.$t$),
  ('block', 'read-customer-record',    'pl', 'description', $t$Wyszukiwanie rekordów klientów przy użyciu danych testowych (mock-data) z funkcją anonimizacji. Dane PII nigdy nie opuszczają granic piaskownicy (sandbox).$t$),
  ('block', 'read-customer-record',    'ar', 'description', $t$البحث عن سجلات العملاء باستخدام بيانات وهمية مع إخفاء البيانات الحساسة. لا تخرج معلومات الهوية الشخصية (PII) أبداً خارج حدود البيئة المعزولة (sandbox).$t$),
  ('block', 'read-customer-record',    'he', 'description', $t$חיפוש רשומות לקוח בנתוני דמה (Mock-data) עם הסתרת מידע (redaction). מידע מזוהה אישי (PII) לעולם אינו עובר את גבולות ה-sandbox.$t$),
  ('block', 'record-form',             'nl', 'description', $t$Zet een enkel record om in een bewerkbaar formulier render-model met accept / edit / reject acties — voor human-in-the-loop stappen.$t$),
  ('block', 'record-form',             'de', 'description', $t$Verwandelt einen einzelnen Datensatz in ein editierbares Formular-Render-Model mit accept / edit / reject Aktionen — für Human-in-the-loop-Schritte.$t$),
  ('block', 'record-form',             'fr', 'description', $t$Transforme un enregistrement unique en un modèle de rendu de formulaire éditable avec des actions accept / edit / reject — pour les étapes human-in-the-loop.$t$),
  ('block', 'record-form',             'es', 'description', $t$Convierte un único registro en un render-model de formulario editable con acciones accept / edit / reject — para pasos de human-in-the-loop.$t$),
  ('block', 'record-form',             'pl', 'description', $t$Przekształca pojedynczy rekord w edytowalny model renderowania formularza z akcjami accept / edit / reject — dla kroków typu human-in-the-loop.$t$),
  ('block', 'record-form',             'ar', 'description', $t$يحول سجلاً واحداً إلى نموذج عرض قابل للتحرير (render-model) مع إجراءات قبول / تعديل / رفض — لخطوات التدخل البشري (human-in-the-loop).$t$),
  ('block', 'record-form',             'he', 'description', $t$הופך רשומה בודדת ל-render-model של טופס הניתן לעריכה עם פעולות accept / edit / reject — עבור שלבי human-in-the-loop.$t$),
  ('block', 'review-panel',            'nl', 'description', $t$Inline accept/edit/reject UI voor human-in-the-loop stappen. Hannah’s bijdrage uit week 21.$t$),
  ('block', 'review-panel',            'de', 'description', $t$Inline-Accept/Edit/Reject-UI für Human-in-the-Loop-Schritte. Hannahs Beitrag aus Woche 21.$t$),
  ('block', 'review-panel',            'fr', 'description', $t$Interface utilisateur d'acceptation/édition/rejet en ligne pour les étapes human-in-the-loop. Contribution de Hannah de la semaine 21.$t$),
  ('block', 'review-panel',            'es', 'description', $t$Interfaz de usuario de aceptación/edición/rechazo en línea para pasos de human-in-the-loop. Contribución de Hannah de la Semana 21.$t$),
  ('block', 'review-panel',            'pl', 'description', $t$Interfejs UI typu inline do akceptacji/edycji/odrzucania dla kroków human-in-the-loop. Wkład Hannah z tygodnia 21.$t$),
  ('block', 'review-panel',            'ar', 'description', $t$واجهة مستخدم (UI) للموافقة/التعديل/الرفض المضمنة (Inline) لخطوات التدخل البشري (human-in-the-loop). مساهمة Hannah من الأسبوع 21.$t$),
  ('block', 'review-panel',            'he', 'description', $t$ממשק משתמש (UI) של אישור/עריכה/דחייה בתוך השורה (Inline) עבור שלבי human-in-the-loop. התרומה של Hannah משבוע 21.$t$),
  ('block', 'rows-to-csv',             'nl', 'description', $t$Rendert een array van platte records naar een CSV-string met een header-rij. Ideaal als exportstap in een flow.$t$),
  ('block', 'rows-to-csv',             'de', 'description', $t$Rendert ein Array aus flachen Datensätzen in einen CSV-String mit einer Kopfzeile. Ideal als Export-Schritt in einem Flow.$t$),
  ('block', 'rows-to-csv',             'fr', 'description', $t$Rend un tableau d'enregistrements plats en une chaîne CSV avec une ligne d'en-tête. Idéal comme étape d'exportation d'un flux.$t$),
  ('block', 'rows-to-csv',             'es', 'description', $t$Renderiza un array de registros planos a una cadena CSV con una fila de encabezado. Ideal como paso de exportación en un flow.$t$),
  ('block', 'rows-to-csv',             'pl', 'description', $t$Renderuje tablicę płaskich rekordów do ciągu znaków CSV z wierszem nagłówka. Świetne jako krok eksportu w przepływie (flow).$t$),
  ('block', 'rows-to-csv',             'ar', 'description', $t$يقوم برسم مصفوفة من السجلات المسطحة (flat records) إلى سلسلة CSV مع صف رأس (header row). يعد خياراً رائعاً كخطوة تصدير في التدفق (flow).$t$),
  ('block', 'rows-to-csv',             'he', 'description', $t$מבצע רינדור של מערך רשומות שטוחות (flat records) למחרוזת CSV עם שורת כותרת. מצוין כשלב ייצוא (export step) בתוך flow.$t$),
  ('block', 'summary-card',            'nl', 'description', $t$Genereert een headline KPI card render-model vanuit een set statistieken — voor dashboards en flow summaries.$t$),
  ('block', 'summary-card',            'de', 'description', $t$Erzeugt ein Headline-KPI-Card-Render-Model aus einem Satz von Statistiken — für Dashboards und Flow-Zusammenfassungen.$t$),
  ('block', 'summary-card',            'fr', 'description', $t$Produit un modèle de rendu de carte KPI de titre à partir d'un ensemble de statistiques — pour les tableaux de bord et les résumés de flux.$t$),
  ('block', 'summary-card',            'es', 'description', $t$Genera un render-model de tarjeta de KPI de encabezado a partir de un conjunto de estadísticas — para dashboards y resúmenes de flujo.$t$),
  ('block', 'summary-card',            'pl', 'description', $t$Generuje model renderowania karty KPI nagłówkowej na podstawie zestawu statystyk — dla dashboardów i podsumowań przepływów.$t$),
  ('block', 'summary-card',            'ar', 'description', $t$يقوم بإنشاء نموذج عرض (render-model) لبطاقة مؤشر أداء رئيسي (KPI card) من مجموعة من الإحصائيات — للوحات البيانات (dashboards) وملخصات التدفق (flow summaries).$t$),
  ('block', 'summary-card',            'he', 'description', $t$מייצר render-model של כרטיס KPI לכותרת מתוך סט סטטיסטיקות — עבור דאשבורדים וסיכומי תזרים.$t$),
  ('block', 'table-view',              'nl', 'description', $t$Genereert een table render-model vanuit een rowset — een herbruikbare UI-stap voor het tonen van resultaten in een flow.$t$),
  ('block', 'table-view',              'de', 'description', $t$Erzeugt ein table render-model aus einem Rowset — ein wiederverwendbarer UI-Schritt zur Anzeige von Ergebnissen in einem Flow.$t$),
  ('block', 'table-view',              'fr', 'description', $t$Produit un `render-model` de type table à partir d'un `rowset` — une étape d'interface utilisateur réutilisable pour afficher des résultats dans un flux.$t$),
  ('block', 'table-view',              'es', 'description', $t$Produce una tabla `render-model` a partir de un `rowset` — un paso de UI reutilizable para mostrar resultados en un flujo.$t$),
  ('block', 'table-view',              'pl', 'description', $t$Generuje tabelę render-model z zestawu wierszy (rowset) — wielokrotnego użytku krok interfejsu użytkownika służący do wyświetlania wyników w przepływie (flow).$t$),
  ('block', 'table-view',              'ar', 'description', $t$يُنتج جدول `render-model` من مجموعة صفوف (rowset) — وهي خطوة واجهة مستخدم (UI step) قابلة لإعادة الاستخدام لعرض النتائج في تدفق (flow).$t$),
  ('block', 'table-view',              'he', 'description', $t$מייצר table render-model מתוך rowset — שלב UI הניתן לשימוש חוזר להצגת תוצאות בתוך flow.$t$),
  ('block', 'triage-claim',            'nl', 'description', $t$Gebruikt het brokered LLM om een ernst (low/medium/high) + prioriteit aan een claim toe te wijzen, met een korte rationale.$t$),
  ('block', 'triage-claim',            'de', 'description', $t$Verwendet das brokered LLM, um einem Claim eine Schweregrad-Einstufung (low/medium/high) + Priorität sowie eine kurze Begründung zuzuweisen.$t$),
  ('block', 'triage-claim',            'fr', 'description', $t$Utilise le LLM via broker pour assigner une sévérité (low/medium/high) + une priorité à une réclamation, avec une courte justification.$t$),
  ('block', 'triage-claim',            'es', 'description', $t$Utiliza el LLM mediado para asignar una severidad (low/medium/high) + prioridad a un reclamo, con una breve justificación.$t$),
  ('block', 'triage-claim',            'pl', 'description', $t$Wykorzystuje brokered LLM do przypisania stopnia dotkliwości (low/medium/high) + priorytetu do roszczenia, wraz z krótkim uzasadnieniem.$t$),
  ('block', 'triage-claim',            'ar', 'description', $t$يستخدم الـ brokered LLM لتحديد مستوى الخطورة (low/medium/high) + الأولوية لمطالبة ما، مع تقديم تعليل قصير.$t$),
  ('block', 'triage-claim',            'he', 'description', $t$משתמש ב-LLM המתווך כדי להקצות חומרה (low/medium/high) + עדיפות לתביעה, בצירוף רציונל קצר.$t$)
ON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- ---------------------------------------------------------------------------
-- 4. `docs_md` — 24 x 7, carried VERBATIM from the 2026-08-08 prod rows (good quality).
--    ONE EXCEPTION, hand-authored: `ocr-scan` / `he`, where the pipeline returned the ENGLISH
--    text byte-for-byte. It is the only such cell in all 504 (measured against the base columns
--    for all three fields in all 7 locales) — an untranslated row is indistinguishable from a
--    translated one to any reader who does not speak the locale, which is exactly why
--    tests/block-i18n-coverage.test.ts asserts `value !== <the en base>`.
-- ---------------------------------------------------------------------------
INSERT INTO content_translations (entity_type, entity_id, locale, field, value) VALUES
  ('block', 'ai-summarize',            'nl', 'docs_md', $t$# ai-summarize

Genereert een samenvatting met gecontroleerde lengte via Claude Sonnet. Configureer `tone` en `max_lines`.$t$),
  ('block', 'ai-summarize',            'de', 'docs_md', $t$# ai-summarize

Erzeugt eine längengesteuerte Zusammenfassung via Claude Sonnet. Konfiguriere `tone` und `max_lines`.$t$),
  ('block', 'ai-summarize',            'fr', 'docs_md', $t$# ai-summarize

Produit un résumé de longueur contrôlée via Claude Sonnet. Configurez `tone` et `max_lines`.$t$),
  ('block', 'ai-summarize',            'es', 'docs_md', $t$# ai-summarize

Produce un resumen de longitud controlada a través de Claude Sonnet. Configura `tone` y `max_lines`.$t$),
  ('block', 'ai-summarize',            'pl', 'docs_md', $t$# ai-summarize

Generuje streszczenie o kontrolowanej długości za pomocą Claude Sonnet. Skonfiguruj `tone` oraz `max_lines`.$t$),
  ('block', 'ai-summarize',            'ar', 'docs_md', $t$# ai-summarize

ينتج ملخصاً محكوماً بالطول عبر Claude Sonnet. قم بتكوين `tone` و `max_lines`.$t$),
  ('block', 'ai-summarize',            'he', 'docs_md', $t$# ai-summarize

מייצר סיכום מבוקר אורך באמצעות Claude Sonnet. הגדר את `tone` ו-`max_lines`.$t$),
  ('block', 'classify',                'nl', 'docs_md', $t$# classify

Classificeert `text` in een van de `labels`, met vertrouwen + redenering.$t$),
  ('block', 'classify',                'de', 'docs_md', $t$# classify

Klassifiziert `text` in eines der `labels`, mit Konfidenz + Begründung.$t$),
  ('block', 'classify',                'fr', 'docs_md', $t$# classify

Classifie `text` en un des `labels`, avec confiance + raisonnement.$t$),
  ('block', 'classify',                'es', 'docs_md', $t$# classify

Clasifica `text` en uno de los `labels`, con confianza + razonamiento.$t$),
  ('block', 'classify',                'pl', 'docs_md', $t$# classify

Klasyfikuje `text` do jednej z kategorii `labels`, wraz z poziomem pewności + uzasadnieniem.$t$),
  ('block', 'classify',                'ar', 'docs_md', $t$# classify

يصنف `text` إلى واحد من `labels` مع درجة الثقة + التبرير.$t$),
  ('block', 'classify',                'he', 'docs_md', $t$# classify

מסווג `text` לאחת מתוך `labels`, עם רמת ביטחון + נימוק.$t$),
  ('block', 'compare-docs',            'nl', 'docs_md', $t$# compare-docs

Semantisch verschil tussen twee documenten met een audit trail.$t$),
  ('block', 'compare-docs',            'de', 'docs_md', $t$# compare-docs

Semantischer Vergleich zweier Dokumente mit Audit-Trail.$t$),
  ('block', 'compare-docs',            'fr', 'docs_md', $t$# compare-docs

Diff sémantique de deux documents avec une piste d'audit.$t$),
  ('block', 'compare-docs',            'es', 'docs_md', $t$# compare-docs

Diferencia semántica de dos documentos con un registro de auditoría.$t$),
  ('block', 'compare-docs',            'pl', 'docs_md', $t$# compare-docs

Semantyczna różnica dwóch dokumentów wraz ze ścieżką audytu.$t$),
  ('block', 'compare-docs',            'ar', 'docs_md', $t$# compare-docs

مقارنة دلالية (Semantic diff) لمستندين مع سجل مراجعة (audit trail).$t$),
  ('block', 'compare-docs',            'he', 'docs_md', $t$# compare-docs

השוואה סמנטית של שני מסמכים עם תיעוד שינויים (audit trail).$t$),
  ('block', 'compose-claim-decision',  'nl', 'docs_md', $t$# Compose claim decision

Stelt een `subject` en `body` bericht samen voor een claim `decision`. Deterministisch en zonder bijwerkingen.$t$),
  ('block', 'compose-claim-decision',  'de', 'docs_md', $t$# Compose claim decision

Erstellt eine `subject` und `body` Nachricht für eine claim `decision`. Deterministisch und ohne Seiteneffekte.$t$),
  ('block', 'compose-claim-decision',  'fr', 'docs_md', $t$# Compose claim decision

Compose un message `subject` et `body` pour une `decision` de réclamation. Déterministe et sans effet de bord.$t$),
  ('block', 'compose-claim-decision',  'es', 'docs_md', $t$# Compose claim decision

Compone un mensaje de `subject` y `body` para una `decision` de reclamo. Determinista y sin efectos secundarios.$t$),
  ('block', 'compose-claim-decision',  'pl', 'docs_md', $t$# Compose claim decision

Tworzy wiadomość `subject` oraz `body` dla `decision` roszczenia. Deterministyczna i wolna od efektów ubocznych.$t$),
  ('block', 'compose-claim-decision',  'ar', 'docs_md', $t$# Compose claim decision

يقوم بتكوين رسالة تتكون من `subject` و `body` لقرار المطالبة `decision`. عملية حتمية وخالية من الآثار الجانبية.$t$),
  ('block', 'compose-claim-decision',  'he', 'docs_md', $t$# Compose claim decision

מבצע הרכבה של `subject` ושל הודעת `body` עבור `decision` של תביעה. דטרמיניסטי ונטול side-effect.$t$),
  ('block', 'example-claim-data',      'nl', 'docs_md', $t$# Claim data

Een **data block** samengesteld uit de **Claim** ontology entity — de output ports zijn de getypeerde attributen van de entity. Leest de `example-claims` sample via `ctx.dataset()` (overschrijf de bron in het config paneel).$t$),
  ('block', 'example-claim-data',      'de', 'docs_md', $t$# Claim data

Ein **data block**, der aus der **Claim** Ontology-Entity zusammengestellt wurde — seine Output-Ports sind die typisierten Attribute der Entity. Liest die `example-claims` Probe via `ctx.dataset()` (überschreiben Sie die Quelle im Config-Panel).$t$),
  ('block', 'example-claim-data',      'fr', 'docs_md', $t$# Claim data

Un **data block** compilé à partir de l'entité de l'ontologie **Claim** — ses ports de sortie sont les attributs typés de l'entité. Lit l'échantillon `example-claims` via `ctx.dataset()` (remplacez la source dans le panneau de configuration).$t$),
  ('block', 'example-claim-data',      'es', 'docs_md', $t$# Claim data

Un **data block** compilado a partir de la entidad de la ontología **Claim** — sus puertos de salida son los atributos tipados de la entidad. Lee la muestra `example-claims` a través de `ctx.dataset()` (sobrescriba la fuente en el panel de configuración).$t$),
  ('block', 'example-claim-data',      'pl', 'docs_md', $t$# Claim data

**Blok danych** (data block) skompilowany z encji ontologii **Claim** — jego porty wyjściowe to typowane atrybuty encji. Odczytuje próbkę `example-claims` za pomocą `ctx.dataset()` (można nadpisać źródło w panelu konfiguracji).$t$),
  ('block', 'example-claim-data',      'ar', 'docs_md', $t$# Claim data

**data block** مجمع من كيان الـ **Claim** ontology — منافذ الإخراج الخاصة به هي سمات الكيان المحددة النوع (typed attributes). يقرأ عينة `example-claims` عبر `ctx.dataset()` (قم بتجاوز المصدر في لوحة الإعدادات config panel).$t$),
  ('block', 'example-claim-data',      'he', 'docs_md', $t$# Claim data

**data block** המורכב מישות ה-**Claim** ב-ontology — פורטי הפלט שלו הם התכונות המוקצויות (typed attributes) של הישות. קורא את הדגימה `example-claims` דרך `ctx.dataset()` (דרוס את המקור בפאנל הקונפיגורציה).$t$),
  ('block', 'example-customer-data',   'nl', 'docs_md', $t$# Klantgegevens

Een **data block** samengesteld uit de **Customer** ontology entity — de output ports zijn de getypeerde attributen van de entity. Leest de `example-customers` sample via `ctx.dataset()` (overschrijf de bron in het config paneel).$t$),
  ('block', 'example-customer-data',   'de', 'docs_md', $t$# Kundendaten

Ein **data block**, der aus der **Customer** Ontology-Entity zusammengestellt wurde — seine Output-Ports sind die typisierten Attribute der Entity. Liest die `example-customers` Probe über `ctx.dataset()` (überschreiben Sie die Quelle im Konfigurationspanel).$t$),
  ('block', 'example-customer-data',   'fr', 'docs_md', $t$# Customer data

Un **data block** compilé à partir de l'entité de l'ontologie **Customer** — ses ports de sortie sont les attributs typés de l'entité. Lit l'échantillon `example-customers` via `ctx.dataset()` (remplacez la source dans le panneau de configuration).$t$),
  ('block', 'example-customer-data',   'es', 'docs_md', $t$# Customer data

Un **data block** compilado a partir de la entidad de ontología **Customer** — sus puertos de salida son los atributos tipados de la entidad. Lee la muestra `example-customers` a través de `ctx.dataset()` (sobrescriba la fuente en el panel de configuración).$t$),
  ('block', 'example-customer-data',   'pl', 'docs_md', $t$# Dane klienta

**Blok danych** (data block) skompilowany z encji ontologii **Customer** — jego porty wyjściowe to typowane atrybuty encji. Odczytuje próbkę `example-customers` za pomocą `ctx.dataset()` (można nadpisać źródło w panelu konfiguracyjnym).$t$),
  ('block', 'example-customer-data',   'ar', 'docs_md', $t$# بيانات العملاء

**كتلة بيانات (data block)** تم تجميعها من كيان الـ **Customer** ontology — منافذ الإخراج الخاصة بها هي سمات الكيان المحددة النوع (typed attributes). تقرأ العينة `example-customers` عبر `ctx.dataset()` (يمكن تجاوز المصدر في لوحة الإعدادات config panel).$t$),
  ('block', 'example-customer-data',   'he', 'docs_md', $t$# Customer data

**data block** המורכב מישות ה-**Customer** באונטולוגיה — פורטי הפלט שלו הם התכונות המוקצבות (typed attributes) של הישות. קורא את הדגימה `example-customers` באמצעות `ctx.dataset()` (דרוס את המקור בפאנל הקונפיגורציה).$t$),
  ('block', 'example-policy-data',     'nl', 'docs_md', $t$# Policy data

Een **data block** samengesteld uit de **Policy** ontology entity — de output ports zijn de getypeerde attributen van de entity. Leest de `example-policies` sample via `ctx.dataset()` (overschrijf de bron in het config paneel).$t$),
  ('block', 'example-policy-data',     'de', 'docs_md', $t$# Policy data

Ein **data block**, der aus der **Policy**-Ontologie-Entität zusammengestellt wurde — seine Output-Ports sind die typisierten Attribute der Entität. Liest die `example-policies`-Probe über `ctx.dataset()` (überschreiben Sie die Quelle im Konfigurationspanel).$t$),
  ('block', 'example-policy-data',     'fr', 'docs_md', $t$# Policy data

Un **data block** compilé à partir de l'entité de l'ontologie **Policy** — ses ports de sortie sont les attributs typés de l'entité. Lit l'échantillon `example-policies` via `ctx.dataset()` (remplacez la source dans le panneau de configuration).$t$),
  ('block', 'example-policy-data',     'es', 'docs_md', $t$# Policy data

Un **data block** compilado a partir de la entidad de ontología **Policy** — sus puertos de salida son los atributos tipados de la entidad. Lee la muestra `example-policies` a través de `ctx.dataset()` (sobrescriba la fuente en el panel de configuración).$t$),
  ('block', 'example-policy-data',     'pl', 'docs_md', $t$# Policy data

**Blok danych** skompilowany z encji ontologii **Policy** — jego porty wyjściowe to typowane atrybuty encji. Odczytuje próbkę `example-policies` za pomocą `ctx.dataset()` (można nadpisać źródło w panelu konfiguracyjnym).$t$),
  ('block', 'example-policy-data',     'ar', 'docs_md', $t$# Policy data

**data block** مجمّع من كيان الـ **Policy** ontology — منافذ الإخراج الخاصة به هي سمات الكيان المحددة النوع (typed attributes). يقرأ عينة `example-policies` عبر `ctx.dataset()` (قم بتجاوز المصدر في لوحة الإعدادات config panel).$t$),
  ('block', 'example-policy-data',     'he', 'docs_md', $t$# Policy data

**data block** המורכב מישות ה-**Policy** של האונטולוגיה — פורטי הפלט שלו הם התכונות המוקצות (typed attributes) של הישות. קורא את הדגימה `example-policies` דרך `ctx.dataset()` (דרוס את המקור בפאנל הקונפיגורציה).$t$),
  ('block', 'extract-fields',          'nl', 'docs_md', $t$# extract-fields

Extraheert de gevraagde `fields` uit een `document`, waarbij waarden + per-veld confidence worden geretourneerd.$t$),
  ('block', 'extract-fields',          'de', 'docs_md', $t$# extract-fields

Extrahiert die angeforderten `fields` aus einem `document` und gibt die Werte + die Konfidenz pro Feld zurück.$t$),
  ('block', 'extract-fields',          'fr', 'docs_md', $t$# extract-fields

Extrait les `fields` demandés d'un `document`, en retournant les valeurs + la confiance par champ.$t$),
  ('block', 'extract-fields',          'es', 'docs_md', $t$# extract-fields

Extrae los `fields` solicitados de un `document`, devolviendo los valores + la confianza por cada campo.$t$),
  ('block', 'extract-fields',          'pl', 'docs_md', $t$# extract-fields

Wyodrębnia żądane `fields` z `document`, zwracając wartości + poziom pewności (confidence) dla każdego pola.$t$),
  ('block', 'extract-fields',          'ar', 'docs_md', $t$# extract-fields

يستخرج الـ `fields` المطلوبة من `document` ، ويعيد القيم + درجة الثقة لكل حقل (per-field confidence).$t$),
  ('block', 'extract-fields',          'he', 'docs_md', $t$# extract-fields

מחלץ את ה-`fields` המבוקשים מתוך `document`, ומחזיר ערכים + רמת ביטחון (confidence) לכל שדה.$t$),
  ('block', 'filter-rows',             'nl', 'docs_md', $t$# Filter rijen

Filtert een array van records op basis van `field` `op` `value`. Numerieke operatoren (`gte`/`lte`) worden omgezet naar getallen. Geeft de behouden `rows` en hun `count` terug.$t$),
  ('block', 'filter-rows',             'de', 'docs_md', $t$# Zeilen filtern

Filtert ein Array von Datensätzen nach `field` `op` `value`. Numerische Operatoren (`gte`/`lte`) werden in Zahlen umgewandelt. Gibt die beibehaltenen `rows` und deren `count` aus.$t$),
  ('block', 'filter-rows',             'fr', 'docs_md', $t$# Filter rows

Filtre un tableau d'enregistrements par `field` `op` `value`. Les opérateurs numériques (`gte`/`lte`) sont convertis en nombres. Émet les `rows` conservées et leur `count`.$t$),
  ('block', 'filter-rows',             'es', 'docs_md', $t$# Filter rows

Filtra un array de registros por `field` `op` `value`. Los operadores numéricos (`gte`/`lte`) fuerzan la conversión a números. Emite las `rows` mantenidas y su `count`.$t$),
  ('block', 'filter-rows',             'pl', 'docs_md', $t$# Filtrowanie wierszy

Filtruje tablicę rekordów według `field` `op` `value`. Operatory numeryczne (`gte`/`lte`) są rzutowane na liczby. Zwraca zachowane `rows` oraz ich `count`.$t$),
  ('block', 'filter-rows',             'ar', 'docs_md', $t$# Filter rows

يقوم بتصفية مصفوفة من السجلات بواسطة `field` `op` `value`. تقوم المعاملات الرقمية (`gte`/`lte`) بتحويل القيم إلى أرقام. يُصدر الـ `rows` التي تم الإبقاء عليها و الـ `count` الخاص بها.$t$),
  ('block', 'filter-rows',             'he', 'docs_md', $t$# Filter rows

מסנן מערך של רשומות לפי `field` `op` `value`. אופרטורים מספריים (`gte`/`lte`) ממירים לערכים מספריים. פולט את ה-`rows` שנשמרו ואת ה-`count` שלהם.$t$),
  ('block', 'flag-anomalies',          'nl', 'docs_md', $t$# flag-anomalies

Vlaggt uitschieters (outlier records). De drempelmodus (threshold mode) is deterministisch; de LLM-modus beoordeelt ambigue rijen.$t$),
  ('block', 'flag-anomalies',          'de', 'docs_md', $t$# flag-anomalies

Markiert Ausreißer-Datensätze. Der Schwellenwert-Modus (Threshold mode) ist deterministisch; der LLM-Modus bewertet mehrdeutige Zeilen.$t$),
  ('block', 'flag-anomalies',          'fr', 'docs_md', $t$# flag-anomalies

Signale les enregistrements aberrants. Le mode seuil (threshold mode) est déterministe ; le mode LLM juge les lignes ambiguës.$t$),
  ('block', 'flag-anomalies',          'es', 'docs_md', $t$# flag-anomalies

Marca registros atípicos. El modo de umbral (Threshold mode) es determinista; el modo LLM juzga las filas ambiguas.$t$),
  ('block', 'flag-anomalies',          'pl', 'docs_md', $t$# flag-anomalies

Flaguje rekordy odstające. Tryb progowy (threshold mode) jest deterministyczny; tryb LLM ocenia niejednoznaczne wiersze.$t$),
  ('block', 'flag-anomalies',          'ar', 'docs_md', $t$# flag-anomalies

يقوم بتمييز السجلات الشاذة. وضع العتبة (Threshold mode) حتمي؛ بينما يقوم وضع LLM بالحكم على الصفوف الغامضة.$t$),
  ('block', 'flag-anomalies',          'he', 'docs_md', $t$# flag-anomalies

מסמן רשומות חריגות (outliers). מצב Threshold הוא דטרמיניסטי; מצב LLM שופט שורות מעורפלות.$t$),
  ('block', 'format-output',           'nl', 'docs_md', $t$# format-output

Rendeert `content` naar markdown, HTML-e-mail, een case-file note of een Slack-bericht.$t$),
  ('block', 'format-output',           'de', 'docs_md', $t$# format-output

Rendert `content` als Markdown, HTML-E-Mail, Fallnotiz (case-file note) oder Slack-Nachricht.$t$),
  ('block', 'format-output',           'fr', 'docs_md', $t$# format-output

Rendu de `content` en markdown, e-mail HTML, note de dossier (case-file note) ou message Slack.$t$),
  ('block', 'format-output',           'es', 'docs_md', $t$# format-output

Renderiza `content` a markdown, HTML email, a case-file note, o un Slack message.$t$),
  ('block', 'format-output',           'pl', 'docs_md', $t$# format-output

Renderuje `content` do formatu markdown, HTML email, notatki w aktach sprawy (case-file note) lub wiadomości Slack.$t$),
  ('block', 'format-output',           'ar', 'docs_md', $t$# format-output

يقوم بعرض `content` بتنسيق markdown، أو HTML email، أو case-file note، أو Slack message.$t$),
  ('block', 'format-output',           'he', 'docs_md', $t$# format-output

מבצע רינדור ל-`content` כ-markdown, אימייל HTML, הערת תיק (case-file note), או הודעת Slack.$t$),
  ('block', 'group-and-count',         'nl', 'docs_md', $t$# Groeperen en tellen

Groepeert `rows` op basis van `field` en telt elke bucket. Emitteert `groups` ({ value: count }) en `total`.$t$),
  ('block', 'group-and-count',         'de', 'docs_md', $t$# Gruppieren und Zählen

Gruppiert `rows` nach `field` und zählt jeden Bucket. Gibt `groups` ({ value: count }) und `total` aus.$t$),
  ('block', 'group-and-count',         'fr', 'docs_md', $t$# Group and count

Groupe `rows` par `field` et compte chaque bucket. Émet `groups` ({ value: count }) et `total`.$t$),
  ('block', 'group-and-count',         'es', 'docs_md', $t$# Group and count

Agrupa `rows` por `field` y cuenta cada bucket. Emite `groups` ({ value: count }) y `total`.$t$),
  ('block', 'group-and-count',         'pl', 'docs_md', $t$# Grupowanie i zliczanie

Grupuje `rows` według `field` i zlicza każdy kubełek. Zwraca `groups` ({ value: count }) oraz `total`.$t$),
  ('block', 'group-and-count',         'ar', 'docs_md', $t$# التجميع والعد

يقوم بتجميع `rows` حسب `field` وعد كل مجموعة. يُصدر `groups` ({ value: count }) و `total`.$t$),
  ('block', 'group-and-count',         'he', 'docs_md', $t$# Group and count

מקבץ את `rows` לפי `field` וסופר כל bucket. פולט `groups` ({ value: count }) ו-`total`.$t$),
  ('block', 'if-else',                 'nl', 'docs_md', $t$# if-else

Retourneert `if_true` of `if_false` op basis van `condition`.$t$),
  ('block', 'if-else',                 'de', 'docs_md', $t$# if-else

Gibt `if_true` oder `if_false` basierend auf `condition` zurück.$t$),
  ('block', 'if-else',                 'fr', 'docs_md', $t$# if-else

Renvoie `if_true` ou `if_false` en fonction de `condition`.$t$),
  ('block', 'if-else',                 'es', 'docs_md', $t$# if-else

Devuelve `if_true` o `if_false` basándose en `condition`.$t$),
  ('block', 'if-else',                 'pl', 'docs_md', $t$# if-else

Zwraca `if_true` lub `if_false` na podstawie `condition`.$t$),
  ('block', 'if-else',                 'ar', 'docs_md', $t$# if-else

يُرجع `if_true` أو `if_false` بناءً على `condition`.$t$),
  ('block', 'if-else',                 'he', 'docs_md', $t$# if-else

מחזיר את `if_true` או את `if_false` בהתבסס על `condition`.$t$),
  ('block', 'load-dataset',            'nl', 'docs_md', $t$# load-dataset

Leest een dataset (geselecteerd in het config-paneel) en retourneert de `rows` en `count`.$t$),
  ('block', 'load-dataset',            'de', 'docs_md', $t$# load-dataset

Liest einen Datensatz (ausgewählt im Config-Panel) und gibt dessen `rows` und `count` zurück.$t$),
  ('block', 'load-dataset',            'fr', 'docs_md', $t$# load-dataset

Lit un jeu de données (sélectionné dans le panneau de configuration) et renvoie ses `rows` et son `count`.$t$),
  ('block', 'load-dataset',            'es', 'docs_md', $t$# load-dataset

Lee un conjunto de datos (seleccionado en el panel de configuración) y devuelve sus `rows` y `count`.$t$),
  ('block', 'load-dataset',            'pl', 'docs_md', $t$# load-dataset

Odczytuje zestaw danych (wybrany w panelu konfiguracyjnym) i zwraca jego `rows` oraz `count`.$t$),
  ('block', 'load-dataset',            'ar', 'docs_md', $t$# load-dataset

يقرأ مجموعة بيانات (تم اختيارها في لوحة الإعدادات config panel) ويعيد الـ `rows` والـ `count` الخاصة بها.$t$),
  ('block', 'load-dataset',            'he', 'docs_md', $t$# load-dataset

קורא מערך נתונים (נבחר בלוח הבקרה של ה-config) ומחזיר את ה-`rows` וה-`count` שלו.$t$),
  ('block', 'lookup-policy',           'nl', 'docs_md', $t$# lookup-policy

Zoekt een policy op in de sandboxed insurance dataset. Retourneert `coverage` + `deductible`.$t$),
  ('block', 'lookup-policy',           'de', 'docs_md', $t$# lookup-policy

Sucht eine Policy im sandboxed insurance dataset. Gibt `coverage` + `deductible` zurück.$t$),
  ('block', 'lookup-policy',           'fr', 'docs_md', $t$# lookup-policy

Recherche une politique dans le jeu de données d'assurance sandboxé. Renvoie `coverage` + `deductible`.$t$),
  ('block', 'lookup-policy',           'es', 'docs_md', $t$# lookup-policy

Busca una política en el conjunto de datos de seguros en sandbox. Devuelve `coverage` + `deductible`.$t$),
  ('block', 'lookup-policy',           'pl', 'docs_md', $t$# lookup-policy

Wyszukuje politykę w piaskownicy zbioru danych ubezpieczeniowych (sandboxed insurance dataset). Zwraca `coverage` + `deductible`.$t$),
  ('block', 'lookup-policy',           'ar', 'docs_md', $t$# lookup-policy

يقوم بالبحث عن سياسة في مجموعة بيانات التأمين المعزولة (sandboxed insurance dataset). يعيد `coverage` + `deductible`.$t$),
  ('block', 'lookup-policy',           'he', 'docs_md', $t$# lookup-policy

מבצע חיפוש של מדיניות (policy) בתוך מאגר הנתונים המבוטח (sandboxed insurance dataset). מחזיר `coverage` + `deductible`.$t$),
  ('block', 'ocr-scan',                'nl', 'docs_md', $t$# ocr-scan

Hybride Tesseract + Claude OCR voor rommelige scans.$t$),
  ('block', 'ocr-scan',                'de', 'docs_md', $t$# ocr-scan

Hybrid Tesseract + Claude OCR für unordentliche Scans.$t$),
  ('block', 'ocr-scan',                'fr', 'docs_md', $t$# ocr-scan

OCR hybride Tesseract + Claude pour les scans de mauvaise qualité.$t$),
  ('block', 'ocr-scan',                'es', 'docs_md', $t$# ocr-scan

OCR híbrido de Tesseract + Claude para escaneos desordenados.$t$),
  ('block', 'ocr-scan',                'pl', 'docs_md', $t$# ocr-scan

Hybrydowy OCR oparty na Tesseract + Claude dla nieczytelnych skanów.$t$),
  ('block', 'ocr-scan',                'ar', 'docs_md', $t$# ocr-scan

نظام OCR هجين يجمع بين Tesseract + Claude للمسحات الضوئية غير الواضحة.$t$),
  ('block', 'ocr-scan',                'he', 'docs_md', $t$# ocr-scan

OCR היברידי המשלב Tesseract + Claude לסריקות לא ברורות.$t$),
  ('block', 'read-claim-form',         'nl', 'docs_md', $t$# read-claim-form

Parseert claim-PDF's (getypt of gescand). Wanneer de PDF een scan is, wordt er automatisch OCR toegepast.

**Retourneert** `text`, `pages`, en `ocr_used`.$t$),
  ('block', 'read-claim-form',         'de', 'docs_md', $t$# read-claim-form

Analysiert Schadensmeldungs-PDFs (getippt oder gescannt). Wenn das PDF ein Scan ist, wird automatisch OCR durchgeführt.

**Rückgabe** `text`, `pages` und `ocr_used`.$t$),
  ('block', 'read-claim-form',         'fr', 'docs_md', $t$# read-claim-form

Analyse les PDF de réclamation (saisis ou numérisés). Lorsque le PDF est un scan, il effectue un OCR automatique.

**Retourne** `text`, `pages`, et `ocr_used`.$t$),
  ('block', 'read-claim-form',         'es', 'docs_md', $t$# read-claim-form

Analiza PDFs de reclamaciones (escritos o escaneados). Cuando el PDF es un escaneo, realiza OCR automáticamente.

**Devuelve** `text`, `pages`, y `ocr_used`.$t$),
  ('block', 'read-claim-form',         'pl', 'docs_md', $t$# read-claim-form

Parsuje pliki PDF z roszczeniami (pisane cyfrowo lub skanowane). Gdy PDF jest skanem, automatycznie uruchamia OCR.

**Zwraca** `text`, `pages` oraz `ocr_used`.$t$),
  ('block', 'read-claim-form',         'ar', 'docs_md', $t$# read-claim-form

يقوم بتحليل ملفات PDF الخاصة بالمطالبات (سواء كانت مكتوبة أو ممسوحة ضوئياً). عندما يكون ملف PDF عبارة عن مسح ضوئي، فإنه يقوم بعمل OCR تلقائياً.

**يعيد** `text` و `pages` و `ocr_used`.$t$),
  ('block', 'read-claim-form',         'he', 'docs_md', $t$# read-claim-form

מנתח קובצי PDF של תביעות (מוקלד או סרוק). כאשר ה-PDF הוא סריקה, הוא מבצע OCR אוטומטי.

**מחזיר** `text`, `pages`, ו-`ocr_used`.$t$),
  ('block', 'read-customer-record',    'nl', 'docs_md', $t$# read-customer-record

Zoekt een klantrecord op uit mock data. De output bevat PII — blijft in de sandbox.$t$),
  ('block', 'read-customer-record',    'de', 'docs_md', $t$# read-customer-record

Sucht einen Kundendatensatz aus Mock-Daten. Die Ausgabe enthält PII — verbleibt in der Sandbox.$t$),
  ('block', 'read-customer-record',    'fr', 'docs_md', $t$# read-customer-record

Recherche un enregistrement client à partir de données fictives. La sortie contient des PII — reste dans le sandbox.$t$),
  ('block', 'read-customer-record',    'es', 'docs_md', $t$# read-customer-record

Busca un registro de cliente a partir de datos simulados (mock data). La salida contiene PII — permanece en el sandbox.$t$),
  ('block', 'read-customer-record',    'pl', 'docs_md', $t$# read-customer-record

Wyszukuje rekord klienta z danych testowych (mock data). Wynikiem są dane osobowe (PII) — pozostają one w piaskownicy (sandbox).$t$),
  ('block', 'read-customer-record',    'ar', 'docs_md', $t$# read-customer-record

يبحث عن سجل عميل من بيانات وهمية (mock data). المخرجات هي معلومات تحديد الهوية الشخصية (PII) — تبقى داخل البيئة المعزولة (sandbox).$t$),
  ('block', 'read-customer-record',    'he', 'docs_md', $t$# read-customer-record

מחפש רשומת לקוח מתוך נתוני דמה (mock data). הפלט הוא PII — נשאר בתוך ה-sandbox.$t$),
  ('block', 'record-form',             'nl', 'docs_md', $t$# Record form

Emits een `form` render-model `{ kind: "form", title, fields[], actions[] }` vanuit een `record`.$t$),
  ('block', 'record-form',             'de', 'docs_md', $t$# Record form

Gibt ein `form` render-model `{ kind: "form", title, fields[], actions[] }` aus einem `record` aus.$t$),
  ('block', 'record-form',             'fr', 'docs_md', $t$# Record form

Émet un modèle de rendu `form` `{ kind: "form", title, fields[], actions[] }` à partir d'un `record`.$t$),
  ('block', 'record-form',             'es', 'docs_md', $t$# Record form

Emite un render-model de `form` `{ kind: "form", title, fields[], actions[] }` desde un `record`.$t$),
  ('block', 'record-form',             'pl', 'docs_md', $t$# Record form

Emituje model renderowania `form` `{ kind: "form", title, fields[], actions[] }` z `record`.$t$),
  ('block', 'record-form',             'ar', 'docs_md', $t$# Record form

يُصدر نموذج رندر `form` من نوع `{ kind: "form", title, fields[], actions[] }` من `record`.$t$),
  ('block', 'record-form',             'he', 'docs_md', $t$# Record form

משחרר `form` render-model `{ kind: "form", title, fields[], actions[] }` מתוך `record`.$t$),
  ('block', 'review-panel',            'nl', 'docs_md', $t$# review-panel

Human-in-the-loop accept / edit / reject stap.$t$),
  ('block', 'review-panel',            'de', 'docs_md', $t$# review-panel

Human-in-the-loop accept / edit / reject Schritt.$t$),
  ('block', 'review-panel',            'fr', 'docs_md', $t$# review-panel

Étape d'acceptation / modification / rejet par intervention humaine (Human-in-the-loop).$t$),
  ('block', 'review-panel',            'es', 'docs_md', $t$# review-panel

Paso de aceptación / edición / rechazo con intervención humana (Human-in-the-loop).$t$),
  ('block', 'review-panel',            'pl', 'docs_md', $t$# review-panel

Krok akceptacji / edycji / odrzucenia typu Human-in-the-loop.$t$),
  ('block', 'review-panel',            'ar', 'docs_md', $t$# review-panel

خطوة القبول / التعديل / الرفض (Human-in-the-loop).$t$),
  ('block', 'review-panel',            'he', 'docs_md', $t$# review-panel

שלב Human-in-the-loop של אישור / עריכה / דחייה.$t$),
  ('block', 'rows-to-csv',             'nl', 'docs_md', $t$# Rows naar CSV

Zet `rows` om in een CSV `string` (gequoteerd/escaped), plus de opgeloste `columns` en `row_count`.$t$),
  ('block', 'rows-to-csv',             'de', 'docs_md', $t$# Rows to CSV

Wandelt `rows` in einen CSV-`string` (mit Anführungszeichen/Escaping) um, plus die aufgelösten `columns` und `row_count`.$t$),
  ('block', 'rows-to-csv',             'fr', 'docs_md', $t$# Rows to CSV

Transforme `rows` en une `string` CSV (avec guillemets/échappement), ainsi que les `columns` résolues et le `row_count`.$t$),
  ('block', 'rows-to-csv',             'es', 'docs_md', $t$# Rows to CSV

Convierte `rows` en un `string` CSV (con comillas/escapado), además de las `columns` resueltas y el `row_count`.$t$),
  ('block', 'rows-to-csv',             'pl', 'docs_md', $t$# Rows to CSV

Zamienia `rows` na ciąg znaków `string` w formacie CSV (z cudzysłowami/escapowaniem), a także na rozwiązane `columns` oraz `row_count`.$t$),
  ('block', 'rows-to-csv',             'ar', 'docs_md', $t$# Rows to CSV

يحول `rows` إلى `string` بتنسيق CSV (مع علامات اقتباس/هروب)، بالإضافة إلى `columns` التي تم استخراجها و `row_count`.$t$),
  ('block', 'rows-to-csv',             'he', 'docs_md', $t$# Rows to CSV

הופך את `rows` ל-`string` בפורמט CSV (עם גרשיים/escaping), בתוספת ה-`columns` וה-`row_count` המפוענחים.$t$),
  ('block', 'summary-card',            'nl', 'docs_md', $t$# Summary card

Emits een `card` render-model `{ kind: "card", title, stats, badge }`.$t$),
  ('block', 'summary-card',            'de', 'docs_md', $t$# Summary card

Gibt ein `card` render-model `{ kind: "card", title, stats, badge }` aus.$t$),
  ('block', 'summary-card',            'fr', 'docs_md', $t$# Summary card

Émet un modèle de rendu `card` `{ kind: "card", title, stats, badge }`.$t$),
  ('block', 'summary-card',            'es', 'docs_md', $t$# Summary card

Emite un render-model `card` `{ kind: "card", title, stats, badge }`.$t$),
  ('block', 'summary-card',            'pl', 'docs_md', $t$# Summary card

Emituje model renderowania `card` `{ kind: "card", title, stats, badge }`.$t$),
  ('block', 'summary-card',            'ar', 'docs_md', $t$# Summary card

يُصدر نموذج عرض `card` وهو `{ kind: "card", title, stats, badge }`.$t$),
  ('block', 'summary-card',            'he', 'docs_md', $t$# Summary card

משחרר `card` render-model `{ kind: "card", title, stats, badge }`.$t$),
  ('block', 'table-view',              'nl', 'docs_md', $t$# Table view

Zendt een `view` render-model uit `{ kind: "table", title, columns, rows }`. (Het canvas rendert dit model — zie de builder’s UI-block rendering.)$t$),
  ('block', 'table-view',              'de', 'docs_md', $t$# Table view

Emittiert ein `view` render-model `{ kind: "table", title, columns, rows }`. (Das Canvas rendert dieses Model — siehe das UI-Block-Rendering des Builders.)$t$),
  ('block', 'table-view',              'fr', 'docs_md', $t$# Vue en tableau

Émet un modèle de rendu `view` `{ kind: "table", title, columns, rows }`. (Le canvas rend ce modèle — voir le rendu des blocs d'interface utilisateur du builder.)$t$),
  ('block', 'table-view',              'es', 'docs_md', $t$# Table view

Emite un render-model `view` `{ kind: "table", title, columns, rows }`. (El canvas renderiza este modelo — ver el renderizado de UI-block del builder.)$t$),
  ('block', 'table-view',              'pl', 'docs_md', $t$# Widok tabeli

Emituje model renderowania `view` `{ kind: "table", title, columns, rows }`. (Płótno renderuje ten model — zobacz renderowanie bloków UI w builderze.)$t$),
  ('block', 'table-view',              'ar', 'docs_md', $t$# Table view

يُصدر `view` render-model `{ kind: "table", title, columns, rows }`. (تقوم الـ canvas برسم هذا النموذج — انظر إلى builder’s UI-block rendering.)$t$),
  ('block', 'table-view',              'he', 'docs_md', $t$# Table view

משחרר `view` render-model `{ kind: "table", title, columns, rows }`. (ה-canvas מרנדר את המודל הזה — ראה את ה-builder’s UI-block rendering.)$t$),
  ('block', 'triage-claim',            'nl', 'docs_md', $t$# Triage claim

Vraagt aan de gemeten `ctx.llm()` om een claim te beoordelen. Geeft altijd een goed gevormde `{ severity, priority, rationale }` terug — het valt terug op een amount/fraud heuristiek als het antwoord van het model niet geparsed kan worden.$t$),
  ('block', 'triage-claim',            'de', 'docs_md', $t$# Triage claim

Fragt das metered `ctx.llm()`, um einen Claim zu bewerten. Gibt immer ein wohlgeformtes `{ severity, priority, rationale }` zurück — falls die Antwort des Modells nicht geparst werden kann, erfolgt ein Fallback auf eine Amount/Fraud-Heuristik.$t$),
  ('block', 'triage-claim',            'fr', 'docs_md', $t$# Triage claim

Demande au `ctx.llm()` mesuré d'évaluer une réclamation. Renvoie toujours un objet `{ severity, priority, rationale }` bien formé — il utilise une heuristique de montant/fraude en cas d'échec de l'analyse de la réponse du modèle.$t$),
  ('block', 'triage-claim',            'es', 'docs_md', $t$# Triage claim

Solicita al `ctx.llm()` con medición de uso que califique una reclamación. Siempre devuelve un `{ severity, priority, rationale }` bien formado; recurre a una heurística de monto/fraude si la respuesta del modelo no se puede analizar.$t$),
  ('block', 'triage-claim',            'pl', 'docs_md', $t$# Triage claim

Prosi limitowany `ctx.llm()` o ocenę roszczenia. Zawsze zwraca poprawnie sformatowany obiekt `{ severity, priority, rationale }` — w przypadku braku możliwości sparsowania odpowiedzi modelu, następuje przełączenie na heurystykę opartą na kwocie/oszustwie.$t$),
  ('block', 'triage-claim',            'ar', 'docs_md', $t$# Triage claim

يطلب من `ctx.llm()` المقاس تقييم مطالبة. يعيد دائماً `{ severity, priority, rationale }` بتنسيق سليم — ويلجأ إلى استدلال القيمة/الاحتيال (amount/fraud heuristic) إذا تعذر تحليل رد النموذج.$t$),
  ('block', 'triage-claim',            'he', 'docs_md', $t$# Triage claim

מבקש מ-`ctx.llm()` המחושב לפי שימוש (metered) לדרג טענה. תמיד מחזיר `{ severity, priority, rationale }` מובנה היטב — הוא חוזר להערכת היוריסטיקה של סכום/הונאה (amount/fraud heuristic) אם לא ניתן לנתח את תגובת המודל.$t$)
ON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
