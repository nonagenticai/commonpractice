// src/host/sandbox-service.ts — persistent per-user sandbox lifecycle (Session 4).
// A sandbox is provisioned lazily on a user's first run and transitioned by the
// run path (host/run-controller.ts): idle ⇄ running → error; idle/error → suspended.
// A suspended sandbox blocks that user's runs. Idle/error sandboxes past the idle
// threshold are auto-suspended by a periodic sweep started from server.ts boot
// (NEVER on import — so `bun test` doesn't spin a timer; tests call the pure
// sweepIdleSandboxes directly). Cost/usage is never stored here — it's derived
// live from usage_counters (see host/ops-metrics.ts + routes/sandboxes.ts).
import { and, asc, eq, inArray, lt } from 'drizzle-orm';
import { db as defaultDb, sandboxes } from '../db/client';
import { claimTick, TICK_LOCK, TICK_MIN_INTERVAL_MS } from './tick-locks';
import { currentDbContext } from '../db/tenant-context';
import type { Sandbox } from '../db/schema';
import { getSnapshot } from './policy-store';
import { recordAudit } from './audit-service';
import { log } from './logger';

type Db = typeof defaultDb;

export interface SandboxLimits {
  autoSuspendIdleMinutes: number;
}

/** Session 6: reads the LIVE policy store (spend.auto_suspend_idle) instead of the
 *  config constant; config.governance.autoSuspendIdleMinutes is the fallback baked
 *  into buildSnapshot when the row is absent. */
export async function getSandboxLimits(): Promise<SandboxLimits> {
  const s = await getSnapshot();
  return { autoSuspendIdleMinutes: s.autoSuspendIdleMinutes };
}

/** kebab(name) + a short random suffix, e.g. "lisa-vermeer-7c4d" (demo shape). */
export function sandboxSlug(name: string): string {
  const base =
    (name || 'user')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'user';
  return `${base}-${crypto.randomUUID().slice(0, 4)}`;
}

/** The caller's explicitly marked primary sandbox, created on demand.
 *  Idempotent: a user keeps ONE primary sandbox so per-user usage_counters map
 *  1:1 to sandbox cost. (Extra sandboxes via provisionSandbox are fidelity-only.) */
export async function ensureSandbox(
  owner: { id: string; name: string },
  database: Db = defaultDb,
  tenantId = currentDbContext()?.tenantId || null,
): Promise<Sandbox> {
  const ownerScope = tenantId
    ? and(eq(sandboxes.tenant_id, tenantId), eq(sandboxes.owner_id, owner.id), eq(sandboxes.is_primary, true))
    : and(eq(sandboxes.owner_id, owner.id), eq(sandboxes.is_primary, true));
  const [existing] = await database
    .select()
    .from(sandboxes)
    .where(ownerScope)
    .orderBy(asc(sandboxes.created_at))
    .limit(1);
  if (existing) return existing;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const [created] = await database
        .insert(sandboxes)
        .values({
          owner_id: owner.id,
          ...(tenantId ? { tenant_id: tenantId } : {}),
          slug: sandboxSlug(owner.name),
          label: owner.name ? `${owner.name}'s sandbox` : 'sandbox',
          status: 'idle',
          is_primary: true,
          last_active_at: new Date(),
        })
        .returning();
      return created!;
    } catch (err) {
      const code = (err as { code?: string; cause?: { code?: string } })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code;
      if (code !== '23505') throw err;
      // A primary-owner conflict means a concurrent request won. A slug collision has no winner,
      // so the next loop iteration simply generates a new suffix.
      const [winner] = await database.select().from(sandboxes).where(ownerScope).limit(1);
      if (winner) return winner;
    }
  }
  throw new Error(`failed to provision primary sandbox for ${owner.id}`);
}

