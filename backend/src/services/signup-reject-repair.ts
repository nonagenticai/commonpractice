// src/services/signup-reject-repair.ts — carrying out a REJECTED signup's cleanup, and finishing it.
//
// A reject has something to undo when an earlier approve of the same signup aborted half-way
// (`approval_claim_lost`, routes/onboarding.ts `HeldApprovalClaim`):
//   • `new_tenant` — the approve FOUNDED a workspace and seated the requester in it: the whole
//     workspace is offboarded (tenant licence + seats revoked) and the realm identity CP minted for
//     the requester is retired (services/offboarding.ts `offboardRejectedSignupWorkspace`);
//   • `existing`   — the approve SEATED the requester in a customer workspace or sent them an invite
//     there (`signup_approvals.approve_effects`): exactly that seat / invite is revoked (and an
//     identity CP minted for that invite retired), nothing else in the customer's workspace.
//
// ⛔ WHY THIS IS NOT "REJECT AGAIN". The first fix made rejecting an already-rejected signup re-run the
// cleanup, which nobody could reach: the /onboarding screen lists only pending rows and Telegram
// answers `already_decided` for a decided one. So a 502 `signup_reject_offboard_failed` left the
// tenant licence and the seat live and the minted identity enabled, forever. Now the state is ON THE
// ROW (`reject_repair`, 0122), the onboarding-integrity tick finishes every `pending` one on its own
// (host/onboarding-integrity.ts `repairRejectedSignups`), and the screen lists the rows that still
// need it with a Retry (which is the same function).
//
// ⛔ `done` MEANS VERIFIED GONE. `offboardTenantFully` reports partial failures WITHOUT throwing (seat
// revokes, the local-llm inference licence, bundle licences, the central archive, IdP disables) and
// stamps `offboarded_at` regardless — after which nothing re-adopts the tenant. Every such residual
// keeps the row `pending` (`offboardResiduals`); the re-run re-attempts them (each step is idempotent
// on an offboarded tenant). The `done` write is also conditional on `approve_effects` being exactly
// what this run revoked, and every write on still holding the lease (`leaseToken`). Bounded:
// REJECT_REPAIR_MAX_ATTEMPTS failures → `failed` (audited, listed; Retry resets it). ANY throw of a
// run — not only a step's — goes through that bounded path, and the claim itself counts the attempt
// and pushes `nextAttemptAt` out, so even a run that cannot record its error (DB down) is retried at
// the backoff, never every tick. A `failed` / `blocked` row whose cause is permanent is closed by a
// super_admin with a note (`resolved_manually`, `resolveRejectRepairManually`), audited.
//
// ⛔ NEVER DESTRUCTIVE PAST A BLOCKER. Before each run the founded workspace is re-checked with
// `signupWorkspaceBlockers`: another member, somebody else's invite or anything a person made → the
// row goes `blocked` (audited, shown on the screen) and nothing more is done; the tick does not retry
// a blocked row, a super_admin's Retry re-checks it.
//
// ONE RUNNER AT A TIME: a short lease (`claimedUntil`) taken by one conditional UPDATE. A second
// caller (the screen's reject racing Telegram's, or either racing the tick) finds it held and
// answers `in_progress` — the cleanup IS being carried out, which is success, not a 502. Likewise a
// licences `licence_busy` (another licence operation on the tenant — typically that other runner) is
// treated as in flight: the row stays `pending` and the tick confirms it.
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, signupApprovals, users, withTenantDb, withTenantTransaction } from '../db/client';
import { tenantInvites, type SignupApproveEffect, type SignupRejectRepair } from '../db/schema';
import { log } from '../host/logger';
import { recordAudit } from '../host/audit-service';
import { isLicenceBusy, revokeMemberEntitlement } from './license-provisioning';
import {
  offboardOneUser,
  offboardRejectedSignupWorkspace,
  retireMintedIdentityUnlessReferenced,
  signupWorkspaceBlockers,
  type OffboardActor,
  type OffboardTenantResult,
  type RejectedSignupOffboard,
} from './offboarding';
import { tenantFoundedByApproval } from './tenant-provisioning';

type SignupApprovalRow = typeof signupApprovals.$inferSelect;

/** How long one run may hold the row before another may take it over (a dead runner). */
export const REJECT_REPAIR_LEASE_MS = 3 * 60_000;
/** Backoff of the tick's retries: 5 min, doubling, capped. */
const RETRY_BASE_MS = 5 * 60_000;
const RETRY_CAP_MS = 6 * 60 * 60_000;
/** After this many failed attempts the row goes `failed`: the tick stops, a super_admin's Retry resets it. */
export const REJECT_REPAIR_MAX_ATTEMPTS = 10;

/** The tick's retry delay after `attempts` attempts (5 min, doubling, capped at 6 h). */
export function rejectRepairBackoffMs(attempts: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(Math.max(attempts, 1) - 1, 10));
}

/**
 * Machine codes of a failed run (`lastErrorCodes`), one per cause — the onboarding screen shows
 * guidance per code (frontend `admin_onboarding_repair_code_<code>`). Keep the two lists in step.
 */
export const REJECT_REPAIR_ERROR_CODES = [
  'owner_unknown', // central archive skipped: the licences registry returned no owner for the tenant
  'owner_lookup_failed', // central archive skipped: the owner lookup itself failed
  'archive_failed', // the central archive call failed
  'seat_failed', // a member seat still active upstream
  'licence_failed', // the inference (local-llm) licence or a bundle licence still active
  'idp_failed', // an IdP still enabled in Keycloak
  'identity_failed', // the realm identity CP minted could not be retired
  'effect_failed', // an existing-mode seat / invite could not be revoked
  'offboard_failed', // the workspace offboard threw
  'internal', // anything else the run threw (a lookup, the blocker check, a DB write)
] as const;
export type RejectRepairErrorCode = (typeof REJECT_REPAIR_ERROR_CODES)[number];

