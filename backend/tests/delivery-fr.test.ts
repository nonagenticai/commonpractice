// tests/delivery-fr.test.ts — Phase 5 / 5D (CP-half, GATED): the fr internal-bridge adapter +
// Gate-2 license assertion + the route precheck (402/422), exercised against the egress test-seam
// (__setEgressHooksForTests), the bridge-SA seam (__setFrBridgeSaForTests), and the license-client
// seam (__setLicenseClientForTests) — NO live fr, NO live Keycloak, NO live licenses service, NO DB.
//
// Proves: the POST /api/project-requests envelope ({external_ref, external_origin, payload}), the
// two-token CP-asserts-the-tenant auth (Bearer SA JWT in Authorization + plain tenant uuid in
// X-Tenant-Id + uuid-only X-Subject-Id; the license token is NOT sent — Gate 2 runs CP-side), the fr
// ProjectCreate mapping (incl. the REPLACE-IN-FR sentinel), base_url normalization, the
// config/dispatch error taxonomy; Gate-2's active/app-key/tenant assertions + fail-closed introspect;
// and that the route precheck surfaces a missing fr license as a DISTINCT 402 (vs 422 config). The
// route-level gate (kind='fr' → 422 delivery_target_kind_unsupported, no row) stays proven in
// delivery-forward.test.ts — 'fr' is deliberately still OUT of SUPPORTED_FORWARD_KINDS.
import { test, expect, afterEach } from 'bun:test';
import { __setEgressHooksForTests } from '../src/host/egress-guard';
import { __setLicenseClientForTests, LicenseClientError } from '../src/services/license-client';
import { __setFrBridgeSaForTests } from '../src/services/fr-bridge-sa';
import {
  deliverFr,
  assertFrConfigured,
  buildFrProjectCreate,
  buildFrExternalOrigin,
  buildFrNotes,
  FR_REPO_SENTINEL,
} from '../src/host/delivery/fr';
import { assertFrLicense, FrLicenseError } from '../src/services/fr-license';
import { precheckTarget } from '../src/routes/delivery';
import { DeliveryConfigError, DeliveryDispatchError } from '../src/host/delivery/errors';
import { encryptSecret } from '../src/host/secret-box';
import type { DeliveryTarget } from '../src/db/schema';
import type { DeliveryPayload } from '../src/db/delivery-types';
import type { GovernanceSnapshot } from '../src/host/policy-store';
import type {
  LicenseClient,
  LicenseIntrospectResponse,
} from '../src/services/license-client';

const HOST = 'cp-fake-fr.test';
const TENANT = 'ten-fr-1';
const LICENSE_TOKEN = 'fr-lic-xyz';
const SA_JWT = 'sa-jwt-test';
const SNAPSHOT = { externalHttp: true, egressAllowlist: [HOST] } as unknown as GovernanceSnapshot;

afterEach(() => {
  __setEgressHooksForTests(undefined);
  __setLicenseClientForTests(undefined);
  __setFrBridgeSaForTests(undefined);
});

function target(overrides: Partial<DeliveryTarget> = {}): DeliveryTarget {
  return {
    id: 't1',
    tenant_id: TENANT,
    kind: 'fr',
    name: 'In-house fr',
    base_url: `https://${HOST}`,
    project_key: null,
    default_item_type: null,
    config: {},
    credentials_encrypted: encryptSecret(JSON.stringify({ licenseToken: LICENSE_TOKEN })),
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as DeliveryTarget;
}

function payload(overrides: Partial<DeliveryPayload> = {}): DeliveryPayload {
  return {
    title: 'Automate claims triage',
    summary: 'A challenge',
    problem: 'Manual triage is slow',
    outcome: 'Time saved per week: 10h',
    acceptance_criteria: ['Time saved per week — target: 10h'],
    deliverables: ['Implement the "Classifier" step'],
    requirements: ['Deliver within the "ops" work area'],
    data_access: ['Claims (claims)'],
    labels: ['Claims', 'fast-track', 'source:commonpractice'],
    provenance: {
      cp_solution_id: 'sol-1',
      cp_challenge_id: 'chal-1',
      cp_flow_id: 'flow-1',
      cp_tenant_id: TENANT,
      initiated_by: 'user-1',
      votes_count: 3,
      flow_chain: ['Classifier'],
      blocks_used: ['Classifier'],
      datasets: ['claims'],
      ontology_entities: ['Claim'],
    },
    needs_human: ['Provide the target repository URL (fr)'],
    ...overrides,
  };
}

/** Capture the outbound request the adapter makes, returning a canned fr response. */
function stubFr(response: { status: number; body: unknown }) {
  const captured: { url: string; init: RequestInit } = { url: '', init: {} };
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'], // a public IP — passes the SSRF hard-block
    fetch: async (input, init) => {
      captured.url = String(input);
      captured.init = init ?? {};
      const body = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
      return new Response(body, { status: response.status });
    },
  });
  return captured;
}

