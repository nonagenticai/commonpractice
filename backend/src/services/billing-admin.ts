// src/services/billing-admin.ts — the billing-service SERVICE-ACCOUNT (read) client.
//
// WHAT THIS IS FOR. CommonPractice bills each tenant monthly as PLATFORM FEE + SEATS + BYO
// MARKUP %. None of those three numbers lives in this database: billing-service owns the price
// book, the seat count it charges for, the markup percentage and the invoices. CP's own
// tenant-admin "Usage & Spend" screen (host/usage-metrics.ts) shows something ADJACENT and
// different — CP's LOCAL estimate of what the LLM calls cost us — and a tenant_admin reading it
// has no way to see what they will actually be invoiced. This client is the read path that closes
// that gap, and `routes/billing-view.ts` is the only thing that proxies it.
//
// ⛔ THE TWO NUMBERS ARE NOT THE SAME NUMBER AND MUST NEVER BE PRESENTED AS ONE. CP's
// `usage_events.cost_usd` is a PRICED ESTIMATE of provider cost (`price_source` is 'provider',
// 'table', 'flat' or 'abort_estimate' — see db/schema.ts). Billing's figure is an INVOICE: it
// applies the markup, adds the platform fee and the seats, and it is the number the customer pays.
// Rendering CP's local ledger under a heading that says "your bill" would be a fabrication even
// when the arithmetic is right, which is why every figure a caller shows as a BILL has to come
// from here and nowhere else. `host/metering-reconcile.ts` exists to measure the gap between the
// two rather than to paper over it.
//
// MODELLED EXACTLY ON services/licenses-admin.ts, deliberately and line for line where it can be:
// an injectable `fetchImpl` + `now()` clock, a 60 s service-token cache, an `authed()` Bearer
// helper, a `BillingAdminClient` interface that routes + tests program against, and a module
// accessor + `__setBillingAdminForTests` override (no process-wide `mock.module`, which the house
// rule forbids). Same `secure-apps` realm, same `client_credentials` grant — billing and licences
// sit behind the SAME auth boundary, which is why the credential below is shared rather than new.
//
// ⛔ FAIL-LOUD CONTRACT, AND IT IS THE WHOLE POINT OF THE FILE. Every method THROWS
// `BillingAdminError` on a non-2xx, a transport failure, or a 2xx whose body does not carry the
// field it promised. There is NO zero fallback and NO empty-array fallback anywhere in here. A
// billing outage that resolved to `{ platformFeeUsd: 0, seats: 0 }` would render as a $0.00 bill —
// indistinguishable, to the customer reading it, from a genuinely free month. "We could not reach
// billing" and "you owe nothing" are different statements and this module refuses to collapse
// them. The route turns the throw into an EXPLICIT unavailable state; see routes/billing-view.ts.
//
// ⚠️ THE INVOICE ENDPOINTS ARE BEING ADDED TO BILLING IN PARALLEL WITH THIS FILE.
// ⛔ THE `/api/billing` PREFIX IS NOT DECORATION — GETTING IT WRONG IS SILENT. billing-service
// mounts its invoice router at `/api/billing`, and an unknown path there answers 404, which this
// client reports as an upstream failure and the panel renders as "unavailable". That is
// indistinguishable, to a reader, from billing being down — so a wrong prefix looks like an outage
// forever rather than like a bug. The first cut of this file called `/api/invoices*` (no prefix)
// against endpoints that did not exist at all; both halves are corrected together.
// `GET /api/costs/tenant/{id}/actors` exists today. `GET /api/billing/invoices?tenant_id=`,
// `GET /api/billing/invoices/{id}` and `GET /api/billing/invoices/preview?tenant_id=&period=` are a concurrent
// change in billing-service. This client is programmed against those paths as specified. If they
// are not live yet the calls 404, which lands in the same fail-loud branch as any other non-2xx —
// the one behaviour that is NOT allowed here is to notice the 404 and synthesise a plausible
// invoice from CP's local ledger. A figure CP computed is not a figure billing issued.
import { config } from '../config';
import { log } from '../host/logger';

/** Thrown by any billing admin-API failure (token / costs / invoices / preview). */
export class BillingAdminError extends Error {
  constructor(
    readonly status: number,
    message?: string,
    /** An excerpt of billing's error BODY, when it sent one. It is the only place a refusal's
     *  reason lives (`budget_write_refused_unregistered_tenant` vs a real 4xx refusal), and the
     *  provisioning saga decides retry-vs-give-up on it (services/tenant-provisioning.ts). */
    readonly detail?: string,
  ) {
    super(message ?? `billing admin request failed: HTTP ${status}`);
    this.name = 'BillingAdminError';
  }
}

/**
 * The billing-service API base, e.g. `https://billing.example.com`.
 *
 * ⚠️ READ FROM env DIRECTLY, AND THAT IS A DEBT THIS FUNCTION EXISTS TO MAKE VISIBLE RATHER THAN
 * HIDE. Every other base URL in this service is a key on the frozen `config` object
 * (`config.license.adminBaseUrl`, …) and this one belongs there too,
 * as `config.billing.baseUrl`. It is not there because `src/config.ts` is owned by another change
 * in flight on this branch and this unit of work is not permitted to edit it — so the choice was
 * between reading env here, behind a named function that says so, or inventing a `config.billing`
 * that does not compile. There IS precedent for the shape (`connectorNotificationsConfig()` in
 * config.ts is a live env read outside the frozen object, for a staged feature) but not for the
 * LOCATION. TODO: hoist to `config.billing.baseUrl` + add `BILLING_ADMIN_BASE_URL` to
 * `validateProductionConfig` (gated on the feature flag, exactly as `license.issuanceEnabled`
 * gates the licences SA creds).
 *
 * ⛔ UNSET IS NOT A DEGRADED MODE — IT IS AN UNCONFIGURED ONE. With no base URL every method throws
 * `BillingAdminError(500)` on its first line rather than returning an empty result, for the reason
 * in the header: an empty result renders as a $0.00 bill. `billingAdminConfigured()` is how a
 * caller asks the question in advance; a caller that does not ask still cannot be lied to.
 */
