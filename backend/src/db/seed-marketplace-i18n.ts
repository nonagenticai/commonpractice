// src/db/seed-marketplace-i18n.ts — §5B deep i18n of user-generated content.
// Seeds content_translations for the demo marketplace (the 5 challenges' title/
// description/business_impact + the 5 solution titles) in the 7 non-en locales, so
// switching locale visibly localizes the marketplace. EN is the base column (no row).
//
// Why a CODE seed and not a SQL migration: challenges/solutions are seeded with
// RANDOM uuids, so their ids are not known at migration-author time. We resolve the
// row here and upsert on the content_translations unique key. Runs via seedAll()
// (incl. the SEED_DEMO_DATA boot path) + CI `bun run seed`.
//
// ⛔ THE ROW LOOKUP IS TENANT-SCOPED *AND* KEYED ON A UNIQUE COLUMN. THE SECOND HALF IS THE ONE
// THAT DOES THE WORK BY DEFAULT — this paragraph used to imply otherwise and was wrong.
// Both resolvers used to be `.where(eq(<table>.title, …)).limit(1)` — no tenant predicate and no
// ORDER BY. `challenges.title` is not unique in any sense the database enforces, so whichever row
// Postgres handed back first received these 7 locales: heap order, a function of the last UPDATE or
// VACUUM, not of anything a reader could name. The visible symptom is a marketplace screen that is
// Dutch after one seed run and English after the next, on the same database, with no code change in
// between.
//
// ⚠️ CORRECTED — WHAT THE TENANT PREDICATE DOES AND DOES NOT BUY. The sentence that stood here
// named "Auto-summarize claim forms" as seeded by BOTH this marketplace seed (into DEMO_TENANT_ID)
// and `seed-tenant-showcase.ts` "into whatever tenant `TENANT_SHOWCASE_ID` names", which reads as
// two rows in two tenants. Measured, IN THE DEFAULT CONFIGURATION THAT IS NOT TRUE:
//   * `config.ts:301` is `tenantShowcaseId: process.env.TENANT_SHOWCASE_ID || DEMO_TENANT_ID` —
//     unset, the showcase writes into THE SAME TENANT as the marketplace;
//   * and the showcase is idempotent by `(tenant_id, title)` (seed-tenant-showcase.ts:353), so in
//     that tenant it MATCHES the marketplace's own row rather than adding a second one — it only
//     self-heals the row's `code`, and both files already spell that code `CH-284`.
// So by default `eq(challenges.tenant_id, DEMO_TENANT_ID)` excludes nothing: there is one row.
// It earns its keep in the cases where a foreign row genuinely exists — a deployment that SETS
// `TENANT_SHOWCASE_ID`, rows left in the pre-C.1 per-USER tenants (`u-<hex>`), and this repo's own
// suite, where three test files seed this title into other tenants against one database.
// The predicate that makes the pick unique in the ORDINARY case is the one below it: within a
// tenant, `code` is index-unique and `title` is not. Do not delete the tenant predicate on the
// strength of "it separates nothing by default" — it is the half that holds when the ids differ,
// and it is the half `tests/seed-marketplace-i18n-tenant-scope.test.ts`'s negative control reverts.
//
// The fix is a key that is unique BY CONSTRUCTION rather than by hope:
//   * challenges → `(tenant_id, code)`, which carries the partial unique index
//     `challenges_tenant_code_key` (schema.ts:760, `WHERE code IS NOT NULL`). Our predicate pins a
//     non-null literal code, so at most one row can match and no ORDER BY is needed to make the
//     result deterministic. `code` is the CH-nnn display badge seed-marketplace.ts stamps on
//     INSERT; the two lists are checked against each other by the positive half of
//     tests/seed-marketplace-i18n-tenant-scope.test.ts, so a drifting code reds rather than
//     silently seeding nothing.
//   * solutions → `(tenant_id, challenge_id, title)`, which is exactly the idempotency key
//     seed-marketplace.ts itself writes against (all five seeded solutions hang off challenge #1).
//     No DB constraint backs it, so `asc(solutions.id)` pins the tie-break: ids are uuidv7, so
//     ascending id is oldest-first — the seeded row wins over anything created later.
//
// Translations are a machine (Claude) pass over the EN source; a native QA remains
// reasonable (SPEC honest-note). Idempotent: onConflictDoUpdate refreshes the value.
import { and, asc, eq } from 'drizzle-orm';
import { db, challenges, solutions, contentTranslations } from './client';
import { DEMO_TENANT_ID } from '../config';

