// src/services/offboarding.ts — the ONE place that says what "offboarded" means, for a single
// member and for a whole workspace.
//
// Callers:
//   • `routes/tenant-users.ts removeTenantMember` — DELETE /api/tenants/:id/users/:userId. One
//     member, tenant_admin-driven, guarded by the last-admin rule; uses `offboardOneUser`.
//   • `routes/admin.ts offboardTenant` (POST /api/tenants/:id/offboard, super_admin) and
//     `scripts/offboard-tenant.ts` (an operator, no JWT) — the WHOLE workspace. Both run
//     `offboardTenantFully` below and nothing else, so the route and the script cannot drift: the
//     script used to be a hand copy that skipped invites, IdPs, seats, the inference credential and
//     the central archive.
//
// ⛔ KEYCLOAK IS NEVER TOUCHED. The portal realm is shared with fr, so a person leaving a CP
// workspace keeps their login; CP access ends with the tombstone + credential revocation here, and
// there is no CP workspace left for that identity to reach. (Older revisions deleted realm users.)
// ONE exception, at the bottom of this file: the identity CP itself MINTED for a signup that was then
// REJECTED is deleted when it never got a credential, else disabled + marked so a re-signup can
// re-enable it — see `retireRejectedIdentity`.
//
// ⛔ WHY THE TENANT OFFBOARD DOES NOT LOOP OVER `offboardOneUser`: THE KEY REVOCATION IS NOT
// PER-USER. `mcp_api_keys.issued_by` is `ON DELETE SET NULL` (db/schema.ts), so a key whose issuer's
// row was hard-deleted at some point in the past has a NULL issuer and belongs to no user at all —
// `revokeKeysIssuedBy` cannot see it. Only a TENANT-scoped revoke (`WHERE tenant_id = :id AND
// revoked_at IS NULL`) catches those, and leaving them live is precisely the "departed customer keeps
// a working MCP key" hole this whole feature exists to close.
//
// What both share — tombstone the row, revoke the credentials, never rewrite an existing timestamp —
// lives in `offboardOneUser` and in `offboardTenantWrites`, so neither can drift from the other's
// understanding of "revoke both".
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  db as defaultDb,
  agentSessions,
  identityProviders,
  mcpApiKeys,
  runAsSystem,
  tenants,
  users,
  withTenantTransaction,
} from '../db/client';
import { tenantInvites } from '../db/schema';
import { DEMO_TENANT_ID } from '../config';
import { log } from '../host/logger';
import { recordAudit } from '../host/audit-service';
import { badRequest, conflict, notFound } from '../utils/http';
import { keycloakAdmin, type KeycloakAdminClient } from './keycloak-admin';
import { isSystemTenant, revokeMemberEntitlement, revokeTenantLicense } from './license-provisioning';
import {
  adminMethod,
  CP_LICENCES_OWNER_KEY,
  licencesAdminConfigured,
  licensesAdmin,
} from './licenses-admin';
import { revokeTenantInference } from './tenant-inference';
import { revokeKeysIssuedBy } from './mcp-api-key';
import { revokeSessionsFor } from './agent-session';
import {
  CP_REJECT_MARKER_ATTR,
  cpRejectMarker,
  identityCredentialState,
  rejectMarkerOf,
  softDeleteLocalUser,
} from './provisioning';

type Db = typeof defaultDb;

/** What offboarding ONE member changed. `tombstoned: false` means the row was already a tombstone
 *  (or absent) — the retry case, which must keep the ORIGINAL offboarding timestamp. */
export interface OffboardedUser {
  tombstoned: boolean;
  keysRevoked: number;
  sessionsRevoked: number;
}

/**
 * Offboard ONE member, LOCALLY (Keycloak is never touched — see the header). Idempotent.
 *
 * ORDER: LOCAL ROW FIRST, then the credentials. Tombstoning is an UPDATE against a row we have just
 * read and touches no FK, so it cannot fail the way the original hard DELETE did, and once it commits
 * the person is off every roster even if a later step falls over.
 *
 * The two credential revocations are explicit because tombstoning keeps the row: `mcp_api_keys.
 * issued_by` is ON DELETE SET NULL and `agent_sessions.user_id` is ON DELETE CASCADE, so both used to
 * be revoked implicitly by a hard delete; once the row survived (0050), a departed person kept a
 * working MCP key and a renewable refresh chain indefinitely.
 */
export async function offboardOneUser(
  userId: string,
  database: Db = defaultDb,
): Promise<OffboardedUser> {
  // `softDeleteLocalUser`, not a hand-written UPDATE: its `deleted_at IS NULL` predicate IS the
  // timestamp-preservation guarantee (a retry after a later step failed must not re-date the
  // offboarding), and a second copy of it here would be a second place for that to go missing.
  const tombstoned = await softDeleteLocalUser(userId, database);

  const [keysRevoked, sessionsRevoked] = await Promise.all([
    revokeKeysIssuedBy(userId, database),
    revokeSessionsFor(userId, database),
  ]);
  return { tombstoned, keysRevoked, sessionsRevoked };
}

/** A member of the workspace being offboarded. `email` is carried out so the caller can name the
 *  person in a seat-revoke failure report without a second query. */
export interface OffboardedMember {
  id: string;
  email: string;
}

/** Everything TX1 changed in the database, plus the membership whose seats the caller releases. */
export interface TenantOffboardWrites {
  /** The tenant's offboarding timestamp — the ORIGINAL one if it already had one. */
  offboardedAt: Date;
  /** True when this tenant already carried an `offboarded_at` before this call. */
  alreadyOffboarded: boolean;
  /**
   * EVERY member row of this workspace — the ones this call tombstoned AND the ones that were
   * already tombstoned. This is the caller's SEAT-RELEASE set, and it is deliberately NOT the same
   * as `usersOffboarded`.
   *
   * ⛔ IF THIS RETURNED ONLY THE NEWLY-TOMBSTONED ROWS, THE RETRY WOULD BE A NO-OP THAT REPORTS
   * SUCCESS. The seat revokes happen OUTSIDE this transaction and are individually allowed to fail
   * (reported, not fatal), so re-running the offboard is the documented repair. But a second call
   * tombstones nobody, so a newly-tombstoned-only list is EMPTY, the loop would iterate nothing, and
   * the offboard would answer `seatFailures: []` while those seats stayed billable. Re-revoking a seat
   * that is already revoked is a no-op.
   */
  members: OffboardedMember[];
  /** How many rows THIS call tombstoned. Zero on a repeat call — this is the honest "what did I
   *  just do" number, which is why it is separate from `members` above. */
  usersOffboarded: number;
  keysRevoked: number;
  sessionsRevoked: number;
}

