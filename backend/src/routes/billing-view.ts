// src/routes/billing-view.ts — what the customer is actually BILLED, read-only.
//
//   GET /api/billing/preview            tenant_admin — this period's bill (fee + seats + markup)
//   GET /api/billing/invoices           tenant_admin — this tenant's issued invoices
//   GET /api/billing/invoices/:id       tenant_admin — one issued invoice
//   GET /api/billing/my-usage           any member   — the CALLER'S OWN metered usage, from CP
//
// ⛔ THE FIRST THREE ARE A PROXY AND OWN NO FIGURES. Every number they return came from
// billing-service through `services/billing-admin.ts`; nothing here computes, estimates,
// re-prices, sums or completes a bill. CP's own `usage_events` ledger is a PRICED ESTIMATE of
// provider cost, and billing's invoice is the amount the customer pays (platform fee + seats +
// BYO markup %) — see the header of services/billing-admin.ts for why presenting one as the other
// is a fabrication even when the arithmetic happens to agree. `host/metering-reconcile.ts`
// measures the distance between the two; this file never closes it.
//
// ⛔ THE TENANT COMES FROM THE REQUEST CONTEXT AND FROM NOWHERE ELSE, WHICH IS WHY THERE IS NO
// `:tenantId` IN ANY PATH AND NO `?tenant_id=` READ ANYWHERE BELOW. Every sibling admin surface
// in this repo is spelled `/api/tenants/:id/...` and resolves the path id through
// `requireTenantAdmin(req, { pathTenantId })`, which is correct and enforced — but it makes the
// safety property a CHECK that has to keep being performed. Here the property is STRUCTURAL: the
// only tenant id that exists in these handlers is `effectiveTenantId` off the guard's own
// resolution, so there is no caller-supplied id to forget to compare. A `?tenant_id=` on the query
// string is therefore not rejected, not validated, and not read — it does not reach any code path
// (pinned by tests/billing-view.test.ts, which sends one and asserts the answer is unchanged).
//
// ⚠️ A super_admin CAN still read another tenant's bill, via the `X-Active-Tenant-Id` scope switch
// that `requireTenantAdmin` resolves — deliberately, because that is the ONE established,
// role-gated and AUDITED cross-tenant mechanism in this codebase (`resolveTenantScope` writes an
// `audit.scope_switch` row for it). A tenant_admin's header is silently ignored. Inventing a
// second cross-tenant path here, un-audited, would be the actual hole.
//
// ⛔ AND THE FOURTH ROUTE IS NOT ADMIN AT ALL, ON PURPOSE. `/api/billing/my-usage` answers "what
// have *I* spent", for an ordinary member with no admin role, and it is served from CP's OWN
// ledger with NO billing call: a member must not be able to pull the workspace's invoice, its
// seat count, or any other member's spend. Its filter is the VERIFIED `user.id` from
// `validateAuth`, never a path or query parameter — there is no `?user_id=` here either, for the
// same structural reason as above.
//
// ⛔ A BILLING OUTAGE IS AN EXPLICIT STATE, NEVER A ZERO. See `unavailable()` below — this is the
// single most load-bearing decision in the file.
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { requireTenantAdmin } from '../middleware/admin-guards';
import { validateAuth } from '../middleware/auth';
import {
  billingAdmin,
  billingAdminConfigured,
  BillingAdminError,
  type BillingInvoice,
  type BillingInvoicePreview,
} from '../services/billing-admin';
import { jsonResponse, notFound, route } from '../utils/http';
import { log } from '../host/logger';
import type { Router } from '../utils/router';

/**
 * Why a billing read could not be answered. Carried to the client so the two are distinguishable
 * WITHOUT reading a log: `not_configured` is a gitops omission (this deployment was never wired to
 * billing, and no amount of waiting fixes it), `upstream_error` is an incident (billing is there
 * and unwell, and retrying is the right action). Collapsing them into one "unavailable" would send
 * an operator to look at the wrong system.
 */
