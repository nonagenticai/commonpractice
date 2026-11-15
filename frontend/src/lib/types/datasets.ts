// src/lib/types/datasets.ts — 1:1 with backend/src/db/dataset-types.ts + the
// /api/datasets response shapes. Keep in sync with the backend.
export type DatasetColumnType = 'string' | 'number' | 'boolean' | 'date' | 'json';

export interface DatasetColumn {
	name: string;
	type: DatasetColumnType;
	pii?: boolean;
	/** A data manager's explicit "not personal" mark: members see the real values. */
	nonPersonal?: boolean;
	sample?: unknown;
}

export type DatasetSourceType = 'csv' | 'xlsx' | 'sql' | 'text' | 'json';

export interface DatasetRow {
	id: string;
	slug: string;
	name: string;
	sourceType: DatasetSourceType;
	columns: DatasetColumn[];
	rowCount: number;
	sizeBytes: number;
	status: string;
	sandboxId: string | null;
	createdAt: string;
	updatedAt: string;
	/**
	 * Columns whose values this reader may not see (W8/P7: a reader who is not a data manager).
	 * Their cells arrive blanked and render as "•••". OPTIONAL: an older backend mid-roll does not
	 * send it, and then nothing is marked (it also masked nothing).
	 */
	maskedColumns?: string[];
}

export interface DatasetList {
	items: DatasetRow[];
	total: number;
	page: number;
	pageSize: number;
	/** Phase 3.6: may the caller add/edit/delete the org's test data (tenant_admin/IT or
	 *  platform)? Reads stay open to every member; the server enforces this too. */
	canManage: boolean;
}

/** One column the ingest had to rename to keep names unique within the dataset. 1:1 with
 *  backend/src/db/dataset-types.ts's `ColumnRename`. */
export interface ColumnRename {
	from: string;
	to: string;
}

export interface DatasetCreated extends DatasetRow {
	preview: Record<string, unknown>[];
	truncated: number;
	/** ⚠️ OPTIONAL ON PURPOSE. The browser reaches the API through the k8s Service, which
	 *  load-balances across old and new pods for the length of a rolling deploy, so a NEW frontend
	 *  really is answered by an OLD backend that has never heard of this field. Every read must go
	 *  through a `?? []` — an `undefined.length` here would throw inside the upload handler and
	 *  leave the drawer stuck on "Creating…". */
	renamedColumns?: ColumnRename[];
}

export interface DatasetDetail extends DatasetRow {
	rows: Record<string, unknown>[];
	/**
	 * Data managers only: columns SUGGESTED as not personal (backend/src/datasets/column-suggestions.ts).
	 * A hint: members still see placeholders until a column is marked `nonPersonal`.
	 * OPTIONAL: absent for a member and from an older backend.
	 */
	suggestedNonPersonal?: string[];
	offset: number;
	limit: number;
}

export const DATASET_COLUMN_TYPES: DatasetColumnType[] = [
	'string',
	'number',
	'boolean',
	'date',
	'json'
];

// ---- Phase 3.3: dataset → ontology mapping (the Pillar A ↔ B bridge) ----

export interface SuggestedColumn {
	column: string;
	attribute: string;
	confidence: number;
	origin: 'heuristic' | 'llm';
}

/** A proposed (dataset, entity) mapping returned by …/mappings/suggest (not persisted). */
export interface MappingSuggestion {
	entityId: string;
	entityName: string;
	entityLabel: string;
	industry: string;
	department: string;
	columnMap: Record<string, string>;
	confidence: number;
	columns: SuggestedColumn[];
}

export interface SuggestMappingsResponse {
	suggestions: MappingSuggestion[];
	threshold: number;
}

/** A persisted (dataset, entity) mapping from GET/PUT …/mappings. */
export interface DatasetMapping {
	id: string;
	entityId: string;
	entityName: string;
	entityLabel: string;
	industry: string;
	department: string;
	columnMap: Record<string, string>;
	confidence: number;
	source: 'auto' | 'human';
	confirmed: boolean;
	updatedAt: string;
}

/** One confirmed mapping sent to PUT …/mappings. */
export interface SaveMappingInput {
	entityId: string;
	industry: string;
	department: string;
	columnMap: Record<string, string>;
	confidence?: number;
}