/** Inject a fake licenses-service introspection verdict for Gate-2 tests. */
function stubLicense(verdict: Partial<LicenseIntrospectResponse> & { active: boolean }): void {
  const client: LicenseClient = {
    introspect: async () => verdict as LicenseIntrospectResponse,
  };
  __setLicenseClientForTests(client);
}

/** Inject a fake fr-bridge SA so the adapter mints a token offline. */
function stubSa(token = SA_JWT): void {
  __setFrBridgeSaForTests({ getToken: async () => token });
}

/** Parse the captured request body JSON. */
function reqBody(init: RequestInit): {
  external_ref: string;
  external_origin: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  return JSON.parse(String(init.body));
}
function header(init: RequestInit, name: string): string | undefined {
  return (init.headers as Record<string, string>)?.[name];
}

// ─────────────────────────────── adapter: deliverFr ───────────────────────────────

test('happy path: deliverFr → draft project_request ref + url, correct envelope + auth', async () => {
  stubSa();
  const captured = stubFr({ status: 201, body: { project_request_id: 'pr-123' } });

  const result = await deliverFr(target(), payload(), SNAPSHOT);

  // endpoint + method
  expect(captured.url).toBe(`https://${HOST}/api/project-requests`);
  expect(captured.init.method).toBe('POST');
  // two-token, CP-asserts-the-tenant (Design A): SA JWT identifies the caller; X-Tenant-Id is the
  // resolved tenant uuid (NOT the license token); X-Subject-Id is omitted when the initiator is not
  // uuid-shaped ('user-1' here).
  expect(header(captured.init, 'authorization')).toBe(`Bearer ${SA_JWT}`);
  expect(header(captured.init, 'x-tenant-id')).toBe(TENANT);
  expect(header(captured.init, 'x-subject-id')).toBeUndefined();
  expect(header(captured.init, 'content-type')).toBe('application/json');

  const body = reqBody(captured.init);
  expect(body.external_ref).toBe('sol-1'); // cp_solution_id = fr idempotency key
  expect(body.external_origin.source).toBe('commonpractice');
  expect(body.external_origin.cp_solution_id).toBe('sol-1');
  expect(body.external_origin.cp_challenge_id).toBe('chal-1');
  expect(body.payload.name).toBe('Automate claims triage');
  expect(body.payload.repository_url).toBe(FR_REPO_SENTINEL);
  expect(body.payload.problem_statement).toBe('Manual triage is slow');
  expect(body.payload.desired_outcome).toBe('Time saved per week: 10h');
  expect(body.payload.acceptance_criteria).toEqual(['Time saved per week — target: 10h']);
  expect(body.payload.key_deliverables).toEqual(['Implement the "Classifier" step']);
  expect(body.payload.high_level_requirements).toEqual(['Deliver within the "ops" work area']);
  expect(body.payload.access_requirements).toEqual(['Claims (claims)']);
  expect(body.payload.requestor).toBe('user-1');
  expect(body.payload.lifecycle_class).toBe('workflow-improvement');
  expect(body.payload.shape).toBe('deliverable');
  expect(typeof body.payload.notes).toBe('string');
  expect((body.payload.notes as string).length).toBeGreaterThan(0);

  expect(result.externalRef).toBe('pr-123');
  expect(result.externalUrl).toBe(`https://${HOST}/projects/requests/pr-123`);
  expect(result.response).toEqual({ project_request_id: 'pr-123' });
});