/** The `reject_repair` a reject records when there is something to undo (null otherwise). */
export function initialRejectRepair(foundedTenantId: string | null): SignupRejectRepair {
  return {
    state: 'pending',
    tenantId: foundedTenantId,
    attempts: 0,
    lastAttemptAt: null,
    nextAttemptAt: new Date().toISOString(),
    lastError: null,
  };
}

/** Does this signup need a cleanup when rejected? (an aborted approve left a workspace or a seat/invite) */
export function hasApproveEffects(row: Pick<SignupApprovalRow, 'approve_effects'>): boolean {
  return Array.isArray(row.approve_effects) && row.approve_effects.length > 0;
}

export interface RejectRepairActor {
  /** Who triggered the run — the super_admin, the Telegram decider, or the tick (`null` → System). */
  actorId: string | null;
  /** `telegram:<id>` / `onboarding-integrity` — for the audit row. */
  operator: string | null;
  via: 'signup.reject' | 'signup.reject_retry' | 'onboarding-integrity';
  /** Extra audit metadata (the decider's). */
  metadata?: Record<string, unknown>;
}

export interface RejectRepairOutcome {
  /** done · pending (failed this time; the tick retries) · failed (gave up after
   *  REJECT_REPAIR_MAX_ATTEMPTS; only a super_admin's Retry runs it again) · blocked · in_progress
   *  (another runner holds it, licences is busy with it, or a new approve effect landed during the
   *  run) · none (nothing to repair on this row). */
  state: 'done' | 'pending' | 'failed' | 'blocked' | 'in_progress' | 'none';
  tenantId: string | null;
  error: string | null;
  blockers: string[];
  offboard: RejectedSignupOffboard | null;
  keycloakIdentity: string | null;
  /** What the existing-mode cleanup revoked (`seat:<user>`, `invite:<id>`, `identity:<sub>=<result>`). */
  effectsRevoked: string[];
  /** Attempts so far (set on a failure). */
  attempts?: number;
  /** What the aborted approve left behind, by kind: the workspace it FOUNDED, and the seats / invites
   *  an `existing`-mode approve made in a customer workspace (the Telegram note names them). */
  undid?: { workspace: boolean; seats: number; invites: number };
}

function outcome(state: RejectRepairOutcome['state'], extra: Partial<RejectRepairOutcome> = {}): RejectRepairOutcome {
  return {
    state,
    tenantId: null,
    error: null,
    blockers: [],
    offboard: null,
    keycloakIdentity: null,
    effectsRevoked: [],
    ...extra,
  };
}

/**
 * Take the run lease on a rejected row whose repair is `pending` — or, for a super_admin's Retry
 * (`manual`), also `blocked` / `failed`. Null = not ours to run: nothing to repair, already done, or
 * held. The lease is a fresh random `leaseToken` + `claimedUntil`: every later write of this run is
 * conditional on the token, so a runner whose lease lapsed (and was taken over) can never overwrite
 * the newer runner's state.
 */
async function claimRepair(id: string, manual: boolean): Promise<{ row: SignupApprovalRow; lease: string } | null> {
  const states = manual ? sql`('pending','blocked','failed')` : sql`('pending')`;
  const lease = randomUUID();
  const rr = signupApprovals.reject_repair;
  // ⛔ THE ATTEMPT IS COUNTED, AND THE NEXT ONE SCHEDULED, BY THE CLAIM ITSELF. A run that dies — or
  // cannot even record its error (DB gone) — releases nothing; its lease lapses after
  // REJECT_REPAIR_LEASE_MS, and without this the tick would take the row again on its next pass, at
  // the same count, forever. With it the row is not due before the backoff of this attempt, and the
  // count still climbs to the cap. Every write the run makes afterwards overwrites both.
  // A super_admin's Retry of a `failed` row starts the count again.
  const attempts = manual
    ? sql`(CASE WHEN ${rr}->>'state' = 'failed' THEN 1 ELSE coalesce((${rr}->>'attempts')::int, 0) + 1 END)`
    : sql`(coalesce((${rr}->>'attempts')::int, 0) + 1)`;
  const [row] = await db
    .update(signupApprovals)
    .set({
      reject_repair: sql`${rr} || jsonb_build_object(
        'claimedUntil', to_jsonb(now() + make_interval(secs => ${REJECT_REPAIR_LEASE_MS / 1000})),
        'leaseToken', ${lease}::text,
        'attempts', ${attempts},
        'lastAttemptAt', to_jsonb(now()),
        'nextAttemptAt', to_jsonb(now() + make_interval(secs => least(${RETRY_CAP_MS / 1000}::double precision,
          ${RETRY_BASE_MS / 1000}::double precision * power(2, least(${attempts} - 1, 10))))))`,
    })
    .where(
      and(
        eq(signupApprovals.id, id),
        eq(signupApprovals.status, 'rejected'),
        sql`${signupApprovals.reject_repair}->>'state' IN ${states}`,
        sql`coalesce((${signupApprovals.reject_repair}->>'claimedUntil')::timestamptz, '-infinity') <= now()`,
      ),
    )
    .returning();
  return row ? { row, lease } : null;
}