export type BillingUnavailableReason = 'not_configured' | 'upstream_error';

/**
 * ⛔ THE DISCRIMINANT IS MANDATORY ON BOTH ARMS, AND THAT IS THE WHOLE MECHANISM.
 *
 * The requirement is that "a zero bill" and "an unknown bill" never render the same. There were
 * three candidate shapes and only this one has that property:
 *
 *   (a) `{ totalUsd: 0 }` on failure — the defect, stated plainly. $0.00 is a legitimate bill for
 *       a tenant in a free trial, so the outage is INDISTINGUISHABLE from a real answer, and the
 *       customer is told they owe nothing by a system that does not know what they owe.
 *   (b) an HTTP 503 `billing_unavailable`. Correct in spirit and rejected here for a measured
 *       reason: `utils/http.ts serviceUnavailable()` carries an explicit warning that the SPA's
 *       error-copy scrape (`frontend/src/lib/api/error-message.backend-contract.test.ts`) does NOT
 *       read `serviceUnavailable(` or `new HttpError(503,`, so a new 503 code ships with no copy
 *       in any of the 8 locales and the whole suite stays green. A screen that renders a blank
 *       error is only marginally better than one that renders zero.
 *   (c) THIS — a 200 carrying a discriminated union. The success arm carries the money fields; the
 *       failure arm DOES NOT CARRY THEM AT ALL. So even a naive client that ignores `status` and
 *       reads `.totalUsd` gets `undefined`, which renders as blank or NaN — visibly wrong —
 *       rather than as `0`, which renders as a number the customer will believe.
 *
 * ⚠️ (c)'s cost is real and is not hidden: a 200 reads as success to any generic HTTP client, and
 * the SPA must branch on `status` to render the unavailable state properly. That is a frontend
 * contract this change does not own. The floor it guarantees on its own is the one that matters —
 * no fabricated number ever leaves this file.
 */
interface BillingUnavailable {
  status: 'unavailable';
  reason: BillingUnavailableReason;
  /** Upstream HTTP status when there was one, for an operator reading a HAR. */
  upstreamStatus?: number;
  message: string;
}

/**
 * The internal result of a billing read.
 *
 * ⛔ A SEPARATE `ok` FLAG, NOT `'status' in value`, AND THIS IS A BUG THAT WAS ACTUALLY WRITTEN
 * HERE BEFORE IT WAS CAUGHT. The obvious narrowing is `if ('status' in result) …it failed`, and it
 * is wrong for exactly one of the three reads: `BillingInvoice` HAS ITS OWN `status` field (paid /
 * open / void — billing's word, not ours). So every successfully-read invoice would have taken the
 * failure branch and been returned to the customer as "billing could not be reached", while the
 * preview — which has no such field — worked perfectly and made the bug look like an invoice-only
 * outage. The discriminant must live somewhere the payload cannot collide with, so it lives
 * outside the payload.
 */
type BillingRead<T> = { ok: true; value: T } | { ok: false; unavailable: BillingUnavailable };

function unavailable(reason: BillingUnavailableReason, upstreamStatus?: number): BillingUnavailable {
  return {
    status: 'unavailable',
    reason,
    ...(upstreamStatus == null ? {} : { upstreamStatus }),
    message:
      reason === 'not_configured'
        ? 'Billing is not connected to this deployment, so the amount due cannot be shown. This is a configuration gap, not a $0 balance.'
        : 'Billing could not be reached, so the amount due is unknown right now. This is not a $0 balance.',
  };
}

