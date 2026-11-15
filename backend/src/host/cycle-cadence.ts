// src/host/cycle-cadence.ts — WHICH cadence governs the marketplace right now.
//
// The setting is the governance policy `cycle.cadence` (off | week | month | quarter | year), edited on
// /governance (PATCH /api/governance/cycle.cadence — audited through policy_changes + audit_log).
// `CYCLE_ENABLED` only BOOTSTRAPS it: `ensureCadencePolicy()` writes the row once at boot
// ('week' when CYCLE_ENABLED=true, else 'off') and never overwrites an edit. While the row is absent
// (tests, a DB that never booted the server) the same bootstrap value is used.
//
// ⛔ A CHANGE TAKES EFFECT AT THE NEXT PERIOD BOUNDARY — never by opening a partly-elapsed period.
// The switch is PERSISTED on the policy row (`effective_from` + `previous_value`, written in the same
// transaction as the value by `applyCadenceSwitch`), so every replica and the boot catch-up agree
// without any in-memory state:
//
//   X→Y (both on)  the OLD cadence keeps running; Y starts at B = the first Y-boundary at or after the
//                  end of the X period open at the switch. The X period that would cross B is
//                  STRETCHED to end at B (period.ts `stretchedEnd`; extra time = building phase).
//   on→off         the open period finishes under its own rules (crowns normally); then off.
//   off→Y          the first Y period opens at the next Y boundary after the switch.
//
// So what is IN FORCE at instant t is `previous_value` while t < effective_from, else the value; and
// what governs NOW is the live cycle row while it has not reached its `closes_at`, else what is in
// force. `off` in force with nothing running = no ticks' work, no winners, NO period gate.
//
// ⛔ 0110: THE CADENCE IS PER TENANT. A tenant may OVERRIDE the platform setting with its own row in
// `tenant_cycle_cadence` (same shape: value + pending switch), audited in the append-only
// `tenant_cycle_cadence_changes`. No row = the tenant INHERITS the platform `cycle.cadence` policy.
// Every function here that touches a cycle row or a cadence takes the TENANT explicitly: the cycle
// rows are per tenant (`marketplace_cycles.tenant_id`), and a read without the tenant predicate would
// mix another tenant's running period into this one's gate.
//
// A tenant's HISTORY (what the catch-up replays): the platform `policy_changes` trail up to the
// tenant's FIRST override, then the tenant's own changes (`readTenantTimeline`).
//
// ⚠️ IMPORT DISCIPLINE: db/client + config + period only. The vote hot path imports this; it must not
// drag the closer (cycle-service: recordAudit, enqueueWinner) in behind it.
import { and, asc, desc, eq, lt, lte, ne } from 'drizzle-orm';
import {
  db as defaultDb,
  marketplaceCycles,
  policies,
  policyChanges,
  tenantCycleCadence,
  tenantCycleCadenceChanges,
} from '../db/client';
import { currentDbContext } from '../db/tenant-context';
import type { MarketplaceCycle, NewPolicy } from '../db/schema';
import { getSnapshot } from './policy-store';
import { config } from '../config';
import { CADENCES, isCadence, periodFor, stretchedEnd, type Cadence, type Period, type PeriodKind } from './period';

type Db = typeof defaultDb;

export const CADENCE_POLICY_KEY = 'cycle.cadence';

/** The value `CYCLE_ENABLED` bootstraps the setting to. */
export function bootstrapCadence(): Cadence {
  return config.cycle.enabled ? 'week' : 'off';
}

/**
 * Write the `cycle.cadence` policy row if it does not exist yet (boot, idempotent). ON CONFLICT DO
 * NOTHING: an edit made on /governance is never overwritten by a restart.
 */
/** The row's shape minus its value. `db/seed-platform.ts` carries the same literal (the frontend's
 *  label contract scrapes that file); cycle-cadence.test.ts asserts the two agree. */
export const CADENCE_POLICY_ROW: Omit<NewPolicy, 'value'> = {
  key: CADENCE_POLICY_KEY,
  category: 'marketplace',
  label: 'Voting cycle',
  description:
    'How often challenges are voted on and a winner is chosen: weekly, monthly, quarterly, yearly, or off. Off keeps votes as a ranking with no winners. A change starts at the next period.',
  control: 'select',
  options: [...CADENCES],
  sort: 10,
};

