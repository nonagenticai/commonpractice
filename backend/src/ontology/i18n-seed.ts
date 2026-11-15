// src/ontology/i18n-seed.ts — the curated ontology i18n CONTENT plus the pure builder that turns
// it into `content_translations` rows. ONE builder, TWO consumers, exactly like
// `src/templates/i18n-seed.ts`:
//
//   * `scripts/gen-ontology-i18n.ts` → regenerates `migrations/0080_ontology_i18n.sql`, which is
//     the half that reaches PRODUCTION;
//   * `db/seed-ontology-i18n.ts` → writes the identical rows on a fresh developer / CI database.
//
// ⛔ THE SEED DOES NOT RUN IN PRODUCTION, AND THAT IS WHY THIS FILE EXISTS. The live Deployment
// sets `SEED_DEMO_DATA=false`, and `server.ts` only calls `seedAll()` when that flag is true;
// `applyMigrations()` runs on EVERY boot. So every word below lived in a code path production
// never executed. Editing this file ALONE still ships nothing — the migration is the artifact that
// lands, and it is GENERATED from here so the two cannot drift. Same construction as
// `migrations/0079_template_i18n.sql`; read that file's header for the full argument.
//
// This module also owns the pure `src/ontology/seed/*.json` reading layer (file list, loader,
// scope derivation). `db/seed-ontology.ts` — the DB writer — imports it from here rather than
// keeping a second copy, because the canonical key set computed below is only trustworthy if it is
// derived from the exact same files, in the exact same order, as the rows it keys against.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, type Locale } from '../utils/locale';
import {
  ONTOLOGY_ENTITY_I18N,
  ONTOLOGY_ATTRIBUTE_I18N,
  ONTOLOGY_RELATION_I18N,
  attrKey,
  entityKey,
  relKey,
} from './ontology-service';

// ---------------------------------------------------------------------------------------------
// The seed JSON layer (shared with db/seed-ontology.ts)
// ---------------------------------------------------------------------------------------------

export interface SeedAttribute {
  name: string;
  type: string;
  synonyms?: string[];
  pii?: boolean;
  description?: string;
}
export interface SeedRelation {
  to: string;
  predicate: string;
  label?: string;
  cardinality?: string;
  /** Optional disambiguator when the target name exists in several departments. */
  toDepartment?: string;
}
export interface SeedEntity {
  name: string;
  label: string;
  department?: string;
  synonyms?: string[];
  description?: string;
  attributes?: SeedAttribute[];
  relations?: SeedRelation[];
}
export interface SeedFile {
  industry?: string;
  entities: SeedEntity[];
}

export type Scope = 'generic' | 'industry' | 'industry_dept';

/** ⛔ ORDER IS LOAD-BEARING for db/seed-ontology.ts: relation targets resolve by name across the
 *  whole catalog and fall back to `candidates[0]` when nothing else disambiguates, so reordering
 *  this list can rebind an edge. It lives here so both consumers read one list. */
export const ONTOLOGY_SEED_FILES = [
  'generic-departments.json',
  'insurance.json',
  'banking.json',
  'healthcare.json',
];

const SEED_DIR = path.join(import.meta.dir, 'seed');

export function loadOntologySeedFile(file: string): SeedFile {
  return JSON.parse(readFileSync(path.join(SEED_DIR, file), 'utf8')) as SeedFile;
}

export function loadOntologySeed(): SeedFile[] {
  return ONTOLOGY_SEED_FILES.map(loadOntologySeedFile);
}

/** No file `industry` => generic (the entity carries its own `department`); file `industry` and no
 *  entity `department` => the industry-wide overlay; both => the (industry x department) cell. */
export function deriveScope(
  file: SeedFile,
  entity: SeedEntity,
): { scope: Scope; industry: string | null; department: string | null } {
  if (!file.industry) {
    if (!entity.department) {
      throw new Error(`[seed-ontology] generic entity '${entity.name}' is missing a department`);
    }
    return { scope: 'generic', industry: null, department: entity.department };
  }
  if (!entity.department) {
    return { scope: 'industry', industry: file.industry, department: null };
  }
  return { scope: 'industry_dept', industry: file.industry, department: entity.department };
}

// ---------------------------------------------------------------------------------------------
// The canonical key sets — what a translation is ALLOWED to key to
// ---------------------------------------------------------------------------------------------

export interface CanonicalKeys {
  /** entityKey() for every seeded entity. */
  entities: Set<string>;
  /** attrKey(entityKey, name) for every seeded attribute. */
  attributes: Set<string>;
  /** relKey(compileIndustry, from, to, predicate) — see the ⛔ below. */
  relations: Set<string>;
  /** The matrix's industry axis, derived the way listMatrix derives it. */
  industries: string[];
  /** The matrix's department axis. Not used for keys; exported because it is the other half of
   *  the cell grid a reviewer needs when reasoning about which edges a locale can actually see. */
  departments: string[];
}

/**
 * Every key the reader can actually look up, computed from the same JSON the seeder loads.
 *
 * ⛔ A RELATION KEY IS QUALIFIED BY THE *COMPILE* INDUSTRY, NOT BY THE EDGE'S OWN SCOPE.
 * `compileEffective` builds its lookup key as `relKey(industry, r.from, r.to, r.predicate)`
 * (ontology-service.ts), where `industry` is the CELL being compiled — never the layer the edge
 * came from. A generic-layer edge is in the layered set of every cell, so `Campaign -runsOn->
 * Channel` is looked up as `insurance:Campaign->Channel:runsOn` on the insurance graph and
 * `banking:…` on the banking one. ONE authored generic edge therefore needs ONE ROW PER INDUSTRY,
 * and that expansion happens HERE, in a loop over the derived industry axis — never by hand-listing
 * tuples, which is exactly how you ship a translation that works on the demo vertical and silently
 * degrades to English on the other two.
 *
 * ⛔ DO NOT "FIX" `relKey` TO USE THE EDGE'S OWN INDUSTRY. The reader is correct: the same
 * (from, to, predicate) name-tuple can mean different things in two verticals (an insurance
 * `Claim -under-> Policy` vs a healthcare one), and collapsing the key would let one vertical's
 * wording leak into another's graph. The cost is rows, and rows are cheap.
 *
 * An edge whose source is an INDUSTRY entity is only ever in that industry's layered set, so it
 * gets exactly one key. An edge whose target name resolves to nothing is SKIPPED — `seedOntology`
 * warns and does not insert it, so a translation keyed to one would match no edge in any database.
 */
