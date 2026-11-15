// src/services/tenant-terms.ts — a tenant's commercial terms (platform fee, seat fee, markup %), owned
// by billing-service and stated by CP at tenant create and on "edit terms".
//
// Billing is the system of record: CP keeps NO copy (a copy would drift from what is invoiced). The
// write is `PUT /api/config/tenants/{id}/commercial-terms` (services/billing-admin.ts explains why
// not the older `POST …/terms`). That PUT is idempotent on value, and this module additionally reads
// first and skips the write when billing already states exactly these terms — so a replayed create or
// a re-saved form re-dates nothing and leaves no audit noise.
import { z } from 'zod';
import {
  billingAdmin,
  billingAdminConfigured,
  billingMethod,
  BillingAdminError,
  type BillingTermsView,
  type TenantTerms,
} from './billing-admin';
import { HttpError } from '../utils/http';
import { log } from '../host/logger';

/** USD, whole cents; a percent (20 = 20 %). Any of the three may be 0. */
const money = z.number().min(0).max(10_000_000).multipleOf(0.01);
export const tenantTermsSchema = z
  .object({
    platformFeeUsd: money,
    seatFeeUsd: money,
    markupPct: z.number().min(0).max(1000).multipleOf(0.01),
  })
  .strict();

export type TermsWriteOutcome =
  | { status: 'written'; terms: BillingTermsView }
  | { status: 'unchanged'; terms: BillingTermsView }
  | { status: 'skipped_unconfigured' };

function sameTerms(a: TenantTerms, b: TenantTerms): boolean {
  const eq = (x: number, y: number) => Math.abs(x - y) < 0.005;
  return eq(a.platformFeeUsd, b.platformFeeUsd) && eq(a.seatFeeUsd, b.seatFeeUsd) && eq(a.markupPct, b.markupPct);
}

function billingUnavailable(err: unknown, what: string): HttpError {
  const upstreamStatus = err instanceof BillingAdminError ? err.status : undefined;
  const upstreamDetail = err instanceof BillingAdminError ? err.detail : undefined;
  return new HttpError(
    502,
    'billing_unavailable',
    `${what}: ${err instanceof Error ? err.message : String(err)}`,
    upstreamStatus !== undefined
      ? { upstreamStatus, ...(upstreamDetail ? { upstreamDetail } : {}) }
      : undefined,
  );
}

/** Read the tenant's terms from billing; `null` when no billing service is configured. */
export async function readTenantTerms(tenantId: string): Promise<BillingTermsView | null> {
  if (!billingAdminConfigured()) return null;
  try {
    return await billingMethod(billingAdmin(), 'commercialTerms')(tenantId);
  } catch (err) {
    throw billingUnavailable(err, `reading the commercial terms of ${tenantId} failed`);
  }
}

/**
 * State the tenant's terms in billing — at most ONE write, and none when billing already says this.
 * Throws `billing_unavailable` (502) on any billing failure; the caller decides whether that fails
 * the whole operation (edit) or is reported beside a tenant that stands (create).
 */
export async function writeTenantTerms(tenantId: string, terms: TenantTerms): Promise<TermsWriteOutcome> {
  if (!billingAdminConfigured()) return { status: 'skipped_unconfigured' };
  const client = billingAdmin();
  let current: BillingTermsView;
  try {
    current = await billingMethod(client, 'commercialTerms')(tenantId);
  } catch (err) {
    throw billingUnavailable(err, `reading the commercial terms of ${tenantId} failed`);
  }
  if (current.fullyConfigured && current.billingMode === 'byo_markup_only' && sameTerms(current, terms)) {
    return { status: 'unchanged', terms: current };
  }
  try {
    const written = await billingMethod(client, 'putCommercialTerms')(tenantId, terms);
    log.info('tenant_terms_written', { tenantId, changed: written.changed });
    return { status: 'written', terms: written };
  } catch (err) {
    throw billingUnavailable(err, `writing the commercial terms of ${tenantId} failed`);
  }
}