/**
 * Write this run's result and release the lease — ONLY while this run still holds it (`leaseToken`),
 * and, for `done`, only while `approve_effects` is exactly the snapshot the run worked from
 * (`effects`). False = not written: the lease was taken over, or an aborting approve recorded a NEW
 * effect (a seat / an invite) during this run, which this run never revoked.
 */
/** Test seam: make every result write throw (the DB gone mid-run). */
let writeFault: (() => void) | null = null;
export function __setRejectRepairWriteFaultForTests(fn?: () => void): void {
  writeFault = fn ?? null;
}

async function writeRepair(
  id: string,
  lease: string,
  rec: SignupRejectRepair,
  guard: { effects?: SignupApprovalRow['approve_effects'] } = {},
): Promise<boolean> {
  writeFault?.();
  const conds = [
    eq(signupApprovals.id, id),
    sql`${signupApprovals.reject_repair}->>'leaseToken' = ${lease}`,
  ];
  if (guard.effects !== undefined) {
    conds.push(
      sql`${signupApprovals.approve_effects} IS NOT DISTINCT FROM ${guard.effects === null ? null : JSON.stringify(guard.effects)}::jsonb`,
    );
  }
  const written = await db
    .update(signupApprovals)
    .set({ reject_repair: { ...rec, claimedUntil: null, leaseToken: null } })
    .where(and(...conds))
    .returning({ id: signupApprovals.id });
  return written.length > 0;
}

/**
 * Everything `offboardTenantFully` reports as NOT done without throwing — each one a live credential,
 * seat or registry tenant left behind: a member seat still active upstream, the inference-router
 * (local-llm) licence, the central archive (failed, or skipped because ownership could not be
 * determined), a bundle licence still active, an IdP still enabled in Keycloak. Empty = all settled.
 * Re-running the offboard retries exactly these (every step is idempotent on an offboarded tenant).
 */
export function offboardResiduals(o: OffboardTenantResult): string[] {
  const out: string[] = [];
  for (const f of o.seatFailures) out.push(`seat ${f.email}: ${f.message}`);
  if (o.inferenceRevokeError) out.push(`inference licence: ${o.inferenceRevokeError}`);
  for (const f of o.residualLicenceFailures) {
    out.push(`licence ${f.licenseId ?? '(list)'}${f.appKey ? `/${f.appKey}` : ''}: ${f.message}`);
  }
  if (o.archiveFailure) out.push(`central archive: ${o.archiveFailure}`);
  else if (o.archiveSkipUncertain) out.push(`central archive not attempted: ${o.archiveSkipped ?? 'ownership unknown'}`);
  for (const f of o.idpDisableFailures) out.push(`idp ${f.alias}: ${f.message}`);
  return out;
}

/** The codes of `offboardResiduals` (same order of concern; duplicates removed by the caller). */
export function offboardResidualCodes(o: OffboardTenantResult): RejectRepairErrorCode[] {
  const out: RejectRepairErrorCode[] = [];
  if (o.seatFailures.length > 0) out.push('seat_failed');
  if (o.inferenceRevokeError || o.residualLicenceFailures.length > 0) out.push('licence_failed');
  if (o.archiveFailure) out.push('archive_failed');
  else if (o.archiveSkipUncertain) {
    out.push((o.archiveSkipped ?? 'owner_unknown').startsWith('owner_unknown') ? 'owner_unknown' : 'owner_lookup_failed');
  }
  if (o.idpDisableFailures.length > 0) out.push('idp_failed');
  return out;
}

/** Test seam: the founded-workspace lookup (to inject a throw OUTSIDE the per-step try blocks). */
let foundedLookup: typeof tenantFoundedByApproval = tenantFoundedByApproval;
export function __setRejectRepairFoundedLookupForTests(fn?: typeof tenantFoundedByApproval): void {
  foundedLookup = fn ?? tenantFoundedByApproval;
}

/** Test seam: the founded-workspace offboard (to inject partial failures). */
let offboardWorkspace: typeof offboardRejectedSignupWorkspace = offboardRejectedSignupWorkspace;
export function __setRejectedSignupOffboardForTests(fn?: typeof offboardRejectedSignupWorkspace): void {
  offboardWorkspace = fn ?? offboardRejectedSignupWorkspace;
}

/** What the approve left behind, by kind — for the Telegram note's wording. */
function undoneKinds(founded: string | null, effects: SignupApprovalRow['approve_effects']): RejectRepairOutcome['undid'] {
  const list = Array.isArray(effects) ? effects : [];
  return {
    workspace: founded !== null,
    seats: list.filter((e) => e.seatedUserId).length,
    invites: list.filter((e) => e.inviteId).length,
  };
}

/**
 * Run (or re-run) the cleanup of rejected signup `approvalId`. Idempotent; never throws for a cleanup
 * failure (the outcome and the row say what happened). `includeBlocked` (a super_admin's Retry)
 * re-checks a `blocked` row and resets a `failed` one (the tick does neither).
 */
