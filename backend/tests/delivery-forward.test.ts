// tests/delivery-forward.test.ts — Phase 5B: POST /forward + /retry. Drives the real router +
// tenant-bound db, with auth faked (__setAuthOverridesForTests), the governance snapshot pinned
// (__setSnapshotOverrideForTests → externalHttp + the Jira host allowlisted), and Jira itself
// served by the egress test-seam (no network). Proves: happy→created, idempotent re-forward→409,
// kind/config/egress→422 (NO row), authz 403/404, dispatch-fail→failed(200), retry→created.
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import {
  db,
  deliveryTargets,
  solutionDeliveries,
  solutions,
  challenges,
  tenants,
  users,
} from '../src/db/client';
import { Router } from '../src/utils/router';
import { registerDeliveryRoutes } from '../src/routes/delivery';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { __setEgressHooksForTests } from '../src/host/egress-guard';
import { __setSnapshotOverrideForTests } from '../src/host/policy-store';
import { encryptSecret } from '../src/host/secret-box';
import { __setLicenseClientForTests } from '../src/services/license-client';
import { __setFrBridgeSaForTests } from '../src/services/fr-bridge-sa';
import type { GovernanceSnapshot } from '../src/host/policy-store';
import type { LicenseClient, LicenseIntrospectResponse } from '../src/services/license-client';
import type { User } from '../src/types';

const A = '00000000-0000-0000-0000-00005b000001';
const B = '00000000-0000-0000-0000-00005b000002';
const USER_A = '00000000-0000-0000-0000-00005ba00001';
const USER_B = '00000000-0000-0000-0000-00005bb00001';
const CH_A = '00000000-0000-0000-0000-00005bc00001';
const SOL_A = '00000000-0000-0000-0000-00005bd00001';

const HOST = 'cp-fwd-jira.test';
const SNAPSHOT = { externalHttp: true, egressAllowlist: [HOST] } as unknown as GovernanceSnapshot;

function admin(id: string, tenant: string): User {
  return { id, email: `${id}@test`, name: 'Admin', roles: ['tenant_admin'], tenantId: tenant };
}
const adminA = admin(USER_A, A);
const adminB = admin(USER_B, B);
const memberA: User = { id: USER_A, email: 'm@test', name: 'M', roles: ['member'], tenantId: A };

const router = new Router();
registerDeliveryRoutes(router);

function as(user: User) {
  __setAuthOverridesForTests({ validateAuth: async () => user, requireRole: async () => user });
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const m = router.match(method, path)!;
  const req = new Request(`http://t${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return m.handler(req, ...m.params);
}

/** res.json() is typed `unknown`; the assertions here read known fields off it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jbody(res: Response): Promise<any> {
  return res.json();
}

/** Pin Jira's HTTP behaviour for the next dispatch (via the egress seam). */
function stubJira(status: number, body: unknown) {
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'],
    fetch: async () => new Response(JSON.stringify(body), { status }),
  });
}

const JIRA_CREDS = { email: 'ops@acme.io', apiToken: 'tok-xyz' };

async function makeTarget(
  tenant: string,
  overrides: Partial<{ kind: 'jira' | 'azure_devops' | 'fr'; enabled: boolean; base_url: string | null; project_key: string | null; credentials: object | null }> = {},
): Promise<string> {
  const [row] = await db
    .insert(deliveryTargets)
    .values({
      tenant_id: tenant,
      kind: overrides.kind ?? 'jira',
      name: `T-${Math.round(performance.now() * 1000)}`,
      base_url: overrides.base_url === undefined ? `https://${HOST}` : overrides.base_url,
      project_key: overrides.project_key === undefined ? 'DEL' : overrides.project_key,
      credentials_encrypted:
        overrides.credentials === null
          ? null
          : encryptSecret(JSON.stringify(overrides.credentials ?? JIRA_CREDS)),
      enabled: overrides.enabled ?? true,
    })
    .returning({ id: deliveryTargets.id });
  return row!.id;
}

