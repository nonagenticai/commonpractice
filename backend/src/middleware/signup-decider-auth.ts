// src/middleware/signup-decider-auth.ts — the guard for POST /api/signup-approvals/:id/telegram-decision.
//
// George approves early-access signups by tapping a callback button in Telegram (early-access v2,
// contract C3). Telegram delivers the tap to chat-bridge — the bot's only update consumer — which
// checks that the tapper is an approver and then calls this route SERVER-SIDE with a Keycloak
// client-credentials token from its own portal-realm client (default `chat-bridge-signup-decider`)
// whose service account holds the narrow realm role `cp-signup-decide`. Modelled on
// middleware/signup-intake-auth.ts, with the same four conditions:
//
//   1. `azp` must be one of `CP_SIGNUP_DECIDER_AZP`. A realm role can be mapped onto the wrong client
//      by mistake; this door CREATES WORKSPACES, so the client is pinned too.
//   1b. `aud` must contain that same `azp` (gitops gives the client an `<id>-audience` mapper).
//   2. the realm role `CP_SIGNUP_DECIDER_ROLE` (default `cp-signup-decide`).
//   3. a token carrying `super_admin` is REFUSED: a human operator decides on /onboarding, behind the
//      audited super_admin surfaces. This SA must never be "upgraded" into an admin credential.
//
// It is deliberately NOT the intake client/role: the website SA can queue signups and nothing else;
// only the decider SA can approve them.
//
// `authenticateWithoutLicense` (Gate 1 only): the SA has no CP tenant, so there is nothing to
// licence-check, and a licence outage must not stop a decision from being recorded.
//
// Errors: missing/invalid/expired token → 401; wrong client / audience / role / super_admin → 403.
import { authenticateWithoutLicense } from './auth';
import { signupDeciderConfig } from '../config';
import { forbidden } from '../utils/http';

export interface SignupDeciderCaller {
  /** The service-account subject — audit metadata only. */
  subject: string;
  azp: string;
}

export async function requireSignupDeciderCaller(req: Request): Promise<SignupDeciderCaller> {
  // `allowServiceRealms`: this is an S2S door, so a KEYCLOAK_SERVICE_ONLY_REALMS (secure-apps) token
  // may verify here — and is then held to the issuer pin below, like every other token.
  const user = await authenticateWithoutLicense(req, { allowServiceRealms: true }); // 401 on missing/invalid/expired token
  const cfg = signupDeciderConfig();
  // Realm-per-app P0: pin the ONE issuer this client is accepted from (default KEYCLOAK_ISSUER), so P1
  // can move each S2S client to secure-apps on its own, and a same-named client in any other trusted
  // realm (a CP app realm's admin could create one) can never stand in for it.
  if (!user.issuer || user.issuer !== cfg.issuer) {
    throw forbidden('signup_decider_forbidden', 'The token was not issued by the realm this client is accepted from.');
  }
  if (user.roles.includes('super_admin')) {
    throw forbidden(
      'signup_decider_forbidden',
      'The Telegram decision door accepts only its dedicated service-account token, never an operator session.',
    );
  }
  if (!user.azp || !cfg.allowedAzp.includes(user.azp)) {
    throw forbidden('signup_decider_forbidden', 'This client is not allowed to decide signups.');
  }
  if (!user.aud || !user.aud.includes(user.azp)) {
    throw forbidden('signup_decider_forbidden', 'The token is not addressed to the signup decider.');
  }
  if (!cfg.role || !user.roles.includes(cfg.role)) {
    throw forbidden('signup_decider_forbidden', `Role '${cfg.role}' required to decide signups.`);
  }
  return { subject: user.id, azp: user.azp };
}
