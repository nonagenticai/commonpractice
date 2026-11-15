// src/lib/i18n/policy-label.ts — the ONE place a governance policy becomes words a reader can
// read: its name, its explanation, its group heading, its dropdown choices, its unit and its
// map sub-labels.
//
// ⛔ THE DEFECT. /governance rendered a Dutch frame around an entirely English body. The page
// head, the "Nalevingsstatus" card and the "Recente wijzigingen" card were localized; everything
// between them came off the wire as English written by the seeder:
//   • PolicyRow.svelte      {policy.label} / {policy.description}   → 18 names + 18 paragraphs
//   • PolicyRow.svelte      {policy.unit}                           → "calls/day"
//   • PolicyRow.svelte      <option value={opt}>{opt}</option>      → "warn · block · 7 days"
//   • PolicyRow.svelte      {key} of a `map` control                → "small · medium · large"
//   • governance/+page.svelte {group.title}                         → 4 group headings
//   • governance/+page.svelte {c.label} of a recent change          → the English policy name
// Every one of those strings lives in `backend/src/db/seed-platform.ts` POLICIES[] or in a
// migration's `INSERT INTO policies`, i.e. in a DATABASE ROW written once at seed time by a
// process that has no idea who will read it. It can never be Dutch. The wire carries the KEY;
// the browser owns the words.
//
// ⛔ NOT `content_translations`. That pipeline exists for TENANT-AUTHORED content the platform
// cannot know at build time (challenges, solutions, block docs) and it costs an LLM round trip
// plus a join per read. Policy copy is shipped product text: identical for every tenant, fixed
// at build time, and belongs in the message catalogs like every other product string.
//
// WHY AN EXHAUSTIVE SWITCH AND NOT A LOOKUP TABLE. Paraglide compiles ONE function per message
// key and tree-shakes on the import graph, so `m[`policy_label_${key}`]()` does not resolve —
// there is no runtime object to index. This is the same reasoning, and the same shape, as
// `stage-label.ts` and `run-status-label.ts`; see either header.
//
// ⛔ NO `?? policy.label` / `?? group.title` FALLBACK AT ANY CALL SITE. Those fields are still on
// the wire on purpose (an OLD frontend against a NEW backend keeps rendering, and they are
// deleted one deploy later) and reading them "just in case" resurrects the exact English this
// file removes, on the exact row being fixed.
import * as m from '$lib/paraglide/messages';

/**
 * The reader's name for a policy rail.
 *
 * Takes `string` because `Policy.key` mirrors a `policies.key` database column the frontend does
 * not own. An unrecognised key returns the RAW KEY: a policy added server-side ships an ugly
 * identifier rather than a blank row, and never an English sentence. `policy-label.backend-
 * contract.test.ts` fails the build when the backend gains a policy this switch does not know,
 * so the default branch is a safety net, not the plan.
 */
export function policyLabel(key: string): string {
	switch (key) {
		// ---- data & isolation ----
		case 'data.block_prod_data':
			return m.policy_label_data_block_prod_data();
		case 'data.pii_scrubbing':
			return m.policy_label_data_pii_scrubbing();
		case 'data.cross_sandbox_isolation':
			return m.policy_label_data_cross_sandbox_isolation();
		case 'data.eu_only':
			return m.policy_label_data_eu_only();
		case 'data.validation_mode':
			return m.policy_label_data_validation_mode();
		// ---- spend & quotas ----
		case 'spend.daily_llm_cap':
			return m.policy_label_spend_daily_llm_cap();
		case 'spend.weekly_spend_ceiling':
			return m.policy_label_spend_weekly_spend_ceiling();
		case 'spend.auto_suspend_idle':
			return m.policy_label_spend_auto_suspend_idle();
		case 'models.pricing':
			return m.policy_label_models_pricing();
		// ---- models & tools ----
		case 'models.allowlist':
			return m.policy_label_models_allowlist();
		case 'models.work_tiers':
			return m.policy_label_models_work_tiers();
		case 'models.external_http':
			return m.policy_label_models_external_http();
		case 'models.code_exec_outside_blocks':
			return m.policy_label_models_code_exec_outside_blocks();
		// `data.` prefix, `models_tools` category — the key predates the regrouping. Left alone:
		// `policies.key` is an FK target (policy_changes.policy_key) and renaming it would orphan
		// every recorded change.
		case 'data.egress_allowlist':
			return m.policy_label_data_egress_allowlist();
		// ---- promotion to production ----
		case 'promotion.mandatory_review':
			return m.policy_label_promotion_mandatory_review();
		case 'promotion.required_reviewers':
			return m.policy_label_promotion_required_reviewers();
		case 'promotion.staging_canary_pct':
			return m.policy_label_promotion_staging_canary_pct();
		case 'block_publish.require_passing_tests':
			return m.policy_label_block_publish_require_passing_tests();
		// ---- voting cycle (0107) ----
		case 'cycle.cadence':
			return m.policy_label_cycle_cadence();
		default:
			return key;
	}
}

