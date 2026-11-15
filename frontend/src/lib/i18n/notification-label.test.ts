// src/lib/i18n/notification-label.test.ts — an in-app notification is rendered from its KIND plus
// the machine fields in `data`, and only ever falls back to the backend's English when there is
// nothing else to say.
//
// The messages module is mocked so each key returns its own name plus its arguments: the assertions
// are about WHICH MESSAGE is selected and WHAT IS INTERPOLATED, not about English copy a translator
// may legitimately reword. Same technique as `ops-alert-label.test.ts` and `policy-label.test.ts`.
// The DUTCH end of it — that these keys really do resolve to Dutch on a real catalog — is
// `layout/notification-bell.i18n.render.test.ts`, which mounts the bell against `messages/nl.json`.
import { describe, it, expect, vi } from 'vitest';
import type { AppNotification, BudgetThresholdNotification } from '$lib/types/admin';

vi.mock('$lib/paraglide/messages', () => ({
	notification_budget_used_up_title: () => 'M_USED_UP_TITLE',
	notification_budget_threshold_title: (p: Record<string, unknown>) => `M_PCT_TITLE(${p.pct})`,
	notification_budget_used_up_body: (p: Record<string, unknown>) =>
		`M_USED_UP_BODY(${p.limit}|${p.tenant})`,
	notification_budget_low_body: (p: Record<string, unknown>) =>
		`M_LOW_BODY(${p.remaining}|${p.limit}|${p.tenant})`,
	notification_budget_heads_up_body: (p: Record<string, unknown>) =>
		`M_HEADS_UP_BODY(${p.remaining}|${p.limit}|${p.tenant})`,
	notification_budget_how_to: (p: Record<string, unknown>) => `M_HOW_TO(${p.path})`,
	settings_path_llm: (p: Record<string, unknown>) => `M_PATH(${p.settings}|${p.group}|${p.page})`,
	// ⚠️ THE SIDEBAR'S OWN KEYS, deliberately mocked here rather than stubbed to fixed strings: the
	// point of the call-to-action is that it renders the SAME three labels the shell renders
	// (Settings gear → Organisation → LLM settings), so the test has to see which keys were read.
	// ⛔ NOT `nav_group_administer`: that menu group is gone, and naming it sent readers nowhere.
	nav_settings: () => 'M_NAV_SETTINGS',
	settings_group_organisation: () => 'M_SETTINGS_ORG',
	nav_llm_settings: () => 'M_NAV_LLM_SETTINGS'
}));
// `usd()` is the shared money formatter; stubbing it keeps this file about MESSAGE SELECTION and
// leaves the currency rules to `format`'s own tests. `$50.00` is what it really produces.
vi.mock('$lib/utils/format', () => ({
	// ⛔ THE MOCK ECHOES THE TAG ON PURPOSE. A one-parameter `usd` stub stays green under a
	// required-`locale` signature and proves NOTHING about threading — `notificationBody` could
	// hard-code 'en' internally and every assertion below would still pass. Measured: with the
	// old `(n) => `$${n.toFixed(2)}`` stub this suite was green against exactly that. Echoing the
	// locale into the output is what makes the tag observable. Same shape as ops-alert-label.test.
	usd: (n: number, locale: string) => `$${n.toFixed(2)}@${locale}`
}));

const { notificationTitle, notificationBody } = await import('./notification-label');

/** Every string `backend/src/host/budget-service.ts` still composes. Reaching one on a full
 *  payload is the bug this file exists for. */
const TITLE_PROSE = 'BACKEND ENGLISH TITLE — must not be reached';
const BODY_PROSE = 'BACKEND ENGLISH BODY — must not be reached';

function notif(
	threshold: number,
	over: Partial<BudgetThresholdNotification['data']> = {}
): BudgetThresholdNotification {
	return {
		id: `n-${threshold}`,
		kind: 'budget.threshold',
		severity: threshold >= 90 ? 'critical' : 'warn',
		title: TITLE_PROSE,
		body: BODY_PROSE,
		href: '/llm-settings',
		read: false,
		createdAt: '2026-08-12T04:00:00.000Z',
		data: { threshold, tenantName: 'Acme Verzekeringen', limitUsd: 50, remainingUsd: 12.5, ...over }
	};
}

