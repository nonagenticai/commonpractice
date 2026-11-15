// src/services/invite-service.ts — CP-native workspace invitations (0094 `tenant_invites`).
//
// An invite binds an EMAIL to (tenant, role). It is accepted explicitly by a signed-in user whose
// VERIFIED email matches; acceptance writes `users.tenant_id` + `users.tenant_role` and claims the
// seat. Keycloak is only asked to make sure an identity exists for the address. An identity that
// cannot sign in yet — whoever created it (`identityLoginState`) — gets Keycloak's action email
// (set password [+ verify], redirecting to the accept page); one that can sign in — possibly
// somebody's fr login — gets a CP mail with the link, never a reset.
//
// RLS: every read/write of a known workspace's invites runs in `withTenantTransaction(tenantId)`, so
// the DATABASE confines it to that workspace (the route gate — requireTenantAdmin / requireSuperAdmin
// — decides WHICH workspace). Only the invitee's side crosses workspaces, and there the presented
// credential is the authorization: the emailed token, or the VERIFIED email of the signed-in caller,
// both checked in this file (`credential-auth`). The bare `users` / `tenants` reads are outside RLS.
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, lte, ne, sql } from 'drizzle-orm';
import { db, memberEntitlements, runAsSystem, tenants, users, withTenantDb, withTenantTransaction } from '../db/client';
import { tenantInvites } from '../db/schema';
import { config } from '../config';
import { keycloakAdmin } from './keycloak-admin';
import {
  assertAdoptableIdentity,
  findOrCreateRealmIdentity,
  identityLoginState,
  rollbackProvisionedUser,
  restoreRejectedIdentity,
  splitName,
  upsertLocalUserTx,
} from './provisioning';
import { claimSeatInTx, revokePendingInvitesInTx, type SeatTx } from './seat-limit';
import { ensureMemberEntitlement, ensureTenantLicense } from './license-provisioning';
import { recordAudit, auditActorId } from '../host/audit-service';
import { sendMail } from '../host/mailer';
import { log } from '../host/logger';
import { conflict, forbidden, HttpError, notFound } from '../utils/http';
import { isUniqueViolation } from '../utils/pg-errors';
import type { TenantRole, User } from '../types';

/** Invite lifetime. */
export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** The frontend client Keycloak's action email returns the user to. */
export const FRONTEND_CLIENT_ID = 'commonpractice-frontend';

export interface CreatedInvite {
  id: string;
  tenantId: string;
  email: string;
  role: TenantRole;
  expiresAt: string;
  emailDelivery: InviteDelivery;
  /** Always present; the one link that works when `emailDelivery` is 'failed'. */
  inviteUrl: string;
  /**
   * Set only by `seatIfMinted` (the early-access approve path): the identity CP minted for this
   * invite was SEATED at create, and the invite is already `accepted` by it. The email is NOT sent
   * here — the caller runs the `member_licence` + `invite_email` provisioning steps
   * (services/tenant-provisioning.ts), so the email only goes out once the licence exists.
   */
  seatedSub?: string;
}

export interface InviteView {
  id: string;
  email: string;
  role: TenantRole;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  createdAt: string;
  invitedBy: string | null;
}

export interface PendingInviteView {
  id: string;
  tenantId: string;
  tenantName: string;
  role: TenantRole;
  expiresAt: string;
}

// ---- token + url --------------------------------------------------------------------------------

function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The public origin of the CP app. `CP_PUBLIC_URL` when set; otherwise the first CORS origin, which
 * is the SPA's own origin in every deployment (the browser is the only cross-origin caller).
 */
export function publicAppUrl(): string {
  const explicit = (process.env.CP_PUBLIC_URL || '').trim();
  const base = explicit || config.cors.origins[0] || 'http://localhost:5174';
  return base.replace(/\/+$/, '');
}

/**
 * The accept link: emailed by CP AND handed to Keycloak as the action email's `redirect_uri`.
 *
 * ⛔ `login_hint` IS WHAT STOPS THE WRONG ACCOUNT FROM ACCEPTING. Keycloak's action-token flow
 * (set password) creates NO session, so the redirect lands on `login-required` init → an EMPTY
 * login form → the browser autofills whichever account it saved for this host. Measured in prod
 * 2026-10-13: the invitee set their password, Chrome filled a different saved account, and the
 * accept answered 403 `invite_email_mismatch` — twice. The SPA forwards this param to Keycloak's
 * `login_hint` so the form opens pre-filled with the invited address.
 *
 * ⚠️ `encodeURIComponent`, never a raw interpolation: `a+b@x` unencoded reads back as `a b@x`.
 */
export function inviteUrlFor(token: string, email: string): string {
  return (
    `${publicAppUrl()}/invite/accept?token=${encodeURIComponent(token)}` +
    `&login_hint=${encodeURIComponent(email)}`
  );
}

/**
 * `george@gmail.com` → `g•••••@gmail.com`: enough for the invitee to recognise WHICH of their
 * accounts the invite is for, without handing the full address to whoever is signed in (the
 * mismatch screen is shown to the WRONG account by definition). Domain kept; local part reduced to
 * its first character + one dot per remaining character, capped so length leaks little.
 */
export function maskEmail(email: string): string {
  const e = email.trim();
  const at = e.lastIndexOf('@');
  if (at <= 0) return '•••';
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const dots = '•'.repeat(Math.min(Math.max(local.length - 1, 3), 8));
  return `${local[0]}${dots}@${domain}`;
}

const normEmail = (email: string) => email.trim();

