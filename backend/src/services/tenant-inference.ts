// src/services/tenant-inference.ts — a tenant's OWN inference-router credential (migration 0099).
//
// WHY. Every platform LLM call used to reach the in-cluster inference-router as `Bearer EMPTY` — a
// sentinel the router ignored. With licence introspection enforced on the router, that means no call
// was attributable to the tenant that made it: not metered per tenant, not budgeted per tenant. A
// `local-llm` tenant now carries its own `inference-router` licence token instead
// (ai/llm/select.ts, host/llm-broker.ts). Platform background work (`platformActor`) keeps the
// platform's own credential: nobody in the tenant asked for it.
//
// HOW — provisioning's tenant-inference flow (provisioning/src/tenant_inference.py), re-implemented
// with what CP's `license-admin` service account can actually do:
//   1. licence  — `POST /licenses/user/{cp-tenant:<id>:a}` for app `inference-router` (idempotent per
//                 tenant+app+subject). Provisioning uses licences' bundle `ensure` instead, which
//                 needs the `bundle-provisioner` realm role CP's SA does not hold.
//   2. token    — `POST /licenses/{id}/tokens` (opaque; returned once; stored encrypted).
//   3. smoke    — one `max_tokens: 1` chat completion AS THE TENANT. A token is stored only after the
//                 router accepted it, so a stored token is a working token.
//   (billing money budget and IR policy: see the PR — billing's money-budget routes are switched off
//    in prod and IR's admin API is unconfigured; IR needs no policy row while POLICY_MODE is off.)
//
// The subject is the tenant's synthetic `cp-tenant:<id>:a` holder (licences only admits `:a|:b` for
// realm `cp-tenant`). It never collides with CP's own tenant licence: licences keys a licence on
// (tenant, APP, subject), and the tenant-licence sweep skips other apps.
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { config } from '../config';
import { db, tenants } from '../db/client';
import { platformInferenceState } from '../db/schema';
import { encryptSecret, tryDecryptSecret } from '../host/secret-box';
import { log } from '../host/logger';
import { incCounter } from '../host/metrics';
import { HttpError } from '../utils/http';
import {
  LicensesAdminService,
  licencesAdminConfigured,
  tenantLicenceSubjects,
  type LicensesAdminClient,
} from './licenses-admin';
import { withLicenceLease } from './license-provisioning';

/**
 * A `local-llm` tenant whose inference credential is missing or unreadable.
 *
 * ⛔ FAIL CLOSED, NEVER `Bearer EMPTY`. Falling back to the shared sentinel is exactly the
 * unattributed, unbudgeted call this module exists to end. 503 (not 402/403): the workspace's licence
 * and posture are fine; a provisioning step has not run (re-run the plan migration / edit the plan).
 */
export class TenantInferenceNotProvisionedError extends HttpError {
  constructor(readonly tenantId: string) {
    super(
      503,
      'llm_inference_not_provisioned',
      `tenant ${tenantId} is on the local-llm plan but holds no readable inference-router credential; ` +
        `refusing to call the router without one`,
      { tenantId },
    );
    this.name = 'TenantInferenceNotProvisionedError';
  }
}

let _client: LicensesAdminClient | undefined;
let _override: LicensesAdminClient | undefined;
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let _fetch: FetchLike = (input, init) => fetch(input, init);

/** A licences admin client pinned to the inference-router app (same SA as CP's own licences). */
export function inferenceLicences(): LicensesAdminClient {
  if (_override) return _override;
  if (!_client) {
    _client = new LicensesAdminService({
      appKey: config.inference.appKey,
      planCode: config.inference.planCode,
    });
  }
  return _client;
}

/** Is there a licences service to mint against? (An injected test client counts.) */
function inferenceLicencesConfigured(): boolean {
  return Boolean(_override) || licencesAdminConfigured();
}

export function __setInferenceLicencesForTests(fake: LicensesAdminClient | undefined): void {
  _override = fake;
}
export function __setInferenceFetchForTests(f: FetchLike | undefined): void {
  _fetch = f ?? ((input, init) => fetch(input, init));
}

