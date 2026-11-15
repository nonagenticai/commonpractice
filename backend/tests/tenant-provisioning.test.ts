// tests/tenant-provisioning.test.ts — the per-tenant creation record (0101) and its retries.
//
// The Netcare create (prod 2026-10-13): licence fine, billing refused the terms, create said 201 and
// the typed terms were gone. Each test below pins one piece of the repair:
//   • billing's "unregistered tenant" 422 gets a few QUICK in-request retries, then `pending`;
//   • a transient failure HOLDS the terms and the tick lands them later, then drops the copy;
//   • a real 4xx is `failed`, and the Retry route re-sends the held terms with no re-entry;
//   • the claim is per (tenant, step): a held claim makes Retry 409 and the tick skip;
//   • the tick's backoff is bounded and gives up into `failed`;
//   • an edit of the terms supersedes the held ones (the tick must not send the OLD terms later);
//   • a failed first-admin invite is retried from the held name + email.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { eq, like, sql } from 'drizzle-orm';
import { db, tenants, queryClient } from '../src/db/client';
import { writeTenantTerms } from '../src/services/tenant-terms';
import {
  __setBillingAdminForTests,
  BillingAdminError,
  BillingAdminService,
  type BillingAdminClient,
  type BillingTermsView,
  type TenantTerms,
} from '../src/services/billing-admin';
import {
  __setProvisioningSleepForTests,
  BILLING_UNREGISTERED_QUICK_ATTEMPTS,
  PROVISIONING_MAX_ATTEMPTS,
  claimStep,
  classifyBillingFailure,
  readProvisioning,
  reconcileProvisioning,
  initialProvisioningRecord,
  toView,
  type ProvisioningRecord,
} from '../src/services/tenant-provisioning';
import { offboardTenantWrites } from '../src/services/offboarding';
import { Router } from '../src/utils/router';
import { registerAdminRoutes } from '../src/routes/admin';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { __setKeycloakAdminForTests, type KeycloakAdminClient } from '../src/services/keycloak-admin';
import { __setMailTransportForTests } from '../src/host/mailer';
import type { User } from '../src/types';

const ADMIN_ID = '00000000-0000-4000-8000-0000f0a00001';
const admin: User = { id: ADMIN_ID, email: 'tp.admin@test.dev', name: 'TP Admin', roles: ['super_admin'] };
const TERMS: TenantTerms = { platformFeeUsd: 300, seatFeeUsd: 15, markupPct: 25 };

const router = new Router();
registerAdminRoutes(router);

