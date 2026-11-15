// src/ontology/ontology-service.ts — Phase 3.2 Pillar B: the matrix engine.
//
// A lightweight, declarative ontology stored as normalized rows (ontology_entities
// / _attributes / _relations) and composed at query time into the "effective"
// graph for a given (industry, department):
//
//   effective(industry, dept) = base(dept)                    # generic, cross-industry
//                             ⊕ industryOverlay(industry)      # industry-wide entities
//                             ⊕ specialization(industry, dept) # the matrix cell
//
// Entities merge by `name` (later layer wins on scalar fields; synonyms + attributes
// are unioned). Relations whose `from` is in the layered set pull their `to` entity
// in (one hop) so cross-layer edges — e.g. insurance `Policy —heldBy→ Customer`
// (Customer is generic/Service) — stay connected in any cell. The compiled JSON view
// is the ONLY shape consumers (the Ontology screen now; the agent in 3.4) need — the
// layering stays server-side. Reads are memoized per (industry, department) for the
// shipped global ontology; any write must call invalidateOntologyCache().
//
// No reasoner, no Python — pure drizzle + in-process merge. Mirrors the service shape
// of datasets/dataset-service.ts (an optional `database` param keeps it test-friendly).
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  db as defaultDb,
  ontologyEntities,
  ontologyAttributes,
  ontologyRelations,
} from '../db/client';
import type { OntologyEntity, OntologyRelation } from '../db/schema';
import {
  getTranslationsBatch,
  upsertTranslation,
  deleteTranslation,
  listTranslations,
} from '../db/translations';
import { DEFAULT_LOCALE, isSupportedLocale } from '../utils/locale';
import { badRequest, conflict, notFound } from '../utils/http';

type Db = typeof defaultDb;
/** `db` OR a `db.transaction(...)` handle — attribute writes run inside one (see updateTenantEntity). */
type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** The content_translations entity_type for GLOBAL ontology entity label/description i18n
 *  (keyed by the natural key — shared by every tenant). */
export const ONTOLOGY_ENTITY_I18N = 'ontology_entity';
/** entity_type for TENANT-authored entity label/description i18n (3.7). A tenant override
 *  shares the global natural key, so its translations are stored under a tenant-scoped id
 *  (tenantEntityI18nId) to stay isolated across orgs. */
export const ONTOLOGY_ENTITY_TENANT_I18N = 'ontology_entity_tenant';
/** entity_type for attribute `description` i18n (3.7); keyed by attrKey(entityKey, name). */
export const ONTOLOGY_ATTRIBUTE_I18N = 'ontology_attribute';
/** entity_type for relation `label` i18n (3.7); keyed by relKey(industry, from, to, pred). */
export const ONTOLOGY_RELATION_I18N = 'ontology_relation';

/** Tenant-isolated content_translations id for a tenant-authored entity (3.7). */
export function tenantEntityI18nId(tenantId: string, key: string): string {
  return `${tenantId}:${key}`;
}
/** Reseed-stable i18n id for an attribute: the owning entity's natural key + '#' + name. */
export function attrKey(entityKey: string, attributeName: string): string {
  return `${entityKey}#${attributeName}`;
}
/** Reseed-stable i18n id for a relation label, qualified by the compile industry so the
 *  same (from,to,predicate) name-tuple in two verticals stays distinct. */
export function relKey(industry: string, from: string, to: string, predicate: string): string {
  return `${industry}:${from}->${to}:${predicate}`;
}

/** Stable, reseed-proof natural key for an entity (i18n id + FE identity). Entity uuids
 *  churn on a DB reset; this composite does not. Names aren't globally unique
 *  (Lead/Claim recur) so scope+industry+department disambiguate. */
export function entityKey(e: {
  scope: string;
  industry: string | null;
  department: string | null;
  name: string;
}): string {
  return `${e.scope}:${e.industry ?? ''}:${e.department ?? ''}:${e.name}`;
}

// ---- The compiled JSON view (the only shape consumers see) ----

export interface CompiledAttribute {
  name: string;
  type: string;
  synonyms: string[];
  pii: boolean;
  description: string | null;
}

export interface CompiledEntity {
  /** The canonical ontology_entities.id (the highest-layer row for this name) — the
   *  3.3 dataset-mapping bridge and the 3.4 agent FK against this. For a tenant override
   *  this is the TENANT row's id, so the editor PATCHes the right row. */
  id: string;
  /** Reseed-stable natural key (i18n id + FE identity). See entityKey(). */
  key: string;
  name: string;
  label: string;
  synonyms: string[];
  description: string | null;
  /** Which layer contributed this entity (highest layer that defined it). */
  scope: 'generic' | 'industry' | 'industry_dept';
  /** True when the highest-precedence row is a per-tenant override/extension (3.5) —
   *  the editor gates edit/delete on this. */
  tenantOwned: boolean;
  attributes: CompiledAttribute[];
}

export interface CompiledRelation {
  /** The edge row id of the highest-precedence (tenant > global) row — the editor
   *  deletes tenant edges by this id. */
  id: string;
  from: string;
  to: string;
  predicate: string;
  label: string;
  cardinality: string;
  /** True when this edge is a per-tenant override/extension (3.5). */
  tenantOwned: boolean;
}

/** A global entity a tenant has tombstoned (3.7): excluded from `entities`/`relations`, but
 *  listed here (with the GLOBAL entity id) so an admin can unhide it. */
export interface CompiledHidden {
  /** The global ontology_entities.id — the hide/unhide route target. */
  id: string;
  key: string;
  name: string;
  label: string;
}

export interface CompiledOntology {
  industry: string;
  department: string;
  entities: CompiledEntity[];
  relations: CompiledRelation[];
  /** Global entities this tenant has hidden (3.7). Empty for the global/no-tenant compile. */
  hidden: CompiledHidden[];
}