export async function ensureCadencePolicy(database: Db = defaultDb): Promise<void> {
  await database
    .insert(policies)
    .values({ ...CADENCE_POLICY_ROW, value: bootstrapCadence() })
    .onConflictDoNothing({ target: policies.key });
}

/**
 * The stored setting, through the governance snapshot (policy-store: cached ≤5s, invalidated by the
 * PATCH route, so an edit is seen at once on the pod that took it and within 5s on the others). The
 * snapshot falls back to the CYCLE_ENABLED bootstrap when the row is absent.
 */
export async function readCadenceSetting(database: Db = defaultDb): Promise<Cadence> {
  const v = (await getSnapshot(database)).cycleCadence;
  return isCadence(v) ? v : bootstrapCadence();
}

/** A cadence switch that has not taken effect yet: before `at`, `previous` is in force. */
export interface PendingSwitch {
  at: Date;
  previous: Cadence;
}

export interface CadenceState {
  /** What the governance row asks for (in force from `pending.at`, or now when nothing is pending). */
  setting: Cadence;
  /** The switch still waiting for its boundary, or null. */
  pending: PendingSwitch | null;
  /** What governs NOW: the running period's kind until it closes, then what is in force. */
  effective: Cadence;
  /** The newest non-closed cycle row, or null. */
  live: MarketplaceCycle | null;
  /** The governing period containing `now` — the live row's own (possibly stretched) period while it
   *  runs, else the in-force kind's period; null when effective is off. */
  current: Period | null;
  /** The period that follows `current` (starts at `current.end`): what a challenge submitted after
   *  current's voting phase rolls into. Null when nothing follows (switching off) or current is null. */
  next: Period | null;
}

/** The setting in force at instant `t`. */
export function cadenceInForce(t: Date, setting: Cadence, pending: PendingSwitch | null | undefined): Cadence {
  return pending && t.getTime() < pending.at.getTime() ? pending.previous : setting;
}

/** The period a cycle row actually covers: its own start, and its (possibly stretched) close. */
export function periodOfRow(row: Pick<MarketplaceCycle, 'period_kind' | 'period_key' | 'period_start' | 'closes_at'>): Period {
  return { kind: row.period_kind as PeriodKind, key: row.period_key, start: row.period_start, end: row.closes_at };
}

/**
 * The period of the in-force kind that starts at boundary `t`, with the stretch applied when it is an
 * old-kind period opened while a switch is pending. Null when `off` is in force at `t`.
 */
export function periodStartingAt(t: Date, setting: Cadence, pending: PendingSwitch | null | undefined): Period | null {
  const kind = cadenceInForce(t, setting, pending);
  if (kind === 'off') return null;
  const p = periodFor(kind, t);
  return { ...p, end: pending && t.getTime() < pending.at.getTime() ? stretchedEnd(p, pending.at) : p.end };
}

// ── the cadence HISTORY (what was in force at any past instant) ──────────────────────────────
//
// ⛔ ONE `previous_value` LEVEL IS NOT HISTORY. The policy row stores only the LATEST switch, so a
// catch-up after an outage that spanned TWO switches (week→month recorded Oct 8 for Nov 1, then
// month→week recorded Nov 15 for Dec 7) reconstructed "month until Dec 7" and never opened the weeks
// of October: their entries were dead. The history is the full `policy_changes` trail for the key —
// each switch with the instant it was made (`created_at`) and the instant it takes effect
// (`effective_from`, 0107; NULL = at once).
//
// THE REPLAY RULE: a switch made at `c` REPLACES every transition still scheduled after `c` (the
// switch was planned from the state at `c`, which already knew about them), then schedules its own at
// `effective_from ?? c`. That is exactly how `switchCadence` overwrites the pending switch on the row.
// Transitions already in the past at `c` stay: they happened.

/** One recorded switch of `cycle.cadence`. */
export interface CadenceChange {
  /** When the switch was made. */
  at: Date;
  /** When the new value takes over (null: at once). */
  effectiveFrom: Date | null;
  oldValue: unknown;
  newValue: unknown;
}

