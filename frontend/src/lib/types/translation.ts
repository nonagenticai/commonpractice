// src/lib/types/translation.ts — Phase 2-G translation-management types (mirror the
// backend routes/translations.ts shapes).
export type TranslationStatus = 'pending' | 'done' | 'failed' | 'skipped';

export interface TranslationJob {
	id: string;
	entity_type: string;
	entity_id: string;
	field: string;
	target_locale: string;
	source_text: string;
	status: TranslationStatus;
	attempts: number;
	error: string | null;
	requested_by: string | null;
	created_at: string;
	updated_at: string;
	/**
	 * The translation this cell ALREADY has — `content_translations.value` for
	 * (entity_type, entity_id, target_locale, field), LEFT JOINed by the jobs route.
	 * `null` ⇔ nothing is stored yet; `''` is impossible (the column is NOT NULL and the
	 * override route rejects an empty value), so null is the only "not translated" signal
	 * and the editor must render it differently from a value it can show.
	 */
	current_value: string | null;
	/** When that value was last written; `null` whenever `current_value` is. */
	current_updated_at: string | null;
}

export interface TranslationStats {
	byStatus: Record<string, number>;
	byLocale: Record<string, { pending: number; done: number; failed: number }>;
}

export interface JobsResponse {
	stats: TranslationStats;
	jobs: TranslationJob[];
	/** Hard server-side cap on `jobs.length` — the list is truncated, never paged. */
	jobsLimit: number;
	/**
	 * How many jobs the ACTIVE filter matches, counted server-side with the same predicate as
	 * `jobs`. Pairs with `jobsLimit` to render the truncation honestly; do NOT substitute
	 * `stats.byStatus`, which is unfiltered and would disagree the moment an entityType filter
	 * is used.
	 */
	jobsTotal: number;
}

export interface QueueRequest {
	entityType?: 'challenge' | 'solution' | 'block';
	entityId?: string;
	force?: boolean;
}

export interface BatchResult {
	processed: number;
	failed: number;
	deferred: number;
}