export interface MatrixCell {
  industry: string;
  department: string;
  /** True when an industry_dept specialization row exists for this cell. */
  hasSpecialization: boolean;
}

export interface MatrixData {
  industries: string[];
  departments: string[];
  cells: MatrixCell[];
}

// Layer precedence for the merge — a later layer wins on scalar fields.
const SCOPE_RANK: Record<OntologyEntity['scope'], number> = {
  generic: 0,
  industry: 1,
  industry_dept: 2,
};

// ---- Memoization (shipped global ontology only) ----
//
// ⚠️ THE TTL IS A BOUND, NOT A FIX. `invalidateOntologyCache()` is an in-process `Map.clear()` and
// nothing carries it across a process boundary. Production runs 2 replicas with no sessionAffinity
// and no DestinationRule, so a write served by pod A clears pod A ONLY. Every write handler on
// /ontology is `await write(); await loadGraph();` and `loadGraph()` is a fresh fetch through the
// Service — it lands on pod B ~50% of the time, and pod B answers from a cache that never heard
// about the row. Before the TTL that meant pod B stayed stale until it happened to serve a write
// for that tenant or restarted, so the user's own edit flickered in and out across page reloads;
// the same stale graph feeds datasets/mapping-service.ts and the MCP tools/resources.
//
// The TTL converts "wrong until the pod restarts" into "wrong for ≤5s". It does NOT eliminate the
// staleness — a reload inside the window still shows the pre-write graph. Cross-process
// invalidation (pg_notify) is the actual fix and is a follow-up; the TTL has to land first because
// it is the only thing that holds when the listener is down. `startConnectorListener()` is `void`-ed
// and a pod stuck in listener backoff still serves traffic, so a fix that depends solely on a live
// LISTEN would be silently absent exactly when it is needed.
//
// Shape (TTL, `{value, at}` entry, injectable clock) is lifted verbatim from the house precedent in
// host/policy-store.ts — same 5s, same `now: number = Date.now()` seam — so there is one cache
// idiom in this codebase, not two. 5s is comfortably affordable here: an uncached compile of a
// seeded cell measures p50 7.4ms / p95 11.8ms for `en` and p50 11.8ms / p95 24.5ms for `nl`
// (48 samples per locale, 4 cells), so the TTL costs at most one ~10-25ms recompile per key per 5s.
const CACHE_TTL_MS = 5_000;
/** Bound on distinct keys. The key is `(tenant, locale, industry, department)` and routes/ontology.ts
 *  validates only that industry/department are NON-EMPTY — never that they name a real matrix cell —
 *  so `?industry=x&department=<anything>` mints a fresh entry holding a whole compiled graph. Without
 *  a cap that is a memory leak any authenticated caller can drive. FIFO eviction: `Map` iterates in
 *  insertion order, so the oldest key is `keys().next()`. Deterministic, and it needs no clock. */
const MAX_ENTRIES = 200;
const compileCache = new Map<string, { compiled: CompiledOntology; at: number }>();

/** Drop the compiled-graph cache. Call after ANY ontology write (seed/override).
 *  IN-PROCESS ONLY — see the note above; the other replica keeps its copy for up to CACHE_TTL_MS. */
export function invalidateOntologyCache(): void {
  compileCache.clear();
}

/** TEST-ONLY. Exposes the cache's size/keys so the size bound can be asserted without reaching into
 *  module internals. Production never calls this (house pattern — cf. __setSnapshotOverrideForTests
 *  in host/policy-store.ts). */
export function __cacheStatsForTests(): { size: number; maxEntries: number; keys: string[] } {
  return { size: compileCache.size, maxEntries: MAX_ENTRIES, keys: [...compileCache.keys()] };
}

/** The minimum an object needs to carry to have its entity label/description localized: the
 *  reseed-stable natural key (`entityKey`) and whether the row is tenant-authored. */
export interface LocalizableEntityLabel {
  key: string;
  tenantOwned: boolean;
  label: string;
  description?: string | null;
}

/**
 * Overlay `content_translations` onto the `label` (and `description`, when present) of a batch of
 * ontology entities, IN PLACE. Missing rows fall through to the en base columns.
 *
 * ⛔ THE ONE PLACE THIS JOIN LIVES. It was written inline inside `compileEffective` and nowhere
 * else, which is precisely how the same entity came to read "Tussenpersoon-notitie" on /ontology
 * and "Broker Note" on /challenges/[id]: the challenge chips reach an entity label through
 * `resolveChallengeEntities` → `listMappings`, a path that joined `ontology_entities.label` and had
 * no idea `content_translations` existed (`grep -n locale mapping-service.ts` returned nothing).
 * Two mechanisms for one word is the defect; a second copy of the join would have been the same
 * defect with better odds. Callers hand in whatever shape they already have.
 *
 * TWO PASSES, NOT ONE, and the split is load-bearing: a GLOBAL entity's translation is keyed by the
 * shared natural key under `ontology_entity`, while a TENANT row — an override authored its own
 * label — is keyed by `tenantEntityI18nId(tenantId, key)` under `ontology_entity_tenant` so two orgs
 * overriding the same global entity never see each other's words. Collapsing them would let a
 * global translation clobber a tenant's own label.
 *
 * A no-op for `DEFAULT_LOCALE`, an empty batch, or a tenant-owned batch with no `tenantId` — the
 * same conditions `getTranslationsBatch` already short-circuits on, so it costs no query.
 */