interface ChallengeI18n {
  enTitle: string;
  /** The CH-nnn display badge seed-marketplace.ts stamps on this challenge. Together with
   *  DEMO_TENANT_ID this is the row's unique key — see the header. `enTitle` stays because it is
   *  what makes the block of translations below readable, but it is no longer the lookup key. */
  code: string;
  locales: Record<string, { title: string; description: string; business_impact: string }>;
}
interface SolutionI18n {
  enTitle: string;
  locales: Record<string, { title: string }>;
}

const DATA: { challenges: ChallengeI18n[]; solutions: SolutionI18n[] } = {
  "challenges": [
    {
      "enTitle": "Auto-summarize claim forms",
      "code": "CH-284",
      "locales": {
        "nl": {
          "title": "Schadeformulieren automatisch samenvatten",
          "description": "Elke dinsdag krijg ik een stapel schade-PDF's te verwerken — meestal 40 tot 60 formulieren. Elk formulier kost me ongeveer 4 minuten om te lezen, de belangrijkste velden eruit te halen en een 3-regelige samenvatting te schrijven die ik in het dossier kan plakken. Dat is ongeveer 3 uur, elke dinsdag, voordat ik überhaupt begin aan het echte werk van het beoordelen van de schadeclaims. De formulieren zijn niet gestandaardiseerd — elke tussenpersoon gebruikt zijn eigen sjabloon.",
          "business_impact": "~3 uur/week per schadebehandelaar × 28 medewerkers bij Claims NL. Verlaagt de achterstand in dossierbehandeling met naar schatting 12%."
        },
        "pl": {
          "title": "Automatyczne streszczanie formularzy roszczeń",
          "description": "W każdy wtorek dostaję stos plików PDF z roszczeniami do obsługi — zwykle od 40 do 60 formularzy. Przeczytanie każdego z nich, wyłuskanie kluczowych pól i napisanie 3-liniowego streszczenia, które mogę wkleić do akt sprawy, zajmuje mi około 4 minut. To około 3 godziny, w każdy wtorek, zanim w ogóle zacznę właściwą pracę nad oceną roszczeń. Formularze nie są standardowe — każdy pośrednik używa własnego szablonu.",
          "business_impact": "~3 godz./tydz. na pracownika ds. roszczeń × 28 osób w Claims NL. Zmniejsza zaległości w obsłudze spraw o szacunkowo 12%."
        },
        "fr": {
          "title": "Résumer automatiquement les formulaires de sinistre",
          "description": "Chaque mardi, je reçois une pile de PDF de sinistres à traiter — généralement 40 à 60 formulaires. Chacun me prend environ 4 minutes à lire, à en extraire les champs clés et à rédiger un résumé en 3 lignes que je peux coller dans le dossier. Cela représente environ 3 heures, chaque mardi, avant même de commencer le vrai travail d'évaluation des sinistres. Les formulaires ne sont pas standardisés — chaque intermédiaire utilise son propre modèle.",
          "business_impact": "~3 h/semaine par chargé de sinistres × 28 collaborateurs au sein de Claims NL. Réduit le retard de traitement des dossiers d'environ 12 %."
        },
        "es": {
          "title": "Resumir formularios de siniestros automáticamente",
          "description": "Cada martes recibo una pila de PDF de siniestros para procesar, normalmente de 40 a 60 formularios. Cada uno me lleva unos 4 minutos: leerlo, extraer los campos clave y redactar un resumen de 3 líneas que pueda pegar en el expediente. Eso suma unas 3 horas, todos los martes, antes incluso de empezar el trabajo real de evaluar los siniestros. Los formularios no son estándar: cada intermediario usa su propia plantilla.",
          "business_impact": "~3 h/semana por gestor de siniestros × 28 personas en Siniestros NL. Reduce el atasco de gestión de expedientes en un 12% estimado."
        },
        "de": {
          "title": "Schadenformulare automatisch zusammenfassen",
          "description": "Jeden Dienstag bekomme ich einen Stapel Schaden-PDFs zur Bearbeitung — typischerweise 40 bis 60 Formulare. Für jedes brauche ich etwa 4 Minuten, um es zu lesen, die wichtigsten Felder herauszuziehen und eine 3-zeilige Zusammenfassung zu schreiben, die ich in die Fallakte einfügen kann. Das sind etwa 3 Stunden, jeden Dienstag, bevor ich überhaupt mit der eigentlichen Arbeit der Schadenprüfung beginne. Die Formulare sind nicht standardisiert — jeder Vermittler verwendet seine eigene Vorlage.",
          "business_impact": "~3 Std./Woche pro Schadensachbearbeiter × 28 Mitarbeitende in Claims NL. Reduziert den Bearbeitungsrückstand um geschätzte 12 %."
        },
        "ar": {
          "title": "تلخيص نماذج المطالبات تلقائيًا",
          "description": "كل يوم ثلاثاء تصلني كومة من ملفات المطالبات بصيغة PDF لمعالجتها — عادةً ما بين 40 و60 نموذجًا. يستغرق كل نموذج نحو 4 دقائق لقراءته واستخراج الحقول الرئيسية وكتابة ملخص من 3 أسطر يمكنني لصقه في ملف الحالة. هذا يعني نحو 3 ساعات، كل يوم ثلاثاء، قبل حتى أن أبدأ العمل الفعلي في البتّ بالمطالبات. النماذج غير موحّدة — فكل وسيط يستخدم قالبه الخاص.",
          "business_impact": "~3 ساعات أسبوعيًا لكل موظف مطالبات × 28 موظفًا في قسم المطالبات NL. يقلّص تراكم معالجة الحالات بنسبة تُقدَّر بـ 12%."
        },
        "he": {
          "title": "סיכום אוטומטי של טופסי תביעות",
          "description": "כל יום שלישי אני מקבל ערימה של קובצי PDF של תביעות לטיפול — בדרך כלל 40 עד 60 טפסים. כל אחד לוקח בערך 4 דקות לקרוא, לחלץ את השדות המרכזיים ולכתוב סיכום של 3 שורות שאני יכול להדביק לתיק. זה בערך 3 שעות, כל יום שלישי, עוד לפני שאני בכלל מתחיל בעבודה האמיתית של הערכת התביעות. הטפסים אינם אחידים — כל מתווך משתמש בתבנית משלו.",
          "business_impact": "~3 שעות בשבוע לכל מטפל תביעות × 28 עובדים במחלקת התביעות ב-NL. מצמצם את עומס תיקי הטיפול בכ-12%."
        }
      }
    },
    {
      "enTitle": "Compare policies in natural language",
      "code": "CH-241",
      "locales": {
        "nl": {
          "title": "Polissen vergelijken in natuurlijke taal",
          "description": "Als een klant vraagt hoe twee van onze polissen verschillen, lees ik beide documenten van begin tot eind en schrijf ik de verschillen met de hand uit. Het is traag en het is makkelijk om een clausule te missen.",
          "business_impact": "Elke verkoopadviseur loopt hier meerdere keren per week tegenaan. Snellere, nauwkeurigere vergelijkingen betekenen minder verkeerd verkochte polissen."
        },
        "pl": {
          "title": "Porównywanie polis w języku naturalnym",
          "description": "Gdy klient pyta, czym różnią się dwie nasze polisy, czytam oba dokumenty od początku do końca i ręcznie spisuję różnice. To powolne i łatwo przeoczyć jakiś zapis.",
          "business_impact": "Każdy doradca sprzedaży styka się z tym kilka razy w tygodniu. Szybsze i dokładniejsze porównania oznaczają mniej błędnie sprzedanych polis."
        },
        "fr": {
          "title": "Comparer les contrats en langage naturel",
          "description": "Quand un client demande en quoi deux de nos contrats diffèrent, je lis les deux documents de bout en bout et je rédige les différences à la main. C'est lent et il est facile de passer à côté d'une clause.",
          "business_impact": "Chaque conseiller commercial y est confronté plusieurs fois par semaine. Des comparaisons plus rapides et plus précises réduisent le nombre de contrats mal vendus."
        },
        "es": {
          "title": "Comparar pólizas en lenguaje natural",
          "description": "Cuando un cliente pregunta en qué se diferencian dos de nuestras pólizas, leo ambos documentos de principio a fin y redacto las diferencias a mano. Es lento y es fácil pasar por alto una cláusula.",
          "business_impact": "Cada asesor comercial se topa con esto varias veces por semana. Comparaciones más rápidas y precisas significan menos pólizas mal vendidas."
        },
        "de": {
          "title": "Policen in natürlicher Sprache vergleichen",
          "description": "Wenn ein Kunde fragt, wie sich zwei unserer Policen unterscheiden, lese ich beide Dokumente von Anfang bis Ende und schreibe die Unterschiede von Hand auf. Das ist langsam, und es ist leicht, eine Klausel zu übersehen.",
          "business_impact": "Jeder Vertriebsberater stößt mehrmals pro Woche darauf. Schnellere, genauere Vergleiche bedeuten weniger fehlerhaft verkaufte Policen."
        },
        "ar": {
          "title": "مقارنة وثائق التأمين باللغة الطبيعية",
          "description": "عندما يسألني العميل عن الفرق بين اثنتين من وثائق تأميننا، أقرأ كلتا الوثيقتين من أولهما إلى آخرهما وأدوّن الفروق يدويًا. الأمر بطيء ومن السهل أن يفوتني أحد البنود.",
          "business_impact": "يواجه كل مستشار مبيعات هذا الموقف عدة مرات أسبوعيًا. المقارنات الأسرع والأدقّ تعني عددًا أقل من الوثائق المُباعة بشكل غير ملائم."
        },
        "he": {
          "title": "השוואת פוליסות בשפה טבעית",
          "description": "כשלקוח שואל במה שתי פוליסות שלנו נבדלות, אני קורא את שני המסמכים מתחילתם ועד סופם וכותב את ההבדלים ידנית. זה איטי וקל לפספס סעיף.",
          "business_impact": "כל יועץ מכירות נתקל בזה כמה פעמים בשבוע. השוואות מהירות ומדויקות יותר משמעותן פחות פוליסות שנמכרו שלא כראוי."
        }
      }
    },
    {
      "enTitle": "Auto-categorize customer email",
      "code": "CH-203",
      "locales": {
        "nl": {
          "title": "Klant-e-mail automatisch categoriseren",
          "description": "Onze gedeelde service-inbox krijgt honderden e-mails per dag en een medewerker verdeelt elke e-mail handmatig naar het juiste team. De meeste zijn al na de eerste regel duidelijk.",
          "business_impact": "Het sorteren kost het equivalent van een fulltime functie. Het automatisch routeren van de voor de hand liggende gevallen maakt die persoon vrij voor de lastige gevallen."
        },
        "pl": {
          "title": "Automatyczna kategoryzacja e-maili od klientów",
          "description": "Nasza wspólna skrzynka odbiorcza działu obsługi dostaje setki e-maili dziennie, a człowiek kieruje każdy z nich do właściwego zespołu. Większość jest oczywista już od pierwszej linijki.",
          "business_impact": "Segregacja zajmuje równowartość jednego pełnego etatu. Automatyczne kierowanie tych oczywistych przypadków uwalnia tę osobę do trudniejszych spraw."
        },
        "fr": {
          "title": "Catégoriser automatiquement les e-mails clients",
          "description": "Notre boîte de réception partagée reçoit des centaines d'e-mails par jour et un humain trie chacun d'eux vers la bonne équipe. La plupart sont évidents dès la première ligne.",
          "business_impact": "Le tri représente l'équivalent d'un poste à temps plein. Acheminer automatiquement les cas évidents libère cette personne pour les cas difficiles."
        },
        "es": {
          "title": "Categorizar el correo de clientes automáticamente",
          "description": "Nuestra bandeja de entrada compartida del servicio recibe cientos de correos al día y una persona clasifica cada uno hacia el equipo correcto. La mayoría se identifican con la primera línea.",
          "business_impact": "La clasificación equivale a un puesto a tiempo completo. Enrutar automáticamente los casos obvios libera a esa persona para los casos difíciles."
        },
        "de": {
          "title": "Kunden-E-Mails automatisch kategorisieren",
          "description": "Unser gemeinsames Service-Postfach erhält täglich Hunderte von E-Mails, und ein Mensch sortiert jede einzelne dem richtigen Team zu. Die meisten sind schon an der ersten Zeile offensichtlich.",
          "business_impact": "Die Triage entspricht einer vollen Vollzeitstelle. Das automatische Routing der offensichtlichen Fälle gibt dieser Person Zeit für die schwierigen Fälle."
        },
        "ar": {
          "title": "تصنيف بريد العملاء تلقائيًا",
          "description": "يستقبل صندوق الخدمة المشترك لدينا مئات الرسائل يوميًا، ويقوم موظف بفرز كل رسالة وتوجيهها إلى الفريق المناسب. معظمها يكون واضحًا من السطر الأول.",
          "business_impact": "يستهلك الفرز ما يعادل وظيفة بدوام كامل. توجيه الرسائل الواضحة تلقائيًا يحرّر ذلك الشخص للتفرّغ للحالات الصعبة."
        },
        "he": {
          "title": "קטלוג אוטומטי של אימיילים מלקוחות",
          "description": "תיבת השירות המשותפת שלנו מקבלת מאות אימיילים ביום ואדם ממיין כל אחד מהם לצוות הנכון. רובם ברורים כבר מהשורה הראשונה.",
          "business_impact": "המיון שווה ערך לתפקיד מלא אחד. ניתוב אוטומטי של הברורים מפנה את אותו אדם למקרים הקשים."
        }
      }
    },
    {
      "enTitle": "Compliance checks on contract changes",
      "code": "CH-178",
      "locales": {
        "nl": {
          "title": "Compliancecontroles op contractwijzigingen",
          "description": "Als een contract wordt aangepast, controleer ik elke wijziging handmatig aan de hand van ons compliance-reglement. Het reglement is 60 pagina's.",
          "business_impact": "De handmatige controle is het knelpunt voordat een contractwijziging live kan. Het automatisch opsporen van problemen verlaagt het risico van elke aanpassing."
        },
        "pl": {
          "title": "Kontrole zgodności przy zmianach w umowach",
          "description": "Gdy umowa zostaje zmieniona, ręcznie sprawdzam każdą zmianę pod kątem naszego zbioru zasad zgodności. Zbiór zasad liczy 60 stron.",
          "business_impact": "Ręczna weryfikacja to wąskie gardło, zanim jakakolwiek zmiana w umowie może wejść w życie. Automatyczne wychwytywanie problemów zmniejsza ryzyko każdej poprawki."
        },
        "fr": {
          "title": "Contrôles de conformité sur les modifications de contrat",
          "description": "Quand un contrat est modifié, je vérifie chaque changement à la main par rapport à notre référentiel de conformité. Le référentiel fait 60 pages.",
          "business_impact": "La revue manuelle est le goulot d'étranglement avant qu'une modification de contrat puisse être déployée. Détecter les problèmes automatiquement réduit le risque de chaque avenant."
        },
        "es": {
          "title": "Verificaciones de cumplimiento en cambios de contrato",
          "description": "Cuando se modifica un contrato, reviso cada cambio a mano contra nuestro manual de normas de cumplimiento. El manual tiene 60 páginas.",
          "business_impact": "La revisión manual es el cuello de botella antes de poder aplicar cualquier cambio de contrato. Detectar los problemas automáticamente reduce el riesgo de cada modificación."
        },
        "de": {
          "title": "Compliance-Prüfungen bei Vertragsänderungen",
          "description": "Wenn ein Vertrag geändert wird, prüfe ich jede Änderung von Hand anhand unseres Compliance-Regelwerks. Das Regelwerk ist 60 Seiten lang.",
          "business_impact": "Die manuelle Prüfung ist der Engpass, bevor eine Vertragsänderung umgesetzt werden kann. Probleme automatisch zu erkennen, verringert das Risiko jeder Änderung."
        },
        "ar": {
          "title": "فحوصات الامتثال على تعديلات العقود",
          "description": "عندما يُعدَّل عقد ما، أراجع كل تغيير مقابل دليل قواعد الامتثال لدينا يدويًا. ويقع الدليل في 60 صفحة.",
          "business_impact": "المراجعة اليدوية هي عنق الزجاجة قبل إطلاق أي تعديل على العقد. واكتشاف المشكلات تلقائيًا يقلّل المخاطر في كل تعديل."
        },
        "he": {
          "title": "בדיקות ציות לשינויים בחוזים",
          "description": "כשחוזה מתוקן אני בודק כל שינוי מול ספר הכללים שלנו לציות, ידנית. ספר הכללים הוא בן 60 עמודים.",
          "business_impact": "הבדיקה הידנית היא צוואר הבקבוק לפני שכל שינוי בחוזה יכול לצאת לדרך. זיהוי בעיות באופן אוטומטי מפחית את הסיכון בכל תיקון."
        }
      }
    },
    {
      "enTitle": "Visibility into churn signals per segment",
      "code": "CH-162",
      "locales": {
        "nl": {
          "title": "Inzicht in churn-signalen per segment",
          "description": "Ik wil kunnen zien welke klantsegmenten vroege churn-signalen vertonen zonder eerst drie dashboards naar een spreadsheet te exporteren.",
          "business_impact": "Het eerder detecteren van churn per segment laat ons retentiebudget inzetten waar het daadwerkelijk verschil maakt."
        },
        "pl": {
          "title": "Wgląd w sygnały odpływu klientów w podziale na segmenty",
          "description": "Chcę widzieć, które segmenty klientów wykazują wczesne sygnały odpływu, bez konieczności eksportowania najpierw trzech pulpitów do arkusza kalkulacyjnego.",
          "business_impact": "Wcześniejsze wykrywanie odpływu w poszczególnych segmentach pozwala kierować wydatki na utrzymanie klientów tam, gdzie naprawdę przynoszą efekt."
        },
        "fr": {
          "title": "Visibilité sur les signaux d'attrition par segment",
          "description": "Je veux voir quels segments de clients présentent des signaux précoces d'attrition sans avoir à exporter d'abord trois tableaux de bord dans un tableur.",
          "business_impact": "Détecter l'attrition plus tôt par segment nous permet de cibler les dépenses de fidélisation là où elles font vraiment la différence."
        },
        "es": {
          "title": "Visibilidad de las señales de fuga por segmento",
          "description": "Quiero ver qué segmentos de clientes muestran señales tempranas de fuga sin tener que exportar antes tres paneles a una hoja de cálculo.",
          "business_impact": "Detectar la fuga antes por segmento nos permite dirigir el gasto en retención donde realmente marca la diferencia."
        },
        "de": {
          "title": "Einblick in Abwanderungssignale je Segment",
          "description": "Ich möchte sehen, welche Kundensegmente frühe Abwanderungssignale zeigen, ohne vorher drei Dashboards in eine Tabelle exportieren zu müssen.",
          "business_impact": "Eine frühere Erkennung der Abwanderung je Segment lässt uns Bindungsbudgets dort einsetzen, wo sie tatsächlich etwas bewirken."
        },
        "ar": {
          "title": "رؤية واضحة لمؤشرات فقدان العملاء حسب الشريحة",
          "description": "أريد أن أرى أي شرائح العملاء تُظهر مؤشرات مبكرة لفقدان العملاء دون الحاجة إلى تصدير ثلاث لوحات معلومات إلى جدول بيانات أولًا.",
          "business_impact": "الكشف المبكر عن فقدان العملاء لكل شريحة يتيح لنا توجيه إنفاق الاحتفاظ حيث يُحدث أثرًا فعليًا."
        },
        "he": {
          "title": "נראות לסימני נטישה לפי מגזר",
          "description": "אני רוצה לראות אילו מגזרי לקוחות מציגים סימני נטישה מוקדמים, בלי לייצא קודם שלושה דשבורדים לגיליון אלקטרוני.",
          "business_impact": "זיהוי מוקדם יותר של נטישה לפי מגזר מאפשר לנו למקד את תקציב השימור היכן שהוא באמת משפיע."
        }
      }
    }
  ],
  "solutions": [
    {
      "enTitle": "GPT flow with policy context in 7 steps",
      "locales": {
        "nl": {
          "title": "GPT-flow met poliscontext in 7 steps"
        },
        "pl": {
          "title": "Przepływ GPT z kontekstem polisy w 7 krokach"
        },
        "fr": {
          "title": "Flux GPT avec contexte de contrat en 7 steps"
        },
        "es": {
          "title": "Flujo de GPT con contexto de póliza en 7 pasos"
        },
        "de": {
          "title": "GPT-Flow mit Policen-Kontext in 7 Schritten"
        },
        "ar": {
          "title": "تدفّق GPT مع سياق وثيقة التأمين في 7 خطوات"
        },
        "he": {
          "title": "תהליך GPT עם הקשר פוליסה ב-7 שלבים"
        }
      }
    },
    {
      "enTitle": "Streaming summarizer with PDF OCR",
      "locales": {
        "nl": {
          "title": "Streaming-samenvatter met PDF-OCR"
        },
        "pl": {
          "title": "Strumieniowy generator streszczeń z OCR plików PDF"
        },
        "fr": {
          "title": "Résumeur en streaming avec OCR de PDF"
        },
        "es": {
          "title": "Resumidor en streaming con OCR de PDF"
        },
        "de": {
          "title": "Streaming-Zusammenfasser mit PDF-OCR"
        },
        "ar": {
          "title": "مُلخِّص بثّ متدفّق مع OCR لملفات PDF"
        },
        "he": {
          "title": "מסכם בזרימה עם OCR ל-PDF"
        }
      }
    },
    {
      "enTitle": "Inline review UI for the Claims associate",
      "locales": {
        "nl": {
          "title": "Inline review-UI voor de schadebehandelaar"
        },
        "pl": {
          "title": "Wbudowane UI do weryfikacji dla pracownika ds. roszczeń"
        },
        "fr": {
          "title": "UI de revue intégrée pour le chargé de sinistres"
        },
        "es": {
          "title": "UI de revisión integrada para el gestor de Siniestros"
        },
        "de": {
          "title": "Inline-Prüf-UI für den Schadensachbearbeiter"
        },
        "ar": {
          "title": "واجهة UI للمراجعة المضمّنة لموظف المطالبات"
        },
        "he": {
          "title": "ממשק UI לבדיקה מובנית עבור מטפל התביעות"
        }
      }
    },
    {
      "enTitle": "Multi-doc compare with audit trail",
      "locales": {
        "nl": {
          "title": "Vergelijking van meerdere documenten met audittrail"
        },
        "pl": {
          "title": "Porównywanie wielu dokumentów ze ścieżką audytu"
        },
        "fr": {
          "title": "Comparaison multi-documents avec piste d'audit"
        },
        "es": {
          "title": "Comparación multidocumento con registro de auditoría"
        },
        "de": {
          "title": "Mehrdokumenten-Vergleich mit Audit-Trail"
        },
        "ar": {
          "title": "مقارنة متعددة المستندات مع سجلّ تدقيق"
        },
        "he": {
          "title": "השוואת מסמכים מרובים עם נתיב ביקורת"
        }
      }
    },
    {
      "enTitle": "No-code Power Automate variant",
      "locales": {
        "nl": {
          "title": "No-code Power Automate-variant"
        },
        "pl": {
          "title": "Wariant no-code w Power Automate"
        },
        "fr": {
          "title": "Variante sans code en Power Automate"
        },
        "es": {
          "title": "Variante sin código con Power Automate"
        },
        "de": {
          "title": "No-Code-Variante mit Power Automate"
        },
        "ar": {
          "title": "نسخة Power Automate بدون كتابة برمجية"
        },
        "he": {
          "title": "גרסת Power Automate ללא קוד"
        }
      }
    }
  ]
};

