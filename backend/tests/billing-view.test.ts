// tests/billing-view.test.ts — the four reads in src/routes/billing-view.ts, and the four ways
// they could leak or lie.
//
// ⛔ WHAT THESE CASES ARE ACTUALLY DEFENDING. This surface shows a customer what they OWE and shows
// a member what THEY spent. It has exactly four interesting failure modes and each one below names
// the mutation that produces it:
//
//   1. a member reads the workspace's bill          → the role gate was dropped
//   2. a tenant_admin reads ANOTHER tenant's bill    → a caller-supplied id reached the client
//   3. a billing outage renders as $0.00             → a failure was defaulted to a number
//   4. "my usage" shows somebody else's spend        → the filter moved off the verified user id
//
// ⚠️ EVERY CASE NAMES ITS MUTATION TARGET, per the house discipline (tests/user-service.test.ts).
// The point of naming it is that the case must FAIL when that exact line is changed, and only
// then — a test that would also pass with the line deleted is a gate that cannot fail.
//
// Fixture ids use the `…00000b11…` prefix, which no other test file uses — see
// tests/fixture-id-collisions.test.ts for why that matters (one database, sequential files, every
// file tearing down the shared fixtures).
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { db, users, tenants, usageEvents } from '../src/db/client';
import { Router } from '../src/utils/router';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { registerBillingViewRoutes, currentBillingPeriod } from '../src/routes/billing-view';
import {
  __setBillingAdminForTests,
  BillingAdminError,
  type BillingAdminClient,
  type BillingActorCost,
  type BillingInvoice,
  type BillingInvoicePreview,
} from '../src/services/billing-admin';
import type { User } from '../src/types';

/** `Response.json()` is typed `unknown` (correctly — it is whatever the server sent), and this
 *  project typechecks its tests. One cast in one place beats twenty at the call sites, and it is
 *  honest about being a cast: the assertions below are what actually check the shape. */
async function json(res: Response): Promise<any> {
  return (await res.json()) as any;
}


const TENANT_A = '00000000-0000-0000-0000-00000b110a01';
const TENANT_B = '00000000-0000-0000-0000-00000b110b01';
const MEMBER_A = '00000000-0000-0000-0000-00000b111001';
const OTHER_A = '00000000-0000-0000-0000-00000b111002';
const TADMIN_A = '00000000-0000-0000-0000-00000b111003';
const USER_IDS = [MEMBER_A, OTHER_A, TADMIN_A];
const TENANT_IDS = [TENANT_A, TENANT_B];

const member: User = {
  id: MEMBER_A,
  email: 'mem@b11',
  name: 'Mem',
  roles: ['member'],
  tenantId: TENANT_A,
};
const otherMember: User = {
  id: OTHER_A,
  email: 'other@b11',
  name: 'Other',
  roles: ['member'],
  tenantId: TENANT_A,
};
const tenantAdmin: User = {
  id: TADMIN_A,
  email: 'ta@b11',
  name: 'TA',
  roles: ['member', 'tenant_admin'],
  tenantId: TENANT_A,
};

const router = new Router();
registerBillingViewRoutes(router);

let currentUser: User | null = member;
function as(u: User | null): void {
  currentUser = u;
}

async function call(path: string): Promise<Response> {
  const pathname = path.split('?')[0]!;
  const m = router.match('GET', pathname);
  if (!m) throw new Error(`no route for GET ${path}`);
  return m.handler(new Request(`http://t${path}`), ...m.params);
}

// ---- the fake billing client -----------------------------------------------------------------
//
// ⛔ IT RECORDS THE TENANT IT WAS ASKED ABOUT, AND THAT RECORDING IS THE ENTIRE POINT OF CASE 2.
// Asserting only on the RESPONSE cannot distinguish "the route refused to be redirected" from
// "the route was redirected and the fake happened to answer the same way". The argument the client
// receives is the observable that actually settles it.
interface Asked {
  previewTenants: string[];
  invoiceTenants: string[];
  invoiceIds: string[];
}

