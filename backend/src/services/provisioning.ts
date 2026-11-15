// src/services/provisioning.ts — the shared identity + membership helpers.
//
// Keycloak (the portal realm, SHARED with fr) only AUTHENTICATES. CP never writes a realm
// role, writes only its own admin-only signup attributes (the approval email's `signup_app` /
// `signup_book_url`, and the reject marker below), and never deletes a realm user it did not mint:
// membership (`users.tenant_id`) and level (`users.tenant_role`) live in CP's own database.
// This file holds the two halves of putting a person into a workspace:
//   • `findOrCreateRealmIdentity` — make sure an identity exists for an email (read, or a bare
//     create with no attributes and no roles);
//   • `upsertLocalUserTx` — write the CP membership row inside the caller's seat-claim txn.
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db, runAsSystem, users } from '../db/client';
import {
  KeycloakAdminError,
  DuplicateUserError,
  type KeycloakAdminClient,
  type RealmUser,
} from './keycloak-admin';
import { badRequest, conflict, HttpError } from '../utils/http';
import { log } from '../host/logger';
import type { SeatTx } from './seat-limit';
import type { TenantRole } from '../types';

/** The only levels an invite / approve / role change may grant — never super_admin or any other
 *  platform role. Any other value is a 422 from zod at the route boundary. */
export const TENANT_SCOPED_ROLES = ['member', 'developer', 'tenant_admin'] as const;
export const tenantScopedRoleSchema = z.enum(TENANT_SCOPED_ROLES);
export type TenantScopedRole = z.infer<typeof tenantScopedRoleSchema>;

/** Defense-in-depth escalation guard: reject any role outside the tenant-scoped set. */
export function assertTenantScopedRole(role: string): asserts role is TenantScopedRole {
  if (!(TENANT_SCOPED_ROLES as readonly string[]).includes(role)) {
    throw badRequest('platform_role_forbidden', `Role '${role}' cannot be granted here`);
  }
}

/**
 * firstName / lastName for the Keycloak rep — the SAME rule every early-access app uses (fr's
 * `identity.ts` splitName). The shared realm requires BOTH (VERIFY_PROFILE): an empty lastName sends
 * the person to Keycloak's "Update account information" form right after they set a password.
 *   • trim, split on whitespace runs; first word → firstName, the rest → lastName;
 *   • ONE word → that word for both;
 *   • empty / whitespace-only → the email's local part for both.
 */
export function splitName(
  name: string | null | undefined,
  email: string,
): { firstName: string; lastName: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    const local = email.split('@')[0] || email;
    return { firstName: local, lastName: local };
  }
  if (parts.length === 1) return { firstName: parts[0]!, lastName: parts[0]! };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

/** What `findOrCreateRealmIdentity` resolved. */
export interface RealmIdentity {
  /** The Keycloak sub. */
  sub: string;
  /** True only when THIS call minted the identity. It is the sole licence to delete it again
   *  (`rollbackProvisionedUser`). Whether it gets a credential-setup email is NOT decided by this
   *  flag any more but by `identityLoginState` — an identity CP did not create may still have no
   *  way to sign in (the Netcare invite). */
  created: boolean;
  /** Whether the realm reports the email as verified (unknown for a fresh create → false). */
  emailVerified: boolean;
  /** Pending required actions on the identity, from the representation already fetched. */
  requiredActions: string[];
  /**
   * Set when the identity was DISABLED by a CommonPractice signup reject (it carried
   * `CP_REJECT_MARKER`) and this call re-enabled it and cleared the marker. `credentialless`: the
   * realm positively reports no credential of any type and no IdP link — CP minted it and nobody ever
   * set it up, so the caller treats it exactly like a freshly minted identity (seat + licence at
   * approval + the set-password email). Otherwise it takes the ordinary invite path.
   * `created` stays false: this call did not create it and may never delete it.
   */
  reclaimed?: { marker: string; credentialless: boolean };
}