describe('notificationTitle / notificationBody — the normal path', () => {
	it('renders all THREE rungs from the catalog, never the backend prose', () => {
		expect(notificationTitle(notif(75))).toBe('M_PCT_TITLE(75)');
		expect(notificationTitle(notif(90))).toBe('M_PCT_TITLE(90)');
		expect(notificationTitle(notif(100))).toBe('M_USED_UP_TITLE');

		expect(notificationBody(notif(75), 'nl')).toBe(
			'M_HEADS_UP_BODY($12.50@nl|$50.00@nl|Acme Verzekeringen) M_HOW_TO(M_PATH(M_NAV_SETTINGS|M_SETTINGS_ORG|M_NAV_LLM_SETTINGS))'
		);
		expect(notificationBody(notif(90), 'nl')).toBe(
			'M_LOW_BODY($12.50@nl|$50.00@nl|Acme Verzekeringen) M_HOW_TO(M_PATH(M_NAV_SETTINGS|M_SETTINGS_ORG|M_NAV_LLM_SETTINGS))'
		);
		expect(notificationBody(notif(100, { remainingUsd: 0 }), 'nl')).toBe(
			'M_USED_UP_BODY($50.00@nl|Acme Verzekeringen) M_HOW_TO(M_PATH(M_NAV_SETTINGS|M_SETTINGS_ORG|M_NAV_LLM_SETTINGS))'
		);
	});

	it('leaves no backend English on any full payload', () => {
		// The assertion that reddens if someone "simplifies" a switch arm back to `return n.title`.
		for (const t of [75, 90, 100]) {
			expect(notificationTitle(notif(t))).not.toContain(TITLE_PROSE);
			expect(notificationBody(notif(t), 'nl')).not.toContain(BODY_PROSE);
		}
	});

	it('⛔ maps 75 and 90 onto DIFFERENT body messages, not one key with a number in it', () => {
		// They differ by more than a percentage: 90 says model calls STOP at zero, 75 says nothing is
		// blocked yet. Collapsing them into `{pct}` would tell a tenant at 75 % their flows are dying.
		expect(notificationBody(notif(75), 'nl')).toContain('M_HEADS_UP_BODY');
		expect(notificationBody(notif(90), 'nl')).toContain('M_LOW_BODY');
		expect(new Set([75, 90, 100].map((t) => notificationBody(notif(t), 'nl')!.split(' ')[0])).size).toBe(3);
	});

	it('⛔ the 100 rung does NOT name the remainder', () => {
		// "$0.00 is left" reads as a rounding artefact, not as a stop. The exhausted sentence is the
		// only one that omits it, which is also why its absence is not a fallback trigger there.
		const body = notificationBody(notif(100, { remainingUsd: 0 }), 'nl')!;
		expect(body).toContain('M_USED_UP_BODY');
		expect(body).not.toContain('$0.00');
	});

	it('interpolates `pct` as the RUNG the backend claimed, not a hard-coded 75/90', () => {
		// REVERT THAT TURNS THIS RED: return `m.notification_budget_threshold_title({ pct: 75 })`.
		// `ALERT_THRESHOLDS` is a backend constant that can gain a rung; a hard-coded number would
		// then render a real alert as the wrong one.
		expect(notificationTitle(notif(50))).toBe('M_PCT_TITLE(50)');
		expect(notificationBody(notif(50), 'nl')).toContain('M_HEADS_UP_BODY');
	});

	it('runs the SAME `>= 100 / >= 90 / else` ladder as `alertCopy`, not equality', () => {
		// The backend's top rung is tied to actual exhaustion, not to a rounded 100, so a value above
		// 100 is reachable in principle and must not fall through to the heads-up sentence.
		expect(notificationTitle(notif(101))).toBe('M_USED_UP_TITLE');
		expect(notificationTitle(notif(89.9))).toBe('M_PCT_TITLE(89.9)');
		expect(notificationBody(notif(89.9), 'nl')).toContain('M_HEADS_UP_BODY');
	});

	it('passes `pct` through as a NUMBER, so an ICU plural selector would work', () => {
		// A stringified count picks the wrong category in pl/ar, which have more than two.
		expect(notificationTitle(notif(1))).toBe('M_PCT_TITLE(1)');
		expect(typeof notif(90).data!.threshold).toBe('number');
	});

	// ---------------------------------------------------------------- the call to action
	it('⛔ builds the breadcrumb from the SIDEBAR’s own two keys', () => {
		// THE SHARPEST EDGE OF THE WHOLE DEFECT. The English body told the reader to open
		// "Administer → LLM settings" while the menu beside it rendered "Beheren → LLM-instellingen".
		// REVERT THAT TURNS THIS RED: hard-code the two label strings into the eight catalogs, the
		// way `blockresult_errkind_budget_exhausted` does — where ar has already drifted off the real
		// nav labels.
		for (const t of [75, 90, 100]) {
			expect(notificationBody(notif(t), 'nl')).toContain('M_HOW_TO(M_PATH(M_NAV_SETTINGS|M_SETTINGS_ORG|M_NAV_LLM_SETTINGS))');
		}
	});

	it('appends the call to action to EVERY rung, as the backend does', () => {
		for (const t of [75, 90, 100]) {
			expect(notificationBody(notif(t), 'nl')).toContain('M_HOW_TO');
		}
	});
});

