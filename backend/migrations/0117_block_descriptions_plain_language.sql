-- 0117_block_descriptions_plain_language.sql — the card descriptions of 16 platform building
-- blocks, rewritten in plain language in `en` and all 7 non-en editions.
--
-- WHAT WAS WRONG
-- --------------
-- A brand-new early-access org (prod walk, 2026-10-16) read the Building blocks screen in Dutch and
-- got English mixed into every other card: "Threshold-based + LLM-judgement modes", "Mock policy
-- lookup tegen de sandboxed insurance dataset", "render-model", "rowset", "brokered LLM". The 0073
-- translations carried the `en` base's developer jargon straight through, because the base itself
-- was written for developers. Several bases also claimed things the code does not do —
-- `flag-anomalies` has no AI mode (it compares the absolute `score` to a threshold), `format-output` has no
-- theming, `if-else` never calls AI, `compare-docs` keeps no audit trail, `read-customer-record`
-- redacts nothing (it returns sample data) — and `review-panel` credited an invented person
-- ("Hannah’s contribution from Week 21"). The new wording follows docs/style-guide.md (no jargon,
-- no second person) and says only what each block's run() does.
--
-- WHY A MIGRATION AS WELL AS THE SEED EDIT — same split as 0076/0103: seeders skip an existing slug,
-- so the seed literals (seed.ts, seed-example-blocks.ts, seed-datasets.ts — corrected in the same
-- change) only reach a database with no row yet; this file repairs prod's existing rows. On a fresh
-- CI database migrations run before the seed, so the base UPDATEs match 0 rows there and the
-- translation rows still land.
--
-- SCOPE. GLOBAL blocks only (`tenant_id IS NULL`; `entity_type='block'`, bare slug as `entity_id`).
-- `block_tenant` rows and tenant forks are never touched. Only the `description` field; docs_md is
-- unchanged. IDEMPOTENT: absolute assignments + `ON CONFLICT … DO UPDATE` on the primary key.

-- 1. The `en` base.
UPDATE building_blocks SET description = $t$Uses AI to pull named fields out of a document and marks each field as found or not found.$t$, updated_at = now()
 WHERE slug = 'extract-fields' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Demonstration block. Looks up a policy in the sample data and returns its coverage and deductible.$t$, updated_at = now()
 WHERE slug = 'lookup-policy' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Flags the records whose score, positive or negative, reaches a set threshold.$t$, updated_at = now()
 WHERE slug = 'flag-anomalies' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Prepares text as plain Markdown, a simple HTML paragraph or a Slack message.$t$, updated_at = now()
 WHERE slug = 'format-output' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Uses AI to sort text into one of a fixed list of labels, with a confidence and a short reason.$t$, updated_at = now()
 WHERE slug = 'classify' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Picks one of two values depending on whether a condition is true.$t$, updated_at = now()
 WHERE slug = 'if-else' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Demonstration block. Returns a sample accept, edit or reject decision in place of a review by a person.$t$, updated_at = now()
 WHERE slug = 'review-panel' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Uses AI to show what changed in meaning between two documents. Useful for contract changes and policy renewals.$t$, updated_at = now()
 WHERE slug = 'compare-docs' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Demonstration block. Returns a customer’s details from the sample data.$t$, updated_at = now()
 WHERE slug = 'read-customer-record' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Keeps only the records where a field meets a condition. Works on any list of records.$t$, updated_at = now()
 WHERE slug = 'filter-rows' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Counts how many records have each value of a field — for example, claims per status.$t$, updated_at = now()
 WHERE slug = 'group-and-count' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Uses AI to give a claim a severity (low, medium or high), a priority from 1 to 5 and a short reason. Without a usable AI answer it falls back to a rule on amount and fraud score.$t$, updated_at = now()
 WHERE slug = 'triage-claim' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Shows a list of records as a table. A reusable step for showing results in a flow.$t$, updated_at = now()
 WHERE slug = 'table-view' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Shows one record as an editable form with accept, edit and reject — for steps where a person checks the work.$t$, updated_at = now()
 WHERE slug = 'record-form' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Shows a few key figures as a summary card — for dashboards and flow summaries.$t$, updated_at = now()
 WHERE slug = 'summary-card' AND tenant_id IS NULL;
