// src/middleware/signup-intake-auth.ts — the guard for POST /api/signup-approvals/intake.
//
// The nonagentic.ai website backend and the signup chat call intake SERVER-SIDE with a Keycloak
// client-credentials token from a dedicated portal-realm client (default `cp-signup-intake`) whose
// service account holds the narrow realm role `cp-signup-intake`. Same shape as
// middleware/fr-feedback-auth.ts, with two extra conditions:
//
//   1. `azp` must be one of `CP_SIGNUP_INTAKE_AZP`. The role alone is not enough: a realm role can be
//      mapped onto any client (or any user) by mistake, and this door writes rows and pings Telegram.
//      Pinning the client too means a mis-mapped role on some other client still cannot get in.
//   1b. `aud` must contain that same `azp`. gitops gives every signup-intake client an
//      `<id>-audience` mapper (aud=<id>), so a token minted for this door names it; a token minted
//      for some other client that happens to carry the role and a listed azp does not.
//   2. A token carrying `super_admin` is REFUSED, even with the right azp and role. This is a narrow
//      service door; an operator session has its own, audited, surfaces and must never be able to
//      pose as the website. (It also keeps the intake SA from ever being "upgraded" into an admin
//      credential by adding roles to it — the moment it holds super_admin it stops working here.)
//
// `authenticateWithoutLicense` (Gate 1 only): the SA has no CP tenant, so there is nothing to
// licence-check, and a licence outage must not stop signups from being recorded.
//
// Errors: missing/invalid/expired token → 401; wrong client / wrong audience / missing role / super_admin → 403.
import { authenticateWithoutLicense } from './auth';
import { signupIntakeConfig } from '../config';
import { forbidden } from '../utils/http';

export interface SignupIntakeCaller {
  /** The service-account subject — audit/log metadata only, never stored as the requester. */
  subject: string;
  azp: string;
}

export async function requireSignupIntakeCaller(req: Request): Promise<SignupIntakeCaller> {
  // `allowServiceRealms`: this is an S2S door, so a KEYCLOAK_SERVICE_ONLY_REALMS (secure-apps) token
  // may verify here — and is then held to the issuer pin below, like every other token.
  const user = await authenticateWithoutLicense(req, { allowServiceRealms: true }); // 401 on missing/invalid/expired token
  const cfg = signupIntakeConfig();
  // Realm-per-app P0: pin the ONE issuer this client is accepted from (default KEYCLOAK_ISSUER), so P1
  // can move each S2S client to secure-apps on its own, and a same-named client in any other trusted
  // realm (a CP app realm's admin could create one) can never stand in for it.
  if (!user.issuer || user.issuer !== cfg.issuer) {
    throw forbidden('signup_intake_forbidden', 'The token was not issued by the realm this client is accepted from.');
  }
  if (user.roles.includes('super_admin')) {
    throw forbidden(
      'signup_intake_forbidden',
      'The signup intake accepts only its dedicated service-account token, never an operator session.',
    );
  }
  if (!user.azp || !cfg.allowedAzp.includes(user.azp)) {
    throw forbidden('signup_intake_forbidden', 'This client is not allowed to submit signups.');
  }
  if (!user.aud || !user.aud.includes(user.azp)) {
    throw forbidden('signup_intake_forbidden', 'The token is not addressed to the signup intake.');
  }
  if (!cfg.role || !user.roles.includes(cfg.role)) {
    throw forbidden('signup_intake_forbidden', `Role '${cfg.role}' required to submit signups.`);
  }
  return { subject: user.id, azp: user.azp };
}