/** A configured Azure DevOps target on the same allowlisted host (Phase 5C). */
const ADO_CREDS = { pat: 'pat-xyz' };
function makeAdoTarget(
  tenant: string,
  overrides: Partial<{ enabled: boolean; base_url: string | null; project_key: string | null; credentials: object | null }> = {},
): Promise<string> {
  return makeTarget(tenant, {
    kind: 'azure_devops',
    base_url: overrides.base_url === undefined ? `https://${HOST}/org` : overrides.base_url,
    project_key: overrides.project_key === undefined ? 'Delivery' : overrides.project_key,
    credentials: overrides.credentials === undefined ? ADO_CREDS : overrides.credentials,
    enabled: overrides.enabled,
  });
}

async function cleanup() {
  await db.delete(solutionDeliveries).where(inArray(solutionDeliveries.tenant_id, [A, B]));
  await db.delete(deliveryTargets).where(inArray(deliveryTargets.tenant_id, [A, B]));
  await db.delete(solutions).where(inArray(solutions.tenant_id, [A, B]));
  await db.delete(challenges).where(inArray(challenges.tenant_id, [A, B]));
  await db.delete(users).where(inArray(users.id, [USER_A, USER_B]));
  await db.delete(tenants).where(inArray(tenants.id, [A, B]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values([
    { id: A, name: 'Tenant A', slug: 'fwd-tenant-a' },
    { id: B, name: 'Tenant B', slug: 'fwd-tenant-b' },
  ]);
  await db.insert(users).values([
    { id: USER_A, email: 'fa@test', name: 'A', tenant_id: A },
    { id: USER_B, email: 'fb@test', name: 'B', tenant_id: B },
  ]);
  await db.insert(challenges).values({
    id: CH_A,
    title: 'Claims triage',
    description: 'Triage is slow',
    business_impact: 'High backlog',
    work_area: 'Claims Ops',
    metrics: { timeSavedPerWeek: '10h' },
    tags: ['fast-track'],
    submitter_id: USER_A,
    tenant_id: A,
  });
  await db.insert(solutions).values({
    id: SOL_A,
    challenge_id: CH_A,
    title: 'Automate triage',
    author_id: USER_A,
    blocks_used: ['Classifier'],
    tenant_id: A,
  });
  __setSnapshotOverrideForTests(SNAPSHOT);
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
  __setEgressHooksForTests(undefined);
  __setSnapshotOverrideForTests(undefined);
}, 30_000);

beforeEach(async () => {
  await db.delete(solutionDeliveries).where(inArray(solutionDeliveries.tenant_id, [A, B]));
  await db.delete(deliveryTargets).where(inArray(deliveryTargets.tenant_id, [A, B]));
}, 30_000);

test('happy path: forward → a Jira issue is created, row is "created" with ref/url', async () => {
  as(adminA);
  const targetId = await makeTarget(A);
  stubJira(201, { key: 'DEL-100' });

  const res = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });
  expect(res.status).toBe(201);
  const out = (await res.json()) as { delivery: Record<string, unknown> };
  expect(out.delivery.status).toBe('created');
  expect(out.delivery.externalRef).toBe('DEL-100');
  expect(out.delivery.externalUrl).toBe(`https://${HOST}/browse/DEL-100`);
  // The response must NOT leak the canonical payload / initiator.
  expect(out.delivery).not.toHaveProperty('payload');
  expect(out.delivery).not.toHaveProperty('initiated_by');
});

test('re-forwarding a live delivery → 409 with the existing delivery', async () => {
  as(adminA);
  const targetId = await makeTarget(A);
  stubJira(201, { key: 'DEL-101' });
  await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });

  const res = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });
  expect(res.status).toBe(409);
  const out = (await res.json()) as { error: string; delivery: { externalRef: string } };
  expect(out.error).toBe('delivery_already_live');
  expect(out.delivery.externalRef).toBe('DEL-101');
});