/** Explicitly create an additional sandbox for an owner (demo "Provision new"). */
export async function provisionSandbox(
  owner: { id: string; name: string },
  database: Db = defaultDb,
  tenantId = currentDbContext()?.tenantId || null,
): Promise<Sandbox> {
  const [created] = await database
    .insert(sandboxes)
    .values({
      owner_id: owner.id,
      ...(tenantId ? { tenant_id: tenantId } : {}),
      slug: sandboxSlug(owner.name),
      label: owner.name ? `${owner.name}'s sandbox` : 'sandbox',
      status: 'idle',
      is_primary: false,
      last_active_at: new Date(),
    })
    .returning();
  return created!;
}

/** A `db` handle or the `tx` a `db.transaction` callback receives. */
type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Resume the OWNER's own primary sandbox, but only from an idle-watchdog suspension.
 *
 * One conditional UPDATE, shared by the two places an owner may resume: the explicit
 * `POST /api/sandboxes/me/resume` and an explicit run (`POST /api/runs`, inside its claim
 * transaction). The WHERE is the whole authorisation: owner = caller, primary, the caller's tenant,
 * `status='suspended'` AND `suspension_reason='idle'`. An administrator's pause (`'admin'`) never
 * matches, so it stays fail-closed; another user's or tenant's sandbox never matches. Returns the
 * resumed row, or null when nothing qualified (the caller decides what that means).
 * It does not touch the idle-suspend policy: the watchdog still suspends after the same window.
 */
export async function resumeOwnIdleSandbox(
  database: DbOrTx,
  scope: { ownerId: string; tenantId: string | null; sandboxId?: string },
): Promise<Sandbox | null> {
  const now = new Date();
  const [resumed] = await database
    .update(sandboxes)
    .set({ status: 'idle', suspension_reason: null, last_active_at: now, updated_at: now })
    .where(
      and(
        ...(scope.tenantId ? [eq(sandboxes.tenant_id, scope.tenantId)] : []),
        ...(scope.sandboxId ? [eq(sandboxes.id, scope.sandboxId)] : []),
        eq(sandboxes.owner_id, scope.ownerId),
        eq(sandboxes.is_primary, true),
        eq(sandboxes.status, 'suspended'),
        eq(sandboxes.suspension_reason, 'idle'),
      ),
    )
    .returning();
  return resumed ?? null;
}

type SandboxStatus = Sandbox['status'];

/** Move a sandbox to a new status. `touchActivity` resets the idle clock — true by
 *  default for running/idle/error (real activity), false when suspending. */
export async function transitionSandbox(
  id: string,
  status: SandboxStatus,
  database: Db = defaultDb,
  opts: {
    touchActivity?: boolean;
    expectedStatuses?: SandboxStatus[];
    suspensionReason?: 'idle' | 'admin' | null;
  } = {},
): Promise<boolean> {
  const touch =
    opts.touchActivity ??
    (status === 'running' || status === 'idle' || status === 'error');
  const now = new Date();
  const where = opts.expectedStatuses?.length
    ? and(eq(sandboxes.id, id), inArray(sandboxes.status, opts.expectedStatuses))
    : eq(sandboxes.id, id);
  const rows = await database
    .update(sandboxes)
    .set({
      status,
      suspension_reason: status === 'suspended' ? (opts.suspensionReason ?? 'admin') : null,
      updated_at: now,
      ...(touch ? { last_active_at: now } : {}),
    })
    .where(where)
    .returning({ id: sandboxes.id });
  return rows.length === 1;
}

/** Pure, unit-testable: suspend idle/error sandboxes whose last_active_at predates
 *  the idle threshold. Cutoff is computed in JS and compared to a timestamptz
 *  column — no DB-clock/timezone coupling (the S3 watchdog TZ lesson). NULL
 *  last_active_at (never-run) is never swept. Returns the suspended ids. */
export async function sweepIdleSandboxes(
  database: Db,
  now: Date,
  limits?: SandboxLimits,
): Promise<string[]> {
  const effective = limits ?? (await getSandboxLimits());
  const cutoff = new Date(now.getTime() - effective.autoSuspendIdleMinutes * 60_000);
  const rows = await database
    .update(sandboxes)
    .set({ status: 'suspended', suspension_reason: 'idle', updated_at: now })
    .where(
      and(
        inArray(sandboxes.status, ['idle', 'error']),
        lt(sandboxes.last_active_at, cutoff),
      ),
    )
    .returning({ id: sandboxes.id });
  return rows.map((r) => r.id);
}

