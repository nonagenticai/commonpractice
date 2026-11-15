// src/services/plan-migration.ts — move every live tenant onto the two plans CP sells (Part B):
//   local-llm — the platform's test/demo tenants below;
//   byo       — everyone else;
// then retire `standard` and `tenant-pooled`.
//
// It REUSES the services the super_admin screens use — the Plans catalogue (`createPlan` /
// `updatePlan`), the licence editor's `changeTenantLicence`, the BYO posture write, and
// `ensureTenantInference` — so a migrated tenant is indistinguishable from one edited by hand.
//
// TWO PHASES, AND THE FIRST WRITES NOTHING. `planTenantMigration` only READS (CP's tenants table and
// licences' plan list) and returns the steps; `applyTenantMigration` performs them. The script
// (scripts/migrate-tenant-plans.ts) is a dry run unless `--apply` is passed.
//
// ORDER PER local-llm TENANT: the inference credential FIRST, then the plan. The moment the plan says
// local-llm, keyless calls must carry the tenant's own router token (or fail closed without one).
import { and, eq, isNull } from 'drizzle-orm';
import { config } from '../config';
import { db, tenants } from '../db/client';
import { recordAudit } from '../host/audit-service';
import { log } from '../host/logger';
import { adminMethod, licensesAdmin, type ByoMode, type LicencesPlan } from './licenses-admin';
import { readTenantByoMode } from './tenant-service';
import { changeTenantLicence, isSystemTenant } from './license-provisioning';
import { ensureTenantInference } from './tenant-inference';
import { BYO_PLAN, LOCAL_LLM_PLAN, planByoMode } from './plan-posture';

/** The owner's test/demo tenants that run on the platform's local LLM (decision 2026-10-13). */
export const LOCAL_LLM_TENANTS: Readonly<Record<string, string>> = {
  '0195f48b-d000-7000-8000-000000000099': 'fr-test',
  '0195f48b-d000-7000-8000-000000000003': 'george-dev',
  '00000000-0000-0000-0000-000000000001': 'CP Demo',
  '019fe708-424a-7a31-bce8-da19020dc62b': 'Nonagentic',
};
/** Tenants that leave CP instead of migrating — offboarded through Platform → Tenants (it has members,
 *  and the route revokes their seats, inference licence and OpenRouter grant key). */
export const OFFBOARD_TENANTS: Readonly<Record<string, string>> = {
  '01a0ae64-3703-76a6-8e05-9a4826428d32': 'raisemytickets',
};
export const RETIRED_PLANS = ['standard', 'tenant-pooled'] as const;

export type MigrationStep =
  | { kind: 'create_plan'; code: string; copyLimitsFrom: string | null }
  | { kind: 'provision_inference'; tenantId: string; name: string }
  | { kind: 'change_plan'; tenantId: string; name: string; from: string | null; to: string }
  | { kind: 'set_posture'; tenantId: string; name: string; from: ByoMode | null; to: ByoMode }
  | { kind: 'retire_plan'; code: string; planId: string }
  /** A plan that must NOT be retired yet: it is the configured default (`LICENSE_PLAN_CODE`). */
  | { kind: 'retire_blocked'; code: string; reason: string }
  | { kind: 'skip'; tenantId: string; name: string; reason: string };

export interface StepResult {
  step: MigrationStep;
  ok: boolean;
  detail?: string;
}

const lc = (s: string) => s.toLowerCase();
const LOCAL = new Set(Object.keys(LOCAL_LLM_TENANTS).map(lc));
const OFFBOARD = new Set(Object.keys(OFFBOARD_TENANTS).map(lc));

/** READ-ONLY. The steps that would bring the estate onto local-llm / byo. */
export async function planTenantMigration(): Promise<MigrationStep[]> {
  const steps: MigrationStep[] = [];
  const plans: LicencesPlan[] = await adminMethod(licensesAdmin(), 'listPlans')({ includeRevoked: true });
  const byCode = new Map(plans.map((p) => [p.code, p]));
  const template = byCode.get(config.license.planCode) ?? byCode.get('standard') ?? null;
  for (const code of [LOCAL_LLM_PLAN, BYO_PLAN]) {
    const p = byCode.get(code);
    if (!p || p.revoked) steps.push({ kind: 'create_plan', code, copyLimitsFrom: template?.code ?? null });
  }

  const rows = await db
    .select({
      id: tenants.id,
      name: tenants.name,
      plan: tenants.plan_code,
      inference: tenants.inference_token_encrypted,
    })
    .from(tenants)
    .where(and(isNull(tenants.offboarded_at), eq(tenants.status, 'active')))
    .orderBy(tenants.created_at);
  for (const t of rows) {
    if (isSystemTenant(t.id)) {
      steps.push({ kind: 'skip', tenantId: t.id, name: t.name, reason: 'system_tenant' });
      continue;
    }
    if (OFFBOARD.has(lc(t.id))) {
      steps.push({ kind: 'skip', tenantId: t.id, name: t.name, reason: 'offboard_via_platform_tenants' });
      continue;
    }
    const to = LOCAL.has(lc(t.id)) ? LOCAL_LLM_PLAN : BYO_PLAN;
    const from = t.plan ?? config.license.planCode;
    if (to === LOCAL_LLM_PLAN && !t.inference) {
      steps.push({ kind: 'provision_inference', tenantId: t.id, name: t.name });
    }
    if (from !== to) steps.push({ kind: 'change_plan', tenantId: t.id, name: t.name, from, to });
    // ⛔ THE POSTURE IS PLANNED FROM ITS OWN LIVE STATE, NOT FROM "THE PLAN CHANGED". A run whose plan
    // change landed and whose posture write failed leaves from == to; keyed on the plan alone the
    // re-run planned nothing, the posture was never set, and `standard` was retired anyway. So the
    // live licences posture is read and compared with the plan's — unknown (null) counts as wrong.
    const want = planByoMode(to)!;
    const live = await readTenantByoMode(t.id);
    if (live !== want) steps.push({ kind: 'set_posture', tenantId: t.id, name: t.name, from: live, to: want });
  }

  for (const code of RETIRED_PLANS) {
    const p = byCode.get(code);
    if (!p || p.revoked) continue;
    // ⛔ NEVER RETIRE THE CONFIGURED DEFAULT. `createTenant` mints every tenant created without an
    // explicit plan on `LICENSE_PLAN_CODE`; retiring it would land them on a retired plan (and
    // createTenant now refuses that outright). The operator changes the default first.
    if (code === config.license.planCode) {
      steps.push({
        kind: 'retire_blocked',
        code,
        reason:
          `'${code}' is the configured default plan (LICENSE_PLAN_CODE). Set LICENSE_PLAN_CODE=${BYO_PLAN} ` +
          `in the commonpractice deployment, roll it, then re-run to retire '${code}'.`,
      });
      continue;
    }
    steps.push({ kind: 'retire_plan', code, planId: p.id });
  }
  return steps;
}