// ---- the signup-reject marker ---------------------------------------------------------------------
//
// A rejected signup's minted identity that cannot simply be deleted (it holds a credential, or the
// realm would not say) is DISABLED and marked so that a later re-signup of the same address can tell
// "CP disabled this on a reject — re-enable it" from "somebody else disabled this — hands off".
//
// ⛔ WHY `signup_app` AND NOT A NEW ATTRIBUTE. The portal realm runs with unmanaged attributes
// DISABLED: Keycloak silently DROPS any attribute its user profile does not declare (no error on the
// PUT). `signup_app` is already declared admin-view/admin-edit-only by gitops
// `realm-patch-job-early-access-v2.yaml` (single-valued, length <= 64) and is CP's own: the approval
// email writes `commonpractice` into it and the email theme branches on that value. A disabled identity
// receives no email, and the re-enable clears the marker before the approval email writes the attribute
// again, so the two uses never overlap. Users cannot write it (admin-only edit), so the marker cannot be
// forged from the account console. The write is READ BACK (`setUserState`) — a profile that ever stops
// declaring the attribute shows up as `disabled_unmarked`, never as a silent success.
export const CP_REJECT_MARKER_ATTR = 'signup_app';
const CP_REJECT_MARKER_PREFIX = 'cp_rejected:';

/** The marker value for a reject of signup approval `approvalId` (48 chars for a uuid; limit 64). */
export function cpRejectMarker(approvalId: string): string {
  return `${CP_REJECT_MARKER_PREFIX}${approvalId}`;
}

/** The CP reject marker an identity carries, or null. */
export function rejectMarkerOf(user: Pick<RealmUser, 'attributes'>): string | null {
  const v = user.attributes?.[CP_REJECT_MARKER_ATTR]?.[0];
  return typeof v === 'string' && v.startsWith(CP_REJECT_MARKER_PREFIX) ? v : null;
}

/**
 * Does the identity hold ANY way to sign in? `none` only when the realm POSITIVELY reports zero
 * credentials of any type (password, otp, webauthn, …) AND zero IdP links. A read that is refused or
 * absent is `unknown` — never `none`: a destructive decision (delete) must not rest on a 403.
 */
export async function identityCredentialState(
  kc: KeycloakAdminClient,
  sub: string,
): Promise<'none' | 'some' | 'unknown'> {
  const [creds, links] = await Promise.all([
    kc.getUserCredentials ? kc.getUserCredentials(sub) : Promise.resolve(null),
    kc.getFederatedIdentities ? kc.getFederatedIdentities(sub) : Promise.resolve(null),
  ]);
  if ((creds && creds.length > 0) || (links && links.length > 0)) return 'some';
  if (creds === null || links === null) return 'unknown';
  return 'none';
}

/**
 * Undo `findOrCreateRealmIdentity`'s re-enable of a reject-marked identity when the call that
 * reclaimed it fails: disable it again and put the marker back, so the next attempt finds it exactly
 * as the reject left it. Best-effort — logged, never thrown (the caller is already failing).
 */
export async function restoreRejectedIdentity(
  kc: KeycloakAdminClient,
  identity: Pick<RealmIdentity, 'sub' | 'reclaimed'>,
  email: string,
): Promise<void> {
  if (!identity.reclaimed || !kc.setUserState) return;
  try {
    await kc.setUserState(identity.sub, {
      enabled: false,
      attributes: { [CP_REJECT_MARKER_ATTR]: identity.reclaimed.marker },
    });
  } catch (err) {
    log.error('reclaimed_identity_restore_failed', {
      component: 'provisioning',
      sub: identity.sub,
      email,
      remediation: 'the identity a rejected signup left disabled is ENABLED again after a failed approve; disable it by hand',
      err,
    });
  }
}

/**
 * An EXISTING identity that is disabled. Re-enabled ONLY when it carries CP's reject marker; anything
 * else disabled it (an operator, fr, a security response) and CP must not undo that — 409
 * `identity_disabled`, so the approver sees why instead of the person getting an invite they can
 * never use.
 */