/**
 * The whole database half of a tenant offboard, in ONE transaction, under `runAsSystem`.
 *
 * ⛔ `runAsSystem` IS THE ENTIRE CORRECTNESS OF THIS FUNCTION, AND WITHOUT IT THE ROUTE REPORTS A
 * SUCCESS IT DID NOT PERFORM.
 *
 * `tenants` and `users` sit OUTSIDE the RLS regime (0028 §COVERAGE) — which is why the platform
 * screens can count another tenant's members at all. `mcp_api_keys` and `agent_sessions` do NOT:
 * both carry a strict `tenant_id = app_current_tenant_uuid()` policy (0028 §4a) with no NULL
 * passthrough. The offboard route is `requireSuperAdmin`, and — unlike `requireTenantAdmin` — that
 * guard never calls `refreshTenantGuc`, so `app.current_tenant` stays the OPERATOR'S OWN workspace,
 * which by definition is not the one being offboarded.
 *
 * On the request's `cp_app` connection the two credential UPDATEs therefore match ZERO ROWS and
 * return zero, silently. The operator reads "7 members offboarded", the tenant row really is
 * suspended and the user rows really are tombstoned — and every departed employee keeps a working
 * MCP API key and a renewable agent refresh token. It is the exact failure `verifyKey` and
 * `moveUserHomeTenant` were each burned by, and it is invisible in dev and CI, where the test DSN
 * connects as the table OWNER and bypasses RLS entirely. `tests/tenant-offboard-cross-tenant.test.ts`
 * asserts a NON-ZERO `keysRevoked` for exactly this reason; that single assertion is what fails if
 * this wrapper is ever removed.
 *
 * ONE transaction, and the ORDER inside it matters:
 *   a. `status = 'suspended'` FIRST, so the suspension gate is already denying this workspace before
 *      the loop below starts. On a large tenant the rest of this transaction is not instantaneous,
 *      and the window between "we decided to offboard" and "requests stop being served" should be as
 *      close to zero as we can make it. (It commits with the rest — but nothing else in here can
 *      lengthen the window.)
 *   b. Tombstone every LIVE member, then read the WHOLE membership (tombstones included) as the
 *      caller's seat-release set — see the note on `TenantOffboardWrites.members` for why those
 *      are two different lists.
 *   c. Revoke every live MCP key OF THE TENANT — see the header block on why this is tenant-scoped
 *      and not `revokeKeysIssuedBy` per user.
 *   d. Revoke every live agent session OF THE TENANT — tenant-scoped for the same reason (c) is,
 *      and emphatically NOT "every session held by one of those members"; see the ⛔ block on the
 *      statement itself for the cross-tenant write that predicate used to perform.
 *
 * IDEMPOTENT BY CONSTRUCTION, not by a flag: every write carries an `IS NULL` predicate and the
 * timestamp is written with `COALESCE(offboarded_at, now())`, so a second call preserves the
 * original instant byte-for-byte and returns all-zero write counts.
 */
export async function offboardTenantWrites(tenantId: string): Promise<TenantOffboardWrites> {
  return runAsSystem('tenant-parameterised', () =>
    defaultDb.transaction(async (tx) => {
      // The PRE-IMAGE, read under `FOR UPDATE`. `RETURNING` can only show the NEW row, so it can
      // never say whether THIS call is the one that set the timestamp — and `alreadyOffboarded` is
      // exactly that question. Reading it first, with the row locked, also serialises two operators
      // offboarding the same workspace at once: the loser blocks here and then correctly reports
      // `alreadyOffboarded: true` with zero counts, instead of both reporting that they did it.
      // Same `SELECT … FOR UPDATE` shape `services/seat-limit.ts claimSeatInTx` uses on this table.
      const [before] = await tx
        .select({ offboardedAt: tenants.offboarded_at })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .for('update');
      if (!before) {
        // The caller has already read the tenant, so this is a genuine race (deleted between that
        // read and here). Nothing has been written; let it surface rather than reporting a phantom
        // offboard with an invented timestamp.
        throw new Error(`offboardTenantWrites: tenant ${tenantId} disappeared mid-offboard`);
      }

      // (a) Suspend FIRST. `COALESCE` is what makes the timestamp write-once — on a repeat call the
      // column keeps its original instant, byte for byte, which is what `tests/tenant-offboard`
      // asserts. `status` is set unconditionally because a workspace someone re-activated by hand
      // between the two calls must end up suspended again.
      const [tenantRow] = await tx
        .update(tenants)
        .set({
          status: 'suspended',
          offboarded_at: sql`COALESCE(${tenants.offboarded_at}, now())`,
          // ⛔ DROP THE HELD CREATION INPUTS (0101, services/tenant-provisioning.ts). The first
          // admin's email + name and the billing terms are kept on the row ONLY so a step that has
          // not landed can be retried without re-entry; a step reaching `ok` drops its own. An
          // offboarded workspace is read-only (Retry 409s `tenant_offboarded`, the tick skips it),
          // so nothing can ever use them again — keeping the PII would be retention with no
          // purpose. The step RECORDS (status / code / attempts) stay: they are history, not PII.
          provisioning: sql`(${tenants.provisioning} - 'terms'::text - 'firstAdmin'::text - 'signupAdmin'::text)`,
          updated_at: new Date(),
        })
        .where(eq(tenants.id, tenantId))
        .returning({ offboardedAt: tenants.offboarded_at });
      const offboardedAt = tenantRow?.offboardedAt;
      if (!offboardedAt) {
        throw new Error(`offboardTenantWrites: tenant ${tenantId} disappeared mid-offboard`);
      }

      // (b) Tombstone every LIVE member. `deleted_at IS NULL` keeps a re-run from rewriting the
      // timestamps of the members the first run already removed.
      const tombstoned = await tx
        .update(users)
        .set({ deleted_at: new Date(), updated_at: new Date() })
        .where(and(eq(users.tenant_id, tenantId), isNull(users.deleted_at)))
        .returning({ id: users.id, email: users.email });

      // …and then read the WHOLE membership, tombstones included, for the caller's seat loop.
      // See the note on `TenantOffboardWrites.members`: a list built from the UPDATE's RETURNING
      // alone is empty on the second call, which would make the retry — the documented repair for a
      // partial seat-revoke failure — silently do nothing and report success.
      const members = await tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.tenant_id, tenantId));

      // (c) TENANT-SCOPED, NOT per-user. See the header block: `issued_by` is ON DELETE SET NULL, so
      // a per-user sweep silently misses every key whose issuer row was hard-deleted at some point,
      // and those are exactly the keys nobody is left to notice.
      const keys = await tx
        .update(mcpApiKeys)
        .set({ revoked_at: new Date() })
        .where(and(eq(mcpApiKeys.tenant_id, tenantId), isNull(mcpApiKeys.revoked_at)))
        .returning({ id: mcpApiKeys.id });

      // (d) TENANT-SCOPED, exactly like the keys above — NOT the member id list.
      //
      // ⛔ THIS PREDICATE USED TO PERFORM A CROSS-TENANT WRITE, IN BOTH DIRECTIONS AT ONCE, FROM
      // THE ONE FEATURE WHOSE ENTIRE PURPOSE IS TO CONTAIN A TENANT. It read
      // `WHERE user_id IN (<members of this tenant>)`, which silently assumes that a session's
      // `tenant_id` always equals its owner's `users.tenant_id`. NOTHING ENFORCES THAT, and the
      // two columns are not even written by the same code at the same time:
      // `agent_sessions.tenant_id` is stamped ONCE at mint — today from the tenant
      // `issueAgentSession` is given EXPLICITLY (it used to be left to the
      // `app_current_tenant_uuid()` column default from 0028; same value, but the row and the
      // token's `tid` claim now come from one source instead of two that merely agreed) — while
      // `users.tenant_id` is a mutable column that `moveUserHomeTenant`
      // (routes/tenant-users.ts) re-points whenever a person changes workspace, leaving their
      // existing rows pointing at the workspace they were minted in. No FK, no trigger and no
      // CHECK ties the two together, so "they agree" is an assumption, never an invariant.
      //
      // Measured with real rows against the old predicate:
      //   • offboarding A REVOKED a session whose `tenant_id` was B — a write reaching into a
      //     live bystander workspace whose only involvement was employing someone A also
      //     employed, and invisible to B's operator;
      //   • offboarding B did NOT revoke that same session, because its owner's home tenant was A
      //     and the owner was therefore absent from B's member list — so B finished being
      //     offboarded still carrying a live, renewable agent refresh chain. That is precisely
      //     the hole this feature exists to close, reported as a success.
      // One clause, over-revoking outward and under-revoking inward simultaneously.
      //
      // WHY `tenant_id = :id` ALONE, and not `tenant_id = :id OR (user_id IN members AND that
      // session's own tenant is also being offboarded)`:
      //   1. `tenant_id` IS this credential's blast radius, not a label describing it. The RLS
      //      policy on this table is `USING (tenant_id = app_current_tenant_uuid())` FOR ALL
      //      (0028 §4a), so the only workspace a session can ever read or write is the one named
      //      in this column. "Every session that grants access TO A" and `tenant_id = A` are the
      //      same set of rows, by construction rather than by convention.
      //   2. A departing person's session in a DIFFERENT, STILL-LIVE workspace is that
      //      workspace's business. B did not ask to be offboarded, and killing a credential
      //      scoped to B is the same boundary violation as the one above, merely pointed the
      //      other way.
      //   3. The second arm is redundant even on its own terms: if the owner's other workspace is
      //      ALSO being offboarded, THAT offboard revokes the row under this very rule. It buys
      //      no coverage and couples this statement to a second tenant's lifecycle state.
      //   4. The person is still not left with standing access — that is handled at the layer
      //      that owns it. The MEMBER-level tool is user-scoped because its subject is a PERSON
      //      (`offboardOneUser` → `revokeSessionsFor(userId)`), and `refreshAgentSession` refuses
      //      and revokes the forward chain the moment it sees a tombstoned owner, so a departing
      //      member's session in B dies at its next renewal — capped at the access token's TTL —
      //      without this transaction ever writing a row it does not own.
      //
      // `agent_sessions.tenant_id` is NOT NULL (0029 set it, after backfilling from the owner and
      // DELETEing what it could not resolve; `tests/rls-coverage.test.ts` pins it), so there are
      // no legacy unscoped rows for this predicate to miss and a `tenant_id IS NULL` fallback arm
      // would be dead code. The claim that used to sit here — that the column "is nullable" — was
      // both false since 0029 and the reasoning that produced the bug.
      //
      // AND NO `members.length` GUARD ANY MORE. It existed only because an empty `inArray` is
      // degenerate; a tenant-scoped predicate has no such problem, and the guard was itself a
      // quiet under-revoke — a workspace every one of whose members has been moved out still owns
      // the sessions minted in it, and would have had this UPDATE skipped altogether.
      //
      // Still ONE statement rather than a loop over `revokeSessionsFor`: that function is
      // user-keyed (the wrong axis here), a loop would hold the transaction open for N
      // round-trips on a large workspace, and its `typeof db` parameter is not satisfiable by a
      // drizzle transaction handle (which has no `$client`) without widening a signature two
      // other paths depend on.
      const sessions = await tx
        .update(agentSessions)
        .set({ revoked_at: new Date() })
        .where(and(eq(agentSessions.tenant_id, tenantId), isNull(agentSessions.revoked_at)))
        .returning({ id: agentSessions.id });

      return {
        offboardedAt,
        alreadyOffboarded: before.offboardedAt !== null,
        members,
        usersOffboarded: tombstoned.length,
        keysRevoked: keys.length,
        sessionsRevoked: sessions.length,
      };
    }),
  );
}

