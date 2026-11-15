-- 0076_ocr_block_honest_copy.sql — retract the OCR claims from the two demo blocks that make them,
-- in the `en` base columns AND in the 7 non-en editions migration 0073 promoted into git.
--
-- WHAT WAS WRONG
-- --------------
-- `ocr-scan` shipped as: name "OCR scan", description "Tesseract+Claude hybrid OCR for messy scans.
-- Published by Mo after #CH-284 solution week.", docs "Hybrid Tesseract + Claude OCR for messy
-- scans." Its `run()` is one line — `ctx.mockData("scan", { ref: inputs.image })` — and
-- `exec/mock-data.ts` answers that with the literal string "Scanned document text (sample N). Lorem
-- ipsum dolor sit amet." There is no Tesseract anywhere in this repo, the `image` input is never
-- read, and nothing on any screen said so: a demo reader ran a block that names a third-party OCR
-- engine and got Lorem ipsum back with no indication it was a fixture.
--
-- `read-claim-form` carries the same class of claim — "Parses claim PDFs (typed or scanned).
-- Auto-OCRs when needed." — against a `run()` that asks `ctx.mockData("claim_pdf", …)` for fixture
-- pages and derives `ocr_used` from the FIXTURE's own `scanned` flag. Both are corrected here.
--
-- ⛔ WHY THIS IS A MIGRATION AND NOT JUST A SEED EDIT, AND WHY IT IS BOTH.
-- Same split as 0073's own note. `upsertGlobalBlock`/`seedAll` skip a slug that already exists, so
-- the seed literals (src/db/seed.ts, corrected in the same change) repair only databases where the
-- rows do not exist yet — a fresh CI database, where `bun run migrate` runs BEFORE `bun run seed`
-- and every UPDATE below therefore matches 0 rows. This file is what repairs the rows that ALREADY
-- exist in prod. Neither half is redundant.
--
-- And the `content_translations` half is not optional either: 0073 committed
-- `ocr-scan`/`description` and `/docs_md` in all 7 locales, each a faithful translation of the
-- false sentence ("Tesseract+Claude hybrid OCR voor rommelige scans", "Hybrid Tesseract + Claude
-- OCR für unordentliche Scans", …). Correcting only the English would have left every non-English
-- reader — including the Dutch demo audience — reading the retracted claim.
--
-- ⚠️ THE SLUGS DO NOT CHANGE. `ocr-scan` and `read-claim-form` are stable identifiers referenced by
-- seed-marketplace.ts (`blocksUsed`, `LISA_FLOW_SLUGS`), seed-tenant-showcase.ts and
-- `SEED_CATALOG_BLOCK_SLUGS`. Only display prose moves. `# ocr-scan` / `# read-claim-form` stay as
-- the docs headings for the same reason.
--
-- ⚠️ THE NAME MOVES FOR `ocr-scan` ONLY. "OCR scan" names an operation the block does not perform,
-- so it becomes "OCR scan (sample)" and its 7 localized names gain the same qualifier;
-- tests/block-i18n-coverage.test.ts requires each to differ from the `en` base and to carry a
-- capital, a space or non-ASCII script (never identifier shape), which all seven do.
-- "Read claim form" is left alone: it is a generic label, not the name of an engine, and the
-- corrected description plus the "Simulated" badge (rendered from `capabilities.mockData` on the
-- catalogue card, the build palette, the canvas node and the run output) carry the qualification.
--
-- SCOPE. Global blocks only: `tenant_id IS NULL` / `entity_type='block'` with the bare slug as
-- `entity_id` (0060's key contract). `block_tenant` rows are untouched — a tenant's own prose is
-- not ours to rewrite. No `en` row is inserted into `content_translations`: `en` is served from the
-- base columns and `getTranslationsBatch` short-circuits it (db/translations.ts).
--
-- PURE DML. No DDL, no RAISE. Every value is dollar-quoted `$t$…$t$` so apostrophes, newlines and
-- markdown backticks survive. IDEMPOTENT: the UPDATEs are absolute assignments and the INSERT is
-- `ON CONFLICT … DO UPDATE`, matching 0073.

-- ---------------------------------------------------------------------------
-- 1. The `en` base — building_blocks.name/description.
-- ---------------------------------------------------------------------------

UPDATE building_blocks
SET name = $t$OCR scan (sample)$t$,
    description = $t$Demonstration block. Returns deterministic sample document text from ctx.mockData — no OCR engine runs and the image is never opened.$t$,
    updated_at = now()
WHERE slug = 'ocr-scan' AND tenant_id IS NULL;

UPDATE building_blocks
SET description = $t$Demonstration block. Returns deterministic sample claim-form pages from ctx.mockData — no PDF is opened and no OCR engine runs; `ocr_used` reports the sample’s own flag.$t$,
    updated_at = now()
WHERE slug = 'read-claim-form' AND tenant_id IS NULL;

-- ---------------------------------------------------------------------------
-- 2. The `en` base — block_versions.docs_md.
--    ⚠️ EVERY version of the block, not just `current_version_id`. The version picker serves any
--    row's docs, so repairing only the current one leaves the claim reachable one click away.
--    Scoped through the parent block's `tenant_id IS NULL`, so a tenant fork is never touched.
-- ---------------------------------------------------------------------------

UPDATE block_versions
SET docs_md = $t$# ocr-scan

Demonstration block. Returns deterministic sample text from `ctx.mockData("scan")`; the `image` input is used only as the fixture key. No OCR engine runs and nothing is read from the image.$t$
WHERE block_id IN (SELECT id FROM building_blocks WHERE slug = 'ocr-scan' AND tenant_id IS NULL);

UPDATE block_versions
SET docs_md = $t$# read-claim-form

Demonstration block. Returns deterministic sample claim-form pages from `ctx.mockData("claim_pdf")`; the `file` input is used only as the fixture key. No PDF is opened and no OCR engine runs.

**Returns** `text`, `pages`, and `ocr_used` — where `ocr_used` is the sample’s own `scanned` flag (or `force_ocr`), not a measurement of any document.$t$
WHERE block_id IN (SELECT id FROM building_blocks WHERE slug = 'read-claim-form' AND tenant_id IS NULL);

-- ---------------------------------------------------------------------------
-- 3. The 7 non-en editions. Overwrites the 0073 rows for these cells.
-- ---------------------------------------------------------------------------
INSERT INTO content_translations (entity_type, entity_id, locale, field, value) VALUES
  -- ocr-scan · name
  ('block', 'ocr-scan',        'nl', 'name', $t$OCR-scan (voorbeeld)$t$),
  ('block', 'ocr-scan',        'de', 'name', $t$OCR-Scan (Beispiel)$t$),
  ('block', 'ocr-scan',        'fr', 'name', $t$Numérisation OCR (exemple)$t$),
  ('block', 'ocr-scan',        'es', 'name', $t$Escaneo OCR (muestra)$t$),
  ('block', 'ocr-scan',        'pl', 'name', $t$Skan OCR (przykład)$t$),
  ('block', 'ocr-scan',        'ar', 'name', $t$مسح ضوئي باستخدام OCR (عيّنة)$t$),
  ('block', 'ocr-scan',        'he', 'name', $t$סריקת OCR (דוגמה)$t$),

  -- ocr-scan · description
  ('block', 'ocr-scan',        'nl', 'description', $t$Demonstratieblok. Geeft deterministische voorbeeldtekst terug uit ctx.mockData — er draait geen OCR-engine en de afbeelding wordt nooit geopend.$t$),
  ('block', 'ocr-scan',        'de', 'description', $t$Demonstrationsbaustein. Gibt deterministischen Beispieltext aus ctx.mockData zurück — es läuft keine OCR-Engine und das Bild wird nie geöffnet.$t$),
  ('block', 'ocr-scan',        'fr', 'description', $t$Bloc de démonstration. Renvoie un texte d'exemple déterministe issu de ctx.mockData — aucun moteur OCR ne s'exécute et l'image n'est jamais ouverte.$t$),
  ('block', 'ocr-scan',        'es', 'description', $t$Bloque de demostración. Devuelve texto de muestra determinista de ctx.mockData: no se ejecuta ningún motor de OCR y la imagen nunca se abre.$t$),
  ('block', 'ocr-scan',        'pl', 'description', $t$Blok demonstracyjny. Zwraca deterministyczny tekst przykładowy z ctx.mockData — żaden silnik OCR nie jest uruchamiany, a obraz nigdy nie jest otwierany.$t$),
  ('block', 'ocr-scan',        'ar', 'description', $t$كتلة توضيحية. تُرجع نصًا تجريبيًا حتميًا من ctx.mockData — لا يعمل أي محرك OCR ولا يُفتح ملف الصورة إطلاقًا.$t$),
  ('block', 'ocr-scan',        'he', 'description', $t$בלוק הדגמה. מחזיר טקסט לדוגמה דטרמיניסטי מתוך ctx.mockData — שום מנוע OCR אינו פועל והתמונה לעולם אינה נפתחת.$t$),

  -- ocr-scan · docs_md
  ('block', 'ocr-scan',        'nl', 'docs_md', $t$# ocr-scan

Demonstratieblok. Geeft deterministische voorbeeldtekst terug uit `ctx.mockData("scan")`; de invoer `image` dient alleen als sleutel voor de fixture. Er draait geen OCR-engine en er wordt niets uit de afbeelding gelezen.$t$),
  ('block', 'ocr-scan',        'de', 'docs_md', $t$# ocr-scan

Demonstrationsbaustein. Gibt deterministischen Beispieltext aus `ctx.mockData("scan")` zurück; die Eingabe `image` dient nur als Schlüssel für die Fixture. Es läuft keine OCR-Engine und aus dem Bild wird nichts gelesen.$t$),
  ('block', 'ocr-scan',        'fr', 'docs_md', $t$# ocr-scan

Bloc de démonstration. Renvoie un texte d'exemple déterministe issu de `ctx.mockData("scan")` ; l'entrée `image` ne sert que de clé pour la fixture. Aucun moteur OCR ne s'exécute et rien n'est lu dans l'image.$t$),
  ('block', 'ocr-scan',        'es', 'docs_md', $t$# ocr-scan

Bloque de demostración. Devuelve texto de muestra determinista de `ctx.mockData("scan")`; la entrada `image` solo se usa como clave de la fixture. No se ejecuta ningún motor de OCR y no se lee nada de la imagen.$t$),
  ('block', 'ocr-scan',        'pl', 'docs_md', $t$# ocr-scan

Blok demonstracyjny. Zwraca deterministyczny tekst przykładowy z `ctx.mockData("scan")`; wejście `image` służy wyłącznie jako klucz fixture. Żaden silnik OCR nie jest uruchamiany i nic nie jest odczytywane z obrazu.$t$),
  ('block', 'ocr-scan',        'ar', 'docs_md', $t$# ocr-scan

كتلة توضيحية. تُرجع نصًا تجريبيًا حتميًا من `ctx.mockData("scan")`؛ ويُستخدم المدخل `image` كمفتاح للبيانات التجريبية فقط. لا يعمل أي محرك OCR ولا تتم قراءة أي شيء من الصورة.$t$),
  ('block', 'ocr-scan',        'he', 'docs_md', $t$# ocr-scan

בלוק הדגמה. מחזיר טקסט לדוגמה דטרמיניסטי מתוך `ctx.mockData("scan")`; הקלט `image` משמש רק כמפתח לנתוני הדוגמה. שום מנוע OCR אינו פועל ודבר אינו נקרא מתוך התמונה.$t$),

  -- read-claim-form · description
  ('block', 'read-claim-form', 'nl', 'description', $t$Demonstratieblok. Geeft deterministische voorbeeldpagina's van een claimformulier terug uit ctx.mockData — er wordt geen pdf geopend en er draait geen OCR-engine; `ocr_used` toont de vlag van het voorbeeld zelf.$t$),
  ('block', 'read-claim-form', 'de', 'description', $t$Demonstrationsbaustein. Gibt deterministische Beispielseiten eines Schadenformulars aus ctx.mockData zurück — es wird kein PDF geöffnet und keine OCR-Engine ausgeführt; `ocr_used` zeigt das Flag des Beispiels selbst.$t$),
  ('block', 'read-claim-form', 'fr', 'description', $t$Bloc de démonstration. Renvoie des pages d'exemple déterministes d'un formulaire de sinistre issues de ctx.mockData — aucun PDF n'est ouvert et aucun moteur OCR ne s'exécute ; `ocr_used` reflète l'indicateur de l'exemple lui-même.$t$),
  ('block', 'read-claim-form', 'es', 'description', $t$Bloque de demostración. Devuelve páginas de muestra deterministas de un formulario de siniestro desde ctx.mockData: no se abre ningún PDF ni se ejecuta ningún motor de OCR; `ocr_used` refleja la marca de la propia muestra.$t$),
  ('block', 'read-claim-form', 'pl', 'description', $t$Blok demonstracyjny. Zwraca deterministyczne przykładowe strony formularza roszczenia z ctx.mockData — żaden plik PDF nie jest otwierany ani żaden silnik OCR uruchamiany; `ocr_used` pokazuje flagę samej próbki.$t$),
  ('block', 'read-claim-form', 'ar', 'description', $t$كتلة توضيحية. تُرجع صفحات تجريبية حتمية لنموذج مطالبة من ctx.mockData — لا يُفتح أي ملف PDF ولا يعمل أي محرك OCR؛ وتعكس `ocr_used` علامة العينة نفسها.$t$),
  ('block', 'read-claim-form', 'he', 'description', $t$בלוק הדגמה. מחזיר עמודי דוגמה דטרמיניסטיים של טופס תביעה מתוך ctx.mockData — שום קובץ PDF אינו נפתח ושום מנוע OCR אינו פועל; השדה `ocr_used` משקף את הדגל של הדוגמה עצמה.$t$),

  -- read-claim-form · docs_md
  ('block', 'read-claim-form', 'nl', 'docs_md', $t$# read-claim-form

Demonstratieblok. Geeft deterministische voorbeeldpagina's van een claimformulier terug uit `ctx.mockData("claim_pdf")`; de invoer `file` dient alleen als sleutel voor de fixture. Er wordt geen pdf geopend en er draait geen OCR-engine.

**Retourneert** `text`, `pages` en `ocr_used` — waarbij `ocr_used` de `scanned`-vlag van het voorbeeld zelf is (of `force_ocr`), geen meting aan een document.$t$),
  ('block', 'read-claim-form', 'de', 'docs_md', $t$# read-claim-form

Demonstrationsbaustein. Gibt deterministische Beispielseiten eines Schadenformulars aus `ctx.mockData("claim_pdf")` zurück; die Eingabe `file` dient nur als Schlüssel für die Fixture. Es wird kein PDF geöffnet und keine OCR-Engine ausgeführt.

**Rückgabe** `text`, `pages` und `ocr_used` — wobei `ocr_used` das `scanned`-Flag des Beispiels selbst ist (oder `force_ocr`), keine Messung an einem Dokument.$t$),
  ('block', 'read-claim-form', 'fr', 'docs_md', $t$# read-claim-form

Bloc de démonstration. Renvoie des pages d'exemple déterministes d'un formulaire de sinistre issues de `ctx.mockData("claim_pdf")` ; l'entrée `file` ne sert que de clé pour la fixture. Aucun PDF n'est ouvert et aucun moteur OCR ne s'exécute.

**Retourne** `text`, `pages` et `ocr_used` — où `ocr_used` est l'indicateur `scanned` de l'exemple lui-même (ou `force_ocr`), et non une mesure faite sur un document.$t$),
  ('block', 'read-claim-form', 'es', 'docs_md', $t$# read-claim-form

Bloque de demostración. Devuelve páginas de muestra deterministas de un formulario de siniestro desde `ctx.mockData("claim_pdf")`; la entrada `file` solo se usa como clave de la fixture. No se abre ningún PDF ni se ejecuta ningún motor de OCR.

**Devuelve** `text`, `pages` y `ocr_used`, donde `ocr_used` es la marca `scanned` de la propia muestra (o `force_ocr`), no una medición sobre un documento.$t$),
  ('block', 'read-claim-form', 'pl', 'docs_md', $t$# read-claim-form

Blok demonstracyjny. Zwraca deterministyczne przykładowe strony formularza roszczenia z `ctx.mockData("claim_pdf")`; wejście `file` służy wyłącznie jako klucz fixture. Żaden plik PDF nie jest otwierany ani żaden silnik OCR uruchamiany.

**Zwraca** `text`, `pages` oraz `ocr_used` — gdzie `ocr_used` to flaga `scanned` samej próbki (albo `force_ocr`), a nie pomiar wykonany na dokumencie.$t$),
  ('block', 'read-claim-form', 'ar', 'docs_md', $t$# read-claim-form

كتلة توضيحية. تُرجع صفحات تجريبية حتمية لنموذج مطالبة من `ctx.mockData("claim_pdf")`؛ ويُستخدم المدخل `file` كمفتاح للبيانات التجريبية فقط. لا يُفتح أي ملف PDF ولا يعمل أي محرك OCR.

**تُرجع** `text` و`pages` و`ocr_used` — حيث تكون `ocr_used` هي علامة `scanned` الخاصة بالعينة نفسها (أو `force_ocr`)، وليست قياسًا على أي مستند.$t$),
  ('block', 'read-claim-form', 'he', 'docs_md', $t$# read-claim-form

בלוק הדגמה. מחזיר עמודי דוגמה דטרמיניסטיים של טופס תביעה מתוך `ctx.mockData("claim_pdf")`; הקלט `file` משמש רק כמפתח לנתוני הדוגמה. שום קובץ PDF אינו נפתח ושום מנוע OCR אינו פועל.

**מחזיר** את השדות `text`, `pages` ו-`ocr_used` — כאשר `ocr_used` הוא הדגל `scanned` של הדוגמה עצמה (או `force_ocr`), ולא מדידה כלשהי על מסמך.$t$)
ON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