export function canonicalOntologyKeys(files: SeedFile[] = loadOntologySeed()): CanonicalKeys {
  const entities = new Set<string>();
  const attributes = new Set<string>();
  const relations = new Set<string>();
  const industries = new Set<string>();
  const departments = new Set<string>();

  interface Rec {
    scope: Scope;
    industry: string | null;
    department: string | null;
    entity: SeedEntity;
  }
  const recs: Rec[] = [];
  for (const file of files) {
    for (const entity of file.entities) {
      const { scope, industry, department } = deriveScope(file, entity);
      recs.push({ scope, industry, department, entity });
      const key = entityKey({ scope, industry, department, name: entity.name });
      entities.add(key);
      for (const a of entity.attributes ?? []) attributes.add(attrKey(key, a.name));
      // Mirrors listMatrix exactly: an industry joins the axis via its industry/industry_dept
      // rows, a department via its generic/industry_dept rows.
      if (industry && (scope === 'industry' || scope === 'industry_dept')) industries.add(industry);
      if (department && (scope === 'generic' || scope === 'industry_dept')) departments.add(department);
    }
  }

  // Relation-target resolvability, mirroring seed-ontology's `resolveTarget`. Only the target's
  // NAME matters for the key, and that is always `rel.to`; the layer-precedence tie-break chooses
  // WHICH ROW, never a different name. So resolvable <=> at least one same-named candidate
  // survives the optional `toDepartment` filter.
  const byName = new Map<string, Rec[]>();
  for (const r of recs) byName.set(r.entity.name, [...(byName.get(r.entity.name) ?? []), r]);

  const industryList = [...industries].sort();
  for (const rec of recs) {
    for (const rel of rec.entity.relations ?? []) {
      let candidates = byName.get(rel.to) ?? [];
      if (rel.toDepartment) candidates = candidates.filter((c) => c.department === rel.toDepartment);
      if (candidates.length === 0) continue;
      // ⛔ THE EXPANSION. A generic-layer edge is compiled under EVERY industry.
      const compileIndustries = rec.scope === 'generic' ? industryList : [rec.industry!];
      for (const ind of compileIndustries) {
        relations.add(relKey(ind, rec.entity.name, rel.to, rel.predicate));
      }
    }
  }

  return {
    entities,
    attributes,
    relations,
    industries: industryList,
    departments: [...departments].sort(),
  };
}

// ---------------------------------------------------------------------------------------------
// The content
// ---------------------------------------------------------------------------------------------

/** The 7 authored locales — `SUPPORTED_LOCALES` minus `en`, DERIVED rather than re-listed so a
 *  9th edition cannot be added to the app and silently skipped here. */
export const ONTOLOGY_LOCALES: Locale[] = SUPPORTED_LOCALES.filter((l) => l !== DEFAULT_LOCALE);

/**
 * One entry's prose, keyed BY LOCALE rather than positionally.
 *
 * ⛔ NOT A TUPLE, AND THAT IS THE POINT. This content used to be a positional 8-tuple
 * `[key, nl, pl, fr, es, de, ar, he]`. Five of those seven columns are languages no reviewer here
 * reads and two are RTL, and in a fixed-width tuple a wrong-column paste is invisible: the row
 * still has 8 cells, the file still compiles, and one locale silently serves another's words. A
 * locale-keyed record makes a single bad cell DELETABLE — a reviewer who finds the `he` reading
 * wrong drops `he:` from that entry, the reader falls back to the English base column, and no
 * tuple-shape refactor and no placeholder string pretending to be a translation is needed.
 * A missing locale is therefore MEANINGFUL: it means "not authored", never "empty string".
 */
export type LocaleValues = Partial<Record<Locale, string>>;

export interface KeyedEntry {
  /** entityKey() — `${scope}:${industry ?? ''}:${department ?? ''}:${name}`. */
  key: string;
  values: LocaleValues;
}
export interface AttributeEntry {
  /** The owning entity's entityKey(). */
  entity: string;
  attribute: string;
  values: LocaleValues;
}
export interface RelationEntry {
  /** The industry whose layer owns the SOURCE entity, or `null` for a generic-layer edge — which
   *  the builder expands to one row per industry on the matrix axis. See canonicalOntologyKeys(). */
  industry: string | null;
  from: string;
  to: string;
  predicate: string;
  values: LocaleValues;
}

