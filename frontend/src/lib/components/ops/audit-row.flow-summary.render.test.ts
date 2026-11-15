// @vitest-environment jsdom
//
// src/lib/components/ops/audit-row.flow-summary.render.test.ts — /audit and /build say the SAME
// WORDS about the SAME EVENT.
//
// ⛔ THE DEFECT, IN ONE SENTENCE. A Dutch reader saved a checkpoint on /build and saw "Handmatig
// checkpoint" in the flow-history drawer. They opened /audit — the compliance surface, the one
// screen whose whole job is to be the record of what happened — and the same event, written by the
// same handler in the same transaction, read "Manual checkpoint". The product contradicted itself
// about a row it had just written, in the reader's own language.
//
// `backend/src/routes/flows.ts` wrote the SNAPSHOT with a `summary_code` and the AUDIT ROW with the
// English prose only, and this component rendered `{item.result}` raw. The fix carries the code the
// snapshot already had onto the audit payload (`resultCode`/`resultParams`, derived from the
// `metadata` jsonb that `recordAudit` already persists) and hands it to `flowSummaryLabel` — the
// SAME function `FlowHistoryPanel.svelte` calls. One vocabulary, one renderer, two surfaces.
//
// ⛔ NOTHING IS MOCKED HERE, AND THAT IS THE POINT. The REAL compiled paraglide catalogs are driven
// through the REAL locale store (`stores/locale.svelte.ts` rebinds paraglide's `getLocale()` onto
// its rune, which is exactly the lever the topbar language switcher pulls). A key-name mock would
// prove which message resolved but could never assert the literal "Handmatig checkpoint" — and the
// literal is the defect: the two screens had to be shown saying the same string.
//
// ⚠️ THE OTHER TWO ENGLISH CELLS ARE STILL DELIBERATELY UNTOUCHED — `item.action` (a raw backend
// enum) and `item.targetId` (a UUID). `item.result` has left that lane only for rows that carry a
// code; every other row still renders it verbatim, which is what the LEGACY GUARD below pins.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { locale } from '$lib/stores/locale.svelte';
import { fullDate } from '$lib/utils/format';
import type { AuditItem } from '$lib/types/audit';
import AuditRow from './AuditRow.svelte';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
const initialLocale = locale.current;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	// Assigned directly, never via `locale.set()`: that PATCHes /api/me/locale.
	locale.current = initialLocale;
});

/** The three cells this file does not touch carry their real backend values. */
const BASE: AuditItem = {
	id: 'a-1',
	action: 'flow.checkpoint',
	category: 'block',
	targetType: 'flow',
	targetId: '3f1c8b2e-1c4a-4d2b-9f0e-6c1b2d3e4a8b',
	result: 'Manual checkpoint',
	resultTone: 'ok',
	createdAt: '2026-08-18T10:00:00.000Z',
	actor: { name: 'Mary de Vries', initials: 'MV' }
};

function render(item: Partial<AuditItem>): HTMLElement {
	const table = document.createElement('table');
	const body = document.createElement('tbody');
	table.appendChild(body);
	host.appendChild(table);
	app = mount(AuditRow, { target: body, props: { item: { ...BASE, ...item } as AuditItem } });
	flushSync();
	return host;
}

/** The result cell only — never the whole row, so `action`/`targetId` cannot satisfy an assertion. */
const resultText = (el: HTMLElement) => el.querySelector('.dot-status')?.textContent ?? '';

describe('an /audit row speaks the same language as the /build history drawer', () => {
	it('⛔ nl + flow_summary_manual_checkpoint → "Handmatig checkpoint", and the English is GONE', () => {
		// REVERT THAT TURNS THIS RED: put `{item.result}` back in AuditRow.svelte, or drop
		// `resultCode` from the /api/audit payload. Either way this row reads "Manual checkpoint"
		// while /build reads "Handmatig checkpoint" — the exact contradiction this file exists for.
		locale.current = 'nl';
		const el = render({ resultCode: 'flow_summary_manual_checkpoint', resultParams: null });
		expect(resultText(el)).toBe('Handmatig checkpoint');
		// The banished string is asserted absent from the WHOLE row, not just the cell — a fix that
		// leaves the English in the `title=` or in a sibling span is not a fix.
		expect(el.textContent).not.toContain('Manual checkpoint');
	});

	it('⛔ nl + flow_summary_restored → the Dutch sentence and a Dutch DATE, not the raw ISO', () => {
		const at = '2026-08-07T09:12:44.031Z';
		locale.current = 'nl';
		const el = render({
			action: 'flow.restore',
			result: `Restored snapshot from ${at}`,
			resultCode: 'flow_summary_restored',
			resultParams: { at }
		});
		const out = resultText(el);
		// "Versie van {at} hersteld" — asserted on the catalog's own frame, so a copy edit to the
		// middle of the sentence does not red this, but a language swap does.
		expect(out).toContain('hersteld');
		expect(out).toContain(fullDate(at, 'nl'));
		expect(el.textContent).not.toContain('Restored snapshot from');
		// ⛔ AND THE RAW INSTANT IS GONE. `fullDate` is the repo's shared dated-fact formatter; an
		// ISO timestamp in the middle of a Dutch sentence is the second half of this defect.
		expect(el.textContent).not.toContain(at);
	});

	it('NON-VACUITY — in `en` the same row still reads the English catalog sentence', () => {
		// Without this, "the Dutch appeared" could be satisfied by a component that renders the
		// Dutch catalog to everyone, which is the same bug pointing the other way.
		locale.current = 'en';
		const el = render({ resultCode: 'flow_summary_manual_checkpoint', resultParams: null });
		expect(resultText(el)).toBe('Manual checkpoint');
	});
});