/**
 * Run a billing read, mapping EVERY failure to the explicit unavailable state.
 *
 * ⚠️ IT CATCHES BROADLY, AND THAT IS DELIBERATE RATHER THAN LAZY. A `BillingAdminError` is the
 * expected shape, but a `TypeError` out of a malformed response, an `AbortError` from the
 * per-call timeout, or anything else thrown between here and the socket has EXACTLY the same
 * meaning to the reader of this screen: the bill is unknown. The one outcome that must never
 * happen is a throw escaping to `route()`'s generic 500, where the SPA's own error handling would
 * be free to render an empty/zeroed panel. The cause is not swallowed — it is logged at `warn`
 * with the tenant, because gitops `rules.yaml` records that loki has no `ruler` stanza and a log
 * line is the human breadcrumb, not the alert.
 *
 * TODO(metrics): this is the natural home for a `billing_view_unavailable_total` counter, which
 * would be the alertable half. `host/metrics.ts incCounter` is lazy for unregistered names, so it
 * would need a `PRESEEDED_COUNTERS` entry to be visible to `increase()` on its first bump — that
 * file is owned by another change in flight and is deliberately not touched here.
 */
async function readBilling<T>(
  tenantId: string,
  what: string,
  read: () => Promise<T>,
): Promise<BillingRead<T>> {
  if (!billingAdminConfigured()) {
    log.warn('billing_view_unavailable', {
      component: 'billing',
      tenantId,
      what,
      reason: 'not_configured',
    });
    return { ok: false, unavailable: unavailable('not_configured') };
  }
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    // ⚠️ A 404 IS RETHROWN, NOT ABSORBED. "This invoice is not yours / does not exist" is an
    // ANSWER, and dressing it up as an outage would send the reader looking for an incident that
    // is not happening — and would hide a genuine authorization refusal behind a retry banner.
    // The one caller that can produce a 404 (`getInvoice`) converts it to a real 404.
    if (err instanceof BillingAdminError && err.status === 404) throw err;
    const upstreamStatus = err instanceof BillingAdminError ? err.status : undefined;
    log.warn('billing_view_unavailable', {
      component: 'billing',
      tenantId,
      what,
      reason: 'upstream_error',
      upstreamStatus: upstreamStatus ?? null,
      err,
    });
    return { ok: false, unavailable: unavailable('upstream_error', upstreamStatus) };
  }
}

/**
 * The billing period a preview is asked for: the CURRENT UTC month, `YYYY-MM`.
 *
 * ⚠️ UTC, NOT THE READER'S CLOCK, AND NOT A CALLER-SUPPLIED `?period=`. The invoice's period is a
 * fact billing owns; letting the browser name it would mean a tenant_admin in Auckland asking for
 * next month's bill on the 31st and getting a preview of a period that has not begun — or, worse,
 * a period selector that reads as a way to browse history and silently returns an empty preview
 * for any month billing has already closed. Past periods are what `GET /api/billing/invoices` is
 * for. Exported so the test can construct the same string rather than re-deriving it.
 */
export function currentBillingPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ---- tenant_admin: the bill ---------------------------------------------------------------

/** GET /api/billing/preview — this period's platform fee + seats + BYO markup, from billing. */
const getPreview = route(async (req) => {
  // ⛔ THE ONLY AUTHORITY IN THIS HANDLER. Copied verbatim from routes/tenant-users.ts — the role
  // check and the tenant resolution are ONE call, so there is no window in which the role has been
  // checked and the tenant has not (or vice versa). `effectiveTenantId` is the guard's answer, not
  // the request's suggestion.
  const { effectiveTenantId } = await requireTenantAdmin(req);
  const period = currentBillingPeriod();
  let read: BillingRead<BillingInvoicePreview>;
  try {
    read = await readBilling<BillingInvoicePreview>(effectiveTenantId, 'preview', () =>
      billingAdmin().invoicePreview(effectiveTenantId, period),
    );
  } catch (err) {
    if (is404(err)) billingNotAvailable('invoice preview');
    throw err;
  }
  // The period is echoed on BOTH arms: a reader who is told the bill is unknown still needs to
  // know WHICH month is unknown, and it is the one fact this handler owns without asking billing.
  if (!read.ok) return jsonResponse({ ...read.unavailable, period });
  return jsonResponse({ status: 'ok' as const, ...read.value });
});