async function reclaimDisabledIdentity(
  kc: KeycloakAdminClient,
  user: RealmUser,
  email: string,
): Promise<RealmIdentity['reclaimed'] | undefined> {
  if (user.enabled !== false) return undefined;
  // The search representation may be brief; the marker is read from the full one.
  const full = (kc.getRealmUser ? await kc.getRealmUser(user.id) : null) ?? user;
  if (full.enabled !== false) return undefined;
  const marker = rejectMarkerOf(full);
  if (!marker || !kc.setUserState) {
    log.warn('identity_disabled_not_by_cp', { component: 'provisioning', sub: user.id, email, marker: !!marker });
    throw conflict(
      'identity_disabled',
      `The realm account for '${email}' is DISABLED, and not by a CommonPractice signup reject, so CP ` +
        `will not re-enable it. Re-enable (or remove) it in Keycloak deliberately, then approve again.`,
    );
  }
  const state = await identityCredentialState(kc, user.id);
  const stored = await kc.setUserState(user.id, { enabled: true, attributes: { [CP_REJECT_MARKER_ATTR]: null } });
  if (stored.enabled === false) {
    throw new KeycloakAdminError(502, `re-enabling the rejected signup's identity ${user.id} did not take`);
  }
  log.info('signup_reject_identity_reenabled', { component: 'provisioning', sub: user.id, email, marker, state });
  return { marker, credentialless: state === 'none' };
}

/** Whether a realm identity can log in yet — see `identityLoginState`. */
export interface IdentityLoginState {
  /** The identity cannot sign in without setting a password first → Keycloak's action email. */
  needsSetup: boolean;
  /** true/false = read; null = Keycloak would not say (403) — the predicate degraded. */
  hasPassword: boolean | null;
  hasFederatedIdentity: boolean | null;
  requiredActions: string[];
}

/**
 * Can this identity sign in today? Decided by its LOGIN STATE, not by who created it.
 *
 *   needsSetup = (no password credential AND no IdP link) OR UPDATE_PASSWORD is pending
 *
 * ⛔ THE BUG THIS REPLACES (prod 2026-10-12, Netcare): the invitee's portal identity had been created
 * months earlier by another provisioning — no password, no IdP link, UPDATE_PASSWORD + VERIFY_EMAIL
 * pending. CP sent the set-password mail only for an identity IT had just created, so this invitee got
 * CP's "sign in and accept" mail and had no way to sign in.
 *
 * DEGRADES, never guesses "no password": when the credentials read is refused (the SA's `view-users`
 * may not cover it), only the second clause decides, i.e. UPDATE_PASSWORD pending — which is what that
 * identity showed. A mail to the account's own address cannot take an account over either way.
 */
export async function identityLoginState(
  kc: KeycloakAdminClient,
  sub: string,
  requiredActions: string[],
): Promise<IdentityLoginState> {
  const [creds, links] = await Promise.all([
    kc.getUserCredentials ? kc.getUserCredentials(sub) : Promise.resolve(null),
    kc.getFederatedIdentities ? kc.getFederatedIdentities(sub) : Promise.resolve(null),
  ]);
  const hasPassword = creds === null ? null : creds.some((c) => c.type === 'password');
  const hasFederatedIdentity = links === null ? null : links.length > 0;
  const pendingPassword = requiredActions.includes('UPDATE_PASSWORD');
  const noCredential = hasPassword === false && hasFederatedIdentity === false;
  return {
    needsSetup: noCredential || pendingPassword,
    hasPassword,
    hasFederatedIdentity,
    requiredActions,
  };
}

/**
 * Resolve the realm identity for `email`, creating a bare one when none exists.
 *
 * Lookup is by USERNAME then email (`findRealmUserByUsernameOrEmail`): CP creates users with
 * `username === email`, and Keycloak 409s a create on a username collision even when the existing
 * account has no email. The create carries NO attributes, NO roles and NO password — the account
 * gets its credential through the action email the caller sends.
 *
 * A create that races another (409) re-resolves instead of failing. Any Keycloak failure → 502.
 */
