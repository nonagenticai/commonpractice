// src/routes/cycle.ts — the marketplace weekly-cycle controls (Phase 2-E).
// GET /api/cycle/current (employee) surfaces the live phase + boundaries for the home
// countdown — READ-ONLY, null when the engine has not opened a week. POST /api/cycle/advance
// (platform-gated) is the manual trigger / live-verification path: it drives a week
// forward without waiting for the daily scheduler (the cadence is normally 7 days). The
// heavy lifting (idempotent open / advance / close + winner selection) lives in
// host/cycle-service.ts; this is the thin HTTP surface around it.
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, marketplaceCycles, runAsSystem, tenants } from '../db/client';
import type { MarketplaceCycle } from '../db/schema';
import { validateAuth } from '../middleware/auth';
import { requireSuperAdmin } from '../middleware/admin-guards';
import { badRequest, conflict, jsonResponse, notFound, readJsonOptional, route, unprocessable } from '../utils/http';
import { recordAudit } from '../host/audit-service';
import { driveCycle, readCurrentCycle } from '../host/cycle-service';
import { cycleNow, requestTenantId, resolveCadence } from '../host/cycle-cadence';
import { periodFromKey } from '../host/period';
import type { Router } from '../utils/router';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cycleDto(c: MarketplaceCycle | null) {
  if (!c) return null;
  return {
    week: c.week,
    periodKind: c.period_kind,
    periodKey: c.period_key,
    periodStart: c.period_start,
    phase: c.phase,
    votingEndsAt: c.voting_ends_at,
    solutionEndsAt: c.solution_ends_at,
    closesAt: c.closes_at,
    closedAt: c.closed_at,
    // winnerSolutionId / stats are gone on purpose: marketplace_cycles is the GLOBAL phase
    // clock, but winners are per-tenant (weekly_winners, 0041). Those two columns could only
    // ever carry one arbitrary tenant's solution id + platform-wide vote totals, and this DTO
    // is served to every tenant — so it was a cross-tenant leak dressed as a convenience field.
    // The winner surface is GET /api/winner, which reads weekly_winners under the caller's RLS.
  };
}

async function readByKey(key: string, tenantId: string): Promise<MarketplaceCycle | null> {
  const p = periodFromKey(key);
  const [row] = await db
    .select()
    .from(marketplaceCycles)
    .where(
      and(
        eq(marketplaceCycles.tenant_id, tenantId),
        eq(marketplaceCycles.period_kind, p.kind),
        eq(marketplaceCycles.period_key, key),
      ),
    );
  return row ?? null;
}

// GET /api/cycle/current — the CALLER'S TENANT's live cycle for the current period (or null). 0110:
// cycles are per tenant; the tenant is the request's RLS scope, never a parameter.
const getCurrent = route(async (req) => {
  await validateAuth(req);
  // `cycleNow()`: the wall clock (tests pin it — host/cycle-cadence.ts).
  const cycle = await readCurrentCycle(cycleNow(), requestTenantId());
  return jsonResponse(cycleDto(cycle));
});

const advanceSchema = z
  .object({
    // A period key of any kind: '2026-W41' | '2026-10' | '2026-Q4' | '2026'. (`week` is the legacy field name.)
    week: z
      .string()
      .regex(/^\d{4}(-W\d{2}|-\d{2}|-Q[1-4])?$/)
      .refine((k) => {
        try {
          periodFromKey(k);
          return true;
        } catch {
          return false;
        }
      }, 'not a valid period key')
      .optional(),
    to: z.enum(['solution_phase', 'closed']).optional(),
    force: z.boolean().optional(),
  })
  .strict();