function fakeBilling(
  overrides: Partial<BillingAdminClient> = {},
): { client: BillingAdminClient; asked: Asked } {
  const asked: Asked = { previewTenants: [], invoiceTenants: [], invoiceIds: [] };
  const client: BillingAdminClient = {
    async actorCosts(): Promise<BillingActorCost[]> {
      return [];
    },
    async invoicePreview(tenantId, period): Promise<BillingInvoicePreview> {
      asked.previewTenants.push(tenantId);
      return {
        tenantId,
        period,
        currency: 'USD',
        totalUsd: 412.5,
        lines: [
          { kind: 'platform_fee', label: 'Platform fee', amountUsd: 300 },
          { kind: 'seats', label: 'Seats', amountUsd: 100, quantity: 5 },
          { kind: 'byo_markup', label: 'BYO markup', amountUsd: 12.5, ratePct: 10 },
        ],
      };
    },
    async invoices(tenantId): Promise<BillingInvoice[]> {
      asked.invoiceTenants.push(tenantId);
      return [
        {
          id: 'inv-1',
          tenantId,
          period: '2026-08',
          // ⚠️ THIS FIELD IS WHY THE ROUTE CANNOT NARROW ON `'status' in result`. An invoice has
          // its OWN `status`, and the first draft of billing-view.ts used that key as the
          // success/failure discriminant — which would have reported every successfully-read
          // invoice as a billing outage. Keep it populated here so the collision stays covered.
          status: 'paid',
          currency: 'USD',
          totalUsd: 401,
          lines: [{ kind: 'platform_fee', label: 'Platform fee', amountUsd: 401 }],
        },
      ];
    },
    async invoice(invoiceId, tenantId): Promise<BillingInvoice> {
      asked.invoiceIds.push(invoiceId);
      asked.invoiceTenants.push(tenantId);
      return {
        id: invoiceId,
        tenantId,
        period: '2026-08',
        status: 'paid',
        currency: 'USD',
        totalUsd: 401,
        lines: [{ kind: 'platform_fee', label: 'Platform fee', amountUsd: 401 }],
      };
    },
    ...overrides,
  };
  return { client, asked };
}

async function cleanup(): Promise<void> {
  await db.delete(usageEvents).where(inArray(usageEvents.user_id, USER_IDS));
  await db.update(users).set({ tenant_id: null }).where(inArray(users.id, USER_IDS));
  await db.delete(users).where(inArray(users.id, USER_IDS));
  await db.delete(tenants).where(inArray(tenants.id, TENANT_IDS));
}

// explicit hook timeout — bun ignores bunfig's [test] timeout for hooks, so a slow one fails as
// "(unnamed) [5003ms]" with no file or cause. See license-provisioning.test.ts.
beforeEach(async () => {
  __setAuthOverridesForTests({
    validateAuth: async () => {
      if (!currentUser) {
        const { UnauthorizedError } = await import('../src/types');
        throw new UnauthorizedError('no auth');
      }
      return currentUser;
    },
  });
  await cleanup();
  await db
    .insert(tenants)
    .values([
      { id: TENANT_A, name: 'Tenant A', slug: 'tenant-a-b11' },
      { id: TENANT_B, name: 'Tenant B', slug: 'tenant-b-b11' },
    ])
    .onConflictDoNothing({ target: tenants.id });
  await db
    .insert(users)
    .values([
      { id: MEMBER_A, email: member.email, name: member.name, tenant_id: TENANT_A },
      { id: OTHER_A, email: otherMember.email, name: otherMember.name, tenant_id: TENANT_A },
      { id: TADMIN_A, email: tenantAdmin.email, name: tenantAdmin.name, tenant_id: TENANT_A },
    ])
    .onConflictDoNothing({ target: users.id });
  as(member);
  __setBillingAdminForTests(fakeBilling().client);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setBillingAdminForTests(undefined);
  await cleanup();
}, 30_000);