export async function findOrCreateRealmIdentity(
  kc: KeycloakAdminClient,
  input: { email: string; firstName?: string; lastName?: string },
): Promise<RealmIdentity> {
  const { email } = input;
  try {
    const existing = await kc.findRealmUserByUsernameOrEmail(email, email);
    if (existing) return await adoptExisting(kc, existing, input);
    try {
      const sub = await kc.createRealmUser({
        username: email,
        email,
        ...(input.firstName ? { firstName: input.firstName } : {}),
        ...(input.lastName ? { lastName: input.lastName } : {}),
        enabled: true,
        emailVerified: false,
      });
      return { sub, created: true, emailVerified: false, requiredActions: [] };
    } catch (err) {
      if (!(err instanceof DuplicateUserError)) throw err;
      const raced = await kc.findRealmUserByUsernameOrEmail(email, email);
      if (!raced) {
        throw new KeycloakAdminError(
          502,
          `Keycloak reported '${email}' as a duplicate but no realm user matches that ` +
            `username or email — the realm is inconsistent; resolve it in Keycloak.`,
        );
      }
      return await adoptExisting(kc, raced, input);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof KeycloakAdminError) {
      throw new HttpError(502, 'keycloak_provisioning_failed', err.message);
    }
    throw err;
  }
}

/** An identity that already exists: reclaim a reject-disabled one (or refuse a foreign-disabled one),
 *  then fill missing profile fields. */
async function adoptExisting(
  kc: KeycloakAdminClient,
  user: RealmUser,
  input: { email: string; firstName?: string; lastName?: string },
): Promise<RealmIdentity> {
  const reclaimed = await reclaimDisabledIdentity(kc, user, input.email);
  await backfillMissingEmail(kc, user, input.email);
  await backfillMissingNames(kc, user, input);
  return {
    sub: user.id,
    created: false,
    emailVerified: user.emailVerified === true,
    requiredActions: user.requiredActions ?? [],
    ...(reclaimed ? { reclaimed } : {}),
  };
}

/**
 * A reused account matched by USERNAME may carry no email, which leaves the realm unable to resolve
 * this address next time (and the invite-accept email match impossible). Fill the EMPTY field only —
 * never overwrite an address someone else set. Best-effort, never fatal.
 */
async function backfillMissingEmail(
  kc: KeycloakAdminClient,
  user: { id: string; email?: string | null },
  email: string,
): Promise<void> {
  if (user.email) return;
  try {
    await kc.backfillUserEmail(user.id, email);
  } catch {
    // best-effort: the invite still works once the person sets their email in Keycloak
  }
}

/**
 * A reused account with an EMPTY first or last name sends its owner through Keycloak's
 * VERIFY_PROFILE form on first sign-in (the realm requires both). When the caller knows the names,
 * fill the empty ones — never overwrite a name someone set. Profile data only: no attribute, role or
 * tenancy field is written (CP owns tenancy in its own `users` table). Best-effort, never fatal.
 */
async function backfillMissingNames(
  kc: KeycloakAdminClient,
  user: { id: string; firstName?: string | null; lastName?: string | null },
  input: { firstName?: string; lastName?: string },
): Promise<void> {
  const fillFirst = !user.firstName?.trim() && Boolean(input.firstName?.trim());
  const fillLast = !user.lastName?.trim() && Boolean(input.lastName?.trim());
  if (!fillFirst && !fillLast) return;
  if (!kc.backfillUserNames) return;
  try {
    await kc.backfillUserNames(user.id, input.firstName, input.lastName);
  } catch (err) {
    // Best-effort — Keycloak's own profile form asks for the names at sign-in instead — but SAID:
    // a silent failure here is exactly how the invitee lands on VERIFY_PROFILE with nobody knowing
    // why (e.g. the `commonpractice-admin` SA lost `manage-users`).
    log.warn('keycloak_name_backfill_failed', {
      component: 'provisioning',
      sub: user.id,
      fillFirst,
      fillLast,
      err,
    });
  }
}

/** The realm role that makes an account PLATFORM staff rather than a workspace member. */
const PLATFORM_ROLE = 'super_admin';

/**
 * May this pre-existing realm account be invited into a customer workspace? READ-ONLY.
 *
 * `super_admin` is refused (409 `platform_account_adoption_refused`): a platform operator's
 * address must not become a member of a customer workspace through a customer-facing invite.
 * Fails CLOSED when Keycloak cannot answer (`null` from `getRealmRolesForUsers` = "could not ask",
 * `[]` = "no roles") — "I could not ask" is never reported as "not a platform account".
 */
