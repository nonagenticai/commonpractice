// src/lib/i18n/ops-alert-label.test.ts — a /it-dash alert is rendered from its KIND plus machine
// fields, and only ever falls back to the backend's English when there is nothing else to say.
//
// The messages module is mocked so each key returns its own name plus its arguments: the assertions
// are about WHICH MESSAGE is selected and WHAT IS INTERPOLATED, not about English copy a translator
// may legitimately reword. Same technique as `data-finding-label.test.ts` and `policy-label.test.ts`.
import { describe, it, expect, vi } from 'vitest';
import type { AttentionItem, SandboxErrorAlert, HighLatencyAlert, BlockErrorsAlert } from '$lib/types/ops';

vi.mock('$lib/paraglide/messages', () => ({
	ops_alert_sandbox_error_title: (p: Record<string, unknown>) => `M_SBX_TITLE(${p.count})`,
	ops_alert_sandbox_error_more: (p: Record<string, unknown>) => `M_SBX_MORE(${p.owners}|${p.more})`,
	ops_alert_high_latency_title: () => 'M_LAT_TITLE',
	ops_alert_high_latency_detail: (p: Record<string, unknown>) =>
		`M_LAT_DETAIL(${p.p95}|${p.threshold})`,
	ops_alert_block_errors_title: (p: Record<string, unknown>) => `M_BLK_TITLE(${p.slug})`,
	ops_alert_block_errors_detail: (p: Record<string, unknown>) =>
		`M_BLK_DETAIL(${p.count}|${p.days})`
}));
// `ms()` is the shared latency formatter; stubbing it keeps this file about MESSAGE SELECTION and
// leaves the unit rules to `format`'s own tests. The `2000 → "2.00s"` shape is what it really does.
//
// ⛔ THE STUB ECHOES THE LOCALE TAG IT WAS HANDED. `ms()` takes a required `locale` because its
// seconds branch used a hard-coded '.' decimal separator, so a Dutch reader was told a P95 of
// "2.47s" was above a "2.00s" target inside an otherwise Dutch sentence. `svelte-check` proves the
// argument is PASSED, but not that the RIGHT one is: `opsAlertDetail` could thread a constant, or
// its own second argument to only one of the two figures, and still compile. Echoing the tag makes
// the assertions below state which locale reached each figure.
vi.mock('$lib/utils/format', () => ({
	ms: (n: number | null, locale: string) =>
		n == null ? '—' : n < 1000 ? `${n}ms@${locale}` : `${(n / 1000).toFixed(2)}s@${locale}`
}));

const { opsAlertTitle, opsAlertDetail } = await import('./ops-alert-label');

/** Every string the backend still composes. Reaching any of these on a full payload is the bug. */
const TITLE_PROSE = 'BACKEND ENGLISH TITLE — must not be reached';
const DETAIL_PROSE = 'BACKEND ENGLISH DETAIL — must not be reached';

// ⚠️ `errorCount` MATCHES `owners.length` here: the backend samples ≤5 owners, so the two agree
// whenever ≤5 sandboxes are in error. The over-5 case has its own fixture below.
const SBX: SandboxErrorAlert = {
	kind: 'sandbox_error',
	errorCount: 2,
	owners: [
		{ name: 'Fatima Hassani', project: 'Email auto-categorize' },
		{ name: 'Lisa de Vries', project: null }
	],
	title: TITLE_PROSE,
	detail: DETAIL_PROSE,
	href: '/sandboxes?status=error'
};
const LAT: HighLatencyAlert = {
	kind: 'high_latency',
	p95Ms: 2474,
	thresholdMs: 2000,
	title: TITLE_PROSE,
	detail: DETAIL_PROSE
};
const BLK: BlockErrorsAlert = {
	kind: 'block_errors',
	slug: 'triage-claim',
	runCount: 4,
	windowDays: 7,
	title: TITLE_PROSE,
	detail: DETAIL_PROSE
};

