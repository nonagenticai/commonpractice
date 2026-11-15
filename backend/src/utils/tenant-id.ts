// src/utils/tenant-id.ts — the ONE canonical form of a tenant id, and the only safe way to
// compare two of them.
//
// ⛔ WHY THIS FILE EXISTS: `z.string().uuid()` IS CASE-INSENSITIVE, AND `uuid` COLUMNS ARE NOT.
// Postgres normalises every `uuid` value to lower case on the way in. Keycloak stores the
// `tenant_id` user attribute as an OPAQUE STRING and normalises nothing, and the JWT claim is that
// string verbatim. So a route that writes one raw body value to BOTH sides ends up with a claim of
// `…-0000000C2B02` and a column of `…-0000000c2b02` — two spellings of the same workspace that no
// `!==` can reconcile.
//
// That is not theoretical: `PATCH /api/admin/users/:userId/tenant` accepted an upper-case
// `tenantId`, wrote it to Keycloak and to `users.tenant_id`, and from then on `ensureUser`'s drift
// detector (`services/user-service.ts`) read the two back as DIFFERENT on every single request —
// bumping `home_tenant_mismatch_total` forever and writing an hourly `user.home_tenant_mismatch`
// audit row about a user who was correctly homed. The counter is deliberately un-throttled because
// it backs an alert, so the alert became permanently non-zero: the route manufactured the exact
// divergence it exists to end.
//
// Two halves, and BOTH are needed:
//   • `tenantIdSchema` — canonicalise at the body boundary, so the two sides are written the same.
//   • `sameTenantId`   — canonicalise at the comparison, because the claim comes from Keycloak and
//                        may predate the fix (or come from an IdP mapper CP does not control).
import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this string a syntactically valid uuid? Guards a `where(eq(uuidColumn, x))` against a
 *  22P02 `invalid input syntax for type uuid` on attacker- or IdP-supplied text. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** The canonical spelling of a tenant id: trimmed and lower-cased, i.e. what a `uuid` column
 *  stores. Never throws — a non-uuid string is canonicalised too, so it can be COMPARED safely
 *  even where it cannot be queried. */
export function canonicalTenantId(value: string): string;
export function canonicalTenantId(value: string | null | undefined): string | null;
export function canonicalTenantId(value: string | null | undefined): string | null {
  if (value == null) return null;
  return value.trim().toLowerCase();
}

/**
 * Do these two tenant ids name the same workspace? Use this instead of `!==` ANYWHERE one side
 * could be a JWT claim / Keycloak attribute and the other a `uuid` column — see the file header.
 * Two nulls are NOT the same workspace: an absent claim is not a match, it is no answer.
 */
export function sameTenantId(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a == null || b == null) return false;
  return canonicalTenantId(a) === canonicalTenantId(b);
}

/**
 * `z.string().uuid()` that also CANONICALISES. Every request body carrying a tenant id that will
 * be written to Keycloak or to a `uuid` column must use this, not the bare `.uuid()` — the bare
 * one validates the shape and then hands the raw spelling straight through.
 */
export const tenantIdSchema = z
  // NOT `.uuid()`: zod 4's is RFC-strict (version nibble 1-8) and refuses the prod demo tenant
  // `00000000-0000-0000-0000-000000000001`. `guid()` is the 8-4-4-4-12 hex shape Postgres stores.
  .guid()
  .transform((v) => canonicalTenantId(v));