// ---- delivery -----------------------------------------------------------------------------------

/**
 * How the invite reached the invitee:
 *   `sent`             — CP's own mail with the accept link (the identity can already sign in);
 *   `keycloak_actions` — Keycloak's action email (set password [+ verify email]), which returns the
 *                        invitee to the accept link once done;
 *   `failed`           — neither went out; the create/resend response carries `inviteUrl` so the
 *                        admin can hand it over by hand;
 *   `deferred`         — the early-access approve path seated the invitee at create and sends the
 *                        Keycloak action email from its `invite_email` provisioning step, which waits
 *                        for the member licence (the onboarding-integrity tick retries it).
 */
export type InviteDelivery = 'sent' | 'keycloak_actions' | 'failed' | 'deferred';

/**
 * Send the invite. An identity that cannot sign in yet (`identityLoginState` → `needsSetup`) gets
 * Keycloak's action email; any other gets a CP mail with the link. Never throws — `failed` is returned
 * with the URL so the admin can hand it over.
 */
async function deliver(args: {
  sub: string | null;
  needsSetup: boolean;
  emailVerified: boolean;
  email: string;
  tenantName: string;
  role: TenantRole;
  inviteUrl: string;
}): Promise<InviteDelivery> {
  if (args.needsSetup && args.sub) {
    try {
      const actions = ['UPDATE_PASSWORD', ...(args.emailVerified ? [] : ['VERIFY_EMAIL'])];
      await keycloakAdmin().executeActionsEmail(args.sub, actions, {
        redirectUri: args.inviteUrl,
        clientId: FRONTEND_CLIENT_ID,
        lifespanSeconds: Math.floor(INVITE_TTL_MS / 1000),
      });
      return 'keycloak_actions';
    } catch (err) {
      log.error('invite_actions_email_failed', { component: 'invites', sub: args.sub, err });
      return 'failed';
    }
  }
  const sent = await sendMail({
    to: args.email,
    subject: `You're invited to ${args.tenantName} on Common Practice`,
    text:
      `You have been invited to join the workspace "${args.tenantName}" on Common Practice ` +
      `as ${args.role.replace('_', ' ')}.\n\n` +
      `Sign in with this email address and accept the invitation here:\n${args.inviteUrl}\n\n` +
      // The identity was judged able to sign in, but that judgement can be degraded (credentials
      // unreadable) or stale — this line is the way out for someone who cannot.
      `No password yet, or forgot it? Use "Forgot password" on the sign-in page to set one for ` +
      `this email address, then open the link above again.\n\n` +
      `The invitation expires in 14 days. If you did not expect it, you can ignore this email.`,
  });
  return sent ? 'sent' : 'failed';
}

/**
 * The login state of `sub` for delivery; a failed read degrades to "can sign in" (CP mail).
 *
 * `mintedUnverified` — the identity was minted by THIS invite and has not verified its email, i.e. it
 * has not finished the action email. When the credentials read is refused (403, expected for the SA)
 * that is the only evidence left: such an identity has NO required actions (`executeActionsEmail`
 * never adds any), so without this floor a resend degraded to the CP "sign in" mail for somebody who
 * has never had a password.
 */
async function setupNeeded(
  sub: string,
  created: boolean,
  requiredActions: string[],
  mintedUnverified = false,
): Promise<boolean> {
  if (created) return true; // CP minted it a moment ago: no credential exists by construction
  try {
    const state = await identityLoginState(keycloakAdmin(), sub, requiredActions);
    return state.needsSetup || (mintedUnverified && state.hasPassword === null);
  } catch (err) {
    log.warn('invite_login_state_unknown', { component: 'invites', sub, err });
    return requiredActions.includes('UPDATE_PASSWORD') || mintedUnverified;
  }
}

// ---- seat accounting ------------------------------------------------------------------------------

/**
 * Lock the tenant row FOR UPDATE and refuse a workspace that cannot invite. Offboarded is named
 * separately from merely suspended: a suspended workspace can be reactivated and then invite again,
 * an offboarded one never can (409 `tenant_offboarded`, as every other write to it answers).
 */
async function assertTenantCanInviteInTx(
  tx: SeatTx,
  tenantId: string,
): Promise<{ max: number | null } | undefined> {
  const [t] = await tx
    .select({ max: tenants.max_members, status: tenants.status, offboardedAt: tenants.offboarded_at })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .for('update');
  if (t?.offboardedAt) {
    throw conflict('tenant_offboarded', 'This workspace has been offboarded and cannot invite.');
  }
  if (t && t.status !== 'active') {
    throw conflict('tenant_not_active', 'This workspace is suspended and cannot invite.');
  }
  return t;
}

/**
 * Seats in use for an invite decision: live members + pending, unexpired invites. Locks the tenant
 * row FOR UPDATE so concurrent invites for the last seat serialise. `excludeInviteId` keeps an
 * invite from counting against its own renewal.
 */
async function assertInviteSeatInTx(
  tx: SeatTx,
  tenantId: string,
  excludeInviteId?: string,
): Promise<void> {
  const t = await assertTenantCanInviteInTx(tx, tenantId);
  const max = t?.max ?? null;
  if (max === null) return;
  const [m] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.tenant_id, tenantId), isNull(users.deleted_at)));
  const [p] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(tenantInvites)
    .where(
      and(
        eq(tenantInvites.tenant_id, tenantId),
        eq(tenantInvites.status, 'pending'),
        gt(tenantInvites.expires_at, new Date()),
        excludeInviteId ? ne(tenantInvites.id, excludeInviteId) : sql`true`,
      ),
    );
  const members = Number(m?.n ?? 0);
  const pending = Number(p?.n ?? 0);
  if (members + pending >= max) {
    throw new HttpError(
      409,
      'seats_full',
      `This workspace has used all ${max} of its seats (${members} members, ${pending} pending ` +
        `invites). Revoke an invite, remove a member, or ask your Common Practice contact to raise the limit.`,
      { used: members + pending, members, pending, max },
    );
  }
}

