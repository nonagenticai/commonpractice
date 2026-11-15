// src/middleware/tenant.ts — tenant resolution.
//
// Tenancy is the caller's CP home tenant (`users.tenant_id`, hydrated onto `user.tenantId` by
// services/cp-identity.ts), fail-closed — there is no switcher and no personal-tenant fallback.
// `resolveTenant` resolves the caller + their home tenant + their access level; it is the shape
// most non-admin routes consume (`.tenantId`). The tenant-scoped ADMIN gate lives in
// `middleware/admin-guards.ts` (`requireTenantAdmin`, which also carries the super_admin
// `X-Active-Tenant-Id` scope-switch).
import { eq } from 'drizzle-orm';
import { db, users, refreshTenantGuc } from '../db/client';
import { authenticateWithoutLicense, validateAuth } from './auth';
import { ensureUser } from '../services/user-service';
import {
  canonicalTenantId,
  effectiveHomeTenant,
  hasTenantAdmin,
  isSuperAdmin,
  readActiveTenantHeader,
  requireTenantExists,
} from './admin-guards';
import type { User } from '../types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase D (RLS): best-effort, NEVER-throwing resolution of the request's effective tenant, used by
 * the server wrapper to PRE-SET `app.current_tenant` before the route runs. Mirrors the guards'
 * precedence enough to be a safe fail-closed default (super_admin's valid `X-Active-Tenant-Id` >
 * the home tenant); the AUTHORITATIVE value (path tenant, validated scope-switch) is set by
 * resolveTenant / requireTenantAdmin via refreshTenantGuc. Returns null when no tenant is derivable
 * (unauthenticated / no workspace) — the route then runs on the pool with no GUC (fail-closed under RLS).
 *
 * Uses the RAW verifier (`authenticateWithoutLicense`), NOT `validateAuth`: this is a best-effort
 * peek that must never itself deny. It feeds the server's RLS pre-set for EVERY request (including
 * platform ones) and it backs `GET /api/license/status` — licence-gating it would make the "your
 * workspace has no licence" screen 402 on the very call that tells it so.
 */
export async function peekEffectiveTenant(req: Request): Promise<string | null> {
  try {
    const user = await authenticateWithoutLicense(req);
    const header = req.headers.get('X-Active-Tenant-Id');
    // Canonicalised for the same reason the guards do it — this value is the request's FIRST
    // spelling of the tenant and it must not differ from the authoritative one by case alone.
    if (isSuperAdmin(user) && header && UUID_RE.test(header)) return canonicalTenantId(header);
    return user.tenantId ? canonicalTenantId(user.tenantId) : null;
  } catch {
    return null;
  }
}

/**
 * The MEMBER's user id, but ONLY when the request is judged against their own home tenant — the same
 * exemption `licenseCallerTenant` (middleware/license-gate.ts) applies, and for the same two reasons.
 *
 * ⛔ NOT `peekLicenseCaller`, which is what this was first called. "Caller identity" in this estate
 * means the KEYCLOAK SERVICE-ACCOUNT axis (the calling service and its roles, carried as
 * `caller_client_id` = the verified `azp`), held deliberately apart from the licence axis. A licence
 * is about a SUBJECT. Naming the human "caller" inside licence code is the exact conflation those
 * two axes exist to prevent.
 *
 * ⛔ A SCOPE-SWITCHED OPERATOR MUST RESOLVE TO `null` HERE. A super_admin acting into a customer's
 * tenant holds no `member_entitlements` row there — they are not an employee of that company.
 * Returning their id would make `GET /api/license/status` answer `no_seat` for every tenant an
 * operator scopes into, i.e. raise a seat wall on the platform staff whose job is to fix seats.
 * (Minting them one instead would be worse: billing counts a seat as a licences-service
 * `human_subjects` entry, so platform staff would land on the customer's invoice.)
 *
 * Best-effort and never throws, exactly like `peekEffectiveTenant` — this backs a gate-EXEMPT
 * endpoint and must not become the thing that denies it.
 */