/** What was in force at any instant: `initial` before the first transition, then each `to` from its `at`. */
export interface CadenceTimeline {
  initial: Cadence;
  /** Ascending by `at`. */
  transitions: { at: Date; to: Cadence }[];
}

/** The timeline a single stored policy describes (no history): `previous` until `pending.at`, then the setting. */
export function timelineOfPolicy(setting: Cadence, pending: PendingSwitch | null | undefined): CadenceTimeline {
  return pending
    ? { initial: pending.previous, transitions: [{ at: pending.at, to: setting }] }
    : { initial: setting, transitions: [] };
}

/**
 * Replay the recorded switches (oldest first) into a timeline, then the stored policy row as the
 * final word (a row written without a `policy_changes` entry — boot bootstrap, a direct write — still
 * governs from its `updated_at`; replaying the row for a switch that WAS recorded is a no-op).
 */
export function buildCadenceTimeline(
  changes: CadenceChange[],
  row: { setting: Cadence; pending: PendingSwitch | null; updatedAt: Date | null },
): CadenceTimeline {
  const valid = changes.filter((c) => isCadence(c.newValue)).sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = valid[0];
  if (!first) return timelineOfPolicy(row.setting, row.pending);
  const initial: Cadence = isCadence(first.oldValue) ? first.oldValue : (row.pending?.previous ?? row.setting);
  let transitions: { at: Date; to: Cadence }[] = [];
  const apply = (made: Date, effective: Date, to: Cadence) => {
    transitions = transitions.filter((t) => t.at.getTime() <= made.getTime());
    transitions.push({ at: effective, to });
    transitions.sort((a, b) => a.at.getTime() - b.at.getTime());
  };
  for (const c of valid) apply(c.at, c.effectiveFrom ?? c.at, c.newValue as Cadence);
  if (row.updatedAt) apply(row.updatedAt, row.pending?.at ?? row.updatedAt, row.setting);
  return { initial, transitions };
}

/** The cadence in force at instant `t` on a timeline. */
export function cadenceAt(tl: CadenceTimeline, t: Date): Cadence {
  let k = tl.initial;
  for (const tr of tl.transitions) {
    if (tr.at.getTime() > t.getTime()) break;
    k = tr.to;
  }
  return k;
}

/**
 * The period that starts at boundary `t` on a timeline, or null when `off` is in force at `t`. It is
 * STRETCHED (period.ts `stretchedEnd`) to the next transition to ANOTHER on-kind — never to a switch
 * to `off`, after which the running period finishes under its own rules.
 */
export function periodStartingAtOn(tl: CadenceTimeline, t: Date): Period | null {
  const kind = cadenceAt(tl, t);
  if (kind === 'off') return null;
  const p = periodFor(kind, t);
  const change = tl.transitions.find((tr) => tr.at.getTime() > t.getTime() && tr.to !== kind);
  return change && change.to !== 'off' ? { ...p, end: stretchedEnd(p, change.at) } : p;
}

/**
 * The periods the engine SHOULD have opened between the close of the newest row (`from`) and `until`
 * (exclusive): the back-fill walk, pure. It follows what was in force at each boundary, jumps an
 * `off` stretch to the transition that ended it, and refuses to invent a crossing: a boundary that
 * is not a period start of the in-force kind, or a kind change with no transition recorded since the
 * previous period began, ends the walk. At most `max` periods.
 */
export function scheduledPeriods(
  tl: CadenceTimeline,
  from: { start: Date; end: Date; kind: PeriodKind },
  until: Date,
  max: number,
): { periods: Period[]; capped: boolean; stoppedAt: Date } {
  const periods: Period[] = [];
  let t = from.end;
  let prev = { start: from.start, kind: from.kind as Cadence };
  while (t.getTime() < until.getTime() && periods.length < max) {
    const p = periodStartingAtOn(tl, t);
    if (!p) {
      const nextOn = tl.transitions.find((tr) => tr.at.getTime() > t.getTime() && tr.to !== 'off');
      if (nextOn && nextOn.at.getTime() < until.getTime()) {
        t = nextOn.at;
        continue;
      }
      break;
    }
    if (p.start.getTime() !== t.getTime()) break;
    const switched = tl.transitions.some((tr) => tr.at.getTime() > prev.start.getTime() && tr.at.getTime() <= t.getTime());
    if (p.kind !== prev.kind && !switched) break;
    periods.push(p);
    prev = { start: p.start, kind: p.kind };
    t = p.end;
  }
  return { periods, capped: periods.length >= max && t.getTime() < until.getTime(), stoppedAt: t };
}