// ---- create -------------------------------------------------------------------------------------

/** Local guards that need no Keycloak call: the address is not already somebody's member. */
async function assertEmailInvitableHere(tenantId: string, email: string): Promise<void> {
  const rows = await db
    .select({ id: users.id, tenantId: users.tenant_id })
    .from(users)
    .where(and(sql`lower(${users.email}) = lower(${email})`, isNull(users.deleted_at)));
  for (const r of rows) {
    if (!r.tenantId) continue; // homeless identity: invitable
    if (r.tenantId === tenantId) {
      throw conflict('already_member', 'This person is already a member of this workspace.');
    }
    throw conflict(
      'email_in_other_tenant',
      'This email already belongs to another workspace. A person can belong to one workspace at a time.',
    );
  }
}

async function loadTenant(tenantId: string): Promise<{ id: string; name: string }> {
  const [t] = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!t) throw notFound('tenant_not_found', `No tenant '${tenantId}'`);
  return t;
}

/** The invitee's names for the realm identity: explicit first/last when given, else `name` split
 *  (`splitName`: never an empty half — the email's local part stands in when there is no name).
 *  The realm requires BOTH (VERIFY_PROFILE), so ONE explicit name fills the missing half too —
 *  the same "one word → both" rule `splitName` applies. */
function inviteNames(
  email: string,
  args: { name?: string; firstName?: string; lastName?: string },
): { firstName: string; lastName: string } {
  const first = args.firstName?.trim();
  const last = args.lastName?.trim();
  if (first || last) {
    return { firstName: first || last!, lastName: last || first! };
  }
  return splitName(args.name, email);
}

export async function createInvite(args: {
  tenantId: string;
  email: string;
  role: TenantRole;
  invitedBy: string | null;
  name?: string;
  /** Explicit names win over splitting `name` (a surname with spaces splits wrongly). */
  firstName?: string;
  lastName?: string;
  reqId?: string;
  /**
   * Early-access approve ONLY (routes/onboarding.ts, `mode: 'new_tenant'` with no seatable sub). When
   * THIS call mints the realm identity, seat it NOW — users row + accepted invite in one transaction —
   * instead of waiting for the invitee to accept. See `seatMintedIdentity` for why skipping the
   * email-verified requirement is safe here and only here. An identity that already existed takes the
   * ordinary invite path unchanged.
   */
  seatIfMinted?: boolean;
}): Promise<CreatedInvite> {
  const email = normEmail(args.email);
  const { tenantId, role } = args;
  const tenant = await loadTenant(tenantId);
  await assertEmailInvitableHere(tenantId, email);

  // An invite already pending for this address: renew + resend it rather than 409.
  const existing = await findPendingInvite(tenantId, email);
  if (existing) {
    return renewAndSend(tenantId, existing.id, args.invitedBy, { role, auditAction: 'invite.resend' });
  }

  // Fail fast before touching Keycloak; the locked re-check below is the enforcement.
  await withTenantTransaction(tenantId, (tx) => assertInviteSeatInTx(tx, tenantId));

  const kc = keycloakAdmin();
  const identity = await findOrCreateRealmIdentity(kc, { email, ...inviteNames(email, args) });
  // A CP-minted identity a signup reject left disabled, re-enabled just now with no credential of any
  // kind: nobody ever set it up, so it is treated exactly like one minted in this call (seat at
  // approval, keycloak_sub on the invite → the set-password email). NOT `created`: never deleted.
  const minted = identity.created || identity.reclaimed?.credentialless === true;
  const undoIdentity = () =>
    identity.created
      ? rollbackProvisionedUser(kc, identity.sub, email, { created: true })
      : restoreRejectedIdentity(kc, identity, email);
  try {
    if (!identity.created) await assertAdoptableIdentity(kc, identity.sub, email);
  } catch (err) {
    await restoreRejectedIdentity(kc, identity, email);
    throw err;
  }

  const { token, hash } = newToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const invitedBy = await auditActorId(args.invitedBy);
  if (args.seatIfMinted && minted) {
    return seatMintedIdentity({
      undoIdentity,
      // The reclaimed identity's users row was tombstoned by the reject's offboard.
      restoreTombstone: !identity.created,
      tenantId,
      email,
      role,
      name: args.name ?? null,
      sub: identity.sub,
      token,
      hash,
      expiresAt,
      invitedBy,
      actorSub: args.invitedBy,
    });
  }
  let inviteId: string;
  try {
    inviteId = await withTenantTransaction(tenantId, async (tx) => {
      await assertInviteSeatInTx(tx, tenantId);
      const [row] = await tx
        .insert(tenantInvites)
        .values({
          tenant_id: tenantId,
          email,
          role,
          token_hash: hash,
          // Set ONLY when this invite minted the identity — it is what tells a resend to use the
          // Keycloak action email (credential setup) rather than a CP mail.
          keycloak_sub: minted ? identity.sub : null,
          invited_by: invitedBy,
          expires_at: expiresAt,
        })
        .returning({ id: tenantInvites.id });
      return row!.id;
    });
  } catch (err) {
    // A concurrent request for the same address won the pending-invite unique index: that invite
    // is the answer (contract: invite_pending → resend). The identity it needs may be the one this
    // call minted, so it is handed over, never deleted.
    if (isUniqueViolation(err)) {
      const winner = await findPendingInvite(tenantId, email);
      if (winner) {
        if (minted) {
          await withTenantTransaction(tenantId, (tx) =>
            tx
              .update(tenantInvites)
              .set({ keycloak_sub: identity.sub })
              .where(and(eq(tenantInvites.id, winner.id), isNull(tenantInvites.keycloak_sub))),
          );
        }
        return renewAndSend(tenantId, winner.id, args.invitedBy, { role, auditAction: 'invite.resend' });
      }
    }
    // Delete a freshly minted identity only when no pending invite (any workspace) points at this
    // address — another request may have minted-or-found the same identity for its own invite.
    // Necessarily cross-workspace, so it reads as the owner — but only a BOOLEAN comes back: no
    // row, id or field of another workspace's invite reaches this caller.
    const [ref] = (await runAsSystem('cross-tenant-aggregate', () =>
      db.execute(sql`
        SELECT exists (
          SELECT 1 FROM tenant_invites WHERE status = 'pending' AND lower(email) = lower(${email})
        ) AS referenced`),
    )) as unknown as { referenced: boolean }[];
    if (ref?.referenced !== true) await undoIdentity();
    throw err;
  }

  const inviteUrl = inviteUrlFor(token, email);
  // A reclaimed identity whose credentials could not be read: CP minted it and its email is not
  // verified, so the degraded predicate leans to the set-password email (see `setupNeeded`).
  const needsSetup = await setupNeeded(
    identity.sub,
    minted,
    identity.requiredActions,
    !!identity.reclaimed && !identity.emailVerified,
  );
  const emailDelivery = await deliver({
    sub: identity.sub,
    needsSetup,
    emailVerified: identity.emailVerified,
    email,
    tenantName: tenant.name,
    role,
    inviteUrl,
  });
  await recordAudit({
    actorId: invitedBy,
    action: 'invite.create',
    category: 'auth',
    targetType: 'invite',
    targetId: inviteId,
    result: email,
    resultTone: 'ok',
    tenantId,
    metadata: {
      tenantId,
      role,
      emailDelivery,
      identityCreated: identity.created,
      ...(identity.reclaimed ? { identityReclaimed: identity.reclaimed } : {}),
      needsSetup,
      actorSub: args.invitedBy,
    },
  });
  return {
    id: inviteId,
    tenantId,
    email,
    role,
    expiresAt: expiresAt.toISOString(),
    emailDelivery,
    inviteUrl,
  };
}

