// src/services/keycloak.ts
// Minimal Keycloak JWT validator (jose). Trimmed from fr/backend's service —
// Common Practice Session 0 only needs token verification, not the Keycloak
// admin-API lookups fr carries. Admin-API features can be added later if needed.
import {
  jwtVerify,
  decodeJwt,
  createRemoteJWKSet,
  type JWTVerifyGetKey,
  type JWTPayload,
} from 'jose';
import {
  config,
  keycloakServiceOnlyRealms,
  keycloakTrustedIssuers,
  realmOfIssuer,
  signupDeciderConfig,
  signupIntakeConfig,
} from '../config';
import { UnauthorizedError, type User } from '../types';
import { log } from '../host/logger';

export type JWKSResolver = JWTVerifyGetKey;

/** CP tenant roles. Never honoured from the realm — they live in `users.tenant_role`. */
const TENANT_ROLES = new Set(['member', 'developer', 'tenant_admin']);

/**
 * The realm roles CP honours: `super_admin` (platform staff), the fr→CP bridge service-account
 * role (middleware/fr-feedback-auth.ts), the signup-intake SA role (middleware/signup-intake-auth.ts)
 * and the Telegram signup-decider SA role (middleware/signup-decider-auth.ts). Every other realm role
 * belongs to fr / the shared realm. ⛔ A guard that checks a realm role it does not list here can never
 * pass: the role is stripped before the guard sees it (the decider door shipped that way and 403'd
 * George's first live Telegram tap).
 * Literal rather than imported so this module does not depend on the middleware layer.
 */
function honouredRealmRoles(): Set<string> {
  const out = new Set(['super_admin']);
  const writer = config.frFeedback.writerRole;
  if (writer && !TENANT_ROLES.has(writer)) out.add(writer);
  // The early-access signup intake SA role (middleware/signup-intake-auth.ts). Read live, like the
  // rest of that feature's config.
  const intake = signupIntakeConfig().role;
  if (intake && !TENANT_ROLES.has(intake)) out.add(intake);
  // The early-access Telegram decider SA role (middleware/signup-decider-auth.ts), read live too.
  const decider = signupDeciderConfig().role;
  if (decider && !TENANT_ROLES.has(decider)) out.add(decider);
  return out;
}

/**
 * The JWKS URL for a trusted issuer. Keys are fetched through KEYCLOAK_URL (the in-cluster service),
 * not the public issuer host, exactly as the single-issuer code always did: only the REALM is taken
 * from the issuer. For the default issuer (KEYCLOAK_ISSUER) this is byte-identical to the old URL.
 */
export function jwksUrlForIssuer(issuer: string): string {
  if (issuer === config.keycloak.issuer) {
    return `${config.keycloak.url}/realms/${config.keycloak.realm}/protocol/openid-connect/certs`;
  }
  const realm = realmOfIssuer(issuer);
  return realm
    ? `${config.keycloak.url}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/certs`
    : `${issuer}/protocol/openid-connect/certs`;
}

const JWKS_URL = jwksUrlForIssuer(config.keycloak.issuer);

/**
 * The realm JWKS resolver, built ON FIRST VERIFY — not at import.
 *
 * ⛔ THIS USED TO BE `createRemoteJWKSet(new URL(JWKS_URL))` AT MODULE SCOPE, AND THAT STOPPED THE
 * PROCESS BOOTING. `new URL()` throws `ERR_INVALID_URL` on a relative string, and with
 * `KEYCLOAK_URL` unset `JWKS_URL` is exactly that — `/realms/portal/protocol/openid-connect/certs`.
 * Because the call sat at module scope, the throw happened at IMPORT time, so anything that
 * imported this module died before running a line of its own. Measured 2026-08-12: the backend
 * exited with `ERR_INVALID_URL` at `keycloak.ts:19` and never reached `server.ts`.
 *
 * ⚠️ THE REASON THAT IS A DEFECT AND NOT A USEFUL GUARD: it fired in EVERY mode, and
 * `config.ts:711-712` explicitly grants the opposite — "In dev with AUTH_BYPASS the Keycloak URL is
 * allowed to be a placeholder; in production it is required." That promise is already enforced, at
 * the layer that actually knows the mode: `validateProductionConfig` pushes `KEYCLOAK_URL` onto
 * `missing` when `env === 'production'`. So prod still fails fast, loudly, naming the variable —
 * while a local `AUTH_BYPASS=true` stack (which never validates a token) now boots, exactly as the
 * config docblock says it may. Nothing became more permissive in production; a contradiction was
 * removed.
 *
 * The old comment on this line already claimed "lazily resolves keys on first verify". That was
 * true of the KEY FETCH and false of the URL — `createRemoteJWKSet` defers the network call but
 * `new URL()` runs immediately. Deferring both is what makes the claim honest.
 *
 * ⛔ DO NOT "simplify" this back to a top-level const. The single `createRemoteJWKSet` instance is
 * preserved below precisely so its internal key cache is not rebuilt per verify — that, not
 * eagerness, is what the original construction was protecting, and it is kept.
 */