export async function assertAdoptableIdentity(
  kc: KeycloakAdminClient,
  sub: string,
  email: string,
): Promise<void> {
  const rolesBySub = await kc.getRealmRolesForUsers([sub]);
  const roles = rolesBySub.get(sub);
  if (roles === null || roles === undefined) {
    throw new HttpError(
      502,
      'keycloak_provisioning_failed',
      `Could not read the realm roles of the existing account for '${email}', so it cannot be ` +
        `established whether this is a platform account — refusing rather than guessing.`,
    );
  }
  if (roles.includes(PLATFORM_ROLE)) {
    log.warn('platform_account_adoption_refused', { component: 'provisioning', sub, email });
    throw conflict(
      'platform_account_adoption_refused',
      `'${email}' is a PLATFORM account (${PLATFORM_ROLE}) and cannot be invited into a workspace.`,
    );
  }
}

/** Materialise / repoint the local users row (id = sub, home tenant + level). Idempotent. */
export async function upsertLocalUser(
  sub: string,
  email: string,
  name: string | null | undefined,
  tenantId: string,
  tenantRole: TenantRole,
): Promise<void> {
  await db.transaction((tx) => upsertLocalUserTx(tx, sub, email, name, tenantId, tenantRole));
}

/**
 * The same upsert, inside a transaction the CALLER owns — `claimSeat` holds the tenant row
 * `FOR UPDATE` across it, which is what enforces the seat cap.
 *
 * Writes `keycloak_sub` as well as `id`, so "this row is a realm subject" is a fact on the row
 * (the member-entitlement reconciler fails closed on its absence).
 *
 * A TOMBSTONE (0050) is refused with 409 `user_offboarded` unless `restoreTombstone` is set. Only
 * an explicit invite acceptance by the verified owner of the identity sets it: the person was
 * removed, an admin invited them back, and they accepted.
 *
 * `onlyIfHomelessOrIn: T` makes the UPDATE itself refuse to repoint a row that is LIVE in another
 * tenant (409 `email_in_other_tenant`). The predicate is re-evaluated on the locked row, so a
 * concurrent seat elsewhere that commits first cannot be overwritten.
 */
export async function upsertLocalUserTx(
  tx: SeatTx,
  sub: string,
  email: string,
  name: string | null | undefined,
  tenantId: string,
  tenantRole: TenantRole,
  opts: { restoreTombstone?: boolean; onlyIfHomelessOrIn?: string } = {},
): Promise<void> {
  await tx
    .insert(users)
    .values({
      id: sub,
      keycloak_sub: sub,
      email,
      name: name ?? email,
      tenant_id: tenantId,
      tenant_role: tenantRole,
    })
    .onConflictDoNothing({ target: users.id });
  const guard = opts.onlyIfHomelessOrIn;
  const moved = await tx
    .update(users)
    .set({
      tenant_id: tenantId,
      tenant_role: tenantRole,
      keycloak_sub: sub,
      updated_at: new Date(),
      ...(opts.restoreTombstone ? { deleted_at: null } : {}),
    })
    .where(
      and(
        eq(users.id, sub),
        opts.restoreTombstone ? undefined : isNull(users.deleted_at),
        guard
          ? sql`(${users.tenant_id} IS NULL OR ${users.tenant_id} = ${guard} OR ${users.deleted_at} IS NOT NULL)`
          : undefined,
      ),
    )
    .returning({ id: users.id });
  if (!moved.length) {
    if (guard) {
      const [row] = await tx
        .select({ tenantId: users.tenant_id, deletedAt: users.deleted_at })
        .from(users)
        .where(eq(users.id, sub))
        .limit(1);
      if (row && !row.deletedAt && row.tenantId && row.tenantId !== guard) {
        throw conflict(
          'email_in_other_tenant',
          'This person already belongs to another workspace. A person can belong to one workspace at a time.',
        );
      }
    }
    throw new HttpError(
      409,
      'user_offboarded',
      `User ${sub} was offboarded from a workspace and cannot be onboarded this way. ` +
        `Invite the address instead.`,
    );
  }
}