export async function repairRejectedSignup(
  approvalId: string,
  actor: RejectRepairActor,
  opts: { includeBlocked?: boolean; audit?: boolean } = {},
): Promise<RejectRepairOutcome> {
  const manual = opts.includeBlocked === true;
  const claim = await claimRepair(approvalId, manual);
  if (!claim) {
    const [now] = await db
      .select({ status: signupApprovals.status, rr: signupApprovals.reject_repair })
      .from(signupApprovals)
      .where(eq(signupApprovals.id, approvalId))
      .limit(1);
    const rr = now?.rr ?? null;
    if (!rr) return outcome('none');
    if (rr.state === 'done') return outcome('done', { tenantId: rr.tenantId, keycloakIdentity: rr.keycloakIdentity ?? null });
    // Closed by a super_admin: nothing left for any runner to do.
    if (rr.state === 'resolved_manually') return outcome('none', { tenantId: rr.tenantId });
    if (rr.state === 'blocked' && !manual) {
      return outcome('blocked', { tenantId: rr.tenantId, blockers: rr.blockers ?? [] });
    }
    if (rr.state === 'failed' && !manual) {
      return outcome('failed', { tenantId: rr.tenantId, error: rr.lastError, attempts: rr.attempts });
    }
    // Held by another runner right now: it is being carried out.
    return outcome('in_progress', { tenantId: rr.tenantId });
  }
  try {
    return await runClaimedRepair(approvalId, claim, actor, opts);
  } catch (err) {
    // ⛔ ANY throw of the run — the founded-workspace lookup, the blocker check, a DB write, an audit —
    // goes through the SAME bounded error path as a step's failure: attempts counted (by the claim),
    // backoff, `failed` at the cap. Before, these skipped the counter and `nextAttemptAt`, so the
    // row was taken again every tick after the lease lapsed and never reached `failed`.
    const prev = claim.row.reject_repair!;
    const message = err instanceof Error ? err.message : String(err);
    let recorded: RejectRepairOutcome | null;
    try {
      recorded = await recordFailure({
        approvalId,
        lease: claim.lease,
        row: claim.row,
        actor,
        opts,
        base: { ...prev, claimedUntil: null },
        attempts: prev.attempts,
        founded: prev.tenantId,
        error: `internal: ${message}`,
        codes: ['internal'],
        offboard: null,
        keycloakIdentity: prev.keycloakIdentity ?? null,
        effectsRevoked: [],
        undid: undefined,
      });
    } catch (recordErr) {
      // Not even the error could be recorded (DB down). Release nothing: the lease lapses on its own,
      // and the claim already set `nextAttemptAt` to this attempt's backoff — never a hot loop.
      log.error('signup_reject_repair_record_failed', {
        component: 'signup-reject-repair',
        approvalId,
        err: recordErr,
        cause: message,
      });
      throw err;
    }
    // Not written: the lease is gone — taken over, or released by this run's own final write (a throw
    // AFTER it, e.g. its audit). Either way the row says what is true; surface the throw as before.
    if (!recorded) throw err;
    return recorded;
  }
}

