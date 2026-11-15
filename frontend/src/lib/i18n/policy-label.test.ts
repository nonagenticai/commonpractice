// src/lib/i18n/policy-label.test.ts — the governance vocabulary resolves from the KEY, never
// from the English strings the backend still sends alongside it.
//
// The messages module is mocked so each key returns its own name: the assertions are about WHICH
// MESSAGE is selected, not about English copy a translator may legitimately reword. Same
// technique as i18n/stage-label.test.ts and types/block-status-label.test.ts.
//
// The COMPLETENESS of the switches — that every policy the backend can ship has a case — is not
// asserted here (a hand-copied list would only restate the switch). It is asserted against the
// backend source itself in `policy-label.backend-contract.test.ts`.
import { describe, it, expect, vi } from 'vitest';

/** Every message this module can reach, each returning its own name. */
vi.mock('$lib/paraglide/messages', () => {
	const KEYS = [
		'policy_group_data_isolation',
		'policy_group_spend_quota',
		'policy_group_models_tools',
		'policy_group_promotion',
		'policy_option_validation_warn',
		'policy_option_validation_block',
		'policy_option_idle_3_days',
		'policy_option_idle_7_days',
		'policy_option_idle_14_days',
		'policy_unit_calls_per_day',
		'policy_tier_small',
		'policy_tier_medium',
		'policy_tier_large'
	];
	const POLICY_KEYS = [
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
	];
	const mod: Record<string, () => string> = {};
	for (const k of KEYS) mod[k] = () => `M_${k}`;
	for (const k of POLICY_KEYS) {
		mod[`policy_label_${k}`] = () => `M_LABEL_${k}`;
		mod[`policy_desc_${k}`] = () => `M_DESC_${k}`;
	}
	return mod;
});

const {
	policyLabel,
	policyDescription,
	policyGroupTitle,
	policyOptionLabel,
	policyUnitLabel,
	policyMapKeyLabel
} = await import('./policy-label');

/** The `policies.key` values, verbatim, as they arrive on the wire (dots and all). */
const WIRE_KEYS = [
	'data.block_prod_data',
	'data.pii_scrubbing',
	'data.cross_sandbox_isolation',
	'data.eu_only',
	'data.validation_mode',
	'spend.daily_llm_cap',
	'spend.weekly_spend_ceiling',
	'spend.auto_suspend_idle',
	'models.pricing',
	'models.allowlist',
	'models.work_tiers',
	'models.external_http',
	'models.code_exec_outside_blocks',
	'data.egress_allowlist',
	'promotion.mandatory_review',
	'promotion.required_reviewers',
	'promotion.staging_canary_pct',
	'block_publish.require_passing_tests'
];

describe('policyLabel', () => {
	it('resolves the dotted wire key to that policy’s own message', () => {
		// The key is `data.block_prod_data` on the wire and `data_block_prod_data` in the catalog;
		// a mis-transcribed dot/underscore here is the single most likely typo in this file.
		expect(policyLabel('data.block_prod_data')).toBe('M_LABEL_data_block_prod_data');
		expect(policyLabel('spend.weekly_spend_ceiling')).toBe('M_LABEL_spend_weekly_spend_ceiling');
		expect(policyLabel('block_publish.require_passing_tests')).toBe(
			'M_LABEL_block_publish_require_passing_tests'
		);
	});

	it('maps no two policies onto the same message', () => {
		// A copy-paste that leaves two cases returning the same message renders two rails with the
		// same name — visually plausible and completely wrong.
		const labels = WIRE_KEYS.map(policyLabel);
		expect(new Set(labels).size).toBe(WIRE_KEYS.length);
	});

	it('resolves every rail the screen can show, including the two added by migration', () => {
		// `models.work_tiers` (migration 0045) and `models.pricing` (0053) are NOT in the seeder's
		// POLICIES[] array — they are INSERTed by migrations — and are the two easiest to miss.
		const unresolved = WIRE_KEYS.filter((k) => policyLabel(k) === k);
		expect(unresolved).toEqual([]);
		expect(policyLabel('models.work_tiers')).toBe('M_LABEL_models_work_tiers');
		expect(policyLabel('models.pricing')).toBe('M_LABEL_models_pricing');
	});

	it('returns the RAW KEY for an unknown policy — never an English sentence', () => {
		// The default branch exists so a policy added server-side ships an ugly identifier rather
		// than a blank row. What it must never do is reach for the backend's `label` field.
		expect(policyLabel('data.some_future_rail')).toBe('data.some_future_rail');
		expect(policyLabel('')).toBe('');
	});
});