export function billingAdminBaseUrl(): string {
  // One reader of the env var, and it is `config` — the same discipline every other service client
  // here follows, so a missing value is visible in one place rather than in whichever module
  // happened to read `process.env` first.
  return config.billing.baseUrl;
}

export interface BillingAdminOptions {
  /** Billing API base, e.g. https://billing.example.com. Defaults to `billingAdminBaseUrl()`. */
  adminBaseUrl?: string;
  /** The `secure-apps` realm token endpoint (client_credentials grant). */
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** Injectable for tests (no live billing service). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms). Defaults to Date.now — only used for the service-token cache. */
  now?: () => number;
  /** Per-call ceiling. Defaults to `config.license.adminTimeoutMs` (the same 10 s SA budget). */
  timeoutMs?: number;
}

/**
 * One actor's cost as BILLING accounts for it, over a date range.
 *
 * ⛔ `subjectId` IS THE JOIN KEY, AND IT IS NOT `users.id`. Billing attributes a cost event on the
 * licences-service SUBJECT uuid (`member_entitlements.license_subject_id`, emitted as the cost
 * event's `subject_id` — host/metering-emit.ts). CP's own user id is a DIFFERENT identifier in a
 * different system, and sending it where a subject id was expected is precisely why 100 % of this
 * service's central spend once landed `attribution_status='unlicensed'`. Anything reconciling
 * against this must join on the subject, never on the local user row.
 *
 * `subjectId` may legitimately be EMPTY: billing keeps a bucket for spend that arrived with no
 * subject (a member who held no entitlement when the call settled, or platform background work).
 * That bucket is a real answer and is carried through as `''` rather than dropped — a reconciler
 * that silently discarded it would report agreement while the unattributed money was the
 * disagreement.
 */
export interface BillingActorCost {
  /** licences Subject uuid, or '' for billing's unattributed bucket. */
  subjectId: string;
  /** `users.keycloak_sub` of the person who acted, or '' for platform work. Correlation only. */
  actorId: string;
  costUsd: number;
  events: number;
}

/**
 * A line on an invoice or a preview. Deliberately NOT modelled as three fixed fields
 * (platform fee / seats / markup): billing owns the price book and may issue a line this repo has
 * never heard of, and a client that only understood three kinds would silently DROP a fourth from
 * a total the customer is being charged. The three CP knows about are named in `kind` for display;
 * anything else passes through with its own label and still counts toward `totalUsd`.
 */
export interface BillingInvoiceLine {
  /** 'platform_fee' | 'seats' | 'byo_markup' | anything else billing issues. */
  kind: string;
  /** Billing's own human label for the line. Rendered as-is; CP does not re-word an invoice. */
  label: string;
  amountUsd: number;
  /** Seats, or units of whatever the line meters. Absent when the line is a flat charge. */
  quantity?: number;
  /** For a percentage line (the BYO markup), the rate applied. Absent otherwise. */
  ratePct?: number;
}

export interface BillingInvoice {
  id: string;
  tenantId: string;
  /** Billing period, `YYYY-MM`. */
  period: string;
  status: string;
  currency: string;
  totalUsd: number;
  lines: BillingInvoiceLine[];
  issuedAt?: string;
  dueAt?: string;
  /** Prepaid credit applied to this invoice (USD), ALREADY deducted from `totalUsd` (billing #267). */
  prepaidCreditAppliedUsd?: number;
  /** The statement exists but could not be read: show it, WITHOUT an amount (`totalUsd` is NaN). */
  detailsUnavailable?: true;
}

/**
 * The CURRENT period's bill as it stands right now — not yet issued, and explicitly labelled so.
 * Same shape as an invoice minus the issuance facts, because the screen renders them identically
 * and a caller that had to branch on two unrelated shapes would drift.
 */
export interface BillingInvoicePreview {
  tenantId: string;
  period: string;
  currency: string;
  totalUsd: number;
  lines: BillingInvoiceLine[];
  /** Billing's own statement of how far through the period this preview is measured. */
  asOf?: string;
  /** Prepaid credit applied to this period so far (USD), ALREADY deducted from `totalUsd`. */
  prepaidCreditAppliedUsd?: number;
  /**
   * The LIVE credit remaining (USD) including this month's usage so far — provisional until the
   * month closes. The ledger's own `remaining_usd` counts closed months only (billing #267).
   */
  prepaidCreditRemainingUsd?: number;
}

/** An optional USD figure: absent/null → undefined (never a fabricated 0); present → a number or throw. */
function optUsd(v: unknown, what: string): number | undefined {
  return v == null ? undefined : numOrThrow(v, what);
}

/** The minimal read surface the routes + tests depend on (real + fake both satisfy). */
export interface BillingAdminClient {
  /**
   * `GET /api/costs/tenant/{id}/actors?start=&end=` — per-actor cost totals for one tenant over
   * an INCLUSIVE date range (`YYYY-MM-DD`). The endpoint that already exists today.
   *
   * Used by `host/metering-reconcile.ts` to compare billing's per-actor totals against CP's own
   * settled `usage_events`, and by nothing else — it is a reconciliation input, not a screen.
   */
  actorCosts(tenantId: string, start: string, end: string): Promise<BillingActorCost[]>;

  /**
   * `GET /api/billing/invoices/preview?tenant_id=&period=` — the current period's bill: platform fee,
   * seats, BYO markup. `period` is `YYYY-MM`.
   */
  invoicePreview(tenantId: string, period: string): Promise<BillingInvoicePreview>;

  /** `GET /api/billing/invoices?tenant_id=` — this tenant's ISSUED invoices, newest first. */
  invoices(tenantId: string): Promise<BillingInvoice[]>;

  /**
   * `GET /api/billing/invoices/{id}` — one invoice.
   *
   * ⛔ `tenantId` IS NOT DECORATION AND MUST NOT BE DROPPED AS "the id is unguessable". It is
   * carried as `X-Tenant-Id` so billing can refuse a foreign invoice, AND the caller re-checks the
   * returned `tenantId` against the tenant it asked for (see `getInvoice` below). An invoice id is
   * a bearer-ish identifier the moment nothing checks ownership, and the thing on the other end of
   * this call is a document containing another company's money.
   */
  invoice(invoiceId: string, tenantId: string): Promise<BillingInvoice>;

