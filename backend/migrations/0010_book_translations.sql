-- 0010_book_translations.sql — the getting-started book chapter in the 7 non-en
-- editions (SPEC §5B). en is served from the resources.ts base text (fallback).
-- Idempotent: ON CONFLICT DO UPDATE so re-applying refreshes the content. Applied
-- everywhere via the migration runner (dev, CI, and prod boot).
INSERT INTO content_translations (entity_type, entity_id, locale, field, value) VALUES
('book','getting-started','nl','content', $md$
# Aan de slag met Common Practice

Common Practice zet de alledaagse frustraties in je werk om in echte, opgeleverde tools — zonder dat iemand een nieuwe app hoeft te leren of productiecode hoeft te schrijven. Het draait als twee scoreborden die elkaar voeden.

## De twee sporen

**Uitdagingen** — iedereen plaatst een frustratie uit zijn eigen werkgebied; collega's stemmen op wat het oplossen waard is. De meest gestemde uitdagingen openen elke donderdag naar het Oplossingen-spoor.

**Oplossingen** — bouwers pakken een topuitdaging op en stellen een *flow* samen uit herbruikbare bouwblokken. Het bedrijf stemt op de beste, en de wekelijkse winnaar wordt via de normale productiepijplijn van IT onder platformgovernance gepromoveerd.

## Bouwen met de copilot

Een flow is een gerichte graaf van getypeerde blokken (categorieën: data · ai · logica · output · ui). Je stelt hem samen op een visueel canvas: sleep een blok uit het palet en verbind de outputpoort van het ene blok met de inputpoort van het volgende blok van een overeenkomend type. De graaf moet acyclisch blijven.

Je hoeft het niet met de hand te bedraden. Vraag de bouw-copilot in gewone taal ("vat de binnenkomende claim samen en markeer alles boven de drempel voor automatische goedkeuring") en hij bedient de builder voor je — hij vindt de juiste blokken, plaatst ze op het canvas, configureert ze en verbindt de poorten. Dit zijn dezelfde handelingen die jij zou uitvoeren, dus je kunt meekijken en op elk moment het roer overnemen.

## Draai het in je sandbox

Druk op **Test run** en de flow wordt echt uitgevoerd in je persoonlijke sandbox. Elke stap streamt een live trace — timing, kosten en een outputvoorbeeld per blok. Sandboxen draaien uitsluitend op testdata en raken nooit productiesystemen aan; AI-aanroepen worden bemiddeld en gemeten, met dagelijkse en wekelijkse limieten per gebruiker die vóór elke aanroep worden afgedwongen.

## De wekelijkse cadans

- **Maandag** — het stemmen op nieuwe uitdagingen opent.
- **Dinsdag & woensdag** — één uur per dag bouwen.
- **Donderdag 18:00** — het stemmen op uitdagingen en oplossingen sluit.
- **Vrijdag** — een korte gastlezing en de bekendmaking van de winnaar.

## Wat je nooit hoeft te doen

Iets lokaal installeren · productiedata aanraken · wachten op IT-goedkeuring om te beginnen met bouwen · een budget verantwoorden. Plaats een uitdaging in twee zinnen, of open je sandbox en remix een bestaande oplossing — geen enkel stukje werk gaat ooit verloren, omdat elke oplossing blijft bestaan als bouwblokken die iedereen kan hergebruiken.
$md$),
('book','getting-started','pl','content', $md$
# Pierwsze kroki z Common Practice

Common Practice zamienia codzienne frustracje w Twojej pracy w realne, wdrożone narzędzia — bez konieczności uczenia się nowej aplikacji czy pisania kodu produkcyjnego. Działa jako dwa rankingi, które wzajemnie się napędzają.

## Dwa nurty

**Wyzwania** — każdy może zgłosić frustrację z własnego obszaru pracy; współpracownicy głosują na to, co warto rozwiązać. Wyzwania z największą liczbą głosów przechodzą do nurtu Rozwiązań w każdy czwartek.

**Rozwiązania** — twórcy podejmują się najwyżej ocenionego wyzwania i komponują *przepływ* z gotowych do ponownego użycia bloków. Firma głosuje na najlepsze, a cotygodniowy zwycięzca trafia do wdrożenia poprzez standardowy proces produkcyjny działu IT, pod nadzorem ładu platformy.

## Twórz z asystentem (copilotem)

Przepływ to skierowany graf typowanych bloków (kategorie: data · ai · logic · output · ui). Komponujesz go na wizualnym płótnie: przeciągasz blok z palety i łączysz port wyjściowy jednego bloku z portem wejściowym kolejnego bloku o pasującym typie. Graf musi pozostać acykliczny.

Nie musisz łączyć tego ręcznie. Poproś asystenta budowania zwykłym językiem („podsumuj przychodzące roszczenie i oznacz wszystko, co przekracza próg automatycznego zatwierdzenia”), a obsłuży on kreator za Ciebie — znajdzie odpowiednie bloki, umieści je na płótnie, skonfiguruje je i połączy porty. Są to dokładnie te same czynności, które wykonałbyś samodzielnie, więc możesz obserwować i przejąć kontrolę w dowolnym momencie.

## Uruchom go w swoim środowisku testowym (sandboksie)

Naciśnij **Uruchom testowo**, a przepływ rzeczywiście wykona się w Twoim osobistym sandboksie. Każdy krok przesyła na żywo ślad wykonania — czas, koszt oraz podgląd wyniku dla każdego bloku. Sandboksy działają wyłącznie na danych testowych i nigdy nie dotykają systemów produkcyjnych; wywołania AI są pośredniczone i rozliczane, z egzekwowaniem dziennych i tygodniowych limitów na użytkownika przed każdym wywołaniem.

## Tygodniowy rytm

- **Poniedziałek** — otwarcie głosowania na nowe wyzwania.
- **Wtorek i środa** — jedna godzina dziennie na budowanie.
- **Czwartek 18:00** — zamknięcie głosowania na wyzwania i rozwiązania.
- **Piątek** — krótka prelekcja gościa i ogłoszenie zwycięzcy.

## Czego nigdy nie musisz robić

Instalować czegokolwiek lokalnie · dotykać danych produkcyjnych · czekać na zgodę działu IT, by zacząć budować · uzasadniać budżetu. Zgłoś wyzwanie w dwóch zdaniach albo otwórz swój sandboks i przerób istniejące rozwiązanie — żadna z tych prac nigdy się nie marnuje, ponieważ każde rozwiązanie pozostaje zbiorem bloków, które każdy może wykorzystać ponownie.
$md$),
('book','getting-started','fr','content', $md$
# Premiers pas avec Common Practice

Common Practice transforme les frustrations quotidiennes de votre travail en outils concrets et déployés — sans que personne ait à apprendre une nouvelle application ou à écrire du code de production. La plateforme fonctionne comme deux classements qui s'alimentent mutuellement.

## Les deux volets

**Défis** — chacun publie une frustration issue de son propre domaine d'activité ; les collègues votent pour ce qui mérite d'être résolu. Les défis les plus plébiscités s'ouvrent au volet Solutions chaque jeudi.

**Solutions** — les créateurs s'emparent d'un défi en tête de classement et composent un *flux* à partir de blocs réutilisables. L'entreprise vote pour le meilleur, et le lauréat de la semaine est promu via la chaîne de production habituelle de la DSI, sous la gouvernance de la plateforme.

## Construire avec le copilote

Un flux est un graphe orienté de blocs typés (catégories : data · ai · logic · output · ui). Vous le composez sur un canevas visuel : faites glisser un bloc depuis la palette et reliez le port de sortie d'un bloc au port d'entrée du bloc suivant, du même type. Le graphe doit rester acyclique.

Vous n'avez pas à tout câbler à la main. Demandez au copilote de construction en langage courant (« résume la demande d'indemnisation entrante et signale tout ce qui dépasse le seuil d'approbation automatique ») et il pilote le constructeur à votre place — en trouvant les bons blocs, en les déposant sur le canevas, en les configurant et en reliant les ports. Ce sont exactement les mêmes actions que vous effectueriez, vous pouvez donc observer et reprendre la main à tout moment.

## L'exécuter dans votre bac à sable

Appuyez sur **Test run** et le flux s'exécute réellement dans votre bac à sable personnel. Chaque étape diffuse une trace en direct — durée, coût et un aperçu de la sortie pour chaque bloc. Les bacs à sable ne fonctionnent qu'avec des données fictives et ne touchent jamais aux systèmes de production ; les appels à l'IA sont gérés par un intermédiaire et mesurés, avec des limites quotidiennes et hebdomadaires par utilisateur appliquées avant chaque appel.

## Le rythme hebdomadaire

- **Lundi** — ouverture des votes sur les nouveaux défis.
- **Mardi et mercredi** — une heure de construction par jour.
- **Jeudi 18:00** — clôture des votes sur les défis et les solutions.
- **Vendredi** — une courte intervention d'un invité et l'annonce du lauréat.

## Ce que vous n'avez jamais à faire

Installer quoi que ce soit en local · toucher aux données de production · attendre l'aval de la DSI pour commencer à construire · justifier un budget. Publiez un défi en deux phrases, ou ouvrez votre bac à sable et remixez une solution existante — aucun travail n'est jamais perdu, car chaque solution subsiste sous forme de blocs que chacun peut réutiliser.
$md$),
('book','getting-started','es','content', $md$
# Primeros pasos con Common Practice

Common Practice convierte las frustraciones cotidianas de tu trabajo en herramientas reales y listas para usar, sin que nadie tenga que aprender una nueva aplicación ni escribir código de producción. Funciona como dos tablas de clasificación que se alimentan entre sí.

## Las dos vertientes

**Desafíos** — cualquiera publica una frustración de su propia área de trabajo; los colegas votan qué vale la pena resolver. Los desafíos más votados se abren a la vertiente de Soluciones cada jueves.

**Soluciones** — los constructores toman un desafío destacado y componen un *flujo* a partir de bloques reutilizables. La empresa vota por el mejor, y el ganador semanal se promueve a través del canal de producción habitual de TI bajo la gobernanza de la plataforma.

## Construye con el copiloto

Un flujo es un grafo dirigido de bloques tipados (categorías: data · ai · logic · output · ui). Lo compones en un lienzo visual: arrastra un bloque desde la paleta y conecta el puerto de salida de un bloque con el puerto de entrada de tipo compatible del siguiente. El grafo debe mantenerse acíclico.

No tienes que conectarlo todo a mano. Pídeselo al copiloto de construcción en lenguaje natural ("resume la reclamación entrante y marca todo lo que supere el umbral de aprobación automática") y este maneja el constructor por ti: encuentra los bloques adecuados, los coloca en el lienzo, los configura y conecta los puertos. Son las mismas acciones que tú harías, así que puedes observar y tomar el control en cualquier momento.

## Ejecútalo en tu entorno de pruebas

Pulsa **Ejecución de prueba** y el flujo se ejecuta de verdad en tu entorno de pruebas personal. Cada paso transmite una traza en vivo: tiempo, costo y una vista previa del resultado por bloque. Los entornos de pruebas funcionan únicamente con datos simulados y nunca tocan los sistemas de producción; las llamadas a la IA se gestionan y se contabilizan, con límites diarios y semanales por usuario que se aplican antes de cada llamada.

## La cadencia semanal

- **Lunes** — se abre la votación de nuevos desafíos.
- **Martes y miércoles** — una hora al día de construcción.
- **Jueves 18:00** — se cierra la votación de desafíos y soluciones.
- **Viernes** — una breve charla invitada y el anuncio del ganador.

## Lo que nunca tienes que hacer

Instalar nada de forma local · tocar datos de producción · esperar la aprobación de TI para empezar a construir · justificar un presupuesto. Publica un desafío en dos frases, o abre tu entorno de pruebas y reinventa una solución existente: ningún trabajo se desperdicia jamás, porque cada solución permanece como bloques de construcción que cualquiera puede reutilizar.
$md$),
('book','getting-started','de','content', $md$
# Erste Schritte mit Common Practice

Common Practice verwandelt die alltäglichen Ärgernisse in Ihrer Arbeit in echte, ausgelieferte Werkzeuge — ohne dass jemand eine neue App erlernen oder Produktivcode schreiben muss. Es läuft als zwei Bestenlisten, die sich gegenseitig speisen.

## Die zwei Stränge

**Herausforderungen** — jede und jeder veröffentlicht ein Ärgernis aus dem eigenen Arbeitsbereich; Kolleginnen und Kollegen stimmen darüber ab, was es wert ist, gelöst zu werden. Die am häufigsten gewählten Herausforderungen werden jeden Donnerstag für den Lösungsstrang freigegeben.

**Lösungen** — Entwickelnde greifen eine der besten Herausforderungen auf und stellen aus wiederverwendbaren Bausteinen einen *Flow* zusammen. Das Unternehmen stimmt über die beste Lösung ab, und die wöchentliche Gewinnerlösung wird über die reguläre Produktions-Pipeline der IT unter der Plattform-Governance ausgerollt.

## Bauen Sie mit dem Copilot

Ein Flow ist ein gerichteter Graph aus typisierten Bausteinen (Kategorien: data · ai · logic · output · ui). Sie stellen ihn auf einer visuellen Arbeitsfläche zusammen: Ziehen Sie einen Baustein aus der Palette und verbinden Sie den Ausgangsport eines Bausteins mit dem Eingangsport des nächsten Bausteins eines passenden Typs. Der Graph muss azyklisch bleiben.

Sie müssen ihn nicht von Hand verdrahten. Bitten Sie den Build-Copilot in normaler Sprache („Fasse die eingehende Schadenmeldung zusammen und markiere alles, was über der Schwelle für die automatische Freigabe liegt") und er bedient den Builder für Sie — er findet die passenden Bausteine, platziert sie auf der Arbeitsfläche, konfiguriert sie und verbindet die Ports. Das sind genau die Schritte, die Sie auch selbst ausführen würden, sodass Sie zusehen und jederzeit übernehmen können.

## Führen Sie ihn in Ihrer Sandbox aus

Drücken Sie **Testlauf** und der Flow wird tatsächlich in Ihrer persönlichen Sandbox ausgeführt. Jeder Schritt liefert eine Live-Ablaufverfolgung — Zeitdauer, Kosten und eine Ausgabevorschau pro Baustein. Sandboxes laufen ausschließlich mit Testdaten und greifen niemals auf Produktivsysteme zu; KI-Aufrufe werden vermittelt und gemessen, wobei tägliche und wöchentliche Limits pro Nutzer vor jedem Aufruf durchgesetzt werden.

## Der wöchentliche Rhythmus

- **Montag** — die Abstimmung über neue Herausforderungen wird geöffnet.
- **Dienstag & Mittwoch** — jeweils eine Stunde pro Tag zum Bauen.
- **Donnerstag 18:00** — die Abstimmung über Herausforderungen und Lösungen schließt.
- **Freitag** — ein kurzer Gastvortrag und die Bekanntgabe der Gewinnerlösung.

## Was Sie nie tun müssen

Etwas lokal installieren · Produktivdaten anfassen · auf eine IT-Freigabe warten, um mit dem Bauen zu beginnen · ein Budget rechtfertigen. Veröffentlichen Sie eine Herausforderung in zwei Sätzen oder öffnen Sie Ihre Sandbox und remixen Sie eine bestehende Lösung — keine dieser Arbeiten ist je vergeudet, denn jede Lösung bleibt als Bausteine erhalten, die jede und jeder wiederverwenden kann.
$md$),
('book','getting-started','ar','content', $md$
# البدء مع Common Practice

يحوّل Common Practice الإحباطات اليومية في عملك إلى أدوات حقيقية جاهزة للاستخدام — دون أن يضطر أحد إلى تعلّم تطبيق جديد أو كتابة شيفرة إنتاجية. يعمل النظام على شكل لوحتي صدارة تغذّي إحداهما الأخرى.

## المساران

**التحديات** — يمكن لأي شخص أن ينشر إحباطًا من مجال عمله الخاص؛ ويصوّت الزملاء على ما يستحق الحل. تُفتَح التحديات الأكثر تصويتًا أمام مسار الحلول في كل يوم خميس.

**الحلول** — يلتقط المطوّرون أحد التحديات البارزة ويؤلّفون *تدفقًا* من لبنات بناء قابلة لإعادة الاستخدام. تصوّت الشركة على الأفضل، ويُرقّى الفائز الأسبوعي عبر خط الإنتاج المعتاد لقسم تقنية المعلومات في ظل حوكمة المنصّة.

## ابنِ مع المساعد الذكي

التدفّق هو رسم بياني موجّه من لبنات ذات أنواع محدّدة (الفئات: data · ai · logic · output · ui). تؤلّفه على لوحة مرئية: اسحب لبنة من اللوحة واربط منفذ الخرج لإحدى اللبنات بمنفذ الدخل المطابق النوع للبنة التالية. يجب أن يبقى الرسم البياني خاليًا من الدورات.

لست مضطرًا إلى توصيله يدويًا. اطلب من المساعد الذكي للبناء بلغة طبيعية ("لخّص المطالبة الواردة وأشِر إلى أي شيء يتجاوز عتبة الموافقة التلقائية") وسيتولّى تشغيل أداة البناء نيابةً عنك — إذ يعثر على اللبنات المناسبة، ويضعها على اللوحة، ويهيّئها، ويربط المنافذ. هذه هي الإجراءات نفسها التي كنت ستقوم بها، لذا يمكنك المراقبة وتولّي الأمر في أي لحظة.

## شغّله في بيئتك المعزولة

اضغط على زر **Test run** ليُنفَّذ التدفّق فعليًا في بيئتك المعزولة الخاصة. تبثّ كل خطوة تتبّعًا حيًّا — التوقيت والتكلفة ومعاينة للخرج لكل لبنة. تعمل البيئات المعزولة على بيانات وهمية فقط ولا تمسّ أنظمة الإنتاج إطلاقًا؛ وتُدار استدعاءات الذكاء الاصطناعي عبر وسيط وتُقاس، مع فرض حدود يومية وأسبوعية لكل مستخدم قبل كل استدعاء.

## الإيقاع الأسبوعي

- **الاثنين** — يُفتَح التصويت على التحديات الجديدة.
- **الثلاثاء والأربعاء** — ساعة بناء واحدة يوميًا.
- **الخميس 18:00** — يُغلَق التصويت على التحديات والحلول.
- **الجمعة** — كلمة قصيرة لضيف وإعلان الفائز.

## ما لن تضطر إلى فعله أبدًا

تثبيت أي شيء محليًا · المساس ببيانات الإنتاج · انتظار موافقة قسم تقنية المعلومات لبدء البناء · تبرير ميزانية. انشر تحديًا في جملتين، أو افتح بيئتك المعزولة وأعد مزج حلٍّ قائم — لا يضيع أيٌّ من العمل أبدًا، لأن كل حل يبقى على شكل لبنات بناء يمكن لأي شخص إعادة استخدامها.
$md$),
('book','getting-started','he','content', $md$
# תחילת העבודה עם Common Practice

Common Practice הופך את התסכולים היומיומיים בעבודה שלך לכלים אמיתיים ופעילים — בלי שאף אחד ילמד אפליקציה חדשה או יכתוב קוד ייצור. הוא פועל כשני לוחות תוצאות שמזינים זה את זה.

## שני המסלולים

**אתגרים** — כל אחד מפרסם תסכול מתחום העבודה שלו; עמיתים מצביעים על מה ששווה לפתור. האתגרים שזכו למרב הקולות נפתחים למסלול הפתרונות בכל יום חמישי.

**פתרונות** — בונים בוחרים אתגר מוביל ומרכיבים *תזרים* מאבני בניין לשימוש חוזר. החברה מצביעה על הטוב ביותר, והזוכה השבועי מקודם דרך צינור הייצור הרגיל של מחלקת ה-IT תחת ממשל הפלטפורמה.

## בנייה בעזרת הקופיילוט

תזרים הוא גרף מכוון של בלוקים מטופסים (קטגוריות: data · ai · logic · output · ui). אתה מרכיב אותו על קנבס חזותי: גורר בלוק מהפלטה ומחבר את פורט הפלט של בלוק אחד לפורט הקלט של הבלוק הבא מטיפוס תואם. הגרף חייב להישאר נטול מעגלים.

אינך חייב לחווט אותו ידנית. בקש מקופיילוט הבנייה בשפה פשוטה ("סכם את התביעה הנכנסת וסמן כל דבר מעל סף האישור האוטומטי") והוא מפעיל עבורך את הבונה — מאתר את הבלוקים הנכונים, מניח אותם על הקנבס, מגדיר אותם, ומחבר את הפורטים. אלה אותן הפעולות שהיית מבצע בעצמך, כך שתוכל לצפות ולהשתלט בכל רגע.

## הרצה בארגז החול שלך

לחץ על **הרצת בדיקה** והתזרים מתבצע באמת בארגז החול האישי שלך. כל שלב משדר עקבות חיות — תזמון, עלות, ותצוגה מקדימה של פלט לכל בלוק. ארגזי החול פועלים על נתוני דמה בלבד ולעולם אינם נוגעים במערכות ייצור; קריאות ה-AI מתווכות ונמדדות, עם הגבלות יומיות ושבועיות לכל משתמש שנאכפות לפני כל קריאה.

## המקצב השבועי

- **יום שני** — ההצבעה על אתגרים חדשים נפתחת.
- **יום שלישי ויום רביעי** — שעה אחת ביום של בנייה.
- **יום חמישי 18:00** — ההצבעה על אתגרים ופתרונות נסגרת.
- **יום שישי** — הרצאת אורח קצרה והכרזת הזוכה.

## מה שלעולם אינך צריך לעשות

להתקין שום דבר באופן מקומי · לגעת בנתוני ייצור · להמתין לאישור מ-IT כדי להתחיל לבנות · להצדיק תקציב. פרסם אתגר בשני משפטים, או פתח את ארגז החול שלך ועבד מחדש על פתרון קיים — אף עבודה אינה יורדת לטמיון, מפני שכל פתרון נשמר כאבני בניין שכל אחד יכול לעשות בהן שימוש חוזר.
$md$)
ON CONFLICT (entity_type, entity_id, locale, field) DO UPDATE
  SET value = EXCLUDED.value, updated_at = now();
