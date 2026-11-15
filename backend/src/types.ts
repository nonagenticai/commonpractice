// src/types.ts — shared API types.

export type UserRole = 'employee' | 'platform';

/** A member's role inside their CP workspace (`users.tenant_role`). CP-owned — never a realm role. */
export type TenantRole = 'member' | 'developer' | 'tenant_admin';

export interface User {
  id: string;
  email: string;
  name: string;
  /** Authorization roles. From Keycloak only `super_admin` (and the fr bridge SA role) is kept; after
   *  `hydrateCpIdentity` (services/cp-identity.ts) the CP `tenantRole` is appended when the user
   *  has a home tenant, so the role guards in middleware/admin-guards.ts read one list. */
  roles: string[];
  /** The user's single home tenant, from CP's own `users.tenant_id` (set by `hydrateCpIdentity`).
   *  Undefined = no workspace. Never read from the token, never fabricated from `sub`. */
  tenantId?: string;
  /** The token's `email_verified` claim. */
  emailVerified?: boolean;
  /** The Keycloak Identity Provider alias a brokered login came through (`idp_alias` claim). */
  idpAlias?: string;
  /** The token's `azp` (authorized party — the Keycloak client it was issued to). */
  azp?: string;
  /** The token's `aud`, always as a list (a single-string claim becomes a one-item list). */
  aud?: string[];
  /** The VERIFIED token issuer (one of KEYCLOAK_TRUSTED_ISSUERS). Unset for AUTH_BYPASS / test fakes. */
  issuer?: string;
  /** The Keycloak realm of `issuer`. */
  realm?: string;
  /** The CP role in `tenantId`; set only when `tenantId` is. */
  tenantRole?: TenantRole;
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}