// ===================================================================================================
// THE WHOLE-WORKSPACE OFFBOARD — shared by POST /api/tenants/:id/offboard and scripts/offboard-tenant.ts
// ===================================================================================================

export interface OffboardTarget {
  id: string;
  name: string;
  slug: string;
}

/**
 * The tenant to offboard, or the refusal: 404 `tenant_not_found`; 409 `system_tenant` for the
 * nil-UUID seed/dev tenant (not a customer, and `revokeTenantLicense` leaves its licence alone, so an
 * offboard would stamp it gone with a live licence — see SYSTEM_TENANT_ID); 409 `demo_tenant` for
 * DEMO_TENANT_ID (showcase/marketplace seeds). Runs BEFORE any write.
 */
export async function loadOffboardTarget(tenantId: string): Promise<OffboardTarget> {
  const [t] = await runAsSystem('platform-admin', () =>
    defaultDb
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, tenantId)),
  );
  if (!t) throw notFound('tenant_not_found', `No tenant '${tenantId}'`);
  if (isSystemTenant(t.id)) {
    throw conflict('system_tenant', 'This is the platform system tenant; it cannot be offboarded.');
  }
  if (t.id === DEMO_TENANT_ID) {
    // Structural, not a customer: the marketplace/showcase seeds and example datasets live here.
    throw conflict('demo_tenant', 'This is the platform demo tenant; it cannot be offboarded.');
  }
  return t;
}

/**
 * 400 `confirm_mismatch` unless `confirmSlug` is the tenant's own slug. The slug (not the uuid)
 * because the operator has to have READ the workspace's name to type it; an unattended script with a
 * wrong id is exactly the mis-aimed-click case this exists for. Runs BEFORE any write.
 */
export function assertOffboardConfirmed(t: OffboardTarget, confirmSlug: string): void {
  if (confirmSlug !== t.slug) {
    throw badRequest(
      'confirm_mismatch',
      `Type the workspace slug '${t.slug}' to confirm offboarding. This cannot be undone.`,
      { expectedSlug: t.slug },
    );
  }
}

/** Who is offboarding: a super_admin (`actorId`) or an operator running the script (`actorId: null`
 *  — a System action, never a fabricated user id — named in `metadata.operator`). */
export interface OffboardActor {
  actorId: string | null;
  operator?: string | null;
  /** Where it ran from, for the audit row (`scripts/offboard-tenant.ts`); omitted for the route. */
  via?: string;
}

