// tests/billing-topup-http.test.ts — the REAL billing HTTP adapter (BillingAdminService) against a
// stub server answering billing PR #267's exact wire shapes (contract matched at head 286a8b2).
//
// ⛔ WHY A WIRE TEST AND NOT A FAKE CLIENT. The first cut parsed `body.balance`, while #267 answers
// `credit{granted_usd, drawn_usd, remaining_usd}`: every successful, INVOICED top-up came back as a
// 502 and wrote no audit row — and a fake client that returns CP's own shape could never notice.
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, tenants, auditLog } from '../src/db/client';
import {
  BillingAdminService,
  BillingTopupUnavailableError,
  __setBillingAdminForTests,
} from '../src/services/billing-admin';
import { Router } from '../src/utils/router';
import { registerAdminRoutes } from '../src/routes/admin';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import type { User } from '../src/types';

const TENANT = '00000000-0000-4000-8000-0000b0b0d201';
const admin: User = {
  id: '00000000-0000-4000-8000-0000b0b0d2a1',
  email: 'topup.http@test.dev',
  name: 'Topup HTTP',
  roles: ['tenant_admin'],
  tenantId: TENANT,
};

/** #267's `MoneyTopupResponse` (src/models/domain.py), verbatim field names, amounts as strings. */
function topupBody(key: string, replayed = false) {
  return {
    topup_id: '01a1c0de-0000-7000-8000-000000000001',
    tenant_id: TENANT,
    idempotency_key: key,
    replayed,
    amount: 50,
    currency: 'USD',
    credit_usd: '50.00',
    invoice_line: {
      access_charge_id: 4242,
      service_key: 'topup:01a1c0de-0000-7000-8000-000000000001',
      cadence: 'one_time',
      amount_usd: '50.00',
      fx_rate: '1',
      effective_from: '2026-10-13T10:00:00Z',
    },
    created_at: '2026-10-13T10:00:00Z',
    credit: { currency: 'USD', granted_usd: '150.00', drawn_usd: '12.34', remaining_usd: '137.66', settled_through: '2026-09' },
  };
}

let mode: 'ok' | 'flag_off' | 'garbage' | 'conflict' | 'fx_missing' | 'no_basis' | 'forbidden' | 'custom' = 'ok';
/** For mode 'custom': the exact body the stub answers on the preview / invoice-list routes. */
let customPreview: unknown = null;
let customInvoices: unknown = null;

