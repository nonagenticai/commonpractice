// src/services/cp-identity.ts — CP-owned authorization for a Keycloak-verified identity.
//
// Keycloak (the `portal` realm, shared with fr) only AUTHENTICATES. CP authorizes from its own
// `users` row: `users.tenant_id` is the single home tenant, `users.tenant_role` the role inside it.
// The token's `tenant_id` claim and every realm role except `super_admin` are ignored
// (services/keycloak.ts drops them before this runs).
//
// `hydrateCpIdentity` is called once per verified token on the real Keycloak path
// (middleware/auth.ts). It fills `User.tenantId`, `User.tenantRole` and appends the tenant role to
// `User.roles`, so every existing role guard (`hasTenantAdmin`, `isDeveloper`, …) keeps working.
//
// SSO first login: a brokered user arrives with no CP row. If their `idp_alias` claim names an
// enabled `identity_providers` row, they are seated as a `member` of the tenant that owns it,
// subject to the seat cap. Anything else → no workspace (the tenant routes answer 403 `no_workspace`).
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, users, identityProviders, runAsSystem } from '../db/client';
import { recordAudit } from '../host/audit-service';
import { incCounter } from '../host/metrics';
import { log } from '../host/logger';
import { claimSeatInTx, probeSeatForUser, revokePendingInvitesInTx } from './seat-limit';
import { ensureMemberEntitlement } from './license-provisioning';
import { HttpError } from '../utils/http';
import { canonicalTenantId } from '../utils/tenant-id';
import type { TenantRole, User } from '../types';

/** Literal rather than imported from middleware/admin-guards.ts, which imports auth.ts → here. */
const SUPER_ADMIN = 'super_admin';
const TENANT_ROLE_NAMES: readonly string[] = ['member', 'developer', 'tenant_admin'];

interface CpMembership {
  tenantId: string | null;
  tenantRole: TenantRole | null;
}

const NO_WORKSPACE: CpMembership = { tenantId: null, tenantRole: null };

/**
 * One resolution per request. `authenticateWithoutLicense` runs several times per request
 * (`peekEffectiveTenant`, the tenant-status gate, the route guard), each producing a fresh `User`,
 * so the cache is keyed on the Request when the caller has one, else on the verified object.
 * The sub is stored with the entry so a key can never serve another identity's membership.
 */
const membershipCache = new WeakMap<object, { sub: string; membership: Promise<CpMembership> }>();

/** Fill `tenantId` / `tenantRole` / `roles` on a Keycloak-verified identity from CP's `users`. */
export async function hydrateCpIdentity(verified: User, req?: Request): Promise<User> {
  const key: object = req ?? verified;
  let entry = membershipCache.get(key);
  if (!entry || entry.sub !== verified.id) {
    entry = { sub: verified.id, membership: resolveMembership(verified) };
    membershipCache.set(key, entry);
  }
  let membership: CpMembership;
  try {
    membership = await entry.membership;
  } catch (err) {
    membershipCache.delete(key); // never cache a failure
    throw err;
  }
  return applyMembership(verified, membership);
}

/** roles = the honoured realm roles (super_admin, bridge SA role) + the CP tenant role, if any. */
function applyMembership(verified: User, m: CpMembership): User {
  const { tenantId: _ignored, tenantRole: _ignoredRole, ...identity } = verified;
  const realm = verified.roles.filter((r) => !TENANT_ROLE_NAMES.includes(r));
  const roles = [...realm, ...(m.tenantId && m.tenantRole ? [m.tenantRole] : [])];
  if (!m.tenantId) return { ...identity, roles };
  return { ...identity, roles, tenantId: m.tenantId, tenantRole: m.tenantRole ?? 'member' };
}

/**
 * The tenant role a set of Keycloak realm roles implied under the old model: tenant_admin >
 * developer > member. Used only by the one-off membership backfill.
 */
export function roleFromRealmRoles(realmRoles: string[]): TenantRole {
  if (realmRoles.includes('tenant_admin')) return 'tenant_admin';
  if (realmRoles.includes('developer')) return 'developer';
  return 'member';
}

async function resolveMembership(verified: User): Promise<CpMembership> {
  if (!verified.id) return NO_WORKSPACE;
  // `users` is outside RLS (0028), and rows are keyed id = Keycloak sub — one PK read.
  const [row] = await db
    .select({
      tenantId: users.tenant_id,
      tenantRole: users.tenant_role,
      deletedAt: users.deleted_at,
    })
    .from(users)
    .where(eq(users.id, verified.id))
    .limit(1);

  // A tombstone (0050) is never a workspace, and is not re-seated by SSO either: the admin who
  // removed this person decides whether they come back (an invite).
  if (row?.deletedAt) return NO_WORKSPACE;
  if (row?.tenantId) {
    return { tenantId: canonicalTenantId(row.tenantId), tenantRole: row.tenantRole ?? 'member' };
  }
  if (verified.idpAlias) return ssoFirstLogin(verified, verified.idpAlias);
  return NO_WORKSPACE;
}