// ---- 1. the role gate --------------------------------------------------------------------------

/**
 * MUTATION TARGET: the `await requireTenantAdmin(req)` line in `getPreview`, `listInvoices` and
 * `getInvoice` (src/routes/billing-view.ts). Weaken any of them to `validateAuth` — or to
 * `requireAnyAdmin` with the role check removed — and this case reds.
 *
 * ⛔ THE BILL IS NOT MEMBER-VISIBLE DATA. It carries the seat count (i.e. the headcount the company
 * is paying for), the negotiated platform fee and the markup rate — commercial terms between the
 * customer's administrators and us. An ordinary employee reading their own LLM usage is fine and
 * has its own route; an ordinary employee reading the contract is not.
 */
test('⛔ a member is REFUSED every tenant-bill read (403 tenant_admin_required)', async () => {
  as(member);
  for (const path of [
    '/api/billing/preview',
    '/api/billing/invoices',
    '/api/billing/invoices/inv-1',
  ]) {
    const res = await call(path);
    expect(res.status, `${path} must be refused for a plain member`).toBe(403);
    expect((await json(res)).error).toBe('tenant_admin_required');
  }

  // NON-VACUITY: the same three paths answer 200 for a tenant_admin, so the 403s above are the
  // ROLE gate and not a broken route table, a missing fake, or a thrown handler.
  as(tenantAdmin);
  for (const path of [
    '/api/billing/preview',
    '/api/billing/invoices',
    '/api/billing/invoices/inv-1',
  ]) {
    expect((await call(path)).status, `${path} must be readable by a tenant_admin`).toBe(200);
  }
});

// ---- 2. it cannot be pointed at another tenant -------------------------------------------------

/**
 * MUTATION TARGET: the absence of any caller-supplied tenant id in
 * `src/routes/billing-view.ts` — i.e. the fact that every handler passes `effectiveTenantId` (from
 * `requireTenantAdmin`) to the billing client. Add `url.searchParams.get('tenant_id') ?? …` in
 * front of it, the way an "allow super admins to pick a tenant" convenience would, and this reds.
 *
 * ⚠️ THE ASSERTION IS ON WHAT THE CLIENT WAS ASKED, NOT ON THE RESPONSE BODY. A response-only
 * assertion passes whether the route ignored the parameter or honoured it and the fake answered
 * identically — which is exactly the shape of a test that cannot fail.
 */
test('⛔ ?tenant_id= is never read — the billing client is only ever asked about the callers own tenant', async () => {
  const { client, asked } = fakeBilling();
  __setBillingAdminForTests(client);
  as(tenantAdmin); // tenant_admin OF TENANT A

  const res = await call(`/api/billing/preview?tenant_id=${TENANT_B}`);
  expect(res.status).toBe(200);
  const body = await json(res);

  // The client was asked about A. Never about B. Not "also about A" — ONLY about A.
  expect(asked.previewTenants).toEqual([TENANT_A]);
  expect(body.tenantId).toBe(TENANT_A);

  // …and the same on the list + single reads, which take the tenant through a different argument.
  await call(`/api/billing/invoices?tenant_id=${TENANT_B}`);
  await call(`/api/billing/invoices/inv-1?tenant_id=${TENANT_B}`);
  expect(asked.invoiceTenants).toEqual([TENANT_A, TENANT_A]);
});

/**
 * MUTATION TARGET: `requireTenantAdmin`'s own `pathTenantId`/claim comparison — reached here
 * through the `X-Active-Tenant-Id` header rather than a query string.
 *
 * ⚠️ THIS IS THE PROBE-RESISTANT ARM AND ITS EXPECTED RESULT IS **200**, NOT 403. A non-super_admin
 * caller's `X-Active-Tenant-Id` is SILENTLY IGNORED by design (middleware/admin-guards.ts
 * `readActiveTenantHeader`), so that a tenant_admin cannot discover whether the header is honoured.
 * The safety property is therefore not "it is refused", it is "it lands on the caller's own
 * tenant" — which is what is asserted. Reading a 403 as the correct answer here would make the
 * case pass against a route that 403s everything.
 */