export interface OffboardTenantResult {
  tenantId: string;
  offboardedAt: Date;
  alreadyOffboarded: boolean;
  /** Rows THIS call tombstoned (0 on a repeat) — never the whole membership the seat loop walks. */
  usersOffboarded: number;
  keysRevoked: number;
  sessionsRevoked: number;
  invitesRevoked: number;
  idpsDisabled: number;
  seatFailures: { userId: string; email: string; message: string }[];
  idpDisableFailures: { alias: string; message: string }[];
  inferenceRevokeError: string | null;
  archiveFailure: string | null;
  /**
   * WHY the central archive was deliberately NOT attempted, or `null` when it was attempted (or
   * licences is not configured at all). Set whenever CP cannot PROVE it owns the licences tenant —
   * see `decideCentralArchive`. Not a failure: the CP-side offboard (tenant licence, seats,
   * inference credential) still ran in full.
   */
  archiveSkipped: string | null;
  /**
   * True when `archiveSkipped` is set because CP could not DETERMINE ownership (the owner lookup
   * failed, or the registry returned no owner_key) — a re-run may archive it. A caller that must know
   * the central tenant is really settled (services/signup-reject-repair.ts) treats this as unfinished.
   */
  archiveSkipUncertain: boolean;
  /**
   * Licences still ACTIVE on the CP-owned licences tenant after CP's own licence and seats were
   * released — in practice the per-app licences CP's BUNDLES minted (`svc:<tenant>:<app>`) — that
   * this call revoked before archiving. 0 when the archive was skipped (never touched then).
   */
  residualLicencesRevoked: number;
  /**
   * Each residual licence that could NOT be revoked (still ACTIVE upstream), or one entry with
   * `licenseId: null` when the tenant's licences could not even be listed. Non-fatal, like
   * `seatFailures`: re-running the offboard retries them (licences lets the owner revoke a bundle
   * licence on an ARCHIVED tenant too).
   */
  residualLicenceFailures: ResidualLicenceFailure[];
}

export interface ResidualLicenceFailure {
  licenseId: string | null;
  appKey: string | null;
  message: string;
}

/** Outcome of the ownership check that gates the central archive. */
type ArchiveDecision =
  | { archive: true }
  | { archive: false; reason: string; /** true = we could not determine ownership (re-run may help) */ uncertain: boolean };

/**
 * May CP archive the licences-registry tenant with this id? ONLY if the registry says CP OWNS it.
 *
 * ⛔ WHY THIS EXISTS. CP's tenant id IS the licences tenant id, and legacy CP workspaces were
 * ADOPTED onto pre-existing licences tenants (`tenants.central_link = 'adopted'`) that belong to
 * `platform` and carry OTHER apps' licences (aa-agents, default-anon, nonagentic, system …).
 * Archiving is tenant-WIDE: every licence on the tenant then introspects `active:false,
 * reason:"tenant_archived"`, so offboarding one CP workspace would switch off every other app on
 * that shared tenant. Archive is therefore gated on `owner_key === CP_LICENCES_OWNER_KEY`, read
 * from the registry itself — the authority — not inferred from CP's own `central_link` column.
 *
 * FAIL SAFE: any doubt (lookup error, a 501 client, a missing owner_key, a tenant licences will not
 * show us) means DO NOT ARCHIVE. A wrongly skipped archive leaves a registry row looking live — a
 * reconciliation nuisance; a wrongly performed one takes other products down.
 *
 * `getTenant` answers `null` both for an absent tenant and for one owned by another app that CP
 * holds no grant on (licences' generic owner-scoped 404) — neither is CP's to archive.
 */
