// @vitest-environment jsdom
//
// src/routes/governance/governance-page.changelog-values.render.test.ts — "Recente wijzigingen"
// spells a policy value the same way the rail that owns it does.
//
// ⛔ THE DEFECT, MEASURED IN THE LIVE APP. The data-validation rail was flipped in the Dutch UI.
// The `<select>` two panels above offers *waarschuwen / blokkeren*; the changelog recorded the same
// edit as **`warn → block`**. One screen, one language, one action, two vocabularies — and the
// English half is the machine's, printed by:
//
//     function fmtVal(v) { … return String(v); }
//
// `c.policyKey` was already on the DTO and already read by the line directly above the diff (the
// row's NAME comes from `policyLabel(c.policyKey)`), so `policyOptionLabel` — which dispatches on
// exactly that pair — was reachable the whole time. Nothing needed to be added to the wire.
//
// ⛔ AND `String(v)` UN-LOCALIZES NUMBERS, which is the same defect in the other half of the same
// expression: a spend ceiling raised to 12 500 rendered "12500" on a screen whose audit-export
// notice one card below already writes "12.500". Both halves are asserted here, because fixing the
// enum and leaving the number is the obvious way to half-fix this.
//
// ⛔ NOTHING ABOUT THE MESSAGE LAYER IS MOCKED, AND THAT IS THE POINT. The sibling spec in this
// directory (`governance-page.i18n.render.test.ts`) stubs every message to its own KEY NAME —
// correct for it, since it asserts WHICH key each region resolved — and structurally unable to see
// this bug: under that stub `policyOptionLabel('data.validation_mode','warn')` returns
// "policy_option_validation_warn" whether or not the changelog calls it, because the stub's output
// for the RAW value would be… the raw value, and the two are trivially distinguishable only in a
// real catalog. This file reads the Dutch words.
//
// ⚠️ IT MUST BE DUTCH, NOT ENGLISH. `messages/en.json` sets `policy_option_validation_warn` to the
// literal string "warn" — correct copy, and it makes the base locale INCAPABLE of distinguishing
// the fix from the defect. An English-only spec here would pass on a full revert. Stated because
// "add the en case too, for symmetry" is the natural review comment and it would weaken the file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Governance, RecentChange } from '$lib/types/governance';
import { locale } from '$lib/stores/locale.svelte';

const { getGovernance, FakeApiError } = vi.hoisted(() => ({
	getGovernance: vi.fn(),
	FakeApiError: class extends Error {
		status = 0;
	}
}));
vi.mock('$lib/api/governance', () => ({
	governanceApi: { get: getGovernance, update: vi.fn(), exportNow: vi.fn() },
	ApiError: FakeApiError
}));
vi.mock('$lib/api/error-message', () => ({
	errorText: (_e: unknown, fallback: string) => fallback,
	writeErrorText: (_e: unknown, fallback: string) => fallback
}));

import Page from './+page.svelte';

const ACTOR = { name: 'Tom Bakker', initials: 'TB' };
const AT = '2026-08-16T09:00:00.000Z';

function change(over: Partial<RecentChange>): RecentChange {
	return {
		id: 'ch',
		policyKey: 'data.validation_mode',
		label: 'Validate injected data against the ontology',
		oldValue: 'warn',
		newValue: 'block',
		actor: ACTOR,
		createdAt: AT,
		...over
	};
}

/**
 * Every value SHAPE `PolicyValue` admits, one recorded change each.
 *
 * ⚠️ The two enum rails are the ones the live database actually holds changes for
 * (`select policy_key, old_value, new_value from policy_changes` → validation_mode `"warn"`→
 * `"block"`, weekly_spend_ceiling `10`→`15`, required_reviewers `"1"`→`"2"`, models.allowlist).
 * The spend figure is raised to FOUR DIGITS here on purpose: at the seeded 10 → 15 the grouped and
 * ungrouped spellings are byte-identical, so the real row cannot tell a fix from a revert.
 */
