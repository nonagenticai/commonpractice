// src/routes/tenant-users.ts — workspace membership management.
//
// Membership is CP-owned: `users.tenant_id` (the one home tenant) and `users.tenant_role`
// (member | developer | tenant_admin; NULL = not backfilled, treated as member). Keycloak is never
// written here — no attribute, no realm role, no user delete (the realm is shared with fr).
//
// Tenant-scoped (tenant_admin of :id, or super_admin):
//   • POST   /api/tenants/:id/users                       — invite a person (see invite-service).
//   • GET    /api/tenants/:id/invites                     — the workspace's invites.
//   • POST   /api/tenants/:id/invites/:inviteId/resend    — rotate the link + resend.
//   • DELETE /api/tenants/:id/invites/:inviteId           — revoke.
//   • PATCH  /api/tenants/:id/users/:userId               — set a member's level (DB only).
//   • DELETE /api/tenants/:id/users/:userId               — remove from the workspace (tombstone +
//                                                           seat release); the identity survives.
// The invitee (authenticated, no workspace needed):
//   • GET    /api/me/invites                              — pending invites for my verified email.
//   • POST   /api/invites/accept                          — accept by token or invite id.
// Platform (super_admin):
//   • PATCH  /api/admin/users/:userId/tenant              — move a person between workspaces.
//
// Last-admin guard: a workspace keeps ≥1 tenant_admin so it can always self-administer. Demoting,
// removing or moving out its last one is 409 `last_tenant_admin`.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, runAsSystem, users, withTenantTransaction } from '../db/client';
import { requireSuperAdmin, requireTenantAdmin, requireTenantExists } from '../middleware/admin-guards';
import { authenticateWithoutLicense } from '../middleware/auth';
import { auditActorId, recordAudit } from '../host/audit-service';
import { tenantScopedRoleSchema, assertTenantScopedRole } from '../services/provisioning';
import { ensureMemberEntitlement, revokeMemberEntitlement } from '../services/license-provisioning';
import { revokeKeysIssuedBy } from '../services/mcp-api-key';
import { revokeSessionsFor } from '../services/agent-session';
import { offboardOneUser } from '../services/offboarding';
import { claimSeatInTx, revokePendingInvitesInTx } from '../services/seat-limit';
import {
  acceptInvite,
  createInvite,
  listTenantInvites,
  pendingInvitesFor,
  resendInvite,
  revokeInvite,
  revokePendingInvitesForEmail,
} from '../services/invite-service';
import { jsonResponse, readJson, route, notFound, conflict } from '../utils/http';
import { log } from '../host/logger';
import { sameTenantId, tenantIdSchema } from '../utils/tenant-id';
import type { Router } from '../utils/router';
import type { TenantRole } from '../types';

// Body `tenantId` is accepted-and-IGNORED (force-scope): the invite lands in the path tenant.
const inviteMemberSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(1).max(160).optional(),
    // Explicit names (the members form sends these); they win over splitting `name`.
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().min(1).max(80).optional(),
    role: tenantScopedRoleSchema.optional(),
    tenantId: z.string().optional(), // ignored
  })
  .strip();

const patchTenantUserSchema = z.object({ role: tenantScopedRoleSchema }).strict();

const acceptSchema = z
  .object({ token: z.string().min(16).max(512).optional(), inviteId: z.string().uuid().optional() })
  .strict()
  .refine((b) => Boolean(b.token) !== Boolean(b.inviteId), {
    message: 'Provide exactly one of token or inviteId',
  });

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Lock the tenant row(s) FOR UPDATE, in id order. Every membership write that can drop the last
 * tenant_admin / last member takes this first, so the count it then reads cannot be invalidated by a
 * concurrent demote / remove / move committing in between. Same lock `claimSeat` takes.
 */
async function lockTenants(tx: Tx, ...ids: (string | null | undefined)[]): Promise<void> {
  const uniq = [...new Set(ids.filter((i): i is string => Boolean(i)))].sort();
  for (const id of uniq) await tx.execute(sql`SELECT 1 FROM tenants WHERE id = ${id} FOR UPDATE`);
}