/**
 * Seat an identity CP minted a moment ago for this invite, and record the invite as already accepted
 * by it — the "licence at approval" ruling (George 2026-10-19, early-access v2): the workspace AND the
 * member's seat + licence exist before the email goes out, so the link lands the person straight in
 * a working app instead of a ~6 s "setting up" wait after they set a password.
 *
 * ⛔ WHY NO VERIFIED EMAIL IS REQUIRED HERE, AND WHY ONLY HERE. Everywhere else CP seats a sub only
 * when the realm (or the token) proves that sub owns the address (`realmSubOwnsEmail`,
 * `acceptInvite`), because an existing identity may belong to somebody else. This identity has no
 * such history: CP created it in this call, for this address, with no credential and no IdP link.
 * Nobody can sign in as it until somebody sets its password — and the only way to do that is the
 * Keycloak action link mailed to THIS address, which also completes VERIFY_EMAIL. So the seat is
 * only usable by the inbox owner, which is exactly what the verified-email rule protects. An identity
 * that already existed (`created: false` — e.g. someone's fr login) never takes this path.
 *
 * The same holds for a credential-less identity CP minted for an earlier signup that was REJECTED
 * and is re-enabled now (`RealmIdentity.reclaimed`): the realm positively reports no credential and no
 * IdP link, so again only the action link to this address can make it usable. Its users row was
 * tombstoned by that reject's offboard, hence `restoreTombstone`.
 *
 * Rollback: a failure here deletes a minted identity (nothing else can reference it yet), or puts a
 * reclaimed one back the way the reject left it (disabled + marker).
 */