// -------------------------------------------------------------------------------------------
// ⭐ THE LEGACY GUARD. Every case below is GREEN TODAY and must STAY green.
//
// This is the load-bearing half of the file. `audit_log` is an APPEND-ONLY compliance table with no
// backfill and no retention sweep: every row written before this change has no code, FOREVER, and
// the ~90 English `result` sentences the other `recordAudit` call sites write never get one either.
// A `flowSummaryLabel` call that did not fall back — or a component that rendered the code token
// instead — would blank or corrupt the result cell of essentially the entire feed. That is a
// bigger defect than the one being fixed, and it would look like a successful localization.
// -------------------------------------------------------------------------------------------
describe('⭐ every row WITHOUT a usable code renders exactly as it does today', () => {
	it('an OLD row (no code at all) renders its English result unchanged, even in nl', () => {
		locale.current = 'nl';
		const el = render({ result: 'Manual checkpoint', resultCode: undefined });
		expect(resultText(el)).toBe('Manual checkpoint');
	});

	it("⛔ a USER-TYPED checkpoint (`resultCode: null`) comes back VERBATIM — their words, their language", () => {
		// The backend deliberately writes NO code when the user typed the text (routes/flows.ts).
		// Matching on the PROSE instead would translate a reader's own sentence on the audit trail.
		locale.current = 'nl';
		const el = render({ result: "Tom's eigen tekst", resultCode: null, resultParams: null });
		expect(resultText(el)).toBe("Tom's eigen tekst");
	});

	it('a NON-flow audit sentence (no code) is untouched — the feed is ~90 of these', () => {
		locale.current = 'nl';
		const el = render({ action: 'ontology.entity_create', result: "Custom entity 'Policy'" });
		expect(resultText(el)).toBe("Custom entity 'Policy'");
	});

	it('⛔ an UNRECOGNISED code (shipped backend-first) falls back to the English, never a bare token', () => {
		locale.current = 'nl';
		const el = render({ result: 'Forked the flow', resultCode: 'flow_summary_forked' });
		expect(resultText(el)).toBe('Forked the flow');
		// The failure mode that is NOT an empty cell: rendering the code itself.
		expect(el.textContent).not.toContain('flow_summary_forked');
	});

	it('⚠️ MID-ROLL — a code whose PARAMS an old pod did not send falls back, not to a broken sentence', () => {
		// `flow_summary_restored` interpolates `{at}`; without it the localized line would read
		// "Versie van undefined hersteld" — a translated sentence that says LESS than the English.
		locale.current = 'nl';
		const el = render({
			action: 'flow.restore',
			result: 'Restored snapshot from 2026-08-07T09:12:44.031Z',
			resultCode: 'flow_summary_restored',
			resultParams: null
		});
		expect(resultText(el)).toBe('Restored snapshot from 2026-08-07T09:12:44.031Z');
		expect(el.textContent).not.toContain('undefined');
	});

	it('a row with NO result at all still renders the em-dash placeholder, not an empty cell', () => {
		locale.current = 'nl';
		const el = render({ result: null, resultCode: null });
		expect(el.querySelector('.dot-status')).toBeNull();
		expect(el.querySelector('.muted')?.textContent).toBe('—');
	});

	it('⚠️ the two deferred English cells are untouched — this change is scoped to `result`', () => {
		locale.current = 'nl';
		const el = render({ resultCode: 'flow_summary_manual_checkpoint' });
		expect(el.textContent).toContain('flow.checkpoint');
		expect(el.textContent).toContain('3f1c8b2e-1c4a-4d2b-9f0e-6c1b2d3e4a8b');
	});
});