// ---- entity labels (every shipped entity) ----
export const LABELS: KeyedEntry[] = [
  { key: "generic::Marketing:Campaign", values: { nl: "Campagne", pl: "Kampania", fr: "Campagne", es: "Campaña", de: "Kampagne", ar: "حملة", he: "קמפיין" } },
  { key: "generic::Marketing:Channel", values: { nl: "Kanaal", pl: "Kanał", fr: "Canal", es: "Canal", de: "Kanal", ar: "قناة", he: "ערוץ" } },
  { key: "generic::Marketing:Audience", values: { nl: "Doelgroep", pl: "Odbiorcy", fr: "Audience", es: "Audiencia", de: "Zielgruppe", ar: "الجمهور", he: "קהל" } },
  { key: "generic::Marketing:Content", values: { nl: "Content", pl: "Treść", fr: "Contenu", es: "Contenido", de: "Inhalt", ar: "محتوى", he: "תוכן" } },
  { key: "generic::Marketing:Lead", values: { nl: "Lead", pl: "Lead", fr: "Prospect", es: "Cliente potencial", de: "Lead", ar: "عميل محتمل", he: "ליד" } },
  { key: "generic::Sales:Lead", values: { nl: "Lead", pl: "Lead", fr: "Prospect", es: "Cliente potencial", de: "Lead", ar: "عميل محتمل", he: "ליד" } },
  { key: "generic::Sales:Opportunity", values: { nl: "Verkoopkans", pl: "Szansa sprzedaży", fr: "Opportunité", es: "Oportunidad", de: "Verkaufschance", ar: "فرصة بيع", he: "הזדמנות" } },
  { key: "generic::Sales:Account", values: { nl: "Account", pl: "Konto", fr: "Compte", es: "Cuenta", de: "Konto", ar: "حساب", he: "חשבון" } },
  { key: "generic::Sales:Quote", values: { nl: "Offerte", pl: "Oferta", fr: "Devis", es: "Presupuesto", de: "Angebot", ar: "عرض سعر", he: "הצעת מחיר" } },
  { key: "generic::Legal:Contract", values: { nl: "Contract", pl: "Umowa", fr: "Contrat", es: "Contrato", de: "Vertrag", ar: "عقد", he: "חוזה" } },
  { key: "generic::Legal:Clause", values: { nl: "Clausule", pl: "Klauzula", fr: "Clause", es: "Cláusula", de: "Klausel", ar: "بند", he: "סעיף" } },
  { key: "generic::Legal:Obligation", values: { nl: "Verplichting", pl: "Zobowiązanie", fr: "Obligation", es: "Obligación", de: "Verpflichtung", ar: "التزام", he: "מחויבות" } },
  { key: "generic::Service:Ticket", values: { nl: "Ticket", pl: "Zgłoszenie", fr: "Ticket", es: "Ticket", de: "Ticket", ar: "تذكرة", he: "כרטיס" } },
  { key: "generic::Service:Case", values: { nl: "Zaak", pl: "Sprawa", fr: "Dossier", es: "Caso", de: "Fall", ar: "حالة", he: "תיק" } },
  { key: "generic::Service:Customer", values: { nl: "Klant", pl: "Klient", fr: "Client", es: "Cliente", de: "Kunde", ar: "عميل", he: "לקוח" } },
  { key: "generic::Finance:Invoice", values: { nl: "Factuur", pl: "Faktura", fr: "Facture", es: "Factura", de: "Rechnung", ar: "فاتورة", he: "חשבונית" } },
  { key: "generic::Finance:Payment", values: { nl: "Betaling", pl: "Płatność", fr: "Paiement", es: "Pago", de: "Zahlung", ar: "دفعة", he: "תשלום" } },
  { key: "generic::Finance:Ledger", values: { nl: "Grootboek", pl: "Księga główna", fr: "Grand livre", es: "Libro mayor", de: "Hauptbuch", ar: "دفتر الأستاذ", he: "ספר חשבונות" } },
  { key: "generic::Ops:Process", values: { nl: "Proces", pl: "Proces", fr: "Processus", es: "Proceso", de: "Prozess", ar: "عملية", he: "תהליך" } },
  { key: "generic::Ops:Task", values: { nl: "Taak", pl: "Zadanie", fr: "Tâche", es: "Tarea", de: "Aufgabe", ar: "مهمة", he: "משימה" } },
  { key: "generic::HR:Employee", values: { nl: "Medewerker", pl: "Pracownik", fr: "Employé", es: "Empleado", de: "Mitarbeiter", ar: "موظف", he: "עובד" } },
  { key: "industry:banking::Account", values: { nl: "Bankrekening", pl: "Rachunek bankowy", fr: "Compte bancaire", es: "Cuenta bancaria", de: "Bankkonto", ar: "حساب مصرفي", he: "חשבון בנק" } },
  { key: "industry:banking::Transaction", values: { nl: "Transactie", pl: "Transakcja", fr: "Transaction", es: "Transacción", de: "Transaktion", ar: "معاملة", he: "עסקה" } },
  { key: "industry:banking::Loan", values: { nl: "Lening", pl: "Pożyczka", fr: "Prêt", es: "Préstamo", de: "Darlehen", ar: "قرض", he: "הלוואה" } },
  { key: "industry:banking::KYC", values: { nl: "KYC-record", pl: "Rekord KYC", fr: "Dossier KYC", es: "Registro KYC", de: "KYC-Datensatz", ar: "سجل اعرف عميلك", he: "רשומת KYC" } },
  { key: "industry:healthcare::Patient", values: { nl: "Patiënt", pl: "Pacjent", fr: "Patient", es: "Paciente", de: "Patient", ar: "مريض", he: "מטופל" } },
  { key: "industry:healthcare::Encounter", values: { nl: "Consult", pl: "Wizyta", fr: "Consultation", es: "Consulta", de: "Konsultation", ar: "زيارة طبية", he: "מפגש" } },
  { key: "industry:healthcare::Claim", values: { nl: "Zorgdeclaratie", pl: "Roszczenie medyczne", fr: "Demande de remboursement", es: "Reclamación médica", de: "Krankenversicherungsanspruch", ar: "مطالبة طبية", he: "תביעה רפואית" } },
  { key: "industry:healthcare::Provider", values: { nl: "Zorgverlener", pl: "Świadczeniodawca", fr: "Prestataire", es: "Proveedor", de: "Leistungserbringer", ar: "مقدم الرعاية", he: "ספק שירותי בריאות" } },
  { key: "industry:insurance::Policy", values: { nl: "Polis", pl: "Polisa", fr: "Police", es: "Póliza", de: "Police", ar: "وثيقة تأمين", he: "פוליסה" } },
  { key: "industry:insurance::Claim", values: { nl: "Schadeclaim", pl: "Roszczenie", fr: "Sinistre", es: "Siniestro", de: "Schadenfall", ar: "مطالبة", he: "תביעה" } },
  { key: "industry:insurance::Coverage", values: { nl: "Dekking", pl: "Zakres ochrony", fr: "Garantie", es: "Cobertura", de: "Deckung", ar: "تغطية", he: "כיסוי" } },
  { key: "industry:insurance::Premium", values: { nl: "Premie", pl: "Składka", fr: "Prime", es: "Prima", de: "Prämie", ar: "قسط التأمين", he: "פרמיה" } },
  { key: "industry:insurance::Adjuster", values: { nl: "Schade-expert", pl: "Likwidator szkód", fr: "Expert en sinistres", es: "Perito", de: "Schadenregulierer", ar: "خبير تسوية", he: "שמאי" } },
  { key: "industry:insurance::Underwriting", values: { nl: "Acceptatie", pl: "Ocena ryzyka", fr: "Souscription", es: "Suscripción", de: "Risikoprüfung", ar: "الاكتتاب", he: "חיתום" } },
  { key: "industry_dept:insurance:Claims:Claim", values: { nl: "Schadeclaim (schadeafdeling)", pl: "Roszczenie (dział szkód)", fr: "Sinistre (service sinistres)", es: "Siniestro (departamento de siniestros)", de: "Schadenfall (Schadenabteilung)", ar: "مطالبة (قسم المطالبات)", he: "תביעה (מחלקת תביעות)" } },
  { key: "industry_dept:insurance:Marketing:PolicyholderSegment", values: { nl: "Polishouder-segment", pl: "Segment ubezpieczonych", fr: "Segment d'assurés", es: "Segmento de asegurados", de: "Versicherungsnehmer-Segment", ar: "شريحة حاملي الوثائق", he: "פלח מבוטחים" } },
  { key: "industry_dept:insurance:Marketing:RenewalCampaign", values: { nl: "Verlengingscampagne", pl: "Kampania odnowieniowa", fr: "Campagne de renouvellement", es: "Campaña de renovación", de: "Verlängerungskampagne", ar: "حملة تجديد", he: "קמפיין חידוש" } },
];

