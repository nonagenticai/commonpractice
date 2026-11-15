// src/services/user-service.ts — the single first-touch user provisioning path.
//
// Tenants are born only from seed or a super_admin endpoint, and membership only from an invite,
// an approval, or an SSO first login (services/cp-identity.ts). So `ensureUser` seats nobody: it
// upserts the identity row (tenant NULL for a first-touch user), backfills `keycloak_sub`, refuses
// a tombstoned (offboarded) account, and queues a workspace-less user into the super_admin approval
// queue (`recordSignupStrand`). `users.tenant_id` / `users.tenant_role` are the authority, read
// per request by `hydrateCpIdentity`.
import { and, eq, isNull } from 'drizzle-orm';
import { db, users, signupApprovals } from '../db/client';
import { recordAudit } from '../host/audit-service';
import { log } from '../host/logger';
import { isSuperAdmin } from '../middleware/admin-guards';
import { matchTenantByEmail } from './onboarding-service';
import { HttpError } from '../utils/http';
import type { User } from '../types';

/**
 * Idempotently upsert the authenticated user. Call at the start of any first-write endpoint.
 * Throws 403 `user_offboarded` for a tombstoned account.
 */
export async function ensureUser(user: User): Promise<void> {
  /** Set when this user has no workspace — queued after the transaction commits. */
  let stranded = false;
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        seat: users.tenant_id,
        deletedAt: users.deleted_at,
        storedSub: users.keycloak_sub,
      })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);

    // SELF-HEALING BACKFILL OF `keycloak_sub`: the request carries a VERIFIED JWT whose `sub` is
    // `user.id`, which is the proof the seat reconciler fails closed on (it refuses to mint for a
    // row with no recorded sub — `db/seed-tenant-showcase.ts` creates rows with plain uuidv7 ids).
    // Guarded on NULL so it writes once and only ever the value the caller authenticated with.
    if (existing && !existing.storedSub) {
      await tx
        .update(users)
        .set({ keycloak_sub: user.id })
        .where(and(eq(users.id, user.id), isNull(users.keycloak_sub)));
    }

    // An offboarded person must not walk back in (0050). Their row keeps its `tenant_id` — a
    // tombstone, not a seat. Coming back is an invite (which clears `deleted_at`), not a login.
    if (existing?.deletedAt) {
      throw new HttpError(
        403,
        'user_offboarded',
        'This account has been removed from its workspace. Ask a workspace admin to invite you again.',
      );
    }
    if (existing?.seat) return; // the per-request common case

    // No workspace. Never fabricate a tenant: the column stays NULL. A super_admin without one is
    // platform staff working through `X-Active-Tenant-Id`, not a signup to approve — so it is not
    // queued, and its row is marked `role = 'platform'`. Without that mark the onboarding census
    // (host/onboarding-integrity.ts, census C) cannot tell it from a stranded signup and
    // `CommonPracticeSignupStrandedUnqueued` fires forever on a row nobody should action
    // (prod 2026-10-25: the owner's own commonpractice-realm login).
    await upsertRow(tx, user);
    if (isSuperAdmin(user)) {
      await tx
        .update(users)
        .set({ role: 'platform' })
        .where(and(eq(users.id, user.id), eq(users.role, 'employee')));
    } else {
      stranded = true;
    }
  });
  // Outside the transaction: a courtesy write for the admin queue, not a login precondition, and it
  // swallows its own failure — see its doc comment.
  if (stranded) await recordSignupStrand(user);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The identity half of the upsert. Never overwrites: email/name stay as first seen.
 *
 * `keycloak_sub` IS WRITTEN ON THE INSERT: `user` comes from a VERIFIED JWT whose `sub` is
 * `user.id`, so the proof is already in hand (the backfill above is for older rows). */
function upsertRow(tx: Tx, user: User): Promise<unknown> {
  return tx
    .insert(users)
    .values({ id: user.id, email: user.email, name: user.name, keycloak_sub: user.id })
    // ⛔ UNTARGETED, deliberately. With `{ target: users.id }` only `users_pkey` is an arbiter.
    // Since `keycloak_sub` is written here too (= id), a parallel first login (an SPA boot fires
    // several requests at once) can let two inserts both pass the speculative pre-check; the loser
    // then blocks on the NON-arbiter `users_keycloak_sub_key` and raises 23505 instead of doing
    // nothing — a 500 on first login. Untargeted makes every unique index an arbiter; both keys
    // carry the same value, so "already exists" is the only meaning either has.
    .onConflictDoNothing();
}

/**
 * Queue a workspace-less user into the super_admin approval queue (`signup_approvals`), so
 * `routes/onboarding.ts`'s `approve` can seat them. `users.tenant_id` is never touched here; only a
 * human approving this row (or the user accepting an invite) moves it.
 *
 * IDEMPOTENCE: `ON CONFLICT DO NOTHING`, the same mechanism `notifySelf` (routes/onboarding.ts)
 * already relies on for the identical write — both target `signup_approvals_pending_email`, the
 * partial unique index on `lower(email) WHERE status = 'pending'` (migration
 * 0027_signup_onboarding.sql). No target is named because none needs to be: a decided
 * (approved/rejected) row never blocks a new one, and this branch reruns on every request this
 * person makes for as long as they stay stranded — one row, not one per request.
 *
 * `.returning()` is how "did THIS call create the row" is known without a second query: it comes
 * back empty on every request after the first. `matchTenantByEmail` (two more SELECTs) and the
 * audit row are gated on that — genuine first creation only, never per request — which is what
 * makes calling `matchTenantByEmail` here cheap enough to justify: on the common (already-queued)
 * path this function costs exactly the one no-op INSERT.
 *
 * Runs OUTSIDE `ensureUser`'s transaction and swallows every failure of its own: this is a courtesy to the admin queue, not a login
 * precondition, and `recordAudit` already documents the same never-throw contract for the same
 * reason. A failure here must not turn today's silent debris row into a 500.
 */
async function recordSignupStrand(user: User): Promise<void> {
  let created: { id: string } | undefined;
  try {
    [created] = await db
      .insert(signupApprovals)
      .values({ keycloak_sub: user.id, email: user.email, name: user.name, status: 'pending' })
      .onConflictDoNothing()
      .returning({ id: signupApprovals.id });
  } catch (err) {
    log.warn('signup_strand_insert_failed', {
      component: 'user-service',
      userId: user.id,
      err,
    });
    return;
  }
  if (!created) return; // already queued (or already decided) — nothing new happened

  const matched = await matchTenantByEmail(user.email).catch((err: unknown) => {
    log.warn('signup_strand_match_failed', {
      component: 'user-service',
      userId: user.id,
      err,
    });
    return null;
  });
  if (matched) {
    await db
      .update(signupApprovals)
      .set({ matched_tenant_id: matched })
      .where(eq(signupApprovals.id, created.id))
      .catch((err: unknown) => {
        log.warn('signup_strand_match_write_failed', {
          component: 'user-service',
          userId: user.id,
          err,
        });
      });
  }

  // ONE row, on genuine first creation only — makes the strand visible in the compliance export
  // (`recordAudit` never throws into its caller; see host/audit-service.ts).
  await recordAudit({
    actorId: null, // no local seat yet — System
    action: 'user.signup_strand_queued',
    category: 'auth',
    targetType: 'user',
    targetId: user.id,
    result: user.email,
    resultTone: 'warn',
    metadata: { approvalId: created.id, matchedTenantId: matched },
  });
}