async function seatMintedIdentity(a: {
  /** Undo the identity on failure: delete a minted one, re-disable + re-mark a reclaimed one. */
  undoIdentity: () => Promise<void>;
  restoreTombstone: boolean;
  tenantId: string;
  email: string;
  role: TenantRole;
  name: string | null;
  sub: string;
  token: string;
  hash: string;
  expiresAt: Date;
  invitedBy: string | null;
  actorSub: string | null;
}): Promise<CreatedInvite> {
  let inviteId: string;
  try {
    inviteId = await withTenantTransaction(a.tenantId, async (tx) => {
      // The same cap + workspace check the accept would run (locks the tenant row FOR UPDATE).
      await claimSeatInTx(tx, a.tenantId, a.email);
      await assertNoOtherHome(tx, a.sub, a.email, a.tenantId);
      await upsertLocalUserTx(tx, a.sub, a.email, a.name, a.tenantId, a.role, {
        onlyIfHomelessOrIn: a.tenantId,
        ...(a.restoreTombstone ? { restoreTombstone: true } : {}),
      });
      const now = new Date();
      const [row] = await tx
        .insert(tenantInvites)
        .values({
          tenant_id: a.tenantId,
          email: a.email,
          role: a.role,
          token_hash: a.hash,
          keycloak_sub: a.sub,
          invited_by: a.invitedBy,
          expires_at: a.expiresAt,
          status: 'accepted',
          accepted_at: now,
          accepted_by: a.sub,
        })
        .returning({ id: tenantInvites.id });
      return row!.id;
    });
  } catch (err) {
    await a.undoIdentity();
    throw err;
  }
  await recordAudit({
    actorId: a.invitedBy,
    action: 'invite.create',
    category: 'auth',
    targetType: 'invite',
    targetId: inviteId,
    result: a.email,
    resultTone: 'ok',
    tenantId: a.tenantId,
    metadata: {
      tenantId: a.tenantId,
      role: a.role,
      emailDelivery: 'deferred',
      identityCreated: !a.restoreTombstone,
      ...(a.restoreTombstone ? { identityReclaimed: true } : {}),
      seatedAtCreate: true,
      actorSub: a.actorSub,
    },
  });
  return {
    id: inviteId,
    tenantId: a.tenantId,
    email: a.email,
    role: a.role,
    expiresAt: a.expiresAt.toISOString(),
    emailDelivery: 'deferred',
    inviteUrl: inviteUrlFor(a.token, a.email),
    seatedSub: a.sub,
  };
}

/** The pending invite for `email` in `tenantId`, read under that workspace's RLS scope. */
async function findPendingInvite(tenantId: string, email: string): Promise<{ id: string } | undefined> {
  const [row] = await withTenantTransaction(tenantId, (tx) =>
    tx
      .select({ id: tenantInvites.id })
      .from(tenantInvites)
      .where(
        and(
          eq(tenantInvites.tenant_id, tenantId),
          eq(tenantInvites.status, 'pending'),
          sql`lower(${tenantInvites.email}) = lower(${email})`,
        ),
      )
      .limit(1),
  );
  return row;
}

/** 409 `invite_superseded`: a newer invite for the same address is already pending here. Built
 *  with `conflict()` so the frontend's backend-contract scrape sees the code. */
function inviteSuperseded(): HttpError {
  return conflict(
    'invite_superseded',
    'A newer invitation for this address is already pending in this workspace — resend that one instead.',
  );
}

/** Rotate the token, extend the expiry, and deliver again — under `tenantId`'s RLS scope. */
async function renewAndSend(
  tenantId: string,
  inviteId: string,
  actorId: string | null,
  opts: { role?: TenantRole; auditAction: 'invite.resend' },
): Promise<CreatedInvite> {
  const tenant = await loadTenant(tenantId);
  const { token, hash } = newToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const row = await withTenantTransaction(tenantId, async (tx) => {
    const [inv] = await tx
      .select()
      .from(tenantInvites)
      .where(and(eq(tenantInvites.id, inviteId), eq(tenantInvites.tenant_id, tenantId)))
      .for('update');
    if (!inv) throw notFound('invite_not_found', 'No such invite in this workspace');
    if (inv.status !== 'pending' && inv.status !== 'expired') {
      throw new HttpError(410, 'invite_not_pending', `This invite is already ${inv.status}`);
    }
    // A lapsed invite was not holding a seat; renewing it takes one again (the seat check includes
    // the workspace check). A still-live invite holds its seat — but a SUSPENDED or offboarded
    // workspace must not re-email it either, so the workspace is checked on every resend.
    if (inv.status === 'expired' || inv.expires_at.getTime() <= Date.now()) {
      await assertInviteSeatInTx(tx, tenantId, inv.id);
    } else {
      await assertTenantCanInviteInTx(tx, tenantId);
    }
    // ⛔ An EXPIRED invite flips back to `pending` below, and `tenant_invites_one_pending_per_email`
    // (0094) allows ONE pending invite per (tenant, address). When a newer invite for the same
    // address is already pending, the old one is superseded: answer 409 `invite_superseded` (resend
    // the newer one) instead of letting the UPDATE die on the index as an unhandled 23505 → 500.
    // Checked after the seat check, which holds the tenant row FOR UPDATE (createInvite takes the
    // same lock before it inserts); the 23505 catch below covers whatever still races past it.
    if (inv.status === 'expired') {
      const [newer] = await tx
        .select({ id: tenantInvites.id })
        .from(tenantInvites)
        .where(
          and(
            eq(tenantInvites.tenant_id, tenantId),
            eq(tenantInvites.status, 'pending'),
            ne(tenantInvites.id, inv.id),
            sql`lower(${tenantInvites.email}) = lower(${inv.email})`,
          ),
        )
        .limit(1);
      if (newer) throw inviteSuperseded();
    }
    try {
      const [updated] = await tx
        .update(tenantInvites)
        .set({
          token_hash: hash,
          expires_at: expiresAt,
          resent_at: new Date(),
          status: 'pending',
          ...(opts.role ? { role: opts.role } : {}),
        })
        .where(eq(tenantInvites.id, inv.id))
        .returning();
      return updated!;
    } catch (err) {
      // Only the one-pending-per-email index means "superseded"; any other collision (e.g. token_hash)
      // is a real error and must not be reported as a newer invite.
      if (isUniqueViolation(err, 'tenant_invites_one_pending_per_email')) throw inviteSuperseded();
      throw err;
    }
  });

  // The SAME predicate as create: the identity's login state, whoever created it. The realm is asked
  // again because that state moves (the invitee may have set a password since the first send).
  let sub: string | null = row.keycloak_sub;
  let needsSetup = false;
  let emailVerified = false;
  try {
    const realm = await keycloakAdmin().findRealmUserByUsernameOrEmail(row.email, row.email);
    if (realm) {
      sub = realm.id;
      emailVerified = realm.emailVerified === true;
      const mintedUnverified = row.keycloak_sub === realm.id && !emailVerified;
      needsSetup = await setupNeeded(realm.id, false, realm.requiredActions ?? [], mintedUnverified);
    }
  } catch (err) {
    // Could not ask. An identity this invite minted cannot have had a password set through CP's
    // flow unless the action email worked — re-send that; otherwise the CP mail (with its
    // "Forgot password" line) is the safe default.
    needsSetup = row.keycloak_sub !== null;
    log.warn('invite_resend_realm_lookup_failed', { component: 'invites', inviteId, err });
  }
  const inviteUrl = inviteUrlFor(token, row.email);
  const emailDelivery = await deliver({
    sub,
    needsSetup,
    emailVerified,
    email: row.email,
    tenantName: tenant.name,
    role: row.role,
    inviteUrl,
  });
  await recordAudit({
    actorId: await auditActorId(actorId),
    action: opts.auditAction,
    category: 'auth',
    targetType: 'invite',
    targetId: row.id,
    result: row.email,
    resultTone: 'ok',
    tenantId,
    metadata: { tenantId, role: row.role, emailDelivery, actorSub: actorId },
  });
  return {
    id: row.id,
    tenantId,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at.toISOString(),
    emailDelivery,
    inviteUrl,
  };
}

