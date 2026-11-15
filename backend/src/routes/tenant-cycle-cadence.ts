// src/routes/tenant-cycle-cadence.ts — a workspace's OWN voting schedule (PLAN-2026-10-14 § W7 task C).
//
//   GET   /api/tenant/cycle-cadence   tenant_admin+: the workspace's choice, what runs now, what takes
//                                     over next (and when), the platform default, the last 10 changes.
//   PATCH /api/tenant/cycle-cadence   tenant_admin+: {value: off|week|month|quarter|year} pins the
//                                     workspace to that cadence; {value: null} returns it to the
//                                     platform default (`cycle.cadence`, super_admin on /governance).
//
// Members never need this: the cadence that governs them is already on /api/me (`cycleCadence`) and
// GET /api/cycle/cadence, both resolved per tenant (host/cycle-cadence.ts `resolveCadence`).
//
// ⛔ THE TENANT IS THE CALLER'S, NEVER A PARAMETER. `requireTenantAdmin` fixes it from auth; a
// `tenantId` in the body or query is REFUSED (400), not silently ignored, so a client that believes it
// can target another workspace learns at once that it cannot. A super_admin acting INTO another
// tenant (X-Active-Tenant-Id) is not supported here (403): the platform default is their lever.
//
// ⛔ The switch runs as SYSTEM (`switchTenantCadence` moves the tenant's running cycle row, which cp_app
// may only read) — safe only because the tenant id came from `requireTenantAdmin` above it.
// The READ runs under the request's cp_app scope, with an explicit tenant predicate on top of RLS.
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, runAsSystem, tenantCycleCadenceChanges, users } from '../db/client';
import { requireTenantAdmin } from '../middleware/admin-guards';
import { auditActorId, recordAudit } from '../host/audit-service';
import { isLockTimeout, switchTenantCadence } from '../host/cycle-service';
import {
  cadenceStateFrom,
  readLiveCycle,
  readPlatformCadenceRow,
  readTenantCadenceRow,
  tenantRowGoverns,
} from '../host/cycle-cadence';
import { CADENCES, type Cadence } from '../host/period';
import { badRequest, conflict, forbidden, jsonResponse, readJson, route } from '../utils/http';
import type { Router } from '../utils/router';

const TENANT_KEYS = ['tenantId', 'tenant_id', 'tenant'] as const;

const patchSchema = z
  .object({ value: z.enum(CADENCES as unknown as [Cadence, ...Cadence[]]).nullable() })
  .strict();

/** The caller's workspace, from auth only; refuses a smuggled tenant and an act-as scope switch. */
async function requireCadenceAdmin(req: Request) {
  const ctx = await requireTenantAdmin(req);
  const q = new URL(req.url).searchParams;
  if (TENANT_KEYS.some((k) => q.has(k))) {
    throw badRequest('tenant_id_not_accepted', 'The workspace comes from your sign-in; it cannot be chosen.');
  }
  if (ctx.scopeSwitched) {
    throw forbidden(
      'scope_switch_unsupported',
      'The voting schedule can only be changed by an admin of this workspace.',
    );
  }
  return ctx;
}

export interface TenantCadenceView {
  /** The workspace's own choice; null = it follows the platform default. */
  value: Cadence | null;
  followsPlatform: boolean;
  platformDefault: Cadence;
  /** What governs NOW (the running period's kind until it closes) — the same value /api/me carries. */
  effectiveValue: Cadence;
  /** What takes over next, and when; null while nothing is pending. */
  pendingValue: Cadence | null;
  effectiveFrom: Date | null;
  history: {
    id: string;
    oldValue: string | null;
    newValue: string;
    followsPlatform: boolean;
    effectiveFrom: Date | null;
    createdAt: Date;
    actorName: string | null;
  }[];
}