/** One row that references `users.id`, plus how many references this user has there. */
export interface UserDependant {
  /** `table.column`, for logs and operator messages. */
  ref: string;
  /** The FK's ON DELETE action — what a hard delete would DO to these rows. */
  onDelete: 'cascade' | 'set null' | 'set default' | 'restrict' | 'no action';
  /** Reference count, capped at {@link DEP_SCAN_CAP} (see `capped`). */
  count: number;
  /** True when the count hit the cap — there are at least this many, probably more. */
  capped: boolean;
}

/** Raised instead of hard-deleting a `users` row that something, somewhere, still points at. */
export class UserHasDependantsError extends Error {
  constructor(
    readonly userId: string,
    readonly dependants: UserDependant[],
  ) {
    super(
      `users row ${userId} still has dependants and must not be hard-deleted: ` +
        dependants.map((d) => `${d.ref} (${d.onDelete}) ×${d.count}${d.capped ? '+' : ''}`).join(', '),
    );
    this.name = 'UserHasDependantsError';
  }
}

/** Per-table scan cap. The decision only needs "is there ANY reference"; an exact count of a
 *  runaway table is not worth the scan (`usage_events.user_id` and `notifications.user_id` carry no
 *  index). The cap bounds the work per table while still giving an operator a useful order of
 *  magnitude in the log line. */
const DEP_SCAN_CAP = 100;

interface UserRefColumn {
  /** `conrelid::regclass::text` — already schema-qualified and quoted as needed. */
  table: string;
  /** `quote_ident(attname)` — safe to interpolate as an identifier. */
  column: string;
  ref: string;
  onDelete: UserDependant['onDelete'];
}

const DEL_ACTION: Record<string, UserDependant['onDelete']> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

/** Cached because the FK graph only changes with a migration (which CP runs at STARTUP, before any
 *  request can populate this), and the query below sits on an interactive path. */
let userRefColumnsCache: Promise<UserRefColumn[]> | null = null;

/**
 * Every (table, column) that references `users.id`, read from the LIVE catalog.
 *
 * Deliberately NOT a hand-maintained list. The comment this replaces claimed "14 NO ACTION FKs plus
 * two ON DELETE SET NULL"; the live schema has **30** referencing columns — 15 NO ACTION, 4 CASCADE
 * and **11 SET NULL across 10 tables** (`policies.updated_by`, `policy_changes.changed_by`,
 * `pipeline_items.author_id`, `pipeline_items.reviewed_by`, `audit_log.actor_id`,
 * `audit_exports.actor_id`, `mcp_prompt_versions.created_by`, `flow_snapshots.created_by`,
 * `mcp_api_keys.issued_by`, `translation_jobs.requested_by`, `signup_approvals.decided_by`). A list
 * written into a comment goes stale on the next migration and nobody notices, which is exactly how
 * the old one came to be wrong by nine columns. `unnest(conkey, confkey)` pairs each referencing
 * column with the column it points at, so a future composite FK still resolves to the one that
 * targets `users.id`.
 *
 * Runs on the CALLER's runner, not on `db`: `removeLocalUser` calls this from inside an owner-pool
 * transaction, and the owner pool is `max: 4`. Reaching for a second connection there would let four
 * concurrent deletes hold all four connections and then wait forever for a fifth.
 */
async function userRefColumns(tx: SqlRunner): Promise<UserRefColumn[]> {
  if (!userRefColumnsCache) {
    userRefColumnsCache = (async () => {
      const rows = (await tx.execute(sql`
        SELECT c.conrelid::regclass::text AS tbl,
               quote_ident(a.attname)     AS col,
               a.attname                  AS col_name,
               c.confdeltype              AS del
          FROM pg_constraint c
          JOIN LATERAL unnest(c.conkey, c.confkey) AS k(att, ref) ON true
          JOIN pg_attribute a  ON a.attrelid  = c.conrelid  AND a.attnum  = k.att
          JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = k.ref
         WHERE c.confrelid = 'users'::regclass
           AND c.contype = 'f'
           AND ra.attname = 'id'
         ORDER BY 1, 3
      `)) as unknown as { tbl: string; col: string; col_name: string; del: string }[];
      return rows.map((r) => ({
        table: r.tbl,
        column: r.col,
        ref: `${r.tbl}.${r.col_name}`,
        onDelete: DEL_ACTION[r.del] ?? 'no action',
      }));
    })().catch((err: unknown) => {
      userRefColumnsCache = null; // a transient DB error must not poison the cache
      throw err;
    });
  }
  return userRefColumnsCache;
}