describe('opsAlertTitle / opsAlertDetail — the normal path', () => {
	it('renders all THREE kinds from the catalog, never the backend prose', () => {
		expect(opsAlertTitle(SBX)).toBe('M_SBX_TITLE(2)');
		expect(opsAlertTitle(LAT)).toBe('M_LAT_TITLE');
		expect(opsAlertTitle(BLK)).toBe('M_BLK_TITLE(triage-claim)');

		expect(opsAlertDetail(LAT, 'en')).toBe('M_LAT_DETAIL(2.47s@en|2.00s@en)');
		expect(opsAlertDetail(BLK, 'en')).toBe('M_BLK_DETAIL(4|7)');
	});

	it('leaves no backend English on any full payload', () => {
		// The assertion that reddens if someone "simplifies" a switch arm to `return item.title`.
		for (const a of [SBX, LAT, BLK] as AttentionItem[]) {
			expect(opsAlertTitle(a)).not.toContain(TITLE_PROSE);
			expect(opsAlertDetail(a, 'en')).not.toContain(DETAIL_PROSE);
		}
	});

	it('maps the three kinds onto DIFFERENT messages', () => {
		expect(new Set([opsAlertTitle(SBX), opsAlertTitle(LAT), opsAlertTitle(BLK)]).size).toBe(3);
	});

	it('⛔ the CALLER’s locale reaches BOTH latency figures, not a constant and not just one', () => {
		// The detail line quotes a measurement against its target in one sentence — "2,47 s, boven de
		// 2,00 s" — so a locale that reaches only `p95` produces a sentence that punctuates its two
		// numbers differently. `svelte-check` cannot see this: it proves an argument is passed, not
		// that it is the right one, and both figures are `string` either way.
		expect(opsAlertDetail(LAT, 'nl')).toBe('M_LAT_DETAIL(2.47s@nl|2.00s@nl)');
		expect(opsAlertDetail(LAT, 'de')).toBe('M_LAT_DETAIL(2.47s@de|2.00s@de)');
		// Non-vacuity: the tag is genuinely threaded, not baked into the stub.
		expect(opsAlertDetail(LAT, 'nl')).not.toBe(opsAlertDetail(LAT, 'de'));
	});

	it('passes `count` through as a NUMBER, so the ICU plural selector works', () => {
		// A stringified count picks the wrong category in pl/ar, which have more than two.
		expect(opsAlertTitle({ ...SBX, errorCount: 1 })).toBe('M_SBX_TITLE(1)');
		expect(opsAlertTitle({ ...SBX, errorCount: 22 })).toBe('M_SBX_TITLE(22)');
		expect(opsAlertDetail({ ...BLK, runCount: 2 }, 'en')).toBe('M_BLK_DETAIL(2|7)');
	});

	it('interpolates the WINDOW the backend actually queried, not a hard-coded 7', () => {
		// REVERT THAT TURNS THIS RED: replace `days: item.windowDays` with `days: 7`.
		expect(opsAlertDetail({ ...BLK, windowDays: 14 }, 'en')).toBe('M_BLK_DETAIL(4|14)');
	});

	// ---------------------------------------------------------------- the owner list
	it('composes owner names IN CODE with "; ", and omits a null project', () => {
		// Proper nouns + punctuation, so no message key — the precedent is `dataFindingRef`.
		expect(opsAlertDetail(SBX, 'en')).toBe('Fatima Hassani · Email auto-categorize; Lisa de Vries');
	});

	it('names the overflow when the ≤5 owner SAMPLE is smaller than the true count', () => {
		// ⛔ The count and the list are different numbers on purpose. Without this, the headline
		// says "12 sandboxes" over a list of five names and the reader assumes the list is complete.
		const big: SandboxErrorAlert = {
			...SBX,
			errorCount: 12,
			owners: Array.from({ length: 5 }, (_, i) => ({ name: `Owner ${i}`, project: null }))
		};
		expect(opsAlertDetail(big, 'en')).toBe(
			'M_SBX_MORE(Owner 0; Owner 1; Owner 2; Owner 3; Owner 4|7)'
		);
	});

	it('does NOT claim an overflow when the sample IS the whole population', () => {
		expect(opsAlertDetail(SBX, 'en')).not.toContain('M_SBX_MORE');
	});

	it('treats an empty-string project like a null one', () => {
		expect(opsAlertDetail({ ...SBX, errorCount: 1, owners: [{ name: 'Ada', project: '' }] }, 'en')).toBe(
			'Ada'
		);
	});

	// ---------------------------------------------------------------- ⛔ zero is a real number
	it('⛔ treats `errorCount: 0` and `runCount: 0` as PRESENT, not missing', () => {
		// REVERT THAT TURNS THIS RED: change the guard to `if (!item.errorCount) return item.title;`
		// (and `if (!item.runCount)`). Both alerts then fall through to English on a legal payload.
		expect(opsAlertTitle({ ...SBX, errorCount: 0, owners: [] })).toBe('M_SBX_TITLE(0)');
		expect(opsAlertDetail({ ...SBX, errorCount: 0, owners: [] }, 'en')).toBe('');
		expect(opsAlertDetail({ ...BLK, runCount: 0 }, 'en')).toBe('M_BLK_DETAIL(0|7)');
	});

	it('⛔ treats `p95Ms: 0` and `windowDays: 0` as PRESENT too', () => {
		expect(opsAlertDetail({ ...LAT, p95Ms: 0, thresholdMs: 0 }, 'en')).toBe('M_LAT_DETAIL(0ms@en|0ms@en)');
		expect(opsAlertDetail({ ...BLK, windowDays: 0 }, 'en')).toBe('M_BLK_DETAIL(4|0)');
	});
});

