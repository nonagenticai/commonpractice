// src/routes/translations/labels.ts — what the /translations job table CALLS a job's status and the
// kind of content it translates.
//
// The table rendered `{j.status}` and `{j.entity_type}` RAW — a Dutch operator read `pending` and
// `challenge` in an otherwise fully translated screen, while `tr_filter_pending/done/failed` were
// already sitting seventeen lines above it on the filter chips. Same defect class as the build
// topbar in this PR: the UI showing a raw internal value.
//
// Returns KEY NAMES, not strings (the `lib/admin/license-chip.ts` convention): this file stays pure
// and paraglide-free so it is unit-testable, and the page owns the key → message mapping.
//
// ⚠️ UNKNOWN VALUES MUST RENDER RAW. `translation_jobs.entity_type` is a bare `text()` column with
// no enum and no CHECK constraint (backend/src/db/schema.ts:1400), and `status` is `text()` too. A
// value this frontend does not know about must show as ITSELF — an unlabelled row is still readable,
// an empty cell is a lie. Both mappers return `''` for it and the page falls back to the raw string.

/** Message keys for `translation_jobs.status`. `''` = no key, render the raw value. */
export type StatusLabelKey =
	| 'tr_filter_pending'
	| 'tr_filter_done'
	| 'tr_filter_failed'
	| 'tr_status_skipped'
	| '';

/** Message keys for `translation_jobs.entity_type`. `''` = no key, render the raw value. */
export type EntityLabelKey = 'tr_entity_challenge' | 'tr_entity_solution' | 'tr_entity_block' | '';

/**
 * The four statuses `TranslationStatus` declares (`$lib/types/translation.ts`, mirroring
 * `backend/src/host/translation-service.ts`).
 *
 * `pending`/`done`/`failed` deliberately reuse the EXISTING `tr_filter_*` keys the filter chips
 * already render — the pill and the chip that selects it must never disagree. `skipped` has no chip
 * (nothing writes that status today, and a filter for an unreachable state is a new dead control,
 * which is the defect class this whole change is about) but it IS in the type and has a colour hook.
 */
export function statusLabelKey(status: string): StatusLabelKey {
	switch (status) {
		case 'pending':
			return 'tr_filter_pending';
		case 'done':
			return 'tr_filter_done';
		case 'failed':
			return 'tr_filter_failed';
		case 'skipped':
			return 'tr_status_skipped';
		default:
			return '';
	}
}

/** The three entity kinds `POST /api/admin/translations/queue` accepts (`QueueRequest.entityType`). */
export function entityLabelKey(entityType: string): EntityLabelKey {
	switch (entityType) {
		case 'challenge':
			return 'tr_entity_challenge';
		case 'solution':
			return 'tr_entity_solution';
		case 'block':
			return 'tr_entity_block';
		default:
			return '';
	}
}
