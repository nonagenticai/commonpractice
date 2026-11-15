// src/services/tenant-licence-bundles.ts — licences BUNDLES CP ensures on a tenant it owns (0104).
//
// A super_admin names bundle keys (`n8n-nodes`, `w2v`, …) at create or later through the repair
// route; CP, as the tenant's OWNING app in licences (migration 050), calls
// `POST /internal/tenants/{id}/bundles/{bundle}/ensure` for each. Licences decides which keys exist
// and what each bundle contains — CP keeps NO list of bundle keys (a hardcoded copy would go stale
// the day licences adds one). What CP keeps is which bundles were asked for and what licences
// answered, in `tenants.licence_bundles`.
//
// FAILURE SEMANTICS. A bundle that fails does NOT void the tenant. createTenant already treats every
// step after its own licence (billing terms, IR licence, first invite) as "the tenant stands, the
// step is recorded and retryable"; bundles are the same kind of thing — other apps' licences on a
// tenant that is fully usable in CP without them. So each bundle gets its own record (ok | failed |
// skipped + licences' error code), the `licence_bundles` provisioning step summarises them, and the
// Retry button / `POST /api/tenants/:id/licence-bundles` re-ensures idempotently.
//
// RETRIES. Only a transient answer (licences >= 500, or a transport failure) is retried, a couple of
// times inside the request. A 4xx — above all a 403 (`tenant_owner_only`, `tenant_not_accessible`,
// `unknown_api_client`, `bundle_not_ensurable_by_caller`, a missing role) — is final and recorded as
// is: it fails identically until licences' data or roles change, and hammering an authorization
// refusal is noise.
//
// PLANS. Every ensure sends `{"plans": config.license.bundlePlans}` (`LICENCE_BUNDLE_PLANS`, default
// `tenant-pooled,standard`), an ordered preference: licences gives each inserted app the first plan
// that exists on it. An app with none of them comes back in `refused` as `no_plan` and is recorded
// on the bundle (`bundle_apps_refused`) like every other per-app refusal.
//
// OVERLAPPING BUNDLES. Licences binds ONE licence per (tenant, app) to ONE bundle, and refuses an app
// already bound to a different bundle with the per-app reason `other_bundle`
// (licences services/bundle_ensure.py REFUSE_OTHER_BUNDLE). Bundles overlap (non-agentic-ai,
// knowledge and research all hold fr / kag / n8n …), so asking for several of them ALWAYS meets that
// answer — and the app IS licensed, through the other bundle. So `other_bundle` is not a failure: it
// is recorded in `coveredByOtherBundle`, and a bundle whose only refusals are `other_bundle` is `ok`.
// Any other reason (`no_plan`, `member_licence`, …) still fails the bundle. Licences' response names
// only `{app, reason}` — not WHICH bundle holds the app — so CP records the app keys only.
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../config';
import { db, tenants } from '../db/client';
import { log } from '../host/logger';
import {
  adminMethod,
  licencesAdminConfigured,
  licensesAdmin,
  LicencesBundleError,
  LicensesAdminError,
  type BundleEnsuredApp,
  type BundleRefusedApp,
} from './licenses-admin';

/** A licences bundle key: kebab-case, as licences' own keys are (`book-fulfillment`, `n8n-nodes`). */
export const BUNDLE_KEY = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'a bundle key is lower-case kebab-case (e.g. n8n-nodes)');

/** At most this many bundles per request — licences holds about ten today. */
export const MAX_BUNDLES_PER_REQUEST = 20;

/** A list of bundle keys: 1..20, no duplicates. */
export const BUNDLE_LIST = z
  .array(BUNDLE_KEY)
  .min(1)
  .max(MAX_BUNDLES_PER_REQUEST)
  .superRefine((keys, ctx) => {
    const seen = new Set<string>();
    keys.forEach((k, i) => {
      if (seen.has(k)) ctx.addIssue({ code: 'custom', path: [i], message: `duplicate bundle '${k}'` });
      seen.add(k);
    });
  });

export type BundleStatus = 'ok' | 'failed' | 'skipped';

/** licences' per-app refusal for an app already licensed through ANOTHER bundle (not a failure). */
export const REFUSE_OTHER_BUNDLE = 'other_bundle';