describe('policyDescription', () => {
	it('resolves every rail to its own paragraph', () => {
		expect(policyDescription('data.eu_only')).toBe('M_DESC_data_eu_only');
		expect(policyDescription('models.pricing')).toBe('M_DESC_models_pricing');
		const descs = WIRE_KEYS.map(policyDescription);
		expect(new Set(descs).size).toBe(WIRE_KEYS.length);
	});

	it('returns EMPTY for an unknown policy, not the key', () => {
		// Deliberately different from `policyLabel`: a description is a sentence, and echoing
		// `spend.daily_llm_cap` where a sentence belongs is worse than an empty line. What matters
		// for the defect is only that it is never English prose.
		expect(policyDescription('data.some_future_rail')).toBe('');
		expect(policyDescription('')).toBe('');
	});
});

describe('policyGroupTitle', () => {
	it('resolves all four `policies.category` values', () => {
		expect(policyGroupTitle('data_isolation')).toBe('M_policy_group_data_isolation');
		expect(policyGroupTitle('spend_quota')).toBe('M_policy_group_spend_quota');
		expect(policyGroupTitle('models_tools')).toBe('M_policy_group_models_tools');
		expect(policyGroupTitle('promotion')).toBe('M_policy_group_promotion');
	});

	it('returns the RAW CATEGORY for an unknown group', () => {
		expect(policyGroupTitle('supply_chain')).toBe('supply_chain');
	});
});

describe('policyOptionLabel', () => {
	it('localizes the two validation modes', () => {
		expect(policyOptionLabel('data.validation_mode', 'warn')).toBe('M_policy_option_validation_warn');
		expect(policyOptionLabel('data.validation_mode', 'block')).toBe(
			'M_policy_option_validation_block'
		);
	});

	it('localizes the three idle windows', () => {
		expect(policyOptionLabel('spend.auto_suspend_idle', '3 days')).toBe('M_policy_option_idle_3_days');
		expect(policyOptionLabel('spend.auto_suspend_idle', '7 days')).toBe('M_policy_option_idle_7_days');
		expect(policyOptionLabel('spend.auto_suspend_idle', '14 days')).toBe(
			'M_policy_option_idle_14_days'
		);
	});

	it('dispatches on the POLICY, so the same word under a different rail is untouched', () => {
		// `block` is not globally unique — it reads "refuse the run" only under
		// `data.validation_mode`. A switch on the value alone would silently translate a future
		// rail whose `block` means a building block.
		expect(policyOptionLabel('some.other_rail', 'block')).toBe('block');
		expect(policyOptionLabel('spend.auto_suspend_idle', 'block')).toBe('block');
	});

	it('leaves the reviewer counts alone — digits need no catalog key', () => {
		for (const n of ['1', '2', '3']) {
			expect(policyOptionLabel('promotion.required_reviewers', n)).toBe(n);
		}
	});

	it('returns the RAW VALUE for an option added server-side', () => {
		// This is the branch that keeps a policy EDITABLE when the backend gains an option: the
		// display falls back to the wire value, and the value attribute (which this function never
		// touches) still round-trips.
		expect(policyOptionLabel('spend.auto_suspend_idle', '30 days')).toBe('30 days');
		expect(policyOptionLabel('data.validation_mode', 'quarantine')).toBe('quarantine');
	});
});

describe('policyUnitLabel', () => {
	it('localizes the one unit that is a word', () => {
		expect(policyUnitLabel('calls/day')).toBe('M_policy_unit_calls_per_day');
	});

	it('passes the CURRENCY and PERCENT symbols through untouched', () => {
		// `€` and `%` are written identically in all eight locales; giving them catalog keys would
		// add two strings eight translators can only get wrong.
		expect(policyUnitLabel('€')).toBe('€');
		expect(policyUnitLabel('%')).toBe('%');
	});

	it('renders nothing for a rail with no unit', () => {
		// `Policy.unit` is null on every toggle/select/list/map rail.
		expect(policyUnitLabel(null)).toBe('');
		expect(policyUnitLabel(undefined)).toBe('');
	});
});

describe('policyMapKeyLabel', () => {
	it('localizes the three work tiers', () => {
		expect(policyMapKeyLabel('models.work_tiers', 'small')).toBe('M_policy_tier_small');
		expect(policyMapKeyLabel('models.work_tiers', 'medium')).toBe('M_policy_tier_medium');
		expect(policyMapKeyLabel('models.work_tiers', 'large')).toBe('M_policy_tier_large');
	});

	it('leaves MODEL IDENTIFIERS byte-for-byte alone', () => {
		// `models.pricing` is the other `map` rail and its keys are provider/model ids. An operator
		// matches these against a vendor price sheet; a "translated" identifier is unusable, and
		// `local/*` in particular must keep its glob.
		for (const id of ['anthropic/claude-opus-4-8', 'local/*', 'openrouter/z-ai/glm-5.2']) {
			expect(policyMapKeyLabel('models.pricing', id)).toBe(id);
		}
	});

	it('does not translate a tier word appearing under another rail', () => {
		expect(policyMapKeyLabel('models.pricing', 'small')).toBe('small');
	});

	it('returns the RAW KEY for a tier added server-side', () => {
		expect(policyMapKeyLabel('models.work_tiers', 'xlarge')).toBe('xlarge');
	});
});