test('uuid initiator → X-Subject-Id forwarded (provenance)', async () => {
  stubSa();
  const captured = stubFr({ status: 201, body: { project_request_id: 'pr-7' } });
  const SUBJECT = '11111111-2222-4333-8444-555566667777';
  await deliverFr(
    target(),
    payload({
      provenance: { ...payload().provenance, initiated_by: SUBJECT },
    }),
    SNAPSHOT,
  );
  expect(header(captured.init, 'x-tenant-id')).toBe(TENANT);
  expect(header(captured.init, 'x-subject-id')).toBe(SUBJECT);
});

test('numeric project_request_id is stringified', async () => {
  stubSa();
  stubFr({ status: 201, body: { project_request_id: 42 } });
  const result = await deliverFr(target(), payload(), SNAPSHOT);
  expect(result.externalRef).toBe('42');
  expect(result.externalUrl).toBe(`https://${HOST}/projects/requests/42`);
});

test('base_url trailing slashes are normalized in url + externalUrl', async () => {
  stubSa();
  const captured = stubFr({ status: 201, body: { project_request_id: 'pr-9' } });
  const result = await deliverFr(target({ base_url: `https://${HOST}///` }), payload(), SNAPSHOT);
  expect(captured.url).toBe(`https://${HOST}/api/project-requests`);
  expect(result.externalUrl).toBe(`https://${HOST}/projects/requests/pr-9`);
});

test('fr 4xx → DeliveryDispatchError carrying status + parsed body', async () => {
  stubSa();
  stubFr({ status: 400, body: { error: 'bad_request', detail: 'missing name' } });
  try {
    await deliverFr(target(), payload(), SNAPSHOT);
    throw new Error('expected throw');
  } catch (err) {
    expect(err).toBeInstanceOf(DeliveryDispatchError);
    const e = err as DeliveryDispatchError;
    expect(e.code).toBe('target_http_error');
    expect(e.status).toBe(400);
    expect(e.body).toEqual({ error: 'bad_request', detail: 'missing name' });
  }
});

test('fr 5xx with a non-JSON (HTML) body → DeliveryDispatchError with {raw}', async () => {
  stubSa();
  stubFr({ status: 502, body: '<html>Bad Gateway</html>' });
  try {
    await deliverFr(target(), payload(), SNAPSHOT);
    throw new Error('expected throw');
  } catch (err) {
    expect(err).toBeInstanceOf(DeliveryDispatchError);
    const e = err as DeliveryDispatchError;
    expect(e.status).toBe(502);
    expect(e.body).toEqual({ raw: '<html>Bad Gateway</html>' });
  }
});

test('201 without project_request_id → DeliveryDispatchError', async () => {
  stubSa();
  stubFr({ status: 201, body: { ok: true } });
  await expect(deliverFr(target(), payload(), SNAPSHOT)).rejects.toBeInstanceOf(DeliveryDispatchError);
});

test('assertFrConfigured: missing base_url → DeliveryConfigError', () => {
  expect(() => assertFrConfigured(target({ base_url: null }))).toThrow(DeliveryConfigError);
});

test('assertFrConfigured: missing credentials → DeliveryConfigError', () => {
  expect(() => assertFrConfigured(target({ credentials_encrypted: null }))).toThrow(DeliveryConfigError);
});

test('assertFrConfigured: credentials without licenseToken → DeliveryConfigError', () => {
  const t = target({ credentials_encrypted: encryptSecret(JSON.stringify({ nope: 'x' })) });
  expect(() => assertFrConfigured(t)).toThrow(DeliveryConfigError);
});

// ─────────────────────── pure mappers (envelope shape) ───────────────────────

test('buildFrProjectCreate maps every canonical field + sentinel repo url', () => {
  const pc = buildFrProjectCreate(payload());
  expect(pc.name).toBe('Automate claims triage');
  expect(pc.repository_url).toBe(FR_REPO_SENTINEL);
  expect(pc.lifecycle_class).toBe('workflow-improvement');
  expect(pc.shape).toBe('deliverable');
});

test('buildFrExternalOrigin carries the CP lineage', () => {
  const eo = buildFrExternalOrigin(payload());
  expect(eo).toEqual({
    source: 'commonpractice',
    cp_solution_id: 'sol-1',
    cp_challenge_id: 'chal-1',
    cp_flow_id: 'flow-1',
    cp_tenant_id: TENANT,
    initiated_by: 'user-1',
    votes_count: 3,
  });
});