/** The licences subject holding a tenant's inference-router licence. */
export function inferenceSubject(tenantId: string): string {
  return tenantLicenceSubjects(tenantId)[0];
}

export { isSentinelCredential } from '../ai/llm/sentinel';

/**
 * The tenant's own inference-router token — the ONLY credential a tenant's router-bound call may
 * carry. Throws `TenantInferenceNotProvisionedError` when it has none or it will not decrypt: a
 * keyless tenant that is not provisioned fails CLOSED instead of reaching the router as `EMPTY`
 * (which the router refuses anyway). Callers ask only when the call is bound for the router.
 */
export async function tenantInferenceToken(tenantId: string): Promise<string> {
  const [row] = await db
    .select({ enc: tenants.inference_token_encrypted })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  const token = tryDecryptSecret(row?.enc);
  if (!token) throw new TenantInferenceNotProvisionedError(tenantId);
  return token;
}

/**
 * The PLATFORM's own router credential — used by platform background work (`platformActor`: content
 * translation) and by a call with no tenant at all.
 *
 * ⛔ HELD BY A DEDICATED LICENCES *SERVICE* TENANT (`config.inference.platformTenantId`,
 * `svc-commonpractice`), NEVER BY CP'S NIL SYSTEM TENANT. In licences the nil uuid is
 * `default-anon`, and inference-router drops every cost event on it (`UNATTRIBUTED_TENANT_ID`,
 * metering.py) while billing dead-letters a nil tenant — platform spend would be silently
 * unmetered. A token held for any other holder than the configured one is never used.
 *
 * The state is one row of `platform_inference_state` (0100), cached briefly in-process.
 */
const PLATFORM_TOKEN_TTL_MS = 60_000;
let platformCache: { holder: string; token: string; at: number } | null = null;

export async function platformInferenceToken(): Promise<string> {
  const holder = config.inference.platformTenantId;
  if (!holder) throw new TenantInferenceNotProvisionedError('platform (INFERENCE_PLATFORM_TENANT_ID unset)');
  if (platformCache && platformCache.holder === holder && Date.now() - platformCache.at < PLATFORM_TOKEN_TTL_MS) {
    return platformCache.token;
  }
  const [row] = await db
    .select({ holder: platformInferenceState.holder_tenant_id, enc: platformInferenceState.token_encrypted })
    .from(platformInferenceState)
    .where(eq(platformInferenceState.id, 1));
  const token = row && row.holder?.toLowerCase() === holder ? tryDecryptSecret(row.enc) : null;
  if (!token) throw new TenantInferenceNotProvisionedError(`platform (${holder})`);
  platformCache = { holder, token, at: Date.now() };
  return token;
}

export function __resetPlatformInferenceCacheForTests(): void {
  platformCache = null;
}

/** The credential a router-bound call carries: the tenant's own, or the platform's. Never `EMPTY`. */
export async function routerCredential(tenantId: string | null, platformActor: boolean): Promise<string> {
  if (platformActor || !tenantId) return platformInferenceToken();
  return tenantInferenceToken(tenantId);
}

/**
 * Backoff between FAILED automatic platform-provisioning attempts: 5 min, doubling, capped at 6 h.
 * Persisted (`next_attempt_at`) so a restart or another replica does not reset it — without it, a
 * smoke that keeps failing made every 5-minute integrity tick mint and revoke a licence (~288/day).
 */
export const PLATFORM_BACKOFF_BASE_MS = 5 * 60_000;
export const PLATFORM_BACKOFF_CAP_MS = 6 * 60 * 60_000;
export function platformBackoffMs(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(PLATFORM_BACKOFF_CAP_MS, PLATFORM_BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 20));
}
const PLATFORM_LEASE_MS = Math.max(120_000, config.license.adminTimeoutMs * 6);

export type PlatformProvisionOutcome =
  | InferenceProvisionOutcome
  | { status: 'skipped_no_router' | 'skipped_no_platform_tenant' | 'busy' }
  | { status: 'backoff'; nextAttemptAt: Date };

/**
 * Mint the platform's router credential if it is missing (onboarding-integrity tick). Idempotent;
 * under a single-statement lease on the state row; honours the persisted backoff after a failure.
 * Throws the provisioning error after recording it (attempts + 1, next_attempt_at) for the caller
 * to log.
 */