// ---- billing's REAL response models, field for field ------------------------------------------
// Copied from billing-service `src/models/domain.py` at PR #267 head ebb4dc8 (`InvoicePreviewResponse`,
// `InvoicePreviewExclusions`, `InvoiceResponse` + `InvoiceSummary`) and `Envelope`/`Meta`; the routes
// (`routers/billing.py` `preview_invoice` :1147, `list_invoices` :961, `get_invoice` :1355) all
// answer `Envelope[...]`. Decimals serialise as STRINGS. There is NO `lines` array on any of them.
const PREVIEW_ENVELOPE = {
  data: {
    tenant_id: TENANT,
    period: '2026-10',
    period_start: '2026-10-01',
    period_end: '2026-11-01',
    basis: 'rollup',
    cost_rollup_rows: 12,
    metering_rollup_rows: 0,
    access_charge_terms: 2,
    // access 5000 + seats 1000 + usage&markup 140 − credit 20 = 6120.
    total_usd: '6120.00',
    internal_cost_usd: '30.00',
    margin_usd: '90.00',
    access_charge_usd: '5000.00',
    platform_fee_usd: '50.00',
    seat_fee_usd: '1000.00',
    seat_count: 40,
    seat_basis: 'active_during_period',
    effective_markup_pct: 20.0,
    billing_mode: 'byo_markup_only',
    prepaid_credit_applied_usd: '20.00',
    prepaid_credit_remaining_usd: '117.66',
    exclusions: { basis: 'raw_cost_events', excluded_usd: '0.00', excluded_rows: 0, by_reason: {} },
  },
  meta: { request_id: 'r-1', next_cursor: null, total: null },
};
/** basis no_basis: nothing measured, EVERY money field null — an answer, never a $0 bill. */
const PREVIEW_NO_BASIS = {
  data: {
    ...PREVIEW_ENVELOPE.data,
    basis: 'no_basis',
    cost_rollup_rows: 0,
    access_charge_terms: 0,
    total_usd: null,
    internal_cost_usd: null,
    margin_usd: null,
    access_charge_usd: null,
    platform_fee_usd: null,
    seat_fee_usd: null,
    seat_count: null,
    seat_basis: null,
    effective_markup_pct: null,
    billing_mode: null,
    prepaid_credit_applied_usd: null,
    prepaid_credit_remaining_usd: null,
    exclusions: { basis: 'not_applicable_no_basis', excluded_usd: null, excluded_rows: null, by_reason: null },
  },
  meta: { request_id: 'r-1b', next_cursor: null, total: null },
};
const INVOICE = {
  id: '01a1d00d-0000-7000-8000-000000000001',
  tenant_id: TENANT,
  tenant_name: 'Topup HTTP',
  period_start: '2026-09-01',
  period_end: '2026-10-01',
  status: 'issued',
  invoice_number: 'INV-2026-0001',
  currency: 'USD',
  // billing's identity (InvoiceSummary): access 5000 + seats 1000 + llm 0 + markup 90 + app 0 + 0
  // − credit 10 == total 6080. platform_fee_usd (50) is INSIDE the markup, not a component.
  subtotal_usd: '6090.00',
  total_usd: '6080.00',
  access_charge_usd: '5000.00',
  platform_fee_usd: '50.00',
  markup_pct: '20',
  effective_markup_pct: '20',
  markup_source: 'tenant_config',
  excluded_unbillable_usd: '0.00',
  excluded_unbillable_rows: 0,
  excluded_by_status: {},
  generator_version: 'v3',
  created_at: '2026-10-01T03:00:00Z',
  issued_at: '2026-10-01T03:00:01Z',
  voided_at: null,
  void_reason: null,
  internal_cost_usd: '60.00',
  margin_usd: '30.00',
  llm_usage_usd: '0.00',
  llm_markup_usd: '90.00',
  app_request_usage_usd: '0.00',
  app_request_markup_usd: '0.00',
  seat_fee_usd: '1000.00',
  seat_count: 40,
  prepaid_credit_applied_usd: '10.00',
  billing_mode: 'byo_markup_only',
};
const INVOICES_ENVELOPE = { data: [INVOICE], meta: { request_id: 'r-2', next_cursor: null, total: 1 } };
const seen: Array<{ path: string; body: unknown; tenantHeader: string | null }> = [];
let server: ReturnType<typeof Bun.serve>;
let base = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/token') return Response.json({ access_token: 'sa-token' });
      const body = req.method === 'POST' ? await req.json() : null;
      seen.push({ path: url.pathname, body, tenantHeader: req.headers.get('x-tenant-id') });
      if (url.pathname === '/api/budget/money/topup') {
        if (mode === 'flag_off') return Response.json({ detail: 'Not Found' }, { status: 404 });
        if (mode === 'conflict') return Response.json({ detail: { reason: 'idempotency_key_reused' } }, { status: 409 });
        if (mode === 'fx_missing') return Response.json({ reason: 'fx_rate_missing' }, { status: 422 });
        if (mode === 'forbidden') return Response.json({ detail: { reason: 'topup_writer_required' } }, { status: 403 });
        if (mode === 'garbage') return new Response('<html>ok</html>', { status: 201 });
        return Response.json(topupBody((body as { idempotency_key: string }).idempotency_key), { status: 201 });
      }
      if (url.pathname === '/api/billing/invoices/preview') {
        if (mode === 'custom') return Response.json(customPreview);
        return Response.json(mode === 'no_basis' ? PREVIEW_NO_BASIS : PREVIEW_ENVELOPE);
      }
      if (url.pathname === '/api/billing/invoices') {
        return Response.json(mode === 'custom' ? customInvoices : INVOICES_ENVELOPE);
      }
      if (url.pathname === `/api/billing/invoices/${INVOICE.id}`) {
        seen.push({ path: `${url.pathname}?tenant_id=${url.searchParams.get('tenant_id')}`, body: null, tenantHeader: null });
        if (mode === 'custom') return Response.json(envelope((customInvoices as { data: unknown[] }).data[0]));
        return Response.json({ data: INVOICE, meta: { request_id: 'r-3', next_cursor: null, total: null } });
      }
      if (url.pathname === `/api/budget/money/credit/${TENANT}`) {
        if (mode === 'flag_off') return Response.json({ detail: 'Not Found' }, { status: 404 });
        return Response.json(topupBody('x').credit);
      }
      return new Response('no route', { status: 500 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  server.stop(true);
  __setBillingAdminForTests(undefined);
  __setAuthOverridesForTests(undefined);
  await db.delete(auditLog).where(eq(auditLog.target_id, TENANT)).catch(() => {});
  await db.delete(tenants).where(eq(tenants.id, TENANT));
}, 30_000);
beforeEach(() => {
  mode = 'ok';
  seen.length = 0;
});