export async function readTenantCadenceView(
  tenantId: string,
  now: Date = new Date(),
  database: typeof db = db,
): Promise<TenantCadenceView> {
  // FRESH reads (never the ≤5s hot-path snapshot): an admin who just saved must see their change.
  const platform = await readPlatformCadenceRow(database, { lock: false });
  const row = await readTenantCadenceRow(database, tenantId);
  const own = tenantRowGoverns(row, now) ? row : null;
  const policy = own ?? platform;
  const pinned = own !== null && !own.followsPlatform;
  const state = cadenceStateFrom(now, policy.setting, await readLiveCycle(database, tenantId, now), policy.pending);
  let pendingValue: Cadence | null = null;
  let effectiveFrom: Date | null = null;
  if (policy.pending && now.getTime() < policy.pending.at.getTime()) {
    pendingValue = policy.setting;
    effectiveFrom = policy.pending.at;
  } else if (state.setting !== state.effective && state.current) {
    // on→off (or a row past its close awaiting the tick): the running period finishes first.
    pendingValue = state.setting;
    effectiveFrom = state.current.end;
  }
  const history = await database
    .select({
      id: tenantCycleCadenceChanges.id,
      oldValue: tenantCycleCadenceChanges.old_value,
      newValue: tenantCycleCadenceChanges.new_value,
      followsPlatform: tenantCycleCadenceChanges.follows_platform,
      effectiveFrom: tenantCycleCadenceChanges.effective_from,
      createdAt: tenantCycleCadenceChanges.created_at,
      actorName: users.name,
    })
    .from(tenantCycleCadenceChanges)
    .leftJoin(users, eq(users.id, tenantCycleCadenceChanges.actor_id))
    .where(eq(tenantCycleCadenceChanges.tenant_id, tenantId))
    .orderBy(desc(tenantCycleCadenceChanges.created_at), desc(tenantCycleCadenceChanges.id))
    .limit(10);
  return {
    value: pinned ? own.setting : null,
    followsPlatform: !pinned,
    platformDefault: platform.setting,
    effectiveValue: state.effective,
    pendingValue,
    effectiveFrom,
    history,
  };
}

const getTenantCadence = route(async (req) => {
  const { effectiveTenantId } = await requireCadenceAdmin(req);
  return jsonResponse(await readTenantCadenceView(effectiveTenantId));
});

const patchTenantCadence = route(async (req) => {
  const { effectiveTenantId: tenantId, user } = await requireCadenceAdmin(req);
  const raw = await readJson(req);
  if (raw && typeof raw === 'object' && TENANT_KEYS.some((k) => k in (raw as Record<string, unknown>))) {
    throw badRequest('tenant_id_not_accepted', 'The workspace comes from your sign-in; it cannot be chosen.');
  }
  const { value } = patchSchema.parse(raw);
  // `tenant_cycle_cadence.updated_by` / `…_changes.actor_id` are FKs onto users.id: an actor with no
  // local row degrades to System (the subject is kept in the audit metadata) — governance.ts's trade.
  const actorRowId = await auditActorId(user.id);
  let r: Awaited<ReturnType<typeof switchTenantCadence>>;
  try {
    r = await runAsSystem('tenant-parameterised', () => switchTenantCadence(tenantId, value, actorRowId));
  } catch (err) {
    if (isLockTimeout(err)) {
      throw conflict('cycle_busy', 'The voting cycle is being advanced right now. Try the change again in a moment.');
    }
    throw err;
  }
  if (r.changed) {
    await recordAudit({
      actorId: user.id,
      tenantId,
      action: 'cycle.cadence.tenant_change',
      category: 'policy',
      targetType: 'tenant_cycle_cadence',
      targetId: tenantId,
      result: 'Applied',
      resultTone: 'warn',
      metadata: {
        oldValue: r.oldValue,
        newValue: value,
        followsPlatform: value === null,
        effectiveFrom: r.pending?.at ?? null,
        actorSub: user.id,
      },
    });
  }
  return jsonResponse({ ...(await readTenantCadenceView(tenantId)), changed: r.changed });
});

export function registerTenantCycleCadenceRoutes(router: Router): void {
  router.add('GET', '/api/tenant/cycle-cadence', getTenantCadence);
  router.add('PATCH', '/api/tenant/cycle-cadence', patchTenantCadence);
}