const CHANGES: RecentChange[] = [
	change({ id: 'ch-enum' }),
	change({
		id: 'ch-num',
		policyKey: 'spend.daily_llm_cap',
		label: 'Per-user daily LLM call cap',
		oldValue: 1000,
		newValue: 12500
	}),
	change({
		id: 'ch-idle',
		policyKey: 'spend.auto_suspend_idle',
		label: 'Auto-suspend idle sandboxes after',
		oldValue: '3 days',
		newValue: '14 days'
	}),
	change({
		id: 'ch-digits',
		policyKey: 'promotion.required_reviewers',
		label: 'Required reviewers',
		oldValue: '1',
		newValue: '2'
	}),
	change({
		id: 'ch-bool',
		policyKey: 'promotion.mandatory_review',
		label: 'Mandatory code review',
		oldValue: false,
		newValue: true
	}),
	change({
		id: 'ch-list',
		policyKey: 'models.allowlist',
		label: 'Allowlisted models',
		oldValue: null,
		newValue: ['claude-opus-4-8', 'gpt-4.1']
	})
];

function dto(): Governance {
	return {
		groups: [
			{
				category: 'data_isolation',
				title: 'Data & isolation',
				policies: [
					{
						key: 'data.validation_mode',
						category: 'data_isolation',
						label: 'Validate injected data against the ontology',
						description: 'Before a run, a dataset bound to an ontology entity is checked.',
						control: 'select',
						// ⚠️ THE RAIL'S LIVE VALUE IS THE CHANGE'S `newValue`. That is what makes the
						// cross-check at the bottom of this file mean something: the two regions are
						// describing the SAME state and must therefore print the same word.
						value: 'block',
						options: ['warn', 'block'],
						unit: null,
						enabled: true
					},
					{
						key: 'spend.daily_llm_cap',
						category: 'data_isolation',
						label: 'Per-user daily LLM call cap',
						description: 'The metered LLM broker rejects a call past this many.',
						control: 'number',
						value: 12500,
						options: null,
						unit: 'calls/day',
						enabled: true
					}
				]
			}
		],
		compliance: [
			{ key: 'iso27001', statusKey: 'passing', label: 'ISO 27001 controls', status: 'Passing', tone: 'ok' }
		],
		recentChanges: CHANGES,
		exportStatus: { enabled: false, bucket: 'compliance', hourUtc: 2, lastRun: null, recent: [] }
	};
}

let host: HTMLElement;
let app: Record<string, unknown> | undefined;
const initialLocale = locale.current;

beforeEach(() => {
	getGovernance.mockReset();
	getGovernance.mockResolvedValue(dto());
	host = document.createElement('div');
	document.body.appendChild(host);
	// Assigned directly, never via `locale.set()` — that PATCHes /api/me/locale, which the fail-loud
	// fetch stub in lib/test/setup.ts would name. `stores/locale.svelte.ts` rebinds paraglide's
	// `getLocale()` onto this rune, so ONE assignment moves both the catalog and `exact()`'s tag.
	locale.current = 'nl';
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
	locale.current = initialLocale;
});

async function render(): Promise<string[]> {
	app = mount(Page, { target: host, props: {} });
	flushSync();
	await Promise.resolve();
	await Promise.resolve();
	flushSync();
	// ⛔ THE POSITIVE ANCHOR. `.changes` lives inside `{#if data}`; a page stuck in its loading or
	// denied branch renders no list at all, and every "the raw value is gone" assertion below would
	// pass against an empty DOM.
	expect(getGovernance, 'the page never asked for its data').toHaveBeenCalled();
	const rows = [...host.querySelectorAll('.changes .ch-diff')].map((n) => n.textContent ?? '');
	expect(rows, 'the recent-changes list never rendered').toHaveLength(CHANGES.length);
	return rows;
}

