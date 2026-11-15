// src/db/seed-ontology-tenant.ts — Phase 3.5: a per-tenant ontology EXTENSION for the
// demo org, so the three-role story (IT/admin authors → everyone browses → the agent
// reasons over it) is demonstrable live. Adds, scoped to common-practice-demo's tenant,
// a `BrokerNote` entity in the insurance × Claims cell and a relation BrokerNote →annotates→
// Claim. Idempotent (matched by tenant + natural key). Global rows are never touched.
import { and, eq, isNull } from 'drizzle-orm';
import {
  db,
  tenants,
  ontologyEntities,
  ontologyAttributes,
  ontologyRelations,
} from './client';
import {
  invalidateOntologyCache,
  entityKey,
  tenantEntityI18nId,
  ONTOLOGY_ENTITY_TENANT_I18N,
} from '../ontology/ontology-service';
import { upsertTranslation } from './translations';

const DEMO_TENANT_SLUG = 'common-practice-demo';

// The BrokerNote's reseed-stable natural key (its tenant translations are isolated under it).
const BROKER_NOTE_KEY = entityKey({
  scope: 'industry_dept',
  industry: 'insurance',
  department: 'Claims',
  name: 'BrokerNote',
});

// The demo custom entity, localized so a tenant-authored object browses in the reader's own
// language — proof a tenant-authored entity localizes, isolated to this org.
//
// ⛔ THIS USED TO BE nl AND de ONLY, and the comment above it said "a couple of locales … so
// `?locale=nl` shows a localized *custom* object". That was honest about being a Phase 3.7
// proof-of-concept, and nl/de were picked because Dutch was the locale the product was demoed in.
// It then stayed that way. Measured against the PRODUCTION database, this was the ONLY place in
// the entire 350-row `content_translations` corpus where two locales had content the other five
// did not: nl and de returned 350 rows across 9 entity types, while ar, he, es, fr and pl returned
// 346 across 8 — the missing 4 being exactly this entity's `label` + `description`. So an Arabic
// or Hebrew reader browsing the demo org's ontology saw the English
// "Broker Note" while a Dutch reader saw theirs. Arabic and Hebrew are primary markets.
//
// ⚠️ THE COVERAGE IS NOW ASSERTED AGAINST A DERIVED SET. `tests/seed-ontology-tenant-locales.test.ts`
// computes `SUPPORTED_LOCALES` minus `DEFAULT_LOCALE` and requires this array to equal it exactly. Adding a ninth locale to the product therefore fails that test
// until someone translates this entity, instead of silently reintroducing the same gap — which is
// what a hand-maintained list of "a couple of locales" cannot do.
//
// ⚠️ ar/he/es/fr/pl here are applied from the insurance sense of the terms (broker = the
// intermediary who places the policy; claim = the loss notification, not a general assertion) and
// want a native-speaker pass before anything is sold on them, same flag as the Hebrew timeago
// units. They are unambiguously better than the English they replace.
/** Exported so `tests/seed-ontology-tenant-locales.test.ts` can assert coverage without a DB. */
export const BROKER_NOTE_I18N: { locale: string; label: string; description: string }[] = [
  {
    locale: 'nl',
    label: 'Tussenpersoon-notitie',
    description: 'Een notitie van de tussenpersoon bij een claim — het eigen objecttype van deze organisatie.',
  },
  {
    locale: 'de',
    label: 'Maklernotiz',
    description: 'Eine Notiz des Maklers zu einem Schadenfall – der eigene Objekttyp dieser Organisation.',
  },
  {
    locale: 'fr',
    label: 'Note du courtier',
    description: "La note d'un courtier jointe à un sinistre — le type d'objet propre à cette organisation.",
  },
  {
    locale: 'es',
    label: 'Nota del corredor',
    description: 'La nota de un corredor adjunta a un siniestro: el tipo de objeto propio de esta organización.',
  },
  {
    locale: 'pl',
    label: 'Notatka brokera',
    description: 'Notatka brokera dołączona do szkody — własny typ obiektu tej organizacji.',
  },
  {
    locale: 'ar',
    label: 'ملاحظة الوسيط',
    description: 'ملاحظة من الوسيط مرفقة بمطالبة — نوع الكائن الخاص بهذه المؤسسة.',
  },
  {
    locale: 'he',
    label: 'הערת סוכן',
    description: 'הערה של סוכן המצורפת לתביעה — סוג האובייקט הייחודי של הארגון הזה.',
  },
];