/**
 * Everything that still points at `users.id = userId`, ACROSS ALL TENANTS.
 *
 * ⛔ The cross-tenant part is the whole point, and it is why this runs under `runAsSystem`.
 *
 * `usage_events`, `notifications`, `chat_sessions`, `agent_sessions` and `usage_counters` are all
 * RLS-scoped on `tenant_id = app_current_tenant_uuid()`, while `users` is NOT. On a request
 * connection (`cp_app`, carrying the INVITING tenant's GUC) the pre-existing `users` row is
 * therefore found across tenants but its dependants in ANY OTHER tenant are invisible — the count
 * came back 0 for a user with a full ledger, the guard passed, and the hard delete below CASCADEd
 * another tenant's metering, notifications and chat history away. (Proven empirically in a
 * rolled-back transaction as `cp_app`: owner view 21 `usage_events`, foreign-tenant view 0.)
 * Referential actions run with the referencing table's owner rights, so RLS does not stop the
 * cascade either — only this check does. Same trap as `admin.ts`'s budget lookup.
 */
export async function findUserDependants(userId: string): Promise<UserDependant[]> {
  return runAsSystem('tenant-parameterised', () => findUserDependantsOn(db, userId));
}

/** Anything that can run a raw statement — the `db` proxy or a drizzle transaction handle. */
type SqlRunner = Pick<SeatTx, 'execute'>;

/** `findUserDependants` on a connection the caller owns — which MUST already be a system
 *  (owner-pool) one, or the RLS blindness described above comes straight back. */
async function findUserDependantsOn(tx: SqlRunner, userId: string): Promise<UserDependant[]> {
  const cols = await userRefColumns(tx);
  // ⛔ Fail CLOSED. An empty catalog read means the probe is broken, not that the row is
  // unreferenced — and returning [] here would let the caller hard-delete on the strength of a
  // question we never actually asked. `users` always has referencing FKs in a real schema.
  if (!cols.length) {
    throw new Error(
      'findUserDependants: pg_constraint returned no columns referencing users.id — refusing to ' +
        'treat an unanswered question as "no dependants".',
    );
  }
  const parts: SQL[] = cols.map(
    (c) => sql`SELECT ${c.ref}::text AS ref,
                      (SELECT count(*) FROM (
                         SELECT 1 FROM ${sql.raw(c.table)}
                          WHERE ${sql.raw(c.column)} = ${userId}
                          LIMIT ${sql.raw(String(DEP_SCAN_CAP))}
                       ) probe)::int AS n`,
  );
  const rows = (await tx.execute(sql.join(parts, sql` UNION ALL `))) as unknown as {
    ref: string;
    n: number;
  }[];
  const byRef = new Map(cols.map((c) => [c.ref, c]));
  return rows
    .filter((r) => Number(r.n) > 0)
    .map((r) => ({
      ref: r.ref,
      onDelete: byRef.get(r.ref)?.onDelete ?? 'no action',
      count: Number(r.n),
      capped: Number(r.n) >= DEP_SCAN_CAP,
    }));
}

