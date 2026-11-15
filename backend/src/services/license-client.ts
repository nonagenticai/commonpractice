// src/services/license-client.ts — Phase 4 / F.1: the licenses-service introspection client.
//
// Spec: SPEC-PHASE4-admin-tenant-isolation.md Part 9 (9.0 / 9.2). The central licenses service
// (licenses.example.com) is the single source of truth for entitlement. Its tokens are OPAQUE
// (`secrets.token_urlsafe(32)`, stored only as a SHA-256 hash) — NOT JWTs — so they are validated
// by INTROSPECTION, not signature: `POST /license/introspect {token}` (public, no auth) returns
// `{active, tenant_id, app{key}, plan, status, expires_at, reason, …}`.
//
// This client mirrors the keycloak-admin client's seams: an injectable `fetchImpl` + `now()` clock,
// a TTL cache (worker_management parity: a 5-min introspection cache so the hot path neither hammers
// the licenses service nor blocks on it), a `LicenseClient` interface the gate + tests program
// against, and a module accessor + `__setLicenseClientForTests` override (no process-wide mocks).
//
// FAIL-CLOSED CONTRACT: a non-2xx response or a network error THROWS (LicenseClientError). The gate
// (middleware/license-gate.ts) maps a throw to DENY (402) — an unreachable licenses service must
// never allow a request through. NOTE the npm `@nonagenticai/license-validator` lib under-models the
// response (it only types/uses `active`), so CP types the full shape itself and calls introspect
// directly — Gate 2 needs `app.key`, `tenant_id`, and `expires_at`, none of which that lib exposes.
import { config } from '../config';

/** The `app` block of an introspection response (the registered licenses `App`). */
export interface LicenseApp {
  key: string;
  name?: string;
}

/** The `plan` block (per-app tier). Modelled loosely — Gate 2 does not read plan limits in F.1. */
export interface LicensePlan {
  code?: string;
  name?: string;
  [k: string]: unknown;
}

/**
 * The FULL introspection response (Spec 9.0). All fields beyond `active` are optional because an
 * inactive/garbage token may omit them — Gate 2 treats a missing `app`/`tenant_id` as a failed gate.
 */
export interface LicenseIntrospectResponse {
  active: boolean;
  tenant_id?: string | null;
  subject_id?: string | null;
  license_id?: string | null;
  app?: LicenseApp | null;
  plan?: LicensePlan | null;
  status?: string | null;
  /** ISO-8601 timestamp; absent = no expiry asserted by the service. */
  expires_at?: string | null;
  reason?: string | null;
  /**
   * Populated ONLY by the licences service's `GET /licenses/active` (same response model as
   * introspect): `true` when the optional `subject_id` selector resolved to a subject holding an
   * active licence and THAT licence was returned; `false` when the selector matched nothing and the
   * tenant-level pick was used instead; `null`/absent when no selector was sent. See
   * `LicensesAdminClient.getActiveLicense`.
   */
  subject_match?: boolean | null;
  /** `GET /licenses/active` only: how many active licences the (tenant, app) holds. */
  candidate_count?: number | null;
}

/** Thrown on a non-2xx introspect response or a transport failure. Gate 2 → fail-closed 402. */
export class LicenseClientError extends Error {
  constructor(
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `license introspect failed: HTTP ${status}`);
    this.name = 'LicenseClientError';
  }
}

/**
 * Gate 2 is ON and `LICENSE_INTROSPECT_URL` is empty — a MISCONFIGURATION, not an outage.
 *
 * ⛔ WHY THIS IS A CLASS AND NOT A STATUS CODE. It used to be an ordinary `LicenseClientError(500)`,
 * and `middleware/license-gate.ts` discriminated it with `err.status === 500`. That is WRONG, and
 * measurably so: `introspect` also raises `new LicenseClientError(res.status, …)` for ANY non-2xx
 * response, so a genuine HTTP 500 from a struggling licences service arrives as the same
 * `instanceof` + the same `.status`. The misconfiguration counter therefore climbed on every request
 * of a real upstream outage, and the comment next to it told the on-call operator to go hunting for
 * a config regression that did not exist — mid-outage, when attention is the scarcest thing there
 * is. A status code is a property of the RESPONSE; "we never sent a request at all" is a property of
 * the CALLER. Identity is the only honest discriminator.
 *
 * Deliberately a SUBCLASS: every existing `instanceof LicenseClientError` fail-closed path (the gate,
 * services/fr-license.ts) keeps working unchanged, and `status` stays 500 so nothing that logs it
 * changes shape.
 */