export async function peekLicensedMember(
  req: Request,
  tenantId: string | null,
): Promise<string | null> {
  if (!tenantId) return null;
  try {
    const user = await authenticateWithoutLicense(req);
    const header = req.headers.get('X-Active-Tenant-Id');
    const scopeSwitched = isSuperAdmin(user) && header && UUID_RE.test(header);
    if (scopeSwitched) return null;
    const home = user.tenantId ? canonicalTenantId(user.tenantId) : null;
    return home && home === tenantId ? user.id : null;
  } catch {
    return null;
  }
}

/** Binary access level for content routes: admin (tenant_admin / super_admin) or not. The full
 *  CP role is `user.tenantRole`. */
export type TenantAccessRole = 'tenant_admin' | 'member';

/** The user's single home tenant (`users.tenant_id`). Used by the few code paths that hold only a
 *  userId. The request path reads the same column through `hydrateCpIdentity`. null if unset.
 *
 *  ⛔ THE COPILOT NO LONGER CALLS THIS, AND THAT REMOVAL IS THE POINT — do not reintroduce it as a
 *  fallback. `routes/agent.ts` and the agent-token branch of `routes/mcp.ts` used to feed this
 *  straight into `withTenantDb`, i.e. into the RLS GUC, which is exactly how the copilot came to
 *  answer about a different workspace than the browser (measured in prod: one user's `chat_sessions`
 *  and `chat_messages` split across two tenants). They now read the `tid` claim baked into the
 *  agent token at mint, and fail closed when it is absent. The remaining callers are the ones with
 *  no claim to read at all:
 *    • `routes/mcp.ts` — the LAN/dev `AUTH_BYPASS` branch only, for a fixed synthetic user;
 *    • `blocks/test-runner.ts` — the block author's ORG, a different axis from request tenancy;
 *    • `routes/tenant-users.ts` / `services/user-service.ts` — administering the column itself. */
export async function homeTenantOf(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ tenantId: users.tenant_id })
    .from(users)
    .where(eq(users.id, userId));
  return row?.tenantId ?? null;
}

export interface TenantContext {
  user: User;
  /** The tenant this request acts on: the caller's home tenant, or a super_admin's acting tenant. */
  tenantId: string;
  /** Binary access level (see `TenantAccessRole`). */
  role: TenantAccessRole;
}

/**
 * Resolve the caller + the tenant this request acts on + their access level.
 * Idempotently upserts the `users` row (`ensureUser`). Throws 401 (via validateAuth) if
 * unauthenticated, 403 `user_offboarded` for a tombstoned account, or 403 `no_workspace` when the
 * caller has no home tenant (and, for a super_admin, no acting tenant).
 */
export async function resolveTenant(req: Request): Promise<TenantContext> {
  const user = await validateAuth(req);
  await ensureUser(user); // upsert the identity row; never seats anyone
  // Honour the super_admin `X-Active-Tenant-Id` scope-switch so content routes act under the tenant
  // the session is "acting as" — for BOTH reads and writes. Without this, `resolveTenant` was
  // home-only while the server wrapper pre-set the RLS GUC from the header (and reads that skip
  // `resolveTenant` honoured it): a super_admin acting-as another tenant wrote content into their
  // HOME tenant while reads were scoped to the acting tenant → a just-created row 404'd and content
  // leaked cross-tenant. Precedence + validation mirror `requireTenantAdmin` / `peekEffectiveTenant`
  // (super_admin valid header > home; the header is null for non-super callers — probe-resistant).
  const active = readActiveTenantHeader(req, user);
  let tenantId: string;
  if (active) {
    await requireTenantExists(active); // fail-closed: a bogus acting tenant → 403, not a phantom scope
    tenantId = active;
  } else {
    tenantId = effectiveHomeTenant(user); // fail-closed: 403 no_workspace
  }
  await refreshTenantGuc(tenantId); // authoritative RLS scope for this request
  const role: TenantAccessRole = hasTenantAdmin(user) ? 'tenant_admin' : 'member';
  return { user, tenantId, role };
}