/** HARD-delete a user's local row. Idempotent — a no-op if the row is already gone.
 *
 *  Only safe when the row owns NOTHING, IN ANY TENANT — so this refuses (throws
 *  `UserHasDependantsError`) rather than deleting anything a foreign key still points at. Its caller
 *  (`rollbackProvisionedUser`) is a "the row is seconds old and provably empty" case, so a refusal
 *  here always means the row is NOT what the caller thought it was.
 *
 *  Failing closed is the only defensible default: of the 30 columns referencing `users.id`, 15 are
 *  NO ACTION (they would raise 23503 anyway — this just turns a raw constraint error into an honest
 *  one), but 4 CASCADE (`usage_events`, `notifications`, `chat_sessions`, `agent_sessions` — the
 *  spend ledger among them) and 11 SET NULL (audit attribution: `audit_log.actor_id`,
 *  `audit_exports.actor_id`, `policies.updated_by`, …) are destroyed or silently blanked with no
 *  error at all. Destroying data because somebody re-typed an email address is never the right
 *  trade; a refusal costs an operator one reconciliation.
 *
 *  The count and the DELETE share ONE owner-pool transaction — but a shared transaction is NOT on
 *  its own enough, and it would be dishonest to claim otherwise. The transaction is READ COMMITTED,
 *  and counting child rows takes no lock on the parent, so without the `FOR UPDATE` below a
 *  concurrent INSERT commits inside the window and is cascaded away anyway. Demonstrated with two
 *  psql sessions: guard counts 0 → another session inserts a `usage_events` row and commits →
 *  DELETE succeeds → the new row is gone. A child INSERT takes `FOR KEY SHARE` on the parent and
 *  releases it at commit, so the later DELETE acquires its lock uncontended.
 *
 *  `FOR UPDATE` specifically — `FOR NO KEY UPDATE` does NOT conflict with the `FOR KEY SHARE` an
 *  inserting child takes, so it would not close the window. This matters because a ghost row (no
 *  Keycloak identity) can still be generating `usage_events`/`agent_sessions` right now via a live
 *  MCP API key or agent refresh token, and via the async run-pump's metering.
 *
 *  OFFBOARDING DOES NOT USE THIS — see `softDeleteLocalUser`. */
export async function removeLocalUser(sub: string): Promise<void> {
  await runAsSystem('tenant-parameterised', () =>
    db.transaction(async (tx) => {
      // Serialise against concurrent child INSERTs for the whole count→delete window.
      await tx.execute(sql`SELECT 1 FROM users WHERE id = ${sub} FOR UPDATE`);
      const deps = await findUserDependantsOn(tx, sub);
      if (deps.length) throw new UserHasDependantsError(sub, deps);
      await tx.delete(users).where(eq(users.id, sub));
    }),
  );
}

/** Tombstone a user's local row (offboarding, 0050). Returns true when a LIVE row was tombstoned,
 *  false when there was nothing to do — the row is absent, or already carries a `deleted_at`.
 *
 *  This is what offboarding uses instead of a hard delete: it releases the seat and removes the
 *  person from every roster while leaving the row to satisfy the 15 NO ACTION foreign keys, so
 *  their authorship survives. `deleted_at` is set only on a row that does not already have one, so
 *  a retried removal never rewrites the original offboarding timestamp.
 *
 *  `database` exists so `services/offboarding.ts offboardOneUser` can run this against a caller-
 *  supplied connection instead of re-writing the same UPDATE. There must be exactly one spelling of
 *  "tombstone a user": the predicate `deleted_at IS NULL` is the whole of the timestamp-preservation
 *  guarantee above, and a second copy is a second place for it to go missing. NB this is `typeof db`
 *  and NOT a transaction handle — drizzle's `PostgresJsDatabase & { $client }` does not admit a
 *  `PgTransaction`, and the tenant-wide offboard writes its own tenant-scoped UPDATE inside its
 *  transaction anyway. */
export async function softDeleteLocalUser(
  sub: string,
  database: typeof db = db,
): Promise<boolean> {
  const rows = await database
    .update(users)
    .set({ deleted_at: new Date(), updated_at: new Date() })
    .where(and(eq(users.id, sub), isNull(users.deleted_at)))
    .returning({ id: users.id });
  return rows.length > 0;
}

/**
 * Undo a realm identity THIS request minted, when a later step of the same request failed.
 *
 * Only ever deletes an identity with `created: true` — the realm is shared with fr, so an
 * identity CP did not create in this call is never touched. The local row half is removed only
 * for a minted sub (a row keyed on a seconds-old sub cannot predate this request); `removeLocalUser`
 * refuses anyway if anything references it. Best-effort; never throws.
 */
export async function rollbackProvisionedUser(
  kc: KeycloakAdminClient,
  sub: string,
  email: string,
  opts: { created: boolean },
): Promise<void> {
  if (!opts.created) return;
  try {
    await kc.deleteRealmUser(sub);
  } catch (err) {
    log.error('orphaned_keycloak_user', { component: 'provisioning', sub, email, err });
  }
  try {
    await removeLocalUser(sub);
  } catch (err) {
    log.error('stranded_user_row', { component: 'provisioning', sub, email, err });
  }
}