async function runClaimedRepair(
  approvalId: string,
  claim: { row: SignupApprovalRow; lease: string },
  actor: RejectRepairActor,
  opts: { includeBlocked?: boolean; audit?: boolean },
): Promise<RejectRepairOutcome> {
  const { row, lease } = claim;
  const prev = row.reject_repair!;
  const now = new Date();
  // Counted by the claim (a super_admin's Retry of a `failed` row restarted it at 1).
  const attempts = prev.attempts;
  const prevAttempts = attempts - 1;
  // The workspace may have been founded AFTER the reject recorded `tenantId` (never, by the claim
  // rules — but a lookup costs nothing): the NEWEST founding of this approval is the one to undo.
  const founded = (await foundedLookup(approvalId, { includeOffboarded: true })) ?? prev.tenantId;
  const undid = undoneKinds(founded, row.approve_effects);
  /** The lease was taken over (this run outlived it): the other runner owns the row now. */
  const leaseLost = () => {
    log.warn('signup_reject_repair_lease_lost', { component: 'signup-reject-repair', approvalId, tenantId: founded });
    return outcome('in_progress', { tenantId: founded, undid });
  };

  const base: SignupRejectRepair = {
    ...prev,
    tenantId: founded,
    attempts,
    lastAttemptAt: now.toISOString(),
    claimedUntil: null,
  };

  // ⛔ The blocker re-check, BEFORE anything destructive.
  if (founded) {
    const blockers = await signupWorkspaceBlockers(founded, row.email);
    if (blockers.length > 0) {
      const changed = prev.state !== 'blocked' || JSON.stringify(prev.blockers ?? []) !== JSON.stringify(blockers);
      if (
        !(await writeRepair(approvalId, lease, {
          ...base,
          // Not an attempt: nothing was tried (a Retry of a blocked row, or the tick finding the
          // workspace in use). The attempt the claim counted is given back, as on the busy path —
          // else repeated Retries of a blocked row eat the budget and its first real error goes
          // straight to `failed`.
          attempts: prevAttempts,
          state: 'blocked',
          blockers,
          nextAttemptAt: null,
          lastError: null,
          lastErrorCodes: [],
        }))
      ) {
        return leaseLost();
      }
      log.warn('signup_reject_repair_blocked', { component: 'signup-reject-repair', approvalId, tenantId: founded, blockers });
      if (changed) await auditRepair(row, actor, 'blocked', { tenantId: founded, blockers });
      return outcome('blocked', { tenantId: founded, blockers, undid });
    }
  }

  let offboard: RejectedSignupOffboard | null = null;
  let error: string | null = null;
  const codes: RejectRepairErrorCode[] = [];
  let busy = false;
  if (founded) {
    try {
      offboard = await offboardWorkspace(
        founded,
        row.email,
        { actorId: actor.actorId, operator: actor.operator, via: actor.via } satisfies OffboardActor,
        approvalId,
      );
      // ⛔ `offboardTenantFully` reports what it could NOT do without throwing (a seat still active
      // upstream, the local-llm inference licence, the central archive, a bundle licence, an IdP). The
      // tenant now carries `offboarded_at`, so nothing would ever adopt it again: any of these left
      // unreported here would live forever. They keep the row `pending`; the re-run retries them.
      const residuals = offboardResiduals(offboard.offboard);
      codes.push(...offboardResidualCodes(offboard.offboard));
      // An identity that could not be retired is NOT done: it may still be enabled.
      if (offboard.keycloakIdentity.startsWith('failed')) {
        residuals.push(`identity: ${offboard.keycloakIdentity}`);
        codes.push('identity_failed');
      }
      if (residuals.length > 0) error = residuals.join('; ');
    } catch (err) {
      if (isLicenceBusy(err)) busy = true;
      else {
        error = err instanceof Error ? err.message : String(err);
        codes.push('offboard_failed');
      }
    }
  }

  const effectsRevoked: string[] = [];
  if (!busy && hasApproveEffects(row)) {
    for (const effect of row.approve_effects!) {
      try {
        effectsRevoked.push(...(await revokeApproveEffect(row, effect)));
      } catch (err) {
        if (isLicenceBusy(err)) busy = true;
        else {
          const message = err instanceof Error ? err.message : String(err);
          error = [error, `effect ${effect.tenantId}: ${message}`].filter(Boolean).join('; ');
          codes.push(message.startsWith('identity:') ? 'identity_failed' : 'effect_failed');
        }
      }
    }
  }

  const keycloakIdentity = offboard?.keycloakIdentity ?? prev.keycloakIdentity ?? null;
  if (busy && !error) {
    // In flight elsewhere (the other runner's licence operation). Not a failure: the row stays
    // `pending`, due after one base delay, and the next tick confirms it — never a 502 for a cleanup
    // under way. The attempt the claim counted is given back.
    const wrote = await writeRepair(approvalId, lease, {
      ...base,
      attempts: prevAttempts,
      state: 'pending',
      keycloakIdentity,
      nextAttemptAt: new Date(now.getTime() + RETRY_BASE_MS).toISOString(),
    });
    if (!wrote) return leaseLost();
    return outcome('in_progress', { tenantId: founded, offboard, keycloakIdentity, effectsRevoked, undid });
  }
  if (error) {
    const failed = await recordFailure({
      approvalId,
      lease,
      row,
      actor,
      opts,
      base,
      attempts,
      founded,
      error,
      codes,
      offboard,
      keycloakIdentity,
      effectsRevoked,
      undid,
    });
    return failed ?? leaseLost();
  }
  // ⛔ `done` ONLY for the effects this run actually undid: conditional on `approve_effects` being the
  // snapshot it worked from. An aborting approve may record a NEW seat / invite while this run holds
  // the lease (`recordApproveEffect` leaves a held `pending` row alone) — then the row stays `pending`,
  // due at once, and the next run revokes it.
  const doneRec: SignupRejectRepair = {
    ...base,
    state: 'done',
    blockers: [],
    keycloakIdentity,
    lastError: null,
    lastErrorCodes: [],
    nextAttemptAt: null,
  };
  if (!(await writeRepair(approvalId, lease, doneRec, { effects: row.approve_effects ?? null }))) {
    const requeued = await writeRepair(approvalId, lease, {
      ...base,
      state: 'pending',
      keycloakIdentity,
      lastError: null,
      lastErrorCodes: [],
      nextAttemptAt: new Date().toISOString(),
    });
    if (!requeued) return leaseLost();
    log.warn('signup_reject_repair_effects_changed', {
      component: 'signup-reject-repair',
      approvalId,
      tenantId: founded,
      remediation: 'an approve recorded a new seat / invite during this run; it stays pending and the next run revokes it',
    });
    return outcome('in_progress', { tenantId: founded, offboard, keycloakIdentity, effectsRevoked, undid });
  }
  if (opts.audit !== false) {
    await auditRepair(row, actor, 'done', { tenantId: founded, offboard, keycloakIdentity, effectsRevoked });
  }
  return outcome('done', { tenantId: founded, offboard, keycloakIdentity, effectsRevoked, undid });
}

/**
 * ⛔ BOUNDED. Record a failed run: `pending` with this attempt's backoff, or — at
 * REJECT_REPAIR_MAX_ATTEMPTS — `failed` (the tick stops; listed on the onboarding screen + audited; a
 * super_admin's Retry resets the count, or Resolve closes it). Null = not written (lease lost).
 */
