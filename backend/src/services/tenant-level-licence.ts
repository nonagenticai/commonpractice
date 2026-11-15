// src/services/tenant-level-licence.ts — the ONE definition of "this tenant holds its tenant-level
// licence for this app" (ruling 2026-09-28).
//
// A tenant's bundle holds ONE licence per (tenant, app) on the service subject
// `svc:<tenant-uuid>:<app>`. Two callers ask this question and must never disagree:
//   - Gate 2 / `GET /api/license/status` (lib/license-status.ts `tenantLevelLicense`) — admit?
//   - onboarding (services/license-provisioning.ts `tenantHoldsTenantLevelLicence`) — skip the mint?
// Both go through `fetchTenantLevelLicence` + `isValidTenantLevelLicence` below.
//
// ⚠️ `GET /licenses/active` never denies on a subject selector, and WITHOUT one it returns the
// tenant's first active licence of ANY holder — including a member licence CP minted for a
// colleague. So the lookup ALWAYS sends `subject_id=svc:<tenant>:<app>` and the predicate ALWAYS
// requires `subject_match === true`; "a licence came back" is never an entitlement.
import { config } from '../config';
import type { LicenseIntrospectResponse } from './license-client';
import { licensesAdmin } from './licenses-admin';

/**
 * The tenant id as the licences service spells it: `str(uuid.UUID(x))` — lowercase, hyphenated.
 * CP ids are Postgres UUIDs (already canonical), but the svc subject is matched as a STRING on the
 * other side, so an upper-case or un-hyphenated id would silently select nothing.
 */
export function canonicalTenantId(tenantId: string): string {
  let s = tenantId.trim().toLowerCase();
  if (s.startsWith('urn:uuid:')) s = s.slice('urn:uuid:'.length);
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1);
  if (/^[0-9a-f]{32}$/.test(s)) {
    s = `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
  return s;
}

/**
 * The holder of a tenant's bundle licence for THIS app: `svc:<tenant-uuid>:<app>` (licences
 * `SERVICE_SUBJECT_PREFIX`, models.py).
 */
export function tenantServiceSubject(tenantId: string): string {
  return `svc:${canonicalTenantId(tenantId)}:${config.license.appKey}`;
}

/**
 * Is `resp` the tenant's OWN tenant-level licence for this app, valid at `now`? The four assertions
 * Gate 2 makes on an introspected token (active, unexpired, app key, tenant) PLUS
 * `subject_match === true` — the selector resolved to the svc holder and THAT licence came back,
 * not the service's fallback pick (which may be another member's licence).
 */
export function isValidTenantLevelLicence(
  resp: LicenseIntrospectResponse | null | undefined,
  tenantId: string,
  now: Date,
): resp is LicenseIntrospectResponse {
  if (!resp || resp.active !== true) return false;
  if (resp.subject_match !== true) return false;
  if (resp.expires_at) {
    const exp = Date.parse(resp.expires_at);
    if (Number.isFinite(exp) && exp <= now.getTime()) return false;
  }
  if (resp.app?.key !== config.license.appKey) return false;
  return (
    typeof resp.tenant_id === 'string' &&
    canonicalTenantId(resp.tenant_id) === canonicalTenantId(tenantId)
  );
}

/**
 * Ask the licences service for the tenant's svc-held licence (raw — callers validate with
 * `isValidTenantLevelLicence`). `null` when the service reports none, or when the configured client
 * cannot do the lookup (a test fake predating it): "cannot tell" is never an entitlement.
 * THROWS on an outage (LicensesAdminError); each caller decides what that means.
 */
export async function fetchTenantLevelLicence(
  tenantId: string,
): Promise<LicenseIntrospectResponse | null> {
  const client = licensesAdmin();
  if (typeof client.getActiveLicense !== 'function') return null;
  return client.getActiveLicense(canonicalTenantId(tenantId), {
    subjectId: tenantServiceSubject(tenantId),
  });
}
