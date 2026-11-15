// src/middleware/admin-guards.ts — the tenant/platform authorization gates.
//
// Keycloak authenticates; CP authorizes. `user.tenantId` / `user.tenantRole` come from CP's own
// `users` row (services/cp-identity.ts), and `user.roles` = `super_admin` (the only realm role CP
// honours) + the CP tenant role. Two live gates:
//   • `requireSuperAdmin` — platform / cross-tenant operations.
//   • `requireTenantAdmin` — the single tenant-scoped gate: a tenant_admin is authorized for their
//     own home tenant; a super_admin may act into ANY provisioned tenant via the
//     `X-Active-Tenant-Id` scope-switch (audited).
import { eq } from 'drizzle-orm';
import { db as defaultDb, tenants, refreshTenantGuc } from '../db/client';
import { authenticateWithoutLicense, validateAuth } from './auth';
import { recordAudit } from '../host/audit-service';
import { forbidden, unprocessable, type HttpError } from '../utils/http';
import { UnauthorizedError, type User } from '../types';

/** Roles, strongest → weakest. `super_admin` (realm) passes every tenant_admin gate too.
 *  `tenant_admin` / `developer` / `member` are CP tenant roles (`users.tenant_role`);
 *  `developer` is the tenant block/ontology author role: a tenant_admin / super_admin passes
 *  every developer gate too. */
export const SUPER_ADMIN = 'super_admin' as const;
export const TENANT_ADMIN = 'tenant_admin' as const;
export const DEVELOPER = 'developer' as const;
export const MEMBER = 'member' as const;

export function isSuperAdmin(user: User): boolean {
  return user.roles.includes(SUPER_ADMIN);
}

/** True for a tenant_admin OR a super_admin (composite). */
export function hasTenantAdmin(user: User): boolean {
  return isSuperAdmin(user) || user.roles.includes(TENANT_ADMIN);
}

/** True for a `developer`, OR an admin (tenant_admin / super_admin) — admins may
 *  author tenant blocks/ontology/test-data too. The write-gate for tenant authoring. */
export function isDeveloper(user: User): boolean {
  return hasTenantAdmin(user) || user.roles.includes(DEVELOPER);
}

/**
 * The caller's home tenant (CP `users.tenant_id`, hydrated onto `user.tenantId`).
 * Fail-closed: no home tenant → 403 `no_workspace`, and we NEVER fabricate `tenant_id = sub` — a
 * ghost UUID would still satisfy an RLS policy and silently scope the user to a phantom tenant.
 *
 * ⚠️ CANONICALISED — see `canonicalTenantId`.
 */
export function effectiveHomeTenant(user: User): string {
  if (!user.tenantId) {
    throw forbidden('no_workspace', 'You are not a member of any Common Practice workspace');
  }
  return canonicalTenantId(user.tenantId);
}

/**
 * Require the caller to hold `super_admin` (platform / cross-tenant scope).
 *
 * ⚠️ THE `authenticateWithoutLicense` CALL BELOW IS THE ENTIRE PLATFORM LICENCE EXEMPTION.
 * Every other guard in this file uses `validateAuth`, which additionally runs Gate 2 against the
 * caller's effective tenant. A platform route's rows are global (pipeline_items / audit_log sit
 * outside RLS by design, migration 0028) and its only authority is this role — there is no tenant
 * whose licence could be checked. Switching this one line back to `validateAuth` makes the whole
 * operator console 402 the moment an operator acts into an unlicensed tenant, which is exactly the
 * bug WS-2 fixed. Nothing in a route file makes that visible, hence this comment.
 */
export async function requireSuperAdmin(req: Request): Promise<User> {
  const user = await authenticateWithoutLicense(req);
  if (!isSuperAdmin(user)) {
    throw forbidden('super_admin_required', 'Super admin role required');
  }
  return user;
}

/** Outer admin gate: any of `super_admin` / `tenant_admin`. */
export async function requireAnyAdmin(req: Request): Promise<User> {
  const user = await validateAuth(req);
  if (!hasTenantAdmin(user)) {
    throw forbidden('admin_required', 'Admin role required');
  }
  return user;
}

/**
 * Fail-closed tenant existence check (specra `_require_tenant_exists`). A target tenant with no
 * provisioned `tenants` row → 403, NOT an auto-created tenant. Tenants are born from seed / a
 * super_admin endpoint only.
 */