async function decideCentralArchive(tenantId: string, centralLink: string | null): Promise<ArchiveDecision> {
  let held;
  try {
    held = await adminMethod(licensesAdmin(), 'getTenant')(tenantId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { archive: false, reason: `owner_lookup_failed: ${message}`, uncertain: true };
  }
  if (!held) {
    return { archive: false, reason: 'not_visible_to_cp (absent from the registry, or owned by another app)', uncertain: false };
  }
  if (!held.ownerKey) {
    return {
      archive: false,
      reason: `owner_unknown: the registry returned no owner_key${centralLink === 'adopted' ? ' (CP row is adopted)' : ''}`,
      uncertain: true,
    };
  }
  if (held.ownerKey !== CP_LICENCES_OWNER_KEY) {
    return { archive: false, reason: `not_owned_by_cp: owner_key=${held.ownerKey}`, uncertain: false };
  }
  return { archive: true };
}

/**
 * Revoke every licence still ACTIVE on a licences tenant CP OWNS — called ONLY after
 * `decideCentralArchive` said `archive: true`, and BEFORE the archive.
 *
 * ⛔ WHY: archiving only stops licences AUTHORIZING; it revokes nothing. CP's bundles mint one
 * licence per bundle app on the tenant (`svc:<tenant>:<app>`, e.g. workers, kanban), which neither
 * `revokeTenantLicense` (cp-tenant subject, CP app only) nor the seat loop reaches — so an
 * offboarded tenant was archived with every bundle licence still `active` (measured on prod
 * `cp-e2e-test-1014`: 9). Licences lets the tenant OWNER revoke licences its bundles minted, for
 * apps CP does not issue and on an archived tenant (licenses#265, `_bundle_owner_may_revoke`).
 *
 * ⛔ NEVER REACHED FOR A TENANT CP DOES NOT OWN — the caller gates it on the same ownership decision
 * as the archive, so a shared / platform-owned tenant's other-app licences are never touched.
 * Licences is the second gate: a row CP neither issues nor minted through a bundle is refused 403
 * and lands in the failure list, never silently revoked or silently skipped.
 *
 * NON-FATAL per licence, reported. A list failure is one `licenseId: null` entry.
 */
async function revokeResidualTenantLicences(
  t: OffboardTarget,
): Promise<{ revoked: number; failures: ResidualLicenceFailure[] }> {
  const failures: ResidualLicenceFailure[] = [];
  let live;
  try {
    live = await adminMethod(licensesAdmin(), 'listTenantLicences')(t.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('tenant_offboard_residual_licence_list_failed', {
      tenantSlug: t.slug,
      tenantId: t.id,
      remediation:
        'could not list the tenant\'s licences, so its bundle licences may still be ACTIVE upstream; ' +
        're-run the offboard once licences answers',
      err,
    });
    return { revoked: 0, failures: [{ licenseId: null, appKey: null, message }] };
  }
  let revoked = 0;
  for (const lic of live) {
    // `?status=active` already filters; the tenant check is defence in depth — never revoke a row
    // the registry attributed to another tenant.
    if (lic.status !== 'active' || lic.tenantId.toLowerCase() !== t.id.toLowerCase()) continue;
    try {
      await licensesAdmin().revokeByLicenseId(lic.id, t.id);
      revoked++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('tenant_offboard_residual_licence_revoke_failed', {
        tenantSlug: t.slug,
        tenantId: t.id,
        licenseId: lic.id,
        appKey: lic.appKey,
        bundle: lic.bundle,
        remediation: 'this licence is still ACTIVE upstream; re-run the offboard to retry the revoke',
        err,
      });
      failures.push({ licenseId: lic.id, appKey: lic.appKey, message });
    }
  }
  return { revoked, failures };
}

/**
 * Offboard an ENTIRE workspace. The guards (`loadOffboardTarget`, `assertOffboardConfirmed`, and
 * the route's `requireSuperAdmin`) are the CALLER's and must already have run.
 *
 * SEQUENCE, and why it is in this order:
 *   1. TX1 — every database write, in ONE transaction, under `runAsSystem` (`offboardTenantWrites`;
 *      read its docblock — without `runAsSystem` the credential revocations match ZERO rows).
 *   1b. Pending invites revoked and the workspace's IdPs disabled in CP (the JIT path skips a
 *      disabled IdP), then in Keycloak best-effort — nothing may seat anyone here again.
 *   2. The tenant licence (FATAL: 502 / 409 `licence_busy` — a licence that keeps answering
 *      "entitled" after everyone has gone is the thing this must not leave behind; the DB writes are
 *      committed and idempotent, so re-running is the recovery), every member seat (non-fatal, per
 *      member: `seatFailures`), and the tenant's inference-router credential (non-fatal).
 *   3. ONLY for a licences tenant CP OWNS: revoke every licence still active on it (the bundle
 *      licences — `revokeResidualTenantLicences`, non-fatal, reported), then the CENTRAL TENANT
 *      ARCHIVE, last of all — archiving stops licences authorizing WITHOUT revoking them, so it must
 *      follow every revoke (see the ⛔ block on that step).
 *   4. One audit row, `warn` when anything upstream refused.
 * Keycloak identities are never deleted (the portal realm is shared with fr).
 *
 * IDEMPOTENT BY CONSTRUCTION: every write carries an `IS NULL` predicate and the timestamp is
 * `COALESCE(offboarded_at, now())`, so a repeat returns `alreadyOffboarded: true`, the ORIGINAL
 * timestamp and zero write counts; the seat loop re-runs over the whole membership.
 */
export async function offboardTenantFully(
  t: OffboardTarget,
  actor: OffboardActor,
  opts: { reason?: string | null } = {},
): Promise<OffboardTenantResult> {
  // Defence in depth: the guard is the caller's, but no path may offboard the system tenant.
  if (isSystemTenant(t.id)) {
    throw conflict('system_tenant', 'This is the platform system tenant; it cannot be offboarded.');
  }

  // (1) Every database write, atomically, as SYSTEM.
  const writes = await offboardTenantWrites(t.id);

  // (1b) Under the workspace's own RLS scope: both tables are tenant-policed and only its rows change.
  const { invitesRevoked, idpAliases } = await withTenantTransaction(t.id, async (tx) => {
    const inv = await tx
      .update(tenantInvites)
      .set({ status: 'revoked', revoked_at: new Date() })
      .where(and(eq(tenantInvites.tenant_id, t.id), eq(tenantInvites.status, 'pending')))
      .returning({ id: tenantInvites.id });
    const idps = await tx
      .update(identityProviders)
      .set({ enabled: false, updated_at: new Date() })
      .where(eq(identityProviders.tenant_id, t.id))
      .returning({ alias: identityProviders.alias });
    return { invitesRevoked: inv.length, idpAliases: idps.map((i) => i.alias) };
  });
  // …and in Keycloak, best-effort: the CP mirror above is what the JIT path reads.
  const idpDisableFailures: { alias: string; message: string }[] = [];
  for (const alias of idpAliases) {
    try {
      const kc = keycloakAdmin();
      const rep = await kc.getIdentityProvider(alias);
      if (rep && rep.enabled !== false) await kc.updateIdentityProvider(alias, { ...rep, enabled: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('tenant_offboard_idp_disable_failed', { tenantSlug: t.slug, alias, err });
      idpDisableFailures.push({ alias, message });
    }
  }

  // (2a) The tenant licence — the call `patchTenant` makes on suspend; a no-op while issuance is
  // off, fail-loud (502) when on, 409 `licence_busy` under another licence op.
  await revokeTenantLicense(t.id);

  // (2a') EVERY MEMBER'S SEAT (0089) — what licences-service counts as a billable seat. NON-FATAL per
  // member: by now the workspace is suspended and every member tombstoned, so a licences hiccup is a
  // BILLING outcome, not a security one. `revokeMemberEntitlement` leaves a failed row at `revoking`
  // (the queue `releaseStuckSeats` retries) and the caller gets the list. Iterates the WHOLE
  // membership so a re-run reaches the seats the first attempt could not release.
  const seatFailures: { userId: string; email: string; message: string }[] = [];
  for (const member of writes.members) {
    try {
      await revokeMemberEntitlement(t.id, member.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('tenant_offboard_seat_revoke_deferred', {
        tenantSlug: t.slug,
        userId: member.id,
        remediation:
          'the member is offboarded but their licence is still ACTIVE upstream and billable; the ' +
          'entitlement row is left at `revoking` for the reconciler — or re-run the offboard',
        err,
      });
      seatFailures.push({ userId: member.id, email: member.email, message });
    }
  }

  // (2a'') The tenant's own inference-router licence (local-llm, 0099), NON-FATAL (reported +
  // audited; re-running retries it). CP holds no other provider credential.
  let inferenceRevokeError: string | null = null;
  try {
    await revokeTenantInference(t.id);
  } catch (err) {
    inferenceRevokeError = err instanceof Error ? err.message : String(err);
    log.error('tenant_offboard_inference_revoke_failed', { tenantId: t.id, err });
  }

  // (2c) ARCHIVE THE TENANT CENTRALLY — LAST, and only after every seat above has been released.
  //
  // ⛔ WHY IT CANNOT MOVE EARLIER, MEASURED AT THE SERVICE: `set_tenant_archived` flips a flag. An
  // archived tenant's licences stop AUTHORIZING (introspect answers `active:false,
  // reason:"tenant_archived"`) but are NOT revoked, so they go on counting toward `human_subjects`.
  // Archiving first would make the workspace look shut while leaving the whole headcount billable —
  // and un-archiving would silently resurrect every one of those seats. Archive is the epitaph,
  // never the eviction.
  //
  // NON-FATAL: by now the workspace IS offboarded, and a 502 would report a committed operation as a
  // failure. Re-running re-archives (idempotent). Gated on `licencesAdminConfigured()`, NOT on
  // issuance: archiving is not minting, and a deployment can be wired to licences with issuance off.
  //
  // ⛔ AND ONLY WHEN CP OWNS THE LICENCES TENANT — see `decideCentralArchive`. Archiving a shared
  // (adopted / platform-owned) tenant would stop every OTHER app's licences on it from authorizing.
  let archiveFailure: string | null = null;
  let archiveSkipped: string | null = null;
  let archiveSkipUncertain = false;
  let residualLicencesRevoked = 0;
  let residualLicenceFailures: ResidualLicenceFailure[] = [];
  if (licencesAdminConfigured()) {
    const [row] = await runAsSystem('platform-admin', () =>
      defaultDb.select({ centralLink: tenants.central_link }).from(tenants).where(eq(tenants.id, t.id)),
    );
    const decision = await decideCentralArchive(t.id, row?.centralLink ?? null);
    if (!decision.archive) {
      archiveSkipped = decision.reason;
      archiveSkipUncertain = decision.uncertain;
      log.warn('tenant_offboard_central_archive_skipped', {
        tenantSlug: t.slug,
        tenantId: t.id,
        centralLink: row?.centralLink ?? null,
        reason: decision.reason,
        remediation:
          'CP cannot prove it owns this licences tenant, so it was NOT archived (archiving is ' +
          'tenant-wide and would stop other apps\' licences). CP\'s own licence and seats were still ' +
          'revoked. If CP really owns it, re-run once licences answers; otherwise the owning app decides.',
      });
    } else {
      // (2b) CP owns the tenant: revoke what its bundles minted BEFORE the archive (see the helper).
      // The archive still runs when some revoke failed — it at least stops those licences
      // authorizing — and the failures are reported for a re-run.
      ({ revoked: residualLicencesRevoked, failures: residualLicenceFailures } =
        await revokeResidualTenantLicences(t));
      try {
        await adminMethod(licensesAdmin(), 'archiveTenant')(t.id);
      } catch (err) {
        archiveFailure = err instanceof Error ? err.message : String(err);
        log.error('tenant_offboard_central_archive_failed', {
          tenantSlug: t.slug,
          tenantId: t.id,
          remediation:
            'the workspace is offboarded in CP but its licences-registry tenant is still ACTIVE, so ' +
            'central reconciliation will report it as live; re-run the offboard once licences is reachable',
          err,
        });
      }
    }
  }

  await recordAudit({
    actorId: actor.actorId,
    tenantId: t.id,
    action: 'tenant.offboard',
    category: 'tenant',
    targetType: 'tenant',
    targetId: t.id,
    result: t.name,
    // 'warn' whenever something upstream refused: the workspace is offboarded, but an operator has
    // to be able to find what was left behind. Otherwise 'ok'.
    resultTone:
      seatFailures.length > 0 ||
      residualLicenceFailures.length > 0 ||
      archiveFailure !== null ||
      archiveSkipUncertain ||
      idpDisableFailures.length > 0 ||
      inferenceRevokeError !== null
        ? 'warn'
        : 'ok',
    metadata: {
      slug: t.slug,
      reason: opts.reason ?? null,
      ...(actor.via ? { via: actor.via } : {}),
      ...(actor.operator !== undefined ? { operator: actor.operator } : {}),
      alreadyOffboarded: writes.alreadyOffboarded,
      usersOffboarded: writes.usersOffboarded,
      keysRevoked: writes.keysRevoked,
      sessionsRevoked: writes.sessionsRevoked,
      seatRevokeFailed: seatFailures.length,
      invitesRevoked,
      idpsDisabled: idpAliases.length,
      idpDisableFailed: idpDisableFailures.length,
      // ⚠️ THREE-VALUED ON PURPOSE. `null` = archived (or nothing to archive); a STRING = the
      // registry still lists this workspace as live.
      centralArchiveError: archiveFailure,
      // Non-null = the archive was deliberately NOT attempted (CP does not provably own the tenant).
      centralArchiveSkipped: archiveSkipped,
      residualLicencesRevoked,
      residualLicenceRevokeFailed: residualLicenceFailures.length,
      inferenceRevokeError,
    },
  });

  return {
    tenantId: t.id,
    offboardedAt: writes.offboardedAt,
    alreadyOffboarded: writes.alreadyOffboarded,
    usersOffboarded: writes.usersOffboarded,
    keysRevoked: writes.keysRevoked,
    sessionsRevoked: writes.sessionsRevoked,
    invitesRevoked,
    idpsDisabled: idpAliases.length,
    seatFailures,
    idpDisableFailures,
    inferenceRevokeError,
    archiveFailure,
    archiveSkipped,
    archiveSkipUncertain,
    residualLicencesRevoked,
    residualLicenceFailures,
  };
}

// ===================================================================================================
// A REJECTED SIGNUP'S WORKSPACE — routes/onboarding.ts `rejectApprovalRow`
// ===================================================================================================

/**
 * How a `tenant_id` table counts toward "this workspace holds USER DATA" — i.e. something a PERSON
 * made, which rejecting the signup would destroy.
 *
 * ⛔ WHY THIS IS NOT A "BOOKKEEPING TABLES" ALLOWLIST ANY MORE. The first version treated every
 * `tenant_id` row outside a short allowlist as user data. Background jobs write tenant rows on their
 * own — the daily cycle tick (host/cycle-service.ts `engineTenantIds` drives EVERY non-offboarded
 * tenant) opens a `marketplace_cycles` row in the aborted workspace within a day — so after ~24h
 * every reject 409'd `signup_workspace_in_use (data:marketplace_cycles)`. The question is not WHICH
 * TABLE a row is in but WHO MADE IT:
 *
 *   • `authored` — the table records its human author (`column`). A row counts ONLY when that column
 *     is set: every human write path stamps it, every engine/system write leaves it NULL. The author
 *     may be the requester (who may have set a password and started working) or anybody else — both
 *     block: whoever made it, rejecting would destroy it.
 *   • `content`  — no author column, but ONLY a person's action ever creates a row (route / MCP tool
 *     handlers; no scheduler writes it). Any row counts.
 *   • `engine`   — CP's own bookkeeping, a setting, a credential or an engine-derived record. Never
 *     user data by itself; where it relates to user content (a cycle's challenges, a run's flow), that
 *     content lives in an `authored`/`content` table and blocks there.
 *   • `membership` — `users` / `tenant_invites`: checked separately (other members / other invites).
 *
 * A `tenant_id` table missing from this map counts as `content` (fail SAFE: refuse the reject), and
 * tests/signup-early-access-v2.test.ts asserts the map covers the live catalogue exactly — so a new
 * table forces an explicit decision here rather than silently blocking or silently destroying.
 */
export type SignupWorkspaceTableRule =
  | { kind: 'authored'; column: string; why: string }
  | { kind: 'content'; why: string }
  | { kind: 'engine'; why: string }
  | { kind: 'membership'; why: string };

export const SIGNUP_WORKSPACE_TABLE_RULES: Record<string, SignupWorkspaceTableRule> = {
  // ---- membership (checked on their own) ----
  users: { kind: 'membership', why: 'other live members → other_members' },
  tenant_invites: { kind: 'membership', why: 'pending invites for anybody else → other_invites' },

  // ---- authored: a row counts when its author column is set ----
  flows: { kind: 'authored', column: 'owner_id', why: 'a flow somebody built' },
  flow_snapshots: { kind: 'authored', column: 'created_by', why: 'a saved version of a flow' },
  flow_templates: { kind: 'authored', column: 'created_by', why: 'a template somebody saved' },
  flow_runs: { kind: 'authored', column: 'triggered_by', why: 'a run a person started (scheduled runs need a flow, which blocks itself)' },
  datasets: { kind: 'authored', column: 'owner_id', why: 'a dataset somebody uploaded / connected' },
  challenges: { kind: 'authored', column: 'submitter_id', why: 'a challenge somebody submitted (a cycle\'s user content)' },
  challenge_entities: { kind: 'authored', column: 'created_by', why: 'a person linking ontology entities to a challenge' },
  solutions: { kind: 'authored', column: 'author_id', why: 'a solution somebody wrote' },
  solution_deliveries: { kind: 'authored', column: 'initiated_by', why: 'a delivery somebody started' },
  votes: { kind: 'authored', column: 'user_id', why: 'a vote somebody cast (a cycle\'s user content)' },
  comments: { kind: 'authored', column: 'author_id', why: 'a comment somebody wrote' },
  chat_sessions: { kind: 'authored', column: 'user_id', why: 'a person\'s assistant conversation' },
  information_requests: { kind: 'authored', column: 'created_by', why: 'a request somebody raised' },
  sandboxes: { kind: 'authored', column: 'owner_id', why: 'a builder sandbox a person opened' },
  mcp_api_keys: { kind: 'authored', column: 'issued_by', why: 'an API key somebody issued (an integration is wired to it)' },

  // ---- content: no author column; only a person's action creates a row ----
  building_blocks: { kind: 'content', why: 'block authoring / data-block derivation — route + MCP tool handlers only' },
  block_templates: { kind: 'content', why: 'templates-service — route handlers only' },
  dataset_mappings: { kind: 'content', why: 'the mapping of a dataset a person set up' },
  information_request_rows: { kind: 'content', why: 'the rows of an information request' },
  ontology_entities: { kind: 'content', why: 'ontology editor / MCP tools only (the tenant ontology seed runs in seed.ts, never per workspace)' },
  ontology_entity_samples: { kind: 'content', why: 'samples a person attached to an entity' },
  ontology_relations: { kind: 'content', why: 'relations a person drew' },
  mcp_prompts: { kind: 'content', why: 'a tenant override of an agent prompt — an admin wrote it' },
  delivery_targets: { kind: 'content', why: 'an integration (Jira / ADO / fr) an admin configured' },
  identity_providers: { kind: 'content', why: 'an SSO provider an admin configured' },
  // ⛔ NOT engine (it was, with "the approve writes it" — it does not: since 0099 only the tenant-admin
  // PUT /api/llm-settings writes this table). A row is an admin's provider choice and possibly their
  // OWN API key (`api_key_encrypted`, `credential_source = 'tenant_byo'`): user data, which rejecting
  // would destroy. Re-audited the rest of `engine` for the same shape (admin-set config / an admin's
  // own credential): tenant_llm_budgets (the platform's welcome-budget key, budget-service), the
  // cadence pair (a setting a PLATFORM switch rewrites in every tenant), email_domain_tenants (the
  // approve / a super_admin), agent_sessions (credentials the offboard revokes) — none holds one.
  tenant_llm_settings: { kind: 'content', why: 'an admin\'s LLM provider setup — possibly their own API key (tenant_byo); only the llm-settings route writes it' },

  // ---- engine: bookkeeping, settings, credentials, engine-derived ----
  audit_log: { kind: 'engine', why: 'the record of what happened, not data' },
  member_entitlements: { kind: 'engine', why: 'licence seats — the approve writes the requester\'s' },
  metering_outbox: { kind: 'engine', why: 'metering delivery queue' },
  usage_counters: { kind: 'engine', why: 'metering counters' },
  usage_events: { kind: 'engine', why: 'metering events' },
  tenant_llm_budgets: { kind: 'engine', why: 'workspace budget setting' },
  tenant_cycle_cadence: { kind: 'engine', why: 'cadence setting — a PLATFORM switch rewrites it in every tenant' },
  tenant_cycle_cadence_changes: { kind: 'engine', why: 'cadence history — a PLATFORM switch appends to every tenant' },
  email_domain_tenants: { kind: 'engine', why: 'domain → workspace routing the approve records' },
  marketplace_cycles: { kind: 'engine', why: 'the daily cycle tick opens/advances/closes these in EVERY live tenant; the user content of a cycle is challenges/solutions/votes/comments' },
  weekly_winners: { kind: 'engine', why: 'derived by the cycle tick from votes (which block themselves)' },
  flow_run_events: { kind: 'engine', why: 'the executor\'s log of a flow_runs row (the run and its flow block themselves)' },
  notifications: { kind: 'engine', why: 'system-generated messages to a recipient' },
  notification_reads: { kind: 'engine', why: 'read receipts — nothing anybody made' },
  agent_sessions: { kind: 'engine', why: 'agent refresh tokens — credentials the offboard revokes' },
  agent_tool_results: { kind: 'engine', why: 'transient tool-call rendezvous rows' },
};

/** The SQL that answers "does `table` hold user data in `tenantId`?" under its rule (null = never). */
function userDataProbe(table: string, rule: SignupWorkspaceTableRule | undefined, tenantId: string) {
  if (rule?.kind === 'engine' || rule?.kind === 'membership') return null;
  const authored = rule?.kind === 'authored' ? sql` AND ${sql.identifier(rule.column)} IS NOT NULL` : sql``;
  return sql`SELECT EXISTS (SELECT 1 FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}${authored}) AS present`;
}

/**
 * Why the workspace a signup FOUNDED may NOT be offboarded by rejecting that signup — empty when it
 * may. Rejecting means "this person should not have a workspace", which is only safe to carry out
 * when the workspace is still exactly what the approve made: the requester alone (seated or
 * invited) and no user data. Anything else — another live member, a pending invite for somebody
 * else, anything a person made (`SIGNUP_WORKSPACE_TABLE_RULES`) — and the reject is refused (409)
 * rather than destroying it. What background jobs write on their own (cycles, metering, audit,
 * notifications…) never blocks.
 */
export async function signupWorkspaceBlockers(tenantId: string, requesterEmail: string): Promise<string[]> {
  return runAsSystem('tenant-parameterised', async () => {
    const blockers: string[] = [];
    const [others] = (await defaultDb.execute(sql`
      SELECT
        (SELECT count(*)::int FROM users
          WHERE tenant_id = ${tenantId} AND deleted_at IS NULL AND lower(email) <> lower(${requesterEmail})) AS members,
        (SELECT count(*)::int FROM tenant_invites
          WHERE tenant_id = ${tenantId} AND status = 'pending' AND lower(email) <> lower(${requesterEmail})) AS invites`)) as unknown as {
      members: number;
      invites: number;
    }[];
    if ((others?.members ?? 0) > 0) blockers.push(`other_members:${others!.members}`);
    if ((others?.invites ?? 0) > 0) blockers.push(`other_invites:${others!.invites}`);
    const tables = (await defaultDb.execute(sql`
      SELECT c.table_name AS name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
       WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
       ORDER BY 1`)) as unknown as { name: string }[];
    for (const { name } of tables) {
      const rule = SIGNUP_WORKSPACE_TABLE_RULES[name];
      if (!rule) log.warn('signup_workspace_table_unclassified', { table: name, treatedAs: 'content' });
      const probe = userDataProbe(name, rule, tenantId);
      if (!probe) continue;
      const [hit] = (await defaultDb.execute(probe)) as unknown as { present: boolean }[];
      if (hit?.present) blockers.push(`data:${name}`);
    }
    return blockers;
  });
}

export interface RejectedSignupOffboard {
  offboard: OffboardTenantResult;
  /** The realm identity CP minted for this signup, or null when it minted none here. */
  keycloakSub: string | null;
  /** `deleted` | `absent` | `disabled` | `disabled_unmarked` | `kept_in_use` (another workspace references it) |
   *  `none` | `failed: …` | `unsupported` — see `retireRejectedIdentity`. */
  keycloakIdentity: string;
}

/**
 * Carry out a rejected signup on the workspace its approval FOUNDED (an approve that aborted after
 * the seat): the WHOLE-workspace offboard (`offboardTenantFully` — tombstones the seat, revokes the
 * tenant licence and every member licence, clears the held `signupAdmin` PII, revokes invites; the
 * central archive only for a licences tenant CP owns, cp#440), then the realm identity CP minted for
 * this signup is retired (`retireRejectedIdentity`: deleted when it never got a credential, else
 * disabled + marked) unless another workspace still references it.
 *
 * ⛔ The header's "Keycloak is never touched" is about people LEAVING a workspace, whose login is
 * theirs (fr shares the realm). This identity is different: CP created it in the approve, for a
 * person nobody approved — leaving it enabled would leave an account the still-pending set-password
 * link could activate. The audit row records what was done to it.
 *
 * The caller must already have checked `signupWorkspaceBlockers` and recorded the reject. A throw
 * from the offboard (licences refusing the tenant licence revoke) propagates; re-running is the
 * repair (everything here is idempotent).
 */
export async function offboardRejectedSignupWorkspace(
  tenantId: string,
  requesterEmail: string,
  actor: OffboardActor,
  approvalId: string,
): Promise<RejectedSignupOffboard> {
  const target = await loadOffboardTarget(tenantId);
  // The identity the approve MINTED for this address in this workspace (`seatMintedIdentity` writes
  // the accepted invite with `keycloak_sub`; an identity that already existed never has it set).
  const [minted] = await withTenantTransaction(tenantId, (tx) =>
    tx
      .select({ sub: tenantInvites.keycloak_sub })
      .from(tenantInvites)
      .where(
        and(
          eq(tenantInvites.tenant_id, tenantId),
          sql`lower(${tenantInvites.email}) = lower(${requesterEmail})`,
          sql`${tenantInvites.keycloak_sub} IS NOT NULL`,
        ),
      )
      .limit(1),
  );
  const keycloakSub = minted?.sub ?? null;

  const offboard = await offboardTenantFully(target, actor, { reason: `signup_rejected:${approvalId}` });

  const keycloakIdentity = keycloakSub
    ? await retireMintedIdentityUnlessReferenced(keycloakSub, tenantId, requesterEmail, approvalId)
    : 'none';
  return { offboard, keycloakSub, keycloakIdentity };
}

/**
 * Retire (see `retireRejectedIdentity`) the realm identity CP minted for a rejected signup in
 * `tenantId` — unless something OUTSIDE that workspace still references it (a live seat elsewhere, an
 * invite elsewhere naming it or a pending one for the address): then `kept_in_use`. Never throws.
 */
export async function retireMintedIdentityUnlessReferenced(
  sub: string,
  tenantId: string,
  email: string,
  approvalId: string,
): Promise<string> {
  const [ref] = (await runAsSystem('cross-tenant-aggregate', () =>
    defaultDb.execute(sql`
      SELECT (
        EXISTS (SELECT 1 FROM users
                 WHERE id = ${sub} AND deleted_at IS NULL AND tenant_id IS DISTINCT FROM ${tenantId})
        OR EXISTS (SELECT 1 FROM tenant_invites
                    WHERE tenant_id <> ${tenantId}
                      AND (keycloak_sub = ${sub}
                           OR (status = 'pending' AND lower(email) = lower(${email}))))
      ) AS in_use`),
  )) as unknown as { in_use: boolean }[];
  if (ref?.in_use) return 'kept_in_use';
  return retireRejectedIdentity(keycloakAdmin(), sub, tenantId, approvalId);
}

/**
 * What happens to the realm identity CP minted for a signup that was then rejected (and that no other
 * workspace references). The identity must not stay usable — the still-pending set-password link
 * could activate it — but it must ALSO not block the same address from signing up again, which a
 * plain disable did: the next approve found the disabled account, invited it, and the person could
 * never sign in.
 *
 *   • NO credential of any type and NO IdP link (realm says so POSITIVELY) → DELETED. CP minted it,
 *     nobody ever set it up, there is nothing to preserve; a re-signup mints a fresh one.
 *   • anything else (a password / otp / IdP link, or the realm would not say) → DISABLED and marked
 *     `signup_app=cp_rejected:<approval id>` in ONE read-modify-write (every other attribute kept),
 *     READ BACK. A re-signup's approve re-enables a marked identity (`provisioning.ts
 *     reclaimDisabledIdentity`); one disabled by anybody else is never re-enabled (409).
 *
 * Returns the audit value: `deleted` | `absent` (already gone — a repeat) | `disabled` | `disabled_unmarked` (disabled, but the marker did
 * not persist — a re-signup will then 409 `identity_disabled` until an operator acts) |
 * `unsupported` | `failed: …`. Never throws: the reject is already recorded.
 */
async function retireRejectedIdentity(
  kc: KeycloakAdminClient,
  sub: string,
  tenantId: string,
  approvalId: string,
): Promise<string> {
  try {
    // A repeat (the reject's repair path) after an earlier run already DELETED it: nothing left.
    if (kc.getRealmUser && (await kc.getRealmUser(sub)) === null) return 'absent';
    const state = await identityCredentialState(kc, sub);
    if (state === 'none') {
      await kc.deleteRealmUser(sub);
      return 'deleted';
    }
    const marker = cpRejectMarker(approvalId);
    if (kc.setUserState) {
      const stored = await kc.setUserState(sub, { enabled: false, attributes: { [CP_REJECT_MARKER_ATTR]: marker } });
      if (stored.enabled !== false) throw new Error('the disable did not persist');
      if (rejectMarkerOf(stored) !== marker) {
        log.error('signup_reject_identity_marker_lost', {
          tenantId,
          approvalId,
          sub,
          attribute: CP_REJECT_MARKER_ATTR,
          remediation:
            `the identity is disabled but the user profile dropped '${CP_REJECT_MARKER_ATTR}' — a re-signup of ` +
            'this address will be refused identity_disabled; declare the attribute (gitops ' +
            'realm-patch-job-early-access-v2) or re-enable the account by hand',
        });
        return 'disabled_unmarked';
      }
      return 'disabled';
    }
    if (!kc.disableUser) return 'unsupported';
    await kc.disableUser(sub);
    return 'disabled_unmarked';
  } catch (err) {
    log.error('signup_reject_identity_retire_failed', {
      tenantId,
      approvalId,
      sub,
      remediation: 'the realm identity minted for this rejected signup may still be ENABLED; disable it by hand',
      err,
    });
    return `failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
  }
}