// ==================================================================================================
// ⛔ THE MIDDLE BRANCH. `notifications.data` is absent for TWO different reasons, and only one of
// them expires:
//   1. mid-roll — the browser reaches the API through the k8s SERVICE, which load-balances across
//      old and new pods for the length of a rolling deploy, so a NEW frontend really is answered by
//      an OLD pod. That exact hazard blanked /governance (PR #233).
//   2. FOREVER — a notification is a stored ROW. Every row written before migration 0066 has
//      `data IS NULL` for as long as it exists, and nothing can backfill it (`remainingUsd` came
//      from a live OpenRouter response at alert time). This branch is not transitional debt.
// Interpolating an absent field would print "undefined of $50.00 is left" — a localized sentence
// that says LESS than the English one it replaced.
// ==================================================================================================
describe('the machine fields are MISSING — an old row, or an old pod mid-roll', () => {
	/** The verbatim pre-0066 wire shape: prose, no `data` key at all. */
	function stripped(n: BudgetThresholdNotification): BudgetThresholdNotification {
		const { data: _drop, ...rest } = n;
		return rest;
	}

	it('returns the backend prose VERBATIM when `data` is absent entirely', () => {
		for (const t of [75, 90, 100]) {
			expect(notificationTitle(stripped(notif(t)))).toBe(TITLE_PROSE);
			expect(notificationBody(stripped(notif(t)), 'nl')).toBe(BODY_PROSE);
		}
	});

	it('returns the prose when `data` is present but EMPTY', () => {
		// A producer that wrote `{}` is the same story as one that wrote nothing.
		const n = { ...notif(90), data: {} };
		expect(notificationTitle(n)).toBe(TITLE_PROSE);
		expect(notificationBody(n, 'nl')).toBe(BODY_PROSE);
	});

	it('emits NO catalog token and no `undefined` on a stripped payload', () => {
		// The complement of the assertion above: prose AND no half-rendered message.
		for (const t of [75, 90, 100]) {
			expect(notificationTitle(stripped(notif(t)))).not.toMatch(/M_/);
			expect(notificationTitle(stripped(notif(t)))).not.toContain('undefined');
			expect(notificationBody(stripped(notif(t)), 'nl')).not.toMatch(/M_/);
			expect(notificationBody(stripped(notif(t)), 'nl')).not.toContain('undefined');
		}
	});

	it('falls back when only PART of the field set arrived', () => {
		// A half-populated payload is the shape a partially-rolled-out producer writes.
		expect(notificationBody(notif(90, { tenantName: undefined }), 'nl')).toBe(BODY_PROSE);
		expect(notificationBody(notif(90, { limitUsd: undefined }), 'nl')).toBe(BODY_PROSE);
		expect(notificationBody(notif(90, { remainingUsd: undefined }), 'nl')).toBe(BODY_PROSE);
		expect(notificationBody(notif(100, { limitUsd: undefined }), 'nl')).toBe(BODY_PROSE);
		// The TITLE needs only `threshold`, so it keeps resolving when the money is missing — the
		// same asymmetry `opsAlertTitle` has for `high_latency`. Falling back here would hand a Dutch
		// reader an English headline for no reason at all.
		expect(notificationTitle(notif(90, { limitUsd: undefined, tenantName: undefined }))).toBe(
			'M_PCT_TITLE(90)'
		);
	});

	it('⛔ the 100 rung does NOT need `remainingUsd`, and must not fall back for want of it', () => {
		// REVERT THAT TURNS THIS RED: hoist the `remainingUsd == null` guard above the `>= 100`
		// branch. The most urgent alert CP sends would then render in English whenever the producer
		// omitted a number that sentence never uses.
		expect(notificationBody(notif(100, { remainingUsd: undefined }), 'nl')).toContain('M_USED_UP_BODY');
	});

	it('returns `null` — not the string "null" — when the row itself has no body', () => {
		// `AppNotification.body` is genuinely nullable, and the bell's `{#if text}` depends on it.
		const n = { ...stripped(notif(90)), body: null };
		expect(notificationBody(n, 'nl')).toBeNull();
	});
});