// Realm-per-app P0: one cached resolver PER TRUSTED ISSUER (same lazy construction, same reason).
// Keyed by the exact issuer string; only issuers that passed the allowlist ever get an entry, so a
// caller cannot grow this map by minting tokens with arbitrary `iss` values.
const cachedJWKS = new Map<string, JWKSResolver>();

function issuerJWKS(issuer: string): JWKSResolver {
  let r = cachedJWKS.get(issuer);
  if (!r) {
    r = createRemoteJWKSet(new URL(jwksUrlForIssuer(issuer)));
    cachedJWKS.set(issuer, r);
  }
  return r;
}

function realmJWKS(): JWKSResolver {
  return issuerJWKS(config.keycloak.issuer);
}

/** Realm JWKS resolver. Same SHAPE as before; only the URL build is deferred. */
export const defaultJWKS: JWKSResolver = (protectedHeader, token) =>
  realmJWKS()(protectedHeader, token);

/**
 * ⛔ FORWARD THE RESOLVER'S OWN PROPERTIES. A BARE ARROW FUNCTION SILENTLY NARROWS jose's API.
 *
 * `createRemoteJWKSet` does not return a plain function — measured on the installed jose@5.10.0, it
 * returns a function carrying five own properties:
 *
 *     ["coolingDown", "fresh", "reload", "reloading", "jwks"]
 *
 * The wrapper above has none of them, so without this block `defaultJWKS.coolingDown` and friends
 * become `undefined`. TypeScript cannot catch it: `JWTVerifyGetKey` is a CALL signature only, so the
 * wrapper still typechecks perfectly while quietly dropping half the object.
 *
 * Nothing in this repo reads those properties today — verified by grep, not assumed — so this is
 * pre-emptive. It is here anyway because the alternative is a landmine with no failing test behind
 * it: the first person to reach for jose's documented `.reload()` (the normal way to force a key
 * refresh after a realm key rotation) would get `undefined is not a function` and no clue why.
 *
 * The getters resolve through `realmJWKS()`, so reading a property builds the resolver on the same
 * terms as verifying does — which is correct: every one of these is a fact ABOUT the remote key set
 * and is meaningless without one. Methods are bound so `this` stays the real resolver.
 */
for (const key of ['coolingDown', 'fresh', 'reload', 'reloading', 'jwks'] as const) {
  Object.defineProperty(defaultJWKS, key, {
    configurable: true,
    get() {
      const resolver = realmJWKS() as unknown as Record<string, unknown>;
      const value = resolver[key];
      return typeof value === 'function' ? value.bind(resolver) : value;
    },
  });
}

/** Test seam: drop the memoised resolver so a later call rebuilds it from current config. */
export function __resetJWKSForTests(): void {
  cachedJWKS.clear();
}

/**
 * Readiness check: confirm the realm JWKS endpoint is reachable and serves a non-empty key set.
 * A pod whose Keycloak URL/realm is misconfigured can validate NO token, so `/health` (DB-only)
 * would falsely report healthy. Used by `GET /ready` (the startup-probe target) so such a pod
 * never goes live. Deliberately NOT wired to the readiness/liveness probes: a transient Keycloak
 * blip must not depool or restart an already-serving pod (cached JWKS keeps validating). Short
 * timeout so the probe never hangs.
 */
export async function checkKeycloakReachable(timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const body = (await res.json()) as { keys?: unknown[] };
    return Array.isArray(body.keys) && body.keys.length > 0;
  } catch {
    return false;
  }
}

export interface KeycloakServiceOptions {
  /** Override the JWKS source for EVERY issuer (tests inject createLocalJWKSet). */
  jwks?: JWKSResolver;
  /** Override the JWKS source per issuer (tests: distinct keys per realm). Wins over `jwks`. */
  jwksForIssuer?: (issuer: string) => JWKSResolver;
}