export async function localizeEntityLabels<T extends LocalizableEntityLabel>(
  items: T[],
  opts: { locale: string; tenantId?: string | null; database?: Db },
): Promise<T[]> {
  const { locale, tenantId = null } = opts;
  const database = opts.database ?? defaultDb;
  if (locale === DEFAULT_LOCALE || items.length === 0) return items;

  const apply = (item: T, t: Record<string, string> | undefined) => {
    if (!t) return;
    if (t.label) item.label = t.label;
    // `description` is optional on the interface: only overlay it where the caller carries one, so
    // a shape without it (the mapping rows) does not sprout a field on the wire.
    if (t.description && 'description' in item) item.description = t.description;
  };

  // Pass 1 — GLOBAL entities, keyed by the natural key (shared by every tenant).
  const globals = items.filter((e) => !e.tenantOwned);
  if (globals.length) {
    const tx = await getTranslationsBatch(
      ONTOLOGY_ENTITY_I18N,
      globals.map((e) => e.key),
      locale,
      ['label', 'description'],
      database,
    );
    for (const e of globals) apply(e, tx.get(e.key));
  }

  // Pass 2 — TENANT-authored entities, isolated per org.
  const owned = tenantId ? items.filter((e) => e.tenantOwned) : [];
  if (owned.length) {
    const tx = await getTranslationsBatch(
      ONTOLOGY_ENTITY_TENANT_I18N,
      owned.map((e) => tenantEntityI18nId(tenantId!, e.key)),
      locale,
      ['label', 'description'],
      database,
    );
    for (const e of owned) apply(e, tx.get(tenantEntityI18nId(tenantId!, e.key)));
  }

  return items;
}

export interface CompileOpts {
  /** Overlay this tenant's overrides/extensions on top of the global ontology (3.5). */
  tenantId?: string | null;
  /** Localize entity label/description to this locale via content_translations (3.5).
   *  Defaults to 'en' (the base columns). */
  locale?: string;
  database?: Db;
  /** Injectable clock for the memoization TTL, mirroring `getSnapshot(database, now)` in
   *  host/policy-store.ts. Tests cross the TTL boundary by arithmetic instead of by waiting.
   *  Production never passes it. */
  now?: number;
}

/**
 * Compose the effective ontology for (industry, department): merge the three global
 * layers, overlay the tenant's overrides/extensions (3.5), resolve relations to in-graph
 * entities, then localize labels (3.5). Memoized per (tenant, locale, industry, dept) for
 * the shipped global DB; any write must call invalidateOntologyCache().
 */