export async function ensurePlatformInference(now: Date = new Date()): Promise<PlatformProvisionOutcome> {
  if (config.llm.mode !== 'openai_compatible' || !config.llm.openaiBaseUrl) return { status: 'skipped_no_router' };
  const holder = config.inference.platformTenantId;
  if (!holder) return { status: 'skipped_no_platform_tenant' };
  if (!inferenceLicencesConfigured()) return { status: 'skipped_unconfigured' };
  const state = platformInferenceState;
  const [row] = await db.select().from(state).where(eq(state.id, 1));
  if (row && row.holder_tenant_id?.toLowerCase() === holder && tryDecryptSecret(row.token_encrypted)) {
    return { status: 'already_provisioned', licenceId: row.licence_id };
  }
  if (row?.next_attempt_at && row.next_attempt_at > now) {
    return { status: 'backoff', nextAttemptAt: row.next_attempt_at };
  }
  const opId = randomUUID();
  const claimed = await db
    .update(state)
    .set({ op_id: opId, op_until: new Date(now.getTime() + PLATFORM_LEASE_MS) })
    .where(sql`${state.id} = 1 AND (${state.op_until} IS NULL OR ${state.op_until} < now())`)
    .returning({ id: state.id });
  if (claimed.length === 0) return { status: 'busy' };
  const client = inferenceLicences();
  try {
    // A smoke-failed licence whose revoke failed last time: settle it first, never leave it live.
    for (const id of row?.revoke_pending ?? []) {
      try {
        await client.revokeByLicenseId(id, row?.holder_tenant_id ?? holder);
        await db
          .update(state)
          .set({ revoke_pending: sql`array_remove(${state.revoke_pending}, ${id}::uuid)` })
          .where(eq(state.id, 1));
      } catch (err) {
        log.warn('platform_inference_pending_revoke_failed', { licenceId: id, err });
      }
    }
    const { licenseId } = await client.createLicense(inferenceSubject(holder), holder, {
      planCode: config.inference.planCode,
    });
    const { token } = await client.createToken(licenseId, holder);
    try {
      await smokeCall(token, holder);
    } catch (err) {
      try {
        await client.revokeByLicenseId(licenseId, holder);
      } catch (revokeErr) {
        incCounter(INFERENCE_ORPHAN_QUEUED_COUNTER);
        log.error('platform_inference_orphan_queued', { licenceId: licenseId, err: revokeErr });
        await db
          .update(state)
          .set({
            revoke_pending: sql`array_append(array_remove(${state.revoke_pending}, ${licenseId}::uuid), ${licenseId}::uuid)`,
          })
          .where(eq(state.id, 1));
      }
      throw err;
    }
    await db
      .update(state)
      .set({
        holder_tenant_id: holder,
        token_encrypted: encryptSecret(token),
        licence_id: licenseId,
        provisioned_at: now,
        attempts: 0,
        next_attempt_at: null,
        last_error: null,
        updated_at: now,
      })
      .where(eq(state.id, 1));
    platformCache = null;
    log.info('platform_inference_provisioned', { holder, licenceId: licenseId });
    return { status: 'provisioned', licenceId: licenseId };
  } catch (err) {
    const attempts = (row?.attempts ?? 0) + 1;
    const nextAttemptAt = new Date(now.getTime() + platformBackoffMs(attempts));
    await db
      .update(state)
      .set({
        attempts,
        next_attempt_at: nextAttemptAt,
        last_error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        updated_at: now,
      })
      .where(eq(state.id, 1));
    log.error('platform_inference_provision_failed', { holder, attempts, nextAttemptAt, err });
    throw err;
  } finally {
    await db
      .update(state)
      .set({ op_id: null, op_until: null })
      .where(sql`${state.id} = 1 AND ${state.op_id} = ${opId}::uuid`);
  }
}