/**
 * Seat a brokered first-login user in the tenant that owns their IdP alias.
 *
 * `credential-auth`: no tenant is known yet; the verified token's alias is what resolves it, and
 * `identity_providers` is RLS-scoped.
 */
async function ssoFirstLogin(user: User, alias: string): Promise<CpMembership> {
  const [idp] = await runAsSystem('credential-auth', () =>
    db
      .select({ tenantId: identityProviders.tenant_id, enabled: identityProviders.enabled })
      .from(identityProviders)
      .where(eq(identityProviders.alias, alias))
      .limit(1),
  );
  if (!idp || !idp.enabled) {
    log.info('sso_alias_not_mapped', {
      component: 'cp-identity',
      userId: user.id,
      alias,
      reason: idp ? 'disabled' : 'unknown',
    });
    return NO_WORKSPACE;
  }
  const tenantId = canonicalTenantId(idp.tenantId);

  let seated: boolean;
  try {
    seated = await runAsSystem('credential-auth', () =>
      db.transaction((tx) => claimJitSeat(tx, user, tenantId)),
    );
  } catch (err) {
    if (err instanceof HttpError && err.code === 'seat_limit_reached') {
      // Fail closed: no workspace. Retried on every request, so the member is admitted
      // automatically once a seat frees up; the audit tells the admin it happened.
      await auditJitSeatDenied(user, tenantId, err);
      return NO_WORKSPACE;
    }
    if (err instanceof HttpError && err.code === 'user_offboarded') {
      log.info('sso_first_login_offboarded', { component: 'cp-identity', userId: user.id, tenantId });
      return NO_WORKSPACE;
    }
    if (err instanceof HttpError && err.code === 'tenant_not_active') {
      log.info('sso_first_login_tenant_not_active', { component: 'cp-identity', userId: user.id, tenantId });
      return NO_WORKSPACE;
    }
    throw err;
  }
  if (!seated) return NO_WORKSPACE;
  await mintJitEntitlement(tenantId, user);
  return { tenantId, tenantRole: 'member' };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Take the first-login seat for `user` in `tenantId` (tenant row lock when capped). A suspended or
 * offboarded workspace seats nobody (409 `tenant_not_active` → no workspace).
 *
 * A seat cap that any member of a customer's Entra directory can walk through is not a cap, so a
 * full workspace refuses (409 `seat_limit_reached`, mapped to "no workspace" by the caller). A
 * super_admin is never seat-refused: platform staff are not a seat the customer bought.
 */
async function claimJitSeat(tx: Tx, user: User, tenantId: string): Promise<boolean> {
  const bypass = user.roles.includes(SUPER_ADMIN);

  // An IdP can mint a NEW sub for a person who was removed (their old Keycloak user gone), so the
  // tombstone check by id in `resolveMembership` cannot see them. Check the email within THIS
  // tenant too — case-insensitively, `users.email` has no unique index. Scoped to the tenant: being
  // removed by one customer is not a platform-wide ban.
  if (!bypass && user.email) {
    const [tombstone] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.tenant_id, tenantId),
          sql`lower(${users.email}) = lower(${user.email})`,
          isNotNull(users.deleted_at),
        ),
      )
      .limit(1);
    if (tombstone) {
      throw new HttpError(403, 'user_offboarded', 'This account has been removed from its workspace.');
    }
  }

  // Unlocked triage first (see `probeSeatForUser`): a refused user re-enters this path on every
  // request, and only an admitting outcome takes the tenant row lock.
  const probe = await probeSeatForUser(tx, tenantId, user.id, user.email);
  if (!probe.active) {
    throw new HttpError(409, 'tenant_not_active', 'This workspace is suspended or offboarded.');
  }
  if (!bypass && probe.max !== null && probe.used >= probe.max) {
    if (probe.seat) return true; // a parallel arm of this first login already took it
    throw seatRefusal(probe.used, probe.max);
  }
  if (bypass || probe.max === null) {
    // Nothing to count, so no FOR UPDATE (it would queue first logins behind every tenant write).
    // FOR KEY SHARE — what the users FK takes anyway — still waits out an offboard (FOR UPDATE) in
    // flight and then reads its committed status, so it cannot leave a live member behind.
    const rows = (await tx.execute(sql`
      SELECT (status = 'active' AND offboarded_at IS NULL) AS active
        FROM tenants WHERE id = ${tenantId} FOR KEY SHARE
    `)) as unknown as { active: boolean }[];
    if (rows[0] && rows[0].active !== true) {
      throw new HttpError(409, 'tenant_not_active', 'This workspace is suspended or offboarded.');
    }
  } else {
    // Capped admit (once per member ever): the tenant row lock re-checks status and the cap.
    // LOCK ORDER: tenant row first, users row second, as `claimSeat`.
    try {
      await claimSeatInTx(tx, tenantId, undefined, { seatEmail: user.email });
    } catch (err) {
      if (!(err instanceof HttpError) || err.code !== 'seat_limit_reached') throw err;
      if (await alreadySeated(tx, user.id)) return true;
      const { used, max } = (err.details ?? {}) as { used?: number; max?: number };
      throw seatRefusal(used, max);
    }
  }

  await tx
    .insert(users)
    .values({ id: user.id, email: user.email, name: user.name, keycloak_sub: user.id })
    // Untargeted: every unique index (pkey, keycloak_sub) is an arbiter under a parallel first login.
    .onConflictDoNothing();
  const took = await tx
    .update(users)
    .set({ tenant_id: tenantId, tenant_role: 'member' })
    .where(and(eq(users.id, user.id), isNull(users.tenant_id), isNull(users.deleted_at)))
    .returning({ id: users.id });
  // Seated by SSO: an invite still pending for this address must not later re-seat them at its level.
  if (took.length && user.email) await revokePendingInvitesInTx(tx, tenantId, user.email);
  return alreadySeated(tx, user.id);
}