// ---- entity descriptions (all 38 shipped entities) ----
// Was insurance-only (9 of 38) through Phase 3.7; the other 29 verticals' descriptions were
// added with the relation labels below.
export const DESCRIPTIONS: KeyedEntry[] = [
  { key: "industry:insurance::Policy", values: { nl: "Een verzekeringscontract tussen de verzekeraar en een verzekeringnemer.", pl: "Umowa ubezpieczenia między ubezpieczycielem a ubezpieczającym.", fr: "Un contrat d'assurance entre l'assureur et un assuré.", es: "Un contrato de seguro entre la aseguradora y un tomador.", de: "Ein Versicherungsvertrag zwischen dem Versicherer und einem Versicherungsnehmer.", ar: "عقد تأمين بين شركة التأمين وحامل الوثيقة.", he: "חוזה ביטוח בין המבטח לבעל הפוליסה." } },
  { key: "industry:insurance::Claim", values: { nl: "Een verzoek om uitkering onder een polis na een gedekt schadegeval.", pl: "Żądanie wypłaty z polisy po objętej ochroną szkodzie.", fr: "Une demande de paiement au titre d'une police après un sinistre couvert.", es: "Una solicitud de pago bajo una póliza tras una pérdida cubierta.", de: "Eine Zahlungsforderung aus einer Police nach einem gedeckten Schaden.", ar: "طلب دفع بموجب وثيقة بعد خسارة مغطاة.", he: "בקשה לתשלום על פי פוליסה לאחר נזק מכוסה." } },
  { key: "industry:insurance::Coverage", values: { nl: "Een specifiek risico waartegen een polis verzekert, met limieten en eigen risico.", pl: "Konkretne ryzyko objęte polisą, z limitami i udziałem własnym.", fr: "Un risque spécifique couvert par une police, avec plafonds et franchise.", es: "Un riesgo específico que cubre una póliza, con límites y franquicia.", de: "Ein bestimmtes Risiko, gegen das eine Police versichert, mit Limits und Selbstbehalt.", ar: "خطر محدد تؤمّن ضده الوثيقة، مع حدود وتحمل.", he: "סיכון מסוים שהפוליסה מבטחת מפניו, עם תקרות והשתתפות עצמית." } },
  { key: "industry:insurance::Premium", values: { nl: "Het bedrag dat voor een verzekeringspolis wordt betaald.", pl: "Kwota płacona za polisę ubezpieczeniową.", fr: "Le montant payé pour une police d'assurance.", es: "El importe pagado por una póliza de seguro.", de: "Der für eine Versicherungspolice gezahlte Betrag.", ar: "المبلغ المدفوع مقابل وثيقة التأمين.", he: "הסכום המשולם עבור פוליסת ביטוח." } },
  { key: "industry:insurance::Adjuster", values: { nl: "De persoon die een claim onderzoekt en afwikkelt.", pl: "Osoba, która bada i likwiduje roszczenie.", fr: "La personne qui enquête sur un sinistre et le règle.", es: "La persona que investiga y resuelve un siniestro.", de: "Die Person, die einen Schaden untersucht und reguliert.", ar: "الشخص الذي يحقق في المطالبة ويسويها.", he: "האדם החוקר ומסדיר את התביעה." } },
  { key: "industry:insurance::Underwriting", values: { nl: "De beoordeling van risico en prijsstelling voor een polis.", pl: "Ocena ryzyka i ustalenie ceny polisy.", fr: "L'évaluation du risque et la tarification d'une police.", es: "La evaluación del riesgo y la tarificación de una póliza.", de: "Die Bewertung von Risiko und Preisgestaltung für eine Police.", ar: "تقييم المخاطر وتسعير الوثيقة.", he: "הערכת הסיכון והתמחור של פוליסה." } },
  { key: "industry_dept:insurance:Claims:Claim", values: { nl: "Beeld van een claim vanuit de schadeafdeling: voegt triage-, fraude- en afwikkelingsdetails toe.", pl: "Widok roszczenia z perspektywy działu szkód: dodaje triage, dane o oszustwach i likwidacji.", fr: "Vue d'un sinistre par le service sinistres : ajoute le tri, la fraude et le règlement.", es: "Vista del siniestro desde el departamento de siniestros: añade triaje, fraude y liquidación.", de: "Sicht der Schadenabteilung auf einen Schaden: ergänzt Triage-, Betrugs- und Regulierungsdetails.", ar: "نظرة قسم المطالبات إلى المطالبة: تضيف الفرز والاحتيال وتفاصيل التسوية.", he: "מבט מחלקת התביעות על תביעה: מוסיף מיון, הונאה ופרטי הסדר." } },
  { key: "industry_dept:insurance:Marketing:PolicyholderSegment", values: { nl: "Een marketingsegment van polishouders voor verlengings- of upsellcampagnes.", pl: "Segment marketingowy ubezpieczonych do kampanii odnowieniowych/upsell.", fr: "Un segment marketing d'assurés défini pour les campagnes de renouvellement/montée en gamme.", es: "Un segmento de marketing de asegurados definido para campañas de renovación/venta adicional.", de: "Ein Marketingsegment von Versicherungsnehmern für Verlängerungs-/Upsell-Kampagnen.", ar: "شريحة تسويقية من حاملي الوثائق لحملات التجديد أو البيع الإضافي.", he: "פלח שיווקי של מבוטחים שהוגדר לקמפיינים של חידוש/מכירה נוספת." } },
  { key: "industry_dept:insurance:Marketing:RenewalCampaign", values: { nl: "Een marketingcampagne gericht op polishouders die hun verlenging naderen.", pl: "Kampania marketingowa skierowana do ubezpieczonych zbliżających się do odnowienia.", fr: "Une campagne marketing ciblant les assurés proches du renouvellement.", es: "Una campaña de marketing dirigida a asegurados próximos a la renovación.", de: "Eine Marketingkampagne für Versicherungsnehmer kurz vor der Verlängerung.", ar: "حملة تسويقية تستهدف حاملي الوثائق المقتربين من التجديد.", he: "קמפיין שיווקי המכוון למבוטחים המתקרבים לחידוש." } },
  { key: "generic::Finance:Invoice", values: { nl: "Een verzoek tot betaling voor geleverde goederen of diensten.", pl: "Żądanie zapłaty za towary lub usługi.", fr: "Une demande de paiement pour des biens ou des services.", es: "Una solicitud de pago por bienes o servicios.", de: "Eine Zahlungsaufforderung für Waren oder Dienstleistungen.", ar: "طلب دفع مقابل سلع أو خدمات.", he: "בקשה לתשלום עבור מוצרים או שירותים." } },
  { key: "generic::Finance:Ledger", values: { nl: "De grootboekrekening waarop boekingen worden vastgelegd.", pl: "Konto księgi głównej, na którym rejestrowane są księgowania.", fr: "Le compte du grand livre sur lequel les écritures sont enregistrées.", es: "La cuenta del libro mayor en la que se registran los asientos.", de: "Das Hauptbuchkonto, auf dem Buchungen erfasst werden.", ar: "حساب دفتر الأستاذ العام الذي تُسجَّل عليه القيود.", he: "חשבון ספר החשבונות הראשי שאליו נרשמות הפקודות." } },
  { key: "generic::Finance:Payment", values: { nl: "Een overboeking van geld ter voldoening van een factuur.", pl: "Przelew środków na poczet faktury.", fr: "Un transfert de fonds en règlement d'une facture.", es: "Una transferencia de fondos para saldar una factura.", de: "Eine Geldübertragung zur Begleichung einer Rechnung.", ar: "تحويل أموال لسداد فاتورة.", he: "העברת כספים לפירעון חשבונית." } },
  { key: "generic::HR:Employee", values: { nl: "Een persoon die in dienst is bij het bedrijf.", pl: "Osoba zatrudniona w firmie.", fr: "Une personne employée par l'entreprise.", es: "Una persona empleada por la empresa.", de: "Eine im Unternehmen beschäftigte Person.", ar: "شخص يعمل لدى الشركة.", he: "אדם המועסק בחברה." } },
  { key: "generic::Legal:Clause", values: { nl: "Een afzonderlijke bepaling binnen een contract.", pl: "Odrębne postanowienie w umowie.", fr: "Une disposition distincte au sein d'un contrat.", es: "Una disposición concreta dentro de un contrato.", de: "Eine einzelne Bestimmung innerhalb eines Vertrags.", ar: "حكم منفصل ضمن العقد.", he: "הוראה נפרדת בתוך חוזה." } },
  { key: "generic::Legal:Contract", values: { nl: "Een bindende overeenkomst tussen partijen.", pl: "Wiążące porozumienie między stronami.", fr: "Un accord contraignant entre les parties.", es: "Un acuerdo vinculante entre las partes.", de: "Eine verbindliche Vereinbarung zwischen Parteien.", ar: "اتفاق ملزم بين الأطراف.", he: "הסכם מחייב בין הצדדים." } },
  { key: "generic::Legal:Obligation", values: { nl: "Een verplichting die voortvloeit uit een contractuele bepaling.", pl: "Obowiązek wynikający z postanowienia umownego.", fr: "Une obligation découlant d'une clause contractuelle.", es: "Un deber que surge de una cláusula contractual.", de: "Eine Pflicht, die sich aus einer Vertragsklausel ergibt.", ar: "واجب ناشئ عن بند تعاقدي.", he: "חובה הנובעת מסעיף חוזי." } },
  { key: "generic::Marketing:Audience", values: { nl: "Een doelgroep die is afgebakend op basis van gedeelde kenmerken.", pl: "Grupa docelowa zdefiniowana przez wspólne cechy.", fr: "Un groupe cible défini par des attributs communs.", es: "Un grupo objetivo definido por atributos compartidos.", de: "Eine Zielgruppe, die durch gemeinsame Merkmale definiert ist.", ar: "مجموعة مستهدفة من الأشخاص تُحدَّد بسمات مشتركة.", he: "קבוצת יעד המוגדרת לפי מאפיינים משותפים." } },
  { key: "generic::Marketing:Campaign", values: { nl: "Een gecoördineerde marketinginspanning via een of meer kanalen.", pl: "Skoordynowane działanie marketingowe w jednym lub kilku kanałach.", fr: "Une action marketing coordonnée sur un ou plusieurs canaux.", es: "Una acción de marketing coordinada en uno o varios canales.", de: "Eine koordinierte Marketingmaßnahme über einen oder mehrere Kanäle.", ar: "جهد تسويقي منسق عبر قناة واحدة أو أكثر.", he: "מאמץ שיווקי מתואם באחד או יותר ערוצים." } },
  { key: "generic::Marketing:Channel", values: { nl: "Een medium waarlangs marketing wordt uitgeleverd (e-mail, paid social, zoekadvertenties).", pl: "Kanał dystrybucji działań marketingowych (e-mail, płatne social media, wyszukiwarka).", fr: "Un canal de diffusion marketing (e-mail, social payant, recherche).", es: "Un medio de difusión para marketing (correo electrónico, social de pago, búsqueda).", de: "Ein Ausspielkanal für Marketing (E-Mail, Paid Social, Suche).", ar: "وسيلة لإيصال الرسائل التسويقية (البريد الإلكتروني، الإعلانات الاجتماعية المدفوعة، البحث).", he: "ערוץ הפצה לשיווק (דואר אלקטרוני, מדיה חברתית בתשלום, חיפוש)." } },
  { key: "generic::Marketing:Content", values: { nl: "Een creatieve uiting die in een campagne wordt ingezet.", pl: "Zasób kreatywny wykorzystywany w kampanii.", fr: "Un actif créatif utilisé dans une campagne.", es: "Un recurso creativo utilizado en una campaña.", de: "Ein Kreativ-Asset, das in einer Kampagne eingesetzt wird.", ar: "أصل إبداعي يُستخدم في حملة.", he: "נכס יצירתי המשמש בקמפיין." } },
  { key: "generic::Marketing:Lead", values: { nl: "Een prospect die via een marketingactiviteit is binnengekomen.", pl: "Przychodzący potencjalny klient pozyskany dzięki działaniu marketingowemu.", fr: "Un prospect entrant capté par une action marketing.", es: "Un cliente potencial entrante captado por una acción de marketing.", de: "Ein eingehender Interessent, der über eine Marketingaktivität erfasst wurde.", ar: "عميل محتمل وارد تم التقاطه عبر نشاط تسويقي.", he: "מתעניין נכנס שנקלט בפעילות שיווקית." } },
  { key: "generic::Ops:Process", values: { nl: "Een herhaalbare operationele procedure.", pl: "Powtarzalna procedura operacyjna.", fr: "Une procédure opérationnelle reproductible.", es: "Un procedimiento operativo repetible.", de: "Ein wiederholbarer operativer Ablauf.", ar: "إجراء تشغيلي قابل للتكرار.", he: "נוהל תפעולי שניתן לחזור עליו." } },
  { key: "generic::Ops:Task", values: { nl: "Een werkeenheid binnen een proces.", pl: "Jednostka pracy w ramach procesu.", fr: "Une unité de travail au sein d'un processus.", es: "Una unidad de trabajo dentro de un proceso.", de: "Eine Arbeitseinheit innerhalb eines Prozesses.", ar: "وحدة عمل ضمن عملية.", he: "יחידת עבודה בתוך תהליך." } },
  { key: "generic::Sales:Account", values: { nl: "Een klantorganisatie in het verkooptraject.", pl: "Organizacja klienta w lejku sprzedaży.", fr: "Une organisation cliente dans le pipeline commercial.", es: "Una organización cliente en el pipeline de ventas.", de: "Eine Kundenorganisation in der Vertriebspipeline.", ar: "مؤسسة عميلة ضمن مسار المبيعات.", he: "ארגון לקוח בצינור המכירות." } },
  { key: "generic::Sales:Lead", values: { nl: "Een gekwalificeerde prospect die een accountmanager in behandeling heeft.", pl: "Zakwalifikowany potencjalny klient, którym zajmuje się handlowiec.", fr: "Un prospect qualifié travaillé par un commercial.", es: "Un cliente potencial cualificado en el que trabaja un comercial.", de: "Ein qualifizierter Interessent, an dem ein Vertriebsmitarbeiter arbeitet.", ar: "عميل محتمل مؤهل يعمل عليه مندوب المبيعات.", he: "מתעניין מוסמך שנציג מכירות מטפל בו." } },
  { key: "generic::Sales:Opportunity", values: { nl: "Een potentiële verkoop die actief wordt nagestreefd.", pl: "Potencjalna sprzedaż, o którą trwają starania.", fr: "Une vente potentielle en cours de traitement.", es: "Una venta potencial que se está persiguiendo.", de: "Ein potenzieller Verkauf, der aktiv verfolgt wird.", ar: "عملية بيع محتملة يجري السعي إليها.", he: "מכירה פוטנציאלית שנמצאת בטיפול." } },
  { key: "generic::Sales:Quote", values: { nl: "Een voorstel met prijzen dat naar een prospect is verstuurd.", pl: "Wyceniona propozycja wysłana do potencjalnego klienta.", fr: "Une proposition chiffrée envoyée à un prospect.", es: "Una propuesta con precios enviada a un cliente potencial.", de: "Ein bepreistes Angebot, das an einen Interessenten gesendet wurde.", ar: "عرض مسعّر أُرسل إلى عميل محتمل.", he: "הצעה מתומחרת שנשלחה למתעניין." } },
  { key: "generic::Service:Case", values: { nl: "Een servicezaak die wordt gevolgd en een of meer tickets omvat.", pl: "Śledzona sprawa serwisowa obejmująca jedno lub więcej zgłoszeń.", fr: "Un dossier de service suivi couvrant un ou plusieurs tickets.", es: "Un asunto de servicio con seguimiento que abarca uno o varios tickets.", de: "Ein nachverfolgter Servicevorgang, der ein oder mehrere Tickets umfasst.", ar: "مسألة خدمة متابَعة تشمل تذكرة واحدة أو أكثر.", he: "עניין שירות במעקב הכולל כרטיס אחד או יותר." } },
  { key: "generic::Service:Customer", values: { nl: "Een persoon of organisatie waaraan het bedrijf diensten levert.", pl: "Osoba lub organizacja obsługiwana przez firmę.", fr: "Une personne ou une organisation servie par l'entreprise.", es: "Una persona u organización a la que la empresa presta servicio.", de: "Eine Person oder Organisation, für die das Unternehmen tätig ist.", ar: "شخص أو مؤسسة تقدم لها الشركة خدماتها.", he: "אדם או ארגון שהחברה מספקת לו שירות." } },
  { key: "generic::Service:Ticket", values: { nl: "Een supportverzoek van een klant.", pl: "Zgłoszenie wsparcia od klienta.", fr: "Une demande d'assistance client.", es: "Una solicitud de soporte de un cliente.", de: "Eine Kundensupport-Anfrage.", ar: "طلب دعم من العميل.", he: "פנייה לתמיכה מלקוח." } },
  { key: "industry:banking::Account", values: { nl: "Een bankrekening van een klant.", pl: "Rachunek bankowy klienta.", fr: "Le compte bancaire d'un client.", es: "La cuenta bancaria de un cliente.", de: "Das Bankkonto eines Kunden.", ar: "الحساب المصرفي للعميل.", he: "חשבון הבנק של לקוח." } },
  { key: "industry:banking::KYC", values: { nl: "Een verificatiedossier voor cliëntenonderzoek (KYC) ten behoeve van compliance.", pl: "Rekord weryfikacji tożsamości klienta (KYC) na potrzeby zgodności.", fr: "Dossier de vérification de l'identité du client (KYC) à des fins de conformité.", es: "Registro de verificación de la identidad del cliente (KYC) para el cumplimiento normativo.", de: "Prüfdatensatz zur Kundenidentifizierung (KYC) für die Compliance.", ar: "سجل التحقق من هوية العميل لأغراض الامتثال.", he: "רשומת אימות זהות הלקוח לצורכי ציות." } },
  { key: "industry:banking::Loan", values: { nl: "Een kredietfaciliteit die aan een klant is verstrekt.", pl: "Linia kredytowa udzielona klientowi.", fr: "Une facilité de crédit accordée à un client.", es: "Una línea de crédito concedida a un cliente.", de: "Eine einem Kunden gewährte Kreditfazilität.", ar: "تسهيل ائتماني ممنوح للعميل.", he: "מסגרת אשראי שהועמדה ללקוח." } },
  { key: "industry:banking::Transaction", values: { nl: "Een debet- of creditboeking op een rekening.", pl: "Obciążenie lub uznanie zaksięgowane na rachunku.", fr: "Un débit ou un crédit passé sur un compte.", es: "Un cargo o abono registrado en una cuenta.", de: "Eine Soll- oder Habenbuchung auf einem Konto.", ar: "قيد مدين أو دائن مسجَّل على الحساب.", he: "חיוב או זיכוי שנרשם בחשבון." } },
  { key: "industry:healthcare::Claim", values: { nl: "Een declaratie voor een consult, ingediend bij een zorgverzekeraar.", pl: "Roszczenie rozliczeniowe złożone płatnikowi za wizytę.", fr: "Une demande de remboursement adressée à un payeur pour une consultation.", es: "Una reclamación de facturación presentada a un pagador por una consulta.", de: "Eine Abrechnung, die für eine Konsultation bei einem Kostenträger eingereicht wird.", ar: "مطالبة فوترة تُقدَّم إلى الجهة الدافعة عن زيارة طبية.", he: "תביעת חיוב שהוגשה לגורם המשלם עבור מפגש." } },
  { key: "industry:healthcare::Encounter", values: { nl: "Eén contactmoment tussen een patiënt en een zorgverlener.", pl: "Pojedyncza interakcja pacjenta ze świadczeniodawcą.", fr: "Une interaction unique entre un patient et un prestataire.", es: "Una única interacción entre un paciente y un proveedor.", de: "Eine einzelne Interaktion zwischen einem Patienten und einem Leistungserbringer.", ar: "تفاعل واحد بين المريض ومقدم الرعاية.", he: "אינטראקציה בודדת בין מטופל לספק שירותי בריאות." } },
  { key: "industry:healthcare::Patient", values: { nl: "Een persoon die zorg ontvangt.", pl: "Osoba otrzymująca opiekę.", fr: "Une personne qui reçoit des soins.", es: "Una persona que recibe atención.", de: "Eine Person, die Behandlung erhält.", ar: "شخص يتلقى الرعاية.", he: "אדם המקבל טיפול." } },
  { key: "industry:healthcare::Provider", values: { nl: "Een behandelaar of instelling die zorg levert.", pl: "Klinicysta lub placówka udzielająca opieki.", fr: "Un clinicien ou un établissement qui dispense des soins.", es: "Un clínico o centro que presta atención.", de: "Eine behandelnde Person oder Einrichtung, die Versorgung erbringt.", ar: "طبيب أو منشأة تقدم الرعاية.", he: "מטפל או מוסד המספק טיפול." } },
];