test('⛔ X-Active-Tenant-Id from a tenant_admin is ignored — the read still lands on their own tenant', async () => {
  const { client, asked } = fakeBilling();
  __setBillingAdminForTests(client);
  as(tenantAdmin);

  const m = router.match('GET', '/api/billing/preview')!;
  const res = await m.handler(
    new Request('http://t/api/billing/preview', { headers: { 'X-Active-Tenant-Id': TENANT_B } }),
  );
  expect(res.status).toBe(200);
  expect(asked.previewTenants).toEqual([TENANT_A]);
});

// ---- 3. an outage is not a zero ----------------------------------------------------------------

/**
 * MUTATION TARGET: the `catch` in `readBilling` (src/routes/billing-view.ts) and the failure arm it
 * returns. Replace it with `return { ok: true, value: { totalUsd: 0, lines: [] } }` — the "graceful
 * degradation" an outage-hardening pass would reach for — and this case reds.
 *
 * ⛔ THE CONTRAST IS THE TEST, NOT EITHER HALF ALONE. A genuinely free month and an unreachable
 * billing service must not produce the same bytes. So this asserts both: the outage response
 * carries `status: 'unavailable'` and NO `totalUsd` AT ALL, while a real $0.00 preview carries
 * `status: 'ok'` and `totalUsd: 0`. A client that ignores `status` and reads `.totalUsd` therefore
 * gets `undefined` (visibly wrong) on the outage and `0` (correct) on the free month.
 */
test('⛔ a billing outage is an EXPLICIT unavailable state — never a $0.00 bill', async () => {
  const { client } = fakeBilling({
    async invoicePreview(): Promise<BillingInvoicePreview> {
      throw new BillingAdminError(503, 'billing admin transport error: connect ECONNREFUSED');
    },
    async invoices(): Promise<BillingInvoice[]> {
      throw new BillingAdminError(503, 'billing admin transport error: connect ECONNREFUSED');
    },
  });
  __setBillingAdminForTests(client);
  as(tenantAdmin);

  const preview = await json(await call('/api/billing/preview'));
  expect(preview.status).toBe('unavailable');
  expect(preview.reason).toBe('upstream_error');
  expect(preview.upstreamStatus).toBe(503);
  // ⛔ THE FIELD IS ABSENT, not 0. `toBeUndefined` and not `not.toBe(0)`: a `totalUsd` of `null`
  // would also satisfy "not 0" and would still render as an amount in a template.
  expect(preview.totalUsd).toBeUndefined();
  expect(preview.lines).toBeUndefined();
  // The period IS still stated — the reader needs to know which month is unknown.
  expect(preview.period).toBe(currentBillingPeriod());

  const list = await json(await call('/api/billing/invoices'));
  expect(list.status).toBe('unavailable');
  // ⛔ NOT `invoices: []`. An empty list renders as "you have never been invoiced", which is the
  // list-shaped spelling of the same lie.
  expect(list.invoices).toBeUndefined();

  // THE CONTRAST. A genuinely zero bill is a DIFFERENT response: status ok, and the number 0.
  const { client: freeMonth } = fakeBilling({
    async invoicePreview(tenantId, period): Promise<BillingInvoicePreview> {
      return { tenantId, period, currency: 'USD', totalUsd: 0, lines: [] };
    },
  });
  __setBillingAdminForTests(freeMonth);
  const zero = await json(await call('/api/billing/preview'));
  expect(zero.status).toBe('ok');
  expect(zero.totalUsd).toBe(0);
});

/**
 * MUTATION TARGET: the `billingAdminConfigured()` branch at the top of `readBilling`, and the
 * `reason` it returns.
 *
 * ⛔ WHY TWO REASONS AND NOT ONE "unavailable". `not_configured` means this deployment was never
 * wired to billing — a gitops omission, which no amount of retrying or paging fixes.
 * `upstream_error` means billing exists and is unwell — an incident. Collapsed into one state they
 * page the same person to look at the wrong system, and the one that is NOT an incident is the one
 * that will be treated as one forever, because it never clears.
 */