// POST /api/cycle/advance — manually drive a week forward (platform-gated).
// { week?, to?: 'solution_phase'|'closed', force? }. No `to` runs a normal time-based
// tick of the current week. Returns the resulting (target-week) cycle row.
const postAdvance = route(async (req) => {
  const actor = await requireSuperAdmin(req);
  const body = advanceSchema.parse(await readJsonOptional(req));
  // 0110: the drive acts on ONE tenant's cycle — the caller's own (its request scope), or the one a
  // super_admin names with `?tenantId=` (this route is super_admin-only, so the parameter is theirs).
  const named = new URL(req.url).searchParams.get('tenantId');
  if (named !== null && !UUID_RE.test(named)) throw badRequest('tenant_required', `'${named}' is not a tenant id.`);
  const tenantId = named ? named.toLowerCase() : requestTenantId();
  if (!tenantId) {
    throw badRequest('tenant_required', 'Name the tenant whose cycle to drive (?tenantId=…); this request has no tenant scope.');
  }
  // The tenant must EXIST and be LIVE. Unchecked, a typo'd id reached the cycle insert and surfaced as
  // an FK violation (500); an offboarded tenant would get a fresh period opened for a workspace nobody
  // can use. (The scheduler still finishes an offboarded tenant's already-running period on its own.)
  const [tenant] = await runAsSystem('platform-admin', () =>
    db.select({ offboardedAt: tenants.offboarded_at }).from(tenants).where(eq(tenants.id, tenantId)),
  );
  if (!tenant) throw notFound('tenant_not_found', `No tenant '${tenantId}'.`);
  if (tenant.offboardedAt) {
    throw conflict('tenant_offboarded', `Tenant '${tenantId}' is offboarded; its cycle cannot be driven by hand.`);
  }
  const now = cycleNow();
  const state = await runAsSystem('platform-admin', () => resolveCadence(now, tenantId, db));
  // ⛔ WHAT IS REFUSED IS OPENING A ROW, NEVER DRIVING ONE THAT EXISTS.
  //
  // An EXISTING non-closed row of any kind can always be driven (solution phase / force-close): in
  // off mode a period may still be running, and in the 00:00–03:00 UTC gap after a cadence switch's
  // boundary the old-kind row has reached its close while the effective cadence is already the new
  // kind. An operator must be able to close that row by hand; an earlier draft refused its key as a
  // kind mismatch and left the row to the tick alone.
  //
  // Only a key with NO row is checked, because driving it OPENS a period:
  //   • cadence off   → 422 `cycle_off`: no period may be opened while the cycle is off.
  //   • another kind  → 400 `cycle_kind_mismatch`: opening `2026-10` while weeks govern would start
  //     a second, overlapping race, and the month row would then be the "live" cycle every reader
  //     resolves the cadence from.
  const existing = body.week ? await runAsSystem('platform-admin', () => readByKey(body.week!, tenantId)) : null;
  if (body.week && !existing && body.to) {
    const kind = periodFromKey(body.week).kind;
    if (state.effective === 'off') {
      throw unprocessable(
        'cycle_off',
        `The voting cycle is off, so no period can be opened. '${body.week}' has no cycle row; turn the cycle on to open one.`,
      );
    }
    if (kind !== state.effective) {
      throw badRequest(
        'cycle_kind_mismatch',
        `'${body.week}' is a ${kind} period, but the effective cadence is ${state.effective}.`,
      );
    }
  }
  // No key and no current period (the cadence is off and nothing runs): there is nothing to drive,
  // and nothing may be opened. An existing row can still be driven by naming its key.
  if (!body.week && !state.current && body.to) {
    throw unprocessable(
      'cycle_off',
      'The voting cycle is off and no period is running, so no period can be opened. Name an existing period to drive it.',
    );
  }
  const week = body.week ?? state.current?.key ?? '';

  // The cycle engine spans every tenant's challenges/solutions for the week — run the mutation as
  // SYSTEM (owner, RLS-bypassed) so this platform super_admin trigger stays cross-tenant-correct
  // once the runtime flips to the non-owner cp_app role (mirrors the scheduler path).
  // ONE transaction holding the policy row FOR SHARE (sweep → open → drive, or a plain tick) — a
  // cadence switch can never commit between the steps. See `driveCycle`.
  await runAsSystem('platform-admin', () => driveCycle(week, body.to, now, tenantId, db, { force: body.force === true }));

  await recordAudit({
    actorId: actor.id,
    action: 'cycle.trigger',
    category: 'deploy',
    targetType: 'marketplace_cycle',
    targetId: week,
    result: body.to ? `Manual → ${body.to}` : 'Manual tick',
    resultTone: 'ok',
    metadata: { week, tenantId, to: body.to ?? 'tick', force: body.force === true },
  });

  return jsonResponse(cycleDto(week ? await runAsSystem('platform-admin', () => readByKey(week, tenantId)) : null));
});

// GET /api/cycle/cadence — the cadence any signed-in user's screens follow. `effective` governs NOW
// (the running period's kind until it closes, then the setting); `setting` is what the next period
// will be. Edited by super_admin through PATCH /api/governance/cycle.cadence (audited).
const getCadence = route(async (req) => {
  await validateAuth(req);
  const s = await resolveCadence(new Date(), requestTenantId());
  return jsonResponse({
    setting: s.setting,
    effective: s.effective,
    pending: s.setting !== s.effective || !!(s.pending && Date.now() < s.pending.at.getTime()),
    // When the setting takes over (the next boundary of its kind), while a switch is pending.
    effectiveFrom: s.pending && Date.now() < s.pending.at.getTime() ? s.pending.at : null,
    current: s.current ? { kind: s.current.kind, key: s.current.key, start: s.current.start, end: s.current.end } : null,
  });
});

export function registerCycleRoutes(router: Router): void {
  router.add('GET', '/api/cycle/current', getCurrent);
  router.add('GET', '/api/cycle/cadence', getCadence);
  router.add('POST', '/api/cycle/advance', postAdvance);
}