// ---- attribute descriptions (insurance, Phase 3.7) ----
// Only attributes that carry an `en` description (the Claims-desk Claim view), so the localized
// prose mirrors the base edition rather than inventing non-en-only text.
export const ATTR_DESCRIPTIONS: AttributeEntry[] = [
  { entity: "industry_dept:insurance:Claims:Claim", attribute: "adjuster_notes", values: { nl: "Vrije triage-/onderzoeksnotities.", pl: "Swobodne notatki triage/dochodzeniowe.", fr: "Notes libres de tri / d'enquête.", es: "Notas libres de triaje / investigación.", de: "Freitext-Triage-/Ermittlungsnotizen.", ar: "ملاحظات حرة للفرز/التحقيق.", he: "הערות מיון/חקירה חופשיות." } },
  { entity: "industry_dept:insurance:Claims:Claim", attribute: "fraud_score", values: { nl: "Door een model gescoorde kans op fraude.", pl: "Prawdopodobieństwo oszustwa ocenione przez model.", fr: "Probabilité de fraude évaluée par un modèle.", es: "Probabilidad de fraude calculada por un modelo.", de: "Modellbasierte Betrugswahrscheinlichkeit.", ar: "احتمالية الاحتيال المقدّرة بنموذج.", he: "הסתברות הונאה שדורגה על ידי מודל." } },
];