/**
 * The smoke, with a NEGATIVE CONTROL first: a bogus licence-shaped token must be REFUSED.
 *
 * ⛔ A 2xx for the tenant's token proves nothing on its own: a router that does not introspect
 * (INTROSPECT_MODE off/observe) answers 2xx to ANY bearer, `EMPTY` included. Measured 2026-10-13:
 * prod runs `INFERENCE_ROUTER_INTROSPECT_MODE=enforce`, under which a token the licence server does
 * not vouch for is a 401 — so a bogus token that is NOT refused means the router is not checking,
 * and the tenant's token would be stored as "working" on evidence that could not have failed.
 * The bogus token is 43 url-safe chars (the router's licence-token shape), random per call so no
 * cache can vouch for it.
 */
async function smokeCall(token: string, tenantId: string): Promise<void> {
  const bogus = randomBytes(32).toString('base64url');
  const control = await smokeRequest(bogus, tenantId);
  if (control.ok) {
    throw new HttpError(
      502,
      'inference_router_not_enforcing',
      `inference-router accepted a bogus licence token (HTTP ${control.status}); it is not enforcing ` +
        `licence introspection, so a smoke pass would prove nothing — refusing to provision ${tenantId}`,
      { upstreamStatus: control.status },
    );
  }
  const res = await smokeRequest(token, tenantId);
  if (!res.ok) {
    throw new HttpError(
      502,
      'inference_smoke_failed',
      `inference-router refused the smoke call for ${tenantId}: HTTP ${res.status}`,
      { upstreamStatus: res.status, correlationId: res.correlationId },
    );
  }
  log.info('tenant_inference_smoke_ok', { tenantId, correlationId: res.correlationId, controlStatus: control.status });
}

/** One `max_tokens: 1` completion against the router with `token` as the bearer. */
async function smokeRequest(
  token: string,
  tenantId: string,
): Promise<{ ok: boolean; status: number; correlationId: string }> {
  const base = config.llm.openaiBaseUrl.replace(/\/+$/, '');
  if (!base) {
    throw new HttpError(500, 'inference_router_unconfigured', 'OPENAI_BASE_URL (the inference-router) is not set');
  }
  const correlationId = randomUUID();
  let res: Response;
  try {
    res = await _fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'X-Correlation-Id': correlationId,
      },
      body: JSON.stringify({
        model: config.inference.smokeModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(config.llm.callTimeoutMs),
    });
  } catch (err) {
    throw new HttpError(502, 'inference_smoke_failed', `inference-router smoke call for ${tenantId} failed: ${String(err)}`);
  }
  return { ok: res.ok, status: res.status, correlationId };
}

export type InferenceProvisionOutcome =
  | { status: 'provisioned'; licenceId: string }
  | { status: 'already_provisioned'; licenceId: string | null }
  | { status: 'skipped_unconfigured' };

/**
 * Give the tenant its own inference-router licence + token, smoke-tested, stored encrypted.
 * Idempotent: a tenant with a readable stored token is left alone unless `force`.
 */