test('buildFrNotes is always non-empty (provenance) and includes needs_human when present', () => {
  expect(buildFrNotes(payload())).toContain('Provide the target repository URL (fr)');
  // empty needs_human → still non-empty (provenance block)
  expect(buildFrNotes(payload({ needs_human: [] })).length).toBeGreaterThan(0);
});

// ─────────────────────────── Gate-2: assertFrLicense ───────────────────────────

test('Gate-2: active fr-family license for the tenant → resolves', async () => {
  stubLicense({ active: true, app: { key: 'fr' }, tenant_id: TENANT });
  await expect(assertFrLicense(LICENSE_TOKEN, TENANT)).resolves.toBeUndefined();
});

test('Gate-2: kanban + n8n app keys are accepted (default fr-bridge set)', async () => {
  stubLicense({ active: true, app: { key: 'kanban' }, tenant_id: TENANT });
  await expect(assertFrLicense(LICENSE_TOKEN, TENANT)).resolves.toBeUndefined();
  stubLicense({ active: true, app: { key: 'n8n' }, tenant_id: TENANT });
  await expect(assertFrLicense(LICENSE_TOKEN, TENANT)).resolves.toBeUndefined();
});

test('Gate-2: inactive license → FrLicenseError(inactive)', async () => {
  stubLicense({ active: false, app: { key: 'fr' }, tenant_id: TENANT });
  try {
    await assertFrLicense(LICENSE_TOKEN, TENANT);
    throw new Error('expected throw');
  } catch (err) {
    expect(err).toBeInstanceOf(FrLicenseError);
    expect((err as FrLicenseError).reason).toBe('inactive');
    // ⛔ ONE CODE PER REASON. This used to be `fr_license_required` for all four reasons, with the
    // difference carried only in the English `message` — which is exactly the part the browser
    // cannot localize. See the ⛔ block on FR_LICENSE_CODE in services/fr-license.ts.
    expect((err as FrLicenseError).code).toBe('fr_license_inactive');
  }
});

test('Gate-2: wrong app (commonpractice) → FrLicenseError(app_mismatch)', async () => {
  stubLicense({ active: true, app: { key: 'commonpractice' }, tenant_id: TENANT });
  try {
    await assertFrLicense(LICENSE_TOKEN, TENANT);
    throw new Error('expected throw');
  } catch (err) {
    expect((err as FrLicenseError).reason).toBe('app_mismatch');
    expect((err as FrLicenseError).code).toBe('fr_license_app_mismatch');
    // The app key stays in the ENGLISH message (the log line / MCP read) and deliberately does NOT
    // travel as a param: it is a licensing-server token the reader cannot act on.
    expect((err as FrLicenseError).message).toContain('commonpractice');
  }
});

test('Gate-2: tenant mismatch → FrLicenseError(tenant_mismatch)', async () => {
  stubLicense({ active: true, app: { key: 'fr' }, tenant_id: 'some-other-tenant' });
  try {
    await assertFrLicense(LICENSE_TOKEN, TENANT);
    throw new Error('expected throw');
  } catch (err) {
    expect((err as FrLicenseError).reason).toBe('tenant_mismatch');
    expect((err as FrLicenseError).code).toBe('fr_license_tenant_mismatch');
  }
});

test('Gate-2: introspect throws → fail-closed FrLicenseError(introspect_unavailable)', async () => {
  __setLicenseClientForTests({
    introspect: async () => {
      throw new LicenseClientError(503, 'down');
    },
  });
  try {
    await assertFrLicense(LICENSE_TOKEN, TENANT);
    throw new Error('expected throw');
  } catch (err) {
    expect(err).toBeInstanceOf(FrLicenseError);
    expect((err as FrLicenseError).reason).toBe('introspect_unavailable');
    expect((err as FrLicenseError).code).toBe('fr_license_unavailable');
  }
});

// ───────────────── route precheck: distinct 402 vs 422 (DB-free) ─────────────────

