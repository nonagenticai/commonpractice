-- 0079_template_i18n.sql — the 20 shipped block-template starter scaffolds, in the 7 non-en
-- editions (§5B). GENERATED — do not hand-edit; see scripts/gen-template-i18n.ts.
--
-- WHY THIS FILE EXISTS
-- --------------------
-- `/block-edit` → "From template" renders the 20 seeded starter templates. In PRODUCTION
-- `block_templates` holds 20 rows and `content_translations` holds ZERO rows for any of them, and
-- routes/templates.ts had no locale handling at all — so a Dutch author was shown English cards
-- titled `validate-record`, `route-by-rule`, `approve-reject`. Worse than a cosmetic miss:
-- picking a template COPIES its label into the new block's name, its description into the
-- description, its docs into the docs, and derives the slug from the English label
-- (frontend/src/routes/block-edit/+page.svelte `applyTemplate`). Choosing a starter therefore
-- wrote English permanently into the Dutch author's own block. This file is the content half; the
-- overlay that reads it is templates/templates-service.ts.
--
-- ⛔ THE KEY IS THE NATURAL KEY, NOT THE ROW id.
-- `entity_id` is `${category}/${domain ?? ''}/${name}` (templates/i18n-key.ts), mirroring the
-- unique index `block_templates_natural_uq (category, coalesce(domain,''), name,
-- coalesce(tenant_id, zero-uuid))` at 0043_block_templates.sql:48-53. It is NOT
-- `block_templates.id`, which is `DEFAULT uuidv7()` (0043:19) and therefore a DIFFERENT value in
-- prod, in CI, and in every developer database for the same shipped template. `content_translations`
-- has no foreign key, so a uuid-keyed row is not an error anywhere — it is simply a row that matches
-- nothing, in every database but the one it was exported from. All 20 templates have a NULL domain,
-- so every key below reads `ai//x`, `logic//x` or `ui//x`; `domain ?? ''` matches the index's
-- `coalesce(domain,'')` exactly so NULL and '' cannot become two spellings of one key.
--
-- TRANSLATION PROVENANCE — READ THIS BEFORE TRUSTING A STRING
-- ----------------------------------------------------------
-- `nl` is the DEMO locale and had the closest review. The other six (de, fr, es, pl, ar, he) are
-- MACHINE-PRODUCED AND UNREVIEWED. They are shipped anyway because the measured alternative is
-- worse — the English identifier `validate-record` as a card title — but no claim is made that
-- they are good, and the `he`/`ar` RTL editions in particular have had no native-reader pass.
-- 0073's audit of the block `name` translations is the cautionary precedent: the pipeline there
-- produced a mix of untranslated slugs, identifier-mangled hybrids (`ai-samenvatten`) and
-- semantically wrong readings, at a measured 11-14 bad cells out of 24 per locale. Assume the same
-- rate here until someone measures otherwise.
--
-- `docs_md` is RENDERED, not authored: the localized label / description / preconditions / steps /
-- postconditions are assembled through the same renderer that produces the English base column
-- (templates/i18n-docs.ts `renderDocsWithHeadings`), with the three `##` headings localized from
-- the already-reviewed frontend catalog keys `blockedit_savetpl_{pre,steps,post}_label`. So the
-- document has the SAME SHAPE in every language and a heading-level or numbering change cannot
-- diverge per locale.
--
-- `tags` is a `string[]` column but `content_translations` is a flat (entity, locale, field) → TEXT
-- table, so the localized tag list is stored NEWLINE-JOINED in the single `tags` cell and split
-- back on read (templates/i18n-key.ts `splitTags`).
--
-- SCOPE
-- -----
-- GLOBAL (shipped) templates only: `entity_type='block_template'`. TENANT-authored templates live
-- under `block_template_tenant` with `${tenant_id}:${natural}` and are DELIBERATELY UNTOUCHED —
-- their prose is not ours to write, and the LLM pipeline handles them (host/translation-service.ts,
-- backfill branch `WHERE tenant_id IS NOT NULL`). That filter exists because `processPendingBatch`
-- UPSERTs with NO curated-row guard: a backfill that included the globals would silently overwrite
-- every row below with machine output and leave this file in git claiming otherwise.
--
-- ⛔ NO `en` ROWS. `getTranslationsBatch` short-circuits `en` to an empty map
-- (src/db/translations.ts:118-121), so an `en` row is unreachable by every reader — dead weight
-- whose only future is to drift from the `block_templates` base column it shadows.
--
-- IDEMPOTENT. `ON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE` on the primary key,
-- matching 0010_book_translations.sql and 0073_block_display_names_and_i18n.sql. The runner applies
-- each file once (`_migrations`), so on prod this runs once.
--
-- FRESH DATABASES. `bun run migrate` runs BEFORE `bun run seed`, so on a new cluster this executes
-- against an EMPTY `block_templates`. The rows still land (no FK), and `seedTemplateTranslations()`
-- in src/db/seed-templates.ts writes the identical set from the identical JSON — neither half is
-- redundant, and they cannot drift because both call `buildTemplateI18nRows()`.
--
-- DEFERRED, WITH THE SCHEME ALREADY CHOSEN — `descriptor.inputs[].description` /
-- `descriptor.outputs[].description`
-- ------------------------------------------------------------------------------------------------
-- The per-PORT help text inside `block_templates.descriptor` (JSONB) is NOT translated by this
-- file and still renders English in every locale. It is deferred, not overlooked, and the next
-- session should NOT redesign it:
--   * KEY: one `content_translations` row PER PORT, field `descriptor.inputs.<port>.description`
--     (and `descriptor.outputs.<port>.description`), under the SAME `entity_type` + natural
--     `entity_id` as the four fields here. A per-port field keeps the flat table flat — no JSON in
--     a `value` cell — and lets one port be re-reviewed without touching the others.
--   * READ: a JSON MERGE in `localize()` (templates/templates-service.ts), not a whole-descriptor
--     replacement. The descriptor is a SCHEMA — types, required flags, defaults — and only
--     `.description` is prose. Overlaying the whole object would let a translation change a port's
--     TYPE, which the block editor would then copy into a real block.
--   * COST: 20 templates × ~4 ports × 7 locales ≈ 560 more rows, i.e. this file again.
-- Do it when someone can review the port help; shipping it machine-produced doubles the unreviewed
-- surface for text most authors never read.


-- 560 rows: 20 templates × 7 locales × 4 fields (label, description, tags, docs_md).