// Phase 5D go-live: 'fr' is now in SUPPORTED_FORWARD_KINDS, so a forward to an fr target passes the
// kind gate and reaches the config + Gate-2 + egress precheck (the fr adapter + Gate-2 themselves are
// exercised with stubs in delivery-fr.test.ts). An fr target with no base URL reaches config precheck →
// 422 delivery_target_incomplete (NOT the old delivery_target_kind_unsupported), proving fr is forwardable.
test('an fr target missing its base URL → 422 delivery_target_incomplete (fr forwardable, config-gated)', async () => {
  as(adminA);
  const targetId = await makeTarget(A, { kind: 'fr', base_url: null, project_key: null, credentials: { licenseToken: 'fr-lic' } });
  const res = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });
  expect(res.status).toBe(422);
  expect((await jbody(res)).error).toBe('delivery_target_incomplete');
  expect((await db.select().from(solutionDeliveries).where(eq(solutionDeliveries.tenant_id, A))).length).toBe(0);
});

test('a disabled target → 422 delivery_target_not_configured (no row)', async () => {
  as(adminA);
  const targetId = await makeTarget(A, { enabled: false });
  const res = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });
  expect(res.status).toBe(422);
  expect((await jbody(res)).error).toBe('delivery_target_not_configured');
});

test('a target missing credentials → 422 (config error, no row)', async () => {
  as(adminA);
  const targetId = await makeTarget(A, { credentials: null });
  const res = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });
  expect(res.status).toBe(422);
  expect((await jbody(res)).error).toBe('delivery_target_credentials_missing');
  expect((await db.select().from(solutionDeliveries).where(eq(solutionDeliveries.tenant_id, A))).length).toBe(0);
});

test('egress disabled / host not allowlisted → 422 (no row)', async () => {
  as(adminA);
  const targetId = await makeTarget(A);
  __setSnapshotOverrideForTests({ externalHttp: false, egressAllowlist: [] } as unknown as GovernanceSnapshot);
  try {
    const res = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });
    expect(res.status).toBe(422);
    expect((await jbody(res)).error).toBe('egress_disabled');
    expect((await db.select().from(solutionDeliveries).where(eq(solutionDeliveries.tenant_id, A))).length).toBe(0);
  } finally {
    __setSnapshotOverrideForTests(SNAPSHOT);
  }
});

test('a non-tenant_admin → 403', async () => {
  as(memberA);
  const res = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: SOL_A });
  expect(res.status).toBe(403);
});

test("another tenant's admin forwarding tenant A's solution → 404", async () => {
  as(adminB);
  const targetId = await makeTarget(B);
  const res = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });
  expect(res.status).toBe(404);
});

test('⛔ a failed row carries the MACHINE CODE, not only the adapter’s English sentence', async () => {
  // ⛔ THE DEFECT. `DeliveryDispatchError` / `DeliveryConfigError` / `EgressBlockedError` all carry
  // a stable snake_case `code`, and this route's catch kept only `err.message` — an ENGLISH sentence
  // authored in the adapter, which is what `solution_deliveries.error` stores and what
  // /solutions/[id] rendered verbatim, on a line whose sibling branches are already localized. The
  // code was thrown away at exactly the point where it was the only translatable thing present.
  //
  // ⛔ AND THE FIX NEEDED NO MIGRATION. `response` is an existing jsonb column this same `.set()`
  // already writes on every failure path (and already carries a CP-authored `_cp_note`), so the
  // classification rides along in it and `publicDelivery` lifts the two CP-authored scalars —
  // never the raw body — onto the wire.
  as(adminA);
  const targetId = await makeTarget(A);
  stubJira(503, { errorMessages: ['upstream down'] });

  const res = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });
  expect(res.status).toBe(200);
  const out = (await res.json()) as {
    delivery: { id: string; status: string; error: string; errorCode: string | null; errorStatus: number | null };
  };
  expect(out.delivery.status).toBe('failed');
  expect(out.delivery.errorCode).toBe('target_http_error');
  expect(out.delivery.errorStatus).toBe(503);
  // ⛔ AND THE ENGLISH STAYS. `error` is the fallback the browser renders for every row written
  // before the code existed, and it is what the row's tooltip keeps showing. A "fix" that replaced
  // the sentence with the token would break history and lose the only detail a support engineer has.
  expect(out.delivery.error).toContain('503');

  // ⛔ THE RAW RESPONSE BODY IS STILL OFF THE WIRE. Adding two CP-authored scalars must not turn
  // `publicDelivery` into a leak of the target's response — that projection exists to keep the
  // payload provenance and the remote body server-side.
  expect(JSON.stringify(out.delivery)).not.toContain('upstream down');
  expect(out.delivery).not.toHaveProperty('response');

  // …and it really is persisted, not merely computed for this one response.
  const [stored] = await db
    .select()
    .from(solutionDeliveries)
    .where(eq(solutionDeliveries.id, out.delivery.id));
  expect((stored!.response as Record<string, unknown>)._cp_code).toBe('target_http_error');
  expect((stored!.response as Record<string, unknown>)._cp_status).toBe(503);
});