UPDATE building_blocks SET description = $t$Loads one of the organisation’s datasets, chosen in the block settings, and returns its rows and the number of rows.$t$, updated_at = now()
 WHERE slug = 'load-dataset' AND tenant_id IS NULL;

-- 2. The 7 non-en editions.
INSERT INTO content_translations (entity_type, entity_id, locale, field, value) VALUES
  ('block', 'extract-fields', 'nl', 'description', $t$Haalt met AI benoemde velden uit een document en markeert per veld of het gevonden is.$t$),
  ('block', 'extract-fields', 'de', 'description', $t$Liest mit KI benannte Felder aus einem Dokument aus und markiert für jedes Feld, ob es gefunden wurde.$t$),
  ('block', 'extract-fields', 'fr', 'description', $t$Extrait avec l’IA des champs nommés d’un document et indique pour chaque champ s’il a été trouvé.$t$),
  ('block', 'extract-fields', 'es', 'description', $t$Extrae con IA campos concretos de un documento e indica para cada campo si se encontró.$t$),
  ('block', 'extract-fields', 'pl', 'description', $t$Wyciąga za pomocą AI wskazane pola z dokumentu i zaznacza przy każdym polu, czy zostało znalezione.$t$),
  ('block', 'extract-fields', 'ar', 'description', $t$يستخرج بالذكاء الاصطناعي حقولاً محددة من مستند ويبيّن لكل حقل ما إذا وُجد.$t$),
  ('block', 'extract-fields', 'he', 'description', $t$שולף בעזרת בינה מלאכותית שדות מסוימים ממסמך ומסמן לכל שדה אם נמצא.$t$),
  ('block', 'lookup-policy', 'nl', 'description', $t$Demonstratieblok. Zoekt een polis op in de voorbeelddata en geeft de dekking en het eigen risico terug.$t$),
  ('block', 'lookup-policy', 'de', 'description', $t$Demonstrationsblock. Sucht eine Police in den Beispieldaten und gibt Deckung und Selbstbehalt zurück.$t$),
  ('block', 'lookup-policy', 'fr', 'description', $t$Brique de démonstration. Recherche une police dans les données d’exemple et renvoie sa couverture et sa franchise.$t$),
  ('block', 'lookup-policy', 'es', 'description', $t$Bloque de demostración. Busca una póliza en los datos de ejemplo y devuelve su cobertura y su franquicia.$t$),
  ('block', 'lookup-policy', 'pl', 'description', $t$Klocek demonstracyjny. Wyszukuje polisę w danych przykładowych i zwraca jej zakres ochrony oraz udział własny.$t$),
  ('block', 'lookup-policy', 'ar', 'description', $t$لبنة تجريبية. تبحث عن وثيقة تأمين في البيانات النموذجية وتعيد التغطية ومبلغ التحمّل.$t$),
  ('block', 'lookup-policy', 'he', 'description', $t$אבן בניין להדגמה. מחפשת פוליסה בנתוני הדוגמה ומחזירה את הכיסוי ואת ההשתתפות העצמית.$t$),
  ('block', 'flag-anomalies', 'nl', 'description', $t$Markeert de records waarvan de score, positief of negatief, een ingestelde drempel bereikt.$t$),
  ('block', 'flag-anomalies', 'de', 'description', $t$Markiert die Datensätze, deren Wert – positiv oder negativ – einen festgelegten Schwellenwert erreicht.$t$),
  ('block', 'flag-anomalies', 'fr', 'description', $t$Signale les enregistrements dont le score, positif ou négatif, atteint un seuil défini.$t$),
  ('block', 'flag-anomalies', 'es', 'description', $t$Marca los registros cuya puntuación, positiva o negativa, alcanza un umbral fijado.$t$),
  ('block', 'flag-anomalies', 'pl', 'description', $t$Oznacza rekordy, których wynik, dodatni lub ujemny, osiąga ustalony próg.$t$),
  ('block', 'flag-anomalies', 'ar', 'description', $t$يميّز السجلات التي تبلغ درجتها، موجبة كانت أو سالبة، حداً محدداً.$t$),
  ('block', 'flag-anomalies', 'he', 'description', $t$מסמן את הרשומות שהציון שלהן, חיובי או שלילי, מגיע לסף שנקבע.$t$),
  ('block', 'format-output', 'nl', 'description', $t$Zet tekst klaar als gewone Markdown, een eenvoudige HTML-alinea of een Slack-bericht.$t$),
  ('block', 'format-output', 'de', 'description', $t$Bereitet Text als einfaches Markdown, einfachen HTML-Absatz oder Slack-Nachricht auf.$t$),
  ('block', 'format-output', 'fr', 'description', $t$Prépare un texte en Markdown simple, en paragraphe HTML simple ou en message Slack.$t$),
  ('block', 'format-output', 'es', 'description', $t$Prepara un texto como Markdown sencillo, un párrafo HTML sencillo o un mensaje de Slack.$t$),
  ('block', 'format-output', 'pl', 'description', $t$Przygotowuje tekst jako zwykły Markdown, prosty akapit HTML lub wiadomość Slack.$t$),
  ('block', 'format-output', 'ar', 'description', $t$يجهّز النص بصيغة Markdown عادية أو فقرة HTML بسيطة أو رسالة Slack.$t$),
  ('block', 'format-output', 'he', 'description', $t$מכין טקסט כ-Markdown רגיל, כפסקת HTML פשוטה או כהודעת Slack.$t$),
  ('block', 'classify', 'nl', 'description', $t$Deelt tekst met AI in bij één label uit een vaste lijst, met een zekerheid en een korte toelichting.$t$),
  ('block', 'classify', 'de', 'description', $t$Ordnet Text mit KI einem Label aus einer festen Liste zu, mit einer Sicherheit und einer kurzen Begründung.$t$),
  ('block', 'classify', 'fr', 'description', $t$Classe un texte avec l’IA dans une liste fixe de libellés, avec un niveau de confiance et une courte explication.$t$),
  ('block', 'classify', 'es', 'description', $t$Clasifica un texto con IA en una lista fija de etiquetas, con un nivel de confianza y una breve explicación.$t$),
  ('block', 'classify', 'pl', 'description', $t$Przypisuje tekst za pomocą AI do jednej etykiety ze stałej listy, z poziomem pewności i krótkim uzasadnieniem.$t$),
  ('block', 'classify', 'ar', 'description', $t$يصنّف النص بالذكاء الاصطناعي ضمن قائمة ثابتة من التسميات، مع درجة ثقة وتعليل قصير.$t$),
  ('block', 'classify', 'he', 'description', $t$מסווג טקסט בעזרת בינה מלאכותית לאחת מתוך רשימה קבועה של תוויות, עם רמת ודאות והסבר קצר.$t$),
  ('block', 'if-else', 'nl', 'description', $t$Kiest een van twee waarden, afhankelijk van of een voorwaarde waar is.$t$),
  ('block', 'if-else', 'de', 'description', $t$Wählt einen von zwei Werten, je nachdem, ob eine Bedingung zutrifft.$t$),
  ('block', 'if-else', 'fr', 'description', $t$Choisit l’une de deux valeurs selon qu’une condition est vraie ou non.$t$),
  ('block', 'if-else', 'es', 'description', $t$Elige uno de dos valores según si una condición se cumple.$t$),
  ('block', 'if-else', 'pl', 'description', $t$Wybiera jedną z dwóch wartości w zależności od tego, czy warunek jest spełniony.$t$),
  ('block', 'if-else', 'ar', 'description', $t$يختار إحدى قيمتين بحسب تحقق شرط ما.$t$),
  ('block', 'if-else', 'he', 'description', $t$בוחר אחד משני ערכים לפי האם תנאי מתקיים.$t$),
  ('block', 'review-panel', 'nl', 'description', $t$Demonstratieblok. Geeft een voorbeeldbesluit (accepteren, aanpassen of afwijzen) terug in plaats van een beoordeling door een persoon.$t$),
  ('block', 'review-panel', 'de', 'description', $t$Demonstrationsblock. Gibt eine Beispielentscheidung (annehmen, bearbeiten oder ablehnen) zurück, anstelle einer Prüfung durch eine Person.$t$),
  ('block', 'review-panel', 'fr', 'description', $t$Brique de démonstration. Renvoie une décision d’exemple (accepter, modifier ou refuser) à la place d’une relecture par une personne.$t$),
  ('block', 'review-panel', 'es', 'description', $t$Bloque de demostración. Devuelve una decisión de ejemplo (aceptar, editar o rechazar) en lugar de la revisión de una persona.$t$),
  ('block', 'review-panel', 'pl', 'description', $t$Klocek demonstracyjny. Zwraca przykładową decyzję (akceptuj, edytuj lub odrzuć) w miejsce przeglądu przez człowieka.$t$),
  ('block', 'review-panel', 'ar', 'description', $t$لبنة تجريبية. تعيد قراراً نموذجياً (قبول أو تعديل أو رفض) بدلاً من مراجعة يجريها شخص.$t$),
  ('block', 'review-panel', 'he', 'description', $t$אבן בניין להדגמה. מחזירה החלטה לדוגמה (אישור, עריכה או דחייה) במקום בדיקה של אדם.$t$),
  ('block', 'compare-docs', 'nl', 'description', $t$Laat met AI zien wat er inhoudelijk verschilt tussen twee documenten. Handig bij contractwijzigingen en polisverlengingen.$t$),
  ('block', 'compare-docs', 'de', 'description', $t$Zeigt mit KI, was sich inhaltlich zwischen zwei Dokumenten unterscheidet. Hilfreich bei Vertragsänderungen und Policenverlängerungen.$t$),
  ('block', 'compare-docs', 'fr', 'description', $t$Montre avec l’IA ce qui change sur le fond entre deux documents. Utile pour les modifications de contrat et les renouvellements de police.$t$),
  ('block', 'compare-docs', 'es', 'description', $t$Muestra con IA qué cambia en el contenido entre dos documentos. Útil para cambios de contrato y renovaciones de pólizas.$t$),
  ('block', 'compare-docs', 'pl', 'description', $t$Pokazuje za pomocą AI, co zmienia się merytorycznie między dwoma dokumentami. Przydatne przy zmianach umów i odnowieniach polis.$t$),
  ('block', 'compare-docs', 'ar', 'description', $t$يبيّن بالذكاء الاصطناعي ما تغيّر في المضمون بين مستندين. مفيد لتعديلات العقود وتجديد وثائق التأمين.$t$),
  ('block', 'compare-docs', 'he', 'description', $t$מראה בעזרת בינה מלאכותית מה השתנה בתוכן בין שני מסמכים. שימושי לשינויי חוזים ולחידוש פוליסות.$t$),
  ('block', 'read-customer-record', 'nl', 'description', $t$Demonstratieblok. Geeft de gegevens van een klant uit de voorbeelddata terug.$t$),
  ('block', 'read-customer-record', 'de', 'description', $t$Demonstrationsblock. Gibt die Daten eines Kunden aus den Beispieldaten zurück.$t$),
  ('block', 'read-customer-record', 'fr', 'description', $t$Brique de démonstration. Renvoie les données d’un client tirées des données d’exemple.$t$),
  ('block', 'read-customer-record', 'es', 'description', $t$Bloque de demostración. Devuelve los datos de un cliente de los datos de ejemplo.$t$),
  ('block', 'read-customer-record', 'pl', 'description', $t$Klocek demonstracyjny. Zwraca dane klienta z danych przykładowych.$t$),
  ('block', 'read-customer-record', 'ar', 'description', $t$لبنة تجريبية. تعيد بيانات عميل من البيانات النموذجية.$t$),
  ('block', 'read-customer-record', 'he', 'description', $t$אבן בניין להדגמה. מחזירה נתוני לקוח מנתוני הדוגמה.$t$),
  ('block', 'filter-rows', 'nl', 'description', $t$Houdt alleen de records over waarbij een veld aan een voorwaarde voldoet. Werkt op elke lijst records.$t$),
  ('block', 'filter-rows', 'de', 'description', $t$Behält nur die Datensätze, bei denen ein Feld eine Bedingung erfüllt. Funktioniert mit jeder Liste von Datensätzen.$t$),
  ('block', 'filter-rows', 'fr', 'description', $t$Ne garde que les enregistrements dont un champ remplit une condition. Fonctionne sur toute liste d’enregistrements.$t$),
  ('block', 'filter-rows', 'es', 'description', $t$Conserva solo los registros en los que un campo cumple una condición. Funciona con cualquier lista de registros.$t$),
  ('block', 'filter-rows', 'pl', 'description', $t$Zostawia tylko rekordy, w których pole spełnia warunek. Działa na dowolnej liście rekordów.$t$),
  ('block', 'filter-rows', 'ar', 'description', $t$يُبقي فقط السجلات التي يستوفي فيها حقلٌ شرطاً ما. يعمل على أي قائمة من السجلات.$t$),
  ('block', 'filter-rows', 'he', 'description', $t$שומר רק את הרשומות שבהן שדה עומד בתנאי. עובד על כל רשימת רשומות.$t$),
  ('block', 'group-and-count', 'nl', 'description', $t$Telt hoeveel records elke waarde van een veld hebben — bijvoorbeeld claims per status.$t$),
  ('block', 'group-and-count', 'de', 'description', $t$Zählt, wie viele Datensätze jeden Wert eines Feldes haben – zum Beispiel Schadenfälle pro Status.$t$),
  ('block', 'group-and-count', 'fr', 'description', $t$Compte combien d’enregistrements ont chaque valeur d’un champ — par exemple les sinistres par statut.$t$),
  ('block', 'group-and-count', 'es', 'description', $t$Cuenta cuántos registros tienen cada valor de un campo; por ejemplo, siniestros por estado.$t$),
  ('block', 'group-and-count', 'pl', 'description', $t$Liczy, ile rekordów ma każdą wartość pola — na przykład szkody według statusu.$t$),
  ('block', 'group-and-count', 'ar', 'description', $t$يعدّ السجلات لكل قيمة من قيم حقل ما — مثلاً المطالبات حسب الحالة.$t$),
  ('block', 'group-and-count', 'he', 'description', $t$סופר כמה רשומות יש לכל ערך של שדה — למשל תביעות לפי סטטוס.$t$),
  ('block', 'triage-claim', 'nl', 'description', $t$Geeft een claim met AI een ernst (laag, middel of hoog), een prioriteit van 1 tot 5 en een korte toelichting. Zonder bruikbaar AI-antwoord valt het terug op een regel voor bedrag en fraudescore.$t$),
  ('block', 'triage-claim', 'de', 'description', $t$Weist einem Schadenfall mit KI einen Schweregrad (niedrig, mittel oder hoch), eine Priorität von 1 bis 5 und eine kurze Begründung zu. Ohne verwertbare KI-Antwort greift eine Regel nach Betrag und Betrugswert.$t$),
  ('block', 'triage-claim', 'fr', 'description', $t$Attribue avec l’IA une gravité (faible, moyenne ou élevée), une priorité de 1 à 5 et une courte justification à un sinistre. Sans réponse exploitable de l’IA, une règle basée sur le montant et le score de fraude s’applique.$t$),
  ('block', 'triage-claim', 'es', 'description', $t$Asigna con IA a un siniestro una gravedad (baja, media o alta), una prioridad de 1 a 5 y una breve justificación. Sin una respuesta útil de la IA, aplica una regla basada en el importe y la puntuación de fraude.$t$),
  ('block', 'triage-claim', 'pl', 'description', $t$Nadaje szkodzie za pomocą AI wagę (niska, średnia lub wysoka), priorytet od 1 do 5 i krótkie uzasadnienie. Bez użytecznej odpowiedzi AI stosuje regułę opartą na kwocie i wskaźniku oszustwa.$t$),
  ('block', 'triage-claim', 'ar', 'description', $t$يحدد بالذكاء الاصطناعي درجة خطورة المطالبة (منخفضة أو متوسطة أو عالية) وأولويتها من 1 إلى 5 مع تعليل قصير. وإن لم تتوفر إجابة صالحة يطبّق قاعدة تعتمد على المبلغ ودرجة الاحتيال.$t$),
  ('block', 'triage-claim', 'he', 'description', $t$קובע בעזרת בינה מלאכותית חומרה (נמוכה, בינונית או גבוהה), עדיפות מ-1 עד 5 והסבר קצר לתביעה. בלי תשובה שמישה מהבינה המלאכותית מופעל כלל לפי סכום וציון הונאה.$t$),
  ('block', 'table-view', 'nl', 'description', $t$Toont een lijst records als tabel. Een herbruikbare stap om resultaten in een flow te tonen.$t$),
  ('block', 'table-view', 'de', 'description', $t$Zeigt eine Liste von Datensätzen als Tabelle. Ein wiederverwendbarer Schritt, um Ergebnisse in einem Flow anzuzeigen.$t$),
  ('block', 'table-view', 'fr', 'description', $t$Affiche une liste d’enregistrements sous forme de tableau. Une étape réutilisable pour montrer les résultats d’un flux.$t$),
  ('block', 'table-view', 'es', 'description', $t$Muestra una lista de registros como tabla. Un paso reutilizable para mostrar resultados en un flujo.$t$),
  ('block', 'table-view', 'pl', 'description', $t$Wyświetla listę rekordów jako tabelę. Krok wielokrotnego użytku do pokazywania wyników w przepływie.$t$),
  ('block', 'table-view', 'ar', 'description', $t$يعرض قائمة سجلات في جدول. خطوة قابلة لإعادة الاستخدام لعرض النتائج في مسار العمل.$t$),
  ('block', 'table-view', 'he', 'description', $t$מציג רשימת רשומות כטבלה. שלב לשימוש חוזר להצגת תוצאות בתהליך.$t$),
  ('block', 'record-form', 'nl', 'description', $t$Toont één record als bewerkbaar formulier met accepteren, aanpassen en afwijzen — voor stappen waarin een persoon het werk controleert.$t$),
  ('block', 'record-form', 'de', 'description', $t$Zeigt einen Datensatz als bearbeitbares Formular mit Annehmen, Bearbeiten und Ablehnen – für Schritte, in denen eine Person die Arbeit prüft.$t$),
  ('block', 'record-form', 'fr', 'description', $t$Affiche un enregistrement sous forme de formulaire modifiable avec accepter, modifier et refuser — pour les étapes où une personne vérifie le travail.$t$),
  ('block', 'record-form', 'es', 'description', $t$Muestra un registro como formulario editable con aceptar, editar y rechazar, para pasos en los que una persona revisa el trabajo.$t$),
  ('block', 'record-form', 'pl', 'description', $t$Wyświetla jeden rekord jako edytowalny formularz z akcjami akceptuj, edytuj i odrzuć — dla kroków, w których człowiek sprawdza pracę.$t$),
  ('block', 'record-form', 'ar', 'description', $t$يعرض سجلاً واحداً كنموذج قابل للتعديل مع قبول وتعديل ورفض — للخطوات التي يراجع فيها شخص العمل.$t$),
  ('block', 'record-form', 'he', 'description', $t$מציג רשומה אחת כטופס הניתן לעריכה עם אישור, עריכה ודחייה — לשלבים שבהם אדם בודק את העבודה.$t$),
  ('block', 'summary-card', 'nl', 'description', $t$Toont een paar kerncijfers als overzichtskaart — voor dashboards en samenvattingen van een flow.$t$),
  ('block', 'summary-card', 'de', 'description', $t$Zeigt einige Kennzahlen als Übersichtskarte – für Dashboards und Flow-Zusammenfassungen.$t$),
  ('block', 'summary-card', 'fr', 'description', $t$Affiche quelques chiffres clés sous forme de carte de synthèse — pour les tableaux de bord et les résumés de flux.$t$),
  ('block', 'summary-card', 'es', 'description', $t$Muestra algunas cifras clave como tarjeta de resumen, para paneles y resúmenes de flujo.$t$),
  ('block', 'summary-card', 'pl', 'description', $t$Wyświetla kilka kluczowych liczb jako kartę podsumowania — do pulpitów i podsumowań przepływu.$t$),
  ('block', 'summary-card', 'ar', 'description', $t$يعرض بعض الأرقام الرئيسية في بطاقة ملخص — للوحات المعلومات وملخصات مسارات العمل.$t$),
  ('block', 'summary-card', 'he', 'description', $t$מציג כמה נתוני מפתח בכרטיס סיכום — ללוחות מחוונים ולסיכומי תהליכים.$t$),
  ('block', 'load-dataset', 'nl', 'description', $t$Laadt een van de datasets van de organisatie, gekozen in de instellingen van het blok, en geeft de rijen en het aantal rijen terug.$t$),
  ('block', 'load-dataset', 'de', 'description', $t$Lädt einen der Datensätze der Organisation, ausgewählt in den Blockeinstellungen, und gibt die Zeilen und deren Anzahl zurück.$t$),
  ('block', 'load-dataset', 'fr', 'description', $t$Charge l’un des jeux de données de l’organisation, choisi dans les réglages de la brique, et renvoie ses lignes et leur nombre.$t$),
  ('block', 'load-dataset', 'es', 'description', $t$Carga uno de los conjuntos de datos de la organización, elegido en los ajustes del bloque, y devuelve sus filas y cuántas hay.$t$),
  ('block', 'load-dataset', 'pl', 'description', $t$Wczytuje jeden ze zbiorów danych organizacji, wybrany w ustawieniach klocka, i zwraca jego wiersze oraz ich liczbę.$t$),
  ('block', 'load-dataset', 'ar', 'description', $t$يحمّل إحدى مجموعات بيانات المؤسسة، المختارة في إعدادات اللبنة، ويعيد صفوفها وعددها.$t$),
  ('block', 'load-dataset', 'he', 'description', $t$טוען אחד ממערכי הנתונים של הארגון, שנבחר בהגדרות של אבן הבניין, ומחזיר את השורות ואת מספרן.$t$)
