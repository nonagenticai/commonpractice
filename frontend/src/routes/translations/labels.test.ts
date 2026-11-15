// Unit tests for the /translations job-table labels.
//
// BEHAVIOURAL, not a grep: `labels.ts` is pure, so it is driven directly. The companion
// `translations-page.enum-labels.test.ts` is the (honestly labelled) text guard that the page still
// USES it and still keeps the raw value in the CSS hook.
//
// What they guard: the job table rendered `{j.status}` and `{j.entity_type}` verbatim, so a Dutch
// operator read `pending` and `challenge` on an otherwise fully translated screen — while
// `tr_filter_pending/done/failed` were already on the filter chips seventeen lines above.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { statusLabelKey, entityLabelKey } from './labels';

describe('statusLabelKey', () => {
	it('reuses the keys the filter chips already render', () => {
		// The pill and the chip that selects it must never disagree — a row labelled one thing and
		// filtered by another is worse than an untranslated row.
		expect(statusLabelKey('pending')).toBe('tr_filter_pending');
		expect(statusLabelKey('done')).toBe('tr_filter_done');
		expect(statusLabelKey('failed')).toBe('tr_filter_failed');
	});

	it('labels `skipped`, which has no filter chip', () => {
		expect(statusLabelKey('skipped')).toBe('tr_status_skipped');
	});

	it('returns NO key for a status it does not know, so the page can render it raw', () => {
		// `translation_jobs.status` is a bare `text()` column with no enum and no CHECK. A value this
		// frontend has never heard of must show as ITSELF: an unlabelled row is still readable, an
		// empty cell is a lie about a job that exists.
		for (const unknown of ['deferred', 'PENDING', '', 'queued', 'null']) {
			expect(
				statusLabelKey(unknown),
				`"${unknown}" was mapped to a message key. An unknown status then renders as some other ` +
					'status\'s label, or as an empty cell — either way the operator is told something false.'
			).toBe('');
		}
	});
});

describe('entityLabelKey', () => {
	it('labels the three entity kinds the queue route accepts', () => {
		expect(entityLabelKey('challenge')).toBe('tr_entity_challenge');
		expect(entityLabelKey('solution')).toBe('tr_entity_solution');
		expect(entityLabelKey('block')).toBe('tr_entity_block');
	});

	it('returns NO key for an entity type it does not know', () => {
		// `translation_jobs.entity_type` is `text('entity_type').notNull()` — no enum, no CHECK
		// (backend/src/db/schema.ts). Anything at all can be in there.
		for (const unknown of ['dataset', 'connector', '', 'Challenge']) {
			expect(
				entityLabelKey(unknown),
				`"${unknown}" was mapped to a message key, so a job for a content type this build does ` +
					'not know about is displayed as one it does.'
			).toBe('');
		}
	});
});

describe('every key these mappers return exists in the catalogs', () => {
	// A typo'd key renders as the raw key name on screen — the exact class of defect being fixed.
	const en: Record<string, string> = JSON.parse(
		readFileSync(resolve(process.cwd(), 'messages/en.json'), 'utf8')
	);
	const keys = [
		...['pending', 'done', 'failed', 'skipped'].map(statusLabelKey),
		...['challenge', 'solution', 'block'].map(entityLabelKey)
	];

	it('maps seven values to seven distinct, existing keys', () => {
		expect(keys.filter(Boolean)).toHaveLength(7);
		expect(new Set(keys).size).toBe(7);
		for (const k of keys) {
			expect(en[k], `messages/en.json has no key "${k}"`).toBeTruthy();
		}
	});
});
