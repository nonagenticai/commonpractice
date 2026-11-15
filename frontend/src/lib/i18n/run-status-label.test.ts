// src/lib/i18n/run-status-label.test.ts — a flow-run status resolves from the ENUM, for all four
// values the backend can send.
//
// THE DEFECT this pins: the /sandboxes run-history drawer rendered `{r.status}` — the raw
// `flow_run_status` enum — inside a drawer whose every other field was already localized.
//
// Messages are mocked so each key returns its own name: the assertions are about WHICH MESSAGE is
// selected, not about English copy a translator may reword. Same technique as stage-label.test.ts.
import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/paraglide/messages', () => ({
	run_status_running: () => 'M_RUNNING',
	run_status_ok: () => 'M_OK',
	run_status_partial: () => 'M_PARTIAL',
	run_status_failed: () => 'M_FAILED'
}));

const { runStatusLabel } = await import('./run-status-label');

describe('runStatusLabel', () => {
	it('resolves every value of the flow_run_status pg enum', () => {
		// backend/src/db/schema.ts `flowRunStatusEnum` — running | ok | partial | failed.
		expect(runStatusLabel('running')).toBe('M_RUNNING');
		expect(runStatusLabel('ok')).toBe('M_OK');
		expect(runStatusLabel('partial')).toBe('M_PARTIAL');
		expect(runStatusLabel('failed')).toBe('M_FAILED');
	});

	it('maps no two run statuses onto the same message', () => {
		// The near-miss this guards is folding runs into <DotStatus> (SandboxStatus), which would
		// have needed ok→running / partial→idle / failed→error: a `partial` run and an `idle`
		// sandbox would then have carried the same word and the same amber dot.
		const labels = ['running', 'ok', 'partial', 'failed'].map(runStatusLabel);
		expect(new Set(labels).size).toBe(4);
	});

	it('returns the RAW enum for an unknown status — never an English sentence', () => {
		expect(runStatusLabel('cancelled')).toBe('cancelled');
		expect(runStatusLabel('')).toBe('');
	});
});