// ==================================================================================================
// ⛔ ZERO IS A REAL NUMBER. `remainingUsd: 0` is not a missing value — it is the exact state the
// 100 % alert exists to report, and `threshold: 0` / `limitUsd: 0` are legal too. A truthiness
// guard drops precisely the most urgent notification CP sends into the English branch.
// ==================================================================================================
describe('⛔ a `0` field is PRESENT', () => {
	it('renders the catalog message for `remainingUsd: 0`', () => {
		// REVERT THAT TURNS THIS RED: change the guard to `if (!d.remainingUsd) return n.body;`.
		expect(notificationBody(notif(90, { remainingUsd: 0 }), 'nl')).toBe(
			'M_LOW_BODY($0.00@nl|$50.00@nl|Acme Verzekeringen) M_HOW_TO(M_PATH(M_NAV_SETTINGS|M_SETTINGS_ORG|M_NAV_LLM_SETTINGS))'
		);
	});

	it('renders the catalog message for `threshold: 0` and `limitUsd: 0`', () => {
		// REVERT THAT TURNS THIS RED: `if (!t) return n.title;` / `if (!d.limitUsd) return n.body;`.
		expect(notificationTitle(notif(0))).toBe('M_PCT_TITLE(0)');
		expect(notificationBody(notif(0, { limitUsd: 0 }), 'nl')).toContain('M_HEADS_UP_BODY($12.50@nl|$0.00@nl|');
	});

	it('treats an empty-string tenant name as PRESENT too', () => {
		// `tenants.name` is NOT NULL but not non-empty; an empty name is a data problem, not a reason
		// to show a different sentence. `== null` says so; a truthiness check would not.
		expect(notificationBody(notif(90, { tenantName: '' }), 'nl')).toContain('M_LOW_BODY($12.50@nl|$50.00@nl|)');
	});
});

// ==================================================================================================
// ⛔ THE THIRD BRANCH. `notifications.kind` is a bare `text()` column with no enum and no CHECK
// (backend/src/db/schema.ts), and 0044 says the table was "kept generic so any future alert can use
// it". A second kind will ship backend-first, and it must degrade to a readable sentence.
// ==================================================================================================
describe('an UNRECOGNISED kind', () => {
	// ⛔ THE DELIBERATE DIVERGENCE FROM `complianceLabel`, which returns the raw key. That panel is a
	// fixed four-row display where an unknown key can only be a build defect. THIS IS AN ALERTING
	// SURFACE: a row degrading to a bare `member.invited` token tells the reader nothing they can
	// act on, while the English sentence tells them everything except in their own language.
	const UNKNOWN = {
		...notif(90),
		kind: 'member.invited',
		title: TITLE_PROSE,
		body: BODY_PROSE
	} as unknown as AppNotification;

	it('renders the PROSE, never the raw kind', () => {
		expect(notificationTitle(UNKNOWN)).toBe(TITLE_PROSE);
		expect(notificationBody(UNKNOWN, 'nl')).toBe(BODY_PROSE);
		expect(notificationTitle(UNKNOWN)).not.toContain('member.invited');
		expect(notificationBody(UNKNOWN, 'nl')).not.toContain('member.invited');
	});

	it('renders the prose even when the unknown kind DOES carry data', () => {
		// A future kind's fields are not this kind's fields. Reading `data.threshold` off it would
		// invent a budget alert out of an invitation.
		expect(notificationTitle(UNKNOWN)).not.toMatch(/M_/);
		expect(notificationBody(UNKNOWN, 'nl')).not.toMatch(/M_/);
	});

	it('renders the prose for an ABSENT kind', () => {
		const noKind = { ...notif(90), kind: undefined } as unknown as AppNotification;
		expect(notificationTitle(noKind)).toBe(TITLE_PROSE);
		expect(notificationBody(noKind, 'nl')).toBe(BODY_PROSE);
	});
});
