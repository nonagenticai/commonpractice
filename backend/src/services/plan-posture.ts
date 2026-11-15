// src/services/plan-posture.ts — the two commercial plans Common Practice sells, and the BYO posture
// each one implies.
//
//   local-llm — the platform's in-cluster inference-router, paid by the platform and metered per
//               tenant on the tenant's own `inference-router` licence (services/tenant-inference.ts).
//               Posture `local_allowed`: the platform LLM is used; an own key stays optional.
//   byo       — the tenant brings its own provider key and pays the provider; the platform invoices
//               the markup. Posture `byo_required`: there is NO platform path, a keyless call fails
//               closed (services/byo-posture.ts).
//
// Any other plan code (the retired `standard` / `tenant-pooled`, or one created later on the Plans
// page) implies nothing: its posture is whatever the super_admin sets.
import type { ByoMode } from './licenses-admin';

export const LOCAL_LLM_PLAN = 'local-llm';
export const BYO_PLAN = 'byo';

/**
 * The plan a workspace created from Platform → Tenants gets when the super_admin picks none: the
 * platform's local model, so a new (early-access) organisation can use the product on day one
 * instead of having no LLM until it adds its own key.
 *
 * ⛔ DELIBERATELY NOT `LICENSE_PLAN_CODE`. That env is also the fallback for every EXISTING row
 * whose `plan_code` is NULL (`coalesce(plan_code, LICENSE_PLAN_CODE)` in routes/admin.ts,
 * platform-plans.ts, license-provisioning.ts), so flipping it would silently re-plan tenants that
 * already exist. This constant only applies at create, and the create writes it to `plan_code`.
 */
export const NEW_TENANT_PLAN = LOCAL_LLM_PLAN;

/** The posture a plan FIXES, or null when the plan leaves it to the super_admin. */
export function planByoMode(planCode: string | null | undefined): ByoMode | null {
  if (planCode === LOCAL_LLM_PLAN) return 'local_allowed';
  if (planCode === BYO_PLAN) return 'byo_required';
  return null;
}

/**
 * The plan for a NEW workspace whose creator chose no plan: NEW_TENANT_PLAN, unless the creator
 * stated a posture that plan would contradict — then undefined (= the deployment default, as before).
 * Used by the signup-approval path, whose form chooses a posture, never a plan.
 */
export function newTenantPlanFor(byoMode: ByoMode | undefined): string | undefined {
  return byoMode === undefined || byoMode === planByoMode(NEW_TENANT_PLAN) ? NEW_TENANT_PLAN : undefined;
}