test('⛔ a row written BEFORE the code existed reports `errorCode: null` — history is NOT migrated', async () => {
  // The stated limitation, pinned. Every attempt already in the table holds only the English
  // sentence; there is no way to recover a classification from prose and a WRONG classification on
  // a delivery ledger is worse than an untranslated one. `null` is what tells the browser to fall
  // back to `error`, and it is the SAME answer a mid-roll pod and a genuinely unclassified failure
  // produce — so this one assertion covers all three.
  as(adminA);
  const targetId = await makeTarget(A);
  const [row] = await db
    .insert(solutionDeliveries)
    .values({
      tenant_id: A,
      solution_id: SOL_A,
      target_id: targetId,
      target_kind: 'jira',
      initiated_by: USER_A,
      status: 'failed',
      // Exactly what the pre-change catch block wrote: the adapter's body, no `_cp_*` key anywhere.
      error: 'Jira returned HTTP 500',
      response: { errorMessages: ['boom'] },
      payload: MIN_PAYLOAD,
    })
    .returning({ id: solutionDeliveries.id });

  const res = await call('GET', `/api/solutions/${SOL_A}/deliveries`);
  expect(res.status).toBe(200);
  const out = (await res.json()) as {
    deliveries: { id: string; error: string; errorCode: string | null; errorStatus: number | null }[];
  };
  const historical = out.deliveries.find((d) => d.id === row!.id);
  expect(historical, 'the historical row is not in the feed, so this case tests nothing').toBeTruthy();
  expect(historical!.errorCode).toBeNull();
  expect(historical!.errorStatus).toBeNull();
  expect(historical!.error).toBe('Jira returned HTTP 500');
});

test('dispatch failure (Jira 5xx) → a "failed" row + 200; then retry → "created"', async () => {
  as(adminA);
  const targetId = await makeTarget(A);
  stubJira(500, { errorMessages: ['boom'] });

  const failRes = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });
  expect(failRes.status).toBe(200);
  const failed = (await failRes.json()) as { delivery: { id: string; status: string; error: string } };
  expect(failed.delivery.status).toBe('failed');
  expect(failed.delivery.error).toContain('500');

  // Retry the failed delivery — Jira now succeeds.
  stubJira(201, { key: 'DEL-200' });
  const retryRes = await call(
    'POST',
    `/api/solutions/${SOL_A}/forward/${failed.delivery.id}/retry`,
  );
  expect(retryRes.status).toBe(201);
  expect((await jbody(retryRes)).delivery.status).toBe('created');
});

test('retry on a non-failed (created) delivery → 409 delivery_not_retriable', async () => {
  as(adminA);
  const targetId = await makeTarget(A);
  stubJira(201, { key: 'DEL-300' });
  const created = (await (
    await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId })
  ).json()) as { delivery: { id: string } };

  const res = await call('POST', `/api/solutions/${SOL_A}/forward/${created.delivery.id}/retry`);
  expect(res.status).toBe(409);
  expect((await jbody(res)).error).toBe('delivery_not_retriable');
});