  /**
   * `GET /api/config/tenants/{id}/commercial-terms` — the tenant's effective terms (or billing's
   * settings defaults, `fullyConfigured: false`, when none were ever stated).
   *
   * OPTIONAL in the type so the many reconcile/invoice test fakes predating it still compile; call
   * it through `billingMethod`, never `?.` (a missing method must fail loudly, not read as "no terms").
   */
  commercialTerms?(tenantId: string): Promise<BillingTermsView>;

  /**
   * `PUT /api/config/tenants/{id}/commercial-terms` — state the tenant's COMPLETE terms.
   *
   * ⛔ THIS ROUTE, NOT `POST /api/config/tenants/{id}/terms`. Billing documents the POST as the wrong
   * one for Common Practice: it writes the unscoped `__seat__` seat key (seats counted across every
   * app), sets no `billing_mode`, and its markup re-prices every product the tenant consumes. Its
   * `?force=true` re-dates all four terms on every call even when nothing changed. The PUT is
   * idempotent ON VALUE (`changed: []` on a replay), scopes the seat count to `seat:commonpractice`,
   * scopes the markup to CP's service key, and closes a legacy `__seat__` row (double seat billing).
   * Gate: `require_pricing_writer` (realm role `license-admin`, which CP's SA holds).
   */
  putCommercialTerms?(tenantId: string, terms: TenantTerms): Promise<BillingTermsView>;

  /**
   * `GET /api/budget/money/status/{id}` (X-Tenant-Id) — the tenant's money budget and what is left.
   * `null` = billing answered 404 (no active money budget, OR the money-budget routes are switched
   * off in this deployment — billing does not distinguish the two).
   */
  moneyBudgetStatus?(tenantId: string): Promise<MoneyBudgetStatus | null>;

  /**
   * `POST /api/budget/money/topup` — buy PREPAID CREDIT (billing PR #267, contract at 286a8b2): a
   * `topup` entry on the tenant's USD credit ledger, invoiced ONCE as a one-time charge. Needs NO
   * money budget. Idempotent per `idempotencyKey` (a replay → `replayed: true`, nothing written).
   * Gate: license-admin. Throws `BillingTopupUnavailableError` on 404 (the feature flag is off).
   */
  moneyTopup?(tenantId: string, input: MoneyTopupInput): Promise<MoneyTopupResult>;

  /** `GET /api/budget/money/credit/{id}` — the tenant's prepaid credit (USD); `null` on 404 (flag off). */
  prepaidCredit?(tenantId: string): Promise<PrepaidCredit | null>;

  /** `GET /api/config/rate-card` — billing's STANDARD rate card. `null` = billing has no such route yet. */
  rateCard?(): Promise<RateCard | null>;
}

export interface MoneyTopupInput {
  amount: number;
  currency: string;
  idempotencyKey: string;
}
/** The tenant's PREPAID CREDIT, in USD (billing's credit ledger). */
export interface PrepaidCredit {
  grantedUsd: number;
  drawnUsd: number;
  remainingUsd: number;
  /** Last month (YYYY-MM) whose drawdown is frozen by a closed invoice; null = none yet. */
  settledThrough: string | null;
}
export interface MoneyTopupResult {
  replayed: boolean;
  amount: number;
  currency: string;
  /**
   * The credit AFTER the top-up, or `null` when billing answered 2xx with a body this client could
   * not read. ⛔ That is still a SUCCESS: billing has applied and invoiced the top-up, and reporting
   * it as a failure would invite the buyer to pay twice.
   */
  credit: PrepaidCredit | null;
}
export interface RateCard {
  currency: string;
  platformFeeUsd: number;
  seatFeeUsd: number;
  /** Markup % on platform-provided usage. */
  markupPct: number;
  /** Markup % on BYO usage — what CP's `markupPct` term is (billing_mode byo_markup_only). */
  byoMarkupPct: number;
  source: string;
}

/** Billing answered 404 to a top-up: the money-budget feature is off, or the tenant has no budget. */
export class BillingTopupUnavailableError extends BillingAdminError {
  constructor() {
    super(404, 'billing money top-up is not available (money budgets disabled, or no active budget)');
    this.name = 'BillingTopupUnavailableError';
  }
}
/** Billing answered 403 (`topup_writer_required`): CP's SA may not top up. */
export class BillingTopupForbiddenError extends BillingAdminError {
  constructor() {
    super(403, 'billing refused the top-up: the service account is not a top-up writer');
    this.name = 'BillingTopupForbiddenError';
  }
}

/** Billing refused a top-up as a conflict (`idempotency_key_reused`, `currency_mismatch`). */
export class BillingTopupConflictError extends BillingAdminError {
  constructor(readonly reason: string) {
    super(409, `billing refused the top-up: ${reason}`);
    this.name = 'BillingTopupConflictError';
  }
}

/** The three commercial terms CP states per tenant. USD amounts and a PERCENT (20 = 20 %). */
export interface TenantTerms {
  platformFeeUsd: number;
  seatFeeUsd: number;
  markupPct: number;
}

export interface BillingTermsView extends TenantTerms {
  billingMode: string;
  /** True when every term comes from a stated row, false when billing is riding its defaults. */
  fullyConfigured: boolean;
  /** Terms the PUT re-dated; `[]` on a GET and on an idempotent replay. */
  changed: string[];
}

/**
 * The money-budget CAP (a spend guard in the budget currency) — NOT the prepaid credit, which is
 * separate (`credit`, USD) and needs no money budget at all.
 */
export interface MoneyBudgetStatus {
  amount: number;
  currency: string;
  consumed: number;
  remaining: number;
  thresholdsCrossed: number[];
  /** The prepaid credit billing returns beside the cap; null when absent from the body. */
  credit?: PrepaidCredit | null;
}

/** The app whose licences billing counts as seats, and the service key CP's spend is emitted under
 *  (host/metering-emit.ts SERVICE_KEY). Equal today; two fields on billing's side on purpose. */
