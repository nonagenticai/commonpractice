// src/routes/platform-plans.ts — the Common Practice PLAN CATALOGUE (super_admin), A2 §5.
//
// A thin proxy over the licences admin API's plan endpoints, PINNED to this deployment's app
// (`config.license.appKey`, i.e. `commonpractice`). The app is never a caller input: a body or query
// naming another app is refused (403 `app_not_allowed`), and an id-addressed write first proves the
// plan belongs to this app's catalogue — licences' `PATCH/DELETE /plans/{id}` would otherwise let a
// CP super_admin edit any product's plans by id.
//
//   GET    /api/platform/plans[?includeRevoked=1]  → { plans: [...+tenantCount], capabilities }
//   POST   /api/platform/plans                      → 201 { plan }
//   PATCH  /api/platform/plans/:id                  → { plan }   (`revoked` = retire / un-retire)
//   DELETE /api/platform/plans/:id                  → { ok: true }
//
// `tenantCount` is CP's own count of tenants whose `plan_code` is that code (NULL counts as the
// deployment default). Delete is refused while it is > 0 (409 `plan_in_use`), and licences' own 409
// (a licence still references the plan) maps to the same code.
//
// RETIRE needs licences A2-L (`PlanUpdate.revoked`). Probe-free: the PATCH is passed through, and a
// licences that refuses or ignores the field answers 501 `retire_unsupported`. `capabilities.
// canRetire` reports what this process has OBSERVED: null = not tried yet, true = a retire worked,
// false = licences refused one. The UI shows "Retire" unless it is false.
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config';
import { db, tenants } from '../db/client';
import { requireSuperAdmin } from '../middleware/admin-guards';
import {
  adminMethod,
  licencesAdminConfigured,
  licensesAdmin,
  LicensesAdminError,
  PlanRetireUnsupportedError,
  type LicencesPlan,
} from '../services/licenses-admin';
import { licencesUnavailable } from '../services/tenant-service';
import { recordAudit } from '../host/audit-service';
import { SYSTEM_TENANT_ID } from '../services/license-provisioning';
import { HttpError, badRequest, conflict, forbidden, jsonResponse, notFound, readJson, route } from '../utils/http';
import type { Router } from '../utils/router';

/** What this process has seen licences do with `revoked` (see the header). */
let retireObserved: boolean | null = null;
/** Test seam. */
export function __resetRetireCapabilityForTests(): void {
  retireObserved = null;
}

const nonNegInt = z.number().int().min(0).max(2_000_000_000);
const planFields = {
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable(),
  durationDays: z.number().int().positive().max(36_500).nullable(),
  rateLimitRpm: z.number().int().positive().max(1_000_000).nullable(),
  rateLimitBurst: z.number().int().positive().max(1_000_000).nullable(),
  quotaMonthly: nonNegInt.nullable(),
  tokenBudgetMonthly: nonNegInt.nullable(),
};
/** Accepted only so a request that names the app can be refused explicitly rather than 422'd. */
const appField = z.string().trim().min(1).max(120).optional();

const createPlanSchema = z
  .object({
    app: appField,
    code: z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
    name: planFields.name,
    description: planFields.description.optional(),
    durationDays: planFields.durationDays.optional(),
    rateLimitRpm: planFields.rateLimitRpm.optional(),
    rateLimitBurst: planFields.rateLimitBurst.optional(),
    quotaMonthly: planFields.quotaMonthly.optional(),
    tokenBudgetMonthly: planFields.tokenBudgetMonthly.optional(),
  })
  .strict();

const patchPlanSchema = z
  .object({
    app: appField,
    name: planFields.name.optional(),
    description: planFields.description.optional(),
    durationDays: planFields.durationDays.optional(),
    rateLimitRpm: planFields.rateLimitRpm.optional(),
    rateLimitBurst: planFields.rateLimitBurst.optional(),
    quotaMonthly: planFields.quotaMonthly.optional(),
    tokenBudgetMonthly: planFields.tokenBudgetMonthly.optional(),
    revoked: z.boolean().optional(),
  })
  .strict();

function assertOwnApp(app: string | null | undefined): void {
  if (app !== undefined && app !== null && app !== config.license.appKey) {
    throw forbidden(
      'app_not_allowed',
      `Only the '${config.license.appKey}' plan catalogue can be managed here.`,
    );
  }
}

function assertConfigured(): void {
  if (!licencesAdminConfigured()) {
    throw conflict(
      'licences_not_configured',
      'No licences service is configured in this deployment, so there is no plan catalogue.',
    );
  }
}

/** CP tenants per plan code (NULL plan_code = the deployment default). Offboarded ones excluded,
 *  and so is the nil-UUID SYSTEM tenant (the Dev User seed): it is not a customer workspace, so it
 *  must neither inflate "Workspaces: N" nor hold a plan hostage against deletion. */
async function tenantCountsByPlan(): Promise<Map<string, number>> {
  const rows = (await db.execute(sql`
    SELECT coalesce(${tenants.plan_code}, ${config.license.planCode}) AS code, count(*)::int AS n
      FROM ${tenants}
     WHERE ${tenants.offboarded_at} IS NULL
       AND ${tenants.id} <> ${SYSTEM_TENANT_ID}::uuid
     GROUP BY 1`)) as unknown as { code: string; n: number }[];
  return new Map(rows.map((r) => [r.code, Number(r.n)]));
}

async function ownPlan(id: string): Promise<LicencesPlan> {
  let plans: LicencesPlan[];
  try {
    plans = await adminMethod(licensesAdmin(), 'listPlans')({ includeRevoked: true });
  } catch (err) {
    throw licencesUnavailable(err, 'reading the plan catalogue failed');
  }
  const plan = plans.find((p) => p.id === id);
  if (!plan) {
    throw notFound('plan_not_found', `No plan '${id}' in the ${config.license.appKey} catalogue`);
  }
  return plan;
}

