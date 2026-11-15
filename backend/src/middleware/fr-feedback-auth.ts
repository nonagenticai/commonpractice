// src/middleware/fr-feedback-auth.ts
//
// Phase 5.1 — the inbound bridge gate for fr→CP promotion feedback. The mirror
// of fr's `requireBridgeWriter` (fr/backend/src/middleware/bridge-auth.ts), in
// the opposite direction: fr's portal service account (`fr-backend`) calls CP,
// and CP must verify it.
//
// It authenticates with `authenticateWithoutLicense` (Gate 1: JWKS of the token's
// trusted issuer, `iss` pinned), then pins the issuer list (FR_FEEDBACK_ISSUER) and the
// client (FR_FEEDBACK_AZP). It then requires the configured realm
// role (`delivery-feedback-writer`, mapped to the fr-backend SA — one of the two
// realm roles services/keycloak.ts keeps). No CP user, no tenant, no Gate-2 — the
// role IS the authorization,
// and the body's tenant_id is cross-checked against the matched delivery row
// under RLS by the route.
//
// Errors: missing/invalid/expired token → 401 (UnauthorizedError, raised by
// validateAuth); valid token without the role → 403.
//
// ⛔ THIS GUARD DOES NOT GATE TENANT SUSPENSION, AND CALLERS MUST NOT ASSUME IT DOES.
// `validateAuth` runs `assertTenantActive` (middleware/tenant-status-gate.ts) — but that gate
// resolves the caller's CP home tenant, and this service account has none (see "no CP user, no
// tenant" above). The gate therefore takes its documented
// `tenantId === null` no-op branch and checks nothing at all. Going through this guard is a
// STRUCTURAL no-op for suspension, not a check that happens to pass.
//
// It is left that way on purpose: the SA has no tenant of its own, so there is no correct tenant to
// judge HERE. The tenant this bridge acts on arrives in the request BODY, which only the route can
// validate — so `routes/delivery.ts frFeedback` calls `assertTenantNotSuspended(body.tenant_id)`
// itself, after parsing and before any write. Any future route added behind this guard must do the
// same for whatever tenant IT acts on.

import { authenticateWithoutLicense } from './auth';
import { frFeedbackDoorConfig } from '../config';
import { forbidden } from '../utils/http';

export interface FrFeedbackCaller {
  /** The service-account subject (azp/sub) — for audit metadata only. */
  subject: string;
  roles: string[];
}

/** Validate the inbound fr-backend SA JWT and assert the feedback-writer role.
 *
 *  Realm-per-app P7 chain C: fr's S2S token moves portal -> secure-apps (fr KEYCLOAK_SERVICE_REALM).
 *  This is an S2S door, so a KEYCLOAK_SERVICE_ONLY_REALMS (secure-apps) token may verify here
 *  (`allowServiceRealms`) — and every token is then held to the issuer pin (FR_FEEDBACK_ISSUER) and
 *  the client pin (FR_FEEDBACK_AZP, default fr-backend). Gate 1 only (`authenticateWithoutLicense`):
 *  the SA has no CP tenant, so `validateAuth`'s tenant-status gate was a structural no-op here anyway
 *  and the route re-enters it on the BODY's tenant (`assertTenantNotSuspended`, routes/delivery.ts).
 *  A token carrying `super_admin` is refused: an operator session must never pose as fr.
 */
export async function requireFrFeedbackWriter(req: Request): Promise<FrFeedbackCaller> {
  const user = await authenticateWithoutLicense(req, { allowServiceRealms: true }); // 401 on missing/invalid/expired token
  const cfg = frFeedbackDoorConfig();
  if (!user.issuer || !cfg.issuers.includes(user.issuer)) {
    throw forbidden('fr_feedback_forbidden', 'The token was not issued by a realm this client is accepted from.');
  }
  if (user.roles.includes('super_admin')) {
    throw forbidden('fr_feedback_forbidden', 'The fr feedback door accepts only its service-account token.');
  }
  if (!user.azp || !cfg.allowedAzp.includes(user.azp)) {
    throw forbidden('fr_feedback_forbidden', 'This client is not allowed to post delivery promotion feedback.');
  }
  if (!user.roles.includes(cfg.role)) {
    throw forbidden(
      'fr_feedback_forbidden',
      `Role '${cfg.role}' required to post delivery promotion feedback`,
    );
  }
  return { subject: user.id, roles: user.roles };
}