test('an unconfigured deployment reports not_configured — distinguishable from an outage', async () => {
  // No override installed ⇒ `billingAdminConfigured()` falls through to the real config, which is
  // empty in dev/CI/bun test. This is the deployment state, not a failure.
  __setBillingAdminForTests(undefined);
  as(tenantAdmin);

  const body = await json(await call('/api/billing/preview'));
  expect(body.status).toBe('unavailable');
  expect(body.reason).toBe('not_configured');
  expect(body.totalUsd).toBeUndefined();
});

/**
 * MUTATION TARGET: the 404 rethrow in `readBilling`'s catch plus the `notFound('invoice_not_found')`
 * conversion in `getInvoice`.
 *
 * ⛔ "THIS INVOICE IS NOT YOURS" IS AN ANSWER, NOT AN OUTAGE. Folding it into the unavailable state
 * would tell an administrator to wait and retry for a document that will never exist — and, worse,
 * would hide a genuine ownership refusal behind a transient-looking banner, which is the failure
 * mode that makes a cross-tenant leak attempt look like a blip in a log.
 */
test('an invoice that is not this tenants is a 404 — not the unavailable state', async () => {
  const { client } = fakeBilling({
    async invoice(): Promise<BillingInvoice> {
      throw new BillingAdminError(404, 'invoice not found for tenant');
    },
  });
  __setBillingAdminForTests(client);
  as(tenantAdmin);

  const res = await call('/api/billing/invoices/inv-belonging-to-someone-else');
  expect(res.status).toBe(404);
  const body = await json(res);
  expect(body.error).toBe('invoice_not_found');
  expect(body.status).not.toBe('unavailable');
});

// ---- 4. "my usage" is the caller's, and only the caller's --------------------------------------

/** Two members of the SAME tenant, each with their own metered call. Same tenant on purpose — see
 *  the ⛔ note on the case below. */
async function seedTwoMembersUsage(): Promise<void> {
  await db.insert(usageEvents).values([
    {
      tenant_id: TENANT_A,
      user_id: MEMBER_A,
      provider: 'stub',
      model: 'mine',
      tokens_in: 10,
      tokens_out: 5,
      cost_usd: '1.500000',
      price_source: 'provider',
    },
    {
      tenant_id: TENANT_A,
      user_id: OTHER_A,
      provider: 'stub',
      model: 'theirs',
      tokens_in: 10,
      tokens_out: 5,
      cost_usd: '99.000000',
      price_source: 'provider',
    },
  ]);
}

/**
 * MUTATION TARGET: `WHERE ue.user_id = ${user.id}` in `getMyUsage` (src/routes/billing-view.ts),
 * both occurrences. Widen either to the tenant — `ue.tenant_id = user.tenantId`, which is what
 * "show the team's usage" would look like — and this case reds on the $99 row appearing.
 *
 * ⛔ BOTH MEMBERS ARE IN **ONE TENANT**, AND THAT IS THE WHOLE DESIGN OF THE FIXTURE. If they sat in
 * different tenants, RLS alone would hide the other row and the case would pass against a route
 * with no user filter at all — a green test proving a property the code does not have. Same
 * tenant, same RLS scope, different person: the ONLY thing that can separate them is the
 * `user_id` predicate under test.
 */
