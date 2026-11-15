// src/services/inline-seat.ts — seat an unseated member ON THE REQUEST PATH (per-member licensing, 0089).
//
// ⛔ WHY THIS EXISTS. With `LICENSE_GATE_PER_MEMBER` on, a member with no active
// `member_entitlements` row is refused (`402 license_seat_required` at the HTTP gate,
// `seat_required` at the LLM broker). Before this, the ONLY thing that seated such a member was the
// `repairUnseatedMembers` sweep (host/onboarding-integrity.ts) on a 5-minute timer, so flipping the
// gate locked every unseated member — and every new member — out until the next tick. The two
// refusal sites now call `seatMemberInline` once and re-check; they refuse only if seating fails or
// is refused.
//
// SAME RULES AS THE SWEEP, NOT A LOOSER COPY. Eligibility is the sweep's predicate verbatim: a live
// (`deleted_at IS NULL`), non-platform (`role <> 'platform'`) member of THIS tenant with a recorded
// `keycloak_sub` (never mint an unproven subject), in an active, non-offboarded tenant. The mint is
// `ensureMemberEntitlement` itself — so `LICENSE_ISSUANCE_ENABLED` off is `disabled` (refused), a
// tenant-level licence is `tenant_licensed` (nothing minted; the gate's own tenant-level fallback
// admits), the claim lease dedupes across replicas, and a licences refusal (e.g. its seat cap)
// throws and is refused here.
//
// ⚠️ NO `max_members` CHECK HERE, DELIBERATELY. The CP seat cap is enforced when a person JOINS a
// tenant (`services/seat-limit.ts claimSeat*`), and that file states it is never retroactive: an
// existing member already occupies a counted seat. Minting that member's licence adds no CP seat, so
// re-checking the cap here could only lock out someone the cap already admitted.
//
// STAMPEDE GUARDS. A refused member's browser fires several requests at once and retries:
//   • SINGLE-FLIGHT per (tenant, user) in this process — concurrent callers share one attempt (the
//     claim lease in `ensureMemberEntitlement` is the cross-replica half of the same guarantee);
//   • a short NEGATIVE CACHE after a refusal or failure, so a member who cannot be seated costs one
//     attempt per window, not one licences round trip per request.
import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { config } from '../config';
import { db, runAsSystem, tenants, users } from '../db/client';
import { ensureMemberEntitlement } from './license-provisioning';
import { incCounter } from '../host/metrics';
import { log } from '../host/logger';

/** How long a refused / failed inline seat attempt is remembered before the next one is allowed. */
export const INLINE_SEAT_NEGATIVE_TTL_MS = 30_000;
const NEGATIVE_CACHE_MAX = 10_000;

const inFlight = new Map<string, Promise<boolean>>();
const refusedUntil = new Map<string, number>();

/**
 * Try to seat `userId` in `tenantId` now. Resolves `true` only when the member holds an ACTIVE
 * entitlement afterwards (the caller re-reads it); `false` for every refusal or failure. NEVER
 * throws — both callers are refusal sites that must keep their own fail-closed verdict.
 */
export function seatMemberInline(tenantId: string, userId: string): Promise<boolean> {
  if (!config.license.issuanceEnabled) return Promise.resolve(false);
  const key = `${tenantId}:${userId}`;
  const until = refusedUntil.get(key);
  if (until !== undefined) {
    if (until > Date.now()) return Promise.resolve(false);
    refusedUntil.delete(key);
  }
  const running = inFlight.get(key);
  if (running) return running;
  const attempt = attemptSeat(tenantId, userId)
    .then((ok) => {
      if (!ok) rememberRefusal(key);
      return ok;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, attempt);
  return attempt;
}

function rememberRefusal(key: string): void {
  if (refusedUntil.size >= NEGATIVE_CACHE_MAX) {
    const now = Date.now();
    for (const [k, at] of refusedUntil) if (at <= now) refusedUntil.delete(k);
    if (refusedUntil.size >= NEGATIVE_CACHE_MAX) refusedUntil.clear();
  }
  refusedUntil.set(key, Date.now() + INLINE_SEAT_NEGATIVE_TTL_MS);
}

async function attemptSeat(tenantId: string, userId: string): Promise<boolean> {
  try {
    // `users` and `tenants` are outside RLS; runAsSystem so the read does not depend on the
    // request's GUC. The predicate is `repairUnseatedMembers`'s — keep the two identical.
    const [row] = await runAsSystem('non-rls-table', () =>
      db
        .select({ keycloakSub: users.keycloak_sub })
        .from(users)
        .innerJoin(tenants, eq(tenants.id, users.tenant_id))
        .where(
          and(
            eq(users.id, userId),
            eq(users.tenant_id, tenantId),
            isNull(users.deleted_at),
            ne(users.role, 'platform'),
            isNotNull(users.keycloak_sub),
            eq(tenants.status, 'active'),
            isNull(tenants.offboarded_at),
          ),
        )
        .limit(1),
    );
    if (!row?.keycloakSub) {
      incCounter('inline_seat_ineligible_total');
      return false;
    }
    const out = await ensureMemberEntitlement(tenantId, userId, row.keycloakSub);
    if (out.state === 'active') {
      incCounter('inline_seat_succeeded_total');
      log.info('inline_seat_succeeded', { component: 'inline-seat', tenantId, userId });
      return true;
    }
    incCounter('inline_seat_refused_total');
    log.info('inline_seat_not_seated', { component: 'inline-seat', tenantId, userId, state: out.state });
    return false;
  } catch (err) {
    incCounter('inline_seat_failed_total');
    log.warn('inline_seat_failed', { component: 'inline-seat', tenantId, userId, err });
    return false;
  }
}

/** Test seam: neither cache may leak between tests. */
export function __resetInlineSeatForTests(): void {
  inFlight.clear();
  refusedUntil.clear();
}