describe('/governance records a change in the same words the rail above it offers', () => {
	it('⛔ THE ENUM CASE: the flip reads "waarschuwen → blokkeren", never "warn → block"', async () => {
		const rows = await render();
		expect(rows[0]).toBe('waarschuwen → blokkeren');

		// ⛔ THE ASSERTION THAT INVERTS ON A REVERT TO `String(v)`. Scoped to the changelog card,
		// because the `<select>` in the rails column legitimately carries `value="warn"` /
		// `value="block"` as WIRE values and must keep them — a document-wide grep would red on the
		// fix, not on the defect.
		const changelog = host.querySelector('.changes')!.textContent ?? '';
		expect(changelog, 'the raw enum is back in the changelog').not.toContain('warn');
		expect(changelog, 'the raw enum is back in the changelog').not.toContain('block');
	});

	it('⛔ THE NUMBER CASE: 12500 reads "12.500" — the reader’s punctuation, not the machine’s', async () => {
		const rows = await render();
		expect(rows[1]).toBe('1.000 → 12.500');
		const changelog = host.querySelector('.changes')!.textContent ?? '';
		expect(changelog, 'the ungrouped figure is back').not.toContain('12500');
	});

	it('the idle window is localized from ITS OWN rail’s vocabulary, not a shared one', async () => {
		// `policyOptionLabel` dispatches on (policyKey, value) rather than on value alone precisely
		// because option vocabularies are per-policy. '3 days' belongs to `spend.auto_suspend_idle`
		// and nothing else; a value-only lookup would be a second mechanism waiting to collide.
		const rows = await render();
		expect(rows[2]).toBe('3 dagen → 14 dagen');
		expect(host.querySelector('.changes')!.textContent).not.toContain('days');
	});

	it('DIGITS, BOOLEANS AND LISTS ARE UNTOUCHED — three ways this fix could overreach', async () => {
		const rows = await render();
		// Reviewer counts are the digits 1/2/3 in every locale; `policy-label.ts` gives that rail no
		// cases on purpose and the changelog must not invent any.
		expect(rows[3]).toBe('1 → 2');
		// Booleans already had a mechanism (`governance_value_on/off`) and keep it.
		expect(rows[4]).toBe('uit → aan');
		// ⛔ MODEL IDENTIFIERS ARE NOT WORDS. They must render byte-for-byte or an operator cannot
		// match a row against a vendor's price sheet — the same call `policyMapKeyLabel` makes for
		// `models.pricing`. And a null side is still the em dash, not "null".
		expect(rows[5]).toBe('— → claude-opus-4-8, gpt-4.1');
	});

	it('⛔ THE CONTRADICTION ITSELF: the changelog and the rail now print the SAME word', async () => {
		// This is the defect as it was seen, driven end to end rather than described. The rail's
		// live value and the change's `newValue` are both `block`; whatever word the `<select>`
		// shows for it, the diff beside it must show too. Reverting `fmtVal` makes these two
		// strings "blokkeren" and "block" and reds this line with both printed.
		const rows = await render();
		const select = host.querySelector('.rails select') as HTMLSelectElement;
		expect(select, 'the validation rail never rendered').not.toBeNull();
		const chosen = [...select.options].find((o) => o.value === 'block')!;
		expect(chosen.textContent).toBe('blokkeren');
		expect(rows[0]).toContain(chosen.textContent!);
		// …while the wire value it submits is untouched. A "fix" that localized the option's VALUE
		// would agree with the changelog and 422 every edit on the screen.
		expect(chosen.value).toBe('block');
	});

	it('the Dutch fixture is really Dutch — non-vacuity for every assertion above', async () => {
		// If the locale lever stopped working the catalog would answer English, `en`'s
		// `policy_option_validation_warn` is the literal string "warn", and the enum assertions would
		// pass while proving the exact opposite. So the file states, once, that it is not in `en`.
		const rows = await render();
		expect(locale.current).toBe('nl');
		expect(rows[4]).not.toBe('off → on');
		expect(host.textContent).not.toContain('Recent changes');
	});
});
