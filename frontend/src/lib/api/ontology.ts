// src/lib/api/ontology.ts — typed client for the Ontology API (Phase 3.2 read; 3.5
// per-tenant authoring). The matrix selector + compiled effective graph (tenant-overlaid,
// localized), plus tenant_admin-gated create/edit/delete of custom entities + relations.
// Mirrors the datasets client (authFetch + unwrap + ApiError).
import { authFetch } from './auth-fetch';
import { parseBody, nonJsonErrorMessage, detailsFrom } from './parse';
import { ApiError } from './blocks';
import type {
	CompiledOntology,
	MatrixData,
	EntityInput,
	EntityPatch,
	EntityTranslations,
	RelationInput,
	EntitySample,
	OntologyChangeFeed
} from '$lib/types/ontology';

export { ApiError };

async function unwrap<T>(res: Response): Promise<T> {
	const text = await res.text();
	const body = parseBody(text);
	if (!res.ok) {
		// `detailsFrom` forwards the offender's name to the localized catalog — see the ⛔ block on
		// `ApiError` (./blocks). Every sibling `unwrap` in this directory carries the same line.
		throw new ApiError(
			res.status,
			body?.error ?? 'error',
			body?.message ?? body?.error ?? nonJsonErrorMessage(res, text),
			detailsFrom(body)
		);
	}
	return body as T;
}

export const ontologyApi = {
	/** The available (industry × department) cells for the matrix selector. */
	async matrix(): Promise<MatrixData> {
		return unwrap(await authFetch('/api/ontology/matrix'));
	},

	/** The compiled effective graph for one (industry, department) cell, localized to
	 *  `locale` (defaults to the negotiated request locale server-side). */
	async get(industry: string, department: string, locale?: string): Promise<CompiledOntology> {
		const qs = new URLSearchParams({ industry, department });
		if (locale) qs.set('locale', locale);
		return unwrap(await authFetch(`/api/ontology?${qs.toString()}`));
	},

	/** Create a tenant entity (a new extension, or an override of a global one). */
	async createEntity(input: EntityInput): Promise<{ id: string }> {
		return unwrap(
			await authFetch('/api/ontology/entities', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input)
			})
		);
	},

	/** Edit a tenant-owned entity. */
	async updateEntity(id: string, patch: EntityPatch): Promise<{ id: string }> {
		return unwrap(
			await authFetch(`/api/ontology/entities/${id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(patch)
			})
		);
	},

	/** Delete a tenant-owned entity (cascades its attributes + edges). */
	async deleteEntity(id: string): Promise<void> {
		await unwrap(await authFetch(`/api/ontology/entities/${id}`, { method: 'DELETE' }));
	},

	/** Create a tenant relation between two global-or-tenant entities. */
	async createRelation(input: RelationInput): Promise<{ id: string }> {
		return unwrap(
			await authFetch('/api/ontology/relations', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input)
			})
		);
	},

	/** Delete a tenant-owned relation. */
	async deleteRelation(id: string): Promise<void> {
		await unwrap(await authFetch(`/api/ontology/relations/${id}`, { method: 'DELETE' }));
	},

	/** Hide a GLOBAL entity for this org (3.7). `id` is the global entity id. */
	async hideEntity(id: string): Promise<void> {
		await unwrap(await authFetch(`/api/ontology/entities/${id}/hide`, { method: 'POST' }));
	},

	/** Unhide a previously hidden global entity (3.7). */
	async unhideEntity(id: string): Promise<void> {
		await unwrap(await authFetch(`/api/ontology/entities/${id}/unhide`, { method: 'POST' }));
	},

	/** Authored translations for a tenant-owned entity, grouped by locale (3.7). */
	async getTranslations(id: string): Promise<EntityTranslations> {
		const body = await unwrap<{ translations: EntityTranslations }>(
			await authFetch(`/api/ontology/entities/${id}/translations`)
		);
		return body.translations;
	},

	/** Upsert a tenant-owned entity's label/description for one non-en locale (3.7). */
	async setTranslations(
		id: string,
		locale: string,
		fields: { label?: string; description?: string }
	): Promise<void> {
		await unwrap(
			await authFetch(`/api/ontology/entities/${id}/translations`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ locale, ...fields })
			})
		);
	},

	// ---- entity test-data bindings (ontology-data-blocks Phase 1) ----

	/** The datasets bound as test data for an entity (resolved across natural-key siblings). */
	async listSamples(entityId: string): Promise<EntitySample[]> {
		const body = await unwrap<{ samples: EntitySample[] }>(
			await authFetch(`/api/ontology/entities/${entityId}/samples`)
		);
		return body.samples;
	},

	/** Bind a tenant dataset as test data for an entity (idempotent). */
	async bindSample(
		entityId: string,
		input: { datasetId: string; mappingId?: string | null; isPrimary?: boolean }
	): Promise<EntitySample> {
		const body = await unwrap<{ sample: EntitySample }>(
			await authFetch(`/api/ontology/entities/${entityId}/samples`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input)
			})
		);
		return body.sample;
	},

	/** Remove a test-data binding by its id. */
	async unbindSample(sampleId: string): Promise<void> {
		await unwrap(await authFetch(`/api/ontology/samples/${sampleId}`, { method: 'DELETE' }));
	},

	/**
	 * Recent `ontology.*` edits IN THIS WORKSPACE, plus the count of rows in the same window that
	 * no workspace can claim.
	 *
	 * ⛔ THIS REPLACES `auditApi.list({ category: 'data', q: 'ontology', range: '30d' })`. That is
	 * the PLATFORM audit feed — no tenant predicate, and none is possible (`audit_log` has no
	 * `tenant_id` and sits outside RLS by design) — so the panel showed a super_admin every OTHER
	 * tenant's ontology history beside a tenant-scoped graph. Do not route this back through
	 * `auditApi`.
	 *
	 * ⚠️ STILL SUPER-ADMIN-GATED, and that is load-bearing: the rows come from the platform audit
	 * log. A 401/403 is the EXPECTED answer for the ordinary members /ontology is open to, and the
	 * caller must keep treating it as silence rather than as a failure.
	 */
	async recentChanges(): Promise<OntologyChangeFeed> {
		return unwrap(await authFetch('/api/ontology/recent-changes'));
	},

	/** Derive (or re-derive) a tenant data block from an entity + its primary sample (Phase 3). */
	async deriveBlock(
		entityId: string
	): Promise<{ block: { slug: string; name: string }; version: { version: string }; created: boolean }> {
		return unwrap(
			await authFetch(`/api/ontology/entities/${entityId}/derive-block`, { method: 'POST' })
		);
	}
};