async function recordFailure(f: {
  approvalId: string;
  lease: string;
  row: SignupApprovalRow;
  actor: RejectRepairActor;
  opts: { audit?: boolean };
  base: SignupRejectRepair;
  attempts: number;
  founded: string | null;
  error: string;
  codes: RejectRepairErrorCode[];
  offboard: RejectedSignupOffboard | null;
  keycloakIdentity: string | null;
  effectsRevoked: string[];
  undid: RejectRepairOutcome['undid'];
}): Promise<RejectRepairOutcome | null> {
  const { approvalId, row, actor, attempts, founded, error, offboard, keycloakIdentity, effectsRevoked, undid } = f;
  const prev = row.reject_repair!;
  const gaveUp = attempts >= REJECT_REPAIR_MAX_ATTEMPTS;
  const lastErrorCodes = [...new Set(f.codes)];
  const wrote = await writeRepair(approvalId, f.lease, {
    ...f.base,
    attempts,
    state: gaveUp ? 'failed' : 'pending',
    blockers: [],
    keycloakIdentity,
    lastError: error.slice(0, 500),
    lastErrorCodes,
    nextAttemptAt: gaveUp ? null : new Date(Date.now() + rejectRepairBackoffMs(attempts)).toISOString(),
  });
  if (!wrote) return null;
  const failCtx = { component: 'signup-reject-repair', approvalId, tenantId: founded, attempts, error, codes: lastErrorCodes };
  if (gaveUp) {
    log.error('signup_reject_repair_gave_up', {
      ...failCtx,
      remediation:
        'the rejected signup still holds a live tenant licence / seat / identity and the tick stopped ' +
        'retrying; fix the cause, then Retry it on the onboarding screen (or Resolve it there if the cause is permanent)',
    });
  } else {
    log.error('signup_reject_repair_failed', {
      ...failCtx,
      remediation:
        'the rejected signup still holds a live tenant licence / seat / identity; the onboarding-integrity ' +
        'tick retries it, or Retry it on the onboarding screen',
    });
  }
  if (gaveUp || (f.opts.audit !== false && error !== prev.lastError)) {
    await auditRepair(row, actor, gaveUp ? 'gave_up' : 'failed', {
      tenantId: founded,
      error,
      offboard,
      keycloakIdentity,
      effectsRevoked,
      attempts,
    });
  }
  const state = gaveUp ? 'failed' : 'pending';
  return outcome(state, { tenantId: founded, error, offboard, keycloakIdentity, effectsRevoked, attempts, undid });
}

/**
 * Codes of a `failed` run that leave NOTHING live for the rejected requester: only the central
 * registry archive was not done (the seats, licences, IdPs and the identity were). Every other code —
 * and a `failed` row with no codes (written before codes existed: unknown, so assumed live) — means a
 * seat, a licence, an IdP, the Keycloak identity or the whole workspace may still be live.
 */
const REGISTRY_ONLY_CODES: readonly RejectRepairErrorCode[] = ['owner_unknown', 'owner_lookup_failed', 'archive_failed'];

/**
 * ⛔ Would closing this cleanup by hand leave the rejected requester's ACCESS live? `blocked` (the
 * offboard never ran: the founded workspace, the requester's seat + licence and the Keycloak identity
 * are all live), or `failed` with any cause other than the registry archive (seat_failed,
 * licence_failed, idp_failed, identity_failed, effect_failed, offboard_failed, internal) or with no
 * recorded cause. `resolved_manually` is terminal — the tick never revisits it — so a resolve of such
 * a row must be an explicit, acknowledged decision (`acknowledgeLiveAccess`), never a generic note.
 */
export function rejectRepairLeavesLiveAccess(
  rr: Pick<SignupRejectRepair, 'state' | 'lastErrorCodes'> | null | undefined,
): boolean {
  if (!rr) return false;
  if (rr.state === 'blocked') return true;
  if (rr.state !== 'failed') return false;
  const codes = rr.lastErrorCodes ?? [];
  return codes.length === 0 || codes.some((c) => !(REGISTRY_ONLY_CODES as readonly string[]).includes(c));
}

/** The same predicate in SQL, over a `reject_repair` column — the resolve's gate is atomic with its write. */
function leavesLiveAccessSql(rr: typeof signupApprovals.reject_repair) {
  return sql`(${rr}->>'state' = 'blocked' OR (${rr}->>'state' = 'failed' AND (
    -- CASE, not OR: SQL does not promise short-circuit, and the array functions raise on a scalar.
    CASE WHEN coalesce(jsonb_typeof(${rr}->'lastErrorCodes'), 'null') <> 'array' THEN true
         WHEN jsonb_array_length(${rr}->'lastErrorCodes') = 0 THEN true
         ELSE EXISTS (SELECT 1 FROM jsonb_array_elements_text(${rr}->'lastErrorCodes') AS c(code)
                      WHERE c.code NOT IN ('owner_unknown','owner_lookup_failed','archive_failed'))
    END)))`;
}

/** Why a manual resolve was refused: no such row / nothing to resolve in its state / a run holds it /
 *  it would leave the requester's access live and that was not acknowledged. */
export type ResolveRejectRepairResult =
  | { ok: true; row: SignupApprovalRow; leavesLiveAccess: boolean }
  | {
      ok: false;
      reason: 'not_found' | 'not_resolvable' | 'in_progress' | 'live_access_unacknowledged';
      state: string | null;
    };

/**
 * A super_admin closes a rejected signup's cleanup that cannot finish on its own — a `failed` row
 * whose cause is permanent (the registry has no owner for the tenant, an identity Keycloak will not
 * retire) or a `blocked` one they decided to keep — with a required note. Terminal
 * (`resolved_manually`): the tick never runs it, Retry is a no-op, the screen stops listing it. The
 * note, the actor and the error it was closed on are kept on the row and in the audit log.
 * Conditional on the state and on no run holding the lease (a run in flight → `in_progress`).
 */