export class LicenseIntrospectNotConfiguredError extends LicenseClientError {
  constructor(message = 'license introspect URL not configured') {
    super(500, message);
    this.name = 'LicenseIntrospectNotConfiguredError';
  }
}

/** The minimal surface the gate + tests depend on (real client + fake both satisfy it). */
export interface LicenseClient {
  introspect(token: string): Promise<LicenseIntrospectResponse>;
}

export interface LicenseClientOptions {
  /** The public `POST /license/introspect` URL. Defaults to config.license.introspectUrl. */
  introspectUrl?: string;
  /** Cache window in ms. Defaults to config.license.cacheTtlSec * 1000. */
  cacheTtlMs?: number;
  /** Injectable for tests (no live licenses service). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms). Defaults to Date.now — only used for the introspection cache. */
  now?: () => number;
}

interface CachedIntrospection {
  value: LicenseIntrospectResponse;
  /** epoch ms after which the cached verdict must be re-introspected. */
  expiresAt: number;
}

export class LicenseClientService implements LicenseClient {
  private readonly introspectUrl: string;
  private readonly cacheTtlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Keyed on the opaque token (worker_management's TTLCache equivalent). */
  private readonly cache = new Map<string, CachedIntrospection>();

  constructor(opts: LicenseClientOptions = {}) {
    this.introspectUrl = opts.introspectUrl ?? config.license.introspectUrl;
    this.cacheTtlMs = opts.cacheTtlMs ?? config.license.cacheTtlSec * 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async introspect(token: string): Promise<LicenseIntrospectResponse> {
    const nowMs = this.now();
    const hit = this.cache.get(token);
    if (hit && hit.expiresAt > nowMs) return hit.value;

    if (!this.introspectUrl) {
      // No URL configured but introspect was called (flag on without config) — fail-closed, and
      // with its OWN error type so the gate can tell it apart from an upstream HTTP 500 (which the
      // `!res.ok` branch below raises with the same status). See the class docblock.
      throw new LicenseIntrospectNotConfiguredError();
    }

    let res: Response;
    try {
      res = await this.fetchImpl(this.introspectUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
        // Gate 2 runs on EVERY request (server.ts, after tenant resolution), so an unbounded
        // introspect against a hung licenses.example.com would hold every in-flight request open
        // until the ingress 504s. The sibling admin client already bounds its calls with this
        // same value — this path was simply missed.
        signal: AbortSignal.timeout(config.license.adminTimeoutMs),
      });
    } catch (err) {
      // Transport failure (DNS / connect / timeout) — never swallow into "active".
      throw new LicenseClientError(
        503,
        `license introspect transport error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new LicenseClientError(res.status, `license introspect failed: HTTP ${res.status}`);
    }
    const value = (await res.json()) as LicenseIntrospectResponse;
    this.cache.set(token, { value, expiresAt: nowMs + this.cacheTtlMs });
    return value;
  }
}

// ---- module accessor + test seam (mirrors keycloakAdmin / __setKeycloakAdminForTests) ----

let _instance: LicenseClient | undefined;
let _testOverride: LicenseClient | undefined;

/** Lazily-constructed default singleton (uses config). Dormant until the gate is enforced (F.2). */
export function licenseClient(): LicenseClient {
  if (_testOverride) return _testOverride;
  if (!_instance) _instance = new LicenseClientService();
  return _instance;
}

/** Inject a fake introspection client in tests (paired with `(undefined)` teardown). */
export function __setLicenseClientForTests(fake: LicenseClient | undefined): void {
  _testOverride = fake;
}