/** Pure: derive the state from the setting, the pending switch and the newest live cycle. */
export function cadenceStateFrom(
  now: Date,
  setting: Cadence,
  live: MarketplaceCycle | null,
  pending: PendingSwitch | null = null,
): CadenceState {
  let effective: Cadence;
  let current: Period | null;
  if (live && live.period_start.getTime() <= now.getTime() && now.getTime() < live.closes_at.getTime()) {
    // The running period governs until its own (possibly stretched) close.
    effective = live.period_kind as PeriodKind;
    current = periodOfRow(live);
  } else {
    // Nothing running, or the running row is past its close and waits for the tick (00:00→03:00):
    // what is in force now decides, so a submission in that window is filed where the tick will open.
    effective = cadenceInForce(now, setting, pending);
    current = effective === 'off' ? null : periodStartingAt(periodFor(effective, now).start, setting, pending);
  }
  const next = current ? periodStartingAt(current.end, setting, pending) : null;
  return { setting, pending, effective, live, current, next };
}

/**
 * The tenant whose cycle a REQUEST is about: the RLS scope the server wrapper bound the request to
 * (`app.current_tenant`, set from the caller's home tenant or a super_admin's validated scope switch).
 * Null outside a tenant-scoped request — callers then have no cycle (`resolveCadence` answers the
 * platform setting with nothing running).
 */
export function requestTenantId(): string | null {
  const ctx = currentDbContext();
  return ctx && !ctx.system && ctx.tenantId ? ctx.tenantId : null;
}

/**
 * The newest cycle row OF THIS TENANT that is not closed (the running period), or null. With `at`,
 * only rows that have STARTED by then: a row opened by hand for a future period (POST
 * /api/cycle/advance) is not the running period and must not shadow the one that is.
 * `tenantId` null (no tenant scope) = nothing runs.
 */
export async function readLiveCycle(
  database: Db,
  tenantId: string | null,
  at?: Date,
): Promise<MarketplaceCycle | null> {
  if (!tenantId) return null;
  const [row] = await database
    .select()
    .from(marketplaceCycles)
    .where(
      and(
        eq(marketplaceCycles.tenant_id, tenantId),
        ne(marketplaceCycles.phase, 'closed'),
        ...(at ? [lte(marketplaceCycles.period_start, at)] : []),
      ),
    )
    .orderBy(desc(marketplaceCycles.period_start))
    .limit(1);
  return row ?? null;
}

/** A tenant's override row as the engine reads it (value + pending switch), or null = no row. */
export interface TenantCadenceRow {
  setting: Cadence;
  pending: PendingSwitch | null;
  updatedAt: Date;
  /** 0112: the row only CARRIES a pending return to the platform default (see `tenantRowGoverns`). */
  followsPlatform: boolean;
}

export function tenantRowOf(
  row:
    | { value: unknown; effective_from: Date | null; previous_value: unknown; updated_at: Date; follows_platform?: boolean }
    | undefined,
): TenantCadenceRow | null {
  if (!row || !isCadence(row.value)) return null;
  const pending = row.effective_from && isCadence(row.previous_value) ? { at: row.effective_from, previous: row.previous_value } : null;
  return { setting: row.value, pending, updatedAt: row.updated_at, followsPlatform: row.follows_platform === true };
}

/**
 * ⛔ 0112: DOES THIS ROW GOVERN THE TENANT AT `at`? A pinned row (the tenant chose a value) always
 * does. A `follows_platform` row (PATCH {value: null}, a return to the platform default) only while
 * its pending switch has not taken effect: before `effective_from` it holds the tenant on its OLD
 * cadence (the return waits for the next boundary like every switch); from then on — or at once,
 * with nothing pending — the tenant INHERITS exactly as with no row, and a platform switch moves it.
 */
