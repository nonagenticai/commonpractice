// src/services/fr-license.ts — Phase 5 / 5D: Gate 2 for the fr internal bridge (Spec Part 5.1).
//
// Forwarding a solution to fr (Target B) is double-gated. Gate 1 is CP's own auth + active
// `commonpractice` license (Phase 4 — already enforced on the route). Gate 2, here, asserts the
// tenant separately holds an active fr-family entitlement by INTROSPECTING the fr license token the
// tenant stored on the connector: the token must be active, its app.key must be one the bridge
// accepts (fr/kanban/n8n), and it must belong to the forwarding tenant. A failure is one of FOUR
// distinct `fr_license_*` codes the route maps to 402 (vs the 422 config / 422 egress gates), and
// it fires in the precheck BEFORE any ledger row is written.
//
// Reuses the existing licenseClient() introspection singleton (services/license-client.ts): the
// `POST /license/introspect` endpoint validates ANY app's token (the app.key comes back IN the
// response), so the same client + its 5-min cache + its `__setLicenseClientForTests` seam serve this
// gate — a second client would duplicate both for no gain. FAIL-CLOSED: an introspect throw (an
// unreachable licenses service) becomes an `fr_license_unavailable` denial, never a pass.
import { config } from '../config';
import { licenseClient, LicenseClientError } from './license-client';

/** Why an fr Gate-2 check failed. Each maps to its OWN 402 code — see `FR_LICENSE_CODE`. */
export type FrLicenseReason =
  | 'inactive'
  | 'app_mismatch'
  | 'tenant_mismatch'
  | 'introspect_unavailable';

/**
 * One machine code per reason — the whole point of this map.
 *
 * ⛔ WHY FOUR CODES AND NOT ONE CODE + A `reason` FIELD. The four reasons already had four distinct
 * ENGLISH sentences and a single code `fr_license_required`, so the reason was carried only in prose
 * — and prose is exactly what the browser cannot localize. A `reason` field cannot fix it here,
 * because it would be DROPPED TWICE on the way to the screen:
 *   1. `paymentRequired(code, message)` in `../utils/http.ts` takes TWO parameters. There is no
 *      third slot for a `details` bag on the 402 helper (`unprocessable` has one; this does not).
 *   2. `routes/delivery.ts:256` — the Test button's catch — answers **HTTP 200** and forwards
 *      exactly `{ ok:false, code: e.code, detail: e.message }`. A `reason` has no field to ride in.
 * Widening both would be the same bug class PR #309 spent a session removing. Four codes need ZERO
 * new plumbing: `code` is already the field both paths forward and both frontend switches key on.
 *
 * ⛔ AND THEY ARE READ THROUGH `err.code`, NEVER WRITTEN AS LITERALS AT A `paymentRequired(...)`
 * CALL SITE — BUT NOT FOR THE REASON IT LOOKS LIKE. Writing them as literals would NOT by itself
 * blank the SPA: `isLicenseBlockResponse` (frontend/src/lib/stores/licenseGate.svelte.ts:55-72) is
 * an EXACT-match test against `LICENSE_BLOCK_CODES`, a five-member set these four are not in, so a
 * 402 carrying one of them never trips the block interceptor.
 *
 * What a literal DOES do is turn `error-message.backend-contract.test.ts:212` RED — it scrapes
 * `paymentRequired('<literal>')` out of backend source and asserts every hit is in
 * `LICENSE_BLOCK_CODES`. THE TRAP IS THE REPAIR, NOT THE LITERAL: the obvious-looking way to green
 * that test is to add the new code to `LICENSE_BLOCK_CODES`, and THAT is what would put the whole
 * workspace behind the renewal wall because ONE delivery connector is misconfigured.
 *
 * These four are connector MISCONFIGURATION, not an absent workspace licence — the same distinction
 * `licenseGate.svelte.ts:50-53` already records for `license_app_mismatch` / `license_tenant_mismatch`,
 * which are 403 for exactly this reason and are deliberately kept out of the block set.
 *
 * Keeping `paymentRequired(err.code, …)` dynamic keeps the scraper blind to them, which is a genuine
 * hole in that scraper — so the decision is pinned by `frontend/src/lib/api/fr-license-codes.guard.test.ts` (which
 * asserts the absence AND names this consequence) rather than left to the next reader's memory.
 */
const FR_LICENSE_CODE: Record<FrLicenseReason, string> = {
  inactive: 'fr_license_inactive',
  app_mismatch: 'fr_license_app_mismatch',
  tenant_mismatch: 'fr_license_tenant_mismatch',
  introspect_unavailable: 'fr_license_unavailable',
};

/** Thrown when the tenant's fr license token is missing/inactive/wrong-app/wrong-tenant, or when the
 *  licenses service can't be reached to verify it (fail-closed). The route → 402 + `code`. */
export class FrLicenseError extends Error {
  /** The 402 code the route forwards. One per `reason` — see `FR_LICENSE_CODE`. */
  readonly code: string;
  constructor(
    readonly reason: FrLicenseReason,
    message?: string,
  ) {
    super(message ?? `fr license required (${reason})`);
    this.name = 'FrLicenseError';
    // ⚠️ The English `message` STAYS and is still forwarded as `detail`. It is the log line, the MCP
    // read, and the mid-roll fallback an older bundle renders when it does not know these codes yet.
    // The code is what makes a localized sentence POSSIBLE; it does not make the sentence redundant.
    this.code = FR_LICENSE_CODE[reason];
  }
}

/**
 * Gate 2 for an fr forward: introspect the connector's stored fr license token and assert the tenant
 * is entitled. Resolves on success; throws FrLicenseError on any failure (including a fail-closed
 * introspect outage). Pure of HTTP-status concerns — the route maps FrLicenseError → 402.
 */
export async function assertFrLicense(token: string, expectedTenantId: string): Promise<void> {
  let resp;
  try {
    resp = await licenseClient().introspect(token);
  } catch (err) {
    // An unreachable / erroring licenses service must DENY, never allow (mirrors license-gate.ts).
    throw new FrLicenseError(
      'introspect_unavailable',
      `The fr license could not be verified: ${
        err instanceof LicenseClientError ? `HTTP ${err.status}` : String(err)
      }`,
    );
  }
  if (!resp.active) {
    throw new FrLicenseError('inactive', 'The tenant’s fr license is not active');
  }
  const appKey = resp.app?.key;
  if (!appKey || !config.fr.licenseAppKeys.includes(appKey)) {
    throw new FrLicenseError(
      'app_mismatch',
      `The fr license is for app "${appKey ?? '(none)'}", not an fr-bridge app`,
    );
  }
  if (!resp.tenant_id || resp.tenant_id !== expectedTenantId) {
    throw new FrLicenseError('tenant_mismatch', 'The fr license belongs to a different tenant');
  }
}