// ---- list / revoke / resend -------------------------------------------------------------------------

export async function listTenantInvites(tenantId: string): Promise<InviteView[]> {
  const rows = await withTenantTransaction(tenantId, (tx) =>
    tx
      .select()
      .from(tenantInvites)
      .where(eq(tenantInvites.tenant_id, tenantId))
      .orderBy(desc(tenantInvites.created_at)),
  );
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    status: r.status === 'pending' && r.expires_at.getTime() <= now ? 'expired' : r.status,
    expiresAt: r.expires_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    invitedBy: r.invited_by,
  }));
}

export async function revokeInvite(tenantId: string, inviteId: string, actorId: string): Promise<void> {
  const revoked = await withTenantTransaction(tenantId, async (tx) => {
    const [row] = await tx
      .update(tenantInvites)
      .set({ status: 'revoked', revoked_at: new Date() })
      .where(
        and(
          eq(tenantInvites.id, inviteId),
          eq(tenantInvites.tenant_id, tenantId),
          eq(tenantInvites.status, 'pending'),
        ),
      )
      .returning({ id: tenantInvites.id, email: tenantInvites.email });
    if (row) return row;
    const [any] = await tx
      .select({ status: tenantInvites.status })
      .from(tenantInvites)
      .where(and(eq(tenantInvites.id, inviteId), eq(tenantInvites.tenant_id, tenantId)))
      .limit(1);
    if (!any) throw notFound('invite_not_found', 'No such invite in this workspace');
    throw new HttpError(410, 'invite_not_pending', `This invite is already ${any.status}`);
  });
  await recordAudit({
    actorId: await auditActorId(actorId),
    action: 'invite.revoke',
    category: 'auth',
    targetType: 'invite',
    targetId: inviteId,
    result: revoked.email,
    resultTone: 'warn',
    tenantId,
    metadata: { tenantId, actorSub: actorId },
  });
}

/** Revoke every pending invite for `email` in `tenantId` (member removal). Returns the count. */
export async function revokePendingInvitesForEmail(tenantId: string, email: string): Promise<number> {
  const rows = await withTenantTransaction(tenantId, (tx) =>
    tx
      .update(tenantInvites)
      .set({ status: 'revoked', revoked_at: new Date() })
      .where(
        and(
          eq(tenantInvites.tenant_id, tenantId),
          eq(tenantInvites.status, 'pending'),
          sql`lower(${tenantInvites.email}) = lower(${email})`,
        ),
      )
      .returning({ id: tenantInvites.id }),
  );
  return rows.length;
}

export async function resendInvite(
  tenantId: string,
  inviteId: string,
  actorId: string,
): Promise<CreatedInvite> {
  return renewAndSend(tenantId, inviteId, actorId, { auditAction: 'invite.resend' });
}

// ---- the invitee's side -----------------------------------------------------------------------------

/**
 * Pending invites addressed to the signed-in caller, across every workspace. The gate is HERE, not
 * in the route: only a VERIFIED email (a claim of the caller's validated token) is looked up — an
 * unverified address proves nothing about who is asking, and the caller has no workspace yet, so no
 * tenant scope can exist for this read.
 */
export async function pendingInvitesFor(
  user: Pick<User, 'email' | 'emailVerified'>,
): Promise<PendingInviteView[]> {
  if (user.emailVerified !== true || !user.email) return [];
  const email = user.email;
  const rows = await runAsSystem('credential-auth', () =>
    db
      .select({
        id: tenantInvites.id,
        tenantId: tenantInvites.tenant_id,
        tenantName: tenants.name,
        role: tenantInvites.role,
        expiresAt: tenantInvites.expires_at,
      })
      .from(tenantInvites)
      .innerJoin(tenants, eq(tenants.id, tenantInvites.tenant_id))
      .where(
        and(
          sql`lower(${tenantInvites.email}) = lower(${normEmail(email)})`,
          eq(tenantInvites.status, 'pending'),
          gt(tenantInvites.expires_at, new Date()),
        ),
      )
      .orderBy(desc(tenantInvites.created_at)),
  );
  return rows.map((r) => ({ ...r, expiresAt: r.expiresAt.toISOString() }));
}

