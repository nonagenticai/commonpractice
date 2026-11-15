// @vitest-environment jsdom
//
// src/lib/components/ops/policy-row.i18n.render.test.ts — one governance rail, rendered.
//
// ⛔ THE DEFECT. Every fixture below carries the EXACT English the backend still sends in
// `label` / `description` / `unit` / `options`, taken verbatim from
// backend/src/db/seed-platform.ts. If the component ever reads those fields again — directly, or
// through a `?? policy.label` fallback someone adds "just in case" — that English appears in the
// DOM and these tests fail. Assertions are on MESSAGE TOKENS, not on Dutch copy a translator may
// legitimately reword.
//
// ⚠️ The second half of this suite is about the WIRE, not the words: an `<option value>` and a
// `map` field key are submitted back to /api/governance, where `validateValue` checks them
// against `policies.options`. Localizing those would 422 every policy edit on the screen, which
// is a worse bug than the English it fixes — so they are pinned separately from the display text.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import type { Policy, PolicyValue } from '$lib/types/governance';

vi.mock('$lib/paraglide/messages', () => {
	const mod: Record<string, () => string> = {
		// PolicyRow's own chrome
		ops_policy_list_placeholder: () => 'PLACEHOLDER',
		ops_policy_edit: () => 'EDIT',
		// the vocabulary under test that is not per-policy
		policy_option_validation_warn: () => 'M_WARN',
		policy_option_validation_block: () => 'M_BLOCK',
		policy_option_idle_3_days: () => 'M_3D',
		policy_option_idle_7_days: () => 'M_7D',
		policy_option_idle_14_days: () => 'M_14D',
		policy_unit_calls_per_day: () => 'M_CALLS_PER_DAY',
		policy_tier_small: () => 'M_SMALL',
		policy_tier_medium: () => 'M_MEDIUM',
		policy_tier_large: () => 'M_LARGE',
		// The stand-in a RETIRED rail renders instead of a control.
		governance_enforcement_retired_mark: () => 'M_NOT_ENFORCED'
	};
	// `policyLabel` / `policyDescription` are looked up for EVERY rail the component renders, so
	// the mock has to answer for all eighteen or an unrelated fixture throws on a missing export.
	for (const k of [
		'data_block_prod_data',
		'data_pii_scrubbing',
		'data_cross_sandbox_isolation',
		'data_eu_only',
		'data_validation_mode',
		'spend_daily_llm_cap',
		'spend_weekly_spend_ceiling',
		'spend_auto_suspend_idle',
		'models_pricing',
		'models_allowlist',
		'models_work_tiers',
		'models_external_http',
		'models_code_exec_outside_blocks',
		'data_egress_allowlist',
		'promotion_mandatory_review',
		'promotion_required_reviewers',
		'promotion_staging_canary_pct',
		'block_publish_require_passing_tests'
	]) {
		mod[`policy_label_${k}`] = () => `M_LABEL_${k}`;
		mod[`policy_desc_${k}`] = () => `M_DESC_${k}`;
	}
	return mod;
});

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

async function render(policy: Policy, onchange: (v: PolicyValue) => void = () => {}) {
	const { default: PolicyRow } = await import('./PolicyRow.svelte');
	app = mount(PolicyRow, { target: host, props: { policy, onchange } });
	flushSync();
	return host;
}

/** `label` / `description` carry the seeder's ENGLISH on purpose — see the header note. */
function policy(p: Partial<Policy> & Pick<Policy, 'key' | 'control' | 'value'>): Policy {
	return {
		category: 'data_isolation',
		label: 'SEEDER ENGLISH LABEL',
		description: 'SEEDER ENGLISH DESCRIPTION',
		options: null,
		unit: null,
		enabled: true,
		...p
	} as Policy;
}

describe('a rail names and explains itself from its KEY', () => {
	it('a toggle rail shows the message, not the seeded English', async () => {
		const el = await render(
			policy({
				key: 'data.block_prod_data',
				control: 'toggle',
				value: true,
				label: 'Block real production data from sandboxes',
				description:
					'A run is started with a scrubbed environment — no database URL, no provider keys — so no production data is reachable from it. Sample data comes from ctx.mockData(), generated deterministically inside the runner.'
			})
		);
		expect(el.querySelector('.policy-name')!.textContent).toBe('M_LABEL_data_block_prod_data');
		expect(el.querySelector('.policy-desc')!.textContent).toBe('M_DESC_data_block_prod_data');
		expect(el.textContent).not.toContain('Block real production data');
		// ⚠️ The negative token moved with the seeder. It used to be 'nightly job' — a phrase the
		// description CLAIMED and the platform never had (there is no nightly mock-data job; four
		// schedulers boot and none of them is one). The fixture now carries the corrected English,
		// so the token has to be one the corrected sentence actually contains.
		expect(el.textContent).not.toContain('scrubbed environment');
	});

	it('the toggle’s ACCESSIBLE NAME is localized too, not just the visible row', async () => {
		// `label` is what a screen-reader user hears when the switch takes focus; leaving it on
		// `policy.label` would localize the sighted row and read English to everyone else.
		const el = await render(
			policy({
				key: 'data.block_prod_data',
				control: 'toggle',
				value: true,
				label: 'Block real production data from sandboxes'
			})
		);
		const named = [...el.querySelectorAll('[aria-label]')].map((n) => n.getAttribute('aria-label'));
		expect(named).toContain('M_LABEL_data_block_prod_data');
		expect(named).not.toContain('Block real production data from sandboxes');
	});

	it('a rail whose key this build does not know shows the KEY, never the English', async () => {
		// The default branches. An ugly identifier is the intended failure mode; the English
		// sentence sitting one field away is not.
		const el = await render(
			policy({
				key: 'data.some_future_rail',
				control: 'toggle',
				value: false,
				label: 'A brand new English label',
				description: 'A brand new English description.'
			})
		);
		expect(el.querySelector('.policy-name')!.textContent).toBe('data.some_future_rail');
		expect(el.querySelector('.policy-desc')!.textContent).toBe('');
		expect(el.textContent).not.toContain('A brand new English');
	});
});