test("retry of another tenant's delivery → 404", async () => {
  as(adminA);
  const targetId = await makeTarget(A);
  stubJira(500, { errorMessages: ['x'] });
  const failed = (await (
    await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId })
  ).json()) as { delivery: { id: string } };

  as(adminB);
  const res = await call('POST', `/api/solutions/${SOL_A}/forward/${failed.delivery.id}/retry`);
  expect(res.status).toBe(404);
});

test('retry → 409 when a live delivery already exists for that (solution,target)', async () => {
  as(adminA);
  const targetId = await makeTarget(A);
  // First attempt fails.
  stubJira(500, { errorMessages: ['x'] });
  const failed = (await (
    await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId })
  ).json()) as { delivery: { id: string } };
  // A fresh forward to the same target now succeeds → a live 'created' row coexists.
  stubJira(201, { key: 'DEL-400' });
  await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });

  // Retrying the old failed row must collide with the live row → 409.
  stubJira(201, { key: 'DEL-401' });
  const res = await call('POST', `/api/solutions/${SOL_A}/forward/${failed.delivery.id}/retry`);
  expect(res.status).toBe(409);
  expect((await jbody(res)).error).toBe('delivery_already_live');
});

// ── #174 recovery case: a 'failed' row can carry a real external_ref when the dispatch itself
// SUCCEEDED and only the ledger UPDATE afterward threw (see dispatchDelivery's catch). Before this
// fix, retryDelivery ignored that ref and re-dispatched unconditionally — deterministically creating
// a SECOND Jira/ADO/fr ticket every time a tenant_admin clicked Retry on exactly this row shape.
const MIN_PAYLOAD = {
  title: 'x',
  summary: '',
  problem: '',
  outcome: '',
  acceptance_criteria: [],
  deliverables: [],
  requirements: [],
  data_access: [],
  labels: [],
  provenance: {
    cp_solution_id: SOL_A,
    cp_challenge_id: CH_A,
    cp_flow_id: null,
    cp_tenant_id: A,
    initiated_by: USER_A,
    votes_count: 0,
    flow_chain: [],
    blocks_used: [],
    datasets: [],
    ontology_entities: [],
  },
  needs_human: [],
};

test('retry of a "failed" row that already carries external_ref does NOT re-dispatch — reconciles in place instead of duplicating the ticket', async () => {
  as(adminA);
  const targetId = await makeTarget(A);
  // Simulate the #174 recovery case directly: the ticket DEL-500 really exists at Jira (the
  // dispatch succeeded), but only our ledger UPDATE failed afterward, so the row landed 'failed'
  // with the ref preserved — exactly the shape dispatchDelivery's catch produces.
  const [row] = await db
    .insert(solutionDeliveries)
    .values({
      tenant_id: A,
      solution_id: SOL_A,
      target_id: targetId,
      target_kind: 'jira',
      initiated_by: USER_A,
      status: 'failed',
      external_ref: 'DEL-500',
      external_url: `https://${HOST}/browse/DEL-500`,
      error: 'Delivery DEL-500 was created at jira but recording it failed: connection reset',
      payload: MIN_PAYLOAD,
    })
    .returning({ id: solutionDeliveries.id });

  // If retryDelivery re-dispatches, this stub is what it would hit, returning a DIFFERENT ref
  // (DEL-501) — proof of a second ticket. It must never be reached.
  let dispatchCalls = 0;
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'],
    fetch: async () => {
      dispatchCalls++;
      return new Response(JSON.stringify({ key: 'DEL-501' }), { status: 201 });
    },
  });

  const res = await call('POST', `/api/solutions/${SOL_A}/forward/${row!.id}/retry`);
  expect(res.status).toBe(200);
  const out = (await jbody(res)) as {
    delivery: { status: string; externalRef: string; externalUrl: string; error: string | null };
  };
  expect(out.delivery.status).toBe('created');
  expect(out.delivery.externalRef).toBe('DEL-500'); // the ORIGINAL ticket, not a new one
  expect(out.delivery.externalUrl).toBe(`https://${HOST}/browse/DEL-500`);
  expect(out.delivery.error).toBeNull();
  expect(dispatchCalls).toBe(0); // never re-dispatched — no second Jira ticket was created

  // Only one solution_deliveries row exists for this target — retry did NOT insert a second row.
  const rows = await db
    .select()
    .from(solutionDeliveries)
    .where(eq(solutionDeliveries.target_id, targetId));
  expect(rows.length).toBe(1);
});

