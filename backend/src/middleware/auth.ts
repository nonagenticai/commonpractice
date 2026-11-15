// src/middleware/auth.ts
// Mirrors fr/backend's auth seam. Tests install fakes via
// `__setAuthOverridesForTests` (paired with `(undefined)` teardown) instead of
// `mock.module()` — module mocks leak process-wide on Bun and the house rule
// forbids them.
//
// GATE SPLIT (see middleware/license-gate.ts for the full reconciliation):
//   `authenticateWithoutLicense` — Gate 1 ONLY (who is this / which CP workspace).
//   `validateAuth`               — Gate 1 + Gate 2 (that tenant holds an active licence).
// The NAME `validateAuth` deliberately keeps its meaning: every tenant-facing handler that
// already calls it stays licence-gated with no edit. Only the three callers that must NOT be
// licence-gated (requireSuperAdmin, peekEffectiveTenant, and validateAuth itself) reach for the
// raw verifier. NB the test override is consulted by the RAW function on purpose — otherwise
// every test that injects an identity would also silently skip Gate 2.
import { keycloak, type ValidateTokenOptions } from '../services/keycloak';
import { hydrateCpIdentity, roleFromRealmRoles } from '../services/cp-identity';
import { DEMO_TENANT_ID, authBypassEnabled } from '../config';
import { licenseCallerTenant } from './license-gate';
import { assertTenantActive } from './tenant-status-gate';
import { UnauthorizedError, type User } from '../types';

export interface AuthOverridesForTests {
  validateAuth?: (req: Request) => Promise<User>;
  requireRole?: (req: Request, role: string) => Promise<User>;
}
let _authOverridesForTests: AuthOverridesForTests | undefined;
export function __setAuthOverridesForTests(
  overrides: AuthOverridesForTests | undefined,
): void {
  _authOverridesForTests = overrides;
}

// AUTH_BYPASS synthetic user. The role set is the SINGLE unified taxonomy
// (super_admin / tenant_admin / developer / member) — the legacy platform/employee/admin
// roles are retired (every Operate route now gates on requireSuperAdmin, not the old
// 'platform' role). The dev user defaults to `super_admin` so the full surface is
// reachable out of the box; set AUTH_BYPASS_ROLES to exercise a specific role's gates
// exactly as a real Keycloak account would — this is what stops the two-taxonomy gap
// from silently reappearing (a dev can now actually be "just a member"):
//   AUTH_BYPASS_ROLES=member            → Discover only
//   AUTH_BYPASS_ROLES=developer         → Discover + tenant authoring
//   AUTH_BYPASS_ROLES=tenant_admin      → + Administer
//   AUTH_BYPASS_TENANT_ID=<uuid>        → override the dev user's home tenant
// The dev user is NOT hydrated from `users` (there is no token to verify); it defaults to the
// seeded demo tenant (DEMO_TENANT_ID) so dev works out of the box.
const DEFAULT_BYPASS_ROLES = ['super_admin'];

function bypassUser(): User {
  const rolesEnv = process.env.AUTH_BYPASS_ROLES;
  const roles = rolesEnv
    ? rolesEnv.split(',').map((r) => r.trim()).filter(Boolean)
    : DEFAULT_BYPASS_ROLES;
  const tenantId = process.env.AUTH_BYPASS_TENANT_ID || DEMO_TENANT_ID;
  return {
    id:
      process.env.AUTH_BYPASS_USER_ID ??
      '00000000-0000-0000-0000-000000000000',
    email: 'dev@localhost',
    name: 'Dev User',
    roles,
    tenantId,
    tenantRole: roleFromRealmRoles(roles),
    emailVerified: true,
  };
}

/**
 * Gate 1 ONLY: resolve WHO the caller is and their CP workspace (`hydrateCpIdentity`). Performs NO licence
 * check. Reserved for the three call sites that must work for a caller whose tenant is unlicensed:
 *   • `requireSuperAdmin` — the platform surface has no tenant of its own to license.
 *   • `peekEffectiveTenant` — feeds the RLS pre-set and `GET /api/license/status`; gating it would
 *     deadlock the very screen that reports "you have no licence".
 *   • `validateAuth` below, which then adds Gate 2.
 * Everything else must call `validateAuth`.
 */
export async function authenticateWithoutLicense(
  req: Request,
  opts: ValidateTokenOptions = {},
): Promise<User> {
  if (_authOverridesForTests?.validateAuth) {
    return _authOverridesForTests.validateAuth(req);
  }
  // ⛔ `authBypassEnabled()` from config.ts, NOT a local `process.env.AUTH_BYPASS === 'true'`. This
  // line used to carry its own copy of that expression while `config.authBypass` carried a second,
  // and `validateProductionConfig` gated on the second one only — so widening THIS one by a token
  // handed every anonymous production caller a super_admin session that the prod fail-fast could
  // not see. One helper, one meaning. Still read at CALL time (tests flip the env around a call).
  if (authBypassEnabled()) {
    return bypassUser();
  }
  const authHeader = req.headers.get('Authorization');
  const token = keycloak.extractToken(authHeader);
  const verified = await keycloak.validateToken(token, opts);
  // Keycloak authenticated; CP authorizes from its own `users` row (cached per request).
  return hydrateCpIdentity(verified, req);
}

/**
 * Gate 1 + Gate 2 — the default authenticator for every TENANT-facing handler.
 *
 * Gate 2 used to run once, centrally, in server.ts before any route guard, which made the whole
 * super_admin console hostage to whichever tenant the operator was acting into. It is now derived
 * from the guard the route already chose: a handler that calls this is by definition operating on
 * a tenant's data, so that tenant must be licensed (402/403 exactly as before).
 */
export async function validateAuth(req: Request): Promise<User> {
  const user = await authenticateWithoutLicense(req);
  // ⛔ THE TENANT-STATUS GATE RUNS BEFORE GATE 2, AND THE ORDER IS THE WHOLE POINT — SWAPPING THESE
  // TWO LINES STILL PASSES EVERY OBVIOUS TEST WHILE TELLING PAYING CUSTOMERS A LIE.
  // `routes/admin.ts patchTenant` already calls `revokeTenantLicense(id)` when an operator sets
  // `status='suspended'`. So the moment LICENSE_ISSUANCE_ENABLED and LICENSE_GATE_2_ENABLED are both
  // on, a suspended tenant is ALSO an unlicensed one, and whichever gate runs first is the one whose
  // code reaches the browser. With Gate 2 first the answer is `402 license_required` — the SPA's
  // terminal "your workspace doesn't have an active Common Practice licence, contact your
  // administrator / renew" wall. That is the wrong accusation twice over: the licence did not
  // expire and there is nothing for the customer to renew; an operator suspended the workspace, and
  // reactivating it (which reissues the licence) is the only thing that clears it.
  // Suspension is the CAUSE, the missing licence is its CONSEQUENCE, and the gate that reports the
  // cause must therefore win the race. tests/tenant-suspension-gate.test.ts pins this ordering with
  // Gate 2 forced on and a licences client that throws.
  await assertTenantActive(req, user);
  await licenseCallerTenant(req, user);
  return user;
}

export async function requireRole(req: Request, role: string): Promise<User> {
  if (_authOverridesForTests?.requireRole) {
    return _authOverridesForTests.requireRole(req, role);
  }
  const user = await validateAuth(req);
  if (!user.roles.includes(role)) {
    throw new UnauthorizedError(`Role '${role}' required`);
  }
  return user;
}