export function tenantRowGoverns(row: TenantCadenceRow | null, at: Date): row is TenantCadenceRow {
  if (!row) return false;
  if (!row.followsPlatform) return true;
  return row.pending !== null && at.getTime() < row.pending.at.getTime();
}

/** Read a tenant's override row FRESH (`lock`: `FOR SHARE` | `FOR UPDATE`). */
export async function readTenantCadenceRow(
  database: Db,
  tenantId: string,
  opts: { lock?: 'share' | 'update' } = {},
): Promise<TenantCadenceRow | null> {
  const q = database.select().from(tenantCycleCadence).where(eq(tenantCycleCadence.tenant_id, tenantId));
  const [row] = opts.lock ? await q.for(opts.lock) : await q;
  return tenantRowOf(row);
}

// The per-tenant snapshot: the hot path (every vote, every board render) must not read the override
// row each time. Same contract as policy-store's snapshot: ≤5s stale on other pods, invalidated on
// the pod that wrote it (`invalidateTenantCadenceCache`, called by `switchTenantCadence`).
const TENANT_CADENCE_TTL_MS = 5_000;
const tenantCadenceCache = new Map<string, { at: number; row: TenantCadenceRow | null }>();
export function invalidateTenantCadenceCache(tenantId?: string): void {
  if (tenantId) tenantCadenceCache.delete(tenantId);
  else tenantCadenceCache.clear();
}

/**
 * The setting AND its pending switch that govern `tenantId` (snapshot-cached): the tenant's own row
 * when it has one, else the platform `cycle.cadence` policy. `tenantId` null = the platform policy.
 */
export async function readCadencePolicy(
  database: Db,
  tenantId: string | null,
  at: Date = new Date(),
): Promise<{ setting: Cadence; pending: PendingSwitch | null; source: 'tenant' | 'platform' }> {
  if (_override) return { setting: _override.setting, pending: _override.pending ?? null, source: 'platform' };
  if (tenantId) {
    const now = Date.now();
    let hit = tenantCadenceCache.get(tenantId);
    if (!hit || now - hit.at >= TENANT_CADENCE_TTL_MS) {
      hit = { at: now, row: await readTenantCadenceRow(database, tenantId) };
      tenantCadenceCache.set(tenantId, hit);
    }
    if (tenantRowGoverns(hit.row, at)) return { setting: hit.row.setting, pending: hit.row.pending, source: 'tenant' };
  }
  const snap = await getSnapshot(database);
  const setting = isCadence(snap.cycleCadence) ? snap.cycleCadence : bootstrapCadence();
  const switchAt = snap.cycleCadenceSwitchAt ?? null;
  const prev = snap.cycleCadencePrevious ?? null;
  return { setting, pending: switchAt && prev ? { at: switchAt, previous: prev } : null, source: 'platform' };
}

/**
 * The stored setting AND its pending switch, read FRESH (never through the ≤5s per-pod snapshot)
 * with `FOR SHARE` on the policy row, inside the caller's transaction. The tick reads the policy this
 * way so a cadence switch (`switchCadence` holds the row `FOR UPDATE` for its whole transaction:
 * value, pending boundary, stretched live row and re-homed rows) is either FULLY seen by the tick or
 * not at all: a switch in flight makes the tick wait for its commit, and a switch arriving while the
 * tick holds the share lock waits for the tick. The snapshot read could give a tick the OLD value
 * next to the switch's already-committed stretch — a mix no single instant ever held.
 */
export async function readCadencePolicyLocked(
  tx: Db,
  tenantId: string,
  at?: Date,
): Promise<{ setting: Cadence; pending: PendingSwitch | null; timeline: CadenceTimeline }> {
  return readCadencePolicyWithHistory(tx, tenantId, { lock: true, at });
}

/**
 * The PLATFORM `cycle.cadence` row (setting + pending), read FRESH (`lock`: `FOR SHARE`).
 */
export async function readPlatformCadenceRow(
  tx: Db,
  opts: { lock: boolean },
): Promise<{ setting: Cadence; pending: PendingSwitch | null; updatedAt: Date | null }> {
  const q = tx.select().from(policies).where(eq(policies.key, CADENCE_POLICY_KEY));
  const [row] = opts.lock ? await q.for('share') : await q;
  const setting = isCadence(row?.value) ? row.value : bootstrapCadence();
  const prev = row?.previous_value;
  const at = row?.effective_from ?? null;
  const pending = at && isCadence(prev) ? { at, previous: prev } : null;
  return { setting, pending, updatedAt: row?.updated_at ?? null };
}