const withCount = (p: LicencesPlan, counts: Map<string, number>) => ({
  ...p,
  tenantCount: counts.get(p.code) ?? 0,
  isDefault: p.code === config.license.planCode,
});

const listPlans = route(async (req) => {
  await requireSuperAdmin(req);
  const url = new URL(req.url);
  assertOwnApp(url.searchParams.get('app'));
  assertConfigured();
  const inc = url.searchParams.get('includeRevoked');
  let plans: LicencesPlan[];
  try {
    plans = await adminMethod(licensesAdmin(), 'listPlans')({
      includeRevoked: inc === '1' || inc === 'true',
    });
  } catch (err) {
    throw licencesUnavailable(err, 'reading the plan catalogue failed');
  }
  const counts = await tenantCountsByPlan();
  return jsonResponse({
    app: config.license.appKey,
    defaultPlanCode: config.license.planCode,
    plans: plans.map((p) => withCount(p, counts)),
    capabilities: { canRetire: retireObserved },
  });
});

const createPlan = route(async (req) => {
  const actor = await requireSuperAdmin(req);
  const { app, ...body } = createPlanSchema.parse(await readJson(req));
  assertOwnApp(app);
  assertConfigured();
  let plan: LicencesPlan;
  try {
    plan = await adminMethod(licensesAdmin(), 'createPlan')(body);
  } catch (err) {
    if (err instanceof LicensesAdminError && err.status === 409) {
      throw conflict('plan_code_taken', `A plan with code '${body.code}' already exists.`);
    }
    throw licencesUnavailable(err, `creating plan '${body.code}' failed`);
  }
  await recordAudit({
    actorId: actor.id,
    action: 'plan.create',
    category: 'tenant',
    targetType: 'plan',
    targetId: plan.id,
    result: plan.code,
    resultTone: 'ok',
    metadata: { change: 'create', before: null, after: plan },
  });
  return jsonResponse({ plan: withCount(plan, await tenantCountsByPlan()) }, 201);
});

const patchPlan = route(async (req, id) => {
  const actor = await requireSuperAdmin(req);
  const { app, revoked, ...fields } = patchPlanSchema.parse(await readJson(req));
  assertOwnApp(app);
  assertConfigured();
  const hasFields = Object.values(fields).some((v) => v !== undefined);
  if (!hasFields && revoked === undefined) {
    throw badRequest('no_changes', 'Provide at least one plan field or `revoked`.');
  }
  const before = await ownPlan(id!);
  const client = licensesAdmin();
  let plan = before;
  try {
    if (hasFields) plan = await adminMethod(client, 'updatePlan')(id!, fields);
    // `revoked` on its own request: an older licences would otherwise apply the fields and DROP the
    // flag, and the response could not say which half happened.
    if (revoked !== undefined && revoked !== before.revoked) {
      plan = await adminMethod(client, 'updatePlan')(id!, { revoked });
      retireObserved = true;
    }
  } catch (err) {
    if (err instanceof PlanRetireUnsupportedError) {
      retireObserved = false;
      throw new HttpError(501, 'retire_unsupported', err.message, {
        // Field edits sent in the same request DID apply when this fires.
        fieldsApplied: hasFields,
      });
    }
    throw licencesUnavailable(err, `updating plan ${id} failed`);
  }
  await recordAudit({
    actorId: actor.id,
    action: revoked !== undefined && revoked !== before.revoked ? (revoked ? 'plan.retire' : 'plan.unretire') : 'plan.update',
    category: 'tenant',
    targetType: 'plan',
    targetId: id,
    result: plan.code,
    resultTone: 'ok',
    metadata: { change: 'update', before, after: plan },
  });
  return jsonResponse({ plan: withCount(plan, await tenantCountsByPlan()) });
});

const deletePlan = route(async (req, id) => {
  const actor = await requireSuperAdmin(req);
  assertOwnApp(new URL(req.url).searchParams.get('app'));
  assertConfigured();
  const plan = await ownPlan(id!);
  const counts = await tenantCountsByPlan();
  const inUse = counts.get(plan.code) ?? 0;
  if (inUse > 0) {
    throw conflict('plan_in_use', `Plan '${plan.code}' is in use by ${inUse} tenant(s).`, {
      tenantCount: inUse,
    });
  }
  try {
    await adminMethod(licensesAdmin(), 'deletePlan')(id!);
  } catch (err) {
    if (err instanceof LicensesAdminError && err.status === 409) {
      throw conflict(
        'plan_in_use',
        `Plan '${plan.code}' is still referenced by licences (current or historical), so it cannot be ` +
          `deleted. Retire it instead.`,
        { tenantCount: inUse },
      );
    }
    throw licencesUnavailable(err, `deleting plan ${id} failed`);
  }
  await recordAudit({
    actorId: actor.id,
    action: 'plan.delete',
    category: 'tenant',
    targetType: 'plan',
    targetId: id,
    result: plan.code,
    resultTone: 'warn',
    metadata: { change: 'delete', before: plan, after: null },
  });
  return jsonResponse({ ok: true });
});

export function registerPlatformPlanRoutes(router: Router): void {
  router.add('GET', '/api/platform/plans', listPlans);
  router.add('POST', '/api/platform/plans', createPlan);
  router.add('PATCH', '/api/platform/plans/:id', patchPlan);
  router.add('DELETE', '/api/platform/plans/:id', deletePlan);
}