// ── adversarial hunt: an UNTYPED dispatch exception must not strand the row at 'pending' ──────
// host/delivery/fr.ts calls frBridgeSa().getToken() BEFORE its own try/catch, so a token-mint
// failure throws whatever the SA client throws — here a plain Error, which is none of the three
// classes dispatchDelivery's catch used to special-case (DeliveryDispatchError / DeliveryConfigError
// / EgressBlockedError). Before the fix that re-threw out of dispatchDelivery, the route 500'd, and
// — because the 'pending' insert had already committed in the earlier `for` loop — the row was left
// 'pending' forever: LIVE (blocks any re-forward to that target) yet NOT retriable (retryDelivery only
// accepts 'failed'/'rejected'), with no sweeper anywhere to reclaim it.
function stubFrLicense(): void {
  const client: LicenseClient = {
    introspect: async () => ({ active: true, app: { key: 'fr' }, tenant_id: A }) as LicenseIntrospectResponse,
  };
  __setLicenseClientForTests(client);
}

test('an untyped adapter exception (plain Error, not the typed taxonomy) → "failed", not stuck "pending", and retriable', async () => {
  as(adminA);
  const targetId = await makeTarget(A, {
    kind: 'fr',
    base_url: `https://${HOST}`,
    project_key: null,
    credentials: { licenseToken: 'fr-lic-untyped' },
  });
  stubFrLicense();
  // The egress precheck (host lookup) runs BEFORE dispatch and must pass so the flow actually
  // reaches deliverFr/getToken(); the fetch stub is irrelevant here since getToken() throws
  // before any outbound fetch to fr.
  stubJira(200, {});
  __setFrBridgeSaForTests({
    getToken: async () => {
      throw new Error('keycloak unreachable');
    },
  });

  try {
    const res = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });
    // Without the fix this either 500s (uncaught rethrow) or the assertions below fail because the
    // row never leaves 'pending'.
    expect(res.status).toBe(200);
    const out = (await jbody(res)) as { delivery: { id: string; status: string; error: string } };
    expect(out.delivery.status).toBe('failed');
    expect(out.delivery.error).toContain('keycloak unreachable');

    const [persisted] = await db
      .select()
      .from(solutionDeliveries)
      .where(eq(solutionDeliveries.id, out.delivery.id));
    expect(persisted!.status).toBe('failed'); // NEVER 'pending'

    // Prove it's not permanently stuck: retryDelivery only accepts 'failed'/'rejected', so this
    // only succeeds because the row landed in 'failed' rather than the un-retriable 'pending'.
    __setFrBridgeSaForTests({ getToken: async () => 'sa-jwt-ok' });
    stubJira(201, { project_request_id: 'pr-999' }); // shared egress stub on the same allowlisted host
    const retryRes = await call(
      'POST',
      `/api/solutions/${SOL_A}/forward/${out.delivery.id}/retry`,
    );
    expect(retryRes.status).toBe(201);
    expect((await jbody(retryRes)).delivery.status).toBe('draft_created');
  } finally {
    __setLicenseClientForTests(undefined);
    __setFrBridgeSaForTests(undefined);
  }
});