export async function compileEffective(
  industry: string,
  department: string,
  opts: CompileOpts = {},
): Promise<CompiledOntology> {
  const database = opts.database ?? defaultDb;
  const tenantId = opts.tenantId ?? null;
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const now = opts.now ?? Date.now();
  const key = `${tenantId ?? 'global'}::${locale}::${industry}::${department}`;
  if (database === defaultDb) {
    const hit = compileCache.get(key);
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.compiled;
  }

  // The three global layers (tenant_id IS NULL) plus, when a tenant is given, that
  // tenant's overrides/extensions for the same cell. The merge below lets tenant rows
  // win over the global row of the same name (tenant rank > scope rank).
  const tenantScope = tenantId
    ? or(isNull(ontologyEntities.tenant_id), eq(ontologyEntities.tenant_id, tenantId))
    : isNull(ontologyEntities.tenant_id);
  const layered = await database
    .select()
    .from(ontologyEntities)
    .where(
      and(
        tenantScope,
        sql`(
          (${ontologyEntities.scope} = 'generic' AND ${ontologyEntities.department} = ${department})
          OR (${ontologyEntities.scope} = 'industry' AND ${ontologyEntities.industry} = ${industry})
          OR (${ontologyEntities.scope} = 'industry_dept' AND ${ontologyEntities.industry} = ${industry} AND ${ontologyEntities.department} = ${department})
        )`,
      ),
    );

  const layeredIds = layered.map((e) => e.id);

  // One-hop expansion: relations leaving the layered set pull their targets in so
  // cross-layer edges (e.g. Policy → generic Customer) survive in any cell. Tenant edges
  // (incl. global→tenant additions) are scoped to NULL-or-this-tenant.
  const relTenantScope = tenantId
    ? or(isNull(ontologyRelations.tenant_id), eq(ontologyRelations.tenant_id, tenantId))
    : isNull(ontologyRelations.tenant_id);
  const outgoing = layeredIds.length
    ? await database
        .select()
        .from(ontologyRelations)
        .where(and(inArray(ontologyRelations.from_entity, layeredIds), relTenantScope))
    : [];

  const expansionIds = [
    ...new Set(outgoing.map((r) => r.to_entity).filter((id) => !layeredIds.includes(id))),
  ];
  const expansion = expansionIds.length
    ? await database
        .select()
        .from(ontologyEntities)
        .where(inArray(ontologyEntities.id, expansionIds))
    : [];

  // Tenant TOMBSTONES for the expansion-reached entities (3.7).
  //
  // ⛔ The expansion above fetches BY RAW GLOBAL ID, and a tombstone is a separate tenant row
  // carrying the GLOBAL's natural key — never the viewed cell's. For a LAYERED entity that costs
  // nothing (the same predicate that selected the global also selects the tenant sibling), but an
  // expansion-reached entity has, by construction, a key this cell's predicate cannot select:
  // insurance `Policy —heldBy→ Customer` puts generic/·/Service `Customer` in (insurance, Claims),
  // where `scope='generic' AND department='Claims'` matches nothing. So the tombstone was written
  // and then never read back: POST /hide answered 200, wrote its audit row, and the entity stayed
  // on screen with no unhide chip because `hidden[]` was empty too.
  //
  // The lookup is `tenantRowForGlobal` — literally the predicate the WRITE side (findTenantRow)
  // uses to decide whether a tombstone already exists, so the two cannot drift apart again.
  //
  // Deliberately TOMBSTONES ONLY (`hidden = true`). Pulling non-hidden overrides in here would let
  // a foreign cell hand out the tenant row's id as an expansion entity's canonical `id` — the
  // 3.3 dataset-mapping bridge FKs against that id — which is a product question about where an
  // override is editable, not this defect.
  //
  // NB this runs AFTER `expansionIds` is computed and adds no edge: the one-hop expansion at :337
  // still selects exactly the same target set it did before.
  const tenantTombstones =
    tenantId && expansion.length
      ? await database
          .select()
          .from(ontologyEntities)
          .where(
            and(
              eq(ontologyEntities.hidden, true),
              or(...expansion.map((g) => tenantRowForGlobal(tenantId, g))),
            ),
          )
      : [];

  const allEntities = [...layered, ...expansion, ...tenantTombstones];
  const allIds = allEntities.map((e) => e.id);
  const idToName = new Map(allEntities.map((e) => [e.id, e.name]));

  // Attributes for every in-graph entity.
  const attrs = allIds.length
    ? await database
        .select()
        .from(ontologyAttributes)
        .where(inArray(ontologyAttributes.entity_id, allIds))
    : [];
  const attrsByEntity = new Map<string, typeof attrs>();
  for (const a of attrs) {
    const list = attrsByEntity.get(a.entity_id) ?? [];
    list.push(a);
    attrsByEntity.set(a.entity_id, list);
  }

  // Merge entity rows by name (later layer wins on scalars; synonyms + attrs unioned).
  // A tenant override/extension always outranks a global row of the same name (rank +10),
  // so it wins scalars + contributes the editable tenant id / tenantOwned flag.
  const merged = new Map<string, CompiledEntity>();
  // A tenant TOMBSTONE (3.7) is a tenant row carrying hidden=true; the winner (highest rank,
  // processed last) for each name decides whether the entity is hidden for this tenant.
  const hiddenByName = new Map<string, boolean>();
  const rank = (e: OntologyEntity) => (e.tenant_id ? 10 : 0) + SCOPE_RANK[e.scope];
  const ordered = [...allEntities].sort((a, b) => rank(a) - rank(b));
  for (const e of ordered) {
    hiddenByName.set(e.name, !!e.tenant_id && e.hidden);
    const existing = merged.get(e.name);
    const entityAttrs = attrsByEntity.get(e.id) ?? [];
    if (!existing) {
      merged.set(e.name, {
        id: e.id,
        key: entityKey(e),
        name: e.name,
        label: e.label,
        synonyms: [...(e.synonyms ?? [])],
        description: e.description,
        scope: e.scope,
        tenantOwned: !!e.tenant_id,
        attributes: entityAttrs.map(toCompiledAttribute),
      });
      continue;
    }
    // Higher-or-equal rank overrides scalar fields (incl. the canonical id + tenant flag).
    existing.id = e.id;
    existing.key = entityKey(e);
    existing.label = e.label;
    if (e.description) existing.description = e.description;
    existing.scope = e.scope;
    existing.tenantOwned = !!e.tenant_id;
    existing.synonyms = unionStrings(existing.synonyms, e.synonyms ?? []);
    mergeAttributes(existing.attributes, entityAttrs.map(toCompiledAttribute));
  }

  // Tombstone filtering (3.7): a hidden-winning entity is dropped from the graph the
  // agent/builder consume, and surfaced in `hidden[]` (carrying the GLOBAL id) so an admin
  // can unhide it. Relations touching a hidden entity are dropped too.
  const hiddenNames = new Set(
    [...hiddenByName.entries()].filter(([, h]) => h).map(([n]) => n),
  );
  const entities = [...merged.values()].filter((e) => !hiddenNames.has(e.name));
  const hidden: CompiledHidden[] = [];
  for (const name of hiddenNames) {
    const g = allEntities.find((r) => r.name === name && r.tenant_id === null);
    if (g) hidden.push({ id: g.id, key: entityKey(g), name, label: g.label });
  }

  // Relations among the final entity set (dedup by from/to/predicate name-tuple; a tenant
  // edge wins over the global edge of the same tuple — sorted global-first, last write wins).
  const finalIdSet = new Set(allIds);
  const relByKey = new Map<string, CompiledRelation>();
  const relsOrdered = [...outgoing].sort((a, b) => (a.tenant_id ? 1 : 0) - (b.tenant_id ? 1 : 0));
  for (const r of relsOrdered) {
    if (!finalIdSet.has(r.from_entity) || !finalIdSet.has(r.to_entity)) continue;
    const from = idToName.get(r.from_entity)!;
    const to = idToName.get(r.to_entity)!;
    if (hiddenNames.has(from) || hiddenNames.has(to)) continue;
    relByKey.set(`${from}->${to}:${r.predicate}`, {
      id: r.id,
      from,
      to,
      predicate: r.predicate,
      label: r.label,
      cardinality: r.cardinality,
      tenantOwned: !!r.tenant_id,
    });
  }
  const relations = [...relByKey.values()];

  // Localize display prose (missing rows fall back to the en base columns). Predicates and
  // attribute names stay canonical en (agent concept stability); only display prose moves.
  if (locale !== DEFAULT_LOCALE) {
    // Passes 1 + 2 — GLOBAL then TENANT entity label/description. Both used to be written out
    // here; they are now `localizeEntityLabels` above, so the dataset-mapping path
    // (mapping-service.listMappings, which feeds the challenge-detail "involves" chips) resolves
    // an entity's words through the SAME join instead of reading the raw en column. Behaviour
    // here is unchanged — the helper is that code, moved.
    await localizeEntityLabels(entities, { locale, tenantId, database });

    // ⛔ AND THE HIDDEN LIST, THROUGH THE SAME OVERLAY. `hidden[]` is built above from the raw
    // `g.label` — the en base column — while `entities` goes through the join. So the "Verborgen"
    // chip row on /ontology (+page.svelte) read "Adjuster" directly beneath a graph whose every
    // node read "Schade-expert": the SAME entity, named twice, in two languages, six pixels apart.
    // The chip is also the only place that entity appears at all once it is tombstoned, so the
    // admin deciding whether to unhide it was reading the one label the overlay never reached.
    //
    // ⚠️ VIA A SHIM, NOT BY WIDENING `CompiledHidden`. `localizeEntityLabels` needs `tenantOwned`
    // to choose between its global and its per-tenant keyspace, and a hidden row is GLOBAL BY
    // CONSTRUCTION — it is only pushed for `r.tenant_id === null` (a tenant cannot tombstone its
    // own entity; it deletes it). Adding the field to the interface would put a boolean on the
    // wire that is always `false`, which reads as a distinction that exists. The shim states the
    // fact locally instead, and `key` is already `entityKey(g)`, the very key pass 1 looks up.
    if (hidden.length) {
      const shims = hidden.map((h) => ({ key: h.key, tenantOwned: false, label: h.label }));
      await localizeEntityLabels(shims, { locale, tenantId, database });
      // Index-parallel by construction — `shims` is a `.map` of `hidden` and neither is reordered.
      for (let i = 0; i < hidden.length; i++) hidden[i]!.label = shims[i]!.label;
    }

    // Pass 3 — attribute `description` + relation `label` (3.7).
    const attrIndex = new Map<string, CompiledAttribute>();
    for (const e of entities) {
      for (const a of e.attributes) attrIndex.set(attrKey(e.key, a.name), a);
    }
    if (attrIndex.size) {
      const tx = await getTranslationsBatch(
        ONTOLOGY_ATTRIBUTE_I18N,
        [...attrIndex.keys()],
        locale,
        ['description'],
        database,
      );
      for (const [k, a] of attrIndex) {
        const t = tx.get(k);
        if (t?.description) a.description = t.description;
      }
    }
    if (relations.length) {
      const relIndex = new Map<string, CompiledRelation>();
      for (const r of relations) relIndex.set(relKey(industry, r.from, r.to, r.predicate), r);
      const tx = await getTranslationsBatch(
        ONTOLOGY_RELATION_I18N,
        [...relIndex.keys()],
        locale,
        ['label'],
        database,
      );
      for (const [k, r] of relIndex) {
        const t = tx.get(k);
        if (t?.label) r.label = t.label;
      }
    }
  }

  const compiled: CompiledOntology = {
    industry,
    department,
    entities,
    relations,
    hidden,
  };
  if (database === defaultDb) {
    // Evict BEFORE inserting, and only when this key is genuinely new — re-setting an existing key
    // does not grow the Map, and evicting on a refresh would throw away a live neighbour for free.
    if (!compileCache.has(key) && compileCache.size >= MAX_ENTRIES) {
      compileCache.delete(compileCache.keys().next().value!);
    }
    compileCache.set(key, { compiled, at: now });
  }
  return compiled;
}