function otherHome(): HttpError {
  return conflict(
    'email_in_other_tenant',
    'You already belong to another workspace. A person can belong to one workspace at a time.',
  );
}

/** Refuse when this identity, or another live row with this address, is homed in another tenant. */
async function assertNoOtherHome(
  runner: Pick<SeatTx, 'select'>,
  userId: string,
  email: string,
  tenantId: string,
): Promise<void> {
  const homes = await runner
    .select({ tenantId: users.tenant_id })
    .from(users)
    .where(
      and(
        isNull(users.deleted_at),
        sql`(${users.id} = ${userId} OR lower(${users.email}) = lower(${email}))`,
      ),
    );
  if (homes.some((h) => h.tenantId && h.tenantId !== tenantId)) throw otherHome();
}

/**
 * Accept an invite as the signed-in `user`. The invite is found by `token` (the emailed link) or by
 * `inviteId` (the no-workspace screen's list); either way the caller's VERIFIED email must equal the
 * invite's, so knowing an id grants nothing.
 *
 * Idempotent for the same user WHILE they are still a live member of the invite's workspace: the
 * replay answers at once without touching licences (the tick finishes a missing licence). Once they
 * were removed or moved, the spent invite is 410 `invite_not_pending`.
 *
 * Accepted by somebody already a member of that workspace, the invite is consumed WITHOUT touching
 * `tenant_role` — a stale invite must not undo a later demotion.
 */
export async function acceptInvite(
  user: User,
  by: { token?: string; inviteId?: string },
): Promise<{ tenantId: string; role: TenantRole; setupPending?: true }> {
  if (!by.token && !by.inviteId) {
    throw new HttpError(400, 'invite_reference_required', 'Provide token or inviteId');
  }
  // The ONE cross-workspace read: resolving the presented reference to its invite. No workspace is
  // known until it resolves; the authorization is the credential — the emailed token, or (by id)
  // the caller's VERIFIED email, which must equal the invite's before anything below runs.
  const [invite] = await runAsSystem('credential-auth', () =>
    db
      .select()
      .from(tenantInvites)
      .where(by.token ? eq(tenantInvites.token_hash, hashToken(by.token)) : eq(tenantInvites.id, by.inviteId!))
      .limit(1),
  );
  if (!invite) throw notFound('invite_not_found', 'This invitation does not exist');
  if (user.emailVerified !== true) {
    throw forbidden('email_not_verified', 'Verify your email address before accepting an invitation.');
  }
  if (!user.email || user.email.trim().toLowerCase() !== invite.email.trim().toLowerCase()) {
    // The MASKED target only — this body is read by the wrong account by definition.
    throw forbidden('invite_email_mismatch', 'This invitation was sent to a different email address.', {
      invitedEmail: maskEmail(invite.email),
    });
  }
  const result = await consumeInvite(user, invite);

  // ⭐ AN ACCEPTANCE THAT ALREADY STANDS IS INSTANT (early-access v2). The early-access approve path
  // seats the invitee and runs their licence steps BEFORE the email goes out (`seatMintedIdentity` +
  // the `member_licence` provisioning step), so the link's /invite/accept finds the invite already
  // accepted by this very user: nothing is left to do, and the old ~6 s licence round-trip here was
  // pure waiting. The same holds for any replay by a live member. If a licence is still missing,
  // the onboarding-integrity tick (`repairUnseatedMembers`, `member_licence`) finishes it and the
  // app shows its own "being set up" state meanwhile — no request ever waits on licences here.
  if (result.already) return { tenantId: result.tenantId, role: result.role };

  // Licence steps outside any transaction (network calls). `user.id` is the realm subject: it came
  // from a verified token.
  //
  // ⛔ THE SEAT IS ALREADY COMMITTED, SO A FAILURE HERE IS NOT THE INVITEE'S ERROR. `consumeInvite`
  // made them a member; throwing now showed an error page to somebody who IS seated — and whose
  // replay then re-ran these same calls against the same outage. The seat is finished by the
  // onboarding-integrity tick (`repairUnseatedMembers` re-offers every member without a live
  // entitlement), so the honest answer is success + `setupPending`, and an `error` entitlement row
  // that makes the licence status say "being set up" instead of "ask for a seat".
  const setupPending = await finishLicenceSetup(result.tenantId, user.id);

  if (!result.already) {
    await recordAudit({
      actorId: user.id,
      action: 'invite.accept',
      category: 'auth',
      targetType: 'user',
      targetId: user.id,
      result: user.email,
      resultTone: 'ok',
      tenantId: result.tenantId,
      metadata: {
        tenantId: result.tenantId,
        role: result.role,
        inviteId: result.inviteId,
        joined: result.joined,
        ...(setupPending ? { setupPending: true } : {}),
      },
    });
  }
  return { tenantId: result.tenantId, role: result.role, ...(setupPending ? { setupPending: true as const } : {}) };
}

/** The accept-time licence steps. `true` = they did not finish and the tick will (see acceptInvite). */
async function finishLicenceSetup(tenantId: string, userId: string): Promise<boolean> {
  try {
    await ensureTenantLicense(tenantId, userId);
    const out = await ensureMemberEntitlement(tenantId, userId, userId);
    // Another caller (the tick, a parallel accept) holds the in-flight mint: not done yet either.
    return out.state === 'pending' && out.reason === 'held-by-another-caller';
  } catch (err) {
    log.warn('invite_accept_licence_setup_deferred', { tenantId, userId, err });
    await markEntitlementSetupPending(tenantId, userId, err);
    return true;
  }
}