/** Live tenant_admins of `tenantId`, read under `lockTenants`. */
async function countTenantAdmins(tx: Tx, tenantId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(eq(users.tenant_id, tenantId), isNull(users.deleted_at), eq(users.tenant_role, 'tenant_admin')),
    );
  return Number(row?.n ?? 0);
}

// ---- invites (tenant_admin) ----

/** POST /api/tenants/:id/users — invite a person into this workspace. */
const inviteTenantMember = route(async (req, id) => {
  const { user: actor, effectiveTenantId } = await requireTenantAdmin(req, { pathTenantId: id! });
  const body = inviteMemberSchema.parse(await readJson(req));
  const role = body.role ?? 'member';
  assertTenantScopedRole(role);
  const invite = await createInvite({
    tenantId: effectiveTenantId,
    email: body.email,
    role,
    invitedBy: actor.id,
    name: body.name,
    firstName: body.firstName,
    lastName: body.lastName,
  });
  return jsonResponse({ invite }, 201);
});

/** GET /api/tenants/:id/invites */
const listInvites = route(async (req, id) => {
  const { effectiveTenantId } = await requireTenantAdmin(req, { pathTenantId: id! });
  return jsonResponse({ invites: await listTenantInvites(effectiveTenantId) });
});

/** POST /api/tenants/:id/invites/:inviteId/resend */
const resendTenantInvite = route(async (req, id, inviteId) => {
  const { user: actor, effectiveTenantId } = await requireTenantAdmin(req, { pathTenantId: id! });
  const invite = await resendInvite(effectiveTenantId, inviteId!, actor.id);
  return jsonResponse({ invite });
});

/** DELETE /api/tenants/:id/invites/:inviteId */
const revokeTenantInvite = route(async (req, id, inviteId) => {
  const { user: actor, effectiveTenantId } = await requireTenantAdmin(req, { pathTenantId: id! });
  await revokeInvite(effectiveTenantId, inviteId!, actor.id);
  return new Response(null, { status: 204 });
});

// ---- the invitee ----

/**
 * GET /api/me/invites — pending invites for the caller's VERIFIED email. Gate 1 only: the caller
 * typically has no workspace yet, so there is no tenant to license-check.
 */
const myInvites = route(async (req) => {
  const user = await authenticateWithoutLicense(req);
  return jsonResponse({ invites: await pendingInvitesFor(user) });
});

/** POST /api/invites/accept — body `{token}` or `{inviteId}`. */
const acceptMyInvite = route(async (req) => {
  const user = await authenticateWithoutLicense(req);
  const body = acceptSchema.parse(await readJson(req));
  const result = await acceptInvite(user, body);
  return jsonResponse(result);
});

// ---- level + removal (tenant_admin) ----

/** PATCH /api/tenants/:id/users/:userId — set a member's level. DB only. */
const setTenantUserRole = route(async (req, id, userId) => {
  const { user: actor, effectiveTenantId } = await requireTenantAdmin(req, { pathTenantId: id! });
  const body = patchTenantUserSchema.parse(await readJson(req));
  assertTenantScopedRole(body.role);

  // Guard + write in ONE transaction under the tenant lock: two admins demoting each other at
  // once must not both pass a count that the other's commit makes stale.
  // Under the WORKSPACE's RLS scope, not a bypass: every row this touches belongs to it.
  const { fromRole, invitesRevoked } = await withTenantTransaction(effectiveTenantId, async (tx) => {
    await lockTenants(tx, effectiveTenantId);
    const [target] = await tx
      .select({ id: users.id, role: users.tenant_role, email: users.email })
      .from(users)
      .where(and(eq(users.id, userId!), eq(users.tenant_id, effectiveTenantId), isNull(users.deleted_at)))
      .for('update');
    if (!target) throw notFound('user_not_found', 'No such user in this tenant');
    if (body.role !== 'tenant_admin' && target.role === 'tenant_admin') {
      if ((await countTenantAdmins(tx, effectiveTenantId)) <= 1) {
        throw conflict(
          'last_tenant_admin',
          "Cannot demote the workspace's last admin — promote another member first",
        );
      }
    }
    await tx
      .update(users)
      .set({ tenant_role: body.role, updated_at: new Date() })
      .where(and(eq(users.id, userId!), eq(users.tenant_id, effectiveTenantId)));
    // A pending invite written at another level must not later re-apply it.
    const invitesRevoked = target.email
      ? await revokePendingInvitesInTx(tx, effectiveTenantId, target.email)
      : 0;
    return { fromRole: (target.role ?? 'member') as TenantRole, invitesRevoked };
  });

  // Agent access tokens carry the roles they were minted with; end those sessions so a demotion
  // takes effect for the co-pilot too.
  const sessionsRevoked = fromRole === body.role ? 0 : await revokeSessionsFor(userId!);

  await recordAudit({
    actorId: actor.id,
    tenantId: effectiveTenantId,
    action: 'member.set_role',
    category: 'auth',
    targetType: 'user',
    targetId: userId,
    result: body.role,
    resultTone: 'ok',
    metadata: { tenantId: effectiveTenantId, fromRole, role: body.role, sessionsRevoked, invitesRevoked },
  });
  return jsonResponse({ userId, role: body.role });
});