let watchdogTimer: ReturnType<typeof setInterval> | undefined;

/**
 * ONE watchdog tick: claim it across the fleet, and sweep only if this pod won the claim.
 *
 * Exported so the claim can be tested by CALLING it, rather than by waiting out a 60s timer.
 *
 * ⚠️ THE CLAIM IS A CONNECTION-BUDGET FIX, NOT A CORRECTNESS FIX, and it is worth being precise
 * about that because the difference decides how this should be tested. The sweep is
 * `UPDATE … WHERE status IN (…) AND last_active_at < cutoff RETURNING id`, which Postgres
 * row-lock-serializes: a second pod re-evaluates the WHERE, matches nothing, and neither
 * double-suspends nor double-audits. Running it in all four pods was never WRONG. It was
 * EXPENSIVE — this was the one scheduler not claim-serialised, so it hit the owner pool once per
 * pod every 60s forever, and the owner pool is on the TRANSACTION pooler, the tighter of CP's two
 * ceilings and the one that has already logged a live `08P01 server conn crashed?`. At 4 HPA
 * replicas that is 4 owner-pool acquisitions per minute. The claim does NOT reduce that count (the
 * claim statement itself runs on the owner pool in every pod) — it removes the sweep UPDATE, the
 * policy read and the audit writes from three of the four, which is where the cost actually is.
 *
 * The consequence for tests: asserting "the same sandboxes ended up suspended" proves NOTHING here,
 * because idempotence makes that true with or without the claim. The only thing that distinguishes
 * fixed from broken is the CLAIM itself — that the second call inside the window does not reach the
 * database at all. tests/sandbox-watchdog-tick.test.ts asserts on that.
 *
 * Returns the suspended ids, or `undefined` when another pod owns this tick.
 */
export async function runSandboxSweepTick(): Promise<string[] | undefined> {
  // Detached from any request → no tenant GUC. The sweep is inherently cross-tenant, so
  // `claimTick` runs the winner's body as SYSTEM (owner pool, bypasses RLS); otherwise the
  // UPDATE on the RLS-scoped `sandboxes` table matches 0 rows under cp_app and idle-suspend
  // silently never fires.
  //
  // ⚠️ This site had NO refused-claim branch at all, and tick-locks.ts's comment pointed readers at
  // "the `result === undefined` branch in each *-scheduler.ts" — there is no sandbox-scheduler.ts.
  // A refusal here is EXPECTED every 60s on every non-winning replica, so it is deliberately NOT
  // counted (a counter that ticks 3x/min at 4 replicas measures the replica count, not a fault) and
  // — for exactly the same reason — not WARNed on repeat: 1,440/day at 2 replicas, 4,320 at 4.
  // `refusal: 'expected'` keeps the first one per process at warn and drops the rest to debug.
  const ids = await claimTick({
    key: TICK_LOCK.sandboxSweep,
    minIntervalMs: TICK_MIN_INTERVAL_MS.sandboxSweep,
    label: '[sandbox-sweep] tick',
    skipCounter: null,
    refusal: 'expected',
    run: () => sweepIdleSandboxes(defaultDb, new Date()),
  });
  if (!ids?.length) return ids;
  log.info('sandbox_sweep_auto_suspended', { component: 'sandbox-sweep', count: ids.length });
  for (const id of ids) {
    await recordAudit({
      action: 'sandbox.suspend',
      category: 'sandbox',
      targetType: 'sandbox',
      targetId: id,
      result: 'Auto-suspended · idle',
      resultTone: 'warn',
    });
  }
  return ids;
}

/** Start the idle-sweep interval. Call ONCE from server.ts boot only. */
export function startSandboxWatchdog(intervalMs = 60_000): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    void runSandboxSweepTick().catch((err) => log.error('sandbox_sweep_failed', { component: 'sandbox-sweep', err }));
  }, intervalMs);
  watchdogTimer.unref?.();
}
