// src/middleware/license-gate.ts — Phase 4 / F.1: Gate 2 of the license dual-gate (Spec Part 9).
//
// CP requires BOTH gates on every non-exempt request, fail-closed (Spec 9.2):
//   Gate 1 — Keycloak portal identity (resolves WHO + WHICH tenant; already shipped).
//   Gate 2 — the caller's tenant holds an ACTIVE `commonpractice` license (this module).
// Gate 2 reads the tenant's stored license token, introspects it against the central licenses
// service (services/license-client.ts), and asserts:
//     active === true                                  (else 402 license_inactive)
//     expires_at not passed                            (else 402 license_expired)
//     app.key === config.license.appKey                (else 403 license_app_mismatch)
//     introspect.tenant_id === the resolved tenant     (else 403 license_tenant_mismatch)
// The LAST check binds the two gates: a license that belongs to another tenant (or another app)
// can never satisfy a session — the same Keycloak-resolved tenant feeds both this check and the RLS
// `SET LOCAL app.current_tenant` (D.1), so a licensed request and its DB scope are always one tenant.
//
// FAIL-CLOSED: no stored token → 402 license_required; a stored token that will not DECRYPT →
// 402 license_unreadable (terminal — an operator must repair it); introspect throws (licenses
// service unreachable / non-2xx) → 402 license_unavailable. An outage DENIES, never allows through (mirrors
// worker_management / license-authz). A super_admin scope-switched INTO a tenant
// (X-Active-Tenant-Id) is evaluated against that TARGET tenant, so the operator sees the same
// "tenant unlicensed" state the tenant would.
//
// ── WHICH REQUESTS GATE 2 APPLIES TO (the reconciled invariant) ─────────────────────────────
// Gate 2 licenses A TENANT'S USE OF THAT TENANT'S DATA. A route whose rows are platform-global and
// whose only authority is `requireSuperAdmin` has no tenant to license — so it is not gated. That
// exemption is GUARD-DERIVED, not path-derived: `requireSuperAdmin` calls
// `authenticateWithoutLicense`, every other guard calls `validateAuth` (= Gate 1 + this gate).
//
// It used to be a path allowlist evaluated once in server.ts before any guard ran, and a pathname
// simply cannot express the route set:
//   • `POST /api/tenants/:id/budget` is platform (grantBudget, requireSuperAdmin) while `GET` on
//     the SAME path is tenant (getBudget, requireTenantAdmin) — the allowlist was method-blind.
//   • `GET /api/sandboxes` is platform but `GET /api/sandboxes/me` is not; `POST /api/cycle/advance`
//     is platform but `GET /api/cycle/current` is not; `GET /api/signup-approvals` is platform but
//     `POST /api/signup-approvals/notify-self` is not.
//   • This repo already shipped the failure mode once: `/api/tenants/:id/usage` sat under the
//     exempt `/api/admin/*` prefix and was a genuine enforcement hole (see the regression test that
//     records it in tests/license-gate.test.ts).
// The four old allowlist entries survive as CONSEQUENCES of the guards, and tests pin them:
// `/health` has no auth at all; `/api/admin/*` and `POST /api/tenants/{uuid}/license` are
// `requireSuperAdmin`; `/api/license/status` resolves via `peekEffectiveTenant` (the raw verifier),
// which is also what stops the "no licence" screen from deadlocking on its own gate.
// Note the inverse rule ("exempt any handler that ever calls requireSuperAdmin") is equally wrong:
// routes/blocks.ts calls it CONDITIONALLY, inside authorizeBlockWrite, for global blocks only,
// reached from 12 routes — that rule would exempt the whole block-authoring surface.
//
// F.1 ships this DEFAULT-OFF (config.license.enforceGate2): with the flag off the gate is a pure
// no-op (never reads the DB, never introspects). F.2 issues per-tenant tokens into onboarding and
// flips the flag on (Spec 9.5 Phase C→F) — enabling enforcement before tokens exist would 402 every
// tenant.
import { config } from '../config';
import {
  tenantLicenseToken,
  memberEntitlementToken,
  tenantLevelLicense,
  LicenseTokenUnreadableError,
} from '../lib/license-status';
import { licenseClient, LicenseIntrospectNotConfiguredError } from '../services/license-client';
import { paymentRequired, forbidden, HttpError } from '../utils/http';
import { incCounter } from '../host/metrics';
import { seatMemberInline } from '../services/inline-seat';
import { isSuperAdmin } from './admin-guards';
import type { User } from '../types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-REQUEST memo. A single handler routinely passes through two guards (e.g. `resolveTenant`
 * then `requireDeveloper`), and each Gate-2 check is a `runAsSystem` SELECT plus a TTL-cached
 * introspect — so without this the same verdict is computed twice per request. Keyed on the
 * Request object itself (weak: nothing is retained past the request).
 */
