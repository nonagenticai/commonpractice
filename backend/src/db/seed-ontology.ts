// src/db/seed-ontology.ts — Phase 3.2: load the native-JSON ontology seed
// (src/ontology/seed/*.json) into ontology_entities / _attributes / _relations.
//
// Scope is derived per entity: no file `industry` => generic (entity carries its
// `department`); file `industry` + no entity `department` => industry overlay;
// file `industry` + entity `department` => the (industry × department) cell.
//
// Idempotent (matches seed-datasets.ts): entities matched by natural key
// (scope, industry, department, name, tenant=NULL), attributes by (entity, name),
// relations by (from, to, predicate). Relation targets resolve by name across the
// whole global ontology, preferring same-department, then same-industry, then
// generic — so collisions (`Lead` in Marketing+Sales, `Claim` in insurance+
// healthcare) bind correctly. All seeded rows are global (tenant_id NULL).
import { and, eq, isNull } from 'drizzle-orm';
import {
  db,
  ontologyEntities,
  ontologyAttributes,
  ontologyRelations,
} from './client';
import { invalidateOntologyCache } from '../ontology/ontology-service';
// ⛔ ONE COPY OF THE SEED-JSON LAYER. The file list, the loader and deriveScope() used to live
// here; they now live in ontology/i18n-seed.ts alongside canonicalOntologyKeys(), which validates
// every translation key against the rows THIS function writes. A second copy would let the two
// drift — and a translation keyed to a row that no longer exists fails NOWHERE (content_translations
// has no foreign key), it just silently serves English forever.
import {
  ONTOLOGY_SEED_FILES,
  deriveScope,
  loadOntologySeedFile,
  type SeedEntity,
  type SeedRelation,
  type Scope,
} from '../ontology/i18n-seed';
import { log } from '../host/logger';

// Loaded ⇒ inserted/existing entity, kept for attribute + relation wiring.
interface EntityRecord {
  id: string;
  scope: Scope;
  industry: string | null;
  department: string | null;
  name: string;
  seed: SeedEntity;
}

/** Pick the best target among same-name candidates for a relation from `source`. */
function resolveTarget(
  source: EntityRecord,
  rel: SeedRelation,
  byName: Map<string, EntityRecord[]>,
): EntityRecord | null {
  let candidates = byName.get(rel.to) ?? [];
  if (rel.toDepartment) {
    candidates = candidates.filter((c) => c.department === rel.toDepartment);
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  const sameDept = candidates.find((c) => c.department && c.department === source.department);
  if (sameDept) return sameDept;
  const sameIndustry = candidates.find((c) => c.industry && c.industry === source.industry);
  if (sameIndustry) return sameIndustry;
  const generic = candidates.find((c) => c.scope === 'generic');
  if (generic) return generic;
  return candidates[0]!;
}

export async function seedOntology(): Promise<{
  entities: number;
  attributes: number;
  relations: number;
}> {
  const records: EntityRecord[] = [];
  let createdEntities = 0;

  // ---- entities (all files first, so relation targets are all present) ----
  for (const file of ONTOLOGY_SEED_FILES) {
    const seed = loadOntologySeedFile(file);
    for (const entity of seed.entities) {
      const { scope, industry, department } = deriveScope(seed, entity);
      const [existing] = await db
        .select({ id: ontologyEntities.id })
        .from(ontologyEntities)
        .where(
          and(
            eq(ontologyEntities.scope, scope),
            industry === null ? isNull(ontologyEntities.industry) : eq(ontologyEntities.industry, industry),
            department === null ? isNull(ontologyEntities.department) : eq(ontologyEntities.department, department),
            eq(ontologyEntities.name, entity.name),
            isNull(ontologyEntities.tenant_id),
          ),
        );
      let id: string;
      if (existing) {
        id = existing.id;
      } else {
        const [row] = await db
          .insert(ontologyEntities)
          .values({
            scope,
            industry,
            department,
            name: entity.name,
            label: entity.label,
            synonyms: entity.synonyms ?? [],
            description: entity.description ?? null,
          })
          .returning({ id: ontologyEntities.id });
        id = row!.id;
        createdEntities++;
      }
      records.push({ id, scope, industry, department, name: entity.name, seed: entity });
    }
  }

  // ---- attributes (idempotent by entity_id + name) ----
  let createdAttributes = 0;
  for (const rec of records) {
    for (const attr of rec.seed.attributes ?? []) {
      const [existing] = await db
        .select({ id: ontologyAttributes.id })
        .from(ontologyAttributes)
        .where(and(eq(ontologyAttributes.entity_id, rec.id), eq(ontologyAttributes.name, attr.name)));
      if (existing) continue;
      await db.insert(ontologyAttributes).values({
        entity_id: rec.id,
        name: attr.name,
        type: attr.type,
        synonyms: attr.synonyms ?? [],
        pii: attr.pii ?? false,
        description: attr.description ?? null,
      });
      createdAttributes++;
    }
  }

  // ---- relations (resolve target by name; idempotent by from+to+predicate) ----
  const byName = new Map<string, EntityRecord[]>();
  for (const rec of records) {
    const list = byName.get(rec.name) ?? [];
    list.push(rec);
    byName.set(rec.name, list);
  }

  let createdRelations = 0;
  for (const rec of records) {
    for (const rel of rec.seed.relations ?? []) {
      const target = resolveTarget(rec, rel, byName);
      if (!target) {
        log.warn('seed_ontology_relation_unresolved', { component: 'seed-ontology', from: rec.name, predicate: rel.predicate, to: rel.to });
        continue;
      }
      const [existing] = await db
        .select({ id: ontologyRelations.id })
        .from(ontologyRelations)
        .where(
          and(
            eq(ontologyRelations.from_entity, rec.id),
            eq(ontologyRelations.to_entity, target.id),
            eq(ontologyRelations.predicate, rel.predicate),
          ),
        );
      if (existing) continue;
      await db.insert(ontologyRelations).values({
        from_entity: rec.id,
        to_entity: target.id,
        predicate: rel.predicate,
        label: rel.label ?? '',
        cardinality: rel.cardinality ?? '',
      });
      createdRelations++;
    }
  }

  invalidateOntologyCache();
  return { entities: createdEntities, attributes: createdAttributes, relations: createdRelations };
}