// ---- relation labels (all 30 seeded edges) ----
// ⛔ THIS LIST IS 30 ENTRIES AND 60 KEYS, AND THE DIFFERENCE IS THE WHOLE DESIGN.
// `industry: null` means the SOURCE entity is generic-layer, and the builder fans that one entry
// across every industry on the matrix axis, because `compileEffective` looks an edge up under the
// industry of the CELL it is compiling. 15 generic × 3 industries + 4 banking + 3 healthcare + 8
// insurance = 60 canonical keys. Do NOT hand-write the expanded tuples; the loop in
// buildOntologyI18nRows() is what keeps a generic edge from being Dutch on the insurance graph and
// English on the other two — the exact defect this content set was written to end: of the 23
// insurance-vertical lookup KEYS (15 generic + 8 insurance), 6 were translated and 17 rendered
// English. ⛔ 23 is a KEY count, not a cell size — the largest single cell is insurance/Marketing
// at 12 edges (measured).
//
// `requireAllLocales` is ON by default now, so a 61st edge added to the seed JSON without a label
// here fails the build instead of quietly rendering English.
export const REL_LABELS: RelationEntry[] = [
  { industry: "insurance", from: "Policy", to: "Customer", predicate: "heldBy", values: { nl: "gehouden door", pl: "posiadana przez", fr: "détenue par", es: "en poder de", de: "gehalten von", ar: "مملوكة لـ", he: "מוחזק על ידי" } },
  { industry: "insurance", from: "Policy", to: "Coverage", predicate: "hasCoverage", values: { nl: "heeft dekking", pl: "ma ochronę", fr: "a une garantie", es: "tiene cobertura", de: "hat Deckung", ar: "لديها تغطية", he: "בעל כיסוי" } },
  { industry: "insurance", from: "Claim", to: "Policy", predicate: "under", values: { nl: "ingediend onder", pl: "zgłoszone w ramach", fr: "déposé au titre de", es: "presentado bajo", de: "eingereicht unter", ar: "مقدمة بموجب", he: "הוגש תחת" } },
  { industry: "insurance", from: "Claim", to: "Adjuster", predicate: "assignedTo", values: { nl: "toegewezen aan", pl: "przypisane do", fr: "attribué à", es: "asignado a", de: "zugewiesen an", ar: "مُسند إلى", he: "הוקצה ל" } },
  { industry: "insurance", from: "Claim", to: "Coverage", predicate: "against", values: { nl: "geclaimd tegen", pl: "zgłoszone wobec", fr: "réclamé au titre de", es: "reclamado contra", de: "geltend gemacht gegen", ar: "مطالَب به مقابل", he: "נתבע כנגד" } },
  { industry: "insurance", from: "Underwriting", to: "Policy", predicate: "prices", values: { nl: "prijst", pl: "wycenia", fr: "tarife", es: "tarifica", de: "bepreist", ar: "يسعّر", he: "מתמחר" } },
  { industry: null, from: "Invoice", to: "Payment", predicate: "settledBy", values: { nl: "voldaan met", pl: "opłacona przez", fr: "réglée par", es: "saldada con", de: "beglichen durch", ar: "مسددة بـ", he: "שולמה באמצעות" } },
  { industry: null, from: "Payment", to: "Ledger", predicate: "postedTo", values: { nl: "geboekt op", pl: "zaksięgowana na", fr: "comptabilisé sur", es: "contabilizado en", de: "gebucht auf", ar: "مقيدة في", he: "נרשם ב" } },
  { industry: null, from: "Clause", to: "Obligation", predicate: "imposes", values: { nl: "creëert", pl: "nakłada", fr: "impose", es: "impone", de: "begründet", ar: "يفرض", he: "מטיל" } },
  { industry: null, from: "Contract", to: "Clause", predicate: "contains", values: { nl: "bevat", pl: "zawiera", fr: "contient", es: "contiene", de: "enthält", ar: "يتضمن", he: "מכיל" } },
  { industry: null, from: "Campaign", to: "Channel", predicate: "runsOn", values: { nl: "loopt via", pl: "prowadzona w", fr: "diffusée sur", es: "se difunde en", de: "läuft über", ar: "تُنفَّذ عبر", he: "מופץ בערוץ" } },
  { industry: null, from: "Campaign", to: "Audience", predicate: "targets", values: { nl: "richt zich op", pl: "kieruje do", fr: "cible", es: "se dirige a", de: "richtet sich an", ar: "تستهدف", he: "מכוון ל" } },
  { industry: null, from: "Campaign", to: "Content", predicate: "uses", values: { nl: "gebruikt", pl: "wykorzystuje", fr: "utilise", es: "utiliza", de: "verwendet", ar: "تستخدم", he: "משתמש ב" } },
  { industry: null, from: "Lead", to: "Campaign", predicate: "from", values: { nl: "binnengekomen via", pl: "pozyskany przez", fr: "capté par", es: "captado por", de: "erfasst über", ar: "تم التقاطه عبر", he: "נקלט דרך" } },
  { industry: null, from: "Process", to: "Task", predicate: "hasStep", values: { nl: "heeft stap", pl: "ma krok", fr: "a pour étape", es: "tiene paso", de: "hat Schritt", ar: "له خطوة", he: "כולל שלב" } },
  { industry: null, from: "Lead", to: "Opportunity", predicate: "becomes", values: { nl: "converteert naar", pl: "przekształca się w", fr: "se convertit en", es: "se convierte en", de: "wird zu", ar: "يتحول إلى", he: "הופך ל" } },
  { industry: null, from: "Opportunity", to: "Account", predicate: "for", values: { nl: "voor account", pl: "dla konta", fr: "pour le compte", es: "para la cuenta", de: "für Konto", ar: "لحساب", he: "עבור חשבון" } },
  { industry: null, from: "Opportunity", to: "Quote", predicate: "has", values: { nl: "heeft", pl: "ma", fr: "a", es: "tiene", de: "hat", ar: "لديها", he: "כולל" } },
  { industry: null, from: "Case", to: "Customer", predicate: "for", values: { nl: "voor klant", pl: "dla klienta", fr: "pour le client", es: "para el cliente", de: "für Kunde", ar: "للعميل", he: "עבור לקוח" } },
  { industry: null, from: "Ticket", to: "Case", predicate: "partOf", values: { nl: "onderdeel van", pl: "część", fr: "fait partie de", es: "parte de", de: "Teil von", ar: "جزء من", he: "חלק מ" } },
  { industry: null, from: "Ticket", to: "Customer", predicate: "raisedBy", values: { nl: "aangemeld door", pl: "zgłoszone przez", fr: "signalé par", es: "reportado por", de: "gemeldet von", ar: "مقدَّمة من", he: "נפתח על ידי" } },
  { industry: "banking", from: "Account", to: "Customer", predicate: "ownedBy", values: { nl: "op naam van", pl: "należy do", fr: "détenu par", es: "a nombre de", de: "gehört", ar: "مملوك لـ", he: "בבעלות" } },
  { industry: "banking", from: "KYC", to: "Customer", predicate: "verifies", values: { nl: "verifieert", pl: "weryfikuje", fr: "vérifie", es: "verifica", de: "verifiziert", ar: "يتحقق من", he: "מאמת" } },
  { industry: "banking", from: "Loan", to: "Customer", predicate: "heldBy", values: { nl: "gehouden door", pl: "zaciągnięta przez", fr: "souscrit par", es: "suscrito por", de: "aufgenommen von", ar: "بحوزة", he: "מוחזקת על ידי" } },
  { industry: "banking", from: "Transaction", to: "Account", predicate: "on", values: { nl: "geboekt op", pl: "zaksięgowana na", fr: "passée sur", es: "registrada en", de: "gebucht auf", ar: "مقيدة على", he: "נרשמה בחשבון" } },
  { industry: "insurance", from: "PolicyholderSegment", to: "Policy", predicate: "derivedFrom", values: { nl: "afgeleid van", pl: "wyprowadzony z", fr: "dérivé de", es: "derivado de", de: "abgeleitet aus", ar: "مشتق من", he: "נגזר מ" } },
  { industry: "insurance", from: "RenewalCampaign", to: "PolicyholderSegment", predicate: "targets", values: { nl: "richt zich op", pl: "kieruje do", fr: "cible", es: "se dirige a", de: "richtet sich an", ar: "تستهدف", he: "מכוון ל" } },
  { industry: "healthcare", from: "Claim", to: "Encounter", predicate: "from", values: { nl: "ingediend voor", pl: "rozliczone za", fr: "facturé pour", es: "facturado por", de: "abgerechnet für", ar: "مفوترة عن", he: "מחויב עבור" } },
  { industry: "healthcare", from: "Encounter", to: "Provider", predicate: "by", values: { nl: "uitgevoerd door", pl: "przeprowadzona przez", fr: "réalisée par", es: "atendido por", de: "behandelt von", ar: "أجراها", he: "בוצע על ידי" } },
  { industry: "healthcare", from: "Encounter", to: "Patient", predicate: "for", values: { nl: "voor patiënt", pl: "dla pacjenta", fr: "pour le patient", es: "para el paciente", de: "für Patient", ar: "للمريض", he: "עבור מטופל" } },
];