// ── Phase 5C: Azure DevOps targets flow through the same route (the kind-dispatcher) ──────────
test('happy path (ADO): forward → a work item is created, row "created" with id ref + deep link', async () => {
  as(adminA);
  const targetId = await makeAdoTarget(A);
  stubJira(200, { id: 555 }); // shared egress stub — ADO returns a numeric work-item id

  const res = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });
  expect(res.status).toBe(201);
  const out = (await res.json()) as { delivery: Record<string, unknown> };
  expect(out.delivery.status).toBe('created');
  expect(out.delivery.externalRef).toBe('555');
  expect(out.delivery.externalUrl).toBe(`https://${HOST}/org/Delivery/_workitems/edit/555`);
  expect(out.delivery).not.toHaveProperty('payload');
});

test('dispatch failure (ADO 5xx) → a "failed" row + 200; then retry → "created"', async () => {
  as(adminA);
  const targetId = await makeAdoTarget(A);
  stubJira(503, { message: 'unavailable' });

  const failRes = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });
  expect(failRes.status).toBe(200);
  const failed = (await failRes.json()) as { delivery: { id: string; status: string; error: string } };
  expect(failed.delivery.status).toBe('failed');
  expect(failed.delivery.error).toContain('503');

  stubJira(200, { id: 777 });
  const retryRes = await call(
    'POST',
    `/api/solutions/${SOL_A}/forward/${failed.delivery.id}/retry`,
  );
  expect(retryRes.status).toBe(201);
  const retried = (await retryRes.json()) as { delivery: { status: string; externalRef: string } };
  expect(retried.delivery.status).toBe('created');
  expect(retried.delivery.externalRef).toBe('777');
});

test('an ADO target missing the PAT → 422 (config error, no row)', async () => {
  as(adminA);
  const targetId = await makeAdoTarget(A, { credentials: null });
  const res = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });
  expect(res.status).toBe(422);
  expect((await jbody(res)).error).toBe('delivery_target_credentials_missing');
  expect((await db.select().from(solutionDeliveries).where(eq(solutionDeliveries.tenant_id, A))).length).toBe(0);
});

test('ADO host not allowlisted → 422 (no row)', async () => {
  as(adminA);
  const targetId = await makeAdoTarget(A, { base_url: 'https://not-allowed.example' });
  const res = await call('POST', `/api/solutions/${SOL_A}/forward`, { target_id: targetId });
  expect(res.status).toBe(422);
  expect((await jbody(res)).error).toBe('egress_host_not_allowlisted');
  expect((await db.select().from(solutionDeliveries).where(eq(solutionDeliveries.tenant_id, A))).length).toBe(0);
});

// Phase 5D go-live: the retry path is symmetric to /forward — fr now passes the kind gate and reaches
// the config precheck. A 'failed' fr row whose target has no base URL retries into config precheck →
// 422 delivery_target_incomplete (not the old kind_unsupported), proving the gate is lifted on retry too.
test('retry of an fr delivery reaches config precheck (kind gate lifted) → 422 delivery_target_incomplete', async () => {
  as(adminA);
  const targetId = await makeTarget(A, { kind: 'fr', base_url: null, credentials: { licenseToken: 'fr-lic' } });
  const [row] = await db
    .insert(solutionDeliveries)
    .values({
      tenant_id: A,
      solution_id: SOL_A,
      target_id: targetId,
      target_kind: 'fr',
      initiated_by: USER_A,
      status: 'failed',
      payload: {
        title: 'x',
        summary: '',
        problem: '',
        outcome: '',
        acceptance_criteria: [],
        deliverables: [],
        requirements: [],
        data_access: [],
        labels: [],
        provenance: {
          cp_solution_id: SOL_A,
          cp_challenge_id: CH_A,
          cp_flow_id: null,
          cp_tenant_id: A,
          initiated_by: USER_A,
          votes_count: 0,
          flow_chain: [],
          blocks_used: [],
          datasets: [],
          ontology_entities: [],
        },
        needs_human: [],
      },
    })
    .returning({ id: solutionDeliveries.id });
  const res = await call('POST', `/api/solutions/${SOL_A}/forward/${row!.id}/retry`);
  expect(res.status).toBe(422);
  expect((await jbody(res)).error).toBe('delivery_target_incomplete');
});
