// src/host/budget-service.ts — what is LEFT of the OpenRouter welcome budget after its retirement.
//
// ⛔ RETIRED (migration 0099). A super_admin used to grant a new tenant a dollar budget as a
// dedicated, lifetime-capped OpenRouter key written into the tenant's LLM settings, polled every
// 15 minutes, with 75/90/100 % alerts. That whole mechanism is gone:
//   • a tenant's LLM money is now its billing-service MONEY budget (`/api/budget/money/*`), shown on
//     `(tenant)/usage` from billing's own status read — CP keeps no copy;
//   • `local-llm` tenants run on the platform's inference-router with their own licence
//     (services/tenant-inference.ts); `byo` tenants pay their provider directly;
//   • the per-user daily/weekly caps (host/llm-broker.ts) are unchanged.
//
// One thing remains, and it is about rows that already exist: the shape of a `budget.threshold`
// NOTIFICATION, because old rows are still in people's bells and the browser renders them in the
// reader's language from `data` (frontend notification-label.ts + its backend-contract test read the
// declarations below).
//
// ⛔ The OpenRouter management client (`services/openrouter-admin.ts`, OPENROUTER_MANAGEMENT_KEY)
// and `revokeLegacyGrantKeys` (the offboard-time grant-key disable) are DELETED too (owner rule
// 2026-10-13: CP holds no provider token). Prod held no stored grant key when they went
// (`tenant_llm_settings.api_key_encrypted IS NULL` on every row). To bring the welcome budget back
// see docs/runbooks/openrouter-welcome-budget.md.

/** The percentages the retired scheduler alerted at, ascending — still the rungs a legacy row holds. */
export const ALERT_THRESHOLDS = [75, 90, 100] as const;
export type AlertThreshold = (typeof ALERT_THRESHOLDS)[number];

/** The notification kind every legacy budget alert row carries. No code writes new ones. */
export const LEGACY_BUDGET_ALERT_KIND = 'budget.threshold';

/**
 * The machine fields of a legacy `budget.threshold` notification (`notifications.data`, 0066), from
 * which the reader's browser composes the sentence in its own language.
 *
 * ⚠️ A `type` ALIAS, NOT AN `interface` — kept as it was written so the frontend contract test's
 * parser and every legacy row keep agreeing on the four field names.
 */
export type BudgetAlertData = {
  threshold: number;
  tenantName: string;
  limitUsd: number;
  /** ⚠️ Legally `0` at the 100 rung. Check presence with `== null`, never truthiness. */
  remainingUsd: number;
};
