// src/lib/utils/auth-guards.ts — client-side mirrors of the backend guards
// (middleware/admin-guards.ts), used by the `(platform)` / `(tenant)` route-group layouts so a
// member never sees an admin screen flash before the API denies it. The server is always the real
// authority.
//
// The argument is the GET /api/me user (`auth.user`), never the Keycloak token: CP owns tenant and
// role, and the token carries no claim the SPA may gate on.
import { error } from '@sveltejs/kit';

export interface RoleBearer {
	roles: string[];
	/** /api/me's explicit flag; `roles` carries `super_admin` too. */
	isSuperAdmin?: boolean;
}

export function hasSuperAdmin(user: RoleBearer | null | undefined): boolean {
	return user?.isSuperAdmin === true || (user?.roles.includes('super_admin') ?? false);
}

/** True for a tenant_admin OR a super_admin (composite). */
export function hasTenantAdmin(user: RoleBearer | null | undefined): boolean {
	return hasSuperAdmin(user) || (user?.roles.includes('tenant_admin') ?? false);
}

/** Platform scope: throws 403 unless the user holds super_admin. */
export function requireSuperAdmin(user: RoleBearer | null | undefined): void {
	if (!hasSuperAdmin(user)) {
		throw error(403, 'Super admin role required');
	}
}

/** Tenant scope: passes for tenant_admin or super_admin (composite). */
export function requireTenantAdmin(user: RoleBearer | null | undefined): void {
	if (!hasTenantAdmin(user)) {
		throw error(403, 'Tenant admin role required');
	}
}

/** Outer admin gate (either tenancy admin role). */
export function requireAnyAdmin(user: RoleBearer | null | undefined): void {
	if (!hasTenantAdmin(user)) {
		throw error(403, 'Admin role required');
	}
}