/**
 * DELETE /api/tenants/:id/users/:userId — remove a member from the workspace.
 *
 * Tombstones the row (0050; authorship survives the NO ACTION FKs), revokes CP-issued credentials,
 * releases the billed seat (non-fatal: a licences outage leaves the entitlement at `revoking` for
 * the reconciler) and revokes the address's pending invites here. The Keycloak identity is NOT
 * touched — it may be the same person's fr login — and without a CP row it has no workspace.
 */
const removeTenantMember = route(async (req, id, userId) => {
  const { user: actor, effectiveTenantId } = await requireTenantAdmin(req, { pathTenantId: id! });

  if (userId === actor.id) throw conflict('cannot_offboard_self', 'You cannot remove yourself');

  // Not filtered on `deleted_at`: a retry after a partial failure must still find the row.
  const [target] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.id, userId!), eq(users.tenant_id, effectiveTenantId)))
    .limit(1);
  if (!target) throw notFound('user_not_found', 'No such user in this tenant');

  // Last-admin guard and tombstone in ONE transaction under the tenant lock (see PATCH above), in
  // the WORKSPACE's RLS scope rather than a bypass.
  await withTenantTransaction(effectiveTenantId, async (tx) => {
    await lockTenants(tx, effectiveTenantId);
    const [row] = await tx
      .select({ role: users.tenant_role, deletedAt: users.deleted_at })
      .from(users)
      .where(and(eq(users.id, userId!), eq(users.tenant_id, effectiveTenantId)))
      .for('update');
    if (!row || row.deletedAt) return; // retry: already tombstoned
    if (row.role === 'tenant_admin' && (await countTenantAdmins(tx, effectiveTenantId)) <= 1) {
      throw conflict(
        'last_tenant_admin',
        "Cannot remove the workspace's last admin — promote another member first",
      );
    }
    await tx
      .update(users)
      .set({ deleted_at: new Date(), updated_at: new Date() })
      .where(and(eq(users.id, userId!), isNull(users.deleted_at)));
  });

  // Already tombstoned above; this revokes the CP-issued credentials.
  const { keysRevoked, sessionsRevoked } = await offboardOneUser(userId!);

  try {
    await revokeMemberEntitlement(effectiveTenantId, userId!);
  } catch (err) {
    log.error('member_entitlement_revoke_deferred', {
      tenantId: effectiveTenantId,
      userId,
      hint:
        'the member is removed, but their licence is still ACTIVE upstream and the tenant is still ' +
        'billed for the seat; the entitlement row is left at `revoking` for the reconciler to retry',
      err,
    });
  }

  const invitesRevoked = target.email
    ? await revokePendingInvitesForEmail(effectiveTenantId, target.email)
    : 0;

  await recordAudit({
    actorId: actor.id,
    tenantId: effectiveTenantId,
    action: 'member.remove',
    category: 'auth',
    targetType: 'user',
    targetId: userId,
    result: target.email,
    resultTone: 'ok',
    metadata: { tenantId: effectiveTenantId, keysRevoked, sessionsRevoked, invitesRevoked },
  });
  return jsonResponse({ userId, offboarded: true, keysRevoked, sessionsRevoked, invitesRevoked });
});

// ---- move a user between workspaces (super_admin) ----