export interface BundleRecord {
  status: BundleStatus;
  /** licences' `detail.error` (`tenant_owner_only`, `bundle_not_ensurable_by_caller`,
   *  `bundle_not_found`, …) or CP's own code. */
  code: string | null;
  message: string | null;
  /** app → licences' decision (`exists` | `adopt` | `insert`), from the last answer that had a body. */
  apps: Record<string, BundleEnsuredApp['decision']>;
  /** Real per-app refusals (anything but `other_bundle`): any one of them fails the bundle. */
  refused: BundleRefusedApp[];
  /** Apps licences answered `other_bundle` for: licensed, through another bundle. Absent on records
   *  written before this field existed (read as `[]`). */
  coveredByOtherBundle?: string[];
  attempts: number;
  lastAttemptAt: string | null;
  /** When licences last confirmed every app of the bundle. */
  ensuredAt: string | null;
}

export type LicenceBundlesRecord = Record<string, BundleRecord>;

/** One bundle's result, as the routes return it. */
export interface BundleResult extends BundleRecord {
  bundle: string;
}

/** Calls per bundle for a transient failure (the first included). */
export const BUNDLE_ENSURE_ATTEMPTS = 3;
const BUNDLE_ENSURE_BACKOFF_MS = [200, 600];

/**
 * The longest ONE bundle's ensure can take: every attempt may spend a service-token fetch AND the
 * ensure call, each bounded by `LICENSE_ADMIN_TIMEOUT_MS`, plus the backoff sleeps between attempts.
 * The `licence_bundles` claim is refreshed to this (plus a margin) before every bundle, so a claim
 * cannot lapse in the middle of a long bundle list (tenant-provisioning.ts runLicenceBundles).
 */
export function bundleEnsureWorstCaseMs(): number {
  const backoff = BUNDLE_ENSURE_BACKOFF_MS.slice(0, BUNDLE_ENSURE_ATTEMPTS - 1).reduce((a, b) => a + b, 0);
  return BUNDLE_ENSURE_ATTEMPTS * 2 * config.license.adminTimeoutMs + backoff;
}

let sleep = (ms: number): Promise<void> => Bun.sleep(ms);
/** Make the transient-retry sleep instant in tests (paired with `(undefined)` teardown). */
export function __setBundleSleepForTests(fake: ((ms: number) => Promise<void>) | undefined): void {
  sleep = fake ?? ((ms: number) => Bun.sleep(ms));
}

/** A failure worth another try in the same request: licences >= 500 or a transport error (503).
 *  Never a 4xx — a 403 in particular is an authorization answer, not a blip. */
function isTransient(err: unknown): boolean {
  return err instanceof LicensesAdminError && err.status >= 500 && err.status !== 501;
}

/** The record a bundle starts with when it is requested (written before it is ensured). */
export function requestedBundleRecord(prev?: BundleRecord): BundleRecord {
  return (
    prev ?? {
      status: 'failed',
      code: 'not_ensured_yet',
      message: null,
      apps: {},
      refused: [],
      attempts: 0,
      lastAttemptAt: null,
      ensuredAt: null,
    }
  );
}

export async function readLicenceBundles(tenantId: string): Promise<LicenceBundlesRecord | null> {
  const [row] = await db
    .select({ b: tenants.licence_bundles })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  return row ? ((row.b ?? {}) as LicenceBundlesRecord) : null;
}

/** Merge `patch` into the tenant's `licence_bundles` (per key; keys not in `patch` are kept). */
export async function writeLicenceBundles(tenantId: string, patch: LicenceBundlesRecord): Promise<void> {
  await db
    .update(tenants)
    .set({ licence_bundles: sql`coalesce(${tenants.licence_bundles}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb` })
    .where(eq(tenants.id, tenantId));
}