/**
 * The reader's explanation of a policy rail — the grey paragraph under the name.
 *
 * An unrecognised key returns the EMPTY STRING, not the key: a description is a full sentence,
 * and echoing `spend.daily_llm_cap` where a sentence belongs is worse than showing nothing. The
 * name above it still identifies the row.
 */
export function policyDescription(key: string): string {
	switch (key) {
		// ---- data & isolation ----
		case 'data.block_prod_data':
			return m.policy_desc_data_block_prod_data();
		case 'data.pii_scrubbing':
			return m.policy_desc_data_pii_scrubbing();
		case 'data.cross_sandbox_isolation':
			return m.policy_desc_data_cross_sandbox_isolation();
		case 'data.eu_only':
			return m.policy_desc_data_eu_only();
		case 'data.validation_mode':
			return m.policy_desc_data_validation_mode();
		// ---- spend & quotas ----
		case 'spend.daily_llm_cap':
			return m.policy_desc_spend_daily_llm_cap();
		case 'spend.weekly_spend_ceiling':
			return m.policy_desc_spend_weekly_spend_ceiling();
		case 'spend.auto_suspend_idle':
			return m.policy_desc_spend_auto_suspend_idle();
		case 'models.pricing':
			return m.policy_desc_models_pricing();
		// ---- models & tools ----
		case 'models.allowlist':
			return m.policy_desc_models_allowlist();
		case 'models.work_tiers':
			return m.policy_desc_models_work_tiers();
		case 'models.external_http':
			return m.policy_desc_models_external_http();
		case 'models.code_exec_outside_blocks':
			return m.policy_desc_models_code_exec_outside_blocks();
		case 'data.egress_allowlist':
			return m.policy_desc_data_egress_allowlist();
		// ---- promotion to production ----
		case 'promotion.mandatory_review':
			return m.policy_desc_promotion_mandatory_review();
		case 'promotion.required_reviewers':
			return m.policy_desc_promotion_required_reviewers();
		case 'promotion.staging_canary_pct':
			return m.policy_desc_promotion_staging_canary_pct();
		case 'block_publish.require_passing_tests':
			return m.policy_desc_block_publish_require_passing_tests();
		case 'cycle.cadence':
			return m.policy_desc_cycle_cadence();
		default:
			return '';
	}
}

/**
 * The heading above a group of rails, from `PolicyGroup.category` — the `policies.category`
 * column, which the DTO has always carried alongside the English `title`.
 */
export function policyGroupTitle(category: string): string {
	switch (category) {
		case 'data_isolation':
			return m.policy_group_data_isolation();
		case 'spend_quota':
			return m.policy_group_spend_quota();
		case 'models_tools':
			return m.policy_group_models_tools();
		case 'promotion':
			return m.policy_group_promotion();
		case 'marketplace':
			return m.policy_group_marketplace();
		default:
			return category;
	}
}