// ---------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------

/** One `content_translations` cell. */
export interface OntologyTranslationRow {
  entityType: string;
  entityId: string;
  locale: Locale;
  field: 'label' | 'description';
  value: string;
}

export interface BuildOntologyI18nOpts {
  /**
   * ⛔ THE COVERAGE GATE — ON BY DEFAULT. DO NOT PASS `false` TO MAKE A BUILD GO GREEN.
   *
   * Every canonical RELATION key must carry a label in every non-en locale, or this throws and
   * names each gap. It shipped OFF for exactly one change — the plumbing commit that had no
   * content yet — and is on from the content commit onward, because the failure it prevents is the
   * one that actually happened: 30 seeded edges, 6 translated, so 17 of the insurance vertical's
   * 23 lookup KEYS rendered ENGLISH for four phases with no symptom anywhere. A missing
   * translation and a wrong one look identical to the reader; both fall back to English.
   *
   * The gate is what makes that unrepeatable. Add a 61st edge to src/ontology/seed/*.json and the
   * build fails until it has a label in all 7 locales. ⛔ The fix is always to author the label —
   * never to pass `false`, and never to delete the edge from the seed to satisfy the count.
   *
   * ⛔ RELATIONS ONLY, and that asymmetry is deliberate. Entity labels and descriptions are both
   * complete (38/38) but are NOT gated: an entity added to the seed still renders its English base
   * label, which is legible. An untranslated EDGE renders an English predicate phrase in the middle
   * of an otherwise Dutch graph, which is the thing users reported.
   */
  requireAllLocales?: boolean;
  /** Injectable for tests; defaults to the real seed JSON. */
  canonical?: CanonicalKeys;
}