/** Ensure ONE bundle now. Never throws: every outcome is a record. */
export async function ensureOneBundle(
  tenantId: string,
  bundle: string,
  prev: BundleRecord | undefined,
): Promise<BundleRecord> {
  const attempts = (prev?.attempts ?? 0) + 1;
  const now = new Date().toISOString();
  const base = {
    apps: prev?.apps ?? {},
    refused: [] as BundleRefusedApp[],
    coveredByOtherBundle: prev?.coveredByOtherBundle ?? [],
    attempts,
    lastAttemptAt: now,
    ensuredAt: prev?.ensuredAt ?? null,
  };
  if (!licencesAdminConfigured()) {
    return { ...base, status: 'skipped', code: 'licences_not_configured', message: null };
  }
  let lastErr: unknown;
  for (let i = 1; i <= BUNDLE_ENSURE_ATTEMPTS; i++) {
    try {
      const out = await adminMethod(licensesAdmin(), 'ensureTenantBundle')(tenantId, bundle, config.license.bundlePlans);
      const apps = Object.fromEntries(Object.entries(out.apps).map(([app, a]) => [app, a.decision]));
      const covered = out.refused.filter((r) => r.reason === REFUSE_OTHER_BUNDLE).map((r) => r.app);
      const refused = out.refused.filter((r) => r.reason !== REFUSE_OTHER_BUNDLE);
      if (refused.length > 0) {
        return {
          ...base,
          apps,
          refused,
          coveredByOtherBundle: covered,
          status: 'failed',
          code: 'bundle_apps_refused',
          message: `licences refused ${refused.map((r) => `${r.app} (${r.reason})`).join(', ')}`.slice(0, 500),
        };
      }
      return { ...base, apps, coveredByOtherBundle: covered, status: 'ok', code: null, message: null, ensuredAt: now };
    } catch (err) {
      lastErr = err;
      if (i === BUNDLE_ENSURE_ATTEMPTS || !isTransient(err)) break;
      await sleep(BUNDLE_ENSURE_BACKOFF_MS[i - 1] ?? BUNDLE_ENSURE_BACKOFF_MS.at(-1)!);
    }
  }
  const code =
    lastErr instanceof LicencesBundleError
      ? lastErr.code
      : lastErr instanceof LicensesAdminError
        ? lastErr.status === 501
          ? 'licences_client_unsupported'
          : 'licences_unavailable'
        : 'bundle_ensure_failed';
  const message = (lastErr instanceof Error ? lastErr.message : String(lastErr)).slice(0, 500);
  log.warn('tenant_licence_bundle_failed', { component: 'tenant-licence-bundles', tenantId, bundle, code, err: lastErr });
  return { ...base, status: 'failed', code, message };
}

/**
 * Ensure `bundles` on the tenant, one after another, and store each record. Returns the per-bundle
 * results in the order asked. The caller holds the `licence_bundles` step claim; `beforeEach` runs
 * before every bundle (the caller refreshes that claim there).
 */
export async function ensureTenantBundles(
  tenantId: string,
  bundles: string[],
  beforeEach?: () => Promise<void>,
): Promise<BundleResult[]> {
  const stored = (await readLicenceBundles(tenantId)) ?? {};
  const results: BundleResult[] = [];
  for (const bundle of bundles) {
    if (beforeEach) await beforeEach();
    const record = await ensureOneBundle(tenantId, bundle, stored[bundle]);
    await writeLicenceBundles(tenantId, { [bundle]: record });
    results.push({ bundle, ...record });
  }
  return results;
}

/** The step summary over EVERY bundle the tenant has (not only the ones just run). */
export function summariseBundles(all: LicenceBundlesRecord): {
  status: 'ok' | 'failed' | 'skipped';
  code: string | null;
  message: string | null;
} {
  const entries = Object.entries(all);
  if (entries.length === 0) return { status: 'skipped', code: 'no_bundles_requested', message: null };
  const failed = entries.filter(([, r]) => r.status === 'failed');
  if (failed.length > 0) {
    return {
      status: 'failed',
      code: failed.length === 1 ? (failed[0]![1].code ?? 'licence_bundles_failed') : 'licence_bundles_failed',
      message: failed.map(([k, r]) => `${k}: ${r.code ?? 'failed'}`).join('; ').slice(0, 500),
    };
  }
  if (entries.every(([, r]) => r.status === 'skipped')) {
    return { status: 'skipped', code: entries[0]![1].code ?? 'licences_not_configured', message: null };
  }
  return { status: 'ok', code: null, message: null };
}

/** The API view: bundles in key order. */
export function bundlesView(all: LicenceBundlesRecord | null | undefined): BundleResult[] {
  return Object.keys(all ?? {})
    .sort()
    .map((bundle) => ({ bundle, ...(all as LicenceBundlesRecord)[bundle]! }));
}