export async function requireTenantExists(
  tenantId: string,
  db: typeof defaultDb = defaultDb,
): Promise<void> {
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) {
    throw forbidden(
      'tenant_not_provisioned',
      'Target tenant is not provisioned; access denied',
    );
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one spelling of a tenant id that leaves this module.
 *
 * ⛔ WHY THIS EXISTS. A tenant id reaches the request from the `X-Active-Tenant-Id` header,
 * which is not case-normalised at the edge: `UUID_RE` carries
 * `/i` on purpose (RFC 9562 §4 says a UUID is case-insensitive on input), so `A1B2…` is a valid
 * header and was passed through verbatim. Everywhere that value meets a `uuid` COLUMN that is
 * harmless: `eq(tenants.id, …)` and the RLS `app_current_tenant_uuid()` both normalise for free.
 * The harm is everywhere it meets TEXT. `routes/ontology.ts` stamps this string into
 * `audit_log.metadata->>'tenantId'` (jsonb text), and `ontology/ontology-changes.ts` has to compare
 * it as text; measured, an uppercase header made the reader's OWN "Recent changes" render empty
 * with the disclosure reporting nothing hidden. The panel's query is now case-insensitive in its
 * own right (defence in depth — `metadata` holds history written before this function existed);
 * this is the other half, so no NEW row is written in a stray case.
 *
 * ⚠️ ONLY UUIDs ARE TOUCHED. Lower-casing an id that is not a UUID would be this function
 * inventing a different tenant; it is returned verbatim and fails where it always did (the `uuid`
 * column).
 */
export function canonicalTenantId(tenantId: string): string {
  return UUID_RE.test(tenantId) ? tenantId.toLowerCase() : tenantId;
}

/**
 * Parse the `X-Active-Tenant-Id` scope-switch header (spec 6.1 semantics):
 *  - non-super_admin → header is SILENTLY IGNORED (probe-resistance — never 400/422,
 *    so a tenant_admin can't tell whether the header is honoured).
 *  - super_admin + malformed UUID → 422 `INVALID_ACTIVE_TENANT_HEADER` (only
 *    super_admins get the diagnostic, so header semantics don't leak).
 *  - super_admin + valid → that UUID, CANONICALISED (see `canonicalTenantId`); absent → null.
 */
export function readActiveTenantHeader(req: Request, user: User): string | null {
  const raw = req.headers.get('X-Active-Tenant-Id');
  if (!raw) return null;
  if (!isSuperAdmin(user)) return null;
  if (!UUID_RE.test(raw)) {
    throw unprocessable(
      'INVALID_ACTIVE_TENANT_HEADER',
      'X-Active-Tenant-Id is not a valid tenant id',
    );
  }
  return canonicalTenantId(raw);
}

export interface TenantScopeContext {
  user: User;
  /** The tenant this request is authorized to act on. */
  effectiveTenantId: string;
  /** Whether the caller holds super_admin (acted via the platform role). */
  isSuperAdmin: boolean;
  /** True when a super_admin acted into a tenant other than their own (audited). */
  scopeSwitched: boolean;
}

/**
 * The single tenant-scoped admin gate. Require the caller to be a `tenant_admin` (or
 * `super_admin`, composite) and resolve the effective tenant.
 *
 * Target authority order: explicit `pathTenantId` > `X-Active-Tenant-Id` header >
 * the caller's home tenant. A path/header or path/home mismatch is a generic 403 (the path is
 * authoritative; no response reveals the caller's real tenant).
 *
 * - **tenant_admin** (non-super): authorized for their home tenant only (fail-closed via
 *   `effectiveHomeTenant`); the header is silently ignored (probe-resistance);
 *   a `pathTenantId` other than their home → 403.
 * - **super_admin**: cross-tenant allowed; the effective tenant must be provisioned
 *   (`requireTenantExists`); acting into a tenant other than their home emits
 *   `audit.scope_switch`.
 */
export async function requireTenantAdmin(
  req: Request,
  opts: { pathTenantId?: string } = {},
): Promise<TenantScopeContext> {
  const user = await validateAuth(req);
  if (!hasTenantAdmin(user)) {
    throw forbidden('tenant_admin_required', 'Tenant admin role required');
  }
  return resolveTenantScope(req, user, opts);
}

/**
 * Tenant-scoped author gate. Require the caller to be a `developer` (or an admin —
 * `tenant_admin` / `super_admin`, which pass developer gates too) and resolve the
 * effective tenant exactly as `requireTenantAdmin` does (home / path / super_admin
 * scope-switch). The write-gate for tenant ontology, test-data, and block authoring.
 */
export async function requireDeveloper(
  req: Request,
  opts: { pathTenantId?: string } = {},
): Promise<TenantScopeContext> {
  const user = await validateAuth(req);
  if (!isDeveloper(user)) {
    throw forbidden('developer_required', 'Developer role required');
  }
  return resolveTenantScope(req, user, opts);
}

export interface BlockAuthorContext {
  user: User;
  /** 'global' = platform-shipped (tenant_id NULL, written via runAsSystem); 'tenant' = tenant-authored. */
  scope: 'global' | 'tenant';
  /** The tenant to stamp on a tenant-scoped block; null for a global block. */
  tenantId: string | null;
}

/**
 * Authoring gate for CREATING a building block (Phase 2 dual ownership). The caller must be a
 * `developer` (or admin, composite). Scope:
 *  - **super_admin** → `'global'` by default (platform-shipped, `tenant_id` NULL, written via
 *    `runAsSystem`), preserving today's platform authoring. May opt into a tenant block with
 *    `?scope=tenant` (+ `X-Active-Tenant-Id` to target a specific tenant).
 *  - **developer / tenant_admin** → always `'tenant'`, stamped with their effective tenant.
 * Mutations on an EXISTING block derive their scope from the block's own `tenant_id` (routes/blocks.ts),
 * not from this gate.
 */
export async function requireBlockAuthor(req: Request): Promise<BlockAuthorContext> {
  const user = await validateAuth(req);
  if (!isDeveloper(user)) {
    throw forbidden('developer_required', 'Developer role required');
  }
  const requested = new URL(req.url).searchParams.get('scope');
  if (isSuperAdmin(user) && requested !== 'tenant') {
    return { user, scope: 'global', tenantId: null };
  }
  // Tenant scope: resolve + bind the RLS GUC exactly like the other tenant gates.
  const ctx = await resolveTenantScope(req, user);
  return { user: ctx.user, scope: 'tenant', tenantId: ctx.effectiveTenantId };
}

/**
 * Shared tenant-scope resolution for the tenant-scoped gates (after the role check).
 * Target authority order: explicit `pathTenantId` > `X-Active-Tenant-Id` header >
 * the caller's home tenant. Sets the authoritative RLS GUC and audits a super_admin scope-switch.
 */
async function resolveTenantScope(
  req: Request,
  user: User,
  opts: { pathTenantId?: string } = {},
): Promise<TenantScopeContext> {
  const header = readActiveTenantHeader(req, user);
  const { pathTenantId } = opts;

  if (pathTenantId && header && pathTenantId !== header) {
    throw forbidden('tenant_scope_mismatch', 'Tenant scope mismatch');
  }

  if (isSuperAdmin(user)) {
    const own = user.tenantId ?? null;
    const effectiveTenantId = pathTenantId ?? header ?? own;
    if (!effectiveTenantId) {
      // super_admin with no home tenant and no explicit target — can't resolve.
      throw forbidden(
        'no_workspace',
        'No target tenant for super_admin (provide a path/header tenant)',
      );
    }
    await requireTenantExists(effectiveTenantId);
    await refreshTenantGuc(effectiveTenantId); // authoritative RLS scope (honours scope-switch)
    const scopeSwitched = effectiveTenantId !== own;
    if (scopeSwitched) {
      const url = new URL(req.url);
      await recordAudit({
        actorId: user.id,
        action: 'scope_switch',
        category: 'auth',
        targetType: 'tenant',
        targetId: effectiveTenantId,
        result: `${req.method} ${url.pathname}`,
        resultTone: 'warn',
        metadata: { ownTenant: own, method: req.method, path: url.pathname },
      });
    }
    return { user, effectiveTenantId, isSuperAdmin: true, scopeSwitched };
  }

  // Normal tenant_admin / developer: their home tenant is the sole authority.
  const ownTenant = effectiveHomeTenant(user); // fail-closed: 403 no_workspace
  if (pathTenantId && pathTenantId !== ownTenant) {
    throw forbidden('tenant_scope_mismatch', 'Tenant scope mismatch');
  }
  const effectiveTenantId = pathTenantId ?? ownTenant;
  await refreshTenantGuc(effectiveTenantId); // authoritative RLS scope for this request
  return {
    user,
    effectiveTenantId,
    isSuperAdmin: false,
    scopeSwitched: false,
  };
}

// Re-exported so callers can narrow on these without importing from two modules.
export type { HttpError };
export { UnauthorizedError };