ON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

-- 3. The translation pipeline's own record of these cells. `translation_jobs.source_hash` is the
-- staleness key (host/translation-service.ts `enqueueTranslations`: an UPSERT resets a job to
-- `pending` only `WHERE source_hash <> excluded.source_hash`). Left at the OLD English, an admin
-- "Backfill all content" would see every one of these 112 cells as edited, re-queue it, and the
-- worker would overwrite the hand-written translations above with machine output. Each job is
-- stamped with the NEW source text + its sha256 (the same `createHash('sha256').update(text,
-- 'utf8').digest('hex')` the service computes) and `done`, so a backfill is a no-op for them.
-- Upserted rather than only UPDATEd: on a database with no job row, a backfill would otherwise
-- INSERT a pending job for the cell and translate over it just the same.
INSERT INTO translation_jobs (entity_type, entity_id, field, target_locale, source_text, source_hash, status, attempts, error)
SELECT 'block', s.slug, 'description', l.loc, s.txt, encode(sha256(convert_to(s.txt, 'UTF8')), 'hex'), 'done', 0, NULL
  FROM (VALUES
    ('extract-fields', $t$Uses AI to pull named fields out of a document and marks each field as found or not found.$t$),
    ('lookup-policy', $t$Demonstration block. Looks up a policy in the sample data and returns its coverage and deductible.$t$),
    ('flag-anomalies', $t$Flags the records whose score, positive or negative, reaches a set threshold.$t$),
    ('format-output', $t$Prepares text as plain Markdown, a simple HTML paragraph or a Slack message.$t$),
    ('classify', $t$Uses AI to sort text into one of a fixed list of labels, with a confidence and a short reason.$t$),
    ('if-else', $t$Picks one of two values depending on whether a condition is true.$t$),
    ('review-panel', $t$Demonstration block. Returns a sample accept, edit or reject decision in place of a review by a person.$t$),
    ('compare-docs', $t$Uses AI to show what changed in meaning between two documents. Useful for contract changes and policy renewals.$t$),
    ('read-customer-record', $t$Demonstration block. Returns a customer’s details from the sample data.$t$),
    ('filter-rows', $t$Keeps only the records where a field meets a condition. Works on any list of records.$t$),
    ('group-and-count', $t$Counts how many records have each value of a field — for example, claims per status.$t$),
    ('triage-claim', $t$Uses AI to give a claim a severity (low, medium or high), a priority from 1 to 5 and a short reason. Without a usable AI answer it falls back to a rule on amount and fraud score.$t$),
    ('table-view', $t$Shows a list of records as a table. A reusable step for showing results in a flow.$t$),
    ('record-form', $t$Shows one record as an editable form with accept, edit and reject — for steps where a person checks the work.$t$),
    ('summary-card', $t$Shows a few key figures as a summary card — for dashboards and flow summaries.$t$),
    ('load-dataset', $t$Loads one of the organisation’s datasets, chosen in the block settings, and returns its rows and the number of rows.$t$)
  ) AS s(slug, txt)
 CROSS JOIN (VALUES ('nl'), ('de'), ('fr'), ('es'), ('pl'), ('ar'), ('he')) AS l(loc)
ON CONFLICT (entity_type, entity_id, field, target_locale) DO UPDATE
   SET source_text = EXCLUDED.source_text,
       source_hash = EXCLUDED.source_hash,
       status = 'done',
       attempts = 0,
       error = NULL,
       updated_at = now();