const memo = new WeakMap<Request, Promise<void>>();

/**
 * Gate 2, entered from `validateAuth` — i.e. from a guard that has already decided this request
 * operates on a tenant's data. Resolves the effective tenant EXACTLY as `peekEffectiveTenant`
 * does (a super_admin's valid `X-Active-Tenant-Id` > the home tenant), so a scope-switched
 * operator is judged against the tenant they are acting into, then delegates to the unchanged
 * `assertTenantLicensed`.
 */
export async function licenseCallerTenant(req: Request, user: User): Promise<void> {
  if (!config.license.enforceGate2) return; // cheap short-circuit before touching the memo
  let pending = memo.get(req);
  if (!pending) {
    const header = req.headers.get('X-Active-Tenant-Id');
    const scopeSwitched = isSuperAdmin(user) && header && UUID_RE.test(header);
    const tenantId = scopeSwitched ? header : (user.tenantId ?? null);
    // ⛔ A SCOPE-SWITCHED OPERATOR IS NOT A SEAT, AND MUST NOT BECOME ONE. A super_admin acting into
    // a customer's tenant via `X-Active-Tenant-Id` holds no `member_entitlements` row there — they
    // are not an employee of that company. Demanding one would lock platform staff out of every
    // tenant; MINTING one would put platform staff on the customer's invoice, because billing counts
    // a seat as a licences-service `human_subjects` entry. So the per-member check applies only to a
    // caller judged against their OWN home tenant, and the operator path stays on the tenant-level
    // token — an explicit exemption rather than a silent one.
    // ⚠️ NO `user.tenantId === tenantId` TERM HERE, AND ITS ABSENCE IS THE POINT. That clause looked
    // like a membership check and could not fail: on this branch `tenantId` was just assigned
    // `user.tenantId ?? null`, so comparing them is a tautology — a guard that cannot refuse. The
    // real discriminator is `scopeSwitched`: it is the ONLY way `tenantId` can differ from the
    // caller's own home tenant, so excluding it is exactly "judge a member against their own home tenant".
    const member = !scopeSwitched && tenantId ? { userId: user.id } : undefined;
    pending = assertTenantLicensed(req, tenantId, member);
    memo.set(req, pending);
  }
  await pending;
}

/**
 * Gate 2. Throws an HttpError (402/403) when the tenant is not validly licensed; returns normally
 * (the request proceeds) when the gate passes, is disabled, or no tenant is resolvable
 * (unauthenticated — the route's own auth guard then 401/403s). NEVER throws a non-Http error: a
 * corrupt token blob degrades to 402 license_unreadable, an introspect failure to 402
 * license_unavailable.
 *
 * Kept exported with this exact signature: tests/license-gate.test.ts drives the whole 402/403
 * matrix through it directly, and the WS-2 change above is then one commit to revert. `req` is now
 * unread (the path allowlist it fed is gone) but stays in the signature for exactly that reason.
 */