describe('the unit beside a number input', () => {
	it('localizes `calls/day`', async () => {
		const el = await render(
			policy({ key: 'spend.daily_llm_cap', control: 'number', value: 50, unit: 'calls/day' })
		);
		expect(el.querySelector('.unit')!.textContent).toBe('M_CALLS_PER_DAY');
		expect(el.textContent).not.toContain('calls/day');
	});

	it('leaves `€` and `%` exactly as they are', async () => {
		const euro = await render(
			policy({ key: 'spend.weekly_spend_ceiling', control: 'number', value: 15, unit: '€' })
		);
		expect(euro.querySelector('.unit')!.textContent).toBe('€');
		unmount(app!);
		app = undefined;
		host.innerHTML = '';

		const pct = await render(
			policy({ key: 'promotion.staging_canary_pct', control: 'number', value: 5, unit: '%' })
		);
		expect(pct.querySelector('.unit')!.textContent).toBe('%');
	});
});

describe('a select rail localizes the WORDS and preserves the WIRE VALUES', () => {
	it('renders the message text on each option', async () => {
		const el = await render(
			policy({
				key: 'data.validation_mode',
				control: 'select',
				value: 'warn',
				options: ['warn', 'block']
			})
		);
		expect([...el.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['M_WARN', 'M_BLOCK']);
		expect(el.textContent).not.toContain('warn');
		expect(el.textContent).not.toContain('block');
	});

	it('⚠️ keeps `value` as the raw wire value — the API validates against it', async () => {
		// `validateValue` in backend/src/routes/governance.ts rejects anything not in
		// `policies.options` with a 422. A localized `value` breaks every edit of this rail.
		const el = await render(
			policy({
				key: 'spend.auto_suspend_idle',
				control: 'select',
				value: '7 days',
				options: ['3 days', '7 days', '14 days']
			})
		);
		expect([...el.querySelectorAll('option')].map((o) => o.value)).toEqual([
			'3 days',
			'7 days',
			'14 days'
		]);
		expect([...el.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
			'M_3D',
			'M_7D',
			'M_14D'
		]);
	});

	it('⚠️ submits the raw wire value on change', async () => {
		// The end-to-end version of the assertion above: what actually leaves the component.
		const seen: PolicyValue[] = [];
		const el = await render(
			policy({
				key: 'spend.auto_suspend_idle',
				control: 'select',
				value: '7 days',
				options: ['3 days', '7 days', '14 days']
			}),
			(v) => seen.push(v)
		);
		const select = el.querySelector('select')!;
		select.value = '14 days';
		select.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(seen).toEqual(['14 days']);
	});

	it('leaves reviewer counts as digits', async () => {
		const el = await render(
			policy({
				key: 'promotion.required_reviewers',
				control: 'select',
				value: '2',
				options: ['1', '2', '3']
			})
		);
		expect([...el.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['1', '2', '3']);
		expect([...el.querySelectorAll('option')].map((o) => o.value)).toEqual(['1', '2', '3']);
	});
});

describe('a map rail distinguishes words from identifiers', () => {
	it('localizes the three work tiers', async () => {
		const el = await render(
			policy({
				key: 'models.work_tiers',
				category: 'models_tools',
				control: 'map',
				value: { small: 'a/b', medium: 'c/d', large: 'e/f' }
			})
		);
		expect([...el.querySelectorAll('.map-key')].map((n) => n.textContent)).toEqual([
			'M_SMALL',
			'M_MEDIUM',
			'M_LARGE'
		]);
		// The VALUES are model ids and stay verbatim in their inputs.
		expect([...el.querySelectorAll<HTMLInputElement>('.map-value')].map((n) => n.value)).toEqual([
			'a/b',
			'c/d',
			'e/f'
		]);
	});

	it('⚠️ leaves `models.pricing` keys byte-for-byte — they are model identifiers', async () => {
		// An operator matches these against a vendor price sheet. `local/*` must keep its glob and
		// `small` must NOT be translated just because the other map rail has a tier by that name.
		const el = await render(
			policy({
				key: 'models.pricing',
				category: 'spend_quota',
				control: 'map',
				value: { 'local/*': '0/0', 'anthropic/claude-opus-4-8': '5/25', small: '1/1' }
			})
		);
		expect([...el.querySelectorAll('.map-key')].map((n) => n.textContent)).toEqual([
			'local/*',
			'anthropic/claude-opus-4-8',
			'small'
		]);
	});

	it('⚠️ submits the raw map key on edit, not the localized word', async () => {
		const seen: PolicyValue[] = [];
		const el = await render(
			policy({
				key: 'models.work_tiers',
				category: 'models_tools',
				control: 'map',
				value: { small: 'a/b', medium: 'c/d', large: 'e/f' }
			}),
			(v) => seen.push(v)
		);
		const input = el.querySelectorAll<HTMLInputElement>('.map-value')[1]!;
		input.value = 'x/y';
		input.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(seen).toEqual([{ small: 'a/b', medium: 'x/y', large: 'e/f' }]);
	});
});

describe('a RETIRED rail offers no control at all', () => {
	// ⛔ THE DEFECT. `data.eu_only` promised "Runs and data stay within EU-region infrastructure"
	// while nothing in the platform ever checked a region — `sandboxes.region` is written and never
	// compared, and the seeded provider endpoints are public-internet hosts outside the EU. The claim
	// is withdrawn. Its `policies` row still holds `value: true`, so anything that renders the toggle
	// puts a switch reading ON beside the words "EU-only execution" on a compliance screen, which is
	// the assertion being withdrawn — greying it out is not enough, it must not be there.
	it('renders the marker instead of a toggle, and offers nothing to click', async () => {
		const seen: PolicyValue[] = [];
		const el = await render(
			policy({ key: 'data.eu_only', control: 'toggle', value: true, enforcement: 'retired' }),
			(v) => seen.push(v)
		);
		expect(el.querySelector('.policy-name')!.textContent).toBe('M_LABEL_data_eu_only');
		expect(el.querySelector('.policy-desc')!.textContent).toBe('M_DESC_data_eu_only');
		expect(el.querySelector('.retired-mark')!.textContent).toBe('M_NOT_ENFORCED');
		// The control side is empty of every widget this component can build.
		const control = el.querySelector('.policy-control')!;
		expect(control.querySelector('button')).toBeNull();
		expect(control.querySelector('input')).toBeNull();
		expect(control.querySelector('select')).toBeNull();
		// …and with no widget there is nothing that can emit a write.
		expect(seen).toEqual([]);
	});

	it('the SAME rail with an enforced classification still renders its control', async () => {
		// The non-vacuity half: the assertions above must fail because the rail is RETIRED, not
		// because this fixture never produces a toggle in the first place.
		const el = await render(
			policy({ key: 'data.eu_only', control: 'toggle', value: true, enforcement: 'enforced' })
		);
		expect(el.querySelector('.retired-mark')).toBeNull();
		expect(el.querySelector('.policy-control button')).not.toBeNull();
	});

	it('a payload with NO enforcement field renders the control — the rolling-deploy path', async () => {
		// A pre-change backend sends no `enforcement` at all. Hiding every control on that payload
		// would make /governance read-only for the length of every deploy.
		const el = await render(policy({ key: 'data.eu_only', control: 'toggle', value: true }));
		expect(el.querySelector('.retired-mark')).toBeNull();
		expect(el.querySelector('.policy-control button')).not.toBeNull();
	});

	it('⛔ an APPLIED rail gets its FULL control and NO mark — the row needs no new affordance', async () => {
		// ⛔ THE DECISION THIS PINS. `applied` means "an edit changes the next run or call, but
		// nothing is refused for it". The tempting move is to mark such a rail on the row the way
		// `retired` is marked — and it is the wrong one twice over: it would suggest the rail is
		// read-only (it is not; `routes/governance.ts` keys its 422 on retirement alone, and an
		// applied edit really does change behaviour), and `governance_enforcement_retired_mark` reads
		// "Not enforced", which is true of an applied rail and yet says the OPPOSITE of what an
		// applied rail does. The band heading and its note carry the meaning; the row stays a normal
		// editable row. If a future change adds a mark here, this is the test that must be argued
		// with.
		const seen: PolicyValue[] = [];
		const el = await render(
			policy({
				key: 'promotion.staging_canary_pct',
				control: 'number',
				value: 5,
				unit: '%',
				enforcement: 'applied'
			}),
			(v) => seen.push(v)
		);
		expect(el.querySelector('.retired-mark')).toBeNull();
		const control = el.querySelector('.policy-control')!;
		expect(control.querySelector('input')).not.toBeNull();
		// It is genuinely writable, not merely visible.
		const input = control.querySelector<HTMLInputElement>('input')!;
		input.value = '9';
		input.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(seen).toEqual([9]);
	});
});