INSERT INTO content_translations (entity_type, entity_id, locale, field, value) VALUES
  ('block_template', 'ai//extract-fields', 'nl', 'label', $t$Velden extraheren$t$),
  ('block_template', 'ai//extract-fields', 'nl', 'description', $t$Haal een gestructureerde set velden uit vrije tekst met het beheerde taalmodel (ctx.llm).$t$),
  ('block_template', 'ai//extract-fields', 'nl', 'tags', $t$extractie
gestructureerd
nlp$t$),
  ('block_template', 'ai//extract-fields', 'nl', 'docs_md', $t$# Velden extraheren

Haal een gestructureerde set velden uit vrije tekst met het beheerde taalmodel (ctx.llm).

## Voorwaarden vooraf

- De brontekst staat op `text`
- Een doelveldschema staat op `schema`

## Stappen

1. **Prompt opbouwen** — Instrueer het model om ALLEEN JSON terug te geven die aan het schema voldoet; noem elk veld + type.
2. **Model aanroepen** — Gebruik ctx.llm() met de tekst; vraag om strikte JSON-uitvoer.
3. **Parsen + bewaken** — Parse de JSON; forceer de typen; zet alles wat niet gevonden is op null (nooit hallucineren).

## Voorwaarden achteraf

- `fields` is een object met de schemavelden als sleutels
- Ontbrekende velden zijn null in plaats van verzonnen
$t$),
  ('block_template', 'ai//classify', 'nl', 'label', $t$Classificeren$t$),
  ('block_template', 'ai//classify', 'nl', 'description', $t$Ken het best passende label uit een vaste set toe aan de invoertekst, met een betrouwbaarheidsscore.$t$),
  ('block_template', 'ai//classify', 'nl', 'tags', $t$classificatie
labelen
nlp$t$),
  ('block_template', 'ai//classify', 'nl', 'docs_md', $t$# Classificeren

Ken het best passende label uit een vaste set toe aan de invoertekst, met een betrouwbaarheidsscore.

## Voorwaarden vooraf

- De invoertekst staat op `text`
- Een gesloten labelset staat op `labels`

## Stappen

1. **Keuzes beperken** — Vraag het model precies één label uit de aangeboden set te kiezen.
2. **Model aanroepen** — Gebruik ctx.llm(); vraag om { label, confidence } als JSON.
3. **Valideren** — Wijs elk label buiten de set af; val terug op unknown met lage betrouwbaarheid.

## Voorwaarden achteraf

- `label` is een van de aangeboden labels (of een expliciete `unknown`)
- `confidence` ligt tussen 0 en 1
$t$),
  ('block_template', 'ai//summarize', 'nl', 'label', $t$Samenvatten$t$),
  ('block_template', 'ai//summarize', 'nl', 'description', $t$Maak een samenvatting van de invoertekst met gestuurde lengte en toon.$t$),
  ('block_template', 'ai//summarize', 'nl', 'tags', $t$samenvatting
nlp$t$),
  ('block_template', 'ai//summarize', 'nl', 'docs_md', $t$# Samenvatten

Maak een samenvatting van de invoertekst met gestuurde lengte en toon.

## Voorwaarden vooraf

- De invoertekst staat op `text`

## Stappen

1. **Randvoorwaarden instellen** — Verwerk max_lines + toon in de systeeminstructie.
2. **Model aanroepen** — Gebruik ctx.llm() met de tekst en de randvoorwaarden.
3. **Inkorten** — Dwing de regellimiet defensief af nadat het model heeft geantwoord.

## Voorwaarden achteraf

- `summary` respecteert de gevraagde maximale lengte + toon
$t$),
  ('block_template', 'ai//generate-draft', 'nl', 'label', $t$Concept opstellen$t$),
  ('block_template', 'ai//generate-draft', 'nl', 'description', $t$Stel tekst op vanuit een korte briefing in een gekozen toon (e-mail, antwoord, omschrijving, …).$t$),
  ('block_template', 'ai//generate-draft', 'nl', 'tags', $t$generatie
concepten
nlp$t$),
  ('block_template', 'ai//generate-draft', 'nl', 'docs_md', $t$# Concept opstellen

Stel tekst op vanuit een korte briefing in een gekozen toon (e-mail, antwoord, omschrijving, …).

## Voorwaarden vooraf

- Een briefing staat op `brief`

## Stappen

1. **Opdracht kaderen** — Geef het model de doelgroep, het doel en de toon.
2. **Model aanroepen** — Gebruik ctx.llm() met de briefing; houd het bewerkbaar, niet definitief.
3. **Teruggeven** — Geef de concepttekst terug zodat een mens die kan beoordelen + versturen.

## Voorwaarden achteraf

- `draft` is een direct bewerkbaar eerste concept in de gevraagde toon
$t$),
  ('block_template', 'ai//route-by-intent', 'nl', 'label', $t$Routeren op intentie$t$),
  ('block_template', 'ai//route-by-intent', 'nl', 'description', $t$Herken de intentie van de gebruiker in een bericht en routeer naar een van een vaste set afhandelaars.$t$),
  ('block_template', 'ai//route-by-intent', 'nl', 'tags', $t$intentie
routering
nlp$t$),
  ('block_template', 'ai//route-by-intent', 'nl', 'docs_md', $t$# Routeren op intentie

Herken de intentie van de gebruiker in een bericht en routeer naar een van een vaste set afhandelaars.

## Voorwaarden vooraf

- Een bericht staat op `message`
- Een set kandidaat-intenties staat op `intents`

## Stappen

1. **Intenties beschrijven** — Geef het model één regel omschrijving per kandidaat-intentie.
2. **Model aanroepen** — Gebruik ctx.llm(); vraag om { intent, confidence } als JSON.
3. **Afschermen** — Routeer onder een betrouwbaarheidsdrempel naar fallback in plaats van te gokken.

## Voorwaarden achteraf

- `intent` is een van de kandidaten (of `fallback`)
- `confidence` ligt tussen 0 en 1
$t$),
  ('block_template', 'ai//redact-pii', 'nl', 'label', $t$Persoonsgegevens maskeren$t$),
  ('block_template', 'ai//redact-pii', 'nl', 'description', $t$Spoor persoonsgegevens (namen, e-mailadressen, telefoonnummers, identificatienummers) op in vrije tekst en maskeer ze.$t$),
  ('block_template', 'ai//redact-pii', 'nl', 'tags', $t$persoonsgegevens
maskeren
privacy$t$),
  ('block_template', 'ai//redact-pii', 'nl', 'docs_md', $t$# Persoonsgegevens maskeren

Spoor persoonsgegevens (namen, e-mailadressen, telefoonnummers, identificatienummers) op in vrije tekst en maskeer ze.

## Voorwaarden vooraf

- De invoertekst staat op `text`
- De te maskeren soorten persoonsgegevens staan op `kinds`

## Stappen

1. **Soorten opgeven** — Geef het model op welke soorten persoonsgegevens het moet zoeken (e-mail, telefoon, naam, id).
2. **Model aanroepen** — Gebruik ctx.llm(); vraag om de te maskeren fragmenten, niet om de ruwe waarden terug.
3. **Maskeren** — Vervang elk fragment door [REDACTED:<kind>]; tel de aantallen op in `found`.

## Voorwaarden achteraf

- `redacted` vervangt elk gevonden fragment door een getypeerde plaatshouder
- `found` somt op wat er is aangetroffen (soort + aantal), nooit de ruwe waarden
$t$),
  ('block_template', 'logic//validate-record', 'nl', 'label', $t$Record valideren$t$),
  ('block_template', 'logic//validate-record', 'nl', 'description', $t$Toets een record aan een set veldregels; laat geldige records door en verzamel bij ongeldige de redenen.$t$),
  ('block_template', 'logic//validate-record', 'nl', 'tags', $t$validatie
bewaking
datakwaliteit$t$),
  ('block_template', 'logic//validate-record', 'nl', 'docs_md', $t$# Record valideren

Toets een record aan een set veldregels; laat geldige records door en verzamel bij ongeldige de redenen.

## Voorwaarden vooraf

- Er is een recordobject beschikbaar op de invoer `record`
- Er is een set veldregels (verplicht / type / bereik) gedefinieerd

## Stappen

1. **Regelset laden** — Lees de regels per veld uit de invoer `rules` (verplicht, type, min/max, patroon).
2. **Elk veld toetsen** — Lees bij elke regel record[field] en toets die; voeg bij een fout een melding toe aan errors.
3. **Beslissen** — valid = errors.length === 0; geef beide terug zodat verderop vertakt kan worden.

## Voorwaarden achteraf

- `valid` is alleen true als elke regel slaagt
- `errors` bevat per gefaalde regel een leesbare reden
$t$),
  ('block_template', 'logic//route-by-rule', 'nl', 'label', $t$Routeren op regel (beslistabel)$t$),
  ('block_template', 'logic//route-by-rule', 'nl', 'description', $t$Kies een vertakking door een geordende beslistabel op de invoer toe te passen — de eerste treffer wint.$t$),
  ('block_template', 'logic//route-by-rule', 'nl', 'tags', $t$routering
beslistabel
vertakking$t$),
  ('block_template', 'logic//route-by-rule', 'nl', 'docs_md', $t$# Routeren op regel (beslistabel)

Kies een vertakking door een geordende beslistabel op de invoer toe te passen — de eerste treffer wint.

## Voorwaarden vooraf

- Er is een invoerobject beschikbaar op `item`
- Er is een geordende lijst regels (voorwaarde → route) gedefinieerd

## Stappen

1. **Beslistabel lezen** — Elke regel is { when: {field, op, value}, route }; werk van boven naar beneden.
2. **Eerste treffer zoeken** — Geef de route terug van de eerste regel waarvan de voorwaarde geldt voor `item`.
3. **Terugvallen** — Als geen enkele regel past, geef dan de ingestelde standaardroute terug en matched=false.

## Voorwaarden achteraf

- `route` is het label van de eerste passende regel, of de standaardroute
- `matched` geeft aan of er een regel is afgegaan
$t$),
  ('block_template', 'logic//approve-reject', 'nl', 'label', $t$Goedkeuren / afwijzen (vierogenprincipe)$t$),
  ('block_template', 'logic//approve-reject', 'nl', 'description', $t$Laat een item alleen door na toetsing aan het beleid én een expliciet menselijk besluit, met vastlegging van wie besliste en waarom.$t$),
  ('block_template', 'logic//approve-reject', 'nl', 'tags', $t$goedkeuring
vierogenprincipe
governance$t$),
  ('block_template', 'logic//approve-reject', 'nl', 'docs_md', $t$# Goedkeuren / afwijzen (vierogenprincipe)

Laat een item alleen door na toetsing aan het beleid én een expliciet menselijk besluit, met vastlegging van wie besliste en waarom.

## Voorwaarden vooraf

- Het te beoordelen item staat op `item`
- Er zijn een besluit (`approve` | `reject`) en de identiteit van de beoordelaar aangeleverd

## Stappen

1. **Beleidstoetsen vooraf uitvoeren** — Voer eerst de automatische controles uit; wijs alles wat het beleid niet doorstaat automatisch af, ongeacht de menselijke invoer.
2. **Menselijk besluit vastleggen** — Leg besluit, beoordelaar en reden vast voor de audittrail.
3. **Uitkomst teruggeven** — approved = policyPassed && decision === 'approve'; voeg het besluitrecord toe.

## Voorwaarden achteraf

- `approved` weerspiegelt het besluit van de beoordelaar na de beleidstoetsen
- Er is een audittrail (beoordelaar, reden, tijdstempel) toegevoegd
$t$),
  ('block_template', 'logic//dedupe', 'nl', 'label', $t$Rijen ontdubbelen$t$),
  ('block_template', 'logic//dedupe', 'nl', 'description', $t$Voeg rijen met dezelfde sleutel samen, behoud één gekozen rij en tel hoeveel duplicaten er zijn verwijderd.$t$),
  ('block_template', 'logic//dedupe', 'nl', 'tags', $t$ontdubbelen
opschonen
datakwaliteit$t$),
  ('block_template', 'logic//dedupe', 'nl', 'docs_md', $t$# Rijen ontdubbelen

Voeg rijen met dezelfde sleutel samen, behoud één gekozen rij en tel hoeveel duplicaten er zijn verwijderd.

## Voorwaarden vooraf

- Er is een lijst rijen beschikbaar op `rows`
- Er is een ontdubbelsleutel (één of meer velden) ingesteld

## Stappen

1. **Sleutel opbouwen** — Bereken per rij een samengestelde sleutel uit de ingestelde sleutelvelden.
2. **Overblijver kiezen** — Houd per sleutel de eerste rij (of de nieuwste volgens `tiebreak`); laat de rest vallen.
3. **Rapporteren** — Geef de ontdubbelde rijen terug plus het aantal verwijderde.

## Voorwaarden achteraf

- `rows` bevat hoogstens één overblijvende rij per sleutel
- `removed` telt hoeveel duplicaten er zijn weggelaten
$t$),
  ('block_template', 'logic//enrich-lookup', 'nl', 'label', $t$Verrijken via opzoektabel$t$),
  ('block_template', 'logic//enrich-lookup', 'nl', 'description', $t$Koppel elke rij op een sleutel aan een referentietabel en voeg de gevonden referentievelden samen.$t$),
  ('block_template', 'logic//enrich-lookup', 'nl', 'tags', $t$verrijken
koppelen
opzoeken$t$),
  ('block_template', 'logic//enrich-lookup', 'nl', 'docs_md', $t$# Verrijken via opzoektabel

Koppel elke rij op een sleutel aan een referentietabel en voeg de gevonden referentievelden samen.

## Voorwaarden vooraf

- De te verrijken rijen staan op `rows`
- Een referentiedataset/-tabel en de koppelsleutel zijn beschikbaar

## Stappen

1. **Referentie indexeren** — Bouw een map van koppelsleutel naar referentierij zodat opzoeken in O(1) gaat.
2. **Samenvoegen** — Zoek per invoerrij op sleutel op en voeg de referentievelden toe (bij conflicten wint de invoer).
3. **Missers bijhouden** — Tel de rijen zonder treffer zodat de kwaliteit bewaakt kan worden.

## Voorwaarden achteraf

- Elke rij krijgt de referentievelden erbij als er een treffer is
- `unmatched` telt de rijen zonder referentietreffer
$t$),
  ('block_template', 'logic//threshold-flag', 'nl', 'label', $t$Markeren op drempelwaarde$t$),
  ('block_template', 'logic//threshold-flag', 'nl', 'description', $t$Scoor elk item en markeer voor beoordeling wat een instelbare drempelwaarde overschrijdt.$t$),
  ('block_template', 'logic//threshold-flag', 'nl', 'tags', $t$scoren
markering
bewaking$t$),
  ('block_template', 'logic//threshold-flag', 'nl', 'docs_md', $t$# Markeren op drempelwaarde

Scoor elk item en markeer voor beoordeling wat een instelbare drempelwaarde overschrijdt.

## Voorwaarden vooraf

- De te scoren items staan op `items`
- Er zijn een numeriek veld en een drempelwaarde ingesteld

## Stappen

1. **Meetwaarde lezen** — Haal het numerieke veld uit elk item.
2. **Vergelijken** — Markeer items waarbij value >= threshold (of <= bij een ondergrens).
3. **Verzamelen** — Geef de gemarkeerde deelverzameling terug met het aantal.

## Voorwaarden achteraf

- `flagged` bevat de items die de drempelwaarde overschrijden
- `count` is het aantal gemarkeerde items
$t$),
  ('block_template', 'logic//map-transform', 'nl', 'label', $t$Toewijzen / transformeren$t$),
  ('block_template', 'logic//map-transform', 'nl', 'description', $t$Vorm elke rij om naar een doelschema via een veldtoewijzing en laat velden vallen of hernoem ze zoals ingesteld.$t$),
  ('block_template', 'logic//map-transform', 'nl', 'tags', $t$transformeren
toewijzing
hervormen$t$),
  ('block_template', 'logic//map-transform', 'nl', 'docs_md', $t$# Toewijzen / transformeren

Vorm elke rij om naar een doelschema via een veldtoewijzing en laat velden vallen of hernoem ze zoals ingesteld.

## Voorwaarden vooraf

- De bronrijen staan op `rows`
- Er is een veldtoewijzing (bron → doel) ingesteld

## Stappen

1. **Toewijzing lezen** — De mapping is { targetField: sourceField }.
2. **Elke rij projecteren** — Bouw per rij een nieuw object met de toewijzing; sla niet-toegewezen velden over.
3. **Teruggeven** — Geef de getransformeerde rijen in de oorspronkelijke volgorde terug.

## Voorwaarden achteraf

- Elke uitvoerrij bevat alleen de toegewezen doelvelden
- De volgorde van de rijen blijft behouden
$t$),
  ('block_template', 'logic//aggregate', 'nl', 'label', $t$Aggregeren / groeperen$t$),
  ('block_template', 'logic//aggregate', 'nl', 'description', $t$Groepeer rijen op een sleutel en bereken per groep aggregaties (aantal / som / gemiddelde).$t$),
  ('block_template', 'logic//aggregate', 'nl', 'tags', $t$aggregeren
groeperen
samenvatting$t$),
  ('block_template', 'logic//aggregate', 'nl', 'docs_md', $t$# Aggregeren / groeperen

Groepeer rijen op een sleutel en bereken per groep aggregaties (aantal / som / gemiddelde).

## Voorwaarden vooraf

- De rijen staan op `rows`
- Er zijn een groepeersleutel en de te aggregeren meetwaarden ingesteld

## Stappen

1. **Verdelen** — Groepeer de rijen op het ingestelde veld group_by.
2. **Samenvouwen** — Bereken per groep het aantal en de som/het gemiddelde van elk meetveld.
3. **Teruggeven** — Geef één rij per groep terug met de aggregaties.

## Voorwaarden achteraf

- `groups` bevat één samenvattingsrij per unieke sleutel
- Elke samenvatting draagt de gevraagde aggregaties
$t$),
  ('block_template', 'ui//form', 'nl', 'label', $t$Formulier$t$),
  ('block_template', 'ui//form', 'nl', 'description', $t$Verzamel en valideer gebruikersinvoer tegen een veldschema en geef de vastgelegde waarden door bij verzenden.$t$),
  ('block_template', 'ui//form', 'nl', 'tags', $t$formulier
invoer
vastleggen$t$),
  ('block_template', 'ui//form', 'nl', 'docs_md', $t$# Formulier

Verzamel en valideer gebruikersinvoer tegen een veldschema en geef de vastgelegde waarden door bij verzenden.

## Voorwaarden vooraf

- Een veldschema (labels, typen, verplicht) staat op `schema`

## Stappen

1. **Velden weergeven** — Bouw de invoervelden op uit het schema (tekst / getal / keuzelijst / selectievakje).
2. **Valideren** — Blokkeer verzenden totdat de verplichte velden zijn ingevuld en de typen kloppen.
3. **Doorgeven** — Geef bij verzenden de verzamelde waarden terug plus submitted=true.

## Voorwaarden achteraf

- `values` bevat de vastgelegde velden zodra er is verzonden
- `submitted` wordt pas true als de validatie in de browser slaagt
$t$),
  ('block_template', 'ui//table', 'nl', 'label', $t$Tabel / lijst$t$),
  ('block_template', 'ui//table', 'nl', 'description', $t$Toon rijen in een sorteerbare, selecteerbare tabel op basis van een kolomdefinitie.$t$),
  ('block_template', 'ui//table', 'nl', 'tags', $t$tabel
lijst
raster$t$),
  ('block_template', 'ui//table', 'nl', 'docs_md', $t$# Tabel / lijst

Toon rijen in een sorteerbare, selecteerbare tabel op basis van een kolomdefinitie.

## Voorwaarden vooraf

- De rijen staan op `rows`
- Een kolomdefinitie staat op `columns`

## Stappen

1. **Kolommen definiëren** — Koppel elke kolom aan een rijveld + kop + optionele opmaakfunctie.
2. **Rijen weergeven** — Toon de rijen; ondersteun sorteren op kolom en het selecteren van rijen.
3. **Selectie doorgeven** — Geef de geselecteerde rij(en) terug wanneer de gebruiker klikt.

## Voorwaarden achteraf

- `selected` weerspiegelt de rij(en) die de gebruiker kiest
$t$),
  ('block_template', 'ui//chart', 'nl', 'label', $t$Grafiek$t$),
  ('block_template', 'ui//chart', 'nl', 'description', $t$Visualiseer één of meer reeksen als lijn-, staaf- of cirkeldiagram.$t$),
  ('block_template', 'ui//chart', 'nl', 'tags', $t$grafiek
visualisatie
rapportage$t$),
  ('block_template', 'ui//chart', 'nl', 'docs_md', $t$# Grafiek

Visualiseer één of meer reeksen als lijn-, staaf- of cirkeldiagram.

## Voorwaarden vooraf

- De reeksgegevens staan op `series`

## Stappen

1. **Grafiektype kiezen** — lijn voor trends, staaf voor vergelijkingen, cirkel voor samenstelling.
2. **Gegevens koppelen** — Koppel de punten van de reeks aan assen / taartpunten.
3. **Tekenen** — Teken de grafiek met asbijschriften + een legenda.

## Voorwaarden achteraf

- De grafiek wordt getekend voor het gekozen `type`
$t$),
  ('block_template', 'ui//kpi-card', 'nl', 'label', $t$KPI-kaart$t$),
  ('block_template', 'ui//kpi-card', 'nl', 'description', $t$Toon één kerncijfer met een optioneel verschil ten opzichte van een vorige periode.$t$),
  ('block_template', 'ui//kpi-card', 'nl', 'tags', $t$kpi
meetwaarde
dashboard$t$),
  ('block_template', 'ui//kpi-card', 'nl', 'docs_md', $t$# KPI-kaart

Toon één kerncijfer met een optioneel verschil ten opzichte van een vorige periode.

## Voorwaarden vooraf

- Er zijn een label en een numerieke waarde aangeleverd

## Stappen

1. **Waarde tonen** — Toon het kerngetal met het label erbij.
2. **Verschil tonen** — Als er een verschil is meegegeven, toon dan omhoog/omlaag met teken + kleur.

## Voorwaarden achteraf

- Het kerncijfer + de richting van het verschil worden getoond
$t$),
  ('block_template', 'ui//detail-view', 'nl', 'label', $t$Detailweergave$t$),
  ('block_template', 'ui//detail-view', 'nl', 'description', $t$Toon één record als een alleen-lezen detailpaneel met label/waarde-regels.$t$),
  ('block_template', 'ui//detail-view', 'nl', 'tags', $t$detail
record
alleen-lezen$t$),
  ('block_template', 'ui//detail-view', 'nl', 'docs_md', $t$# Detailweergave

Toon één record als een alleen-lezen detailpaneel met label/waarde-regels.

## Voorwaarden vooraf

- Er staat een record op `record`

## Stappen

1. **Velden kiezen** — Gebruik `fields` om te kiezen + ordenen welke sleutels je toont (standaard: alle).
2. **Weergeven** — Toon elk als een label/waarde-regel; maak datums + getallen netjes op.

## Voorwaarden achteraf

- De gekozen velden worden getoond als label/waarde-regels
$t$),
  ('block_template', 'ui//filter-bar', 'nl', 'label', $t$Filterbalk$t$),
  ('block_template', 'ui//filter-bar', 'nl', 'description', $t$Toon een set filters en geef de resulterende zoekopdracht door zodra de gebruiker ze aanpast.$t$),
  ('block_template', 'ui//filter-bar', 'nl', 'tags', $t$filter
zoeken
bediening$t$),
  ('block_template', 'ui//filter-bar', 'nl', 'docs_md', $t$# Filterbalk

Toon een set filters en geef de resulterende zoekopdracht door zodra de gebruiker ze aanpast.

## Voorwaarden vooraf

- Een definitie van de filtervelden staat op `fields`

## Stappen

1. **Filters weergeven** — Bouw per veld een filter (tekst / keuzelijst / datumbereik).
2. **Verzamelen** — Stel bij elke wijziging de actieve filters samen tot één query-object.
3. **Doorgeven** — Geef de query terug zodat een volgend gegevensblok opnieuw kan ophalen.

## Voorwaarden achteraf

- `query` weerspiegelt de huidige filterkeuzes
- `changed` gaat af zodra een filter wijzigt
$t$),
  ('block_template', 'ai//extract-fields', 'pl', 'label', $t$Wyodrębnianie pól$t$),
  ('block_template', 'ai//extract-fields', 'pl', 'description', $t$Wyodrębnia ustrukturyzowany zestaw pól z tekstu swobodnego przy użyciu zarządzanego modelu językowego (ctx.llm).$t$),
  ('block_template', 'ai//extract-fields', 'pl', 'tags', $t$ekstrakcja
ustrukturyzowane
nlp$t$),
  ('block_template', 'ai//extract-fields', 'pl', 'docs_md', $t$# Wyodrębnianie pól

Wyodrębnia ustrukturyzowany zestaw pól z tekstu swobodnego przy użyciu zarządzanego modelu językowego (ctx.llm).

## Warunki wstępne

- Tekst źródłowy jest przekazany w `text`
- Schemat pól docelowych jest przekazany w `schema`

## Kroki

1. **Zbuduj prompt** — Poleć modelowi zwrócić WYŁĄCZNIE JSON zgodny ze schematem; wymień każde pole + jego typ.
2. **Wywołaj model** — Użyj ctx.llm() z tekstem; zażądaj ścisłego wyjścia JSON.
3. **Sparsuj + zabezpiecz** — Sparsuj JSON; wymuś typy; ustaw null wszędzie tam, gdzie nic nie znaleziono (nigdy nie zmyślaj).

## Warunki końcowe

- `fields` to obiekt, którego kluczami są pola schematu
- Brakujące pola mają wartość null, zamiast być zmyślane
$t$),
  ('block_template', 'ai//classify', 'pl', 'label', $t$Klasyfikacja$t$),
  ('block_template', 'ai//classify', 'pl', 'description', $t$Przypisuje tekstowi wejściowemu najlepiej pasującą etykietę ze stałego zbioru wraz z oceną pewności.$t$),
  ('block_template', 'ai//classify', 'pl', 'tags', $t$klasyfikacja
etykietowanie
nlp$t$),
  ('block_template', 'ai//classify', 'pl', 'docs_md', $t$# Klasyfikacja

Przypisuje tekstowi wejściowemu najlepiej pasującą etykietę ze stałego zbioru wraz z oceną pewności.

## Warunki wstępne

- Tekst wejściowy jest w `text`
- Zamknięty zbiór etykiet jest w `labels`

## Kroki

1. **Ogranicz wybór** — Poproś model o wybranie dokładnie jednej etykiety z podanego zbioru.
2. **Wywołaj model** — Użyj ctx.llm(); poproś o { label, confidence } w formacie JSON.
3. **Zweryfikuj** — Odrzuć każdą etykietę spoza zbioru; w razie potrzeby użyj unknown z niską pewnością.

## Warunki końcowe

- `label` jest jedną z podanych etykiet (albo jawnym `unknown`)
- `confidence` mieści się w przedziale od 0 do 1
$t$),
  ('block_template', 'ai//summarize', 'pl', 'label', $t$Streszczanie$t$),
  ('block_template', 'ai//summarize', 'pl', 'description', $t$Tworzy streszczenie tekstu wejściowego o kontrolowanej długości i tonie.$t$),
  ('block_template', 'ai//summarize', 'pl', 'tags', $t$streszczenie
nlp$t$),
  ('block_template', 'ai//summarize', 'pl', 'docs_md', $t$# Streszczanie

Tworzy streszczenie tekstu wejściowego o kontrolowanej długości i tonie.

## Warunki wstępne

- Tekst wejściowy jest w `text`

## Kroki

1. **Ustaw ograniczenia** — Zakoduj max_lines + ton w instrukcji systemowej.
2. **Wywołaj model** — Użyj ctx.llm() z tekstem i ograniczeniami.
3. **Przytnij** — Wymuś limit wierszy zapobiegawczo po odpowiedzi modelu.

## Warunki końcowe

- `summary` zachowuje żądaną maksymalną długość + ton
$t$),
  ('block_template', 'ai//generate-draft', 'pl', 'label', $t$Tworzenie szkicu$t$),
  ('block_template', 'ai//generate-draft', 'pl', 'description', $t$Redaguje treść na podstawie krótkiego briefu w wybranym tonie (e-mail, odpowiedź, opis, …).$t$),
  ('block_template', 'ai//generate-draft', 'pl', 'tags', $t$generowanie
redagowanie
nlp$t$),
  ('block_template', 'ai//generate-draft', 'pl', 'docs_md', $t$# Tworzenie szkicu

Redaguje treść na podstawie krótkiego briefu w wybranym tonie (e-mail, odpowiedź, opis, …).

## Warunki wstępne

- Brief jest przekazany w `brief`

## Kroki

1. **Określ zadanie** — Podaj modelowi odbiorcę, cel i ton.
2. **Wywołaj model** — Użyj ctx.llm() z briefem; zostaw tekst edytowalny, nie ostateczny.
3. **Zwróć** — Zwróć tekst szkicu, aby człowiek mógł go sprawdzić + wysłać.

## Warunki końcowe

- `draft` to gotowy do edycji pierwszy szkic w żądanym tonie
$t$),
  ('block_template', 'ai//route-by-intent', 'pl', 'label', $t$Kierowanie według intencji$t$),
  ('block_template', 'ai//route-by-intent', 'pl', 'description', $t$Rozpoznaje intencję użytkownika w wiadomości i kieruje ją do jednego ze stałego zbioru modułów obsługi.$t$),
  ('block_template', 'ai//route-by-intent', 'pl', 'tags', $t$intencja
kierowanie
nlp$t$),
  ('block_template', 'ai//route-by-intent', 'pl', 'docs_md', $t$# Kierowanie według intencji

Rozpoznaje intencję użytkownika w wiadomości i kieruje ją do jednego ze stałego zbioru modułów obsługi.

## Warunki wstępne

- Wiadomość jest w `message`
- Zbiór możliwych intencji jest w `intents`

## Kroki

1. **Opisz intencje** — Podaj modelowi jednowierszowy opis każdej możliwej intencji.
2. **Wywołaj model** — Użyj ctx.llm(); poproś o { intent, confidence } w formacie JSON.
3. **Zabezpiecz** — Poniżej progu pewności kieruj do fallback, zamiast zgadywać.

## Warunki końcowe

- `intent` jest jedną z możliwych intencji (albo `fallback`)
- `confidence` mieści się w przedziale od 0 do 1
$t$),
  ('block_template', 'ai//redact-pii', 'pl', 'label', $t$Maskowanie danych osobowych$t$),
  ('block_template', 'ai//redact-pii', 'pl', 'description', $t$Wykrywa i maskuje dane osobowe (imiona i nazwiska, adresy e-mail, numery telefonów, identyfikatory) w tekście swobodnym.$t$),
  ('block_template', 'ai//redact-pii', 'pl', 'tags', $t$dane osobowe
maskowanie
prywatność$t$),
  ('block_template', 'ai//redact-pii', 'pl', 'docs_md', $t$# Maskowanie danych osobowych

Wykrywa i maskuje dane osobowe (imiona i nazwiska, adresy e-mail, numery telefonów, identyfikatory) w tekście swobodnym.

## Warunki wstępne

- Tekst wejściowy jest w `text`
- Rodzaje danych osobowych do zamaskowania są w `kinds`

## Kroki

1. **Wskaż rodzaje** — Podaj modelowi, jakich rodzajów danych osobowych ma szukać (e-mail, telefon, imię, identyfikator).
2. **Wywołaj model** — Użyj ctx.llm(); poproś o fragmenty do zamaskowania, a nie o zwrot surowych wartości.
3. **Zamaskuj** — Zastąp każdy fragment przez [REDACTED:<kind>]; zlicz wystąpienia w `found`.

## Warunki końcowe

- `redacted` zastępuje każdy wykryty fragment typowanym symbolem zastępczym
- `found` wymienia to, co wykryto (rodzaj + liczba), nigdy surowych wartości
$t$),
  ('block_template', 'logic//validate-record', 'pl', 'label', $t$Walidacja rekordu$t$),
  ('block_template', 'logic//validate-record', 'pl', 'description', $t$Sprawdza rekord względem zestawu reguł pól; przepuszcza rekordy poprawne, a dla niepoprawnych zbiera przyczyny.$t$),
  ('block_template', 'logic//validate-record', 'pl', 'tags', $t$walidacja
zabezpieczenie
jakość danych$t$),
  ('block_template', 'logic//validate-record', 'pl', 'docs_md', $t$# Walidacja rekordu

Sprawdza rekord względem zestawu reguł pól; przepuszcza rekordy poprawne, a dla niepoprawnych zbiera przyczyny.

## Warunki wstępne

- Obiekt rekordu jest dostępny na wejściu `record`
- Zdefiniowany jest zestaw reguł pól (wymagane / typ / zakres)

## Kroki

1. **Wczytaj zestaw reguł** — Odczytaj reguły dla poszczególnych pól z wejścia `rules` (wymagane, typ, min/maks, wzorzec).
2. **Sprawdź każde pole** — Dla każdej reguły odczytaj record[field] i sprawdź je; przy błędzie dodaj komunikat do errors.
3. **Zdecyduj** — valid = errors.length === 0; zwróć oba, aby dalsze kroki mogły się rozgałęzić.

## Warunki końcowe

- `valid` ma wartość true tylko wtedy, gdy spełniona jest każda reguła
- `errors` zawiera czytelną przyczynę dla każdej niespełnionej reguły
$t$),
  ('block_template', 'logic//route-by-rule', 'pl', 'label', $t$Kierowanie według reguł (tablica decyzyjna)$t$),
  ('block_template', 'logic//route-by-rule', 'pl', 'description', $t$Wybiera gałąź, stosując do danych wejściowych uporządkowaną tablicę decyzyjną — wygrywa pierwsze dopasowanie.$t$),
  ('block_template', 'logic//route-by-rule', 'pl', 'tags', $t$kierowanie
tablica decyzyjna
rozgałęzienie$t$),
  ('block_template', 'logic//route-by-rule', 'pl', 'docs_md', $t$# Kierowanie według reguł (tablica decyzyjna)

Wybiera gałąź, stosując do danych wejściowych uporządkowaną tablicę decyzyjną — wygrywa pierwsze dopasowanie.

## Warunki wstępne

- Obiekt wejściowy jest dostępny w `item`
- Zdefiniowana jest uporządkowana lista reguł (warunek → trasa)

## Kroki

1. **Odczytaj tablicę decyzyjną** — Każda reguła ma postać { when: {field, op, value}, route }; przetwarzaj od góry do dołu.
2. **Znajdź pierwsze dopasowanie** — Zwróć trasę pierwszej reguły, której warunek jest spełniony dla `item`.
3. **Użyj wartości domyślnej** — Jeśli żadna reguła nie pasuje, zwróć skonfigurowaną trasę domyślną oraz matched=false.

## Warunki końcowe

- `route` to etykieta pierwszej pasującej reguły albo trasa domyślna
- `matched` wskazuje, czy zadziałała którakolwiek reguła
$t$),
  ('block_template', 'logic//approve-reject', 'pl', 'label', $t$Zatwierdzanie / odrzucanie (zasada dwóch par oczu)$t$),
  ('block_template', 'logic//approve-reject', 'pl', 'description', $t$Przepuszcza pozycję dopiero po sprawdzeniu zgodności z polityką i po wyraźnej decyzji człowieka, zapisując, kto zdecydował i dlaczego.$t$),
  ('block_template', 'logic//approve-reject', 'pl', 'tags', $t$zatwierdzanie
dwie pary oczu
nadzór$t$),
  ('block_template', 'logic//approve-reject', 'pl', 'docs_md', $t$# Zatwierdzanie / odrzucanie (zasada dwóch par oczu)

Przepuszcza pozycję dopiero po sprawdzeniu zgodności z polityką i po wyraźnej decyzji człowieka, zapisując, kto zdecydował i dlaczego.

## Warunki wstępne

- Pozycja poddana ocenie jest w `item`
- Podane są decyzja (`approve` | `reject`) oraz tożsamość osoby oceniającej

## Kroki

1. **Wykonaj wstępne kontrole polityki** — Najpierw uruchom automatyczne kontrole; automatycznie odrzuć wszystko, co nie spełnia polityki, niezależnie od decyzji człowieka.
2. **Zapisz decyzję człowieka** — Zarejestruj decyzję, osobę oceniającą i przyczynę na potrzeby ścieżki audytu.
3. **Zwróć wynik** — approved = policyPassed && decision === 'approve'; dołącz zapis decyzji.

## Warunki końcowe

- `approved` odzwierciedla decyzję osoby oceniającej po kontrolach zgodności z polityką
- Dołączona jest ścieżka audytu (osoba oceniająca, przyczyna, znacznik czasu)
$t$),
  ('block_template', 'logic//dedupe', 'pl', 'label', $t$Usuwanie duplikatów wierszy$t$),
  ('block_template', 'logic//dedupe', 'pl', 'description', $t$Scala wiersze o tym samym kluczu, zachowując jeden wybrany wiersz i zliczając usunięte duplikaty.$t$),
  ('block_template', 'logic//dedupe', 'pl', 'tags', $t$duplikaty
czyszczenie
jakość danych$t$),
  ('block_template', 'logic//dedupe', 'pl', 'docs_md', $t$# Usuwanie duplikatów wierszy

Scala wiersze o tym samym kluczu, zachowując jeden wybrany wiersz i zliczając usunięte duplikaty.

## Warunki wstępne

- Lista wierszy jest dostępna w `rows`
- Skonfigurowany jest klucz deduplikacji (jedno lub więcej pól)

## Kroki

1. **Zbuduj klucz** — Wylicz dla każdego wiersza klucz złożony ze skonfigurowanych pól kluczowych.
2. **Wybierz wiersz do zachowania** — Dla każdego klucza zachowaj pierwszy wiersz (albo najnowszy według `tiebreak`); resztę odrzuć.
3. **Zaraportuj** — Zwróć wiersze po deduplikacji oraz liczbę usuniętych.

## Warunki końcowe

- `rows` zawiera co najwyżej jeden zachowany wiersz na klucz
- `removed` zlicza, ile duplikatów usunięto
$t$),
  ('block_template', 'logic//enrich-lookup', 'pl', 'label', $t$Wzbogacanie przez tabelę odniesienia$t$),
  ('block_template', 'logic//enrich-lookup', 'pl', 'description', $t$Łączy każdy wiersz z tabelą odniesienia po kluczu i scala dopasowane pola odniesienia.$t$),
  ('block_template', 'logic//enrich-lookup', 'pl', 'tags', $t$wzbogacanie
złączenie
wyszukiwanie$t$),
  ('block_template', 'logic//enrich-lookup', 'pl', 'docs_md', $t$# Wzbogacanie przez tabelę odniesienia

Łączy każdy wiersz z tabelą odniesienia po kluczu i scala dopasowane pola odniesienia.

## Warunki wstępne

- Wiersze do wzbogacenia są w `rows`
- Dostępne są zbiór danych lub tabela odniesienia oraz klucz złączenia

## Kroki

1. **Zindeksuj tabelę odniesienia** — Zbuduj mapę z klucza złączenia na wiersz odniesienia, aby wyszukiwać w O(1).
2. **Scal** — Dla każdego wiersza wejściowego wyszukaj po kluczu i dołącz pola odniesienia (przy konflikcie wygrywa wejście).
3. **Śledź nietrafienia** — Zliczaj wiersze bez dopasowania, aby można było monitorować jakość.

## Warunki końcowe

- Każdy wiersz otrzymuje pola odniesienia, gdy znaleziono dopasowanie
- `unmatched` zlicza wiersze bez dopasowania w tabeli odniesienia
$t$),
  ('block_template', 'logic//threshold-flag', 'pl', 'label', $t$Oznaczanie po przekroczeniu progu$t$),
  ('block_template', 'logic//threshold-flag', 'pl', 'description', $t$Ocenia każdą pozycję i oznacza do przeglądu te, które przekraczają konfigurowalny próg.$t$),
  ('block_template', 'logic//threshold-flag', 'pl', 'tags', $t$ocena
oznaczanie
monitorowanie$t$),
  ('block_template', 'logic//threshold-flag', 'pl', 'docs_md', $t$# Oznaczanie po przekroczeniu progu

Ocenia każdą pozycję i oznacza do przeglądu te, które przekraczają konfigurowalny próg.

## Warunki wstępne

- Pozycje do oceny są w `items`
- Skonfigurowane są pole liczbowe oraz próg

## Kroki

1. **Odczytaj miarę** — Wyodrębnij pole liczbowe z każdej pozycji.
2. **Porównaj** — Oznacz pozycje, dla których value >= threshold (albo <= przy dolnych granicach).
3. **Zbierz** — Zwróć oznaczony podzbiór wraz z jego liczebnością.

## Warunki końcowe

- `flagged` zawiera pozycje, które przekraczają próg
- `count` to liczba oznaczonych pozycji
$t$),
  ('block_template', 'logic//map-transform', 'pl', 'label', $t$Mapowanie / przekształcanie$t$),
  ('block_template', 'logic//map-transform', 'pl', 'description', $t$Przekształca każdy wiersz do schematu docelowego przy użyciu mapowania pól, pomijając lub zmieniając nazwy zgodnie z konfiguracją.$t$),
  ('block_template', 'logic//map-transform', 'pl', 'tags', $t$przekształcanie
mapowanie
przebudowa$t$),
  ('block_template', 'logic//map-transform', 'pl', 'docs_md', $t$# Mapowanie / przekształcanie

Przekształca każdy wiersz do schematu docelowego przy użyciu mapowania pól, pomijając lub zmieniając nazwy zgodnie z konfiguracją.

## Warunki wstępne

- Wiersze źródłowe są w `rows`
- Skonfigurowane jest mapowanie pól (źródło → cel)

## Kroki

1. **Odczytaj mapowanie** — Mapowanie ma postać { targetField: sourceField }.
2. **Zrzutuj każdy wiersz** — Zbuduj dla każdego wiersza nowy obiekt na podstawie mapowania; pomiń pola niezmapowane.
3. **Zwróć** — Zwróć przekształcone wiersze w pierwotnej kolejności.

## Warunki końcowe

- Każdy wiersz wyjściowy zawiera wyłącznie zmapowane pola docelowe
- Kolejność wierszy zostaje zachowana
$t$),
  ('block_template', 'logic//aggregate', 'pl', 'label', $t$Agregacja / grupowanie$t$),
  ('block_template', 'logic//aggregate', 'pl', 'description', $t$Grupuje wiersze według klucza i wylicza agregaty (liczba / suma / średnia) dla każdej grupy.$t$),
  ('block_template', 'logic//aggregate', 'pl', 'tags', $t$agregacja
grupowanie
podsumowanie$t$),
  ('block_template', 'logic//aggregate', 'pl', 'docs_md', $t$# Agregacja / grupowanie

Grupuje wiersze według klucza i wylicza agregaty (liczba / suma / średnia) dla każdej grupy.

## Warunki wstępne

- Wiersze są w `rows`
- Skonfigurowane są klucz grupowania oraz miary do zagregowania

## Kroki

1. **Podziel na grupy** — Pogrupuj wiersze według skonfigurowanego pola group_by.
2. **Zredukuj** — Dla każdej grupy wylicz liczbę oraz sumę/średnią każdego pola miary.
3. **Zwróć wynik** — Zwróć po jednym wierszu na grupę wraz z agregatami.

## Warunki końcowe

- `groups` zawiera jeden wiersz podsumowania na każdy odrębny klucz
- Każde podsumowanie zawiera żądane agregaty
$t$),
  ('block_template', 'ui//form', 'pl', 'label', $t$Formularz$t$),
  ('block_template', 'ui//form', 'pl', 'description', $t$Zbiera i weryfikuje dane wprowadzone przez użytkownika względem schematu pól i przekazuje zebrane wartości po wysłaniu.$t$),
  ('block_template', 'ui//form', 'pl', 'tags', $t$formularz
wprowadzanie
zbieranie$t$),
  ('block_template', 'ui//form', 'pl', 'docs_md', $t$# Formularz

Zbiera i weryfikuje dane wprowadzone przez użytkownika względem schematu pól i przekazuje zebrane wartości po wysłaniu.

## Warunki wstępne

- Schemat pól (etykiety, typy, wymagalność) jest przekazany w `schema`

## Kroki

1. **Wyrenderuj pola** — Zbuduj pola wejściowe na podstawie schematu (tekst / liczba / lista / pole wyboru).
2. **Zweryfikuj** — Blokuj wysłanie, dopóki pola wymagane nie są wypełnione, a typy poprawne.
3. **Przekaż** — Po wysłaniu zwróć zebrane wartości oraz submitted=true.

## Warunki końcowe

- `values` zawiera zebrane pola po wysłaniu formularza
- `submitted` przyjmuje wartość true dopiero po pomyślnej walidacji po stronie klienta
$t$),
  ('block_template', 'ui//table', 'pl', 'label', $t$Tabela / lista$t$),
  ('block_template', 'ui//table', 'pl', 'description', $t$Wyświetla wiersze w sortowalnej tabeli z możliwością zaznaczania, na podstawie definicji kolumn.$t$),
  ('block_template', 'ui//table', 'pl', 'tags', $t$tabela
lista
siatka$t$),
  ('block_template', 'ui//table', 'pl', 'docs_md', $t$# Tabela / lista

Wyświetla wiersze w sortowalnej tabeli z możliwością zaznaczania, na podstawie definicji kolumn.

## Warunki wstępne

- Wiersze są przekazane w `rows`
- Definicja kolumn jest przekazana w `columns`

## Kroki

1. **Zdefiniuj kolumny** — Przypisz każdej kolumnie pole wiersza + nagłówek + opcjonalny formater.
2. **Wyrenderuj wiersze** — Wyświetl wiersze; obsłuż sortowanie po kolumnie i zaznaczanie wierszy.
3. **Przekaż zaznaczenie** — Zwróć zaznaczony wiersz lub wiersze, gdy użytkownik kliknie.

## Warunki końcowe

- `selected` odzwierciedla wiersz lub wiersze wybrane przez użytkownika
$t$),
  ('block_template', 'ui//chart', 'pl', 'label', $t$Wykres$t$),
  ('block_template', 'ui//chart', 'pl', 'description', $t$Przedstawia jedną lub więcej serii jako wykres liniowy, słupkowy albo kołowy.$t$),
  ('block_template', 'ui//chart', 'pl', 'tags', $t$wykres
wizualizacja
raport$t$),
  ('block_template', 'ui//chart', 'pl', 'docs_md', $t$# Wykres

Przedstawia jedną lub więcej serii jako wykres liniowy, słupkowy albo kołowy.

## Warunki wstępne

- Dane serii są przekazane w `series`

## Kroki

1. **Wybierz typ wykresu** — liniowy dla trendów, słupkowy dla porównań, kołowy dla struktury.
2. **Przypisz dane** — Przypisz punkty serii do osi / wycinków.
3. **Narysuj** — Narysuj wykres z opisami osi + legendą.

## Warunki końcowe

- Wykres jest rysowany dla wybranego `type`
$t$),
  ('block_template', 'ui//kpi-card', 'pl', 'label', $t$Karta KPI$t$),
  ('block_template', 'ui//kpi-card', 'pl', 'description', $t$Pokazuje pojedynczy kluczowy wskaźnik z opcjonalną zmianą względem poprzedniego okresu.$t$),
  ('block_template', 'ui//kpi-card', 'pl', 'tags', $t$kpi
wskaźnik
pulpit$t$),
  ('block_template', 'ui//kpi-card', 'pl', 'docs_md', $t$# Karta KPI

Pokazuje pojedynczy kluczowy wskaźnik z opcjonalną zmianą względem poprzedniego okresu.

## Warunki wstępne

- Podane są etykieta oraz wartość liczbowa

## Kroki

1. **Pokaż wartość** — Wyświetl główną liczbę wraz z etykietą.
2. **Pokaż zmianę** — Jeśli podano zmianę, pokaż wzrost/spadek ze znakiem + kolorem.

## Warunki końcowe

- Wyświetlane są wskaźnik + kierunek zmiany
$t$),
  ('block_template', 'ui//detail-view', 'pl', 'label', $t$Widok szczegółów$t$),
  ('block_template', 'ui//detail-view', 'pl', 'description', $t$Wyświetla pojedynczy rekord jako panel szczegółów etykieta/wartość tylko do odczytu.$t$),
  ('block_template', 'ui//detail-view', 'pl', 'tags', $t$szczegóły
rekord
tylko do odczytu$t$),
  ('block_template', 'ui//detail-view', 'pl', 'docs_md', $t$# Widok szczegółów

Wyświetla pojedynczy rekord jako panel szczegółów etykieta/wartość tylko do odczytu.

## Warunki wstępne

- Rekord jest przekazany w `record`

## Kroki

1. **Wybierz pola** — Użyj `fields`, aby wybrać + uporządkować wyświetlane klucze (domyślnie: wszystkie).
2. **Wyświetl** — Pokaż każde jako wiersz etykieta/wartość; sformatuj daty + liczby.

## Warunki końcowe

- Wybrane pola są wyświetlane jako wiersze etykieta/wartość
$t$),
  ('block_template', 'ui//filter-bar', 'pl', 'label', $t$Pasek filtrów$t$),
  ('block_template', 'ui//filter-bar', 'pl', 'description', $t$Wyświetla zestaw kontrolek filtrowania i przekazuje wynikowe zapytanie, gdy użytkownik je zmienia.$t$),
  ('block_template', 'ui//filter-bar', 'pl', 'tags', $t$filtr
wyszukiwanie
kontrolki$t$),
  ('block_template', 'ui//filter-bar', 'pl', 'docs_md', $t$# Pasek filtrów

Wyświetla zestaw kontrolek filtrowania i przekazuje wynikowe zapytanie, gdy użytkownik je zmienia.

## Warunki wstępne

- Definicja pól filtrowania jest przekazana w `fields`

## Kroki

1. **Wyrenderuj kontrolki** — Zbuduj kontrolkę dla każdego pola (tekst / lista / zakres dat).
2. **Zbierz** — Przy każdej zmianie złóż aktywne filtry w obiekt zapytania.
3. **Przekaż** — Zwróć zapytanie, aby kolejny blok danych mógł ponownie pobrać dane.

## Warunki końcowe

- `query` odzwierciedla bieżące ustawienia filtrów
- `changed` uruchamia się przy każdej zmianie kontrolki
$t$),
  ('block_template', 'ai//extract-fields', 'fr', 'label', $t$Extraire les champs$t$),
  ('block_template', 'ai//extract-fields', 'fr', 'description', $t$Extrait un ensemble structuré de champs à partir d'un texte libre à l'aide du modèle de langage géré (ctx.llm).$t$),
  ('block_template', 'ai//extract-fields', 'fr', 'tags', $t$extraction
structuré
nlp$t$),
  ('block_template', 'ai//extract-fields', 'fr', 'docs_md', $t$# Extraire les champs

Extrait un ensemble structuré de champs à partir d'un texte libre à l'aide du modèle de langage géré (ctx.llm).

## Préconditions

- Le texte source est fourni sur `text`
- Un schéma de champs cible est fourni sur `schema`

## Étapes

1. **Construire l'invite** — Demandez au modèle de ne renvoyer QUE du JSON conforme au schéma ; listez chaque champ + son type.
2. **Appeler le modèle** — Utilisez ctx.llm() avec le texte ; demandez une sortie JSON stricte.
3. **Analyser + protéger** — Analysez le JSON ; forcez les types ; mettez à null tout ce qui n'a pas été trouvé (jamais d'invention).