/**
 * The setting, its pending switch and the full history that govern `tenantId`, read FRESH (`lock`:
 * the platform row AND the tenant's override row `FOR SHARE` — the order every engine transaction
 * takes them in, after the tenant's advisory lock; see cycle-service CYCLE_TENANT_LOCK).
 */
export async function readCadencePolicyWithHistory(
  tx: Db,
  tenantId: string,
  opts: { lock: boolean; at?: Date },
): Promise<{ setting: Cadence; pending: PendingSwitch | null; timeline: CadenceTimeline }> {
  if (_override) {
    const pending = _override.pending ?? null;
    return { setting: _override.setting, pending, timeline: timelineOfPolicy(_override.setting, pending) };
  }
  const platform = await readPlatformCadenceRow(tx, opts);
  const own = await readTenantCadenceRow(tx, tenantId, opts.lock ? { lock: 'share' } : {});
  const timeline = await readTenantTimeline(tx, tenantId, own, platform);
  if (!tenantRowGoverns(own, opts.at ?? new Date())) {
    return { setting: platform.setting, pending: platform.pending, timeline };
  }
  return { setting: own.setting, pending: own.pending, timeline };
}

type ChangeRow = { at: Date; effectiveFrom: Date | null; oldValue: unknown; newValue: unknown };
/** A tenant history entry: `followsPlatform` = a return to the platform default (0112). */
export type TenantChangeRow = ChangeRow & { followsPlatform: boolean };

/**
 * Pure: the switches that shaped a TENANT's cadence, for `buildCadenceTimeline`. A platform switch
 * made at `c` counts only while the tenant INHERITED at `c` — before its first own switch, or after
 * its latest own switch before `c` was a return to the platform default (0112). Its own switches
 * always count. Platform entries are listed first, so on an equal instant (a platform switch that
 * also rewrites a pending return, `switchCadence`) the tenant's own entry replays LAST.
 * `pinnedSince`: an override row with no recorded history (written directly) pins from its write.
 */
export function mergeTenantChanges(
  platform: ChangeRow[],
  own: TenantChangeRow[],
  pinnedSince?: Date | null,
): ChangeRow[] {
  const ordered = [...own].sort((a, b) => a.at.getTime() - b.at.getTime());
  const kept = platform.filter((p) => {
    if (ordered.length === 0) return !pinnedSince || p.at.getTime() < pinnedSince.getTime();
    let last: TenantChangeRow | undefined;
    for (const o of ordered) {
      if (o.at.getTime() < p.at.getTime()) last = o;
      else break;
    }
    return !last || last.followsPlatform;
  });
  return [...kept, ...ordered];
}

async function platformChanges(database: Db, before?: Date): Promise<ChangeRow[]> {
  return database
    .select({
      at: policyChanges.created_at,
      effectiveFrom: policyChanges.effective_from,
      oldValue: policyChanges.old_value,
      newValue: policyChanges.new_value,
    })
    .from(policyChanges)
    .where(
      and(eq(policyChanges.policy_key, CADENCE_POLICY_KEY), ...(before ? [lt(policyChanges.created_at, before)] : [])),
    )
    .orderBy(asc(policyChanges.created_at), asc(policyChanges.id));
}

/** The full PLATFORM cadence history (`policy_changes` for the key, oldest first) replayed onto the stored row. */
export async function readCadenceTimeline(
  database: Db,
  row: { setting: Cadence; pending: PendingSwitch | null; updatedAt: Date | null },
): Promise<CadenceTimeline> {
  return buildCadenceTimeline(await platformChanges(database), row);
}

/**
 * A tenant's history (`mergeTenantChanges`): the platform trail while it inherited, its own switches,
 * then the final word. `row` = the tenant's override row (null = none). A PINNED row is the final
 * word; for a tenant that inherits (no row, or a `follows_platform` row) the platform row is — but
 * only when it was written after the tenant's last own switch (else replaying it would wipe that
 * switch's scheduled transition).
 */