export async function assertTenantLicensed(
  req: Request,
  tenantId: string | null,
  /**
   * The MEMBER whose seat is being checked, when the request is judged against their own home tenant
   * (see `licenseCallerTenant` for who is excluded and why). Optional:
   * `tests/license-gate.test.ts` drives the tenant-level matrix through this function directly with
   * two arguments, and a scope-switched operator deliberately passes nothing.
   *
   * ⛔ DELIBERATELY NOT NAMED `caller`. In this estate "caller identity" is a term of art for the
   * KEYCLOAK SERVICE-ACCOUNT axis — the calling SERVICE and what it is allowed to do — and it is
   * kept deliberately SEPARATE from the licence axis, which carries tenant, subject and budget and
   * never roles. `caller_client_id` (the verified `azp` of the upstream service) is that axis on the
   * wire. A licence is about a SUBJECT; the caller is merely who asked. Naming a human "caller" in
   * the licence gate is the conflation those two axes exist to prevent, so this is `member` and the
   * value it binds to is the licences-service Subject UUID.
   * ⚠️ The surrounding `licenseCallerTenant` predates this and uses "caller" for the human. It is
   * left alone rather than renamed here, but do not spread it.
   */
  member?: { userId: string },
): Promise<void> {
  // F.1 default-OFF: dormant until F.2 issues tokens and flips the flag.
  if (!config.license.enforceGate2) return;

  // Unauthenticated / no workspace — there is no tenant to license-check here; the route's auth
  // guard fails the request (401/403). Gate 2 only applies to a resolved tenant session.
  if (!tenantId) return;

  // ⭐ TENANT-LEVEL LICENCES (ruling 2026-09-28). A tenant's bundle holds ONE licence per
  // (tenant, app), on the service subject `svc:<tenant-uuid>:<app>`. CP never minted it and holds no
  // token for it, so the stored-token check below answers `license_required` (or, per-member,
  // `license_seat_required`) for a tenant that is paying. So: the stored-token path runs FIRST and
  // UNCHANGED — a tenant whose token works costs no extra call and gets the identical verdict — and
  // only a DENIAL consults the licences service by (tenant, app). A valid tenant-level licence
  // admits; none re-throws the stored-token verdict exactly as it was.
  try {
    await assertStoredLicence(tenantId, member);
    return;
  } catch (verdict) {
    if (!(verdict instanceof HttpError)) throw verdict; // unreachable by contract; never swallow
    let resp;
    try {
      resp = await tenantLevelLicense(tenantId);
    } catch {
      // FAIL-CLOSED, and honestly labelled. The lookup could not be made, so we cannot say the
      // tenant is unlicensed: a `license_required`/`license_seat_required` verdict that exists only
      // because CP holds no token would be a false "you have not paid" during a licences blip.
      // Those two become `license_unavailable` (still a 402, still a DENY); a more specific stored
      // verdict (unreadable, expired, mismatch) is kept as it was.
      incCounter('license_tenant_level_lookup_failures_total');
      if (verdict.code === 'license_required' || verdict.code === 'license_seat_required') {
        throw paymentRequired(
          'license_unavailable',
          'Could not verify the tenant license; access denied.',
        );
      }
      throw verdict;
    }
    if (resp) return; // a valid (active, unexpired, this app, this tenant) tenant-level licence
    throw verdict;
  }
}

/**
 * The stored-token half of Gate 2: the tenant's (or, per-member, the member's) token held in CP's
 * own DB, introspected. Throws the 402/403 verdict; returns when that token admits the request.
 * Behaviour is exactly what `assertTenantLicensed` did before tenant-level licences existed.
 */