function toCompiledAttribute(a: {
  name: string;
  type: string;
  synonyms: string[] | null;
  pii: boolean;
  description: string | null;
}): CompiledAttribute {
  return {
    name: a.name,
    type: a.type,
    synonyms: [...(a.synonyms ?? [])],
    pii: a.pii,
    description: a.description,
  };
}

function unionStrings(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** Union attributes by name in-place; a later (higher-rank) attribute wins. */
function mergeAttributes(into: CompiledAttribute[], incoming: CompiledAttribute[]): void {
  for (const attr of incoming) {
    const idx = into.findIndex((x) => x.name === attr.name);
    if (idx === -1) into.push(attr);
    else into[idx] = { ...attr, synonyms: unionStrings(into[idx]!.synonyms, attr.synonyms) };
  }
}

/**
 * The available (industry × department) cells for the screen's matrix selector:
 * distinct industries (from industry/industry_dept rows) × the union of generic +
 * industry-specific departments, each flagged when a specialization cell exists.
 */
export async function listMatrix(
  opts: { tenantId?: string | null; database?: Db } = {},
): Promise<MatrixData> {
  const database = opts.database ?? defaultDb;
  const tenantId = opts.tenantId ?? null;
  const rows = await database
    .select({
      scope: ontologyEntities.scope,
      industry: ontologyEntities.industry,
      department: ontologyEntities.department,
    })
    .from(ontologyEntities)
    .where(
      tenantId
        ? or(isNull(ontologyEntities.tenant_id), eq(ontologyEntities.tenant_id, tenantId))
        : isNull(ontologyEntities.tenant_id),
    );

  const industries = new Set<string>();
  const departments = new Set<string>();
  const specCells = new Set<string>();
  for (const r of rows) {
    if (r.industry && (r.scope === 'industry' || r.scope === 'industry_dept')) {
      industries.add(r.industry);
    }
    if (r.department && (r.scope === 'generic' || r.scope === 'industry_dept')) {
      departments.add(r.department);
    }
    if (r.scope === 'industry_dept' && r.industry && r.department) {
      specCells.add(`${r.industry}::${r.department}`);
    }
  }

  const industryList = [...industries].sort();
  const departmentList = [...departments].sort();
  const cells: MatrixCell[] = [];
  for (const industry of industryList) {
    for (const department of departmentList) {
      cells.push({
        industry,
        department,
        hasSpecialization: specCells.has(`${industry}::${department}`),
      });
    }
  }
  return { industries: industryList, departments: departmentList, cells };
}

// ---- (industry × department) cell selection (Phase 3.4, SPEC §B4) ----

/**
 * Canonical challenge work_area → ontology department map. The work_area values are the
 * fixed set in routes/challenges.ts (`WORK_AREAS`); the departments are the seeded
 * generic/industry_dept cells (Claims, Sales, Service, Legal, Marketing, Ops, …).
 * Mostly identity; aliases where a work_area has no dedicated department cell:
 *   - IT   → Ops  (IT work reasons over the Ops department ontology)
 *   - Risk → null (no Risk department cell yet → the agent gets the industry overlay only)
 * An unknown work_area falls through as itself (forward-compatible: a new challenge
 * work_area resolves to a same-named department, an empty cell at worst).
 */
export const WORK_AREA_TO_DEPARTMENT: Record<string, string | null> = {
  Claims: 'Claims',
  Sales: 'Sales',
  Service: 'Service',
  Legal: 'Legal',
  Marketing: 'Marketing',
  Ops: 'Ops',
  IT: 'Ops',
  Risk: null,
};

/**
 * Resolve a (industry, department) cell from a tenant industry + a challenge work_area.
 * `department` is null when the work_area maps to no department cell (e.g. Risk) — the
 * caller then compiles the industry overlay alone. Pure (no DB); the lookups live in
 * cell-context.ts.
 */
export function resolveCell(
  industry: string | null,
  workArea: string | null,
): { industry: string | null; department: string | null } {
  let department: string | null = null;
  if (workArea) {
    department = workArea in WORK_AREA_TO_DEPARTMENT ? (WORK_AREA_TO_DEPARTMENT[workArea] ?? null) : workArea;
  }
  return { industry, department };
}

/** List raw entity rows for a scope (used by the seeder's idempotency checks/tests). */
export async function listEntities(
  scope: OntologyEntity['scope'],
  industry: string | null,
  department: string | null,
  database: Db = defaultDb,
): Promise<OntologyEntity[]> {
  const filters = [eq(ontologyEntities.scope, scope), isNull(ontologyEntities.tenant_id)];
  filters.push(industry === null ? isNull(ontologyEntities.industry) : eq(ontologyEntities.industry, industry));
  filters.push(department === null ? isNull(ontologyEntities.department) : eq(ontologyEntities.department, department));
  return database.select().from(ontologyEntities).where(and(...filters));
}

// ---- Per-tenant overrides / extensions (Phase 3.5, SPEC §B2/§8) ----
// Writes are gated to tenant_admin || platform in the route. A tenant's view of an
// entity is one tenant-scoped row that compileEffective overlays on the global ontology
// (override = same scope/industry/department/name; extension = a new name). Editing only
// ever touches tenant-owned rows — global rows are immutable from here.

export type Scope = OntologyEntity['scope'];

export interface AttributeInput {
  name: string;
  type: string;
  synonyms?: string[];
  pii?: boolean;
  description?: string | null;
}

export interface EntityInput {
  scope: Scope;
  industry?: string | null;
  department?: string | null;
  name: string;
  label: string;
  synonyms?: string[];
  description?: string | null;
  attributes?: AttributeInput[];
}

export interface RelationInput {
  fromEntityId: string;
  toEntityId: string;
  predicate: string;
  label?: string;
  cardinality?: string;
}

/** Enforce the scope ⇄ (industry, department) invariant the global seed also follows. */
function normalizeScopeFields(scope: Scope, industry?: string | null, department?: string | null): {
  industry: string | null;
  department: string | null;
} {
  const ind = industry?.trim() || null;
  const dep = department?.trim() || null;
  // `reason: 'entity_scope'` — routes/ontology.ts throws these same two codes for a MISSING QUERY
  // PARAM, a different sentence entirely. One code, two refusals: the discriminator is what lets the
  // browser catalog pick the right localized sentence instead of echoing whichever English one it got.
  if (scope === 'generic') {
    if (!dep) {
      throw badRequest('department_required', 'generic-scope entities need a department', {
        reason: 'entity_scope',
      });
    }
    return { industry: null, department: dep };
  }
  if (scope === 'industry') {
    if (!ind) {
      throw badRequest('industry_required', 'industry-scope entities need an industry', {
        reason: 'entity_scope',
      });
    }
    return { industry: ind, department: null };
  }
  if (!ind || !dep) throw badRequest('cell_required', 'industry_dept entities need both industry and department');
  return { industry: ind, department: dep };
}

/** `ontology_attributes_entity_name_uq (entity_id, name)` — a caller-supplied list with a repeated
 *  name is a CLIENT mistake, and letting the multi-row insert raise 23505 surfaced it as a 500. */
function assertDistinctAttributeNames(attributes: AttributeInput[]): void {
  const seen = new Set<string>();
  for (const a of attributes) {
    if (seen.has(a.name)) {
      // `attribute` carries the interpolated value as a named field: the sentence is rebuildable in
      // any language from it, whereas re-parsing the name out of the English prose is not.
      throw badRequest('duplicate_attribute', `Attribute '${a.name}' is listed more than once`, {
        attribute: a.name,
      });
    }
    seen.add(a.name);
  }
}

async function insertAttributes(
  database: DbOrTx,
  entityId: string,
  attributes: AttributeInput[] | undefined,
): Promise<void> {
  const list = attributes ?? [];
  if (list.length === 0) return;
  await database.insert(ontologyAttributes).values(
    list.map((a) => ({
      entity_id: entityId,
      name: a.name,
      type: a.type,
      synonyms: a.synonyms ?? [],
      pii: a.pii ?? false,
      description: a.description ?? null,
    })),
  );
}

/** Create a tenant entity (override of a global one, or a brand-new extension). */
export async function createTenantEntity(
  tenantId: string,
  input: EntityInput,
  database: Db = defaultDb,
): Promise<OntologyEntity> {
  const { industry, department } = normalizeScopeFields(input.scope, input.industry, input.department);
  const name = input.name.trim();
  if (!name) throw badRequest('name_required', 'entity name is required');
  if (input.attributes) assertDistinctAttributeNames(input.attributes);

  const [dupe] = await database
    .select({ id: ontologyEntities.id })
    .from(ontologyEntities)
    .where(
      and(
        eq(ontologyEntities.scope, input.scope),
        industry === null ? isNull(ontologyEntities.industry) : eq(ontologyEntities.industry, industry),
        department === null ? isNull(ontologyEntities.department) : eq(ontologyEntities.department, department),
        eq(ontologyEntities.name, name),
        eq(ontologyEntities.tenant_id, tenantId),
      ),
    );
  if (dupe) {
    // `name` is the trimmed name actually collided on — the localized sentence interpolates it.
    throw conflict('entity_exists', `A custom entity '${name}' already exists in this cell`, { name });
  }

  const [row] = await database
    .insert(ontologyEntities)
    .values({
      scope: input.scope,
      industry,
      department,
      name,
      label: input.label.trim() || name,
      synonyms: input.synonyms ?? [],
      description: input.description ?? null,
      tenant_id: tenantId,
    })
    .returning();
  await insertAttributes(database, row!.id, input.attributes);
  invalidateOntologyCache();
  return row!;
}

/** Load a tenant-owned entity by id (404 if global or another tenant's). */
async function loadTenantEntity(tenantId: string, id: string, database: Db): Promise<OntologyEntity> {
  const [row] = await database.select().from(ontologyEntities).where(eq(ontologyEntities.id, id));
  if (!row || row.tenant_id !== tenantId) {
    throw notFound('entity_not_found', 'No editable (tenant-owned) ontology entity with that id');
  }
  return row;
}

/** Update a tenant-owned entity's label/description/synonyms; replace its attributes when
 *  `attributes` is provided. Scope/industry/department/name are immutable (they are the
 *  identity that binds an override to its global entity). */
export async function updateTenantEntity(
  tenantId: string,
  id: string,
  patch: { label?: string; description?: string | null; synonyms?: string[]; attributes?: AttributeInput[] },
  database: Db = defaultDb,
): Promise<OntologyEntity> {
  const existing = await loadTenantEntity(tenantId, id, database);
  // Rejected BEFORE the transaction opens: a repeated name breaks the (entity_id, name) unique
  // constraint, and the replace is delete-then-insert — an unvalidated list used to commit the
  // DELETE and then fail the INSERT, leaving the entity with no attributes at all.
  if (patch.attributes) assertDistinctAttributeNames(patch.attributes);
  // One transaction: the row update and the attribute replace either both land or neither does.
  const row = await database.transaction(async (tx) => {
    const [updated] = await tx
      .update(ontologyEntities)
      .set({
        label: patch.label?.trim() || existing.label,
        description: patch.description === undefined ? existing.description : patch.description,
        synonyms: patch.synonyms ?? existing.synonyms,
        updated_at: new Date(),
      })
      .where(eq(ontologyEntities.id, id))
      .returning();
    if (patch.attributes !== undefined) {
      await tx.delete(ontologyAttributes).where(eq(ontologyAttributes.entity_id, id));
      await insertAttributes(tx, id, patch.attributes);
    }
    return updated!;
  });
  invalidateOntologyCache();
  return row;
}

/** Delete a tenant-owned entity (cascades its attributes + any edges referencing it). */
export async function deleteTenantEntity(
  tenantId: string,
  id: string,
  database: Db = defaultDb,
): Promise<void> {
  await loadTenantEntity(tenantId, id, database);
  await database.delete(ontologyEntities).where(eq(ontologyEntities.id, id));
  invalidateOntologyCache();
}

/** Both endpoints must resolve and be global-or-this-tenant (no cross-tenant edges). */
async function assertEndpoint(tenantId: string, id: string, database: Db): Promise<void> {
  const [row] = await database
    .select({ tenant_id: ontologyEntities.tenant_id })
    .from(ontologyEntities)
    .where(eq(ontologyEntities.id, id));
  if (!row || (row.tenant_id !== null && row.tenant_id !== tenantId)) {
    throw badRequest('bad_endpoint', 'Relation endpoints must be global or this tenant’s entities');
  }
}

/** Create a tenant relation (edge) between two global-or-tenant entities. */
export async function createTenantRelation(
  tenantId: string,
  input: RelationInput,
  database: Db = defaultDb,
): Promise<OntologyRelation> {
  const predicate = input.predicate.trim();
  if (!predicate) throw badRequest('predicate_required', 'relation predicate is required');
  if (input.fromEntityId === input.toEntityId) {
    throw badRequest('self_edge', 'a relation needs two distinct entities');
  }
  await assertEndpoint(tenantId, input.fromEntityId, database);
  await assertEndpoint(tenantId, input.toEntityId, database);

  const [dupe] = await database
    .select({ id: ontologyRelations.id })
    .from(ontologyRelations)
    .where(
      and(
        eq(ontologyRelations.from_entity, input.fromEntityId),
        eq(ontologyRelations.to_entity, input.toEntityId),
        eq(ontologyRelations.predicate, predicate),
        eq(ontologyRelations.tenant_id, tenantId),
      ),
    );
  if (dupe) throw conflict('relation_exists', 'That relation already exists for this tenant');

  const [row] = await database
    .insert(ontologyRelations)
    .values({
      from_entity: input.fromEntityId,
      to_entity: input.toEntityId,
      predicate,
      label: input.label?.trim() ?? '',
      cardinality: input.cardinality?.trim() ?? '',
      tenant_id: tenantId,
    })
    .returning();
  invalidateOntologyCache();
  return row!;
}

/** Delete a tenant-owned relation (404 if global or another tenant's). */
export async function deleteTenantRelation(
  tenantId: string,
  id: string,
  database: Db = defaultDb,
): Promise<void> {
  const [row] = await database.select().from(ontologyRelations).where(eq(ontologyRelations.id, id));
  if (!row || row.tenant_id !== tenantId) {
    throw notFound('relation_not_found', 'No editable (tenant-owned) relation with that id');
  }
  await database.delete(ontologyRelations).where(eq(ontologyRelations.id, id));
  invalidateOntologyCache();
}

// ---- Tombstoning a global entity for a tenant (Phase 3.7) ----
// A tombstone is a tenant override row carrying hidden=true; compileEffective drops the
// hidden-winning entity (and its relations) for that tenant only. Only GLOBAL entities can
// be hidden — a tenant's own extension is simply deleted.

/** Load a GLOBAL entity by id (404 if missing; 400 if it is a tenant row). */
async function loadGlobalEntity(id: string, database: Db): Promise<OntologyEntity> {
  const [row] = await database.select().from(ontologyEntities).where(eq(ontologyEntities.id, id));
  if (!row) throw notFound('entity_not_found', 'No ontology entity with that id');
  if (row.tenant_id !== null) {
    throw badRequest('not_global', 'Only a global entity can be hidden; a custom entity is deleted');
  }
  return row;
}

/** The predicate identifying this tenant's own row (override or tombstone) for the same natural
 *  key as global entity `g`.
 *
 *  ⛔ ONE definition, shared by the WRITE side (findTenantRow → hide/unhide) and the READ side
 *  (compileEffective's expansion tombstone fetch). They were separate, and the read side simply had
 *  no equivalent for expansion-reached entities: hide wrote a row on a key the viewed cell never
 *  looked up, so the entity stayed rendered behind a 200. Keep them one expression. */
function tenantRowForGlobal(
  tenantId: string,
  g: Pick<OntologyEntity, 'scope' | 'industry' | 'department' | 'name'>,
) {
  return and(
    eq(ontologyEntities.scope, g.scope),
    g.industry === null ? isNull(ontologyEntities.industry) : eq(ontologyEntities.industry, g.industry),
    g.department === null ? isNull(ontologyEntities.department) : eq(ontologyEntities.department, g.department),
    eq(ontologyEntities.name, g.name),
    eq(ontologyEntities.tenant_id, tenantId),
  );
}

/** This tenant's own row (override or tombstone) for the same natural key as `g`, if any. */
async function findTenantRow(
  tenantId: string,
  g: OntologyEntity,
  database: Db,
): Promise<OntologyEntity | undefined> {
  const [row] = await database
    .select()
    .from(ontologyEntities)
    .where(tenantRowForGlobal(tenantId, g));
  return row;
}

/** Hide a global entity for this tenant (idempotent). Reuses an existing override row or
 *  inserts a minimal tombstone copying the global's natural key + label. */
export async function hideGlobalEntity(
  tenantId: string,
  globalEntityId: string,
  database: Db = defaultDb,
): Promise<void> {
  const g = await loadGlobalEntity(globalEntityId, database);
  const existing = await findTenantRow(tenantId, g, database);
  if (existing) {
    await database
      .update(ontologyEntities)
      .set({ hidden: true, updated_at: new Date() })
      .where(eq(ontologyEntities.id, existing.id));
  } else {
    await database.insert(ontologyEntities).values({
      scope: g.scope,
      industry: g.industry,
      department: g.department,
      name: g.name,
      label: g.label,
      tenant_id: tenantId,
      hidden: true,
    });
  }
  invalidateOntologyCache();
}

/** Unhide a global entity (idempotent). A pure tombstone (no attributes, untouched label /
 *  description / synonyms) is removed; an override that also carried hidden just clears it. */
export async function unhideGlobalEntity(
  tenantId: string,
  globalEntityId: string,
  database: Db = defaultDb,
): Promise<void> {
  const g = await loadGlobalEntity(globalEntityId, database);
  const row = await findTenantRow(tenantId, g, database);
  if (!row || !row.hidden) return;
  const attrs = await database
    .select({ id: ontologyAttributes.id })
    .from(ontologyAttributes)
    .where(eq(ontologyAttributes.entity_id, row.id));
  const pureTombstone =
    attrs.length === 0 &&
    row.label === g.label &&
    row.description === null &&
    (row.synonyms ?? []).length === 0;
  if (pureTombstone) {
    await database.delete(ontologyEntities).where(eq(ontologyEntities.id, row.id));
  } else {
    await database
      .update(ontologyEntities)
      .set({ hidden: false, updated_at: new Date() })
      .where(eq(ontologyEntities.id, row.id));
  }
  invalidateOntologyCache();
}

// ---- Tenant-entity label/description i18n (Phase 3.7) ----
// Tenant translations are stored under a tenant-scoped content_translations id so an override
// of a global entity (same natural key) stays isolated from other orgs. compileEffective's
// pass-2 overlay reads them back for tenant-owned entities.

export type EntityTranslations = Record<string, { label?: string; description?: string }>;

/** All authored translations for a tenant-owned entity, grouped by locale (editor read). */
export async function getEntityTranslations(
  tenantId: string,
  id: string,
  database: Db = defaultDb,
): Promise<EntityTranslations> {
  const row = await loadTenantEntity(tenantId, id, database);
  const cells = await listTranslations(
    ONTOLOGY_ENTITY_TENANT_I18N,
    tenantEntityI18nId(tenantId, entityKey(row)),
    database,
  );
  const out: EntityTranslations = {};
  for (const c of cells) {
    if (c.field !== 'label' && c.field !== 'description') continue;
    (out[c.locale] ??= {})[c.field] = c.value;
  }
  return out;
}

/** Upsert (or clear) a tenant-owned entity's label/description for one non-en locale. A
 *  blank value clears that field (the en base column then shows). */
export async function setEntityTranslations(
  tenantId: string,
  id: string,
  locale: string,
  fields: { label?: string | null; description?: string | null },
  database: Db = defaultDb,
): Promise<void> {
  if (!isSupportedLocale(locale) || locale === DEFAULT_LOCALE) {
    throw badRequest('bad_locale', 'Translations target a supported non-en locale');
  }
  const row = await loadTenantEntity(tenantId, id, database);
  const entityId = tenantEntityI18nId(tenantId, entityKey(row));
  for (const field of ['label', 'description'] as const) {
    if (!(field in fields)) continue;
    const value = fields[field];
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) {
      await upsertTranslation(ONTOLOGY_ENTITY_TENANT_I18N, entityId, locale, field, trimmed, database);
    } else {
      await deleteTranslation(ONTOLOGY_ENTITY_TENANT_I18N, entityId, locale, field, database);
    }
  }
  invalidateOntologyCache();
}