interface Result {
  tenant: string | null;
  entities: number;
  relations: number;
}

/** Resolve the global Claim entity the BrokerNote should annotate: the Claims-desk cell
 *  view first, then the insurance overlay. Null if the ontology isn't seeded yet. */
async function resolveClaimId(): Promise<string | null> {
  const [cell] = await db
    .select({ id: ontologyEntities.id })
    .from(ontologyEntities)
    .where(
      and(
        eq(ontologyEntities.scope, 'industry_dept'),
        eq(ontologyEntities.industry, 'insurance'),
        eq(ontologyEntities.department, 'Claims'),
        eq(ontologyEntities.name, 'Claim'),
        isNull(ontologyEntities.tenant_id),
      ),
    );
  if (cell) return cell.id;
  const [overlay] = await db
    .select({ id: ontologyEntities.id })
    .from(ontologyEntities)
    .where(
      and(
        eq(ontologyEntities.scope, 'industry'),
        eq(ontologyEntities.industry, 'insurance'),
        eq(ontologyEntities.name, 'Claim'),
        isNull(ontologyEntities.tenant_id),
      ),
    );
  return overlay?.id ?? null;
}

export async function seedOntologyTenant(): Promise<Result> {
  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, DEMO_TENANT_SLUG));
  if (!tenant) return { tenant: null, entities: 0, relations: 0 };
  const tenantId = tenant.id;

  let entities = 0;
  let relations = 0;

  // ---- BrokerNote (tenant entity in insurance × Claims) ----
  const [existing] = await db
    .select({ id: ontologyEntities.id })
    .from(ontologyEntities)
    .where(
      and(
        eq(ontologyEntities.scope, 'industry_dept'),
        eq(ontologyEntities.industry, 'insurance'),
        eq(ontologyEntities.department, 'Claims'),
        eq(ontologyEntities.name, 'BrokerNote'),
        eq(ontologyEntities.tenant_id, tenantId),
      ),
    );
  let brokerNoteId: string;
  if (existing) {
    brokerNoteId = existing.id;
  } else {
    const [row] = await db
      .insert(ontologyEntities)
      .values({
        scope: 'industry_dept',
        industry: 'insurance',
        department: 'Claims',
        name: 'BrokerNote',
        label: 'Broker Note',
        synonyms: ['broker_memo', 'intermediary_note'],
        description: "A broker's note attached to a claim — this org's own object type.",
        tenant_id: tenantId,
      })
      .returning({ id: ontologyEntities.id });
    brokerNoteId = row!.id;
    entities++;
    await db.insert(ontologyAttributes).values([
      { entity_id: brokerNoteId, name: 'note_id', type: 'string', synonyms: ['memo_id'], pii: false, description: 'Identifier of the broker note.' },
      { entity_id: brokerNoteId, name: 'author', type: 'string', synonyms: ['broker'], pii: true, description: 'The broker who wrote the note.' },
      { entity_id: brokerNoteId, name: 'body', type: 'string', synonyms: ['text'], pii: false, description: 'The note text.' },
    ]);
  }

  // ---- BrokerNote tenant translations (all 7 non-en locales) — isolated under the tenant id ----
  const i18nId = tenantEntityI18nId(tenantId, BROKER_NOTE_KEY);
  for (const { locale, label, description } of BROKER_NOTE_I18N) {
    await upsertTranslation(ONTOLOGY_ENTITY_TENANT_I18N, i18nId, locale, 'label', label);
    await upsertTranslation(ONTOLOGY_ENTITY_TENANT_I18N, i18nId, locale, 'description', description);
  }

  // ---- BrokerNote →annotates→ Claim (tenant relation) ----
  const claimId = await resolveClaimId();
  if (claimId) {
    const [rel] = await db
      .select({ id: ontologyRelations.id })
      .from(ontologyRelations)
      .where(
        and(
          eq(ontologyRelations.from_entity, brokerNoteId),
          eq(ontologyRelations.to_entity, claimId),
          eq(ontologyRelations.predicate, 'annotates'),
          eq(ontologyRelations.tenant_id, tenantId),
        ),
      );
    if (!rel) {
      await db.insert(ontologyRelations).values({
        from_entity: brokerNoteId,
        to_entity: claimId,
        predicate: 'annotates',
        label: 'annotates',
        cardinality: 'many-to-one',
        tenant_id: tenantId,
      });
      relations++;
    }
  }

  invalidateOntologyCache();
  return { tenant: DEMO_TENANT_SLUG, entities, relations };
}