/**
 * Leave an `error` entitlement row for a seated member whose licence setup failed — the state the
 * reconciler re-claims immediately and `GET /api/license/status` reports as `seat_pending`. A row
 * `ensureMemberEntitlement` already parked (its own mint failure) or a live one is left untouched.
 * Best-effort: the tick re-offers the member with or without it.
 */
async function markEntitlementSetupPending(tenantId: string, userId: string, err: unknown): Promise<void> {
  if (!config.license.issuanceEnabled) return;
  try {
    await withTenantDb(tenantId, () =>
      db
        .insert(memberEntitlements)
        .values({
          tenant_id: tenantId,
          user_id: userId,
          app_key: config.license.appKey,
          status: 'error',
          last_error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        })
        .onConflictDoNothing(),
    );
  } catch (writeErr) {
    log.warn('invite_accept_setup_pending_mark_failed', { tenantId, userId, err: writeErr });
  }
}

/**
 * The seating half of `acceptInvite`, for an invite whose credential check has ALREADY passed. Every
 * write is tenant-scoped to `invite.tenant_id` (or the seat claim's own transaction).
 */
async function consumeInvite(
  user: User,
  invite: typeof tenantInvites.$inferSelect,
): Promise<{ tenantId: string; role: TenantRole; already: boolean; joined: boolean; inviteId: string }> {
  if (invite.status === 'accepted' && invite.accepted_by === user.id) {
    // A replay is idempotent only while that acceptance still stands: the caller is a LIVE member
    // of the invite's workspace. Removed or moved since → the invite is spent, and re-running the
    // licence steps below would mint a billed seat for somebody who is no longer here.
    const [me] = await db
      .select({ tenantId: users.tenant_id, role: users.tenant_role, deletedAt: users.deleted_at })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (me && !me.deletedAt && me.tenantId === invite.tenant_id) {
      return {
        tenantId: invite.tenant_id,
        role: (me.role ?? 'member') as TenantRole,
        already: true,
        joined: false,
        inviteId: invite.id,
      };
    }
    throw new HttpError(410, 'invite_not_pending', 'This invitation was already used.');
  }
  if (invite.status === 'accepted' || invite.status === 'revoked') {
    throw new HttpError(410, 'invite_not_pending', `This invitation was ${invite.status}.`);
  }
  if (invite.status === 'expired' || invite.expires_at.getTime() <= Date.now()) {
    await withTenantTransaction(invite.tenant_id, (tx) =>
      tx
        .update(tenantInvites)
        .set({ status: 'expired' })
        .where(and(eq(tenantInvites.id, invite.id), eq(tenantInvites.status, 'pending'))),
    );
    throw new HttpError(410, 'invite_expired', 'This invitation has expired. Ask for a new one.');
  }

  // One home tenant: a live membership elsewhere (by identity or by address) refuses. Pre-flight;
  // re-checked under the row lock below.
  await assertNoOtherHome(db, user.id, invite.email, invite.tenant_id);

  // Seat claim + seating in ONE transaction under the invite's WORKSPACE RLS scope (the same shape
  // the SSO/JIT path uses), so the invite writes below cannot reach another workspace's rows.
  return withTenantTransaction(invite.tenant_id, async (tx) => {
    await claimSeatInTx(tx, invite.tenant_id, invite.email, { excludeInviteId: invite.id });
    // Lock order: tenant row (claimSeatInTx), then this users row.
    const [me] = await tx
      .select({ tenantId: users.tenant_id, role: users.tenant_role, deletedAt: users.deleted_at })
      .from(users)
      .where(eq(users.id, user.id))
      .for('update');
    let role: TenantRole = invite.role;
    let joined = true;
    if (me && !me.deletedAt && me.tenantId) {
      if (me.tenantId !== invite.tenant_id) throw otherHome();
      // Already a member here: the invite is consumed, the level an admin set since is kept.
      role = (me.role ?? 'member') as TenantRole;
      joined = false;
    } else {
      await assertNoOtherHome(tx, user.id, invite.email, invite.tenant_id);
      await upsertLocalUserTx(tx, user.id, user.email, user.name, invite.tenant_id, invite.role, {
        restoreTombstone: true,
        onlyIfHomelessOrIn: invite.tenant_id,
      });
    }
    const moved = await tx
      .update(tenantInvites)
      .set({ status: 'accepted', accepted_at: new Date(), accepted_by: user.id })
      .where(and(eq(tenantInvites.id, invite.id), eq(tenantInvites.status, 'pending')))
      .returning({ id: tenantInvites.id });
    if (!moved.length) {
      throw new HttpError(410, 'invite_not_pending', 'This invitation was changed while accepting it.');
    }
    await revokePendingInvitesInTx(tx, invite.tenant_id, invite.email, invite.id);
    return { tenantId: invite.tenant_id, role, already: false, joined, inviteId: invite.id };
  });
}

/** Mark lapsed pending invites `expired`. Returns how many changed. Scheduler-safe. */
export async function expireInvites(): Promise<number> {
  const rows = await runAsSystem('scheduler-tick', () =>
    db
      .update(tenantInvites)
      .set({ status: 'expired' })
      .where(and(eq(tenantInvites.status, 'pending'), lte(tenantInvites.expires_at, new Date())))
      .returning({ id: tenantInvites.id }),
  );
  return rows.length;
}