export interface ValidateTokenOptions {
  /**
   * Accept a token from a KEYCLOAK_SERVICE_ONLY_REALMS realm (default `secure-apps`). ONLY the S2S
   * doors pass this, and each of them then pins azp + aud + role + its own issuer. Default false: a
   * user-facing route never honours a secure-apps token, because that realm holds human accounts too.
   */
  allowServiceRealms?: boolean;
}

/** True when `issuer` names a realm whose tokens are for S2S doors only. */
export function isServiceOnlyIssuer(issuer: string): boolean {
  const realm = realmOfIssuer(issuer);
  return realm !== undefined && keycloakServiceOnlyRealms().includes(realm);
}

export class KeycloakService {
  // ⚠️ `jwks` keeps its name and meaning (the KEYCLOAK_ISSUER resolver): tests swap it on the
  // singleton (tests/cp-identity.test.ts), so it must stay a plain, writable instance field.
  private jwks: JWKSResolver;
  private readonly jwksAllIssuers: boolean;
  private readonly jwksForIssuer?: (issuer: string) => JWKSResolver;

  constructor(opts: KeycloakServiceOptions = {}) {
    this.jwks = opts.jwks ?? defaultJWKS;
    this.jwksAllIssuers = opts.jwks !== undefined;
    this.jwksForIssuer = opts.jwksForIssuer;
  }

  private jwksFor(iss: string): JWKSResolver {
    if (this.jwksForIssuer) return this.jwksForIssuer(iss);
    if (this.jwksAllIssuers || iss === config.keycloak.issuer) return this.jwks;
    return issuerJWKS(iss);
  }