/**
 * Every curated ontology cell, across every authored locale.
 *
 * ⛔ NO `en` ROWS, EVER. `getTranslationsBatch` short-circuits `en` to an empty map
 * (db/translations.ts:117-135), so an `en` row is unreachable by every reader — dead weight whose
 * only possible future is to drift from the base column it shadows and to make a coverage count
 * lie. `ONTOLOGY_LOCALES` excludes it structurally; the throw below catches an entry that spells
 * it out anyway, because a silently-dropped cell and a rejected one are very different reviews.
 *
 * ⛔ EVERY KEY IS CHECKED AGAINST THE SEED. A translation keyed to an entity/attribute/relation
 * that does not exist is not an error anywhere — `content_translations` has no foreign key — it is
 * simply a row that matches nothing, in every database, forever. That is the failure this natural-
 * key scheme is exposed to (rename an entity, keep the translation), and it has NO SYMPTOM: the
 * reader falls back to English exactly as if the row had never been written. So it fails HERE,
 * naming the key, which is the only place it can be seen.
 */
export function buildOntologyI18nRows(
  opts: BuildOntologyI18nOpts = {},
): OntologyTranslationRow[] {
  const canonical = opts.canonical ?? canonicalOntologyKeys();
  // ⛔ DEFAULT ON. An omitted option must be the SAFE reading, not the permissive one — the whole
  // point of the gate is that a caller who has not thought about coverage still gets it.
  const requireAllLocales = opts.requireAllLocales ?? true;
  const out: OntologyTranslationRow[] = [];
  const seen = new Set<string>();

  const emit = (
    entityType: string,
    entityId: string,
    field: 'label' | 'description',
    values: LocaleValues,
    where: string,
  ): void => {
    if (DEFAULT_LOCALE in values) {
      throw new Error(
        `${where}: '${entityId}' carries an '${DEFAULT_LOCALE}' value. getTranslationsBatch ` +
          `short-circuits '${DEFAULT_LOCALE}', so that row is unreachable by every reader — the ` +
          `base column IS the English edition. Remove it.`,
      );
    }
    for (const locale of ONTOLOGY_LOCALES) {
      const value = values[locale];
      if (value === undefined) continue;
      const dedupe = `${entityType} ${entityId} ${locale} ${field}`;
      if (seen.has(dedupe)) {
        // Not merely redundant: the generated INSERT would carry the same primary key twice and
        // postgres refuses it ("ON CONFLICT DO UPDATE command cannot affect row a second time").
        throw new Error(`${where}: duplicate cell (${entityType}, ${entityId}, ${locale}, ${field})`);
      }
      seen.add(dedupe);
      out.push({ entityType, entityId, locale, field, value });
    }
  };

  const requireCanonical = (set: Set<string>, key: string, where: string, kind: string): void => {
    if (set.has(key)) return;
    throw new Error(
      `${where}: '${key}' matches no seeded ${kind}. content_translations has no foreign key, so ` +
        `this row would match nothing in every database rather than fail anywhere — rename the key ` +
        `or delete the entry. The canonical set comes from canonicalOntologyKeys().`,
    );
  };

  for (const e of LABELS) {
    requireCanonical(canonical.entities, e.key, 'LABELS', 'entity');
    emit(ONTOLOGY_ENTITY_I18N, e.key, 'label', e.values, 'LABELS');
  }
  for (const e of DESCRIPTIONS) {
    requireCanonical(canonical.entities, e.key, 'DESCRIPTIONS', 'entity');
    emit(ONTOLOGY_ENTITY_I18N, e.key, 'description', e.values, 'DESCRIPTIONS');
  }
  for (const a of ATTR_DESCRIPTIONS) {
    const key = attrKey(a.entity, a.attribute);
    requireCanonical(canonical.attributes, key, 'ATTR_DESCRIPTIONS', 'attribute');
    emit(ONTOLOGY_ATTRIBUTE_I18N, key, 'description', a.values, 'ATTR_DESCRIPTIONS');
  }
  for (const r of REL_LABELS) {
    // ⛔ THE COMPILE-INDUSTRY EXPANSION, done in the builder. `industry: null` (a generic-layer
    // edge) becomes one row per industry on the matrix axis, because that is how the reader keys
    // its lookup. Hand-listing those tuples is how one vertical silently keeps English.
    const industries = r.industry === null ? canonical.industries : [r.industry];
    for (const ind of industries) {
      const key = relKey(ind, r.from, r.to, r.predicate);
      requireCanonical(canonical.relations, key, 'REL_LABELS', 'relation');
      emit(ONTOLOGY_RELATION_I18N, key, 'label', r.values, 'REL_LABELS');
    }
  }

  if (requireAllLocales) {
    const have = new Set(
      out
        .filter((r) => r.entityType === ONTOLOGY_RELATION_I18N)
        .map((r) => `${r.entityId} ${r.locale}`),
    );
    const missing: string[] = [];
    for (const key of [...canonical.relations].sort()) {
      const gaps = ONTOLOGY_LOCALES.filter((l) => !have.has(`${key} ${l}`));
      if (gaps.length) missing.push(`${key} [${gaps.join(',')}]`);
    }
    if (missing.length) {
      throw new Error(
        `requireAllLocales: ${missing.length} of ${canonical.relations.size} canonical relation ` +
          `key(s) carry no translated label in one or more locales, so those edges render ENGLISH ` +
          `on a localized graph:\n  ${missing.join('\n  ')}`,
      );
    }
  }

  return out;
}