async function call(method: string, path: string, body?: unknown) {
  const m = router.match(method, path);
  if (!m) return new Response(null, { status: 404 });
  return m.handler(
    new Request(`http://t${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    ...m.params,
  );
}

type PutFailure = 'unregistered' | 'unavailable' | 'refused' | null;

/** Billing fake: GET reads back what PUT stored; `fail` decides what the NEXT PUTs answer. */
function makeBilling() {
  const stored = new Map<string, TenantTerms>();
  const state = { fail: null as PutFailure, failTimes: Infinity, puts: [] as Array<{ tenantId: string; terms: TenantTerms }> };
  const view = (tenantId: string): BillingTermsView => {
    const t = stored.get(tenantId);
    return {
      billingMode: t ? 'byo_markup_only' : 'standard_markup',
      platformFeeUsd: t?.platformFeeUsd ?? 0,
      seatFeeUsd: t?.seatFeeUsd ?? 0,
      markupPct: t?.markupPct ?? 0,
      fullyConfigured: Boolean(t),
      changed: [],
    };
  };
  const client: BillingAdminClient = {
    async actorCosts() {
      return [];
    },
    async invoicePreview() {
      throw new Error('unused');
    },
    async invoices() {
      return [];
    },
    async invoice() {
      throw new Error('unused');
    },
    async commercialTerms(tenantId) {
      return view(tenantId);
    },
    async putCommercialTerms(tenantId, terms) {
      state.puts.push({ tenantId, terms });
      if (state.fail && state.failTimes > 0) {
        state.failTimes--;
        if (state.fail === 'unregistered') {
          throw new BillingAdminError(
            422,
            'write commercial terms failed: HTTP 422',
            '{"detail":"budget_write_refused_unregistered_tenant"}',
          );
        }
        if (state.fail === 'unavailable') throw new BillingAdminError(503, 'write commercial terms failed: HTTP 503');
        throw new BillingAdminError(400, 'write commercial terms failed: HTTP 400', '{"detail":"seat_app_key unknown"}');
      }
      stored.set(tenantId, terms);
      return view(tenantId);
    },
    async moneyBudgetStatus() {
      return null;
    },
  };
  return { client, state, stored };
}

const CLEANUP_SQL = `
  DELETE FROM audit_log WHERE actor_id = '${ADMIN_ID}';
  DELETE FROM audit_log WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'tp-%');
  DELETE FROM tenant_invites WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'tp-%');
  DELETE FROM tenants WHERE slug LIKE 'tp-%';
`;

let billing = makeBilling();
const sleeps: number[] = [];

beforeEach(async () => {
  __setAuthOverridesForTests({ validateAuth: async () => admin });
  billing = makeBilling();
  __setBillingAdminForTests(billing.client);
  sleeps.length = 0;
  __setProvisioningSleepForTests(async (ms) => {
    sleeps.push(ms);
  });
  await queryClient.unsafe(CLEANUP_SQL);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setBillingAdminForTests(undefined);
  __setProvisioningSleepForTests(undefined);
  __setKeycloakAdminForTests(undefined);
  __setMailTransportForTests(undefined);
  await queryClient.unsafe(CLEANUP_SQL);
}, 30_000);

async function create(name: string, extra: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/tenants', { name, byoMode: 'byo_required', terms: TERMS, ...extra });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    tenant: { id: string };
    termsError?: string;
    inviteError?: string;
    invite: unknown;
    provisioning: { recorded: boolean; termsHeld: boolean; firstAdminHeld: boolean; steps: Record<string, { status: string; code: string | null; attempts: number; nextAttemptAt: string | null }> };
  };
}

/** Make the tenant's billing step due for the tick right now. */
async function makeDue(tenantId: string) {
  await db
    .update(tenants)
    .set({
      provisioning: sql`jsonb_set(${tenants.provisioning}, '{steps,billing_terms,nextAttemptAt}', to_jsonb(now() - interval '1 second'))`,
    })
    .where(eq(tenants.id, tenantId));
}

test('a clean create records every step and keeps NO copy of the terms', async () => {
  const body = await create('TP Clean');
  expect(body.provisioning.recorded).toBe(true);
  // Issuance is off in this file: nothing is minted, so the licence step says so — never `ok`
  // without a stored token (tenant-create-licences.test.ts covers the minting create).
  expect(body.provisioning.steps.licence).toMatchObject({ status: 'skipped', code: 'licence_issuance_disabled' });
  expect(body.provisioning.steps.billing_terms!.status).toBe('ok');
  expect(body.provisioning.steps.ir_licence!.status).toBe('skipped');
  expect(body.provisioning.steps.first_invite!.status).toBe('skipped');
  expect(body.provisioning.termsHeld).toBe(false);
  const rec = (await readProvisioning(body.tenant.id))!;
  expect(rec.terms).toBeUndefined();
});

test("billing's unregistered-tenant 422 gets quick retries inside the create, then lands", async () => {
  billing.state.fail = 'unregistered';
  billing.state.failTimes = BILLING_UNREGISTERED_QUICK_ATTEMPTS - 1;
  const body = await create('TP Quick');
  expect(billing.state.puts.length).toBe(BILLING_UNREGISTERED_QUICK_ATTEMPTS);
  expect(sleeps.length).toBe(BILLING_UNREGISTERED_QUICK_ATTEMPTS - 1);
  expect(body.termsError).toBeUndefined();
  expect(body.provisioning.steps.billing_terms!.status).toBe('ok');
  expect(billing.stored.get(body.tenant.id)).toEqual(TERMS);
});

test('still unregistered after the quick retries → pending (not failed), terms HELD, the tick lands them and drops the copy', async () => {
  billing.state.fail = 'unregistered';
  const body = await create('TP Unregistered');
  expect(billing.state.puts.length).toBe(BILLING_UNREGISTERED_QUICK_ATTEMPTS);
  const step = body.provisioning.steps.billing_terms!;
  expect(step.status).toBe('pending');
  expect(step.code).toBe('billing_tenant_not_registered');
  expect(step.nextAttemptAt).not.toBeNull();
  expect(body.termsError).toBe('billing_tenant_not_registered');
  expect(body.provisioning.termsHeld).toBe(true);
  expect((await readProvisioning(body.tenant.id))!.terms).toEqual(TERMS);

  // Not due yet: the tick leaves it alone.
  billing.state.fail = null;
  await reconcileProvisioning();
  expect(billing.stored.has(body.tenant.id)).toBe(false);

  // Due: the tick sends the HELD terms (nobody re-typed them), records ok, forgets the copy.
  await makeDue(body.tenant.id);
  const sweep = await reconcileProvisioning();
  expect(sweep.landed).toBeGreaterThanOrEqual(1);
  expect(billing.stored.get(body.tenant.id)).toEqual(TERMS);
  const rec = (await readProvisioning(body.tenant.id))!;
  expect(rec.steps.billing_terms!.status).toBe('ok');
  expect(rec.terms).toBeUndefined();
});

test('billing 503 → pending with NO quick retry (that is the tick\'s job), code billing_unavailable', async () => {
  billing.state.fail = 'unavailable';
  const body = await create('TP Outage');
  expect(billing.state.puts.length).toBe(1);
  expect(body.provisioning.steps.billing_terms!.status).toBe('pending');
  expect(body.provisioning.steps.billing_terms!.code).toBe('billing_unavailable');
});

test('a real 4xx refusal → failed; Retry re-sends the HELD terms with no body, and lands once billing accepts', async () => {
  billing.state.fail = 'refused';
  const body = await create('TP Refused');
  const step = body.provisioning.steps.billing_terms!;
  expect(step.status).toBe('failed');
  expect(step.code).toBe('billing_refused');
  expect(body.termsError).toBe('billing_refused');

  billing.state.fail = null;
  const res = await call('POST', `/api/tenants/${body.tenant.id}/provisioning/billing_terms/retry`);
  expect(res.status).toBe(200);
  const out = (await res.json()) as { record: { status: string }; provisioning: { termsHeld: boolean } };
  expect(out.record.status).toBe('ok');
  expect(out.provisioning.termsHeld).toBe(false);
  expect(billing.stored.get(body.tenant.id)).toEqual(TERMS);

  const view = (await (await call('GET', `/api/tenants/${body.tenant.id}/provisioning`)).json()) as {
    provisioning: { steps: Record<string, { status: string; attempts: number }> };
  };
  expect(view.provisioning.steps.billing_terms!.status).toBe('ok');
  expect(view.provisioning.steps.billing_terms!.attempts).toBe(2);
});

test('the claim is per (tenant, step): a live claim makes Retry 409 and the tick skip that tenant', async () => {
  billing.state.fail = 'unavailable';
  const body = await create('TP Busy');
  billing.state.fail = null;
  expect(await claimStep(body.tenant.id, 'billing_terms')).not.toBeNull();
  // A second claimer loses — the one-statement CAS.
  expect(await claimStep(body.tenant.id, 'billing_terms')).toBeNull();

  const res = await call('POST', `/api/tenants/${body.tenant.id}/provisioning/billing_terms/retry`);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('provisioning_step_busy');

  await makeDue(body.tenant.id);
  const sweep = await reconcileProvisioning();
  expect(sweep.busy).toBeGreaterThanOrEqual(1);
  expect(billing.stored.has(body.tenant.id)).toBe(false);
});

test('the backoff is bounded: after PROVISIONING_MAX_ATTEMPTS the step is failed and the tick stops', async () => {
  billing.state.fail = 'unavailable';
  const body = await create('TP Bounded');
  for (let i = 1; i < PROVISIONING_MAX_ATTEMPTS; i++) {
    await makeDue(body.tenant.id);
    await reconcileProvisioning();
  }
  const rec = (await readProvisioning(body.tenant.id))!;
  expect(rec.steps.billing_terms!.attempts).toBe(PROVISIONING_MAX_ATTEMPTS);
  expect(rec.steps.billing_terms!.status).toBe('failed');
  expect(rec.steps.billing_terms!.nextAttemptAt).toBeNull();
  // The terms are still held for a human Retry.
  expect(rec.terms).toEqual(TERMS);
  const putsBefore = billing.state.puts.length;
  await reconcileProvisioning();
  expect(billing.state.puts.length).toBe(putsBefore);
});

test('an EDIT of the terms supersedes the held ones: the tick never sends the old terms afterwards', async () => {
  billing.state.fail = 'unavailable';
  const body = await create('TP Edited');
  billing.state.fail = null;
  const edited: TenantTerms = { platformFeeUsd: 99, seatFeeUsd: 9, markupPct: 9 };
  const res = await call('PATCH', `/api/tenants/${body.tenant.id}`, { terms: edited });
  expect(res.status).toBe(200);
  const rec = (await readProvisioning(body.tenant.id))!;
  expect(rec.terms).toBeUndefined();
  expect(rec.steps.billing_terms!.status).toBe('ok');

  await makeDue(body.tenant.id);
  await reconcileProvisioning();
  expect(billing.stored.get(body.tenant.id)).toEqual(edited);
});

test('Retry on an unknown step → 404; on an offboarded tenant → 409 tenant_offboarded', async () => {
  const body = await create('TP Guards');
  expect((await call('POST', `/api/tenants/${body.tenant.id}/provisioning/nonsense/retry`)).status).toBe(404);
  await db.update(tenants).set({ offboarded_at: new Date() }).where(eq(tenants.id, body.tenant.id));
  const res = await call('POST', `/api/tenants/${body.tenant.id}/provisioning/billing_terms/retry`);
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toBe('tenant_offboarded');
});

test('a failed first-admin invite is recorded and retried from the HELD name + email', async () => {
  const created: Array<Record<string, unknown>> = [];
  let kcDown = true;
  const kc = {
    async createRealmUser(input: Record<string, unknown>) {
      if (kcDown) throw new Error('keycloak down');
      created.push(input);
      return '00000000-0000-4000-8000-0000f0a0beef';
    },
    async findRealmUserByUsernameOrEmail() {
      return null;
    },
    async executeActionsEmail() {},
    async getRealmRolesForUsers(ids: string[]) {
      return new Map(ids.map((i) => [i, [] as string[]]));
    },
  } as unknown as KeycloakAdminClient;
  __setKeycloakAdminForTests(kc);
  __setMailTransportForTests({ async sendMail() {} } as never);
  try {
    const body = await create('TP Invite', {
      firstAdminEmail: 'boss@tp-invite.test',
      firstAdminFirstName: 'Anna',
      firstAdminLastName: 'van Dijk',
    });
    expect(body.invite).toBeNull();
    expect(body.provisioning.steps.first_invite!.status).toBe('failed');
    expect(body.provisioning.firstAdminHeld).toBe(true);

    kcDown = false;
    const res = await call('POST', `/api/tenants/${body.tenant.id}/provisioning/first_invite/retry`);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { record: { status: string }; invite?: { email: string }; provisioning: { firstAdminHeld: boolean } };
    expect(out.record.status).toBe('ok');
    expect(out.invite?.email).toBe('boss@tp-invite.test');
    expect(out.provisioning.firstAdminHeld).toBe(false);
    expect(created[0]).toMatchObject({ firstName: 'Anna', lastName: 'van Dijk' });
  } finally {
    __setKeycloakAdminForTests(undefined);
  }
});

test('a tenant created before 0101 has no record, and says so', async () => {
  const [t] = await db
    .insert(tenants)
    .values({ name: 'TP Legacy', slug: 'tp-legacy' })
    .returning({ id: tenants.id });
  const view = (await (await call('GET', `/api/tenants/${t!.id}/provisioning`)).json()) as {
    provisioning: ProvisioningRecord & { recorded: boolean };
  };
  expect(view.provisioning.recorded).toBe(false);
  expect(await db.select({ id: tenants.id }).from(tenants).where(like(tenants.slug, 'tp-legacy'))).toHaveLength(1);
});

test('offboarding DROPS the held creation inputs (first admin PII, terms) and keeps the step history', async () => {
  const rec = initialProvisioningRecord({
    central: false,
    terms: TERMS,
    needsIr: false,
    firstAdmin: { email: 'held@tp-offboard.test', firstName: 'Held', lastName: 'Person' },
  });
  const [t] = await db
    .insert(tenants)
    .values({ name: 'TP Offboard', slug: 'tp-offboard', provisioning: rec })
    .returning({ id: tenants.id });
  const before = (await readProvisioning(t!.id))!;
  expect(before.terms).toEqual(TERMS);
  expect(before.firstAdmin?.email).toBe('held@tp-offboard.test');

  await offboardTenantWrites(t!.id);

  const after = (await readProvisioning(t!.id))!;
  expect(after.terms).toBeUndefined();
  expect(after.firstAdmin).toBeUndefined();
  expect(JSON.stringify(after)).not.toContain('held@tp-offboard.test');
  // The records are history, not PII — they stay.
  expect(after.steps.first_invite!.status).toBe('pending');
  expect(after.steps.billing_terms!.status).toBe('pending');
});

test('an orphaned pending step the tick does not own reads as failed/interrupted once its claim lapsed', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const pend = (over: Record<string, unknown> = {}) => ({
    status: 'pending' as const,
    code: null,
    message: null,
    attempts: 0,
    lastAttemptAt: null,
    nextAttemptAt: past,
    ...over,
  });
  const rec: ProvisioningRecord = {
    steps: {
      ir_licence: pend(), // died mid-create, window past, no claim → interrupted
      first_invite: pend({ leaseUntil: future }), // somebody holds a live claim right now
      billing_terms: pend(), // the TICK owns it: it stays pending, the tick will run it
      licence: pend(), // the tick owns this one too (a busy-lease create leaves it pending)
      licences_tenant: pend({ nextAttemptAt: future }), // the create is still inside its window
    },
  };
  const [t] = await db
    .insert(tenants)
    .values({ name: 'TP Orphan', slug: 'tp-orphan', provisioning: rec })
    .returning({ id: tenants.id });

  const res = await call('GET', `/api/tenants/${t!.id}/provisioning`);
  expect(res.status).toBe(200);
  const view = ((await res.json()) as { provisioning: ReturnType<typeof toView> }).provisioning;
  expect(view.steps.ir_licence).toMatchObject({ status: 'failed', code: 'interrupted', nextAttemptAt: null });
  expect(view.steps.licences_tenant!.status).toBe('pending');
  expect(view.steps.first_invite!.status).toBe('pending');
  expect(view.steps.billing_terms!.status).toBe('pending');
  expect(view.steps.licence!.status).toBe('pending');
  // Presented, NOT written: the stored record is untouched.
  expect((await readProvisioning(t!.id))!.steps.ir_licence!.status).toBe('pending');
  // …and once the live claim lapses, the claimed step reads interrupted too.
  expect(toView(rec, Date.now() + 120_000).steps.first_invite!.code).toBe('interrupted');
});

test('the onboarding-integrity tick runs the provisioning sweep (source guard)', async () => {
  const src = await Bun.file(new URL('../src/host/onboarding-integrity.ts', import.meta.url)).text();
  expect(src.length).toBeGreaterThan(1000);
  const tickBody = src.slice(src.indexOf('async function tick(): Promise<void> {'));
  expect(tickBody.indexOf('async function tick')).toBe(0);
  expect(tickBody.slice(0, tickBody.indexOf('\n}\n'))).toContain('await reconcileProvisioning()');
});

test("the REAL billing client keeps billing's error body, so an unregistered 422 is told apart from a real refusal", async () => {
  const answer = { status: 422, body: '{"detail":"budget_write_refused_unregistered_tenant"}' };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
    if (url.includes('/commercial-terms') && answer.status === 0) return new Response('{}', { status: 200 });
    return new Response(answer.body, { status: answer.status });
  }) as unknown as typeof fetch;
  __setBillingAdminForTests(
    new BillingAdminService({ adminBaseUrl: 'http://billing.test', tokenUrl: 'http://kc.test/token', clientId: 'cp', clientSecret: 's', fetchImpl }),
  );
  const err1 = await writeTenantTerms('00000000-0000-4000-8000-0000f0a0c001', TERMS).catch((e: unknown) => e);
  expect(classifyBillingFailure(err1)).toBe('unregistered');
  answer.body = '{"detail":"seat_app_key unknown"}';
  const err2 = await writeTenantTerms('00000000-0000-4000-8000-0000f0a0c001', TERMS).catch((e: unknown) => e);
  expect(classifyBillingFailure(err2)).toBe('refused');
  answer.status = 503;
  const err3 = await writeTenantTerms('00000000-0000-4000-8000-0000f0a0c001', TERMS).catch((e: unknown) => e);
  expect(classifyBillingFailure(err3)).toBe('transient');
});