export async function resolveRejectRepairManually(
  approvalId: string,
  actor: { actorId: string | null; actorSub: string },
  note: string,
  opts: { acknowledgeLiveAccess?: boolean } = {},
): Promise<ResolveRejectRepairResult> {
  const rr = signupApprovals.reject_repair;
  const ack = opts.acknowledgeLiveAccess === true;
  const [row] = await db
    .update(signupApprovals)
    .set({
      reject_repair: sql`${rr} || jsonb_build_object(
        'state', 'resolved_manually',
        'nextAttemptAt', NULL, 'claimedUntil', NULL, 'leaseToken', NULL,
        'resolution', jsonb_build_object(
          'note', ${note}::text,
          'actorId', ${actor.actorId}::text,
          'actorSub', ${actor.actorSub}::text,
          'at', to_jsonb(now()),
          'priorState', ${rr}->'state',
          'attempts', coalesce(${rr}->'attempts', '0'::jsonb),
          'lastError', ${rr}->'lastError',
          'lastErrorCodes', coalesce(${rr}->'lastErrorCodes', '[]'::jsonb),
          'blockers', coalesce(${rr}->'blockers', '[]'::jsonb),
          'leavesLiveAccess', ${leavesLiveAccessSql(rr)}))`,
    })
    .where(
      and(
        eq(signupApprovals.id, approvalId),
        eq(signupApprovals.status, 'rejected'),
        sql`${rr}->>'state' IN ('failed','blocked')`,
        sql`coalesce((${rr}->>'claimedUntil')::timestamptz, '-infinity') <= now()`,
        // ⛔ Without the acknowledgement, a row whose resolve leaves the requester's access live is
        // NOT written — in the same statement, so a state change between a check and the write
        // cannot slip one through.
        ...(ack ? [] : [sql`NOT ${leavesLiveAccessSql(rr)}`]),
      ),
    )
    .returning();
  if (!row) {
    const [cur] = await db
      .select({ status: signupApprovals.status, rr: signupApprovals.reject_repair })
      .from(signupApprovals)
      .where(eq(signupApprovals.id, approvalId))
      .limit(1);
    if (!cur) return { ok: false, reason: 'not_found', state: null };
    const state = cur.status === 'rejected' ? (cur.rr?.state ?? null) : null;
    const held =
      (state === 'failed' || state === 'blocked') &&
      cur.rr?.claimedUntil != null &&
      Date.parse(cur.rr.claimedUntil) > Date.now();
    if (held) return { ok: false, reason: 'in_progress', state };
    if (!ack && (state === 'failed' || state === 'blocked') && rejectRepairLeavesLiveAccess(cur.rr)) {
      return { ok: false, reason: 'live_access_unacknowledged', state };
    }
    return { ok: false, reason: 'not_resolvable', state };
  }
  const res = row.reject_repair!.resolution!;
  const leavesLiveAccess = res.leavesLiveAccess === true;
  const tenantId = row.reject_repair!.tenantId;
  log.warn('signup_reject_repair_resolved_manually', {
    component: 'signup-reject-repair',
    approvalId,
    tenantId: row.reject_repair!.tenantId,
    actorSub: actor.actorSub,
    priorState: res.priorState,
    lastErrorCodes: res.lastErrorCodes,
    leavesLiveAccess,
  });
  await recordAudit({
    actorId: actor.actorId,
    action: 'signup.reject_repair_resolved',
    category: 'auth',
    targetType: 'user',
    targetId: row.email,
    result: leavesLiveAccess ? 'resolved — access left live' : 'resolved manually',
    resultTone: 'warn',
    ...(tenantId ? { tenantId } : {}),
    metadata: {
      leavesLiveAccess,
      tenantId,
      requesterEmail: row.email,
      approvalId,
      actorSub: actor.actorSub,
      note: res.note,
      priorState: res.priorState,
      attempts: res.attempts,
      lastError: res.lastError,
      lastErrorCodes: res.lastErrorCodes,
      blockers: res.blockers,
      foundedTenantId: row.reject_repair!.tenantId,
      keycloakIdentity: row.reject_repair!.keycloakIdentity ?? null,
    },
  });
  return { ok: true, row, leavesLiveAccess };
}

async function auditRepair(
  row: SignupApprovalRow,
  actor: RejectRepairActor,
  result: 'done' | 'failed' | 'gave_up' | 'blocked',
  d: {
    tenantId: string | null;
    error?: string | null;
    blockers?: string[];
    offboard?: RejectedSignupOffboard | null;
    keycloakIdentity?: string | null;
    effectsRevoked?: string[];
    attempts?: number;
  },
): Promise<void> {
  await recordAudit({
    actorId: actor.actorId,
    action: 'signup.reject_repair',
    category: 'auth',
    targetType: 'user',
    targetId: row.email,
    result:
      result === 'done'
        ? 'offboarded'
        : result === 'blocked'
          ? 'blocked: workspace in use'
          : result === 'gave_up'
            ? `gave up after ${d.attempts ?? '?'} attempts`
            : 'offboard failed',
    resultTone: result === 'done' ? 'ok' : 'warn',
    ...(d.tenantId ? { tenantId: d.tenantId } : {}),
    metadata: {
      approvalId: row.id,
      via: actor.via,
      operator: actor.operator,
      ...(actor.metadata ?? {}),
      foundedTenantId: d.tenantId,
      workspaceOffboarded: d.offboard != null,
      offboardError: d.error ?? null,
      blockers: d.blockers ?? [],
      seatFailures: d.offboard?.offboard.seatFailures.length ?? null,
      inferenceRevokeError: d.offboard?.offboard.inferenceRevokeError ?? null,
      centralArchiveError: d.offboard?.offboard.archiveFailure ?? null,
      residualLicenceRevokeFailed: d.offboard?.offboard.residualLicenceFailures.length ?? null,
      idpDisableFailed: d.offboard?.offboard.idpDisableFailures.length ?? null,
      ...(d.attempts !== undefined ? { attempts: d.attempts } : {}),
      centralArchiveSkipped: d.offboard?.offboard.archiveSkipped ?? null,
      keycloakIdentity: d.keycloakIdentity ?? null,
      effectsRevoked: d.effectsRevoked ?? [],
    },
  });
}