  async validateToken(token: string, opts: ValidateTokenOptions = {}): Promise<User> {
    // ---- Realm-per-app P0: pick the issuer BEFORE verifying (licenses' auth/jwt_verify.py pattern).
    // The unverified `iss` only SELECTS which allowlisted realm's keys to verify against; `jwtVerify`
    // then pins `issuer` to that same value, so a token cannot borrow one realm's key for another's
    // claims. A token whose `iss` is not allowlisted is refused without any network call.
    let iss: string;
    try {
      const claimed = decodeJwt(token).iss;
      if (typeof claimed !== 'string' || claimed.length === 0) {
        throw new UnauthorizedError('Invalid or expired token');
      }
      iss = claimed;
    } catch {
      // Not a JWT / no `iss`: the client's fault, quiet like ERR_JWT_INVALID below.
      throw new UnauthorizedError('Invalid or expired token');
    }
    if (!keycloakTrustedIssuers().includes(iss)) {
      // warn, not error: the value is attacker-controlled, so this must not page anyone — but a
      // drifted allowlist (realm rename, host change) shows up here with the offending issuer named.
      log.warn('token_issuer_not_trusted', { component: 'keycloak', iss: iss.slice(0, 200) });
      throw new UnauthorizedError('Invalid or expired token');
    }
    if (!opts.allowServiceRealms && isServiceOnlyIssuer(iss)) {
      log.warn('token_service_realm_on_user_route', { component: 'keycloak', iss });
      throw new UnauthorizedError('Invalid or expired token');
    }
    try {
      const { payload } = await jwtVerify(token, this.jwksFor(iss), {
        issuer: iss,
      });
      const claims = payload as JWTPayload & Record<string, unknown>;

      // Keycloak AUTHENTICATES; CP AUTHORIZES. The portal realm is shared with fr, so of its realm
      // roles only `super_admin` and the bridge SA role mean anything here (`honouredRealmRoles`).
      // Tenant and tenant role come from CP's own `users` row (services/cp-identity.ts) — the
      // `tenant_id` claim and the realm tenant_admin/developer/member roles are ignored.
      const realmAccess = claims.realm_access;
      const realmRoles =
        typeof realmAccess === 'object' &&
        realmAccess !== null &&
        Array.isArray((realmAccess as Record<string, unknown>).roles)
          ? (realmAccess as { roles: unknown[] }).roles
          : [];
      const honoured = honouredRealmRoles();
      const roles = realmRoles.filter((r): r is string => typeof r === 'string' && honoured.has(r));

      // `aud` may be a string or a list (RFC 7519 §4.1.3). Read by the signup-intake guard, which
      // requires the token to be addressed to its own client (the `<id>-audience` mapper).
      const aud = (typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : []).filter(
        (a): a is string => typeof a === 'string' && a.length > 0,
      );

      const idpAlias =
        typeof claims.idp_alias === 'string' && claims.idp_alias.length > 0
          ? claims.idp_alias
          : undefined;

      return {
        id: typeof claims.sub === 'string' ? claims.sub : '',
        email: typeof claims.email === 'string' ? claims.email : '',
        name: typeof claims.name === 'string' ? claims.name : '',
        roles,
        emailVerified: claims.email_verified === true,
        ...(idpAlias ? { idpAlias } : {}),
        // The client the token was issued to. Read by the signup-intake guard, which admits only
        // its own dedicated client(s) — a role alone could be mapped onto any client by mistake.
        ...(typeof claims.azp === 'string' && claims.azp.length > 0 ? { azp: claims.azp } : {}),
        ...(aud.length > 0 ? { aud } : {}),
        // The VERIFIED issuer and its realm. The S2S guards pin the issuer per client
        // (CP_SIGNUP_INTAKE_ISSUER / CP_SIGNUP_DECIDER_ISSUER).
        issuer: iss,
        ...(realmOfIssuer(iss) ? { realm: realmOfIssuer(iss) } : {}),
      };
    } catch (error) {
      // ⛔ AN EXPIRED OR MALFORMED TOKEN IS A 401, NOT A SERVER ERROR — and it must not print a
      // stack. This line used to fire UNCONDITIONALLY, which made it fire TWICE per request for
      // any browser session that had simply timed out: `middleware/tenant.ts`'s
      // `peekEffectiveTenant` calls `validateAuth` and SWALLOWS the throw (it deliberately returns
      // null for an unauthenticated caller), and then the route guard calls it again and this runs
      // a second time. Two stack traces, no request id, nothing actionable, for the single most
      // ordinary thing that happens to a logged-in user: their session expired.
      //
      // The fix is to classify rather than to thread a `quiet` flag through `validateAuth` into
      // every caller. jose tags its own rejections with a stable `code` (`ERR_JWT_EXPIRED`,
      // `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`, `ERR_JWT_CLAIM_VALIDATION_FAILED`, `ERR_JWS_INVALID`
      // …), and all of those mean THE CLIENT SENT A BAD TOKEN. That verdict is already fully
      // visible: the caller gets a 401 with this message, and the access log records it. Logging it
      // here adds nothing and drowns the lines that do matter — so the swallowing caller now causes
      // no log at all, and the guard causes no stack.
      //
      // Everything else still logs, loudly, exactly as before: `ERR_JWKS_*`, a fetch failure
      // reaching Keycloak, a misconfigured issuer. Those mean the auth SYSTEM is broken, nobody
      // else will report them, and they are precisely the case where the swallowed call site would
      // otherwise hide the cause. This narrows the noise; it does not narrow the visibility.
      //
      // ⛔ AN EXPLICIT LIST, NOT A `startsWith('ERR_JWT')` PREFIX. The prefix version of this check
      // silenced the single most important thing the paragraph above promises to keep loud:
      // `jwtVerify(token, jwks, { issuer })` raises ERR_JWT_CLAIM_VALIDATION_FAILED on an ISSUER
      // MISMATCH, which starts with ERR_JWT. So a drifted KEYCLOAK_ISSUER — a realm rename, a host
      // change, a stray trailing slash — would 401 one hundred percent of requests while emitting
      // ZERO log lines, indistinguishable from ordinary session expiry. A total auth outage with no
      // signal is exactly the failure this classifier was supposed to make easier to find, not
      // harder. Caught in adversarial review of this commit, by measuring each code rather than
      // reading the prefix.
      //
      // ERR_JWT_CLAIM_VALIDATION_FAILED is genuinely ambiguous, so it is split on the offending
      // claim, which jose reports: `aud`/`exp`/`nbf` are the client's problem and stay quiet;
      // `iss` is ours and logs.
      const err = error as { code?: unknown; claim?: unknown };
      const code = typeof err?.code === 'string' ? err.code : '';
      const QUIET_CLIENT_TOKEN_FAULTS = new Set([
        'ERR_JWT_EXPIRED', // the ordinary one: a session timed out
        'ERR_JWT_INVALID', // not a JWT at all
        'ERR_JWS_INVALID', // garbage in the Authorization header
        'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', // forged, or signed by a key we no longer trust
      ]);
      const clientTokenFault =
        QUIET_CLIENT_TOKEN_FAULTS.has(code) ||
        (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && err.claim !== 'iss');
      if (!clientTokenFault) {
        log.error('token_validation_failed', { component: 'keycloak', err: error });
      }
      throw new UnauthorizedError('Invalid or expired token');
    }
  }

  extractToken(authHeader: string | null): string {
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or invalid Authorization header');
    }
    return authHeader.substring(7);
  }
}

export const keycloak = new KeycloakService();