/**
 * The 404 a list/preview read can get from billing — its route is not deployed yet, or it holds no
 * such data for the tenant. ⛔ That is an ANSWER, not a crash: it used to escape `readBilling` (which
 * rethrows 404s for the single-invoice read) and reach `route()` as a generic 500. It is a clean
 * 404 `billing_not_available` instead, and the SPA renders "not available", never a $0 bill.
 */
function billingNotAvailable(what: string): never {
  throw notFound('billing_not_available', `Billing has no ${what} for this workspace yet.`);
}
const is404 = (err: unknown) => err instanceof BillingAdminError && err.status === 404;

/** GET /api/billing/invoices — issued invoices for the caller's own tenant, newest first. */
const listInvoices = route(async (req) => {
  const { effectiveTenantId } = await requireTenantAdmin(req);
  let read: BillingRead<BillingInvoice[]>;
  try {
    read = await readBilling<BillingInvoice[]>(effectiveTenantId, 'invoices', () =>
      billingAdmin().invoices(effectiveTenantId),
    );
  } catch (err) {
    if (is404(err)) billingNotAvailable('invoices');
    throw err;
  }
  // ⛔ NO `invoices: []` ON THE FAILURE ARM. An empty list renders as "you have never been
  // invoiced", which is the list-shaped spelling of the $0.00 bill this whole file refuses to
  // fabricate. The key is ABSENT when the answer is unknown.
  if (!read.ok) return jsonResponse(read.unavailable);
  return jsonResponse({ status: 'ok' as const, invoices: read.value });
});

/**
 * GET /api/billing/invoices/:invoiceId — one issued invoice.
 *
 * ⚠️ THE OWNERSHIP CHECK HAPPENS TWICE AND BOTH ARE LOAD-BEARING. The tenant goes to billing as
 * `X-Tenant-Id` so billing can refuse a foreign invoice, AND `services/billing-admin.ts`
 * re-asserts the returned `tenant_id` against the one asked for. A caller who guesses or is leaked
 * an invoice id from another workspace hits a 404 from billing (first check) or a
 * `BillingAdminError(502)` here (second) — and the second exists because "billing enforces it" is
 * a claim about another repo's code, which this file cannot pin with a test.
 *
 * A 404 from billing surfaces as an ordinary `notFound`, NOT as the unavailable state: "this
 * invoice does not exist for you" is an answer, and dressing it up as an outage would send the
 * reader to look for an incident that is not happening.
 */
const getInvoice = route(async (req, invoiceId) => {
  const { effectiveTenantId } = await requireTenantAdmin(req);
  const id = invoiceId!;
  let read: BillingRead<BillingInvoice>;
  try {
    read = await readBilling<BillingInvoice>(effectiveTenantId, 'invoice', () =>
      billingAdmin().invoice(id, effectiveTenantId),
    );
  } catch (err) {
    // `readBilling` rethrows only the 404 — see its catch block.
    if (err instanceof BillingAdminError && err.status === 404) {
      throw notFound('invoice_not_found', 'No such invoice for this workspace');
    }
    throw err;
  }
  if (!read.ok) return jsonResponse(read.unavailable);
  return jsonResponse({ status: 'ok' as const, invoice: read.value });
});

// ---- any member: their own usage, from CP's own ledger ------------------------------------

/** Clamp of `?days=`. 1 is the floor because 0 would make every window empty and read as "you have
 *  spent nothing"; 90 is the ceiling because `usage_events_user_created_idx` serves this query and
 *  an unbounded range turns a member's own screen into a full-table scan. */
function rangeDaysFromQuery(url: URL): number {
  const raw = Number.parseInt(url.searchParams.get('days') ?? '', 10);
  if (!Number.isFinite(raw)) return 30;
  return Math.min(90, Math.max(1, raw));
}

