// src/services/fr-bridge-sa.ts — Phase 5 / 5D: the `commonpractice-bridge` service-account token.
//
// Spec: SPEC-PHASE5-solution-to-delivery.md Part 5 (5D composition). When CP forwards a solution to
// fr (Target B) it POSTs to fr's `/api/project-requests` as the `commonpractice-bridge` portal-realm
// service account — its JWT is the CALLER identity (carrying the `project-request-writer` role + an
// audit `azp`), presented in `Authorization: Bearer …`. (The tenant's fr LICENSE token rides
// separately in `X-Tenant-Id`; see host/delivery/fr.ts.) This module mints + caches that SA token.
//
// Mirrors the seams of services/licenses-admin.ts (getServiceToken): an injectable `fetchImpl` +
// `now()` clock, a 60s token cache, a fail-loud contract (every failure THROWS FrBridgeSaError —
// the fr adapter surfaces it as a dispatch failure, never a silent success), and a module accessor
// + `__setFrBridgeSaForTests` override so adapter tests mint a fake token with NO live Keycloak. The
// mint is a DIRECT token-endpoint fetch (client_credentials), NOT routed through the egress guard —
// it talks to our own auth server, not the external delivery target.
//
// DORMANT until the fr forward path is un-gated (routes/delivery.ts SUPPORTED_FORWARD_KINDS): the
// singleton is lazy, so with 'fr' gated this is never constructed/called.
import { config } from '../config';

/** Thrown on any SA token-mint failure (missing config / non-2xx / transport / no access_token). */
export class FrBridgeSaError extends Error {
  constructor(
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `fr-bridge SA token request failed: HTTP ${status}`);
    this.name = 'FrBridgeSaError';
  }
}

/** The minimal surface the fr adapter + tests depend on (real client + fake both satisfy it). */
export interface FrBridgeSa {
  /** A valid `commonpractice-bridge` access token (cached ≤60s). Throws on failure. */
  getToken(): Promise<string>;
}

export interface FrBridgeSaOptions {
  /** The portal-realm token endpoint (client_credentials grant). Defaults to config.fr.sa.tokenUrl. */
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** Injectable for tests (no live Keycloak). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms). Defaults to Date.now — only used for the service-token cache. */
  now?: () => number;
}

interface CachedToken {
  token: string;
  /** epoch ms after which the cached SA token must be refreshed. */
  expiresAt: number;
}

/** Service-token cache window, mirroring licenses-admin's 60s. */
const TOKEN_TTL_MS = 60_000;

export class FrBridgeSaService implements FrBridgeSa {
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached?: CachedToken;

  constructor(opts: FrBridgeSaOptions = {}) {
    this.tokenUrl = opts.tokenUrl ?? config.fr.sa.tokenUrl;
    this.clientId = opts.clientId ?? config.fr.sa.clientId;
    this.clientSecret = opts.clientSecret ?? config.fr.sa.clientSecret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async getToken(): Promise<string> {
    const nowMs = this.now();
    if (this.cached && this.cached.expiresAt > nowMs) {
      return this.cached.token;
    }
    if (!this.tokenUrl) {
      throw new FrBridgeSaError(500, 'fr-bridge SA token URL not configured');
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    let res: Response;
    try {
      // BOUNDED. This mint runs INSIDE the forward request (routes/delivery.ts dispatch), so an
      // unresponsive Keycloak would otherwise hold that request — and the DB row it is about to
      // settle — open until an upstream proxy gave up, leaving the delivery stuck 'pending'.
      // Reuses keycloak.adminTimeoutMs because this IS a Keycloak token-endpoint call (same
      // server, same latency profile as KeycloakAdminService.getAdminToken) — a separate knob
      // would be a second name for the same ceiling.
      res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(config.keycloak.adminTimeoutMs),
      });
    } catch (err) {
      // A DNS failure / connection refused / TLS error / our own abort throws a raw `TypeError` or
      // `TimeoutError` — neither is FrBridgeSaError, so it would escape the fr adapter's typed
      // catch and surface as a generic 500 instead of the documented dispatch failure.
      const reason =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? `timed out after ${config.keycloak.adminTimeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      throw new FrBridgeSaError(503, `fr-bridge SA token transport error: ${reason}`);
    }
    if (!res.ok) {
      throw new FrBridgeSaError(res.status, `fr-bridge SA token request failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new FrBridgeSaError(502, 'fr-bridge SA token response missing access_token');
    }
    this.cached = { token: json.access_token, expiresAt: nowMs + TOKEN_TTL_MS };
    return json.access_token;
  }
}

// ---- module accessor + test seam (mirrors licensesAdmin / __setLicensesAdminForTests) ----

let _instance: FrBridgeSa | undefined;
let _testOverride: FrBridgeSa | undefined;

/** Lazily-constructed default singleton. Dormant until the fr forward path is un-gated. */
export function frBridgeSa(): FrBridgeSa {
  if (_testOverride) return _testOverride;
  if (!_instance) _instance = new FrBridgeSaService();
  return _instance;
}

/** Inject a fake SA client in tests (paired with `(undefined)` teardown). */
export function __setFrBridgeSaForTests(fake: FrBridgeSa | undefined): void {
  _testOverride = fake;
}
