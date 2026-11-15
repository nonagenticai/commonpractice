// src/lib/types/ontology.ts — Phase 3.2 Pillar B. Mirrors the compiled-graph shape
// the backend serves (backend/src/ontology/ontology-service.ts). The Ontology screen
// consumes only this compiled view; the three-layer matrix merge stays server-side.

import type { AuditItem } from './audit';

export type OntologyScope = 'generic' | 'industry' | 'industry_dept';

export interface OntologyAttribute {
	name: string;
	type: string;
	synonyms: string[];
	pii: boolean;
	description: string | null;
}

export interface OntologyEntity {
	/** Canonical ontology_entities.id (highest-layer row) — the 3.3 mapping FK target. For
	 *  a tenant override this is the editable TENANT row id. */
	id: string;
	/** Reseed-stable natural key "scope:industry:department:name" (i18n + override identity). */
	key: string;
	name: string;
	label: string;
	synonyms: string[];
	description: string | null;
	/** The highest layer that contributed this entity in the merge. */
	scope: OntologyScope;
	/** True when the winning row is a per-tenant override/extension (3.5) — editable. */
	tenantOwned: boolean;
	attributes: OntologyAttribute[];
}

export interface OntologyRelation {
	/** Edge row id of the winning (tenant > global) row — tenant edges deletable by this. */
	id: string;
	from: string;
	to: string;
	predicate: string;
	label: string;
	cardinality: string;
	/** True when this edge is a per-tenant override/extension (3.5). */
	tenantOwned: boolean;
}

/** A global entity this tenant has tombstoned (3.7): excluded from the graph, listed here
 *  (carrying the GLOBAL id) so an admin can unhide it. */
export interface CompiledHidden {
	id: string;
	key: string;
	name: string;
	label: string;
}

export interface CompiledOntology {
	industry: string;
	department: string;
	entities: OntologyEntity[];
	relations: OntologyRelation[];
	/** Global entities this org has hidden (3.7). */
	hidden: CompiledHidden[];
	/** Set by the API: the locale the labels were resolved in + whether the caller may edit. */
	locale?: string;
	canManage?: boolean;
}

/** A tenant-owned entity's authored translations, grouped by locale (3.7). */
export type EntityTranslations = Record<string, { label?: string; description?: string }>;

export interface MatrixCell {
	industry: string;
	department: string;
	/** True when an industry × department specialization cell exists. */
	hasSpecialization: boolean;
}

export interface MatrixData {
	industries: string[];
	departments: string[];
	cells: MatrixCell[];
	/** Whether the caller may author the ontology (tenant_admin / platform). */
	canManage?: boolean;
}

/** Payload for creating/overriding a tenant entity (3.5). */
export interface EntityInput {
	scope: OntologyScope;
	industry?: string | null;
	department?: string | null;
	name: string;
	label: string;
	synonyms?: string[];
	description?: string | null;
	attributes?: OntologyAttribute[];
}

/** Payload for editing a tenant-owned entity (3.5). */
export interface EntityPatch {
	label?: string;
	description?: string | null;
	synonyms?: string[];
	attributes?: OntologyAttribute[];
}

/** Payload for creating a tenant relation (3.5). */
export interface RelationInput {
	fromEntityId: string;
	toEntityId: string;
	predicate: string;
	label?: string;
	cardinality?: string;
}

/** A dataset bound to an ontology entity as its test data (ontology-data-blocks Phase 1). */
export interface EntitySample {
	id: string;
	datasetId: string;
	datasetSlug: string;
	datasetName: string;
	rowCount: number;
	mappingId: string | null;
	isPrimary: boolean;
}

/**
 * The /ontology "Recent changes" panel — `ontology.*` audit rows attributed to ONE workspace.
 *
 * ⛔ WHY THIS IS NOT `AuditFeed`. The panel used to read `GET /api/audit`, the PLATFORM feed, which
 * has no tenant predicate and cannot have one (`audit_log` has no `tenant_id` column and sits
 * outside RLS by design). A super_admin therefore read every OTHER tenant's ontology history under
 * a graph that IS tenant-scoped. `GET /api/ontology/recent-changes` resolves each row's owning
 * workspace server-side; see `backend/src/ontology/ontology-changes.ts` for the rules.
 */
export interface OntologyChangeFeed {
	items: AuditItem[];
	/**
	 * Rows in the same window that are `ontology.*` but belong to NO resolvable workspace — a
	 * delete whose target is gone, a hide whose target is a global entity, anything written before
	 * the audit rows carried their tenant. They MIGHT be this workspace's, so they are never
	 * rendered as its own and never dropped in silence: the panel states the count.
	 */
	unattributed: number;
}