export async function ensureTenantInference(
  tenantId: string,
  opts: { force?: boolean } = {},
): Promise<InferenceProvisionOutcome> {
  if (!inferenceLicencesConfigured()) return { status: 'skipped_unconfigured' };
  const [row] = await db
    .select({ enc: tenants.inference_token_encrypted, licenceId: tenants.inference_licence_id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!row) throw new HttpError(404, 'tenant_not_found', `No tenant '${tenantId}'`);
  if (!opts.force && tryDecryptSecret(row.enc)) {
    return { status: 'already_provisioned', licenceId: row.licenceId };
  }
  // Under the tenant's licence lease (0096): two provisioners (the integrity tick on two replicas,
  // a PATCH racing the plan migration) must not both mint, smoke and overwrite each other's token.
  return withLicenceLease(tenantId, () => mintInferenceLocked(tenantId, opts));
}

async function mintInferenceLocked(tenantId: string, opts: { force?: boolean }): Promise<InferenceProvisionOutcome> {
  const [row] = await db
    .select({ enc: tenants.inference_token_encrypted, licenceId: tenants.inference_licence_id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!row) throw new HttpError(404, 'tenant_not_found', `No tenant '${tenantId}'`);
  // Re-checked under the lease: the holder that just released it may have provisioned already.
  if (!opts.force && tryDecryptSecret(row.enc)) {
    return { status: 'already_provisioned', licenceId: row.licenceId };
  }
  const client = inferenceLicences();
  const { licenseId } = await client.createLicense(inferenceSubject(tenantId), tenantId, {
    planCode: config.inference.planCode,
  });
  const { token } = await client.createToken(licenseId, tenantId);
  try {
    await smokeCall(token, tenantId);
  } catch (err) {
    // ⛔ NOTHING LIVE MAY BE ORPHANED. The licence + token were minted above and the smoke refused
    // them, so nothing will store them — and licences hands the SAME active licence back on the
    // next attempt, which would mint one more live token per retry.
    await discardMinted(client, tenantId, licenseId, token, row.licenceId);
    throw err;
  }
  await db
    .update(tenants)
    .set({
      inference_token_encrypted: encryptSecret(token),
      inference_licence_id: licenseId,
      inference_provisioned_at: new Date(),
      updated_at: new Date(),
    })
    .where(eq(tenants.id, tenantId));
  log.info('tenant_inference_provisioned', { tenantId, licenceId: licenseId });
  return { status: 'provisioned', licenceId: licenseId };
}

export const INFERENCE_ORPHAN_QUEUED_COUNTER = 'tenant_inference_orphan_revoke_queued_total';

/**
 * Undo a mint whose smoke failed.
 *   • A NEW licence (not the one stored on the row) is revoked by id — its tokens die with it, so a
 *     retry mints a fresh licence instead of piling tokens onto this one. If licences refuses the
 *     revoke, the id is queued in `tenants.licence_revoke_pending` (0097), which the
 *     onboarding-integrity sweep settles; it is never left live and unrecorded.
 *   • The STORED licence (a `force` re-provision of a working tenant) is kept: only the just-minted
 *     TOKEN is revoked, so the tenant's current credential keeps working.
 */
async function discardMinted(
  client: LicensesAdminClient,
  tenantId: string,
  licenseId: string,
  token: string,
  storedLicenceId: string | null,
): Promise<void> {
  if (storedLicenceId && licenseId === storedLicenceId) {
    await client
      .revokeByToken(token, tenantId)
      .catch((err: unknown) => log.error('tenant_inference_smoke_token_revoke_failed', { tenantId, licenceId: licenseId, err }));
    return;
  }
  try {
    await client.revokeByLicenseId(licenseId, tenantId);
    log.warn('tenant_inference_smoke_failed_licence_revoked', { tenantId, licenceId: licenseId });
  } catch (err) {
    incCounter(INFERENCE_ORPHAN_QUEUED_COUNTER);
    log.error('tenant_inference_orphan_queued', {
      tenantId,
      licenceId: licenseId,
      remediation: 'queued in tenants.licence_revoke_pending; the onboarding-integrity sweep revokes it',
      err,
    });
    await db
      .update(tenants)
      .set({
        licence_revoke_pending: sql`array_append(array_remove(${tenants.licence_revoke_pending}, ${licenseId}::uuid), ${licenseId}::uuid)`,
      })
      .where(eq(tenants.id, tenantId));
  }
}

/**
 * Revoke the tenant's inference-router licence and forget the token (plan change away from
 * local-llm, offboard). Revoke first: a cleared column with a live licence upstream is a credential
 * nobody can see any more. With no licences service configured only the columns are cleared.
 */
export async function revokeTenantInference(tenantId: string): Promise<{ revoked: boolean }> {
  const [row] = await db
    .select({ licenceId: tenants.inference_licence_id, enc: tenants.inference_token_encrypted })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!row || (!row.licenceId && !row.enc)) return { revoked: false };
  if (row.licenceId && inferenceLicencesConfigured()) {
    await inferenceLicences().revokeByLicenseId(row.licenceId, tenantId);
  }
  await db
    .update(tenants)
    .set({
      inference_token_encrypted: null,
      inference_licence_id: null,
      inference_provisioned_at: null,
      updated_at: new Date(),
    })
    .where(eq(tenants.id, tenantId));
  log.info('tenant_inference_revoked', { tenantId, licenceId: row.licenceId });
  return { revoked: true };
}