/**
 * Undo ONE thing an `existing`-mode approve did in a customer workspace — exactly that, never
 * anything else there:
 *   • `seatedUserId` — the seat it created (only while that row is still a live member of THAT
 *     workspace): tombstoned + credentials revoked (`offboardOneUser`) + the licence seat revoked;
 *   • `inviteId` — its invite: revoked while pending; if the person already ACCEPTED it, the seat
 *     that accept created is undone as above. An identity CP minted for that invite is retired
 *     unless something outside the workspace references it.
 */
async function revokeApproveEffect(row: SignupApprovalRow, e: SignupApproveEffect): Promise<string[]> {
  const done: string[] = [];
  const undoSeat = async (userId: string) => {
    // Under THAT workspace's own RLS scope: the seat is a row of it, and nothing outside it is touched.
    const [live] = await withTenantDb(e.tenantId, () =>
      db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.tenant_id, e.tenantId), isNull(users.deleted_at)))
        .limit(1),
    );
    if (live) {
      await withTenantDb(e.tenantId, () => offboardOneUser(userId));
      done.push(`seat:${userId}`);
    }
    // Idempotent; also reaches a seat a previous run tombstoned but could not release.
    await revokeMemberEntitlement(e.tenantId, userId);
  };
  if (e.seatedUserId) await undoSeat(e.seatedUserId);
  if (e.inviteId) {
    const inv = await withTenantTransaction(e.tenantId, async (tx) => {
      const [cur] = await tx
        .select({ status: tenantInvites.status, acceptedBy: tenantInvites.accepted_by, sub: tenantInvites.keycloak_sub })
        .from(tenantInvites)
        .where(and(eq(tenantInvites.id, e.inviteId!), eq(tenantInvites.tenant_id, e.tenantId)))
        .limit(1);
      if (cur?.status === 'pending') {
        await tx
          .update(tenantInvites)
          .set({ status: 'revoked', revoked_at: new Date() })
          .where(and(eq(tenantInvites.id, e.inviteId!), eq(tenantInvites.status, 'pending')));
      }
      return cur ?? null;
    });
    if (inv?.status === 'pending') done.push(`invite:${e.inviteId}`);
    if (inv?.status === 'accepted' && inv.acceptedBy) await undoSeat(inv.acceptedBy);
    if (inv?.sub) {
      const r = await retireMintedIdentityUnlessReferenced(inv.sub, e.tenantId, row.email, row.id);
      if (r.startsWith('failed')) throw new Error(`identity: ${r}`);
      done.push(`identity:${inv.sub}=${r}`);
    }
  }
  return done;
}

/**
 * The onboarding-integrity sweep: every rejected signup whose cleanup is `pending` and due, retried
 * (bounded per tick). `blocked` rows are left for a super_admin (shown on the onboarding screen).
 */
export async function repairRejectedSignups(
  limit = 20,
): Promise<{ adopted: number; attempted: number; done: number; failed: number; blocked: number }> {
  // DETECT what no reject recorded: a rejected signup that still has a LIVE workspace its approve
  // founded (an approve whose createTenant finished after its claim lapsed and the reject landed, or
  // a row rejected before 0122). Marked `pending`, then repaired below like any other.
  const adopted = await db
    .update(signupApprovals)
    .set({
      reject_repair: sql`jsonb_build_object('state', 'pending', 'tenantId', NULL, 'attempts', 0,
        'lastAttemptAt', NULL, 'nextAttemptAt', to_jsonb(now()), 'lastError', NULL)`,
    })
    .where(
      and(
        eq(signupApprovals.status, 'rejected'),
        sql`(${signupApprovals.reject_repair} IS NULL OR ${signupApprovals.reject_repair}->>'state' = 'done')`,
        sql`EXISTS (SELECT 1 FROM tenants t
                     WHERE t.provisioning->>'signupApprovalId' = ${signupApprovals.id}::text
                       AND t.offboarded_at IS NULL)`,
      ),
    )
    .returning({ id: signupApprovals.id });
  for (const { id } of adopted) {
    log.warn('signup_reject_repair_adopted', { component: 'signup-reject-repair', approvalId: id });
  }
  const due = await db
    .select({ id: signupApprovals.id })
    .from(signupApprovals)
    .where(
      and(
        eq(signupApprovals.status, 'rejected'),
        sql`${signupApprovals.reject_repair}->>'state' = 'pending'`,
        sql`coalesce((${signupApprovals.reject_repair}->>'nextAttemptAt')::timestamptz, '-infinity') <= now()`,
        sql`coalesce((${signupApprovals.reject_repair}->>'claimedUntil')::timestamptz, '-infinity') <= now()`,
      ),
    )
    .orderBy(signupApprovals.decided_at)
    .limit(limit);
  const tally = { adopted: adopted.length, attempted: 0, done: 0, failed: 0, blocked: 0 };
  for (const { id } of due) {
    tally.attempted++;
    try {
      const out = await repairRejectedSignup(id, { actorId: null, operator: 'onboarding-integrity', via: 'onboarding-integrity' });
      if (out.state === 'done') tally.done++;
      else if (out.state === 'blocked') tally.blocked++;
      else if (out.state === 'pending' || out.state === 'failed') tally.failed++;
    } catch (err) {
      tally.failed++;
      log.error('signup_reject_repair_sweep_row_failed', { component: 'signup-reject-repair', approvalId: id, err });
    }
  }
  return tally;
}