export const CP_BILLING_APP_KEY = 'commonpractice';
/** Billing's mode for Common Practice: a BYO line bills its markup, never the provider cost. */
export const CP_BILLING_MODE = 'byo_markup_only';

/** Resolve an OPTIONAL billing client method or throw 501 — same contract as licences' `adminMethod`. */
export function billingMethod<
  K extends 'commercialTerms' | 'putCommercialTerms' | 'moneyBudgetStatus' | 'moneyTopup' | 'rateCard' | 'prepaidCredit',
>(
  client: BillingAdminClient,
  name: K,
): NonNullable<BillingAdminClient[K]> {
  const fn = client[name];
  if (typeof fn !== 'function') {
    throw new BillingAdminError(501, `the configured billing client does not implement ${name}()`);
  }
  return (fn as (...a: unknown[]) => unknown).bind(client) as NonNullable<BillingAdminClient[K]>;
}

interface CachedToken {
  token: string;
  /** epoch ms after which the cached SA token must be refreshed. */
  expiresAt: number;
}

/** Service-token cache window, mirroring licenses-admin / keycloak-admin's 60 s. */
const TOKEN_TTL_MS = 60_000;

export class BillingAdminService implements BillingAdminClient {
  private readonly adminBaseUrl: string;
  private readonly tokenUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private cached?: CachedToken;

  constructor(opts: BillingAdminOptions = {}) {
    this.adminBaseUrl = (opts.adminBaseUrl ?? billingAdminBaseUrl()).replace(/\/+$/, '');
    // ⚠️ THE SAME `secure-apps` SERVICE ACCOUNT AS LICENCES, ON PURPOSE AND NOT BY ACCIDENT.
    // billing-service and licenses-service sit behind ONE auth boundary (the `secure-apps` realm —
    // see the CLAUDE.md two-realm split), so a second SA would be a second credential to rotate
    // for no additional isolation. It also means this client needs NO new config keys beyond the
    // base URL, which is what keeps `config.ts` out of this change. If billing ever moves to its
    // own realm or its own client, these three lines are the ONLY ones that change.
    this.tokenUrl = opts.tokenUrl ?? config.license.sa.tokenUrl;
    this.clientId = opts.clientId ?? config.license.sa.clientId;
    this.clientSecret = opts.clientSecret ?? config.license.sa.clientSecret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? config.license.adminTimeoutMs;
  }

  // ---- service token (client_credentials against secure-apps, 60s cache) ----