export async function readTenantTimeline(
  database: Db,
  tenantId: string,
  row: { setting: Cadence; pending: PendingSwitch | null; updatedAt: Date | null; followsPlatform?: boolean } | null,
  platformRow?: { setting: Cadence; pending: PendingSwitch | null; updatedAt: Date | null },
): Promise<CadenceTimeline> {
  const own: TenantChangeRow[] = await database
    .select({
      at: tenantCycleCadenceChanges.created_at,
      effectiveFrom: tenantCycleCadenceChanges.effective_from,
      oldValue: tenantCycleCadenceChanges.old_value,
      newValue: tenantCycleCadenceChanges.new_value,
      followsPlatform: tenantCycleCadenceChanges.follows_platform,
    })
    .from(tenantCycleCadenceChanges)
    .where(eq(tenantCycleCadenceChanges.tenant_id, tenantId))
    .orderBy(asc(tenantCycleCadenceChanges.created_at), asc(tenantCycleCadenceChanges.id));
  const pinned = row !== null && row.followsPlatform !== true;
  const merged = mergeTenantChanges(await platformChanges(database), own, pinned ? row.updatedAt : null);
  if (pinned) return buildCadenceTimeline(merged, row);
  const platform = platformRow ?? (await readPlatformCadenceRow(database, { lock: false }));
  const lastOwn = own.length ? own[own.length - 1]!.at : null;
  const platformIsNewer = !lastOwn || (platform.updatedAt !== null && platform.updatedAt.getTime() > lastOwn.getTime());
  return buildCadenceTimeline(merged, platformIsNewer ? platform : { ...platform, updatedAt: null });
}

// Test seam (house pattern — like policy-store's __setSnapshotOverrideForTests). `policies` and
// `marketplace_cycles` are GLOBAL tables shared by every test file, so an off-mode or month-mode
// test must not flip the real row (or depend on which fixture cycle another file left live). When
// set, resolveCadence uses this setting and live cycle verbatim. Production never sets it.
/** The wall clock the manual cycle route and an un-ticked open decide by. Test seam below. */
let _clock: Date | undefined;
export function cycleNow(): Date {
  return _clock ? new Date(_clock.getTime()) : new Date();
}
/** Test seam: pin `cycleNow()` (POST /api/cycle/advance, `openCycle`'s sweep). Production never sets it. */
export function __setCycleClockForTests(d?: Date): void {
  _clock = d;
}

type CadenceOverride = { setting: Cadence; live: MarketplaceCycle | null; pending?: PendingSwitch | null };
let _override: CadenceOverride | undefined;
export function __setCadenceOverrideForTests(o?: CadenceOverride): void {
  _override = o;
}

/**
 * Resolve `tenantId`'s cadence state at `now`: its setting (own row, else the platform's) and ITS OWN
 * running cycle. `tenantId` null (no tenant scope) = the platform setting with nothing running.
 * `opts.setting` overrides the stored row.
 */
export async function resolveCadence(
  now: Date,
  tenantId: string | null,
  database: Db = defaultDb,
  opts: { setting?: Cadence } = {},
): Promise<CadenceState> {
  if (_override) return cadenceStateFrom(now, _override.setting, _override.live, _override.pending ?? null);
  const policy = await readCadencePolicy(database, tenantId, now);
  const setting = opts.setting ?? policy.setting;
  return cadenceStateFrom(now, setting, await readLiveCycle(database, tenantId, now), opts.setting ? null : policy.pending);
}

/**
 * The comparator the period gate needs (host/cycle-eligibility.ts `periodClosedSql`):
 * `off` → no gate at all; otherwise the current period's kind and start.
 */
export type PeriodGate = { mode: 'off' } | { mode: 'on'; kind: PeriodKind; start: Date };

export function gateOf(state: CadenceState): PeriodGate {
  return state.current ? { mode: 'on', kind: state.current.kind, start: state.current.start } : { mode: 'off' };
}

/** Convenience: `tenantId`'s gate at `now`. */
export async function currentPeriodGate(now: Date, tenantId: string | null, database: Db = defaultDb): Promise<PeriodGate> {
  return gateOf(await resolveCadence(now, tenantId, database));
}