async function upsert(entityType: string, entityId: string, locale: string, field: string, value: string): Promise<void> {
  await db
    .insert(contentTranslations)
    .values({ entity_type: entityType, entity_id: entityId, locale, field, value })
    .onConflictDoUpdate({
      target: [contentTranslations.entity_type, contentTranslations.entity_id, contentTranslations.locale, contentTranslations.field],
      set: { value, updated_at: new Date() },
    });
}

/** The challenge every seeded marketplace solution hangs off — `seed-marketplace.ts` inserts all
 *  five with `challenge_id: claimsChallengeId`. Scoping the solution lookup to it is what makes
 *  `(tenant, challenge, title)` the same key that seeder writes against. */
const SOLUTION_PARENT_CODE = 'CH-284';

/**
 * Idempotently seed marketplace content translations. Returns the number of
 * (entity, locale, field) rows written. No-op when the marketplace isn't seeded
 * (a row that cannot be resolved is skipped, not created).
 *
 * ⛔ EVERY LOOKUP IS SCOPED TO `DEMO_TENANT_ID` — the tenant `seed-marketplace.ts` stamps on every
 * row it inserts. Read the header for why an unscoped title match was the defect and not merely
 * imprecise. A row that is absent is still skipped rather than invented: this seeder localizes the
 * marketplace, it does not create it.
 */