const client = () =>
  new BillingAdminService({ adminBaseUrl: base, tokenUrl: `${base}/token`, clientId: 'cp', clientSecret: 's' });

test('moneyTopup sends #267’s request and reads the CREDIT it returns (USD strings → numbers)', async () => {
  const out = await client().moneyTopup(TENANT, { amount: 50, currency: 'USD', idempotencyKey: 'intent-0001-abcdef' });
  expect(seen[0]).toEqual({
    path: '/api/budget/money/topup',
    body: { tenant_id: TENANT, amount: 50, currency: 'USD', idempotency_key: 'intent-0001-abcdef' },
    tenantHeader: TENANT,
  });
  expect(out).toEqual({
    replayed: false,
    amount: 50,
    currency: 'USD',
    credit: { grantedUsd: 150, drawnUsd: 12.34, remainingUsd: 137.66, settledThrough: '2026-09' },
  });
});

test('a 404 from the top-up route (feature flag off) is BillingTopupUnavailableError', async () => {
  mode = 'flag_off';
  await expect(
    client().moneyTopup(TENANT, { amount: 5, currency: 'USD', idempotencyKey: 'intent-0002-abcdef' }),
  ).rejects.toBeInstanceOf(BillingTopupUnavailableError);
});

test('⛔ a 2xx whose body cannot be read is still a SUCCESS (balance unknown), never a failure', async () => {
  mode = 'garbage';
  const out = await client().moneyTopup(TENANT, { amount: 5, currency: 'USD', idempotencyKey: 'intent-0003-abcdef' });
  expect(out.credit).toBeNull();
  expect(out.amount).toBe(5);
});

test('prepaidCredit reads GET /money/credit/{id}; 404 → null', async () => {
  expect(await client().prepaidCredit(TENANT)).toEqual({
    grantedUsd: 150,
    drawnUsd: 12.34,
    remainingUsd: 137.66,
    settledThrough: '2026-09',
  });
  mode = 'flag_off';
  expect(await client().prepaidCredit(TENANT)).toBeNull();
});

// ---- the CP route over the REAL adapter --------------------------------------------------------