## Postconditions

- `fields` est un objet indexé par les champs du schéma
- Les champs manquants valent null plutôt que d'être inventés
$t$),
  ('block_template', 'ai//classify', 'fr', 'label', $t$Classifier$t$),
  ('block_template', 'ai//classify', 'fr', 'description', $t$Attribue au texte d'entrée le libellé le plus adapté parmi un ensemble fixe, avec un score de confiance.$t$),
  ('block_template', 'ai//classify', 'fr', 'tags', $t$classification
étiquetage
nlp$t$),
  ('block_template', 'ai//classify', 'fr', 'docs_md', $t$# Classifier

Attribue au texte d'entrée le libellé le plus adapté parmi un ensemble fixe, avec un score de confiance.

## Préconditions

- Le texte d'entrée est sur `text`
- Un ensemble fermé de libellés est sur `labels`

## Étapes

1. **Restreindre les choix** — Demandez au modèle de choisir exactement un libellé dans l'ensemble fourni.
2. **Appeler le modèle** — Utilisez ctx.llm() ; demandez { label, confidence } en JSON.
3. **Valider** — Rejetez tout libellé hors de l'ensemble ; repliez-vous sur unknown avec une confiance faible.

## Postconditions

- `label` est l'un des libellés fournis (ou un `unknown` explicite)
- `confidence` est compris entre 0 et 1
$t$),
  ('block_template', 'ai//summarize', 'fr', 'label', $t$Résumer$t$),
  ('block_template', 'ai//summarize', 'fr', 'description', $t$Produit un résumé du texte d'entrée dont la longueur et le ton sont contrôlés.$t$),
  ('block_template', 'ai//summarize', 'fr', 'tags', $t$résumé
nlp$t$),
  ('block_template', 'ai//summarize', 'fr', 'docs_md', $t$# Résumer

Produit un résumé du texte d'entrée dont la longueur et le ton sont contrôlés.

## Préconditions

- Le texte d'entrée est sur `text`

## Étapes

1. **Poser les contraintes** — Encodez max_lines + le ton dans l'instruction système.
2. **Appeler le modèle** — Utilisez ctx.llm() avec le texte et les contraintes.
3. **Tronquer** — Faites respecter la limite de lignes de façon défensive après la réponse du modèle.

## Postconditions

- `summary` respecte la longueur maximale + le ton demandés
$t$),
  ('block_template', 'ai//generate-draft', 'fr', 'label', $t$Rédiger un brouillon$t$),
  ('block_template', 'ai//generate-draft', 'fr', 'description', $t$Rédige un contenu à partir d'un brief court, dans le ton choisi (e-mail, réponse, description, …).$t$),
  ('block_template', 'ai//generate-draft', 'fr', 'tags', $t$génération
rédaction
nlp$t$),
  ('block_template', 'ai//generate-draft', 'fr', 'docs_md', $t$# Rédiger un brouillon

Rédige un contenu à partir d'un brief court, dans le ton choisi (e-mail, réponse, description, …).

## Préconditions

- Un brief est fourni sur `brief`

## Étapes

1. **Cadrer la tâche** — Indiquez au modèle le public, l'objectif et le ton.
2. **Appeler le modèle** — Utilisez ctx.llm() avec le brief ; gardez le texte modifiable, non définitif.
3. **Renvoyer** — Renvoyez le texte du brouillon pour qu'un humain le relise + l'envoie.

## Postconditions

- `draft` est un premier brouillon prêt à être modifié, dans le ton demandé
$t$),
  ('block_template', 'ai//route-by-intent', 'fr', 'label', $t$Router par intention$t$),
  ('block_template', 'ai//route-by-intent', 'fr', 'description', $t$Détecte l'intention de l'utilisateur dans un message et l'oriente vers l'un des gestionnaires d'un ensemble fixe.$t$),
  ('block_template', 'ai//route-by-intent', 'fr', 'tags', $t$intention
routage
nlp$t$),
  ('block_template', 'ai//route-by-intent', 'fr', 'docs_md', $t$# Router par intention

Détecte l'intention de l'utilisateur dans un message et l'oriente vers l'un des gestionnaires d'un ensemble fixe.

## Préconditions

- Un message est sur `message`
- Un ensemble d'intentions candidates est sur `intents`

## Étapes

1. **Décrire les intentions** — Donnez au modèle une description d'une ligne par intention candidate.
2. **Appeler le modèle** — Utilisez ctx.llm() ; demandez { intent, confidence } en JSON.
3. **Filtrer** — En dessous d'un seuil de confiance, orientez vers fallback plutôt que de deviner.

## Postconditions

- `intent` est l'une des candidates (ou `fallback`)
- `confidence` est compris entre 0 et 1
$t$),
  ('block_template', 'ai//redact-pii', 'fr', 'label', $t$Masquer les données personnelles$t$),
  ('block_template', 'ai//redact-pii', 'fr', 'description', $t$Détecte et masque les données personnelles (noms, e-mails, téléphones, identifiants) dans un texte libre.$t$),
  ('block_template', 'ai//redact-pii', 'fr', 'tags', $t$données personnelles
masquage
confidentialité$t$),
  ('block_template', 'ai//redact-pii', 'fr', 'docs_md', $t$# Masquer les données personnelles

Détecte et masque les données personnelles (noms, e-mails, téléphones, identifiants) dans un texte libre.

## Préconditions

- Le texte d'entrée est sur `text`
- Les types de données personnelles à masquer sont sur `kinds`

## Étapes

1. **Préciser les types** — Indiquez au modèle les types de données personnelles à rechercher (e-mail, téléphone, nom, identifiant).
2. **Appeler le modèle** — Utilisez ctx.llm() ; demandez les passages à masquer, pas les valeurs brutes en retour.
3. **Masquer** — Remplacez chaque passage par [REDACTED:<kind>] ; totalisez les occurrences dans `found`.

## Postconditions

- `redacted` remplace chaque passage détecté par un espace réservé typé
- `found` liste ce qui a été détecté (type + nombre), jamais les valeurs brutes
$t$),
  ('block_template', 'logic//validate-record', 'fr', 'label', $t$Valider un enregistrement$t$),
  ('block_template', 'logic//validate-record', 'fr', 'description', $t$Contrôle un enregistrement selon un jeu de règles de champs ; laisse passer les enregistrements valides et collecte les motifs pour les invalides.$t$),
  ('block_template', 'logic//validate-record', 'fr', 'tags', $t$validation
garde-fou
qualité des données$t$),
  ('block_template', 'logic//validate-record', 'fr', 'docs_md', $t$# Valider un enregistrement

Contrôle un enregistrement selon un jeu de règles de champs ; laisse passer les enregistrements valides et collecte les motifs pour les invalides.

## Préconditions

- Un objet enregistrement est disponible sur l'entrée `record`
- Un jeu de règles de champs (obligatoire / type / plage) est défini

## Étapes

1. **Charger le jeu de règles** — Lisez les règles par champ depuis l'entrée `rules` (obligatoire, type, min/max, motif).
2. **Évaluer chaque champ** — Pour chaque règle, lisez record[field] et testez-le ; ajoutez un message à errors en cas d'échec.
3. **Décider** — valid = errors.length === 0 ; renvoyez les deux pour que l'aval puisse brancher.

## Postconditions

- `valid` vaut true uniquement si toutes les règles passent
- `errors` donne un motif lisible par règle en échec
$t$),
  ('block_template', 'logic//route-by-rule', 'fr', 'label', $t$Router par règle (table de décision)$t$),
  ('block_template', 'logic//route-by-rule', 'fr', 'description', $t$Choisit une branche en évaluant une table de décision ordonnée sur l'entrée — la première correspondance l'emporte.$t$),
  ('block_template', 'logic//route-by-rule', 'fr', 'tags', $t$routage
table de décision
branchement$t$),
  ('block_template', 'logic//route-by-rule', 'fr', 'docs_md', $t$# Router par règle (table de décision)

Choisit une branche en évaluant une table de décision ordonnée sur l'entrée — la première correspondance l'emporte.

## Préconditions

- Un objet d'entrée est disponible sur `item`
- Une liste ordonnée de règles (condition → route) est définie

## Étapes

1. **Lire la table de décision** — Chaque règle s'écrit { when: {field, op, value}, route } ; évaluez de haut en bas.
2. **Trouver la première correspondance** — Renvoyez la route de la première règle dont la condition est vraie pour `item`.
3. **Se rabattre** — Si aucune règle ne correspond, renvoyez la route par défaut configurée et matched=false.

## Postconditions

- `route` est le libellé de la première règle correspondante, ou la route par défaut
- `matched` indique si une règle a été déclenchée
$t$),
  ('block_template', 'logic//approve-reject', 'fr', 'label', $t$Approuver / rejeter (double validation)$t$),
  ('block_template', 'logic//approve-reject', 'fr', 'description', $t$Soumet un élément à une politique interne puis à une décision humaine explicite, en consignant qui a décidé et pourquoi.$t$),
  ('block_template', 'logic//approve-reject', 'fr', 'tags', $t$approbation
double validation
gouvernance$t$),
  ('block_template', 'logic//approve-reject', 'fr', 'docs_md', $t$# Approuver / rejeter (double validation)

Soumet un élément à une politique interne puis à une décision humaine explicite, en consignant qui a décidé et pourquoi.

## Préconditions

- L'élément à examiner est sur `item`
- Une décision (`approve` | `reject`) et l'identité du relecteur sont fournies

## Étapes

1. **Appliquer les contrôles de politique** — Exécutez d'abord les garde-fous automatiques ; rejetez automatiquement tout ce qui échoue à la politique, quelle que soit la saisie humaine.
2. **Consigner la décision humaine** — Enregistrez la décision, le relecteur et le motif pour la piste d'audit.
3. **Émettre le résultat** — approved = policyPassed && decision === 'approve' ; incluez l'enregistrement de décision.

## Postconditions

- `approved` reflète la décision du relecteur après les contrôles de politique
- Une piste d'audit (relecteur, motif, horodatage) est jointe
$t$),
  ('block_template', 'logic//dedupe', 'fr', 'label', $t$Dédoublonner les lignes$t$),
  ('block_template', 'logic//dedupe', 'fr', 'description', $t$Fusionne les lignes partageant une même clé, en conservant une ligne survivante choisie et en comptant les doublons supprimés.$t$),
  ('block_template', 'logic//dedupe', 'fr', 'tags', $t$dédoublonnage
nettoyage
qualité des données$t$),
  ('block_template', 'logic//dedupe', 'fr', 'docs_md', $t$# Dédoublonner les lignes

Fusionne les lignes partageant une même clé, en conservant une ligne survivante choisie et en comptant les doublons supprimés.

## Préconditions

- Une liste de lignes est disponible sur `rows`
- Une clé de dédoublonnage (un ou plusieurs champs) est configurée

## Étapes

1. **Construire la clé** — Calculez une clé composite par ligne à partir des champs de clé configurés.
2. **Choisir la survivante** — Pour chaque clé, gardez la première ligne (ou la plus récente selon `tiebreak`) ; écartez les autres.
3. **Rendre compte** — Renvoyez les lignes dédoublonnées et le nombre de suppressions.

## Postconditions

- `rows` contient au plus une ligne survivante par clé
- `removed` compte le nombre de doublons supprimés
$t$),
  ('block_template', 'logic//enrich-lookup', 'fr', 'label', $t$Enrichir par table de référence$t$),
  ('block_template', 'logic//enrich-lookup', 'fr', 'description', $t$Joint chaque ligne à une table de référence sur une clé et y fusionne les champs de référence trouvés.$t$),
  ('block_template', 'logic//enrich-lookup', 'fr', 'tags', $t$enrichissement
jointure
correspondance$t$),
  ('block_template', 'logic//enrich-lookup', 'fr', 'docs_md', $t$# Enrichir par table de référence

Joint chaque ligne à une table de référence sur une clé et y fusionne les champs de référence trouvés.

## Préconditions

- Les lignes à enrichir sont sur `rows`
- Un jeu de données / une table de référence et la clé de jointure sont disponibles

## Étapes

1. **Indexer la référence** — Construisez une table associant la clé de jointure à la ligne de référence pour des accès en O(1).
2. **Fusionner** — Pour chaque ligne d'entrée, recherchez par clé et intégrez les champs de référence (l'entrée l'emporte en cas de conflit).
3. **Suivre les échecs** — Comptez les lignes sans correspondance afin de pouvoir surveiller la qualité.

## Postconditions

- Chaque ligne reçoit les champs de référence lorsqu'une correspondance est trouvée
- `unmatched` compte les lignes sans correspondance de référence
$t$),
  ('block_template', 'logic//threshold-flag', 'fr', 'label', $t$Marquer selon un seuil$t$),
  ('block_template', 'logic//threshold-flag', 'fr', 'description', $t$Note chaque élément et marque pour examen ceux qui franchissent un seuil configurable.$t$),
  ('block_template', 'logic//threshold-flag', 'fr', 'tags', $t$notation
marquage
surveillance$t$),
  ('block_template', 'logic//threshold-flag', 'fr', 'docs_md', $t$# Marquer selon un seuil

Note chaque élément et marque pour examen ceux qui franchissent un seuil configurable.

## Préconditions

- Les éléments à noter sont sur `items`
- Un champ numérique et un seuil sont configurés

## Étapes

1. **Lire la mesure** — Extrayez le champ numérique de chaque élément.
2. **Comparer** — Marquez les éléments où value >= threshold (ou <= pour une borne inférieure).
3. **Collecter** — Renvoyez le sous-ensemble marqué et son effectif.

## Postconditions

- `flagged` liste les éléments qui franchissent le seuil
- `count` est le nombre d'éléments marqués
$t$),
  ('block_template', 'logic//map-transform', 'fr', 'label', $t$Mapper / transformer$t$),
  ('block_template', 'logic//map-transform', 'fr', 'description', $t$Remodèle chaque ligne vers un schéma cible via une correspondance de champs, en supprimant ou en renommant selon la configuration.$t$),
  ('block_template', 'logic//map-transform', 'fr', 'tags', $t$transformation
correspondance
remodelage$t$),
  ('block_template', 'logic//map-transform', 'fr', 'docs_md', $t$# Mapper / transformer

Remodèle chaque ligne vers un schéma cible via une correspondance de champs, en supprimant ou en renommant selon la configuration.

## Préconditions

- Les lignes source sont sur `rows`
- Une correspondance de champs (source → cible) est configurée

## Étapes

1. **Lire la correspondance** — La correspondance s'écrit { targetField: sourceField }.
2. **Projeter chaque ligne** — Construisez un nouvel objet par ligne à l'aide de la correspondance ; ignorez les champs non mappés.
3. **Renvoyer** — Émettez les lignes transformées dans l'ordre d'origine.

## Postconditions

- Chaque ligne de sortie ne contient que les champs cibles mappés
- L'ordre des lignes est préservé
$t$),
  ('block_template', 'logic//aggregate', 'fr', 'label', $t$Agréger / grouper$t$),
  ('block_template', 'logic//aggregate', 'fr', 'description', $t$Groupe les lignes par une clé et calcule des agrégats (nombre / somme / moyenne) par groupe.$t$),
  ('block_template', 'logic//aggregate', 'fr', 'tags', $t$agrégation
groupement
synthèse$t$),
  ('block_template', 'logic//aggregate', 'fr', 'docs_md', $t$# Agréger / grouper

Groupe les lignes par une clé et calcule des agrégats (nombre / somme / moyenne) par groupe.

## Préconditions

- Les lignes sont sur `rows`
- Une clé de groupement et les mesures à agréger sont configurées

## Étapes

1. **Répartir** — Groupez les lignes selon le champ group_by configuré.
2. **Réduire** — Par groupe, calculez le nombre ainsi que la somme/moyenne de chaque champ de mesure.
3. **Émettre** — Renvoyez une ligne par groupe avec les agrégats.

## Postconditions

- `groups` contient une ligne de synthèse par clé distincte
- Chaque synthèse porte les agrégats demandés
$t$),
  ('block_template', 'ui//form', 'fr', 'label', $t$Formulaire$t$),
  ('block_template', 'ui//form', 'fr', 'description', $t$Recueille et valide la saisie de l'utilisateur selon un schéma de champs, puis émet les valeurs saisies à la soumission.$t$),
  ('block_template', 'ui//form', 'fr', 'tags', $t$formulaire
saisie
collecte$t$),
  ('block_template', 'ui//form', 'fr', 'docs_md', $t$# Formulaire

Recueille et valide la saisie de l'utilisateur selon un schéma de champs, puis émet les valeurs saisies à la soumission.

## Préconditions

- Un schéma de champs (libellés, types, obligatoire) est fourni sur `schema`

## Étapes

1. **Afficher les champs** — Construisez les champs de saisie à partir du schéma (texte / nombre / liste / case à cocher).
2. **Valider** — Bloquez la soumission tant que des champs obligatoires manquent ou que des types sont invalides.
3. **Émettre** — À la soumission, renvoyez les valeurs recueillies et submitted=true.

## Postconditions

- `values` contient les champs saisis une fois le formulaire soumis
- `submitted` ne passe à true qu'après la validation côté client
$t$),
  ('block_template', 'ui//table', 'fr', 'label', $t$Tableau / liste$t$),
  ('block_template', 'ui//table', 'fr', 'description', $t$Affiche des lignes dans un tableau triable et sélectionnable à partir d'une définition de colonnes.$t$),
  ('block_template', 'ui//table', 'fr', 'tags', $t$tableau
liste
grille$t$),
  ('block_template', 'ui//table', 'fr', 'docs_md', $t$# Tableau / liste

Affiche des lignes dans un tableau triable et sélectionnable à partir d'une définition de colonnes.

## Préconditions

- Les lignes sont fournies sur `rows`
- Une définition de colonnes est fournie sur `columns`

## Étapes

1. **Définir les colonnes** — Associez chaque colonne à un champ de ligne + un en-tête + un formateur facultatif.
2. **Afficher les lignes** — Affichez les lignes ; permettez le tri par colonne et la sélection de lignes.
3. **Émettre la sélection** — Renvoyez la ou les lignes sélectionnées lorsque l'utilisateur clique.

## Postconditions

- `selected` reflète la ou les lignes choisies par l'utilisateur
$t$),
  ('block_template', 'ui//chart', 'fr', 'label', $t$Graphique$t$),
  ('block_template', 'ui//chart', 'fr', 'description', $t$Visualise une ou plusieurs séries sous forme de courbe, de barres ou de secteurs.$t$),
  ('block_template', 'ui//chart', 'fr', 'tags', $t$graphique
visualisation
rapport$t$),
  ('block_template', 'ui//chart', 'fr', 'docs_md', $t$# Graphique

Visualise une ou plusieurs séries sous forme de courbe, de barres ou de secteurs.

## Préconditions

- Les données de série sont fournies sur `series`

## Étapes

1. **Choisir un type de graphique** — courbe pour les tendances, barres pour les comparaisons, secteurs pour la composition.
2. **Associer les données** — Associez les points de série aux axes / aux secteurs.
3. **Tracer** — Tracez le graphique avec les libellés d'axes + une légende.

## Postconditions

- Le graphique s'affiche selon le `type` choisi
$t$),
  ('block_template', 'ui//kpi-card', 'fr', 'label', $t$Carte KPI$t$),
  ('block_template', 'ui//kpi-card', 'fr', 'description', $t$Affiche un indicateur clé unique avec une variation facultative par rapport à la période précédente.$t$),
  ('block_template', 'ui//kpi-card', 'fr', 'tags', $t$kpi
indicateur
tableau de bord$t$),
  ('block_template', 'ui//kpi-card', 'fr', 'docs_md', $t$# Carte KPI

Affiche un indicateur clé unique avec une variation facultative par rapport à la période précédente.

## Préconditions

- Un libellé et une valeur numérique sont fournis

## Étapes

1. **Afficher la valeur** — Affichez le chiffre principal avec son libellé.
2. **Afficher la variation** — Si une variation est fournie, indiquez la hausse/baisse avec le signe + la couleur.

## Postconditions

- L'indicateur + le sens de la variation s'affichent
$t$),
  ('block_template', 'ui//detail-view', 'fr', 'label', $t$Vue détaillée$t$),
  ('block_template', 'ui//detail-view', 'fr', 'description', $t$Affiche un enregistrement unique sous forme de panneau de détail libellé/valeur en lecture seule.$t$),
  ('block_template', 'ui//detail-view', 'fr', 'tags', $t$détail
enregistrement
lecture seule$t$),
  ('block_template', 'ui//detail-view', 'fr', 'docs_md', $t$# Vue détaillée

Affiche un enregistrement unique sous forme de panneau de détail libellé/valeur en lecture seule.

## Préconditions

- Un enregistrement est fourni sur `record`

## Étapes

1. **Choisir les champs** — Utilisez `fields` pour choisir + ordonner les clés à afficher (par défaut : toutes).
2. **Afficher** — Affichez chacune en ligne libellé/valeur ; formatez les dates + les nombres.

## Postconditions

- Les champs sélectionnés s'affichent en lignes libellé/valeur
$t$),
  ('block_template', 'ui//filter-bar', 'fr', 'label', $t$Barre de filtres$t$),
  ('block_template', 'ui//filter-bar', 'fr', 'description', $t$Affiche un ensemble de contrôles de filtre et émet la requête correspondante à mesure que l'utilisateur les modifie.$t$),
  ('block_template', 'ui//filter-bar', 'fr', 'tags', $t$filtre
recherche
contrôles$t$),
  ('block_template', 'ui//filter-bar', 'fr', 'docs_md', $t$# Barre de filtres

Affiche un ensemble de contrôles de filtre et émet la requête correspondante à mesure que l'utilisateur les modifie.

## Préconditions

- Une définition des champs de filtre est fournie sur `fields`

## Étapes

1. **Afficher les contrôles** — Construisez un contrôle par champ (texte / liste / plage de dates).
2. **Collecter** — À chaque changement, assemblez les filtres actifs en un objet de requête.
3. **Émettre** — Renvoyez la requête pour qu'un bloc de données en aval puisse recharger.

## Postconditions

- `query` reflète les sélections de filtre en cours
- `changed` se déclenche dès qu'un contrôle change
$t$),
  ('block_template', 'ai//extract-fields', 'es', 'label', $t$Extraer campos$t$),
  ('block_template', 'ai//extract-fields', 'es', 'description', $t$Extrae un conjunto estructurado de campos a partir de texto libre mediante el modelo de lenguaje gestionado (ctx.llm).$t$),
  ('block_template', 'ai//extract-fields', 'es', 'tags', $t$extracción
estructurado
nlp$t$),
  ('block_template', 'ai//extract-fields', 'es', 'docs_md', $t$# Extraer campos

Extrae un conjunto estructurado de campos a partir de texto libre mediante el modelo de lenguaje gestionado (ctx.llm).

## Precondiciones

- El texto de origen se recibe en `text`
- Un esquema de campos de destino se recibe en `schema`

## Pasos

1. **Construir el prompt** — Indica al modelo que devuelva SOLO JSON conforme al esquema; enumera cada campo + su tipo.
2. **Llamar al modelo** — Usa ctx.llm() con el texto; solicita una salida JSON estricta.
3. **Analizar + proteger** — Analiza el JSON; fuerza los tipos; deja en null todo lo que no se encuentre (nunca inventes).

## Poscondiciones

- `fields` es un objeto indexado por los campos del esquema
- Los campos ausentes son null en lugar de inventados
$t$),
  ('block_template', 'ai//classify', 'es', 'label', $t$Clasificar$t$),
  ('block_template', 'ai//classify', 'es', 'description', $t$Asigna al texto de entrada la etiqueta más adecuada de un conjunto fijo, con una puntuación de confianza.$t$),
  ('block_template', 'ai//classify', 'es', 'tags', $t$clasificación
etiquetado
nlp$t$),
  ('block_template', 'ai//classify', 'es', 'docs_md', $t$# Clasificar

Asigna al texto de entrada la etiqueta más adecuada de un conjunto fijo, con una puntuación de confianza.

## Precondiciones

- El texto de entrada está en `text`
- Un conjunto cerrado de etiquetas está en `labels`

## Pasos

1. **Restringir las opciones** — Pide al modelo que elija exactamente una etiqueta del conjunto facilitado.
2. **Llamar al modelo** — Usa ctx.llm(); pide { label, confidence } en JSON.
3. **Validar** — Rechaza cualquier etiqueta fuera del conjunto; recurre a unknown con confianza baja.

## Poscondiciones

- `label` es una de las etiquetas facilitadas (o un `unknown` explícito)
- `confidence` está entre 0 y 1
$t$),
  ('block_template', 'ai//summarize', 'es', 'label', $t$Resumir$t$),
  ('block_template', 'ai//summarize', 'es', 'description', $t$Genera un resumen del texto de entrada con la longitud y el tono controlados.$t$),
  ('block_template', 'ai//summarize', 'es', 'tags', $t$resumen
nlp$t$),
  ('block_template', 'ai//summarize', 'es', 'docs_md', $t$# Resumir

Genera un resumen del texto de entrada con la longitud y el tono controlados.

## Precondiciones

- El texto de entrada está en `text`

## Pasos

1. **Fijar las restricciones** — Codifica max_lines + el tono en la instrucción de sistema.
2. **Llamar al modelo** — Usa ctx.llm() con el texto y las restricciones.
3. **Recortar** — Aplica el límite de líneas de forma defensiva después de que responda el modelo.

## Poscondiciones

- `summary` respeta la longitud máxima + el tono solicitados
$t$),
  ('block_template', 'ai//generate-draft', 'es', 'label', $t$Redactar un borrador$t$),
  ('block_template', 'ai//generate-draft', 'es', 'description', $t$Redacta contenido a partir de un briefing breve en el tono elegido (correo, respuesta, descripción, …).$t$),
  ('block_template', 'ai//generate-draft', 'es', 'tags', $t$generación
redacción
nlp$t$),
  ('block_template', 'ai//generate-draft', 'es', 'docs_md', $t$# Redactar un borrador

Redacta contenido a partir de un briefing breve en el tono elegido (correo, respuesta, descripción, …).

## Precondiciones

- Se facilita un briefing en `brief`

## Pasos

1. **Enmarcar la tarea** — Indica al modelo el público, el propósito y el tono.
2. **Llamar al modelo** — Usa ctx.llm() con el briefing; mantenlo editable, no definitivo.
3. **Devolver** — Devuelve el texto del borrador para que una persona lo revise + lo envíe.

## Poscondiciones

- `draft` es un primer borrador listo para editar en el tono solicitado
$t$),
  ('block_template', 'ai//route-by-intent', 'es', 'label', $t$Enrutar por intención$t$),
  ('block_template', 'ai//route-by-intent', 'es', 'description', $t$Detecta la intención del usuario en un mensaje y lo dirige a uno de un conjunto fijo de manejadores.$t$),
  ('block_template', 'ai//route-by-intent', 'es', 'tags', $t$intención
enrutamiento
nlp$t$),
  ('block_template', 'ai//route-by-intent', 'es', 'docs_md', $t$# Enrutar por intención

Detecta la intención del usuario en un mensaje y lo dirige a uno de un conjunto fijo de manejadores.

## Precondiciones

- Un mensaje está en `message`
- Un conjunto de intenciones candidatas está en `intents`

## Pasos

1. **Describir las intenciones** — Da al modelo una descripción de una línea por cada intención candidata.
2. **Llamar al modelo** — Usa ctx.llm(); pide { intent, confidence } en JSON.
3. **Filtrar** — Por debajo de un umbral de confianza, dirige a fallback en lugar de adivinar.

## Poscondiciones

- `intent` es una de las candidatas (o `fallback`)
- `confidence` está entre 0 y 1
$t$),
  ('block_template', 'ai//redact-pii', 'es', 'label', $t$Enmascarar datos personales$t$),
  ('block_template', 'ai//redact-pii', 'es', 'description', $t$Detecta y enmascara datos personales (nombres, correos, teléfonos, identificadores) en texto libre.$t$),
  ('block_template', 'ai//redact-pii', 'es', 'tags', $t$datos personales
enmascarado
privacidad$t$),
  ('block_template', 'ai//redact-pii', 'es', 'docs_md', $t$# Enmascarar datos personales

Detecta y enmascara datos personales (nombres, correos, teléfonos, identificadores) en texto libre.

## Precondiciones

- El texto de entrada está en `text`
- Los tipos de datos personales que se deben enmascarar están en `kinds`

## Pasos

1. **Especificar los tipos** — Indica al modelo qué tipos de datos personales debe buscar (correo, teléfono, nombre, id).
2. **Llamar al modelo** — Usa ctx.llm(); pide los fragmentos que hay que enmascarar, no los valores originales.
3. **Enmascarar** — Sustituye cada fragmento por [REDACTED:<kind>]; contabiliza los recuentos en `found`.

## Poscondiciones

- `redacted` sustituye cada fragmento detectado por un marcador con su tipo
- `found` enumera lo detectado (tipo + recuento), nunca los valores originales
$t$),
  ('block_template', 'logic//validate-record', 'es', 'label', $t$Validar registro$t$),
  ('block_template', 'logic//validate-record', 'es', 'description', $t$Comprueba un registro frente a un conjunto de reglas de campo; deja pasar los registros válidos y recopila los motivos de los inválidos.$t$),
  ('block_template', 'logic//validate-record', 'es', 'tags', $t$validación
control
calidad de datos$t$),
  ('block_template', 'logic//validate-record', 'es', 'docs_md', $t$# Validar registro

Comprueba un registro frente a un conjunto de reglas de campo; deja pasar los registros válidos y recopila los motivos de los inválidos.

## Precondiciones

- Hay un objeto de registro disponible en la entrada `record`
- Hay definido un conjunto de reglas de campo (obligatorio / tipo / rango)

## Pasos

1. **Cargar el conjunto de reglas** — Lee las reglas por campo desde la entrada `rules` (obligatorio, tipo, mín./máx., patrón).
2. **Evaluar cada campo** — Para cada regla, lee record[field] y compruébalo; añade un mensaje a errors si falla.
3. **Decidir** — valid = errors.length === 0; devuelve ambos para que el flujo posterior pueda ramificar.

## Poscondiciones

- `valid` solo es true cuando se cumplen todas las reglas
- `errors` recoge un motivo legible por cada regla incumplida
$t$),
  ('block_template', 'logic//route-by-rule', 'es', 'label', $t$Enrutar por regla (tabla de decisión)$t$),
  ('block_template', 'logic//route-by-rule', 'es', 'description', $t$Elige una rama evaluando una tabla de decisión ordenada sobre la entrada — gana la primera coincidencia.$t$),
  ('block_template', 'logic//route-by-rule', 'es', 'tags', $t$enrutamiento
tabla de decisión
ramificación$t$),
  ('block_template', 'logic//route-by-rule', 'es', 'docs_md', $t$# Enrutar por regla (tabla de decisión)

Elige una rama evaluando una tabla de decisión ordenada sobre la entrada — gana la primera coincidencia.

## Precondiciones

- Hay un objeto de entrada disponible en `item`
- Hay definida una lista ordenada de reglas (condición → ruta)

## Pasos

1. **Leer la tabla de decisión** — Cada regla es { when: {field, op, value}, route }; evalúa de arriba abajo.
2. **Buscar la primera coincidencia** — Devuelve la ruta de la primera regla cuya condición se cumple para `item`.
3. **Recurrir al valor por defecto** — Si no coincide ninguna regla, devuelve la ruta por defecto configurada y matched=false.

## Poscondiciones

- `route` es la etiqueta de la primera regla coincidente, o la ruta por defecto
- `matched` indica si se activó alguna regla
$t$),
  ('block_template', 'logic//approve-reject', 'es', 'label', $t$Aprobar / rechazar (doble validación)$t$),
  ('block_template', 'logic//approve-reject', 'es', 'description', $t$Somete un elemento a una política interna y a una decisión humana explícita, dejando constancia de quién decidió y por qué.$t$),
  ('block_template', 'logic//approve-reject', 'es', 'tags', $t$aprobación
doble validación
gobernanza$t$),
  ('block_template', 'logic//approve-reject', 'es', 'docs_md', $t$# Aprobar / rechazar (doble validación)

Somete un elemento a una política interna y a una decisión humana explícita, dejando constancia de quién decidió y por qué.

## Precondiciones

- El elemento en revisión está en `item`
- Se facilitan una decisión (`approve` | `reject`) y la identidad del revisor

## Pasos

1. **Aplicar las comprobaciones de política** — Ejecuta primero los controles automáticos; rechaza automáticamente todo lo que incumpla la política, sea cual sea la entrada humana.
2. **Registrar la decisión humana** — Captura la decisión, el revisor y el motivo para la pista de auditoría.
3. **Emitir el resultado** — approved = policyPassed && decision === 'approve'; incluye el registro de la decisión.

## Poscondiciones

- `approved` refleja la decisión del revisor tras las comprobaciones de política
- Se adjunta una pista de auditoría (revisor, motivo, marca de tiempo)
$t$),
  ('block_template', 'logic//dedupe', 'es', 'label', $t$Eliminar filas duplicadas$t$),
  ('block_template', 'logic//dedupe', 'es', 'description', $t$Fusiona las filas que comparten una clave, conserva una fila superviviente elegida y cuenta los duplicados eliminados.$t$),
  ('block_template', 'logic//dedupe', 'es', 'tags', $t$duplicados
limpieza
calidad de datos$t$),
  ('block_template', 'logic//dedupe', 'es', 'docs_md', $t$# Eliminar filas duplicadas

Fusiona las filas que comparten una clave, conserva una fila superviviente elegida y cuenta los duplicados eliminados.

## Precondiciones

- Hay una lista de filas disponible en `rows`
- Hay configurada una clave de deduplicación (uno o varios campos)

## Pasos

1. **Construir la clave** — Calcula una clave compuesta por fila a partir de los campos de clave configurados.
2. **Elegir la superviviente** — Para cada clave conserva la primera fila (o la más reciente según `tiebreak`); descarta el resto.
3. **Informar** — Devuelve las filas deduplicadas y el número de eliminadas.

## Poscondiciones

- `rows` contiene como mucho una fila superviviente por clave
- `removed` cuenta cuántos duplicados se descartaron
$t$),
  ('block_template', 'logic//enrich-lookup', 'es', 'label', $t$Enriquecer mediante tabla de referencia$t$),
  ('block_template', 'logic//enrich-lookup', 'es', 'description', $t$Une cada fila con una tabla de referencia por una clave e incorpora los campos de referencia coincidentes.$t$),
  ('block_template', 'logic//enrich-lookup', 'es', 'tags', $t$enriquecimiento
unión
búsqueda$t$),
  ('block_template', 'logic//enrich-lookup', 'es', 'docs_md', $t$# Enriquecer mediante tabla de referencia

Une cada fila con una tabla de referencia por una clave e incorpora los campos de referencia coincidentes.

## Precondiciones

- Las filas que hay que enriquecer están en `rows`
- Están disponibles un conjunto de datos o tabla de referencia y la clave de unión

## Pasos

1. **Indexar la referencia** — Construye un mapa de la clave de unión a la fila de referencia para búsquedas en O(1).
2. **Fusionar** — Para cada fila de entrada, busca por clave e incorpora los campos de referencia (en caso de conflicto gana la entrada).
3. **Registrar los fallos** — Cuenta las filas sin coincidencia para poder supervisar la calidad.

## Poscondiciones

- Cada fila incorpora los campos de referencia cuando hay coincidencia
- `unmatched` cuenta las filas sin coincidencia en la referencia
$t$),
  ('block_template', 'logic//threshold-flag', 'es', 'label', $t$Marcar por umbral$t$),
  ('block_template', 'logic//threshold-flag', 'es', 'description', $t$Puntúa cada elemento y marca para revisión los que superan un umbral configurable.$t$),
  ('block_template', 'logic//threshold-flag', 'es', 'tags', $t$puntuación
marcado
supervisión$t$),
  ('block_template', 'logic//threshold-flag', 'es', 'docs_md', $t$# Marcar por umbral

Puntúa cada elemento y marca para revisión los que superan un umbral configurable.

## Precondiciones

- Los elementos que hay que puntuar están en `items`
- Hay configurados un campo numérico y un umbral

## Pasos

1. **Leer la métrica** — Extrae el campo numérico de cada elemento.
2. **Comparar** — Marca los elementos donde value >= threshold (o <= para límites inferiores).
3. **Recopilar** — Devuelve el subconjunto marcado y su recuento.

## Poscondiciones

- `flagged` enumera los elementos que superan el umbral
- `count` es el número de elementos marcados
$t$),
  ('block_template', 'logic//map-transform', 'es', 'label', $t$Asignar / transformar$t$),
  ('block_template', 'logic//map-transform', 'es', 'description', $t$Remodela cada fila a un esquema de destino mediante una asignación de campos, descartando o renombrando según la configuración.$t$),
  ('block_template', 'logic//map-transform', 'es', 'tags', $t$transformación
asignación
remodelado$t$),
  ('block_template', 'logic//map-transform', 'es', 'docs_md', $t$# Asignar / transformar

Remodela cada fila a un esquema de destino mediante una asignación de campos, descartando o renombrando según la configuración.

## Precondiciones

- Las filas de origen están en `rows`
- Hay configurada una asignación de campos (origen → destino)

## Pasos

1. **Leer la asignación** — La asignación es { targetField: sourceField }.
2. **Proyectar cada fila** — Construye un objeto nuevo por fila usando la asignación; omite los campos no asignados.
3. **Devolver** — Emite las filas transformadas en el orden original.

## Poscondiciones

- Cada fila de salida contiene solo los campos de destino asignados
- Se conserva el orden de las filas
$t$),
  ('block_template', 'logic//aggregate', 'es', 'label', $t$Agregar / agrupar$t$),
  ('block_template', 'logic//aggregate', 'es', 'description', $t$Agrupa las filas por una clave y calcula agregados (recuento / suma / media) por grupo.$t$),
  ('block_template', 'logic//aggregate', 'es', 'tags', $t$agregación
agrupación
resumen$t$),
  ('block_template', 'logic//aggregate', 'es', 'docs_md', $t$# Agregar / agrupar

Agrupa las filas por una clave y calcula agregados (recuento / suma / media) por grupo.

## Precondiciones

- Las filas están en `rows`
- Hay configuradas una clave de agrupación y las medidas que hay que agregar

## Pasos

1. **Repartir** — Agrupa las filas por el campo group_by configurado.
2. **Reducir** — Por grupo, calcula el recuento y la suma/media de cada campo de medida.
3. **Emitir** — Devuelve una fila por grupo con los agregados.

## Poscondiciones

- `groups` contiene una fila de resumen por cada clave distinta
- Cada resumen lleva los agregados solicitados
$t$),
  ('block_template', 'ui//form', 'es', 'label', $t$Formulario$t$),
  ('block_template', 'ui//form', 'es', 'description', $t$Recoge y valida la entrada del usuario frente a un esquema de campos y emite los valores capturados al enviar.$t$),
  ('block_template', 'ui//form', 'es', 'tags', $t$formulario
entrada
captura$t$),
  ('block_template', 'ui//form', 'es', 'docs_md', $t$# Formulario

Recoge y valida la entrada del usuario frente a un esquema de campos y emite los valores capturados al enviar.

## Precondiciones

- Se facilita un esquema de campos (etiquetas, tipos, obligatoriedad) en `schema`

## Pasos

1. **Renderizar los campos** — Construye los campos de entrada a partir del esquema (texto / número / desplegable / casilla).
2. **Validar** — Bloquea el envío hasta que los campos obligatorios estén presentes y los tipos sean válidos.
3. **Emitir** — Al enviar, devuelve los valores recogidos y submitted=true.

## Poscondiciones

- `values` contiene los campos capturados una vez enviado
- `submitted` solo pasa a true tras superar la validación en el cliente
$t$),
  ('block_template', 'ui//table', 'es', 'label', $t$Tabla / lista$t$),
  ('block_template', 'ui//table', 'es', 'description', $t$Muestra filas en una tabla ordenable y seleccionable a partir de una definición de columnas.$t$),
  ('block_template', 'ui//table', 'es', 'tags', $t$tabla
lista
cuadrícula$t$),
  ('block_template', 'ui//table', 'es', 'docs_md', $t$# Tabla / lista

Muestra filas en una tabla ordenable y seleccionable a partir de una definición de columnas.

## Precondiciones

- Las filas se facilitan en `rows`
- Se facilita una definición de columnas en `columns`

## Pasos

1. **Definir las columnas** — Asocia cada columna a un campo de fila + un encabezado + un formateador opcional.
2. **Renderizar las filas** — Muestra las filas; admite ordenación por columna y selección de filas.
3. **Emitir la selección** — Devuelve la fila o filas seleccionadas cuando el usuario hace clic.

## Poscondiciones

- `selected` refleja la fila o filas que elige el usuario
$t$),
  ('block_template', 'ui//chart', 'es', 'label', $t$Gráfico$t$),
  ('block_template', 'ui//chart', 'es', 'description', $t$Visualiza una o varias series como gráfico de líneas, de barras o circular.$t$),
  ('block_template', 'ui//chart', 'es', 'tags', $t$gráfico
visualización
informe$t$),
  ('block_template', 'ui//chart', 'es', 'docs_md', $t$# Gráfico

Visualiza una o varias series como gráfico de líneas, de barras o circular.

## Precondiciones

- Los datos de la serie se facilitan en `series`

## Pasos

1. **Elegir un tipo de gráfico** — líneas para tendencias, barras para comparaciones, circular para composición.
2. **Asignar los datos** — Asigna los puntos de la serie a los ejes / porciones.
3. **Dibujar** — Dibuja el gráfico con etiquetas de eje + leyenda.

## Poscondiciones

- El gráfico se dibuja según el `type` elegido
$t$),
  ('block_template', 'ui//kpi-card', 'es', 'label', $t$Tarjeta de KPI$t$),
  ('block_template', 'ui//kpi-card', 'es', 'description', $t$Muestra una única métrica destacada con una variación opcional respecto al periodo anterior.$t$),
  ('block_template', 'ui//kpi-card', 'es', 'tags', $t$kpi
métrica
panel$t$),
  ('block_template', 'ui//kpi-card', 'es', 'docs_md', $t$# Tarjeta de KPI

Muestra una única métrica destacada con una variación opcional respecto al periodo anterior.

## Precondiciones

- Se facilitan una etiqueta y un valor numérico

## Pasos

1. **Mostrar el valor** — Muestra la cifra destacada junto con la etiqueta.
2. **Mostrar la variación** — Si se indica una variación, muestra subida/bajada con signo + color.

## Poscondiciones

- Se muestran la métrica + la dirección de la variación
$t$),
  ('block_template', 'ui//detail-view', 'es', 'label', $t$Vista de detalle$t$),
  ('block_template', 'ui//detail-view', 'es', 'description', $t$Muestra un único registro como un panel de detalle de etiqueta/valor en solo lectura.$t$),
  ('block_template', 'ui//detail-view', 'es', 'tags', $t$detalle
registro
solo lectura$t$),
  ('block_template', 'ui//detail-view', 'es', 'docs_md', $t$# Vista de detalle

Muestra un único registro como un panel de detalle de etiqueta/valor en solo lectura.

## Precondiciones

- Se facilita un registro en `record`

## Pasos

1. **Elegir los campos** — Usa `fields` para elegir + ordenar qué claves se muestran (por defecto: todas).
2. **Mostrar** — Muestra cada una como fila de etiqueta/valor; formatea fechas + números.

## Poscondiciones

- Los campos seleccionados se muestran como filas de etiqueta/valor
$t$),
  ('block_template', 'ui//filter-bar', 'es', 'label', $t$Barra de filtros$t$),
  ('block_template', 'ui//filter-bar', 'es', 'description', $t$Muestra un conjunto de controles de filtro y emite la consulta resultante a medida que el usuario los cambia.$t$),
  ('block_template', 'ui//filter-bar', 'es', 'tags', $t$filtro
búsqueda
controles$t$),
  ('block_template', 'ui//filter-bar', 'es', 'docs_md', $t$# Barra de filtros

Muestra un conjunto de controles de filtro y emite la consulta resultante a medida que el usuario los cambia.

## Precondiciones

- Se facilita una definición de los campos de filtro en `fields`

## Pasos

1. **Renderizar los controles** — Construye un control por campo (texto / desplegable / rango de fechas).
2. **Recopilar** — Al cambiar, ensambla los filtros activos en un objeto de consulta.
3. **Emitir** — Devuelve la consulta para que un bloque de datos posterior pueda recargar.

## Poscondiciones

- `query` refleja las selecciones de filtro actuales
- `changed` se dispara cada vez que cambia un control
$t$),
  ('block_template', 'ai//extract-fields', 'de', 'label', $t$Felder extrahieren$t$),
  ('block_template', 'ai//extract-fields', 'de', 'description', $t$Extrahiert einen strukturierten Satz von Feldern aus Freitext mithilfe des verwalteten Sprachmodells (ctx.llm).$t$),
  ('block_template', 'ai//extract-fields', 'de', 'tags', $t$Extraktion
strukturiert
NLP$t$),
  ('block_template', 'ai//extract-fields', 'de', 'docs_md', $t$# Felder extrahieren

Extrahiert einen strukturierten Satz von Feldern aus Freitext mithilfe des verwalteten Sprachmodells (ctx.llm).

## Vorbedingungen

- Der Quelltext liegt auf `text` vor
- Ein Zielfeldschema liegt auf `schema` vor

## Schritte

1. **Prompt erstellen** — Weise das Modell an, AUSSCHLIESSLICH JSON gemäß dem Schema zurückzugeben; nenne jedes Feld + den Typ.
2. **Modell aufrufen** — Verwende ctx.llm() mit dem Text; fordere strikte JSON-Ausgabe an.
3. **Parsen + absichern** — Parse das JSON; erzwinge die Typen; setze alles Nichtgefundene auf null (niemals halluzinieren).

## Nachbedingungen

- `fields` ist ein Objekt mit den Schemafeldern als Schlüssel
- Fehlende Felder sind null statt erfunden
$t$),
  ('block_template', 'ai//classify', 'de', 'label', $t$Klassifizieren$t$),
  ('block_template', 'ai//classify', 'de', 'description', $t$Ordnet dem Eingabetext das am besten passende Label aus einer festen Menge zu, mit einem Konfidenzwert.$t$),
  ('block_template', 'ai//classify', 'de', 'tags', $t$Klassifikation
Kennzeichnung
NLP$t$),
  ('block_template', 'ai//classify', 'de', 'docs_md', $t$# Klassifizieren

Ordnet dem Eingabetext das am besten passende Label aus einer festen Menge zu, mit einem Konfidenzwert.

## Vorbedingungen

- Der Eingabetext liegt auf `text` vor
- Eine geschlossene Labelmenge liegt auf `labels` vor

## Schritte

1. **Auswahl einschränken** — Fordere das Modell auf, genau ein Label aus der vorgegebenen Menge zu wählen.
2. **Modell aufrufen** — Verwende ctx.llm(); fordere { label, confidence } als JSON an.
3. **Validieren** — Weise jedes Label außerhalb der Menge zurück; falle auf unknown mit niedriger Konfidenz zurück.

## Nachbedingungen

- `label` ist eines der vorgegebenen Labels (oder ein explizites `unknown`)
- `confidence` liegt zwischen 0 und 1
$t$),
  ('block_template', 'ai//summarize', 'de', 'label', $t$Zusammenfassen$t$),
  ('block_template', 'ai//summarize', 'de', 'description', $t$Erstellt eine Zusammenfassung des Eingabetexts mit gesteuerter Länge und Tonalität.$t$),
  ('block_template', 'ai//summarize', 'de', 'tags', $t$Zusammenfassung
NLP$t$),
  ('block_template', 'ai//summarize', 'de', 'docs_md', $t$# Zusammenfassen

Erstellt eine Zusammenfassung des Eingabetexts mit gesteuerter Länge und Tonalität.

## Vorbedingungen

- Der Eingabetext liegt auf `text` vor

## Schritte

1. **Vorgaben setzen** — Kodiere max_lines + Tonalität in der Systemanweisung.
2. **Modell aufrufen** — Verwende ctx.llm() mit dem Text und den Vorgaben.
3. **Kürzen** — Erzwinge das Zeilenlimit defensiv, nachdem das Modell geantwortet hat.

## Nachbedingungen

- `summary` hält die geforderte Maximallänge + Tonalität ein
$t$),
  ('block_template', 'ai//generate-draft', 'de', 'label', $t$Entwurf erstellen$t$),
  ('block_template', 'ai//generate-draft', 'de', 'description', $t$Erstellt aus einem kurzen Briefing einen Text in der gewählten Tonalität (E-Mail, Antwort, Beschreibung, …).$t$),
  ('block_template', 'ai//generate-draft', 'de', 'tags', $t$Generierung
Entwurf
NLP$t$),
  ('block_template', 'ai//generate-draft', 'de', 'docs_md', $t$# Entwurf erstellen

Erstellt aus einem kurzen Briefing einen Text in der gewählten Tonalität (E-Mail, Antwort, Beschreibung, …).

## Vorbedingungen

- Ein Briefing liegt auf `brief` vor

## Schritte

1. **Aufgabe rahmen** — Nenne dem Modell Zielgruppe, Zweck und Tonalität.
2. **Modell aufrufen** — Verwende ctx.llm() mit dem Briefing; halte es bearbeitbar, nicht endgültig.
3. **Zurückgeben** — Gib den Entwurfstext zurück, damit ein Mensch ihn prüfen + versenden kann.

## Nachbedingungen

- `draft` ist ein sofort bearbeitbarer erster Entwurf in der geforderten Tonalität
$t$),
  ('block_template', 'ai//route-by-intent', 'de', 'label', $t$Nach Absicht weiterleiten$t$),
  ('block_template', 'ai//route-by-intent', 'de', 'description', $t$Erkennt die Absicht des Nutzers in einer Nachricht und leitet an einen aus einer festen Menge von Handlern weiter.$t$),
  ('block_template', 'ai//route-by-intent', 'de', 'tags', $t$Absicht
Weiterleitung
NLP$t$),
  ('block_template', 'ai//route-by-intent', 'de', 'docs_md', $t$# Nach Absicht weiterleiten

Erkennt die Absicht des Nutzers in einer Nachricht und leitet an einen aus einer festen Menge von Handlern weiter.

## Vorbedingungen

- Eine Nachricht liegt auf `message` vor
- Eine Menge möglicher Absichten liegt auf `intents` vor

## Schritte

1. **Absichten beschreiben** — Gib dem Modell je eine einzeilige Beschreibung pro möglicher Absicht.
2. **Modell aufrufen** — Verwende ctx.llm(); fordere { intent, confidence } als JSON an.
3. **Absichern** — Leite unterhalb einer Konfidenzschwelle an fallback weiter, statt zu raten.

## Nachbedingungen

- `intent` ist eine der vorgegebenen Absichten (oder `fallback`)
- `confidence` liegt zwischen 0 und 1
$t$),
  ('block_template', 'ai//redact-pii', 'de', 'label', $t$Personenbezogene Daten schwärzen$t$),
  ('block_template', 'ai//redact-pii', 'de', 'description', $t$Erkennt personenbezogene Daten (Namen, E-Mail-Adressen, Telefonnummern, Kennnummern) in Freitext und maskiert sie.$t$),
  ('block_template', 'ai//redact-pii', 'de', 'tags', $t$Personendaten
Schwärzung
Datenschutz$t$),
  ('block_template', 'ai//redact-pii', 'de', 'docs_md', $t$# Personenbezogene Daten schwärzen

Erkennt personenbezogene Daten (Namen, E-Mail-Adressen, Telefonnummern, Kennnummern) in Freitext und maskiert sie.

## Vorbedingungen

- Der Eingabetext liegt auf `text` vor
- Die zu schwärzenden Arten personenbezogener Daten liegen auf `kinds` vor

## Schritte

1. **Arten festlegen** — Nenne dem Modell die zu suchenden Arten personenbezogener Daten (E-Mail, Telefon, Name, ID).
2. **Modell aufrufen** — Verwende ctx.llm(); fordere die zu maskierenden Textstellen an, nicht die Rohwerte zurück.
3. **Maskieren** — Ersetze jede Textstelle durch [REDACTED:<kind>]; zähle die Treffer in `found`.

## Nachbedingungen

- `redacted` ersetzt jede gefundene Textstelle durch einen typisierten Platzhalter
- `found` listet auf, was erkannt wurde (Art + Anzahl), niemals die Rohwerte
$t$),
  ('block_template', 'logic//validate-record', 'de', 'label', $t$Datensatz validieren$t$),
  ('block_template', 'logic//validate-record', 'de', 'description', $t$Prüft einen Datensatz gegen ein Feldregelwerk; gültige Datensätze passieren, bei ungültigen werden die Gründe gesammelt.$t$),
  ('block_template', 'logic//validate-record', 'de', 'tags', $t$Validierung
Absicherung
Datenqualität$t$),
  ('block_template', 'logic//validate-record', 'de', 'docs_md', $t$# Datensatz validieren

Prüft einen Datensatz gegen ein Feldregelwerk; gültige Datensätze passieren, bei ungültigen werden die Gründe gesammelt.

## Vorbedingungen

- Ein Datensatzobjekt liegt am Eingang `record` vor
- Ein Feldregelwerk (Pflicht / Typ / Wertebereich) ist definiert

## Schritte

1. **Regelwerk laden** — Lies die Regeln je Feld aus dem Eingang `rules` (Pflicht, Typ, Min/Max, Muster).
2. **Jedes Feld prüfen** — Lies zu jeder Regel record[field] und prüfe es; hänge bei einem Fehler eine Meldung an errors an.
3. **Entscheiden** — valid = errors.length === 0; gib beides zurück, damit nachgelagert verzweigt werden kann.

## Nachbedingungen

- `valid` ist nur dann true, wenn jede Regel erfüllt ist
- `errors` enthält pro fehlgeschlagener Regel einen lesbaren Grund
$t$),
  ('block_template', 'logic//route-by-rule', 'de', 'label', $t$Nach Regel weiterleiten (Entscheidungstabelle)$t$),
  ('block_template', 'logic//route-by-rule', 'de', 'description', $t$Wählt einen Zweig, indem eine geordnete Entscheidungstabelle auf die Eingabe angewendet wird — der erste Treffer gewinnt.$t$),
  ('block_template', 'logic//route-by-rule', 'de', 'tags', $t$Weiterleitung
Entscheidungstabelle
Verzweigung$t$),
  ('block_template', 'logic//route-by-rule', 'de', 'docs_md', $t$# Nach Regel weiterleiten (Entscheidungstabelle)

Wählt einen Zweig, indem eine geordnete Entscheidungstabelle auf die Eingabe angewendet wird — der erste Treffer gewinnt.

## Vorbedingungen

- Ein Eingabeobjekt liegt auf `item` vor
- Eine geordnete Liste von Regeln (Bedingung → Route) ist definiert

## Schritte

1. **Entscheidungstabelle lesen** — Jede Regel lautet { when: {field, op, value}, route }; werte von oben nach unten aus.
2. **Ersten Treffer finden** — Gib die Route der ersten Regel zurück, deren Bedingung für `item` gilt.
3. **Zurückfallen** — Passt keine Regel, gib die konfigurierte Standardroute zurück und matched=false.

## Nachbedingungen

- `route` ist das Label der ersten passenden Regel oder die Standardroute
- `matched` zeigt an, ob überhaupt eine Regel gegriffen hat
$t$),
  ('block_template', 'logic//approve-reject', 'de', 'label', $t$Genehmigen / ablehnen (Vier-Augen-Prinzip)$t$),
  ('block_template', 'logic//approve-reject', 'de', 'description', $t$Entscheidet über einen Vorgang anhand einer Richtlinie und einer ausdrücklichen menschlichen Entscheidung und hält fest, wer entschieden hat und warum.$t$),
  ('block_template', 'logic//approve-reject', 'de', 'tags', $t$Genehmigung
Vier-Augen-Prinzip
Governance$t$),
  ('block_template', 'logic//approve-reject', 'de', 'docs_md', $t$# Genehmigen / ablehnen (Vier-Augen-Prinzip)

Entscheidet über einen Vorgang anhand einer Richtlinie und einer ausdrücklichen menschlichen Entscheidung und hält fest, wer entschieden hat und warum.

## Vorbedingungen

- Der zu prüfende Vorgang liegt auf `item` vor
- Eine Entscheidung (`approve` | `reject`) und die Identität der prüfenden Person liegen vor

## Schritte

1. **Richtlinienprüfungen vorschalten** — Führe zuerst die automatischen Prüfungen aus; lehne alles, was die Richtlinie nicht besteht, unabhängig von der menschlichen Eingabe automatisch ab.
2. **Menschliche Entscheidung festhalten** — Erfasse Entscheidung, Prüfer und Grund für den Audit-Trail.
3. **Ergebnis ausgeben** — approved = policyPassed && decision === 'approve'; füge den Entscheidungsdatensatz bei.

## Nachbedingungen

- `approved` spiegelt die Entscheidung der prüfenden Person nach den Richtlinienprüfungen wider
- Ein Audit-Trail (Prüfer, Grund, Zeitstempel) ist angehängt
$t$),
  ('block_template', 'logic//dedupe', 'de', 'label', $t$Duplikate entfernen$t$),
  ('block_template', 'logic//dedupe', 'de', 'description', $t$Fasst Zeilen mit gleichem Schlüssel zusammen, behält eine ausgewählte Zeile und zählt die entfernten Duplikate.$t$),
  ('block_template', 'logic//dedupe', 'de', 'tags', $t$Duplikate
Bereinigung
Datenqualität$t$),
  ('block_template', 'logic//dedupe', 'de', 'docs_md', $t$# Duplikate entfernen

Fasst Zeilen mit gleichem Schlüssel zusammen, behält eine ausgewählte Zeile und zählt die entfernten Duplikate.

## Vorbedingungen

- Eine Liste von Zeilen liegt auf `rows` vor
- Ein Dublettenschlüssel (ein oder mehrere Felder) ist konfiguriert

## Schritte

1. **Schlüssel bilden** — Berechne je Zeile einen zusammengesetzten Schlüssel aus den konfigurierten Schlüsselfeldern.
2. **Verbleibende Zeile wählen** — Behalte je Schlüssel die erste Zeile (oder die neueste laut `tiebreak`); verwirf den Rest.
3. **Berichten** — Gib die bereinigten Zeilen und die Anzahl der entfernten zurück.

## Nachbedingungen

- `rows` enthält höchstens eine verbleibende Zeile je Schlüssel
- `removed` zählt, wie viele Duplikate entfernt wurden
$t$),
  ('block_template', 'logic//enrich-lookup', 'de', 'label', $t$Über Nachschlagetabelle anreichern$t$),
  ('block_template', 'logic//enrich-lookup', 'de', 'description', $t$Verknüpft jede Zeile über einen Schlüssel mit einer Referenztabelle und übernimmt die gefundenen Referenzfelder.$t$),
  ('block_template', 'logic//enrich-lookup', 'de', 'tags', $t$Anreicherung
Verknüpfung
Nachschlagen$t$),
  ('block_template', 'logic//enrich-lookup', 'de', 'docs_md', $t$# Über Nachschlagetabelle anreichern

Verknüpft jede Zeile über einen Schlüssel mit einer Referenztabelle und übernimmt die gefundenen Referenzfelder.

## Vorbedingungen

- Die anzureichernden Zeilen liegen auf `rows` vor
- Ein Referenzdatensatz bzw. eine Referenztabelle und der Verknüpfungsschlüssel sind vorhanden

## Schritte

1. **Referenz indizieren** — Baue eine Map vom Verknüpfungsschlüssel auf die Referenzzeile für Zugriffe in O(1).
2. **Zusammenführen** — Schlage je Eingabezeile über den Schlüssel nach und übernimm die Referenzfelder (bei Konflikten gewinnt die Eingabe).
3. **Fehltreffer erfassen** — Zähle die Zeilen ohne Treffer, damit die Qualität überwacht werden kann.

## Nachbedingungen

- Jede Zeile erhält bei einem Treffer die Referenzfelder hinzu
- `unmatched` zählt die Zeilen ohne Referenztreffer
$t$),
  ('block_template', 'logic//threshold-flag', 'de', 'label', $t$Nach Schwellenwert markieren$t$),
  ('block_template', 'logic//threshold-flag', 'de', 'description', $t$Bewertet jeden Eintrag und markiert diejenigen zur Prüfung, die einen konfigurierbaren Schwellenwert überschreiten.$t$),
  ('block_template', 'logic//threshold-flag', 'de', 'tags', $t$Bewertung
Markierung
Überwachung$t$),
  ('block_template', 'logic//threshold-flag', 'de', 'docs_md', $t$# Nach Schwellenwert markieren

Bewertet jeden Eintrag und markiert diejenigen zur Prüfung, die einen konfigurierbaren Schwellenwert überschreiten.

## Vorbedingungen

- Die zu bewertenden Einträge liegen auf `items` vor
- Ein numerisches Feld und ein Schwellenwert sind konfiguriert

## Schritte

1. **Kennzahl lesen** — Lies das numerische Feld aus jedem Eintrag.
2. **Vergleichen** — Markiere Einträge, bei denen value >= threshold gilt (oder <= bei Untergrenzen).
3. **Sammeln** — Gib die markierte Teilmenge und ihre Anzahl zurück.

## Nachbedingungen

- `flagged` listet die Einträge auf, die den Schwellenwert überschreiten
- `count` ist die Anzahl der markierten Einträge
$t$),
  ('block_template', 'logic//map-transform', 'de', 'label', $t$Zuordnen / transformieren$t$),
  ('block_template', 'logic//map-transform', 'de', 'description', $t$Formt jede Zeile über eine Feldzuordnung auf ein Zielschema um und verwirft oder benennt Felder wie konfiguriert.$t$),
  ('block_template', 'logic//map-transform', 'de', 'tags', $t$Transformation
Zuordnung
Umformung$t$),
  ('block_template', 'logic//map-transform', 'de', 'docs_md', $t$# Zuordnen / transformieren

Formt jede Zeile über eine Feldzuordnung auf ein Zielschema um und verwirft oder benennt Felder wie konfiguriert.

## Vorbedingungen

- Die Quellzeilen liegen auf `rows` vor
- Eine Feldzuordnung (Quelle → Ziel) ist konfiguriert

## Schritte

1. **Zuordnung lesen** — Die Zuordnung lautet { targetField: sourceField }.
2. **Jede Zeile projizieren** — Baue je Zeile ein neues Objekt anhand der Zuordnung; überspringe nicht zugeordnete Felder.
3. **Zurückgeben** — Gib die transformierten Zeilen in der ursprünglichen Reihenfolge aus.

## Nachbedingungen

- Jede Ausgabezeile enthält nur die zugeordneten Zielfelder
- Die Zeilenreihenfolge bleibt erhalten
$t$),
  ('block_template', 'logic//aggregate', 'de', 'label', $t$Aggregieren / gruppieren$t$),
  ('block_template', 'logic//aggregate', 'de', 'description', $t$Gruppiert Zeilen nach einem Schlüssel und berechnet je Gruppe Aggregate (Anzahl / Summe / Mittelwert).$t$),
  ('block_template', 'logic//aggregate', 'de', 'tags', $t$Aggregation
Gruppierung
Übersicht$t$),
  ('block_template', 'logic//aggregate', 'de', 'docs_md', $t$# Aggregieren / gruppieren

Gruppiert Zeilen nach einem Schlüssel und berechnet je Gruppe Aggregate (Anzahl / Summe / Mittelwert).

## Vorbedingungen

- Die Zeilen liegen auf `rows` vor
- Ein Gruppierungsschlüssel und die zu aggregierenden Kennzahlen sind konfiguriert

## Schritte

1. **Einteilen** — Gruppiere die Zeilen nach dem konfigurierten Feld group_by.
2. **Verdichten** — Berechne je Gruppe die Anzahl sowie Summe/Mittelwert jedes Kennzahlenfelds.
3. **Ausgeben** — Gib je Gruppe eine Zeile mit den Aggregaten zurück.

## Nachbedingungen

- `groups` enthält je eindeutigem Schlüssel eine Ergebniszeile
- Jede Ergebniszeile trägt die angeforderten Aggregate
$t$),
  ('block_template', 'ui//form', 'de', 'label', $t$Formular$t$),
  ('block_template', 'ui//form', 'de', 'description', $t$Erfasst und validiert Nutzereingaben gegen ein Feldschema und gibt die erfassten Werte beim Absenden aus.$t$),
  ('block_template', 'ui//form', 'de', 'tags', $t$Formular
Eingabe
Erfassung$t$),
  ('block_template', 'ui//form', 'de', 'docs_md', $t$# Formular

Erfasst und validiert Nutzereingaben gegen ein Feldschema und gibt die erfassten Werte beim Absenden aus.

## Vorbedingungen

- Ein Feldschema (Labels, Typen, Pflichtfelder) liegt auf `schema` vor

## Schritte

1. **Felder rendern** — Baue die Eingabefelder aus dem Schema (Text / Zahl / Auswahl / Kontrollkästchen).
2. **Validieren** — Sperre das Absenden, bis alle Pflichtfelder gefüllt und die Typen gültig sind.
3. **Ausgeben** — Gib beim Absenden die gesammelten Werte zurück sowie submitted=true.

## Nachbedingungen

- `values` enthält die erfassten Felder, sobald abgesendet wurde
- `submitted` wird erst true, wenn die clientseitige Validierung besteht
$t$),
  ('block_template', 'ui//table', 'de', 'label', $t$Tabelle / Liste$t$),
  ('block_template', 'ui//table', 'de', 'description', $t$Stellt Zeilen anhand einer Spaltendefinition in einer sortier- und auswählbaren Tabelle dar.$t$),
  ('block_template', 'ui//table', 'de', 'tags', $t$Tabelle
Liste
Raster$t$),
  ('block_template', 'ui//table', 'de', 'docs_md', $t$# Tabelle / Liste

Stellt Zeilen anhand einer Spaltendefinition in einer sortier- und auswählbaren Tabelle dar.

## Vorbedingungen

- Die Zeilen liegen auf `rows` vor
- Eine Spaltendefinition liegt auf `columns` vor

## Schritte

1. **Spalten definieren** — Ordne jeder Spalte ein Zeilenfeld + eine Überschrift + optional einen Formatierer zu.
2. **Zeilen rendern** — Stelle die Zeilen dar; unterstütze Sortierung nach Spalte und Zeilenauswahl.
3. **Auswahl ausgeben** — Gib die ausgewählte(n) Zeile(n) zurück, sobald der Nutzer klickt.

## Nachbedingungen

- `selected` spiegelt die vom Nutzer gewählte(n) Zeile(n) wider
$t$),
  ('block_template', 'ui//chart', 'de', 'label', $t$Diagramm$t$),
  ('block_template', 'ui//chart', 'de', 'description', $t$Visualisiert eine oder mehrere Datenreihen als Linien-, Balken- oder Kreisdiagramm.$t$),
  ('block_template', 'ui//chart', 'de', 'tags', $t$Diagramm
Visualisierung
Bericht$t$),
  ('block_template', 'ui//chart', 'de', 'docs_md', $t$# Diagramm

Visualisiert eine oder mehrere Datenreihen als Linien-, Balken- oder Kreisdiagramm.

## Vorbedingungen

- Die Reihendaten liegen auf `series` vor

## Schritte

1. **Diagrammtyp wählen** — Linie für Trends, Balken für Vergleiche, Kreis für Anteile.
2. **Daten zuordnen** — Ordne die Punkte der Datenreihe den Achsen / Segmenten zu.
3. **Zeichnen** — Zeichne das Diagramm mit Achsenbeschriftungen + Legende.

## Nachbedingungen

- Das Diagramm wird für den gewählten `type` gezeichnet
$t$),
  ('block_template', 'ui//kpi-card', 'de', 'label', $t$KPI-Karte$t$),
  ('block_template', 'ui//kpi-card', 'de', 'description', $t$Zeigt eine einzelne Kennzahl mit optionaler Veränderung gegenüber einer Vorperiode.$t$),
  ('block_template', 'ui//kpi-card', 'de', 'tags', $t$KPI
Kennzahl
Dashboard$t$),
  ('block_template', 'ui//kpi-card', 'de', 'docs_md', $t$# KPI-Karte

Zeigt eine einzelne Kennzahl mit optionaler Veränderung gegenüber einer Vorperiode.

## Vorbedingungen

- Ein Label und ein numerischer Wert liegen vor

## Schritte

1. **Wert anzeigen** — Stelle die Kennzahl zusammen mit dem Label dar.
2. **Veränderung anzeigen** — Ist eine Veränderung angegeben, zeige auf/ab mit Vorzeichen + Farbe.

## Nachbedingungen

- Die Kennzahl + die Richtung der Veränderung werden dargestellt
$t$),
  ('block_template', 'ui//detail-view', 'de', 'label', $t$Detailansicht$t$),
  ('block_template', 'ui//detail-view', 'de', 'description', $t$Stellt einen einzelnen Datensatz als schreibgeschütztes Detailfeld mit Label/Wert-Zeilen dar.$t$),
  ('block_template', 'ui//detail-view', 'de', 'tags', $t$Detail
Datensatz
schreibgeschützt$t$),
  ('block_template', 'ui//detail-view', 'de', 'docs_md', $t$# Detailansicht

Stellt einen einzelnen Datensatz als schreibgeschütztes Detailfeld mit Label/Wert-Zeilen dar.

## Vorbedingungen

- Ein Datensatz liegt auf `record` vor

## Schritte

1. **Felder wählen** — Nutze `fields`, um zu wählen + zu ordnen, welche Schlüssel angezeigt werden (Standard: alle).
2. **Darstellen** — Stelle jedes als Label/Wert-Zeile dar; formatiere Datumsangaben + Zahlen.

## Nachbedingungen

- Die gewählten Felder werden als Label/Wert-Zeilen dargestellt
$t$),
  ('block_template', 'ui//filter-bar', 'de', 'label', $t$Filterleiste$t$),
  ('block_template', 'ui//filter-bar', 'de', 'description', $t$Stellt eine Reihe von Filtern dar und gibt die daraus entstehende Abfrage aus, sobald der Nutzer sie ändert.$t$),
  ('block_template', 'ui//filter-bar', 'de', 'tags', $t$Filter
Suche
Bedienelemente$t$),
  ('block_template', 'ui//filter-bar', 'de', 'docs_md', $t$# Filterleiste

Stellt eine Reihe von Filtern dar und gibt die daraus entstehende Abfrage aus, sobald der Nutzer sie ändert.

## Vorbedingungen

- Eine Definition der Filterfelder liegt auf `fields` vor

## Schritte

1. **Bedienelemente rendern** — Baue je Feld ein Bedienelement (Text / Auswahl / Datumsbereich).
2. **Sammeln** — Setze bei jeder Änderung die aktiven Filter zu einem Abfrageobjekt zusammen.
3. **Ausgeben** — Gib die Abfrage zurück, damit ein nachgelagerter Datenblock neu laden kann.

## Nachbedingungen

- `query` spiegelt die aktuellen Filterauswahlen wider
- `changed` löst aus, sobald sich ein Bedienelement ändert
$t$),
  ('block_template', 'ai//extract-fields', 'ar', 'label', $t$استخراج الحقول$t$),
  ('block_template', 'ai//extract-fields', 'ar', 'description', $t$يستخرج مجموعة منظَّمة من الحقول من نص حر باستخدام نموذج اللغة المُدار (ctx.llm).$t$),
  ('block_template', 'ai//extract-fields', 'ar', 'tags', $t$استخراج
منظَّم
معالجة اللغة الطبيعية$t$),
  ('block_template', 'ai//extract-fields', 'ar', 'docs_md', $t$# استخراج الحقول

يستخرج مجموعة منظَّمة من الحقول من نص حر باستخدام نموذج اللغة المُدار (ctx.llm).

## الشروط المسبقة

- النص المصدر متاح في `text`
- مخطط الحقول المستهدفة متاح في `schema`

## الخطوات

1. **بناء الموجّه** — اطلب من النموذج إعادة JSON فقط مطابقًا للمخطط؛ واذكر كل حقل + نوعه.
2. **استدعاء النموذج** — استخدم ctx.llm() مع النص؛ واطلب مخرجات JSON صارمة.
3. **التحليل + الحماية** — حلّل JSON؛ وافرض الأنواع؛ واجعل كل ما لم يُعثر عليه null (لا تختلق أبدًا).

## الشروط اللاحقة

- `fields` كائن مفاتيحه هي حقول المخطط
- الحقول المفقودة تكون null بدلاً من اختلاقها
$t$),
  ('block_template', 'ai//classify', 'ar', 'label', $t$التصنيف$t$),
  ('block_template', 'ai//classify', 'ar', 'description', $t$يُسنِد إلى نص الإدخال أنسب تسمية من مجموعة ثابتة، مع درجة ثقة.$t$),
  ('block_template', 'ai//classify', 'ar', 'tags', $t$تصنيف
وسم
معالجة اللغة الطبيعية$t$),
  ('block_template', 'ai//classify', 'ar', 'docs_md', $t$# التصنيف

يُسنِد إلى نص الإدخال أنسب تسمية من مجموعة ثابتة، مع درجة ثقة.

## الشروط المسبقة

- نص الإدخال في `text`
- مجموعة مغلقة من التسميات في `labels`

## الخطوات

1. **تقييد الخيارات** — اطلب من النموذج اختيار تسمية واحدة بالضبط من المجموعة المتاحة.
2. **استدعاء النموذج** — استخدم ctx.llm()؛ واطلب { label, confidence } بصيغة JSON.
3. **التحقق** — ارفض أي تسمية خارج المجموعة؛ وارجع إلى unknown بثقة منخفضة.

## الشروط اللاحقة

- `label` إحدى التسميات المتاحة (أو `unknown` صريحة)
- `confidence` قيمة بين 0 و1
$t$),
  ('block_template', 'ai//summarize', 'ar', 'label', $t$التلخيص$t$),
  ('block_template', 'ai//summarize', 'ar', 'description', $t$ينتج ملخصًا لنص الإدخال بطول ونبرة محكومَين.$t$),
  ('block_template', 'ai//summarize', 'ar', 'tags', $t$تلخيص
معالجة اللغة الطبيعية$t$),
  ('block_template', 'ai//summarize', 'ar', 'docs_md', $t$# التلخيص

ينتج ملخصًا لنص الإدخال بطول ونبرة محكومَين.

## الشروط المسبقة

- نص الإدخال في `text`

## الخطوات

1. **ضبط القيود** — ضمّن max_lines + النبرة في تعليمات النظام.
2. **استدعاء النموذج** — استخدم ctx.llm() مع النص والقيود.
3. **الاقتطاع** — افرض حد الأسطر احترازيًا بعد رد النموذج.

## الشروط اللاحقة

- `summary` يلتزم بالحد الأقصى للطول + النبرة المطلوبين
$t$),
  ('block_template', 'ai//generate-draft', 'ar', 'label', $t$إنشاء مسودة$t$),
  ('block_template', 'ai//generate-draft', 'ar', 'description', $t$يصوغ محتوى انطلاقًا من موجز قصير بالنبرة المختارة (بريد إلكتروني، رد، وصف، …).$t$),
  ('block_template', 'ai//generate-draft', 'ar', 'tags', $t$توليد
صياغة
معالجة اللغة الطبيعية$t$),
  ('block_template', 'ai//generate-draft', 'ar', 'docs_md', $t$# إنشاء مسودة

يصوغ محتوى انطلاقًا من موجز قصير بالنبرة المختارة (بريد إلكتروني، رد، وصف، …).

## الشروط المسبقة

- الموجز متاح في `brief`

## الخطوات

1. **تأطير المهمة** — عرّف النموذج بالجمهور والغرض والنبرة.
2. **استدعاء النموذج** — استخدم ctx.llm() مع الموجز؛ وأبقِ النص قابلًا للتحرير لا نهائيًا.
3. **الإرجاع** — أعد نص المسودة ليراجعها إنسان + يرسلها.

## الشروط اللاحقة

- `draft` مسودة أولى جاهزة للتحرير بالنبرة المطلوبة
$t$),
  ('block_template', 'ai//route-by-intent', 'ar', 'label', $t$التوجيه حسب النية$t$),
  ('block_template', 'ai//route-by-intent', 'ar', 'description', $t$يتعرّف على نية المستخدم في رسالة ويوجّهها إلى أحد المعالجات ضمن مجموعة ثابتة.$t$),
  ('block_template', 'ai//route-by-intent', 'ar', 'tags', $t$نية
توجيه
معالجة اللغة الطبيعية$t$),
  ('block_template', 'ai//route-by-intent', 'ar', 'docs_md', $t$# التوجيه حسب النية

يتعرّف على نية المستخدم في رسالة ويوجّهها إلى أحد المعالجات ضمن مجموعة ثابتة.

## الشروط المسبقة

- الرسالة في `message`
- مجموعة النوايا المرشحة في `intents`

## الخطوات

1. **وصف النوايا** — زوّد النموذج بوصف من سطر واحد لكل نية مرشحة.
2. **استدعاء النموذج** — استخدم ctx.llm()؛ واطلب { intent, confidence } بصيغة JSON.
3. **ضبط العتبة** — دون عتبة ثقة معينة، وجّه إلى fallback بدلًا من التخمين.

## الشروط اللاحقة

- `intent` إحدى النوايا المرشحة (أو `fallback`)
- `confidence` قيمة بين 0 و1
$t$),
  ('block_template', 'ai//redact-pii', 'ar', 'label', $t$إخفاء البيانات الشخصية$t$),
  ('block_template', 'ai//redact-pii', 'ar', 'description', $t$يكتشف البيانات الشخصية (الأسماء، وعناوين البريد الإلكتروني، وأرقام الهواتف، والمعرّفات) في النص الحر ويخفيها.$t$),
  ('block_template', 'ai//redact-pii', 'ar', 'tags', $t$بيانات شخصية
إخفاء
خصوصية$t$),
  ('block_template', 'ai//redact-pii', 'ar', 'docs_md', $t$# إخفاء البيانات الشخصية

يكتشف البيانات الشخصية (الأسماء، وعناوين البريد الإلكتروني، وأرقام الهواتف، والمعرّفات) في النص الحر ويخفيها.

## الشروط المسبقة

- نص الإدخال في `text`
- أنواع البيانات الشخصية المراد إخفاؤها في `kinds`

## الخطوات

1. **تحديد الأنواع** — حدّد للنموذج أنواع البيانات الشخصية المطلوب البحث عنها (بريد إلكتروني، هاتف، اسم، معرّف).
2. **استدعاء النموذج** — استخدم ctx.llm()؛ واطلب المقاطع المراد إخفاؤها لا القيم الأصلية.
3. **الإخفاء** — استبدل كل مقطع بـ [REDACTED:<kind>]؛ واحسب الأعداد في `found`.

## الشروط اللاحقة

- `redacted` يستبدل كل مقطع مكتشف بعنصر نائب محدد النوع
- `found` يسرد ما تم اكتشافه (النوع + العدد)، ولا يسرد القيم الأصلية أبدًا
$t$),
  ('block_template', 'logic//validate-record', 'ar', 'label', $t$التحقق من السجل$t$),
  ('block_template', 'logic//validate-record', 'ar', 'description', $t$يفحص سجلًا وفق مجموعة قواعد للحقول؛ يمرّر السجلات الصالحة ويجمع أسباب الإخفاق لغير الصالحة.$t$),
  ('block_template', 'logic//validate-record', 'ar', 'tags', $t$تحقق
حماية
جودة البيانات$t$),
  ('block_template', 'logic//validate-record', 'ar', 'docs_md', $t$# التحقق من السجل

يفحص سجلًا وفق مجموعة قواعد للحقول؛ يمرّر السجلات الصالحة ويجمع أسباب الإخفاق لغير الصالحة.

## الشروط المسبقة

- كائن السجل متاح في المُدخل `record`
- مجموعة قواعد للحقول (إلزامي / نوع / نطاق) معرّفة

## الخطوات

1. **تحميل مجموعة القواعد** — اقرأ قواعد كل حقل من المُدخل `rules` (إلزامي، نوع، حد أدنى/أقصى، نمط).
2. **فحص كل حقل** — لكل قاعدة، اقرأ record[field] واختبره؛ وأضف رسالة إلى errors عند الإخفاق.
3. **اتخاذ القرار** — valid = errors.length === 0؛ وأعد الاثنين معًا ليتمكن ما بعده من التفرّع.

## الشروط اللاحقة

- `valid` تكون true فقط عند اجتياز كل قاعدة
- `errors` تسرد سببًا مقروءًا لكل قاعدة أخفقت
$t$),
  ('block_template', 'logic//route-by-rule', 'ar', 'label', $t$التوجيه حسب القاعدة (جدول قرار)$t$),
  ('block_template', 'logic//route-by-rule', 'ar', 'description', $t$يختار مسارًا بتقييم جدول قرار مرتّب على المدخل — أول تطابق هو الفائز.$t$),
  ('block_template', 'logic//route-by-rule', 'ar', 'tags', $t$توجيه
جدول قرار
تفرّع$t$),
  ('block_template', 'logic//route-by-rule', 'ar', 'docs_md', $t$# التوجيه حسب القاعدة (جدول قرار)

يختار مسارًا بتقييم جدول قرار مرتّب على المدخل — أول تطابق هو الفائز.

## الشروط المسبقة

- كائن الإدخال متاح في `item`
- قائمة مرتّبة من القواعد (شرط → مسار) معرّفة

## الخطوات

1. **قراءة جدول القرار** — كل قاعدة بالشكل { when: {field, op, value}, route }؛ قيّمها من الأعلى إلى الأسفل.
2. **إيجاد أول تطابق** — أعد مسار أول قاعدة يتحقق شرطها على `item`.
3. **الرجوع إلى الافتراضي** — إذا لم تطابق أي قاعدة، فأعد المسار الافتراضي المهيأ مع matched=false.

## الشروط اللاحقة

- `route` هو تسمية أول قاعدة مطابقة، أو المسار الافتراضي
- `matched` يبيّن ما إذا كانت أي قاعدة قد تحققت
$t$),
  ('block_template', 'logic//approve-reject', 'ar', 'label', $t$الموافقة / الرفض (مبدأ المراجعة المزدوجة)$t$),
  ('block_template', 'logic//approve-reject', 'ar', 'description', $t$يُخضِع العنصر لسياسة داخلية ولقرار بشري صريح، مع تسجيل من اتخذ القرار ولماذا.$t$),
  ('block_template', 'logic//approve-reject', 'ar', 'tags', $t$موافقة
مراجعة مزدوجة
حوكمة$t$),
  ('block_template', 'logic//approve-reject', 'ar', 'docs_md', $t$# الموافقة / الرفض (مبدأ المراجعة المزدوجة)

يُخضِع العنصر لسياسة داخلية ولقرار بشري صريح، مع تسجيل من اتخذ القرار ولماذا.

## الشروط المسبقة

- العنصر قيد المراجعة في `item`
- يُقدَّم قرار (`approve` | `reject`) وهوية المراجِع

## الخطوات

1. **تطبيق فحوص السياسة المسبقة** — شغّل الضوابط الآلية أولًا؛ وارفض تلقائيًا كل ما يخالف السياسة بغض النظر عن المدخل البشري.
2. **تسجيل القرار البشري** — سجّل القرار والمراجِع والسبب في مسار التدقيق.
3. **إصدار النتيجة** — approved = policyPassed && decision === 'approve'؛ وأدرج سجل القرار.

## الشروط اللاحقة

- `approved` يعكس قرار المراجِع بعد فحوص السياسة
- يُرفق مسار تدقيق (المراجِع، السبب، الطابع الزمني)
$t$),
  ('block_template', 'logic//dedupe', 'ar', 'label', $t$إزالة الصفوف المكررة$t$),
  ('block_template', 'logic//dedupe', 'ar', 'description', $t$يدمج الصفوف التي تتشارك المفتاح نفسه، مع الإبقاء على صف واحد مختار وإحصاء المكررات المحذوفة.$t$),
  ('block_template', 'logic//dedupe', 'ar', 'tags', $t$إزالة التكرار
تنظيف
جودة البيانات$t$),
  ('block_template', 'logic//dedupe', 'ar', 'docs_md', $t$# إزالة الصفوف المكررة

يدمج الصفوف التي تتشارك المفتاح نفسه، مع الإبقاء على صف واحد مختار وإحصاء المكررات المحذوفة.

## الشروط المسبقة

- قائمة الصفوف متاحة في `rows`
- مفتاح إزالة التكرار (حقل واحد أو أكثر) مهيأ

## الخطوات

1. **بناء المفتاح** — احسب لكل صف مفتاحًا مركبًا من حقول المفتاح المهيأة.
2. **اختيار الصف الباقي** — لكل مفتاح احتفظ بالصف الأول (أو الأحدث وفق `tiebreak`)؛ واحذف الباقي.
3. **الإبلاغ** — أعد الصفوف بعد إزالة التكرار وعدد المحذوف.

## الشروط اللاحقة

- `rows` يحتوي على صف باقٍ واحد على الأكثر لكل مفتاح
- `removed` يحصي عدد المكررات التي حُذفت
$t$),
  ('block_template', 'logic//enrich-lookup', 'ar', 'label', $t$الإثراء عبر جدول مرجعي$t$),
  ('block_template', 'logic//enrich-lookup', 'ar', 'description', $t$يربط كل صف بجدول مرجعي عبر مفتاح، ويدمج فيه حقول المرجع المطابقة.$t$),
  ('block_template', 'logic//enrich-lookup', 'ar', 'tags', $t$إثراء
ربط
بحث مرجعي$t$),
  ('block_template', 'logic//enrich-lookup', 'ar', 'docs_md', $t$# الإثراء عبر جدول مرجعي

يربط كل صف بجدول مرجعي عبر مفتاح، ويدمج فيه حقول المرجع المطابقة.

## الشروط المسبقة

- الصفوف المراد إثراؤها في `rows`
- مجموعة بيانات أو جدول مرجعي ومفتاح الربط متاحان

## الخطوات

1. **فهرسة المرجع** — ابنِ خريطة من مفتاح الربط إلى صف المرجع للبحث بزمن O(1).
2. **الدمج** — لكل صف إدخال، ابحث بالمفتاح وأدرج حقول المرجع (الإدخال يفوز عند التعارض).
3. **تتبّع الإخفاقات** — أحصِ الصفوف بلا تطابق حتى يمكن مراقبة الجودة.

## الشروط اللاحقة

- يكتسب كل صف حقول المرجع عند العثور على تطابق
- `unmatched` يحصي الصفوف التي لا تطابق المرجع
$t$),
  ('block_template', 'logic//threshold-flag', 'ar', 'label', $t$التمييز عند تجاوز عتبة$t$),
  ('block_template', 'logic//threshold-flag', 'ar', 'description', $t$يمنح كل عنصر درجة ويميّز للمراجعة ما يتجاوز عتبة قابلة للتهيئة.$t$),
  ('block_template', 'logic//threshold-flag', 'ar', 'tags', $t$تسجيل درجات
تمييز
مراقبة$t$),
  ('block_template', 'logic//threshold-flag', 'ar', 'docs_md', $t$# التمييز عند تجاوز عتبة

يمنح كل عنصر درجة ويميّز للمراجعة ما يتجاوز عتبة قابلة للتهيئة.

## الشروط المسبقة

- العناصر المراد تقييمها في `items`
- حقل رقمي وعتبة مهيآن

## الخطوات

1. **قراءة المقياس** — استخرج الحقل الرقمي من كل عنصر.
2. **المقارنة** — ميّز العناصر التي يتحقق فيها value >= threshold (أو <= للحدود الدنيا).
3. **التجميع** — أعد المجموعة الفرعية المميّزة وعددها.

## الشروط اللاحقة

- `flagged` يسرد العناصر التي تتجاوز العتبة
- `count` هو عدد العناصر المميّزة
$t$),
  ('block_template', 'logic//map-transform', 'ar', 'label', $t$التعيين / التحويل$t$),
  ('block_template', 'logic//map-transform', 'ar', 'description', $t$يعيد تشكيل كل صف إلى مخطط مستهدف عبر تعيين للحقول، مع إسقاط الحقول أو إعادة تسميتها حسب التهيئة.$t$),
  ('block_template', 'logic//map-transform', 'ar', 'tags', $t$تحويل
تعيين
إعادة تشكيل$t$),
  ('block_template', 'logic//map-transform', 'ar', 'docs_md', $t$# التعيين / التحويل

يعيد تشكيل كل صف إلى مخطط مستهدف عبر تعيين للحقول، مع إسقاط الحقول أو إعادة تسميتها حسب التهيئة.

## الشروط المسبقة

- الصفوف المصدر في `rows`
- تعيين للحقول (مصدر → هدف) مهيأ

## الخطوات

1. **قراءة التعيين** — التعيين بالشكل { targetField: sourceField }.
2. **إسقاط كل صف** — ابنِ كائنًا جديدًا لكل صف باستخدام التعيين؛ وتجاوز الحقول غير المعيَّنة.
3. **الإرجاع** — أصدر الصفوف المحوَّلة بالترتيب الأصلي.

## الشروط اللاحقة

- كل صف مخرَج يحتوي على الحقول المستهدفة المعيَّنة فقط
- ترتيب الصفوف محفوظ
$t$),
  ('block_template', 'logic//aggregate', 'ar', 'label', $t$التجميع / التقسيم حسب مفتاح$t$),
  ('block_template', 'logic//aggregate', 'ar', 'description', $t$يجمّع الصفوف حسب مفتاح ويحسب لكل مجموعة قيمًا مجمّعة (عدد / مجموع / متوسط).$t$),
  ('block_template', 'logic//aggregate', 'ar', 'tags', $t$تجميع
تقسيم حسب مفتاح
ملخّص$t$),
  ('block_template', 'logic//aggregate', 'ar', 'docs_md', $t$# التجميع / التقسيم حسب مفتاح

يجمّع الصفوف حسب مفتاح ويحسب لكل مجموعة قيمًا مجمّعة (عدد / مجموع / متوسط).

## الشروط المسبقة

- الصفوف في `rows`
- مفتاح التجميع والمقاييس المراد تجميعها مهيأة

## الخطوات

1. **التقسيم** — جمّع الصفوف حسب الحقل group_by المهيأ.
2. **الاختزال** — لكل مجموعة احسب العدد ومجموع/متوسط كل حقل مقياس.
3. **الإصدار** — أعد صفًا واحدًا لكل مجموعة مع القيم المجمّعة.

## الشروط اللاحقة

- `groups` يضم صف ملخص واحدًا لكل مفتاح مميز
- كل ملخص يحمل القيم المجمّعة المطلوبة
$t$),
  ('block_template', 'ui//form', 'ar', 'label', $t$نموذج$t$),
  ('block_template', 'ui//form', 'ar', 'description', $t$يجمع مدخلات المستخدم ويتحقق منها وفق مخطط حقول، ثم يصدر القيم الملتقطة عند الإرسال.$t$),
  ('block_template', 'ui//form', 'ar', 'tags', $t$نموذج
إدخال
التقاط$t$),
  ('block_template', 'ui//form', 'ar', 'docs_md', $t$# نموذج

يجمع مدخلات المستخدم ويتحقق منها وفق مخطط حقول، ثم يصدر القيم الملتقطة عند الإرسال.

## الشروط المسبقة

- مخطط حقول (تسميات، أنواع، إلزامية) متاح في `schema`

## الخطوات

1. **عرض الحقول** — ابنِ حقول الإدخال من المخطط (نص / رقم / قائمة منسدلة / مربع اختيار).
2. **التحقق** — امنع الإرسال حتى تُملأ الحقول الإلزامية وتصح الأنواع.
3. **الإصدار** — عند الإرسال، أعد القيم المجمّعة مع submitted=true.

## الشروط اللاحقة

- `values` يحتوي على الحقول الملتقطة بعد الإرسال
- `submitted` لا يصبح true إلا بعد نجاح التحقق في المتصفح
$t$),
  ('block_template', 'ui//table', 'ar', 'label', $t$جدول / قائمة$t$),
  ('block_template', 'ui//table', 'ar', 'description', $t$يعرض الصفوف في جدول قابل للفرز والتحديد انطلاقًا من تعريف الأعمدة.$t$),
  ('block_template', 'ui//table', 'ar', 'tags', $t$جدول
قائمة
شبكة$t$),
  ('block_template', 'ui//table', 'ar', 'docs_md', $t$# جدول / قائمة

يعرض الصفوف في جدول قابل للفرز والتحديد انطلاقًا من تعريف الأعمدة.

## الشروط المسبقة

- الصفوف متاحة في `rows`
- تعريف الأعمدة متاح في `columns`

## الخطوات

1. **تعريف الأعمدة** — اربط كل عمود بحقل في الصف + عنوان + منسّق اختياري.
2. **عرض الصفوف** — اعرض الصفوف؛ وادعم الفرز حسب العمود وتحديد الصفوف.
3. **إصدار التحديد** — أعد الصف أو الصفوف المحددة عند نقر المستخدم.

## الشروط اللاحقة

- `selected` يعكس الصف أو الصفوف التي يختارها المستخدم
$t$),
  ('block_template', 'ui//chart', 'ar', 'label', $t$رسم بياني$t$),
  ('block_template', 'ui//chart', 'ar', 'description', $t$يعرض سلسلة واحدة أو أكثر كرسم خطي أو شريطي أو دائري.$t$),
  ('block_template', 'ui//chart', 'ar', 'tags', $t$رسم بياني
تصور مرئي
تقرير$t$),
  ('block_template', 'ui//chart', 'ar', 'docs_md', $t$# رسم بياني

يعرض سلسلة واحدة أو أكثر كرسم خطي أو شريطي أو دائري.

## الشروط المسبقة

- بيانات السلسلة متاحة في `series`

## الخطوات

1. **اختيار نوع الرسم** — خطي للاتجاهات، شريطي للمقارنات، دائري للتركيب.
2. **ربط البيانات** — اربط نقاط السلسلة بالمحاور / القطاعات.
3. **الرسم** — ارسم المخطط مع تسميات المحاور + مفتاح توضيحي.

## الشروط اللاحقة

- يُرسم الرسم البياني وفق `type` المختار
$t$),
  ('block_template', 'ui//kpi-card', 'ar', 'label', $t$بطاقة مؤشر أداء$t$),
  ('block_template', 'ui//kpi-card', 'ar', 'description', $t$يعرض مقياسًا رئيسيًا واحدًا مع فارق اختياري مقارنة بفترة سابقة.$t$),
  ('block_template', 'ui//kpi-card', 'ar', 'tags', $t$مؤشر أداء
مقياس
لوحة معلومات$t$),
  ('block_template', 'ui//kpi-card', 'ar', 'docs_md', $t$# بطاقة مؤشر أداء

يعرض مقياسًا رئيسيًا واحدًا مع فارق اختياري مقارنة بفترة سابقة.

## الشروط المسبقة

- تُقدَّم تسمية وقيمة رقمية

## الخطوات

1. **عرض القيمة** — اعرض الرقم الرئيسي مع تسميته.
2. **عرض الفارق** — إذا أُعطي فارق، فأظهر ارتفاعًا/انخفاضًا مع الإشارة + اللون.

## الشروط اللاحقة

- يظهر المقياس + اتجاه الفارق
$t$),
  ('block_template', 'ui//detail-view', 'ar', 'label', $t$عرض التفاصيل$t$),
  ('block_template', 'ui//detail-view', 'ar', 'description', $t$يعرض سجلًا واحدًا في لوحة تفاصيل للقراءة فقط بصيغة تسمية/قيمة.$t$),
  ('block_template', 'ui//detail-view', 'ar', 'tags', $t$تفاصيل
سجل
للقراءة فقط$t$),
  ('block_template', 'ui//detail-view', 'ar', 'docs_md', $t$# عرض التفاصيل

يعرض سجلًا واحدًا في لوحة تفاصيل للقراءة فقط بصيغة تسمية/قيمة.

## الشروط المسبقة

- السجل متاح في `record`

## الخطوات

1. **اختيار الحقول** — استخدم `fields` لاختيار + ترتيب المفاتيح المعروضة (الافتراضي: الكل).
2. **العرض** — اعرض كل حقل كصف تسمية/قيمة؛ ونسّق التواريخ + الأرقام.

## الشروط اللاحقة

- تظهر الحقول المختارة كصفوف تسمية/قيمة
$t$),
  ('block_template', 'ui//filter-bar', 'ar', 'label', $t$شريط التصفية$t$),
  ('block_template', 'ui//filter-bar', 'ar', 'description', $t$يعرض مجموعة من عناصر تحكم التصفية ويصدر الاستعلام الناتج كلما غيّرها المستخدم.$t$),
  ('block_template', 'ui//filter-bar', 'ar', 'tags', $t$تصفية
بحث
عناصر تحكم$t$),
  ('block_template', 'ui//filter-bar', 'ar', 'docs_md', $t$# شريط التصفية

يعرض مجموعة من عناصر تحكم التصفية ويصدر الاستعلام الناتج كلما غيّرها المستخدم.

## الشروط المسبقة

- تعريف حقول التصفية متاح في `fields`

## الخطوات

1. **عرض عناصر التحكم** — ابنِ عنصر تحكم لكل حقل (نص / قائمة منسدلة / نطاق تواريخ).
2. **التجميع** — عند كل تغيير، اجمع عوامل التصفية النشطة في كائن استعلام.
3. **الإصدار** — أعد الاستعلام لتتمكن كتلة بيانات لاحقة من إعادة الجلب.

## الشروط اللاحقة

- `query` يعكس اختيارات التصفية الحالية
- `changed` يُطلَق كلما تغيّر عنصر تحكم
$t$),
  ('block_template', 'ai//extract-fields', 'he', 'label', $t$חילוץ שדות$t$),
  ('block_template', 'ai//extract-fields', 'he', 'description', $t$מחלץ אוסף שדות מובנה מתוך טקסט חופשי באמצעות מודל השפה המנוהל (ctx.llm).$t$),
  ('block_template', 'ai//extract-fields', 'he', 'tags', $t$חילוץ
מובנה
עיבוד שפה טבעית$t$),
  ('block_template', 'ai//extract-fields', 'he', 'docs_md', $t$# חילוץ שדות

מחלץ אוסף שדות מובנה מתוך טקסט חופשי באמצעות מודל השפה המנוהל (ctx.llm).

## תנאים מקדימים

- טקסט המקור מסופק ב-`text`
- סכמת שדות היעד מסופקת ב-`schema`

## צעדים

1. **בניית ההנחיה** — הנחה את המודל להחזיר JSON בלבד התואם לסכמה; פרט כל שדה + הסוג שלו.
2. **קריאה למודל** — השתמש ב-ctx.llm() עם הטקסט; בקש פלט JSON קפדני.
3. **פענוח + הגנה** — פענח את ה-JSON; אכוף את הסוגים; קבע null לכל מה שלא נמצא (לעולם אל תמציא).

## תנאים אחריים

- `fields` הוא אובייקט שמפתחותיו הם שדות הסכמה
- שדות חסרים מקבלים null במקום שיומצאו
$t$),
  ('block_template', 'ai//classify', 'he', 'label', $t$סיווג$t$),
  ('block_template', 'ai//classify', 'he', 'description', $t$משייך לטקסט הקלט את התווית המתאימה ביותר מתוך קבוצה סגורה, יחד עם ציון ביטחון.$t$),
  ('block_template', 'ai//classify', 'he', 'tags', $t$סיווג
תיוג
עיבוד שפה טבעית$t$),
  ('block_template', 'ai//classify', 'he', 'docs_md', $t$# סיווג

משייך לטקסט הקלט את התווית המתאימה ביותר מתוך קבוצה סגורה, יחד עם ציון ביטחון.

## תנאים מקדימים

- טקסט הקלט נמצא ב-`text`
- קבוצת תוויות סגורה נמצאת ב-`labels`

## צעדים

1. **הגבלת האפשרויות** — בקש מהמודל לבחור בדיוק תווית אחת מתוך הקבוצה שסופקה.
2. **קריאה למודל** — השתמש ב-ctx.llm(); בקש { label, confidence } כ-JSON.
3. **אימות** — דחה כל תווית מחוץ לקבוצה; חזור אל unknown עם ביטחון נמוך.

## תנאים אחריים

- `label` הוא אחת התוויות שסופקו (או `unknown` מפורש)
- `confidence` נמצא בין 0 ל-1
$t$),
  ('block_template', 'ai//summarize', 'he', 'label', $t$סיכום$t$),
  ('block_template', 'ai//summarize', 'he', 'description', $t$מפיק סיכום של טקסט הקלט באורך ובסגנון מבוקרים.$t$),
  ('block_template', 'ai//summarize', 'he', 'tags', $t$סיכום
עיבוד שפה טבעית$t$),
  ('block_template', 'ai//summarize', 'he', 'docs_md', $t$# סיכום

מפיק סיכום של טקסט הקלט באורך ובסגנון מבוקרים.

## תנאים מקדימים

- טקסט הקלט נמצא ב-`text`

## צעדים

1. **קביעת מגבלות** — שלב את max_lines + הסגנון בהוראת המערכת.
2. **קריאה למודל** — השתמש ב-ctx.llm() עם הטקסט והמגבלות.
3. **קיצור** — אכוף את מגבלת השורות באופן הגנתי לאחר תשובת המודל.

## תנאים אחריים

- `summary` עומד באורך המרבי + בסגנון שהתבקשו
$t$),
  ('block_template', 'ai//generate-draft', 'he', 'label', $t$יצירת טיוטה$t$),
  ('block_template', 'ai//generate-draft', 'he', 'description', $t$מנסח תוכן מתוך תדריך קצר בסגנון הנבחר (דואר אלקטרוני, תגובה, תיאור, …).$t$),
  ('block_template', 'ai//generate-draft', 'he', 'tags', $t$יצירה
כתיבת טיוטה
עיבוד שפה טבעית$t$),
  ('block_template', 'ai//generate-draft', 'he', 'docs_md', $t$# יצירת טיוטה

מנסח תוכן מתוך תדריך קצר בסגנון הנבחר (דואר אלקטרוני, תגובה, תיאור, …).

## תנאים מקדימים

- תדריך מסופק ב-`brief`

## צעדים

1. **מסגור המשימה** — ציין למודל את קהל היעד, המטרה והסגנון.
2. **קריאה למודל** — השתמש ב-ctx.llm() עם התדריך; השאר את הטקסט ניתן לעריכה, לא סופי.
3. **החזרה** — החזר את טקסט הטיוטה כדי שאדם יבדוק + ישלח אותו.

## תנאים אחריים

- `draft` הוא טיוטה ראשונה מוכנה לעריכה בסגנון שהתבקש
$t$),
  ('block_template', 'ai//route-by-intent', 'he', 'label', $t$ניתוב לפי כוונה$t$),
  ('block_template', 'ai//route-by-intent', 'he', 'description', $t$מזהה את כוונת המשתמש מתוך הודעה ומנתב אותה לאחד מתוך קבוצה קבועה של מטפלים.$t$),
  ('block_template', 'ai//route-by-intent', 'he', 'tags', $t$כוונה
ניתוב
עיבוד שפה טבעית$t$),
  ('block_template', 'ai//route-by-intent', 'he', 'docs_md', $t$# ניתוב לפי כוונה

מזהה את כוונת המשתמש מתוך הודעה ומנתב אותה לאחד מתוך קבוצה קבועה של מטפלים.

## תנאים מקדימים

- הודעה נמצאת ב-`message`
- קבוצת כוונות מועמדות נמצאת ב-`intents`

## צעדים

1. **תיאור הכוונות** — ספק למודל תיאור בן שורה אחת לכל כוונה מועמדת.
2. **קריאה למודל** — השתמש ב-ctx.llm(); בקש { intent, confidence } כ-JSON.
3. **סף ביטחון** — מתחת לסף ביטחון מסוים, נתב אל fallback במקום לנחש.

## תנאים אחריים

- `intent` הוא אחת הכוונות המועמדות (או `fallback`)
- `confidence` נמצא בין 0 ל-1
$t$),
  ('block_template', 'ai//redact-pii', 'he', 'label', $t$הסתרת מידע אישי$t$),
  ('block_template', 'ai//redact-pii', 'he', 'description', $t$מזהה ומסתיר מידע אישי (שמות, כתובות דואר אלקטרוני, מספרי טלפון, מספרי זהות) בטקסט חופשי.$t$),
  ('block_template', 'ai//redact-pii', 'he', 'tags', $t$מידע אישי
הסתרה
פרטיות$t$),
  ('block_template', 'ai//redact-pii', 'he', 'docs_md', $t$# הסתרת מידע אישי

מזהה ומסתיר מידע אישי (שמות, כתובות דואר אלקטרוני, מספרי טלפון, מספרי זהות) בטקסט חופשי.

## תנאים מקדימים

- טקסט הקלט נמצא ב-`text`
- סוגי המידע האישי שיש להסתיר נמצאים ב-`kinds`

## צעדים

1. **ציון הסוגים** — ציין למודל אילו סוגי מידע אישי לחפש (דואר אלקטרוני, טלפון, שם, מזהה).
2. **קריאה למודל** — השתמש ב-ctx.llm(); בקש את הקטעים להסתרה, לא את הערכים עצמם.
3. **הסתרה** — החלף כל קטע ב-[REDACTED:<kind>]; ספור את הכמויות ב-`found`.

## תנאים אחריים

- `redacted` מחליף כל קטע שזוהה במציין מקום מסומן בסוגו
- `found` מפרט מה זוהה (סוג + כמות), לעולם לא את הערכים עצמם
$t$),
  ('block_template', 'logic//validate-record', 'he', 'label', $t$אימות רשומה$t$),
  ('block_template', 'logic//validate-record', 'he', 'description', $t$בודק רשומה מול מערכת כללים לשדות; מעביר רשומות תקינות ואוסף סיבות עבור אלה שאינן תקינות.$t$),
  ('block_template', 'logic//validate-record', 'he', 'tags', $t$אימות
בקרה
איכות נתונים$t$),
  ('block_template', 'logic//validate-record', 'he', 'docs_md', $t$# אימות רשומה

בודק רשומה מול מערכת כללים לשדות; מעביר רשומות תקינות ואוסף סיבות עבור אלה שאינן תקינות.

## תנאים מקדימים

- אובייקט רשומה זמין בקלט `record`
- מוגדרת מערכת כללים לשדות (חובה / סוג / טווח)

## צעדים

1. **טעינת מערכת הכללים** — קרא את הכללים לכל שדה מהקלט `rules` (חובה, סוג, מינימום/מקסימום, תבנית).
2. **בדיקת כל שדה** — לכל כלל, קרא את record[field] ובדוק אותו; הוסף הודעה אל errors בכישלון.
3. **הכרעה** — valid = errors.length === 0; החזר את שניהם כדי שהשלבים הבאים יוכלו להסתעף.

## תנאים אחריים

- `valid` הוא true רק כאשר כל כלל מתקיים
- `errors` מפרט סיבה קריאה לכל כלל שנכשל
$t$),
  ('block_template', 'logic//route-by-rule', 'he', 'label', $t$ניתוב לפי כלל (טבלת החלטה)$t$),
  ('block_template', 'logic//route-by-rule', 'he', 'description', $t$בוחר ענף על ידי הרצת טבלת החלטה מסודרת על הקלט — ההתאמה הראשונה מנצחת.$t$),
  ('block_template', 'logic//route-by-rule', 'he', 'tags', $t$ניתוב
טבלת החלטה
הסתעפות$t$),
  ('block_template', 'logic//route-by-rule', 'he', 'docs_md', $t$# ניתוב לפי כלל (טבלת החלטה)

בוחר ענף על ידי הרצת טבלת החלטה מסודרת על הקלט — ההתאמה הראשונה מנצחת.

## תנאים מקדימים

- אובייקט קלט זמין ב-`item`
- מוגדרת רשימה מסודרת של כללים (תנאי → מסלול)

## צעדים

1. **קריאת טבלת ההחלטה** — כל כלל הוא { when: {field, op, value}, route }; הערך מלמעלה למטה.
2. **איתור ההתאמה הראשונה** — החזר את המסלול של הכלל הראשון שתנאיו מתקיימים עבור `item`.
3. **נפילה לברירת מחדל** — אם אף כלל אינו מתאים, החזר את מסלול ברירת המחדל שהוגדר וכן matched=false.

## תנאים אחריים

- `route` הוא התווית של הכלל המתאים הראשון, או מסלול ברירת המחדל
- `matched` מציין אם כלל כלשהו הופעל
$t$),
  ('block_template', 'logic//approve-reject', 'he', 'label', $t$אישור / דחייה (עקרון ארבע עיניים)$t$),
  ('block_template', 'logic//approve-reject', 'he', 'description', $t$מעביר פריט רק לאחר בדיקה מול מדיניות ולאחר הכרעה אנושית מפורשת, תוך תיעוד מי הכריע ומדוע.$t$),
  ('block_template', 'logic//approve-reject', 'he', 'tags', $t$אישור
ארבע עיניים
ממשל תאגידי$t$),
  ('block_template', 'logic//approve-reject', 'he', 'docs_md', $t$# אישור / דחייה (עקרון ארבע עיניים)

מעביר פריט רק לאחר בדיקה מול מדיניות ולאחר הכרעה אנושית מפורשת, תוך תיעוד מי הכריע ומדוע.

## תנאים מקדימים

- הפריט שבבדיקה נמצא ב-`item`
- מסופקים הכרעה (`approve` | `reject`) וזהות הבודק

## צעדים

1. **הרצת בדיקות מדיניות מקדימות** — הרץ תחילה את הבקרות האוטומטיות; דחה אוטומטית כל מה שאינו עומד במדיניות, ללא תלות בקלט האנושי.
2. **תיעוד ההכרעה האנושית** — תעד את ההכרעה, הבודק והסיבה עבור מסלול הביקורת.
3. **החזרת התוצאה** — approved = policyPassed && decision === 'approve'; צרף את רשומת ההכרעה.

## תנאים אחריים

- `approved` משקף את הכרעת הבודק לאחר בדיקות המדיניות
- מצורף מסלול ביקורת (בודק, סיבה, חותמת זמן)
$t$),
  ('block_template', 'logic//dedupe', 'he', 'label', $t$הסרת שורות כפולות$t$),
  ('block_template', 'logic//dedupe', 'he', 'description', $t$מאחד שורות בעלות אותו מפתח, שומר שורה נבחרת אחת וסופר את הכפילויות שהוסרו.$t$),
  ('block_template', 'logic//dedupe', 'he', 'tags', $t$כפילויות
ניקוי
איכות נתונים$t$),
  ('block_template', 'logic//dedupe', 'he', 'docs_md', $t$# הסרת שורות כפולות

מאחד שורות בעלות אותו מפתח, שומר שורה נבחרת אחת וסופר את הכפילויות שהוסרו.

## תנאים מקדימים

- רשימת שורות זמינה ב-`rows`
- מוגדר מפתח לאיתור כפילויות (שדה אחד או יותר)

## צעדים

1. **בניית המפתח** — חשב לכל שורה מפתח מורכב משדות המפתח שהוגדרו.
2. **בחירת השורה שתישמר** — לכל מפתח שמור את השורה הראשונה (או העדכנית ביותר לפי `tiebreak`); השלך את השאר.
3. **דיווח** — החזר את השורות לאחר הסרת הכפילויות ואת מספר השורות שהוסרו.

## תנאים אחריים

- `rows` מכיל לכל היותר שורה שנשמרה אחת לכל מפתח
- `removed` סופר כמה כפילויות הוסרו
$t$),
  ('block_template', 'logic//enrich-lookup', 'he', 'label', $t$העשרה מטבלת ייחוס$t$),
  ('block_template', 'logic//enrich-lookup', 'he', 'description', $t$מצרף כל שורה לטבלת ייחוס לפי מפתח וממזג לתוכה את שדות הייחוס שהותאמו.$t$),
  ('block_template', 'logic//enrich-lookup', 'he', 'tags', $t$העשרה
צירוף
חיפוש ייחוס$t$),
  ('block_template', 'logic//enrich-lookup', 'he', 'docs_md', $t$# העשרה מטבלת ייחוס

מצרף כל שורה לטבלת ייחוס לפי מפתח וממזג לתוכה את שדות הייחוס שהותאמו.

## תנאים מקדימים

- השורות להעשרה נמצאות ב-`rows`
- זמינים מערך נתונים או טבלת ייחוס ומפתח הצירוף

## צעדים

1. **אינדוקס הייחוס** — בנה מיפוי ממפתח הצירוף לשורת הייחוס לשליפה בזמן O(1).
2. **מיזוג** — לכל שורת קלט, חפש לפי המפתח ושלב את שדות הייחוס (בהתנגשות הקלט מנצח).
3. **מעקב אחר החמצות** — ספור שורות ללא התאמה כדי שניתן יהיה לנטר את האיכות.

## תנאים אחריים

- כל שורה מקבלת את שדות הייחוס כאשר נמצאת התאמה
- `unmatched` סופר שורות ללא התאמה בטבלת הייחוס
$t$),
  ('block_template', 'logic//threshold-flag', 'he', 'label', $t$סימון לפי סף$t$),
  ('block_template', 'logic//threshold-flag', 'he', 'description', $t$מנקד כל פריט ומסמן לבדיקה את אלה שחוצים סף הניתן להגדרה.$t$),
  ('block_template', 'logic//threshold-flag', 'he', 'tags', $t$ניקוד
סימון
ניטור$t$),
  ('block_template', 'logic//threshold-flag', 'he', 'docs_md', $t$# סימון לפי סף

מנקד כל פריט ומסמן לבדיקה את אלה שחוצים סף הניתן להגדרה.

## תנאים מקדימים

- הפריטים לניקוד נמצאים ב-`items`
- מוגדרים שדה מספרי וסף

## צעדים

1. **קריאת המדד** — חלץ את השדה המספרי מכל פריט.
2. **השוואה** — סמן פריטים שבהם value >= threshold (או <= עבור גבול תחתון).
3. **איסוף** — החזר את תת-הקבוצה המסומנת ואת מספרה.

## תנאים אחריים

- `flagged` מפרט את הפריטים שחוצים את הסף
- `count` הוא מספר הפריטים שסומנו
$t$),
  ('block_template', 'logic//map-transform', 'he', 'label', $t$מיפוי / המרה$t$),
  ('block_template', 'logic//map-transform', 'he', 'description', $t$מעצב כל שורה מחדש לסכמת יעד באמצעות מיפוי שדות, ומשמיט או משנה שמות בהתאם להגדרה.$t$),
  ('block_template', 'logic//map-transform', 'he', 'tags', $t$המרה
מיפוי
עיצוב מחדש$t$),
  ('block_template', 'logic//map-transform', 'he', 'docs_md', $t$# מיפוי / המרה

מעצב כל שורה מחדש לסכמת יעד באמצעות מיפוי שדות, ומשמיט או משנה שמות בהתאם להגדרה.

## תנאים מקדימים

- שורות המקור נמצאות ב-`rows`
- מוגדר מיפוי שדות (מקור → יעד)

## צעדים

1. **קריאת המיפוי** — המיפוי הוא { targetField: sourceField }.
2. **היטל כל שורה** — בנה אובייקט חדש לכל שורה לפי המיפוי; דלג על שדות שאינם ממופים.
3. **החזרה** — החזר את השורות שהומרו בסדר המקורי.

## תנאים אחריים

- כל שורת פלט מכילה רק את שדות היעד הממופים
- סדר השורות נשמר
$t$),
  ('block_template', 'logic//aggregate', 'he', 'label', $t$צבירה / קיבוץ$t$),
  ('block_template', 'logic//aggregate', 'he', 'description', $t$מקבץ שורות לפי מפתח ומחשב ערכים מצטברים (ספירה / סכום / ממוצע) לכל קבוצה.$t$),
  ('block_template', 'logic//aggregate', 'he', 'tags', $t$צבירה
קיבוץ
סיכום$t$),
  ('block_template', 'logic//aggregate', 'he', 'docs_md', $t$# צבירה / קיבוץ

מקבץ שורות לפי מפתח ומחשב ערכים מצטברים (ספירה / סכום / ממוצע) לכל קבוצה.

## תנאים מקדימים

- השורות נמצאות ב-`rows`
- מוגדרים מפתח קיבוץ והמדדים לצבירה

## צעדים

1. **חלוקה לקבוצות** — קבץ את השורות לפי השדה group_by שהוגדר.
2. **צמצום** — לכל קבוצה חשב את הספירה ואת הסכום/הממוצע של כל שדה מדידה.
3. **החזרת התוצאה** — החזר שורה אחת לכל קבוצה עם הערכים המצטברים.

## תנאים אחריים

- `groups` מכיל שורת סיכום אחת לכל מפתח ייחודי
- כל סיכום נושא את הערכים המצטברים שהתבקשו
$t$),
  ('block_template', 'ui//form', 'he', 'label', $t$טופס$t$),
  ('block_template', 'ui//form', 'he', 'description', $t$אוסף ומאמת קלט משתמש מול סכמת שדות, ומחזיר את הערכים שנקלטו בעת השליחה.$t$),
  ('block_template', 'ui//form', 'he', 'tags', $t$טופס
קלט
לכידה$t$),
  ('block_template', 'ui//form', 'he', 'docs_md', $t$# טופס

אוסף ומאמת קלט משתמש מול סכמת שדות, ומחזיר את הערכים שנקלטו בעת השליחה.

## תנאים מקדימים

- סכמת שדות (תוויות, סוגים, חובה) מסופקת ב-`schema`

## צעדים

1. **הצגת השדות** — בנה את שדות הקלט מתוך הסכמה (טקסט / מספר / רשימה נפתחת / תיבת סימון).
2. **אימות** — חסום את השליחה עד שכל שדות החובה מלאים והסוגים תקינים.
3. **החזרה** — בעת השליחה, החזר את הערכים שנאספו וכן submitted=true.

## תנאים אחריים

- `values` מכיל את השדות שנקלטו לאחר השליחה
- `submitted` הופך ל-true רק לאחר שהאימות בצד הלקוח עבר
$t$),
  ('block_template', 'ui//table', 'he', 'label', $t$טבלה / רשימה$t$),
  ('block_template', 'ui//table', 'he', 'description', $t$מציג שורות בטבלה הניתנת למיון ולבחירה על בסיס הגדרת עמודות.$t$),
  ('block_template', 'ui//table', 'he', 'tags', $t$טבלה
רשימה
רשת$t$),
  ('block_template', 'ui//table', 'he', 'docs_md', $t$# טבלה / רשימה

מציג שורות בטבלה הניתנת למיון ולבחירה על בסיס הגדרת עמודות.

## תנאים מקדימים

- השורות מסופקות ב-`rows`
- הגדרת עמודות מסופקת ב-`columns`

## צעדים

1. **הגדרת העמודות** — מפה כל עמודה לשדה בשורה + כותרת + מעצב אופציונלי.
2. **הצגת השורות** — הצג את השורות; תמוך במיון לפי עמודה ובבחירת שורות.
3. **החזרת הבחירה** — החזר את השורה או השורות שנבחרו כאשר המשתמש לוחץ.

## תנאים אחריים

- `selected` משקף את השורה או השורות שהמשתמש בוחר
$t$),
  ('block_template', 'ui//chart', 'he', 'label', $t$תרשים$t$),
  ('block_template', 'ui//chart', 'he', 'description', $t$ממחיש סדרה אחת או יותר כתרשים קו, עמודות או עוגה.$t$),
  ('block_template', 'ui//chart', 'he', 'tags', $t$תרשים
המחשה חזותית
דוח$t$),
  ('block_template', 'ui//chart', 'he', 'docs_md', $t$# תרשים

ממחיש סדרה אחת או יותר כתרשים קו, עמודות או עוגה.

## תנאים מקדימים

- נתוני הסדרה מסופקים ב-`series`

## צעדים

1. **בחירת סוג תרשים** — קו למגמות, עמודות להשוואות, עוגה להרכב.
2. **מיפוי הנתונים** — מפה את נקודות הסדרה לצירים / לפלחים.
3. **ציור** — צייר את התרשים עם תוויות צירים + מקרא.

## תנאים אחריים

- התרשים מוצג עבור ה-`type` שנבחר
$t$),
  ('block_template', 'ui//kpi-card', 'he', 'label', $t$כרטיס מדד$t$),
  ('block_template', 'ui//kpi-card', 'he', 'description', $t$מציג מדד מוביל יחיד עם שינוי אופציונלי לעומת תקופה קודמת.$t$),
  ('block_template', 'ui//kpi-card', 'he', 'tags', $t$מדד
מדידה
לוח מחוונים$t$),
  ('block_template', 'ui//kpi-card', 'he', 'docs_md', $t$# כרטיס מדד

מציג מדד מוביל יחיד עם שינוי אופציונלי לעומת תקופה קודמת.

## תנאים מקדימים

- מסופקים תווית וערך מספרי

## צעדים

1. **הצגת הערך** — הצג את המספר המוביל יחד עם התווית.
2. **הצגת השינוי** — אם ניתן שינוי, הצג עלייה/ירידה עם סימן + צבע.

## תנאים אחריים

- המדד + כיוון השינוי מוצגים
$t$),
  ('block_template', 'ui//detail-view', 'he', 'label', $t$תצוגת פרטים$t$),
  ('block_template', 'ui//detail-view', 'he', 'description', $t$מציג רשומה יחידה כלוח פרטים לקריאה בלבד בפורמט תווית/ערך.$t$),
  ('block_template', 'ui//detail-view', 'he', 'tags', $t$פרטים
רשומה
לקריאה בלבד$t$),
  ('block_template', 'ui//detail-view', 'he', 'docs_md', $t$# תצוגת פרטים

מציג רשומה יחידה כלוח פרטים לקריאה בלבד בפורמט תווית/ערך.

## תנאים מקדימים

- רשומה מסופקת ב-`record`

## צעדים

1. **בחירת שדות** — השתמש ב-`fields` כדי לבחור + לסדר אילו מפתחות יוצגו (ברירת מחדל: הכול).
2. **הצגה** — הצג כל אחד כשורת תווית/ערך; עצב תאריכים + מספרים.

## תנאים אחריים

- השדות שנבחרו מוצגים כשורות תווית/ערך
$t$),
  ('block_template', 'ui//filter-bar', 'he', 'label', $t$סרגל סינון$t$),
  ('block_template', 'ui//filter-bar', 'he', 'description', $t$מציג אוסף פקדי סינון ומחזיר את השאילתה הנובעת מהם ככל שהמשתמש משנה אותם.$t$),
  ('block_template', 'ui//filter-bar', 'he', 'tags', $t$סינון
חיפוש
פקדים$t$),
  ('block_template', 'ui//filter-bar', 'he', 'docs_md', $t$# סרגל סינון

מציג אוסף פקדי סינון ומחזיר את השאילתה הנובעת מהם ככל שהמשתמש משנה אותם.

## תנאים מקדימים

- הגדרת שדות הסינון מסופקת ב-`fields`

## צעדים

1. **הצגת הפקדים** — בנה פקד לכל שדה (טקסט / רשימה נפתחת / טווח תאריכים).
2. **איסוף** — בכל שינוי, הרכב את הפילטרים הפעילים לאובייקט שאילתה.
3. **החזרה** — החזר את השאילתה כדי שבלוק נתונים בהמשך יוכל לטעון מחדש.

## תנאים אחריים

- `query` משקף את בחירות הסינון הנוכחיות
- `changed` מופעל בכל פעם שפקד משתנה
$t$)

ON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();