/**
 * Perform the steps, in order. A failed tenant step is reported and the rest continue; plans are
 * retired only when EVERY tenant step succeeded (a tenant left on `standard` must stay assignable
 * back to it while someone looks).
 */
export async function applyTenantMigration(
  steps: MigrationStep[],
  operator: string,
): Promise<StepResult[]> {
  const client = licensesAdmin();
  const results: StepResult[] = [];
  const failedTenants = new Set<string>();
  let template: LicencesPlan | null = null;
  const plans = await adminMethod(client, 'listPlans')({ includeRevoked: true });

  for (const step of steps) {
    try {
      switch (step.kind) {
        case 'skip':
          results.push({ step, ok: true, detail: step.reason });
          break;
        case 'create_plan': {
          template ??= plans.find((p) => p.code === step.copyLimitsFrom) ?? null;
          const created = await adminMethod(client, 'createPlan')({
            code: step.code,
            name: step.code === LOCAL_LLM_PLAN ? 'Local LLM' : 'Bring your own key',
            description:
              step.code === LOCAL_LLM_PLAN
                ? "Runs on the platform's in-cluster LLM, metered per workspace."
                : 'The workspace brings its own provider key and pays the provider; the platform invoices the markup.',
            durationDays: null,
            rateLimitRpm: template?.rateLimitRpm ?? null,
            rateLimitBurst: template?.rateLimitBurst ?? null,
            quotaMonthly: template?.quotaMonthly ?? null,
            tokenBudgetMonthly: template?.tokenBudgetMonthly ?? null,
          });
          results.push({ step, ok: true, detail: created.id });
          break;
        }
        case 'provision_inference': {
          const out = await ensureTenantInference(step.tenantId);
          results.push({ step, ok: true, detail: out.status });
          if (out.status === 'provisioned') {
            await recordAudit({
              actorId: null,
              action: 'tenant.inference_provision',
              category: 'tenant',
              targetType: 'tenant',
              targetId: step.tenantId,
              tenantId: step.tenantId,
              result: out.licenceId,
              resultTone: 'ok',
              metadata: { operator, source: 'plan-migration', licenceId: out.licenceId },
            });
          }
          break;
        }
        case 'change_plan': {
          if (failedTenants.has(step.tenantId)) {
            results.push({ step, ok: false, detail: 'skipped: an earlier step for this tenant failed' });
            break;
          }
          const licence = await changeTenantLicence(
            step.tenantId,
            { planCode: step.to },
            { actorId: operator },
          );
          await recordAudit({
            actorId: null,
            action: 'tenant.licence_change',
            category: 'tenant',
            targetType: 'tenant',
            targetId: step.tenantId,
            tenantId: step.tenantId,
            result: step.to,
            resultTone: licence.memberFailures.length > 0 || licence.oldLicenceRevoked === false ? 'warn' : 'ok',
            metadata: {
              operator,
              source: 'plan-migration',
              change: 'licence',
              before: licence.before,
              after: licence.after,
              oldLicenceRevoked: licence.oldLicenceRevoked,
              memberReissueFailed: licence.memberFailures.length,
            },
          });
          results.push({ step, ok: true, detail: `${step.from} → ${step.to}` });
          break;
        }
        case 'set_posture': {
          if (failedTenants.has(step.tenantId)) {
            results.push({ step, ok: false, detail: 'skipped: an earlier step for this tenant failed' });
            break;
          }
          await adminMethod(client, 'setTenantByoMode')(step.tenantId, step.to);
          await recordAudit({
            actorId: null,
            action: 'tenant.byo_mode',
            category: 'tenant',
            targetType: 'tenant',
            targetId: step.tenantId,
            tenantId: step.tenantId,
            result: step.to,
            resultTone: 'ok',
            metadata: { operator, source: 'plan-migration', change: 'byo_mode', before: step.from, after: step.to },
          });
          results.push({ step, ok: true, detail: `${step.from ?? 'unknown'} → ${step.to}` });
          break;
        }
        case 'retire_blocked':
          results.push({ step, ok: false, detail: step.reason });
          break;
        case 'retire_plan': {
          if (failedTenants.size > 0) {
            results.push({ step, ok: false, detail: 'not retired: a tenant step failed' });
            break;
          }
          await adminMethod(client, 'updatePlan')(step.planId, { revoked: true });
          results.push({ step, ok: true });
          break;
        }
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if ('tenantId' in step) failedTenants.add(step.tenantId);
      log.error('plan_migration_step_failed', { step, err });
      results.push({ step, ok: false, detail });
    }
  }
  return results;
}