/** READ COMMITTED re-read: has this user's seat been filled (by us or a parallel arm)? */
async function alreadySeated(tx: Tx, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ seat: users.tenant_id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deleted_at)))
    .limit(1);
  return row?.seat != null;
}

function seatRefusal(used: number | undefined, max: number | undefined): HttpError {
  return new HttpError(
    409,
    'seat_limit_reached',
    `Your Common Practice workspace has no free seats (${used ?? '?'} of ${max ?? '?'} in use).`,
    { used, max, firstLogin: true },
  );
}

/**
 * Mint the central licence for a seat just taken. After the commit; swallows its failure — the
 * seat is durable and `repairUnseatedMembers` (host/onboarding-integrity.ts) re-offers it.
 */
async function mintJitEntitlement(tenantId: string, user: User): Promise<void> {
  // ⚠️ NO super_admin SKIP (there was one). A super_admin seated in a tenant by SSO is judged by the
  // per-member gate there like any member (license-gate.ts exempts only a SCOPE-SWITCHED operator),
  // and `repairUnseatedMembers` seats them anyway — it excludes only `users.role = 'platform'`, which
  // no login path ever writes (seed data only). So the skip never kept anyone off an invoice; it only
  // made such a person wait up to one sweep tick, locked out. Same eligibility as the sweep now.
  try {
    const out = await ensureMemberEntitlement(tenantId, user.id, user.id);
    if (out.state === 'disabled' || out.state === 'tenant_licensed') return;
    incCounter(
      out.state === 'active' ? 'jit_seat_licensed_total' : 'jit_seat_licence_deferred_total',
    );
  } catch (err) {
    incCounter('jit_seat_licence_deferred_total');
    log.warn('jit_seat_licence_deferred', { component: 'cp-identity', tenantId, err });
  }
}

/** Per-process audit throttle: at most one row per key per hour (the refusal recurs per request). */
const throttledAudits = new Map<string, number>();
const AUDIT_THROTTLE_WINDOW_MS = 60 * 60 * 1000;

function claimAuditSlot(key: string): boolean {
  const now = Date.now();
  if (now - (throttledAudits.get(key) ?? -Infinity) < AUDIT_THROTTLE_WINDOW_MS) return false;
  for (const [k, at] of throttledAudits) {
    if (now - at > AUDIT_THROTTLE_WINDOW_MS) throttledAudits.delete(k);
  }
  throttledAudits.set(key, now);
  return true;
}

async function auditJitSeatDenied(user: User, tenantId: string, err: HttpError): Promise<void> {
  incCounter('jit_seat_denied_total');
  log.warn('sso_first_login_seat_denied', { component: 'cp-identity', userId: user.id, tenantId });
  if (!claimAuditSlot(`denied:${tenantId}:${user.id}`)) return;
  await recordAudit({
    actorId: null, // the refusal rolled back any row this would point at
    action: 'user.jit_seat_denied',
    category: 'auth',
    targetType: 'user',
    targetId: user.id,
    result: user.email,
    resultTone: 'warn',
    metadata: { tenantId, ...(err.details ?? {}) },
  });
}

/** Test seam: the audit throttle must not leak between tests. */
export function __resetCpIdentityForTests(): void {
  throttledAudits.clear();
}