// ==================================================================================================
// ⛔ THE MID-ROLL BRANCH. The browser reaches the API through the k8s SERVICE, which load-balances
// across old and new pods for the length of a rolling deploy, so a NEW frontend answered by an OLD
// pod is a REAL wire shape, not a hypothetical. That exact hazard blanked /governance (PR #233).
// Interpolating an absent field would print "undefined sandboxes in error" — a localized sentence
// that says LESS than the English one it replaced.
// ==================================================================================================
describe('the machine fields are STRIPPED — an old backend, mid-roll', () => {
	/** The verbatim pre-change payload: prose only. */
	function stripped(a: AttentionItem): AttentionItem {
		const { title, detail, href, kind } = a as AttentionItem & { href?: string };
		return { kind, title, detail, href } as AttentionItem;
	}

	it('returns the backend prose VERBATIM wherever a machine field is missing', () => {
		// ⚠️ `high_latency`'s TITLE is excluded, and that exclusion is the point of the last test in
		// this block: it interpolates nothing, so there is no absent field to fall back FROM.
		for (const a of [SBX, BLK] as AttentionItem[]) {
			expect(opsAlertTitle(stripped(a)), `${a.kind} title`).toBe(TITLE_PROSE);
		}
		for (const a of [SBX, LAT, BLK] as AttentionItem[]) {
			expect(opsAlertDetail(stripped(a), 'en'), `${a.kind} detail`).toBe(DETAIL_PROSE);
		}
	});

	it('emits NO catalog token and no `undefined` on a stripped payload', () => {
		// The complement of the assertion above: prose AND no half-rendered message.
		for (const a of [SBX, BLK] as AttentionItem[]) {
			expect(opsAlertTitle(stripped(a))).not.toMatch(/^M_/);
			expect(opsAlertTitle(stripped(a))).not.toContain('undefined');
		}
		for (const a of [SBX, LAT, BLK] as AttentionItem[]) {
			expect(opsAlertDetail(stripped(a), 'en')).not.toMatch(/^M_/);
			expect(opsAlertDetail(stripped(a), 'en')).not.toContain('undefined');
		}
	});

	it('falls back when only PART of a kind’s field set arrived', () => {
		// A half-populated payload is the shape a partially-rolled-out change produces.
		expect(opsAlertDetail({ ...SBX, owners: undefined }, 'en')).toBe(DETAIL_PROSE);
		expect(opsAlertDetail({ ...SBX, errorCount: undefined }, 'en')).toBe(DETAIL_PROSE);
		expect(opsAlertDetail({ ...LAT, thresholdMs: undefined }, 'en')).toBe(DETAIL_PROSE);
		expect(opsAlertDetail({ ...BLK, windowDays: undefined }, 'en')).toBe(DETAIL_PROSE);
	});

	it('STILL localizes the high-latency TITLE, which has no machine fields to lose', () => {
		// ⛔ THE ASYMMETRY, ASSERTED. "P95 latency rising" is a constant sentence with nothing
		// interpolated, so it is translatable on EVERY wire version, old pod or new. Guards against
		// a copy-paste of the other kinds' mid-roll check onto this one, which would hand a Dutch
		// operator an English headline for no reason at all.
		// REVERT THAT TURNS THIS RED: add `if (item.p95Ms === undefined) return item.title;` to the
		// `high_latency` arm of `opsAlertTitle`.
		expect(opsAlertTitle(stripped(LAT))).toBe('M_LAT_TITLE');
		expect(opsAlertTitle({ ...LAT, p95Ms: undefined, thresholdMs: undefined })).toBe(
			'M_LAT_TITLE'
		);
		// …while its DETAIL, which does interpolate, still falls back.
		expect(opsAlertDetail(stripped(LAT), 'en')).toBe(DETAIL_PROSE);
	});
});

describe('an UNRECOGNISED kind', () => {
	// ⛔ THE DELIBERATE DIVERGENCE FROM `complianceLabel`, which returns the raw key. THIS IS AN
	// ALERTING SURFACE. A row degrading to a bare `sandbox_quota` token tells an operator nothing
	// they can act on; the English sentence tells them everything except in their own language.
	const UNKNOWN = {
		kind: 'sandbox_quota_exceeded',
		title: TITLE_PROSE,
		detail: DETAIL_PROSE
	} as unknown as AttentionItem;

	it('renders the PROSE, never the raw key', () => {
		expect(opsAlertTitle(UNKNOWN)).toBe(TITLE_PROSE);
		expect(opsAlertDetail(UNKNOWN, 'en')).toBe(DETAIL_PROSE);
		expect(opsAlertTitle(UNKNOWN)).not.toContain('sandbox_quota_exceeded');
		expect(opsAlertDetail(UNKNOWN, 'en')).not.toContain('sandbox_quota_exceeded');
	});

	it('renders the prose for an ABSENT kind', () => {
		const noKind = { title: TITLE_PROSE, detail: DETAIL_PROSE } as unknown as AttentionItem;
		expect(opsAlertTitle(noKind)).toBe(TITLE_PROSE);
		expect(opsAlertDetail(noKind, 'en')).toBe(DETAIL_PROSE);
	});
});