/**
 * GET /api/billing/my-usage — the caller's OWN metered LLM usage from CP's `usage_events`.
 *
 * ⛔ NO BILLING CALL, AND NO CALLER-SUPPLIED IDENTITY. Two separate refusals in one route:
 *
 *  1. It does not touch billing-service. A member is not entitled to the workspace's invoice, its
 *     seat count or its markup rate, and the cheapest way to guarantee that is for this handler to
 *     have no billing client in scope at all.
 *  2. The filter is `user.id` from `validateAuth` — the verified token subject. There is no
 *     `:userId` in the path and no `?user_id=` read, so "show me someone else's usage" is not a
 *     request this endpoint can express. Pinned by tests/billing-view.test.ts, which seeds two
 *     members in ONE tenant (so RLS alone would let both rows through) and asserts the caller sees
 *     exactly their own.
 *
 * ⚠️ `platform_actor` ROWS ARE EXCLUDED, matching host/usage-metrics.ts's `HUMAN_ONLY`. A
 * background drainer's call carries a real person's `user_id` (migration 0063 and the long block
 * at the top of usage-metrics.ts), so without this a member's personal screen credits them with
 * work the platform did — which on a PER-PERSON screen is the most misleading place it can appear.
 *
 * ⚠️ `estimated` IS NOT DECORATION. `price_source` NULL or 'flat' means the figure is a
 * two-constant guess, not a vendor charge, and the SPA hedges the total with a tilde on the
 * strength of this flag. Dropping it would make an estimate read as an invoice — the same class of
 * claim this whole file exists to avoid.
 */
const getMyUsage = route(async (req) => {
  const user = await validateAuth(req);
  const rangeDays = rangeDaysFromQuery(new URL(req.url));

  const [totals] = (await db.execute(sql`
    SELECT COALESCE(SUM(ue.cost_usd), 0) AS spend,
           COUNT(*)::int AS calls,
           BOOL_OR(ue.price_source IS NULL OR ue.price_source IN ('flat', 'abort_estimate')) AS estimated
      FROM usage_events ue
     WHERE ue.user_id = ${user.id}
       AND ue.created_at >= now() - make_interval(days => ${rangeDays})
       AND NOT ue.platform_actor
  `)) as unknown as { spend: string | number; calls: number; estimated: boolean | null }[];

  const byModel = (await db.execute(sql`
    SELECT ue.model AS model,
           MAX(ue.provider) AS provider,
           COUNT(*)::int AS calls,
           COALESCE(SUM(ue.cost_usd), 0) AS spend
      FROM usage_events ue
     WHERE ue.user_id = ${user.id}
       AND ue.created_at >= now() - make_interval(days => ${rangeDays})
       AND NOT ue.platform_actor
     GROUP BY ue.model
     ORDER BY spend DESC, calls DESC
     LIMIT 20
  `)) as unknown as { model: string; provider: string | null; calls: number; spend: string | number }[];

  return jsonResponse({
    status: 'ok' as const,
    // Echoed so a reader (and the test) can see WHOSE usage this is without inferring it from the
    // token. It is the verified id, so echoing it discloses nothing the caller did not present.
    userId: user.id,
    rangeDays,
    calls: Number(totals?.calls ?? 0),
    spendUsd: Number(totals?.spend ?? 0),
    estimated: totals?.estimated === true,
    byModel: byModel.map((r) => ({
      model: String(r.model),
      provider: r.provider == null ? '' : String(r.provider),
      calls: Number(r.calls),
      spendUsd: Number(r.spend),
    })),
  });
});

export function registerBillingViewRoutes(router: Router): void {
  router.add('GET', '/api/billing/preview', getPreview);
  router.add('GET', '/api/billing/invoices', listInvoices);
  router.add('GET', '/api/billing/invoices/:invoiceId', getInvoice);
  router.add('GET', '/api/billing/my-usage', getMyUsage);
}