test('precheckTarget: fr + inactive license → 402 fr_license_inactive (before egress)', async () => {
  stubLicense({ active: false, app: { key: 'fr' }, tenant_id: TENANT });
  try {
    await precheckTarget(target());
    throw new Error('expected throw');
  } catch (err) {
    expect((err as { status: number }).status).toBe(402);
    expect((err as { code: string }).code).toBe('fr_license_inactive');
  }
});

// ⛔ THE FAIL-CLOSED ARM, THROUGH THE ROUTE. `assertFrLicense`'s own unit test above proves the
// FrLicenseError; this proves the code SURVIVES `paymentRequired(err.code, err.message)` at
// routes/delivery.ts:437 and arrives on the wire as a distinct 402 — which is the whole point of
// minting four codes, and the step the unit test cannot see.
//
// ⚠️ `paymentRequired` is called with `err.code`, NEVER a literal. A literal here would red the
// frontend scrape at error-message.backend-contract.test.ts:212, whose tempting repair — adding the
// code to LICENSE_BLOCK_CODES — is what would blank the entire SPA for one bad connector. Pinned in
// frontend/src/lib/api/fr-license-codes.guard.test.ts.
test('precheckTarget: fr + licenses service DOWN → fail-closed 402 fr_license_unavailable', async () => {
  __setLicenseClientForTests({
    introspect: async () => {
      throw new LicenseClientError(503, 'down');
    },
  });
  try {
    await precheckTarget(target());
    throw new Error('expected throw');
  } catch (err) {
    expect((err as { status: number }).status).toBe(402);
    expect((err as { code: string }).code).toBe('fr_license_unavailable');
    // The English sentence STAYS as `detail` — the log line, the MCP read, and the mid-roll
    // fallback an older bundle renders when it does not yet know this code.
    expect((err as { message: string }).message).toContain('could not be verified');
  }
});

test('the four reasons produce four DISTINCT codes — no two collapse', async () => {
  // The defect was one code for four reasons. Distinctness is the invariant, so assert it directly
  // rather than leaving it implied by four separate tests that each pass in isolation.
  const codes: string[] = [];
  for (const verdict of [
    { active: false, app: { key: 'fr' }, tenant_id: TENANT },
    { active: true, app: { key: 'commonpractice' }, tenant_id: TENANT },
    { active: true, app: { key: 'fr' }, tenant_id: 'another-tenant' },
  ]) {
    stubLicense(verdict);
    try {
      await assertFrLicense(LICENSE_TOKEN, TENANT);
      throw new Error('expected throw');
    } catch (err) {
      codes.push((err as FrLicenseError).code);
    }
  }
  __setLicenseClientForTests({
    introspect: async () => {
      throw new LicenseClientError(503, 'down');
    },
  });
  try {
    await assertFrLicense(LICENSE_TOKEN, TENANT);
    throw new Error('expected throw');
  } catch (err) {
    codes.push((err as FrLicenseError).code);
  }
  expect(codes).toEqual([
    'fr_license_inactive',
    'fr_license_app_mismatch',
    'fr_license_tenant_mismatch',
    'fr_license_unavailable',
  ]);
  expect(new Set(codes).size).toBe(4);
});

test('precheckTarget: fr + missing base_url → 422 (config precedes the license gate)', async () => {
  // license would be fine, but the config gap must short-circuit FIRST → 422, not 402.
  stubLicense({ active: true, app: { key: 'fr' }, tenant_id: TENANT });
  try {
    await precheckTarget(target({ base_url: null }));
    throw new Error('expected throw');
  } catch (err) {
    expect((err as { status: number }).status).toBe(422);
  }
});

test('precheckTarget: fr + valid license + allowlisted host → resolves with the snapshot', async () => {
  stubLicense({ active: true, app: { key: 'fr' }, tenant_id: TENANT });
  __setEgressHooksForTests({
    lookup: async () => ['93.184.216.34'],
    fetch: async () => new Response('{}', { status: 200 }),
  });
  // precheckTarget calls getSnapshot(); override it so we don't depend on the DB policy store.
  const { __setSnapshotOverrideForTests } = await import('../src/host/policy-store');
  __setSnapshotOverrideForTests(SNAPSHOT);
  try {
    const snap = await precheckTarget(target());
    expect(snap).toBeDefined();
  } finally {
    __setSnapshotOverrideForTests(undefined);
  }
});