const router = new Router();
registerAdminRoutes(router);
async function post(body: unknown): Promise<Response> {
  const path = `/api/tenants/${TENANT}/budget/topup`;
  const m = router.match('POST', path)!;
  return m.handler(
    new Request(`http://t${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ...m.params,
  );
}

test('route over the real adapter: 2xx → 200 with the credit + an audit row; flag off → 409; garbage 2xx → 200 balanceKnown:false', async () => {
  await db.insert(tenants).values({ id: TENANT, name: 'Topup HTTP', slug: 'topup-http-d201' }).onConflictDoNothing();
  __setAuthOverridesForTests({ validateAuth: async () => admin });
  __setBillingAdminForTests(client());

  const ok = await post({ amount: 50, idempotencyKey: 'intent-0004-abcdef' });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({
    credit: { grantedUsd: 150, drawnUsd: 12.34, remainingUsd: 137.66, settledThrough: '2026-09' },
    replayed: false,
    balanceKnown: true,
  });
  const audits = await db.select().from(auditLog).where(eq(auditLog.target_id, TENANT));
  expect(audits.some((a) => a.action === 'tenant.budget_topup')).toBe(true);

  mode = 'flag_off';
  const off = await post({ amount: 50, idempotencyKey: 'intent-0005-abcdef' });
  expect(off.status).toBe(409);
  expect(((await off.json()) as { error: string }).error).toBe('billing_topup_unavailable');

  mode = 'garbage';
  const unknown = await post({ amount: 50, idempotencyKey: 'intent-0006-abcdef' });
  expect(unknown.status).toBe(200);
  expect(((await unknown.json()) as { balanceKnown: boolean }).balanceKnown).toBe(false);
}, 30_000);

test('422 fx_rate_missing is a REFUSAL (BillingTopupConflictError), not a 502 outage', async () => {
  const { BillingTopupConflictError } = await import('../src/services/billing-admin');
  mode = 'fx_missing';
  const err = await client()
    .moneyTopup(TENANT, { amount: 5, currency: 'USD', idempotencyKey: 'intent-0007-abcdef' })
    .catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BillingTopupConflictError);
  expect((err as { reason: string }).reason).toBe('fx_rate_missing');
});

test("the preview parses billing's REAL Envelope[InvoicePreviewResponse] — no `lines`, Decimal strings, live credit", async () => {
  const preview = await client().invoicePreview(TENANT, '2026-10');
  expect(preview.totalUsd).toBe(6120);
  expect(preview.prepaidCreditAppliedUsd).toBe(20);
  expect(preview.prepaidCreditRemainingUsd).toBe(117.66);
  expect(preview.lines).toEqual([
    { kind: 'access_charge', label: 'Access charges', amountUsd: 5000 },
    { kind: 'seats', label: 'Seats', amountUsd: 1000, quantity: 40 },
    // 6120 + 20 (credit, already deducted) − 6000 (access + seats): the usage and markup.
    { kind: 'usage_other', label: 'Usage and markup', amountUsd: 140 },
  ]);
  // The platform fee (50) is NOT a line — it is inside the markup.
  expect(preview.lines.some((l) => l.kind === 'platform_fee')).toBe(false);
});

test('a no_basis preview (nothing measured) is a 404 — "not available", never a $0 bill', async () => {
  mode = 'no_basis';
  const err = await client().invoicePreview(TENANT, '2026-10').catch((e: unknown) => e);
  expect((err as { status: number }).status).toBe(404);
});

test("invoices + one invoice parse billing's REAL Envelope[InvoiceSummary]; the detail read sends tenant_id", async () => {
  const [inv] = await client().invoices(TENANT);
  expect(inv).toMatchObject({ id: INVOICE.id, period: '2026-09', status: 'issued', totalUsd: 6080, prepaidCreditAppliedUsd: 10 });
  expect(inv!.lines.map((l) => [l.kind, l.amountUsd])).toEqual([
    ['access_charge', 5000],
    ['seats', 1000],
    ['llm_markup', 90],
  ]);
  // The lines minus the credit ARE the total.
  expect(inv!.lines.reduce((a, l) => a + l.amountUsd, 0) - 10).toBe(6080);
  const one = await client().invoice(INVOICE.id, TENANT);
  expect(one.id).toBe(INVOICE.id);
  expect(seen.some((x) => x.path === `/api/billing/invoices/${INVOICE.id}?tenant_id=${TENANT}`)).toBe(true);
});

test('billing 403 topup_writer_required → 409 billing_topup_forbidden with a clear message and NO raw upstream text', async () => {
  await db.insert(tenants).values({ id: TENANT, name: 'Topup HTTP', slug: 'topup-http-d201' }).onConflictDoNothing();
  __setAuthOverridesForTests({ validateAuth: async () => admin });
  __setBillingAdminForTests(client());
  mode = 'forbidden';
  const res = await post({ amount: 5, idempotencyKey: 'intent-0008-abcdef' });
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error: string; message: string };
  expect(body.error).toBe('billing_topup_forbidden');
  expect(body.message).toBe('Top-up is not permitted for this service account — contact support.');
  expect(JSON.stringify(body)).not.toContain('topup_writer_required');
  expect(JSON.stringify(body)).not.toContain('HTTP 403');
}, 30_000);

// ---- billing's total identity, the access charge, tenant ownership, negative credit -------------

const envelope = (data: unknown) => ({ data, meta: { request_id: 'r-x', next_cursor: null, total: null } });

test('⛔ the platform fee is NOT counted twice: total 60, platform fee 50, LLM markup 60 → the lines sum to 60', async () => {
  mode = 'custom';
  customInvoices = envelope([
    {
      ...INVOICE,
      total_usd: '60.00',
      subtotal_usd: '60.00',
      access_charge_usd: '0.00',
      seat_fee_usd: '0.00',
      seat_count: null,
      llm_usage_usd: '0.00',
      llm_markup_usd: '60.00',
      app_request_usage_usd: '0.00',
      app_request_markup_usd: '0.00',
      platform_fee_usd: '50.00',
      prepaid_credit_applied_usd: '0.00',
    },
  ]);
  const [inv] = await client().invoices(TENANT);
  expect(inv!.lines.reduce((a, l) => a + l.amountUsd, 0)).toBe(60);
  expect(inv!.lines).toEqual([{ kind: 'llm_markup', label: 'LLM markup', amountUsd: 60 }]);
});

test('⛔ an invoice whose components do not add up to its total is REFUSED (502) on the detail read', async () => {
  mode = 'custom';
  // The previous, impossible fixture: components 7080 against a total of 6090.
  customInvoices = envelope([
    { ...INVOICE, total_usd: '6090.00', access_charge_usd: '6000.00', llm_usage_usd: '75.00', llm_markup_usd: '15.00' },
  ]);
  const err = await client().invoice(INVOICE.id, TENANT).catch((e: unknown) => e);
  expect((err as { status: number }).status).toBe(502);
});

test('⛔ ONE malformed invoice does not blank the list: it is listed as "details unavailable", the rest still show', async () => {
  mode = 'custom';
  const good = { ...INVOICE, id: '01a1d00d-0000-7000-8000-0000000000a1' };
  const bad = { ...INVOICE, id: '01a1d00d-0000-7000-8000-0000000000b2', total_usd: '6090.00', llm_markup_usd: '15.00' };
  customInvoices = envelope([good, bad]);
  const list = await client().invoices(TENANT);
  expect(list).toHaveLength(2);
  expect(list[0]).toMatchObject({ id: good.id, totalUsd: 6080 });
  expect(list[0]!.detailsUnavailable).toBeUndefined();
  expect(list[1]).toMatchObject({ id: bad.id, detailsUnavailable: true, period: '2026-09', lines: [] });
  expect(Number.isNaN(list[1]!.totalUsd)).toBe(true); // never a fabricated amount
});

/** One invoice whose only component is `markup`, against `total` (credit 0). */
const oneComponent = (markup: string, total: string) =>
  envelope([
    {
      ...INVOICE,
      total_usd: total,
      access_charge_usd: '0.00',
      seat_fee_usd: '0.00',
      seat_count: null,
      llm_usage_usd: '0.00',
      llm_markup_usd: markup,
      app_request_usage_usd: '0.00',
      app_request_markup_usd: '0.00',
      prepaid_credit_applied_usd: '0.00',
    },
  ]);

test('⛔ the identity is compared in INTEGER CENTS: 0.04 vs 0.03 is a 1-cent gap and passes (floats say 0.010000000000000002)', async () => {
  mode = 'custom';
  customInvoices = oneComponent('0.04', '0.03');
  const inv = await client().invoice(INVOICE.id, TENANT);
  expect(inv.totalUsd).toBe(0.03);
});

test('⛔ billing’s one-cent tolerance: a 1-cent gap passes, a 2-cent gap is refused', async () => {
  mode = 'custom';
  customInvoices = oneComponent('60.00', '60.01');
  expect((await client().invoice(INVOICE.id, TENANT)).totalUsd).toBe(60.01);
  customInvoices = oneComponent('60.00', '60.02');
  const err = await client().invoice(INVOICE.id, TENANT).catch((e: unknown) => e);
  expect((err as { status: number }).status).toBe(502);
});

test('the preview itemises the FLAT ACCESS CHARGE: a $5,000 flat-fee tenant with no usage shows access charges, not "usage"', async () => {
  mode = 'custom';
  customPreview = envelope({
    ...PREVIEW_ENVELOPE.data,
    total_usd: '5000.00',
    access_charge_usd: '5000.00',
    platform_fee_usd: '0.00',
    seat_fee_usd: '0.00',
    seat_count: null,
    prepaid_credit_applied_usd: '0.00',
    prepaid_credit_remaining_usd: '0.00',
  });
  const preview = await client().invoicePreview(TENANT, '2026-10');
  expect(preview.lines).toEqual([{ kind: 'access_charge', label: 'Access charges', amountUsd: 5000 }]);
});

test('a preview or invoice naming ANOTHER tenant is refused (assertSameTenant)', async () => {
  mode = 'custom';
  const OTHER = '00000000-0000-4000-8000-0000b0b0dfff';
  customPreview = envelope({ ...PREVIEW_ENVELOPE.data, tenant_id: OTHER });
  customInvoices = envelope([{ ...INVOICE, tenant_id: OTHER }]);
  const p = await client().invoicePreview(TENANT, '2026-10').catch((e: unknown) => e);
  expect((p as { status: number }).status).toBe(502);
  // In the LIST a foreign row is DROPPED (never shown, not even as "details unavailable").
  expect(await client().invoices(TENANT)).toEqual([]);
  const d = await client().invoice(INVOICE.id, TENANT).catch((e: unknown) => e);
  expect((d as { status: number }).status).toBe(502);
});

test('a NEGATIVE credit from billing is logged as billing_credit_negative', async () => {
  const warned: string[] = [];
  const realWarn = console.warn;
  const realLog = console.log;
  const grab = (...a: unknown[]) => void warned.push(a.map(String).join(' '));
  console.warn = grab;
  console.log = grab;
  try {
    mode = 'custom';
    customPreview = envelope({ ...PREVIEW_ENVELOPE.data, prepaid_credit_remaining_usd: '-5.00' });
    await client().invoicePreview(TENANT, '2026-10');
  } finally {
    console.warn = realWarn;
    console.log = realLog;
  }
  expect(warned.some((w) => w.includes('billing_credit_negative'))).toBe(true);
});