export async function seedMarketplaceI18n(): Promise<{ rows: number }> {
  let rows = 0;

  // Resolved from the challenge loop so the solution loop can scope by parent. `null` means the
  // marketplace's challenge #1 is not in this database, in which case none of its five solutions
  // can be either.
  let solutionParentId: string | null = null;

  for (const c of DATA.challenges) {
    // At most one row can match: `challenges_tenant_code_key` is unique over (tenant_id, code)
    // wherever `code IS NOT NULL`, and `c.code` is a non-null literal. No ORDER BY can change a
    // one-row result set, so this is deterministic without one.
    const [row] = await db
      .select({ id: challenges.id })
      .from(challenges)
      .where(and(eq(challenges.tenant_id, DEMO_TENANT_ID), eq(challenges.code, c.code)));
    if (!row) continue;
    if (c.code === SOLUTION_PARENT_CODE) solutionParentId = row.id;
    for (const [locale, fields] of Object.entries(c.locales)) {
      await upsert('challenge', row.id, locale, 'title', fields.title);
      await upsert('challenge', row.id, locale, 'description', fields.description);
      await upsert('challenge', row.id, locale, 'business_impact', fields.business_impact);
      rows += 3;
    }
  }

  if (solutionParentId === null) return { rows };

  for (const s of DATA.solutions) {
    // `(tenant_id, challenge_id, title)` — seed-marketplace.ts's own idempotency key. Nothing in
    // the schema enforces it, so `asc(solutions.id)` decides any tie: ids are uuidv7, so ascending
    // id is oldest-first and the seeded row outranks a later duplicate rather than alternating
    // with it.
    const [row] = await db
      .select({ id: solutions.id })
      .from(solutions)
      .where(
        and(
          eq(solutions.tenant_id, DEMO_TENANT_ID),
          eq(solutions.challenge_id, solutionParentId),
          eq(solutions.title, s.enTitle),
        ),
      )
      .orderBy(asc(solutions.id))
      .limit(1);
    if (!row) continue;
    for (const [locale, fields] of Object.entries(s.locales)) {
      await upsert('solution', row.id, locale, 'title', fields.title);
      rows += 1;
    }
  }

  return { rows };
}