/**
 * The DISPLAY TEXT of one `<option>` of a `select` rail.
 *
 * ⚠️ THE VALUE ATTRIBUTE MUST NOT CHANGE. `warn` / `block` / `7 days` / `2` are WIRE VALUES:
 * the option's `value` is PATCHed straight back to /api/governance, where `validateValue`
 * checks it against `policies.options` — a localized `value` fails that check with 422 and
 * every policy edit on the screen breaks. This function localizes the label a human reads and
 * nothing else. See PolicyRow.svelte, where `value={opt}` stays untouched.
 *
 * Dispatch is on (policyKey, value), not on value alone, because option vocabularies are
 * per-policy and the words are not globally unique — `block` here means "refuse the run", and a
 * future rail could legitimately use `block` to mean a building block.
 *
 * An unrecognised pair returns the RAW VALUE, which is exactly what the screen showed before
 * this change. `promotion.required_reviewers` has no cases on purpose: its options are the
 * digits 1/2/3, which are already the same in all eight locales.
 */
export function policyOptionLabel(policyKey: string, value: string): string {
	switch (policyKey) {
		case 'data.validation_mode':
			switch (value) {
				case 'warn':
					return m.policy_option_validation_warn();
				case 'block':
					return m.policy_option_validation_block();
				default:
					return value;
			}
		case 'spend.auto_suspend_idle':
			switch (value) {
				case '3 days':
					return m.policy_option_idle_3_days();
				case '7 days':
					return m.policy_option_idle_7_days();
				case '14 days':
					return m.policy_option_idle_14_days();
				default:
					return value;
			}
		case 'cycle.cadence':
			switch (value) {
				case 'off':
					return m.policy_option_cadence_off();
				case 'week':
					return m.policy_option_cadence_week();
				case 'month':
					return m.policy_option_cadence_month();
				case 'quarter':
					return m.policy_option_cadence_quarter();
				case 'year':
					return m.policy_option_cadence_year();
				default:
					return value;
			}
		default:
			return value;
	}
}

/**
 * The unit shown beside a `number` rail's input.
 *
 * Only ONE of the three seeded units is a word: `calls/day`. `€` and `%` are SYMBOLS — they are
 * written the same in all eight locales (Dutch, German, French, Spanish and Polish all use `€`
 * and `%`; Arabic and Hebrew render them from the same code points and the surrounding `dir`
 * handles placement), so routing them through the catalog would buy nothing and would add two
 * keys that eight translators can only get wrong. They fall through to the default branch, which
 * returns the unit verbatim — as does any unit a future rail introduces.
 *
 * Takes `string | null` because `Policy.unit` is nullable on the wire (most rails have no unit).
 */
export function policyUnitLabel(unit: string | null | undefined): string {
	switch (unit) {
		case 'calls/day':
			return m.policy_unit_calls_per_day();
		default:
			return unit ?? '';
	}
}

/**
 * The sub-label of one field of a `map` rail — the small grey word left of the input.
 *
 * ⚠️ Two rails use the `map` control and they are NOT the same kind of key:
 *   • `models.work_tiers` keys are the words small / medium / large — a fixed, human-facing
 *     vocabulary, and the only English left on the screen once the labels are localized.
 *   • `models.pricing` keys are MODEL IDENTIFIERS (`anthropic/claude-opus-4-8`, `local/*`). They
 *     are not words in any language and must render byte-for-byte, or an operator cannot match a
 *     row against a vendor's price sheet.
 * Dispatching on the policy key rather than on the map key is what makes that distinction
 * structural: `models.pricing` has no cases, so every identifier falls straight through.
 *
 * Like the option labels, this is DISPLAY ONLY — `commitMapEntry` sends the real key back.
 */
export function policyMapKeyLabel(policyKey: string, mapKey: string): string {
	switch (policyKey) {
		case 'models.work_tiers':
			switch (mapKey) {
				case 'small':
					return m.policy_tier_small();
				case 'medium':
					return m.policy_tier_medium();
				case 'large':
					return m.policy_tier_large();
				default:
					return mapKey;
			}
		default:
			return mapKey;
	}
}