async function assertStoredLicence(
  tenantId: string,
  member: { userId: string } | undefined,
): Promise<void> {
  // The token lookup is itself fail-closed: a DB error here must DENY (402), never surface as a 500
  // (this gate runs outside a route() wrapper, so a raw Error would become an Internal Server Error).
  //
  // ⛔ TWO DIFFERENT FAULTS LIVE IN THIS CATCH, AND ONLY ONE OF THEM EVER RECOVERS ON ITS OWN.
  // `LicenseTokenUnreadableError` means the stored blob exists and will not decrypt — a wrong or
  // rotated `CP_SECRET_KEY`, or a corrupt row. That condition is STANDING (see the once-per-process
  // warn in lib/license-status.ts, which exists precisely because it does not fix itself), it hits
  // EVERY tenant at once after a rotation, and no amount of retrying or renewing clears it. Every
  // other throw out of this lookup is a transport/DB blip that does recover on its own. So they get
  // DIFFERENT terminal codes: `license_unreadable` (needs an operator, no Renew/Retry CTA) vs
  // `license_unavailable` (whose copy promises "access resumes automatically as soon as it
  // succeeds" — true for a blip, a lie for a rotated key).
  //
  // ⛔ WHY THIS ARRIVED ONE DEPLOY LATER THAN THE COPY THAT DESCRIBES IT. KEEP THIS REASONING —
  // it is the durable part, and it applies to the NEXT new 402 code as much as it did to this one.
  // The two halves could not land together. CP runs 2–4 replicas with `RollingUpdate maxSurge:1
  // maxUnavailable:0`, and a browser holding a cached bundle outlives the whole roll, so there is
  // always a window of OLD SPA against NEW API. In that window a 402 code the SPA does not know is
  // NOT in `LICENSE_BLOCK_CODES` → `isLicenseBlockResponse` is false → the auth-fetch interceptor
  // never fires → NO block screen at all, and every screen instead papers itself with
  // `error_license_required` ("your workspace doesn't have an active Common Practice license") —
  // the exact accusation #252 removed, and strictly WORSE than the bug being fixed. Measured, not
  // assumed: old-SPA + new-API gave `isBlocked=false, blockReason=null`.
  //
  // The reverse window is free: NEW SPA + OLD API was byte-identical to the then-current behaviour
  // (the API still emitted `license_unavailable`, the SPA still ranked it `outage`, same copy, same
  // buttons). So the ordering was forced and the split cost nothing:
  //   deploy 1 — SPA only (#255): `LICENSE_BLOCK_CODES`, `LICENSE_MESSAGES`/`KNOWN_LICENSE_CODES`,
  //              the `'unreadable'` blockReason + rank, the third `LicenseBlocked` branch, 3 keys ×
  //              8 catalogs. Backend deliberately untouched, still emitting `license_unavailable`.
  //   deploy 2 — THIS emission, once that bundle was confirmed live in production.
  // The invariant that made it safe is enforced, not remembered: frontend's
  // `error-message.backend-contract.test.ts` scrapes every `paymentRequired(` code out of
  // `backend/src` and reds unless the SPA both BLOCKS it (`LICENSE_BLOCK_CODES`) and SPEAKS it
  // (`KNOWN_LICENSE_CODES`). A future 402 code added here without its SPA half cannot go green.
  // PER-MEMBER MODE (0089), flag-gated. When on, the entitlement being checked is the MEMBER'S OWN
  // — which is the only way `human_subjects` can count seats and the only way offboarding can
  // release one. When off, or for a request judged against a tenant the user is not a member of, the tenant-level
  // token is used exactly as before, so this is inert until `LICENSE_GATE_PER_MEMBER` is flipped.
  const perMember = config.license.perMemberGate && member != null;

  let token: string | null;
  // The Subject UUID the presented token MUST introspect to. Null in tenant mode (there is no
  // per-member binding to make there).
  let boundSubjectId: string | null = null;
  try {
    if (perMember) {
      let ent = await memberEntitlementToken(tenantId, member!.userId);
      // ⭐ SELF-HEALING SEAT. No seat → seat this member NOW (`seatMemberInline`: the sweep's own
      // eligibility predicate + `ensureMemberEntitlement`, single-flight, negative-cached) and re-read,
      // instead of locking them out until the next 5-minute `repairUnseatedMembers` tick. Refused
      // only if seating is refused or fails (issuance off, ineligible, licences refused the mint).
      if (!ent?.token && (await seatMemberInline(tenantId, member!.userId))) {
        ent = await memberEntitlementToken(tenantId, member!.userId);
      }
      token = ent?.token ?? null;
      boundSubjectId = ent?.subjectId ?? null;
      if (!token) {
        // ⛔ ITS OWN CODE, NOT `license_required`, AND THE DIFFERENCE IS THE WHOLE REASON IT EXISTS.
        // `license_required` means "this workspace was never licensed" and the SPA renders it as a
        // terminal billing wall aimed at the workspace. Here the workspace is licensed and PAYING;
        // this one person has no seat. Reusing the tenant code would send a reader to a billing
        // screen to fix something that is not broken — the same class of false accusation as the
        // `error_license_required` papering this file's rolling-deploy note records.
        throw paymentRequired(
          'license_seat_required',
          'You do not have a Common Practice seat in this workspace.',
        );
      }
    } else {
      token = await tenantLicenseToken(tenantId);
    }
  } catch (err) {
    // A thrown HttpError is a VERDICT, not a lookup fault — re-throw it untouched. Without this the
    // `license_seat_required` above would be swallowed by the catch below and re-emitted as
    // `license_unavailable` ("could not verify… access resumes automatically"), turning a permanent,
    // actionable state into a phantom outage nobody would ever chase.
    if (err instanceof HttpError) throw err;
    if (err instanceof LicenseTokenUnreadableError) {
      // The counter PREDATES the wire code and outlives it. It stayed the only discriminator for the
      // whole of deploy 1, and it is still the thing that separates "the licences DB hiccuped" from
      // "somebody rotated CP_SECRET_KEY and de-licensed the fleet" in a dashboard, where nobody is
      // reading response bodies. Do not fold it into the throw below.
      incCounter('license_token_unreadable_total');
      throw paymentRequired(
        'license_unreadable',
        'The stored tenant license cannot be read; access denied. This needs an operator.',
      );
    }
    throw paymentRequired(
      'license_unavailable',
      'Could not verify the tenant license; access denied.',
    );
  }
  if (!token) {
    throw paymentRequired(
      'license_required',
      'This tenant has no active Common Practice license.',
    );
  }

  let resp;
  try {
    resp = await licenseClient().introspect(token);
  } catch (err) {
    // Licenses service unreachable / non-2xx (LicenseClientError) or any other error → fail-closed
    // DENY (never allow-through). Surface as a metric — a spike means the licenses service is down
    // and is 402-ing real tenants (an alertable outage, not per-tenant denial).
    incCounter('license_introspect_failures_total');
    // ⚠️ ONE OF THESE IS NOT AN OUTAGE. `LicenseIntrospectNotConfiguredError` means Gate 2 is ON and
    // `LICENSE_INTROSPECT_URL` is empty — no request was ever sent. That is a MISCONFIGURATION,
    // permanent until someone edits the deployment, and it makes every tenant look like an outage
    // victim. `config.ts`'s `validateConfigInvariants` now refuses to boot in that state in EVERY
    // environment, so this should be unreachable — which is precisely why it gets its own counter
    // rather than being deleted: a non-zero value here means that boot guard was bypassed or
    // regressed, and no amount of staring at `license_introspect_failures_total` would say so.
    //
    // ⛔ DISCRIMINATE ON IDENTITY, NEVER ON `err.status === 500`. This check used to do exactly that
    // and it was FALSE: `license-client.ts` also raises `new LicenseClientError(res.status, …)` for
    // ANY non-2xx, so a genuine HTTP 500 from the licences service is `instanceof LicenseClientError`
    // with `status === 500` too. Under that version this counter climbed on EVERY request of a real
    // upstream outage and the comment above sent the on-call operator hunting a config regression
    // that did not exist — a new operator-facing lie, in the commit that removed three others.
    if (err instanceof LicenseIntrospectNotConfiguredError) {
      incCounter('license_introspect_misconfigured_total');
    }
    throw paymentRequired(
      'license_unavailable',
      'Could not verify the tenant license; access denied.',
    );
  }

  if (resp.active !== true) {
    throw paymentRequired('license_inactive', 'The tenant license is not active.');
  }
  if (resp.expires_at) {
    const exp = Date.parse(resp.expires_at);
    if (Number.isFinite(exp) && exp <= Date.now()) {
      throw paymentRequired('license_expired', 'The tenant license has expired.');
    }
  }
  if (resp.app?.key !== config.license.appKey) {
    throw forbidden(
      'license_app_mismatch',
      'The license is not for the Common Practice application.',
    );
  }
  if (resp.tenant_id !== tenantId) {
    throw forbidden(
      'license_tenant_mismatch',
      'The license belongs to a different tenant.',
    );
  }
  // ⭐ THE ASSERTION THAT MAKES PER-MEMBER LICENSING MEAN ANYTHING. Everything above this line is
  // satisfied just as well by ANY valid licence of this tenant — which is precisely how one shared
  // token used to admit every employee. Binding the introspected `subject_id` to the Subject UUID
  // stored on THIS member's entitlement row is what makes member A's token fail for member B.
  //
  // ⚠️ A NULL `boundSubjectId` DENIES rather than skipping the check. An `active` entitlement is
  // constrained to carry a licence and a token (0089's ck_..._active_is_complete) but the subject
  // column is nullable for the `pending` state, so a row written by an older build could reach here
  // without one. Treating "nothing to compare" as "comparison passed" would silently restore the
  // shared-token behaviour under a flag that claims to have removed it.
  if (perMember && resp.subject_id !== boundSubjectId) {
    throw forbidden(
      'license_subject_mismatch',
      'The license does not belong to this member.',
    );
  }
  // Both gates satisfied — fall through (the handler runs under the tenant-bound DB connection).
}