/** `tenantIdSchema` (canonical lower-case), not a bare `.uuid()`. */
const moveUserTenantSchema = z
  .object({ tenantId: tenantIdSchema, role: tenantScopedRoleSchema.optional() })
  .strict();

/**
 * PATCH /api/admin/users/:userId/tenant — move a user's home tenant. DB only.
 *
 * `requireSuperAdmin` only: a move spends the destination's seat and removes a member (possibly
 * its last admin) from the source, and a tenant_admin administers at most one of the two.
 *
 * The level in the destination defaults to `member` when the person actually changes workspace
 * (an unstated level must never carry a tenant_admin across). Same workspace + no role = no-op.
 *
 * ORDER: guards + seat + column write in one transaction holding both tenant rows → hand the billed seat over
 * (revoke source, then ensure destination; non-fatal, reported as `seatFailures`) → revoke the
 * person's CP credentials (platform-wide for that one user — `runAsSystem`, because this guard does
 * not set the tenant GUC) → audit.
 */
const moveUserHomeTenant = route(async (req, userId) => {
  const actor = await requireSuperAdmin(req);
  const { tenantId: toTenantId, role: requestedRole } = moveUserTenantSchema.parse(await readJson(req));

  const [target] = await db
    .select({
      id: users.id,
      email: users.email,
      tenantId: users.tenant_id,
      tenantRole: users.tenant_role,
      deletedAt: users.deleted_at,
    })
    .from(users)
    .where(eq(users.id, userId!))
    .limit(1);
  if (!target) throw notFound('user_not_found', `No user '${userId}'`);
  if (target.deletedAt) {
    throw conflict(
      'user_offboarded',
      'This account was removed from its workspace and cannot be moved. Invite the address into the destination workspace instead.',
    );
  }

  await requireTenantExists(toTenantId);
  const fromTenantId = target.tenantId;
  const changesWorkspace = !sameTenantId(fromTenantId, toTenantId);

  const role: TenantRole | null = requestedRole ?? (changesWorkspace ? 'member' : null);
  if (role) assertTenantScopedRole(role);

  if (!changesWorkspace && !role) {
    return jsonResponse({
      userId,
      fromTenantId,
      toTenantId,
      role: target.tenantRole ?? null,
      keysRevoked: 0,
      sessionsRevoked: 0,
      seatFailures: [],
    });
  }

  // Guards + write in ONE transaction holding BOTH tenant rows (id order — no deadlock between
  // opposite moves): the source's last-member / last-admin counts and the destination's seat count
  // cannot go stale before the write commits.
  // Spans TWO workspaces, so no single RLS scope fits: an owner bypass, gated by requireSuperAdmin.
  await runAsSystem('platform-admin', () =>
    db.transaction(async (tx) => {
      await lockTenants(tx, fromTenantId, toTenantId);
      if (changesWorkspace) await claimSeatInTx(tx, toTenantId, target.email ?? undefined);
      const [now] = await tx
        .select({ tenantId: users.tenant_id, role: users.tenant_role, deletedAt: users.deleted_at })
        .from(users)
        .where(eq(users.id, userId!))
        .for('update');
      if (!now || now.deletedAt || now.tenantId !== fromTenantId) {
        throw conflict('user_changed', 'This account changed while it was being moved — reload and retry.');
      }
      if (fromTenantId && changesWorkspace) {
        // Last live MEMBER: a workspace with zero live rows has nobody to bind its licence to.
        const [liveRow] = await tx
          .select({ live: sql<number>`count(*)::int` })
          .from(users)
          .where(and(eq(users.tenant_id, fromTenantId), isNull(users.deleted_at)));
        if (Number(liveRow?.live ?? 0) <= 1) {
          throw conflict(
            'last_member',
            "Cannot move the source workspace's last live member — add another member there first, " +
              'or offboard the workspace instead.',
          );
        }
        if (now.role === 'tenant_admin' && (await countTenantAdmins(tx, fromTenantId)) <= 1) {
          throw conflict(
            'last_tenant_admin',
            "Cannot move the source workspace's last admin — promote another member there first",
          );
        }
      }
      await tx
        .update(users)
        .set({ tenant_id: toTenantId, ...(role ? { tenant_role: role } : {}), updated_at: new Date() })
        .where(and(eq(users.id, userId!), isNull(users.deleted_at)));
      // Seated / re-levelled here: a stale pending invite must not later re-apply its level.
      if (target.email) await revokePendingInvitesInTx(tx, toTenantId, target.email);
    }),
  );

  // ---- hand the BILLED seat over (0089) ----
  // The column write moves the headcount seat only; the invoiced seat is the member_entitlements
  // row. Revoke the source FIRST, then ensure the destination — the reverse order could bill the
  // person twice. Both are network calls outside any transaction and both are non-fatal: the move
  // has happened, and a failure is reported (and swept by the reconciler), not thrown.
  const seatFailures: { userId: string; tenantId: string; email: string; message: string }[] = [];
  if (changesWorkspace) {
    if (fromTenantId) {
      try {
        await revokeMemberEntitlement(fromTenantId, userId!);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('home_tenant_move_seat_revoke_deferred', {
          userId,
          tenantId: fromTenantId,
          remediation:
            'the member LEFT this workspace but their licence is still ACTIVE upstream; the ' +
            'entitlement row is left at `revoking` for `releaseStuckSeats` to retry',
          err,
        });
        seatFailures.push({ userId: userId!, tenantId: fromTenantId, email: target.email ?? '', message });
      }
    }
    try {
      // `userId` as the Keycloak subject: only rows written by the onboarding paths carry it as
      // their id; the reconciler's stricter `keycloak_sub` check covers seeded rows.
      const outcome = await ensureMemberEntitlement(toTenantId, userId!, userId!);
      if (outcome.state === 'pending') {
        log.warn('home_tenant_move_seat_pending', { userId, tenantId: toTenantId, reason: outcome.reason });
        seatFailures.push({
          userId: userId!,
          tenantId: toTenantId,
          email: target.email ?? '',
          message: `entitlement not active yet (pending: ${outcome.reason}) — the reconciler will finish it`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('home_tenant_move_seat_ensure_deferred', {
        userId,
        tenantId: toTenantId,
        remediation:
          'the member is IN this workspace but holds no licence; the onboarding-integrity ' +
          'reconciler sweeps members with no entitlement — or re-run the move',
        err,
      });
      seatFailures.push({ userId: userId!, tenantId: toTenantId, email: target.email ?? '', message });
    }
  }

  // CP-issued credentials are stamped with the tenant (and roles) at mint; end them all.
  const [keysRevoked, sessionsRevoked] = await runAsSystem('platform-admin', () =>
    Promise.all([revokeKeysIssuedBy(userId!), revokeSessionsFor(userId!)]),
  );

  await recordAudit({
    actorId: await auditActorId(actor.id),
    // Filed under the DESTINATION workspace (where the user now is); the origin is in metadata.
    tenantId: toTenantId,
    action: 'user.move',
    category: 'auth',
    targetType: 'user',
    targetId: userId,
    result: target.email,
    resultTone: 'warn',
    metadata: {
      actorSub: actor.id,
      fromTenantId,
      toTenantId,
      role,
      keysRevoked,
      sessionsRevoked,
      seatHandoverFailed: seatFailures.length,
    },
  });
  return jsonResponse({
    userId,
    fromTenantId,
    toTenantId,
    role,
    keysRevoked,
    sessionsRevoked,
    seatFailures,
  });
});

export function registerTenantUserRoutes(router: Router): void {
  router.add('POST', '/api/tenants/:id/users', inviteTenantMember);
  router.add('PATCH', '/api/tenants/:id/users/:userId', setTenantUserRole);
  router.add('DELETE', '/api/tenants/:id/users/:userId', removeTenantMember);
  router.add('GET', '/api/tenants/:id/invites', listInvites);
  router.add('POST', '/api/tenants/:id/invites/:inviteId/resend', resendTenantInvite);
  router.add('DELETE', '/api/tenants/:id/invites/:inviteId', revokeTenantInvite);
  router.add('GET', '/api/me/invites', myInvites);
  router.add('POST', '/api/invites/accept', acceptMyInvite);
  router.add('PATCH', '/api/admin/users/:userId/tenant', moveUserHomeTenant);
}