  async getServiceToken(): Promise<string> {
    const nowMs = this.now();
    if (this.cached && this.cached.expiresAt > nowMs) {
      return this.cached.token;
    }
    if (!this.tokenUrl) {
      throw new BillingAdminError(500, 'billing SA token URL not configured');
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    let res: Response;
    try {
      res = await this.fetchImpl(this.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new BillingAdminError(
        503,
        `billing SA token transport error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new BillingAdminError(res.status, `billing SA token request failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new BillingAdminError(502, 'billing SA token response missing access_token');
    }
    this.cached = { token: json.access_token, expiresAt: nowMs + TOKEN_TTL_MS };
    return json.access_token;
  }

  private adminUrl(path: string): string {
    return `${this.adminBaseUrl}/${path.replace(/^\/+/, '')}`;
  }

  private async authed(
    method: string,
    path: string,
    opts: { headers?: Record<string, string>; jsonBody?: unknown } = {},
  ): Promise<Response> {
    if (!this.adminBaseUrl) {
      // Checked BEFORE the token round-trip: an unconfigured deployment should not be pointed at
      // Keycloak on every page load to discover it has nowhere to send the result.
      throw new BillingAdminError(
        500,
        'billing admin base URL not configured (BILLING_ADMIN_BASE_URL) — refusing to report a ' +
          'bill this service cannot read',
      );
    }
    const token = await this.getServiceToken();
    let res: Response;
    try {
      res = await this.fetchImpl(this.adminUrl(path), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.jsonBody !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.headers ?? {}),
        },
        ...(opts.jsonBody !== undefined ? { body: JSON.stringify(opts.jsonBody) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new BillingAdminError(
        503,
        `billing admin transport error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return res;
  }

  /** Parse a 2xx JSON body, or throw. A body that is not JSON is a contract break, not an empty
   *  result — same rule as every non-2xx above. */
  private async json(res: Response, what: string): Promise<unknown> {
    if (!res.ok) {
      let detail: string | undefined;
      try {
        detail = (await res.text()).slice(0, 500) || undefined;
      } catch {
        detail = undefined;
      }
      throw new BillingAdminError(res.status, `${what} failed: HTTP ${res.status}`, detail);
    }
    try {
      return await res.json();
    } catch (err) {
      throw new BillingAdminError(
        502,
        `${what} returned a non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ---- reads ----

  async actorCosts(tenantId: string, start: string, end: string): Promise<BillingActorCost[]> {
    const q = `start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const res = await this.authed(
      'GET',
      `api/costs/tenant/${encodeURIComponent(tenantId)}/actors?${q}`,
      { headers: { 'X-Tenant-Id': tenantId } },
    );
    const body = await this.json(res, `read actor costs for tenant ${tenantId}`);
    // Accept either a bare array or `{actors: [...]}` — billing's list endpoints are not uniform
    // and guessing wrong here would be an EMPTY array, i.e. "this tenant spent nothing", which is
    // the one answer this module may never invent. Anything else throws.
    const raw = Array.isArray(body)
      ? body
      : Array.isArray((body as { actors?: unknown })?.actors)
        ? (body as { actors: unknown[] }).actors
        : null;
    if (!raw) {
      throw new BillingAdminError(
        502,
        `actor costs for tenant ${tenantId} were neither an array nor {actors: [...]} — refusing ` +
          `to read an unrecognised shape as "no spend"`,
      );
    }
    return raw.map((r) => {
      const row = (r ?? {}) as Record<string, unknown>;
      return {
        subjectId: str(row.subject_id ?? row.subjectId),
        actorId: str(row.actor_id ?? row.actorId),
        costUsd: numOrThrow(row.cost_usd ?? row.costUsd, `actor cost for tenant ${tenantId}`),
        // Events is a COUNT and a missing one is genuinely 0 rows — unlike money, a fabricated
        // zero here cannot be mistaken for a bill. It is carried for the log line only.
        events: Number(row.events ?? row.event_count ?? 0) || 0,
      };
    });
  }

  /**
   * `GET /api/billing/invoices/preview` → billing's `Envelope[InvoicePreviewResponse]`
   * (`{data: {...}, meta}`, routers/billing.py on main AND billing PR #267). ⛔ It has NO `lines`
   * array and money fields are Decimal STRINGS; the earlier parser read a bare object with `lines`,
   * so every real preview failed as "non-numeric amount (undefined)" → an `upstream_error` screen.
   * `basis: "no_basis"` (nothing measured this period; every money field null) is an ANSWER, not a
   * $0 bill: it is raised as a 404 so the route says "not available".
   */
  async invoicePreview(tenantId: string, period: string): Promise<BillingInvoicePreview> {
    const q = `tenant_id=${encodeURIComponent(tenantId)}&period=${encodeURIComponent(period)}`;
    const res = await this.authed('GET', `api/billing/invoices/preview?${q}`, {
      headers: { 'X-Tenant-Id': tenantId },
    });
    const body = unwrapData(await this.json(res, `read invoice preview for tenant ${tenantId}`));
    // ⛔ THE OWNERSHIP RE-CHECK. `tenant_id` went out in the query string AND the header; if what
    // comes back names a different tenant, something upstream ignored one of them and this client
    // is one `jsonResponse` away from rendering another company's bill inside this tenant's
    // screen. That is a refusal, not a warning.
    assertSameTenant(body.tenant_id, tenantId, 'invoice preview');
    if (body.basis === 'no_basis') {
      throw new BillingAdminError(404, `billing measured nothing for tenant ${tenantId} in ${period} (basis no_basis)`);
    }
    const what = `invoice preview for tenant ${tenantId}`;
    const totalUsd = numOrThrow(body.total_usd, what);
    const applied = optUsd(body.prepaid_credit_applied_usd, `credit applied for ${tenantId}`);
    flagNegativeCredit(body.prepaid_credit_remaining_usd, tenantId, 'prepaid_credit_remaining_usd');
    return {
      tenantId,
      period: str(body.period) || period,
      currency: 'USD',
      totalUsd,
      lines: previewLines(body, totalUsd, applied, what),
      ...withUsd('prepaidCreditAppliedUsd', applied),
      ...withUsd('prepaidCreditRemainingUsd', optUsd(body.prepaid_credit_remaining_usd, `credit remaining for ${tenantId}`)),
    };
  }

  /** `GET /api/billing/invoices?tenant_id=` → `Envelope[list[InvoiceSummary]]`. */
  async invoices(tenantId: string): Promise<BillingInvoice[]> {
    const res = await this.authed(
      'GET',
      `api/billing/invoices?tenant_id=${encodeURIComponent(tenantId)}`,
      { headers: { 'X-Tenant-Id': tenantId } },
    );
    const raw = (await this.json(res, `list invoices for tenant ${tenantId}`)) as Record<string, unknown> | unknown[];
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as Record<string, unknown>)?.data) ? ((raw as Record<string, unknown>).data as unknown[]) : null;
    if (!list) {
      throw new BillingAdminError(
        502,
        `invoice list for tenant ${tenantId} was neither an array nor {data: [...]} — ` +
          `refusing to read an unrecognised shape as "no invoices"`,
      );
    }
    // ⛔ ONE MALFORMED STATEMENT MUST NOT BLANK THE WHOLE LIST. Each row is parsed on its own: a row
    // of THIS tenant that cannot be read is listed as "details unavailable" (no amount — never a
    // fabricated one); a row naming ANOTHER tenant is dropped and logged (never shown).
    const out: BillingInvoice[] = [];
    list.forEach((r, i) => {
      try {
        out.push(parseInvoice(r, tenantId));
      } catch (err) {
        const row = unwrapData(r);
        const owner = str(row.tenant_id).toLowerCase();
        log.error('billing_invoice_unparsed', { tenantId, index: i, invoiceId: str(row.id) || null, err });
        if (owner && owner !== tenantId.toLowerCase()) return;
        out.push({
          id: str(row.id) || `unavailable-${i}`,
          tenantId,
          period: str(row.period_start).slice(0, 7),
          status: str(row.status),
          currency: 'USD',
          totalUsd: Number.NaN,
          lines: [],
          detailsUnavailable: true,
        });
      }
    });
    return out;
  }

  /** `GET /api/billing/invoices/{id}?tenant_id=` → `Envelope[InvoiceSummary]` (tenant_id REQUIRED). */
  async invoice(invoiceId: string, tenantId: string): Promise<BillingInvoice> {
    const res = await this.authed(
      'GET',
      `api/billing/invoices/${encodeURIComponent(invoiceId)}?tenant_id=${encodeURIComponent(tenantId)}`,
      { headers: { 'X-Tenant-Id': tenantId } },
    );
    return parseInvoice(unwrapData(await this.json(res, `read invoice ${invoiceId}`)), tenantId);
  }

  // ---- commercial terms + money budget ----

  async commercialTerms(tenantId: string): Promise<BillingTermsView> {
    const res = await this.authed(
      'GET',
      `api/config/tenants/${encodeURIComponent(tenantId)}/commercial-terms`,
    );
    return parseTermsView(await this.json(res, `read commercial terms of tenant ${tenantId}`), tenantId);
  }

  async putCommercialTerms(tenantId: string, terms: TenantTerms): Promise<BillingTermsView> {
    const res = await this.authed(
      'PUT',
      `api/config/tenants/${encodeURIComponent(tenantId)}/commercial-terms`,
      {
        jsonBody: {
          billing_mode: CP_BILLING_MODE,
          platform_fee_usd: terms.platformFeeUsd,
          seat_app_key: CP_BILLING_APP_KEY,
          seat_fee_usd: terms.seatFeeUsd,
          markup_service_key: CP_BILLING_APP_KEY,
          byo_markup_pct: terms.markupPct,
        },
      },
    );
    return parseTermsView(await this.json(res, `write commercial terms of tenant ${tenantId}`), tenantId);
  }

  async moneyBudgetStatus(tenantId: string): Promise<MoneyBudgetStatus | null> {
    const res = await this.authed(
      'GET',
      `api/budget/money/status/${encodeURIComponent(tenantId)}`,
      { headers: { 'X-Tenant-Id': tenantId } },
    );
    if (res.status === 404) return null;
    return parseMoneyStatus(await this.json(res, `read money budget of tenant ${tenantId}`), tenantId);
  }

  async moneyTopup(tenantId: string, input: MoneyTopupInput): Promise<MoneyTopupResult> {
    const res = await this.authed('POST', 'api/budget/money/topup', {
      headers: { 'X-Tenant-Id': tenantId },
      jsonBody: {
        tenant_id: tenantId,
        amount: input.amount,
        currency: input.currency,
        idempotency_key: input.idempotencyKey,
      },
    });
    if (res.status === 404) throw new BillingTopupUnavailableError();
    // 403 `topup_writer_required`: CP's service account is not allowed to buy credit — a
    // configuration fact about the SA, not an outage.
    if (res.status === 403) throw new BillingTopupForbiddenError();

    // 409 `idempotency_key_reused` / 422 `fx_rate_missing`: billing REFUSED, nothing was written.
    if (res.status === 409 || res.status === 422) {
      const body = (await res.json().catch(() => ({}))) as { reason?: string; detail?: { reason?: string } };
      throw new BillingTopupConflictError(body.detail?.reason ?? body.reason ?? (res.status === 422 ? 'refused' : 'conflict'));
    }
    // ⛔ FROM HERE BILLING HAS SAID YES (2xx): the credit exists and the charge is invoiced. A body
    // this client cannot read is logged and reported as "succeeded, balance unknown" — NEVER thrown
    // as a failure, which would surface as a 502 and invite the buyer to pay a second time.
    if (!res.ok) throw new BillingAdminError(res.status, `top up the credit of tenant ${tenantId} failed: HTTP ${res.status}`);
    let raw: unknown = null;
    try {
      raw = await res.json();
    } catch (err) {
      log.error('billing_topup_body_unreadable', { tenantId, idempotencyKey: input.idempotencyKey, err });
    }
    const body = unwrapData(raw);
    let credit: PrepaidCredit | null = null;
    try {
      if (body.tenant_id !== undefined) assertSameTenant(body.tenant_id, tenantId, 'money top-up');
      credit = parsePrepaidCredit(body.credit, tenantId);
    } catch (err) {
      log.error('billing_topup_body_unparsed', { tenantId, idempotencyKey: input.idempotencyKey, err });
    }
    return {
      replayed: body.replayed === true,
      amount: typeof body.amount === 'number' ? body.amount : input.amount,
      currency: str(body.currency) || input.currency,
      credit,
    };
  }

  async prepaidCredit(tenantId: string): Promise<PrepaidCredit | null> {
    const res = await this.authed('GET', `api/budget/money/credit/${encodeURIComponent(tenantId)}`, {
      headers: { 'X-Tenant-Id': tenantId },
    });
    if (res.status === 404) return null;
    return parsePrepaidCredit(unwrapData(await this.json(res, `read the prepaid credit of tenant ${tenantId}`)), tenantId);
  }

  async rateCard(): Promise<RateCard | null> {
    const res = await this.authed('GET', 'api/config/rate-card');
    if (res.status === 404) return null;
    const body = unwrapData(await this.json(res, 'read the standard rate card'));
    return {
      currency: str(body.currency) || 'USD',
      platformFeeUsd: numOrThrow(body.platform_fee_usd, 'rate card platform fee'),
      seatFeeUsd: numOrThrow(body.seat_fee_usd, 'rate card seat fee'),
      markupPct: numOrThrow(body.markup_pct, 'rate card markup'),
      byoMarkupPct: numOrThrow(body.byo_markup_pct, 'rate card BYO markup'),
      source: str(body.source),
    };
  }
}

/**
 * THE ONE ADAPTER for billing's prepaid-credit object (`credit` on the status and top-up bodies, and
 * the body of `GET /money/credit/{id}`) — billing PR #267 at 286a8b2:
 * `{currency: "USD", granted_usd, drawn_usd, remaining_usd, settled_through}`, amounts as strings.
 */
function parsePrepaidCredit(raw: unknown, tenantId: string): PrepaidCredit {
  const c = unwrapData(raw);
  flagNegativeCredit(c.remaining_usd, tenantId, 'credit.remaining_usd');
  return {
    grantedUsd: numOrThrow(c.granted_usd, `prepaid credit granted of ${tenantId}`),
    drawnUsd: numOrThrow(c.drawn_usd, `prepaid credit drawn of ${tenantId}`),
    remainingUsd: numOrThrow(c.remaining_usd, `prepaid credit remaining of ${tenantId}`),
    settledThrough: typeof c.settled_through === 'string' ? c.settled_through : null,
  };
}

/**
 * Prepaid credit cannot be negative: billing nets usage AGAINST the credit and bills the rest. A
 * negative figure is a billing anomaly — logged for an operator; the SPA clamps the display at $0.
 */
function flagNegativeCredit(v: unknown, tenantId: string, field: string): void {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (Number.isFinite(n) && n < 0) log.warn('billing_credit_negative', { tenantId, field, value: n });
}

/** Billing's money-budget STATUS → CP's view: the CAP fields, plus the separate prepaid credit. */
function parseMoneyStatus(raw: unknown, tenantId: string): MoneyBudgetStatus {
  const body = unwrapData(raw);
  let credit: PrepaidCredit | null = null;
  if (body.credit != null) {
    try {
      credit = parsePrepaidCredit(body.credit, tenantId);
    } catch (err) {
      log.warn('billing_status_credit_unparsed', { tenantId, err });
    }
  }
  return {
    amount: numOrThrow(body.amount, `money budget amount of ${tenantId}`),
    currency: str(body.currency) || 'USD',
    consumed: numOrThrow(body.consumed ?? 0, `money budget consumed of ${tenantId}`),
    remaining: numOrThrow(body.remaining, `money budget remaining of ${tenantId}`),
    thresholdsCrossed: Array.isArray(body.thresholds_crossed)
      ? body.thresholds_crossed.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : [],
    credit,
  };
}

/** Billing wraps most JSON in `{data, meta}`; accept a bare object too. */
function unwrapData(v: unknown): Record<string, unknown> {
  const o = (v ?? {}) as Record<string, unknown>;
  return (o.data && typeof o.data === 'object' ? o.data : o) as Record<string, unknown>;
}

function parseTermsView(raw: unknown, tenantId: string): BillingTermsView {
  const body = unwrapData(raw);
  assertSameTenant(body.tenant_id, tenantId, 'commercial terms');
  const term = (k: string): number => {
    const t = (body[k] ?? {}) as Record<string, unknown>;
    // An unstated term on a fresh tenant reads `value: null` — 0 here would be a fabricated price,
    // so it is NaN-free 0 only when billing said 0; null maps to 0 with `fullyConfigured` false.
    return t.value == null ? 0 : numOrThrow(t.value, `commercial term ${k} of ${tenantId}`);
  };
  return {
    billingMode: str(body.billing_mode),
    platformFeeUsd: term('platform_fee'),
    seatFeeUsd: term('seat_fee'),
    markupPct: term('byo_markup'),
    fullyConfigured: body.fully_configured === true,
    changed: Array.isArray(body.changed) ? body.changed.map(str) : [],
  };
}

// ---- parsing helpers (shared, so the list and the single read cannot drift) ----

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * A MONEY field, parsed or thrown — never defaulted.
 *
 * ⛔ THIS IS THE SINGLE MOST IMPORTANT FUNCTION IN THE FILE. `Number(undefined)` is `NaN` and
 * `Number(null)` is `0`; both of the obvious spellings (`Number(x) || 0`, `x ?? 0`) turn a field
 * billing did not send into a zero that renders as a real amount. A total that is missing is not a
 * total of zero. Every amount on the wire goes through here.
 */
function numOrThrow(v: unknown, what: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) {
    throw new BillingAdminError(
      502,
      `${what} carried a non-numeric amount (${JSON.stringify(v)}) — refusing to report it as 0`,
    );
  }
  return n;
}

function assertSameTenant(got: unknown, expected: string, what: string): void {
  const g = str(got);
  if (g && g.toLowerCase() !== expected.toLowerCase()) {
    throw new BillingAdminError(
      502,
      `${what} came back for tenant ${g}, not the tenant it was requested for (${expected}) — ` +
        `refusing to render another tenant's billing data`,
    );
  }
}

function withUsd<K extends string>(key: K, v: number | undefined): Partial<Record<K, number>> {
  return v === undefined ? {} : ({ [key]: v } as Record<K, number>);
}

/**
 * A statement's TOTAL COMPONENTS, exactly as billing defines them (`InvoiceSummary`, billing
 * `services.invoices._TOTAL_COMPONENT_COLUMNS`):
 *
 *   access_charge + seat_fee + llm_usage + llm_markup + app_usage + app_markup − prepaid_credit == total
 *
 * ⛔ `platform_fee_usd` IS NOT A COMPONENT. It is a surcharge already folded INSIDE the markup lines;
 * adding it as a line double-counts it (billing's model says "DO NOT ADD platform_fee_usd"). The
 * markup lines are SIGNED (billing_mode `internal` reads +X / −X), so a zero is skipped but a negative
 * is shown. The prepaid credit is shown by the SPA as its own deduction line.
 */
const INVOICE_COMPONENTS: Array<[kind: string, label: string, field: string, quantityField?: string]> = [
  ['access_charge', 'Access charges', 'access_charge_usd'],
  ['seats', 'Seats', 'seat_fee_usd', 'seat_count'],
  ['llm_usage', 'LLM usage', 'llm_usage_usd'],
  ['llm_markup', 'LLM markup', 'llm_markup_usd'],
  ['app_usage', 'App usage', 'app_request_usage_usd'],
  ['app_markup', 'App markup', 'app_request_markup_usd'],
];
/** Billing's own tolerance for the identity (`_TOTAL_IDENTITY_TOLERANCE_USD`): one cent. */
const TOTAL_IDENTITY_TOLERANCE_USD = 0.01;
const TOTAL_IDENTITY_TOLERANCE_CENTS = 1;

/**
 * A billing Decimal (string, or number) as INTEGER CENTS, rounded half-up (away from zero on the
 * absolute value, so a signed markup rounds symmetrically). ⛔ Never compare money as floats:
 * 0.04 − 0.03 is 0.010000000000000002 in binary, which "exceeds" a one-cent tolerance.
 */
export function toCents(v: unknown): number {
  const raw = (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : '').trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) {
    // Exponent notation from a number, etc.: fall back to a decimal rendering first.
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new BillingAdminError(502, `non-numeric money value ${JSON.stringify(v)}`);
    return toCents(n.toFixed(6));
  }
  const sign = m[1] === '-' ? -1 : 1;
  const frac = (m[3] ?? '').padEnd(3, '0');
  const cents = Number(m[2] || '0') * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
  return sign * cents;
}

/**
 * The PREVIEW names only two of the components — the flat ACCESS charge and the SEAT fee — not the
 * usage split. So the lines are those two (the access charge itemised, never folded into "usage":
 * a $5,000 flat-fee tenant must not read "usage $5,000"), plus the remainder as ONE line: usage and
 * markup billed this period = total + credit − access − seats. `platform_fee_usd` is inside the
 * markup (see INVOICE_COMPONENTS) and is never a line. A negative remainder is a contract mismatch:
 * logged, and not shown.
 */
function previewLines(
  body: Record<string, unknown>,
  totalUsd: number,
  creditAppliedUsd: number | undefined,
  what: string,
): BillingInvoiceLine[] {
  const { lines, sum } = componentLines(body, what, [
    ['access_charge', 'Access charges', 'access_charge_usd'],
    ['seats', 'Seats', 'seat_fee_usd', 'seat_count'],
  ]);
  const usage = Math.round((totalUsd + (creditAppliedUsd ?? 0) - sum) * 100) / 100;
  if (usage > 0) lines.push({ kind: 'usage_other', label: 'Usage and markup', amountUsd: usage });
  else if (usage < -TOTAL_IDENTITY_TOLERANCE_USD) {
    log.warn('billing_preview_components_exceed_total', { what, totalUsd, components: sum, creditAppliedUsd: creditAppliedUsd ?? null });
  }
  return lines;
}

function componentLines(
  body: Record<string, unknown>,
  what: string,
  specs: Array<[string, string, string, string?]>,
): { lines: BillingInvoiceLine[]; sum: number; sumCents: number } {
  const lines: BillingInvoiceLine[] = [];
  let sum = 0;
  let sumCents = 0;
  for (const [kind, label, field, qtyField] of specs) {
    const v = optUsd(body[field], `${what} ${field}`);
    if (v === undefined) continue;
    sum += v;
    sumCents += toCents(body[field]);
    if (v === 0) continue;
    const qty = qtyField ? body[qtyField] : undefined;
    lines.push({ kind, label, amountUsd: v, ...(typeof qty === 'number' ? { quantity: qty } : {}) });
  }
  return { lines, sum, sumCents };
}

/** One `InvoiceSummary` (billing main + PR #267): `id`, `period_start`, `status`, Decimal strings. */
function parseInvoice(r: unknown, tenantId: string): BillingInvoice {
  const row = unwrapData(r);
  const id = str(row.id);
  if (!id) throw new BillingAdminError(502, `invoice for tenant ${tenantId} carried no id`);
  // Same ownership re-check as the preview — see the ⛔ block there. On the single-invoice read
  // this is the ONLY thing standing between a guessed/leaked invoice id and another tenant's bill.
  assertSameTenant(row.tenant_id, tenantId, `invoice ${id}`);
  const what = `invoice ${id}`;
  const totalUsd = numOrThrow(row.total_usd, what);
  const applied = optUsd(row.prepaid_credit_applied_usd, `credit applied on ${what}`);
  const { lines, sum, sumCents } = componentLines(row, what, INVOICE_COMPONENTS);
  // ⛔ THE IDENTITY BILLING GATES A CLOSE ON, in INTEGER CENTS with billing's one-cent tolerance. If
  // the components do not add up to the total, the lines would contradict the amount charged:
  // refuse (an unknown bill), never render a wrong one.
  const gapCents = sumCents - (applied === undefined ? 0 : toCents(row.prepaid_credit_applied_usd)) - toCents(row.total_usd);
  if (Math.abs(gapCents) > TOTAL_IDENTITY_TOLERANCE_CENTS) {
    log.error('billing_invoice_components_mismatch', { what, totalUsd, components: sum, creditAppliedUsd: applied ?? null });
    throw new BillingAdminError(
      502,
      `${what}: its components (${sum.toFixed(2)}) minus credit (${(applied ?? 0).toFixed(2)}) do not equal its total (${totalUsd.toFixed(2)})`,
    );
  }
  const issuedAt = row.issued_at;
  return {
    id,
    tenantId,
    // `period_start` is a date (YYYY-MM-DD); the period is its month.
    period: str(row.period_start).slice(0, 7),
    status: str(row.status),
    currency: str(row.currency) || 'USD',
    totalUsd,
    lines,
    ...(issuedAt == null ? {} : { issuedAt: str(issuedAt) }),
    ...withUsd('prepaidCreditAppliedUsd', applied),
  };
}

/**
 * Is there a billing API to talk to at all?
 *
 * ⛔ THIS IS A DEPLOYMENT FACT, NOT A PERMISSION. It answers "is this deployment wired to billing",
 * which is the question `routes/billing-view.ts` asks in order to say `reason: 'not_configured'`
 * instead of `reason: 'upstream_error'` — two states an operator needs to tell apart, because one
 * is a gitops omission and the other is an incident. It is NOT an authorization check and must
 * never be used as one: the route's authority is `requireTenantAdmin`, always, whatever this says.
 *
 * Both halves are required for the same reason licences' equivalent needs both: with no base URL
 * `adminUrl()` builds a relative URL `fetch` rejects, and with no `sa.tokenUrl`
 * `getServiceToken()` throws before any request is built. Dev, CI and `bun test` set neither, so
 * this is false there and every billing read reports unavailable — VISIBLY.
 */
export function billingAdminConfigured(): boolean {
  // ⛔ AN INJECTED TEST CLIENT COUNTS AS CONFIGURED, AND WITHOUT THIS LINE THE TEST SEAM IS DEAD.
  // `__setBillingAdminForTests` replaces the CLIENT; it cannot set `BILLING_ADMIN_BASE_URL` or
  // `config.license.sa.tokenUrl` (the latter is frozen at module load). So a route that asks this
  // question before calling the client would answer `not_configured` in every test — including the
  // tests written to prove that an OUTAGE is reported as an outage, which would then pass while
  // exercising a completely different branch. A green suite that never reaches the fake is worse
  // than no suite. The override is only ever installed by `__setBillingAdminForTests`, which is the
  // same trust boundary `billingAdmin()` already relies on.
  if (_testOverride) return true;
  return Boolean(billingAdminBaseUrl() && config.license.sa.tokenUrl);
}

// ---- module accessor + test seam (mirrors licensesAdmin / __setLicensesAdminForTests) ----

let _instance: BillingAdminClient | undefined;
let _testOverride: BillingAdminClient | undefined;

/** Lazily-constructed default singleton. */
export function billingAdmin(): BillingAdminClient {
  if (_testOverride) return _testOverride;
  if (!_instance) _instance = new BillingAdminService();
  return _instance;
}

/** Inject a fake SA client in tests (paired with `(undefined)` teardown). */
export function __setBillingAdminForTests(fake: BillingAdminClient | undefined): void {
  _testOverride = fake;
  // ⚠️ The real singleton is dropped too. Without this, a test that installed a fake and then
  // cleared it would hand the NEXT caller a `BillingAdminService` built from whatever
  // `BILLING_ADMIN_BASE_URL` was at first construction — a stale instance surviving a config
  // change is exactly the shape of bug that makes a suite pass in isolation and fail in a run.
  if (fake === undefined) _instance = undefined;
}
