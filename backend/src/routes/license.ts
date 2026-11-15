// src/routes/license.ts — the SPA-facing license STATUS endpoint.
//   GET /api/license/status — rich, app-scoped license state for the current request's tenant.
//
// This is the READ companion to the enforcement gate (middleware/license-gate.ts). It is GATE-EXEMPT
// so the SPA can always learn its own license state — otherwise the gate would 402 the very endpoint
// that reports on it. Since WS-2 that exemption is not a path allowlist but a CONSEQUENCE of the
// handler's own choice below: it resolves the tenant via `peekEffectiveTenant`, which uses the raw
// verifier (`authenticateWithoutLicense`) and never runs Gate 2. Swapping that call for
// `validateAuth` would deadlock the "no licence" screen — pinned by
// tests/license-gate-guard-derived.test.ts. The handler never throws a license error itself:
// `getLicenseStatus` fails soft to state:'unknown' on any upstream blip.
//
// Contract (identical shape to fr):
//   { appKey, gateEnabled, tenantId, hasLicense, state, expiresAt, daysRemaining, planCode }
//   state ∈ active | expiring_soon | expired | none | no_seat | seat_pending | no_workspace | unknown
//
// `tenantId` is the tenant this answer is ABOUT (null when none resolved → `no_workspace`). The SPA
// keys its cached status on it: a status read before an invite was accepted is about NO tenant, and
// the moment `/api/me` reports a different one the store re-reads instead of trusting the old
// answer (frontend `licenseGate.syncTenant`).
//
// With the gate OFF (config.license.enforceGate2 false — the F.1 default) this returns
// {state:'active', hasLicense:true} WITHOUT any DB read or introspect, so the frontend gate never
// blocks until F.2 issues per-tenant tokens and flips the flag on.
import { config } from '../config';
import { getLicenseStatus } from '../lib/license-status';
import { peekEffectiveTenant, peekLicensedMember } from '../middleware/tenant';
import { jsonResponse, route } from '../utils/http';
import type { Router } from '../utils/router';

const licenseStatus = route(async (req) => {
  // peekEffectiveTenant never throws (returns null when unauthenticated / no claim), so the status
  // endpoint degrades gracefully to state:'no_workspace' instead of 401-ing — the SPA only calls it once
  // authenticated, but this keeps it robust.
  const tenantId = await peekEffectiveTenant(req);
  // ⭐ THE MEMBER, SO THIS ENDPOINT ANSWERS THE SAME QUESTION THE GATE ASKS. With the per-member
  // gate on, reporting the TENANT's licence to a seatless member tells them "active" while every
  // other request 402s them — and `licenseGate.svelte.ts` `load()` then CLEARS the block the gate
  // just raised, so the next request raises it again. That is a flap loop, not a mislabel.
  //
  // ⚠️ `peekLicensedMember` deliberately resolves the member ONLY when they are judged against their
  // own home tenant — the same exemption `licenseCallerTenant` applies, so a scope-switched operator
  // (who holds no entitlement in the tenant they are acting into) still reads the tenant-level
  // answer instead of being told they have no seat.
  const member = await peekLicensedMember(req, tenantId);
  const status = await getLicenseStatus({
    appKey: config.license.appKey,
    tenantId,
    gateEnabled: config.license.enforceGate2,
    userId: member,
  });
  return jsonResponse({
    appKey: config.license.appKey,
    gateEnabled: config.license.enforceGate2,
    tenantId: tenantId ?? null,
    hasLicense: status.hasLicense,
    state: status.state,
    expiresAt: status.expiresAt,
    daysRemaining: status.daysRemaining,
    planCode: status.planCode,
  });
});

export function registerLicenseRoutes(router: Router): void {
  router.add('GET', '/api/license/status', licenseStatus);
}