test('⛔ my-usage returns ONLY the callers own rows, with a same-tenant neighbour present', async () => {
  await seedTwoMembersUsage();
  as(member);

  const body = await json(await call('/api/billing/my-usage'));
  expect(body.status).toBe('ok');
  expect(body.userId).toBe(MEMBER_A);
  expect(body.calls).toBe(1);
  expect(body.spendUsd).toBeCloseTo(1.5, 6);
  expect(body.byModel.map((m: { model: string }) => m.model)).toEqual(['mine']);

  // NON-VACUITY: the neighbour's row really is in the table and really is visible to this
  // connection — so the absence above is the filter, not an empty fixture.
  as(otherMember);
  const theirs = await json(await call('/api/billing/my-usage'));
  expect(theirs.userId).toBe(OTHER_A);
  expect(theirs.calls).toBe(1);
  expect(theirs.spendUsd).toBeCloseTo(99, 6);
  expect(theirs.byModel.map((m: { model: string }) => m.model)).toEqual(['theirs']);
});

/**
 * MUTATION TARGET: the ABSENCE of any `user_id` read from the request in `getMyUsage`. Add
 * `const who = url.searchParams.get('user_id') ?? user.id` — the obvious "let an admin look at a
 * member" convenience — and this reds.
 *
 * ⚠️ The expected result is the CALLER'S OWN numbers, not a 400. Rejecting the parameter would be
 * a second, weaker property (it can be forgotten for the next parameter name somebody invents);
 * never reading one is the property that holds for every name.
 */
test('⛔ my-usage ignores a caller-supplied ?user_id= entirely', async () => {
  await seedTwoMembersUsage();
  as(member);

  const body = await json(await call(`/api/billing/my-usage?user_id=${OTHER_A}`));
  expect(body.userId).toBe(MEMBER_A);
  expect(body.spendUsd).toBeCloseTo(1.5, 6);
});

/**
 * MUTATION TARGET: `AND NOT ue.platform_actor` in both `getMyUsage` queries.
 *
 * ⛔ A BACKGROUND DRAINER'S CALL CARRIES A REAL PERSON'S `user_id` (migration 0063 — see the
 * HUMAN_ONLY block in host/usage-metrics.ts, where this exact defect was measured in production at
 * 608 rows against one person's name). On a PER-PERSON screen that is the most misleading place it
 * can possibly appear: the number sits next to "your usage" and is not their usage.
 */
test('⛔ my-usage excludes platform background work filed under the callers user id', async () => {
  await db.insert(usageEvents).values([
    {
      tenant_id: TENANT_A,
      user_id: MEMBER_A,
      provider: 'stub',
      model: 'mine',
      tokens_in: 10,
      tokens_out: 5,
      cost_usd: '1.500000',
      price_source: 'provider',
    },
    {
      tenant_id: TENANT_A,
      user_id: MEMBER_A,
      provider: 'stub',
      model: 'local-llm',
      tokens_in: 10,
      tokens_out: 5,
      cost_usd: '40.000000',
      price_source: 'flat',
      platform_actor: true,
    },
  ]);
  as(member);

  const body = await json(await call('/api/billing/my-usage'));
  expect(body.calls).toBe(1);
  expect(body.spendUsd).toBeCloseTo(1.5, 6);
  // …and the estimate flag reflects the HUMAN row only: that row is `price_source='provider'`, so
  // the figure is a vendor charge and must not be hedged. If the platform row leaked in, its
  // `flat` pricing would flip this to true — a second, independent witness to the same leak.
  expect(body.estimated).toBe(false);
});

// ---- a billing 404 on preview / invoices is a clean "not available", never a 500 ---------------
test('⛔ billing answers 404 for the preview or the invoice list → 404 billing_not_available, not 500', async () => {
  const { BillingAdminError } = await import('../src/services/billing-admin');
  const { client } = fakeBilling({
    async invoicePreview() {
      throw new BillingAdminError(404, 'read invoice preview failed: HTTP 404');
    },
    async invoices() {
      throw new BillingAdminError(404, 'list invoices failed: HTTP 404');
    },
  });
  __setBillingAdminForTests(client);
  as(tenantAdmin);
  try {
    for (const path of ['/api/billing/preview', '/api/billing/invoices']) {
      const res = await call(path);
      expect(res.status, path).toBe(404);
      expect((await json(res)).error, path).toBe('billing_not_available');
    }
  } finally {
    __setBillingAdminForTests(undefined);
  }
});
