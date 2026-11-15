// tests/delivery-azure-devops.test.ts — Phase 5C: the Azure DevOps (Boards) adapter, exercised
// end-to-end against the egress test-seam (__setEgressHooksForTests serves a canned ADO response —
// NO live ADO, NO network). Proves the JSON-Patch request shape (System.Title / Description /
// AcceptanceCriteria / Tags / AreaPath, the $<type> URL, the application/json-patch+json
// content-type, empty-username PAT Basic auth), empty-safe HTML, tag sanitization, base_url
// normalization, and the config/dispatch error taxonomy.
import { test, expect, afterEach } from 'bun:test';
import { __setEgressHooksForTests } from '../src/host/egress-guard';
import {
  deliverAzureDevOps,
  testAzureDevOpsConnection,
  assertAzureDevOpsConfigured,
  sanitizeAdoTags,
  buildAdoDescriptionHtml,
  buildAdoAcceptanceCriteriaHtml,
  escapeHtml,
} from '../src/host/delivery/azure-devops';
import { DeliveryConfigError, DeliveryDispatchError } from '../src/host/delivery/errors';
import { encryptSecret } from '../src/host/secret-box';
import type { DeliveryTarget } from '../src/db/schema';
import type { DeliveryPayload } from '../src/db/delivery-types';
import type { GovernanceSnapshot } from '../src/host/policy-store';

const HOST = 'cp-fake-ado.test';
const SNAPSHOT = { externalHttp: true, egressAllowlist: [HOST] } as unknown as GovernanceSnapshot;

afterEach(() => __setEgressHooksForTests(undefined));

function target(overrides: Partial<DeliveryTarget> = {}): DeliveryTarget {
  return {
    id: 't1',
    tenant_id: 'ten1',
    kind: 'azure_devops',
    name: 'Acme ADO',
    base_url: `https://${HOST}/acme-org`,
    project_key: 'Delivery',
    default_item_type: null,
    config: {},
    credentials_encrypted: encryptSecret(JSON.stringify({ pat: 'pat-123' })),
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
    labels: ['Claims; Ops', 'fast-track', 'source:commonpractice'],
    provenance: {
      cp_solution_id: 's1',
      cp_challenge_id: 'c1',
      cp_flow_id: null,
      cp_tenant_id: 'ten1',
      initiated_by: 'u1',
      votes_count: 3,
      flow_chain: [],
      blocks_used: ['Classifier'],
      datasets: ['claims'],
      ontology_entities: ['Claim'],
    },
    needs_human: ['Assign an owner / team in the target system'],
    ...overrides,
  };
}

/** Capture the outbound request the adapter makes, returning a canned response. */
function stubAdo(response: { status: number; body: unknown }) {
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

/** Pull a /fields/<ref> value out of the captured JSON-Patch body. */
function field(init: RequestInit, ref: string): string | undefined {
  const patch = JSON.parse(init.body as string) as { op: string; path: string; value: string }[];
  return patch.find((p) => p.path === `/fields/${ref}`)?.value;
}

test('creates an ADO work item: POSTs the right URL/body/auth and returns id + deep link', async () => {
  const cap = stubAdo({
    status: 200,
    body: { id: 42, _links: { html: { href: `https://${HOST}/acme-org/_workitems/edit/42` } } },
  });
  const res = await deliverAzureDevOps(target(), payload(), SNAPSHOT);

  expect(res.externalRef).toBe('42');
  expect(res.externalUrl).toBe(`https://${HOST}/acme-org/_workitems/edit/42`);
  expect(cap.url).toBe(
    `https://${HOST}/acme-org/Delivery/_apis/wit/workitems/$Epic?api-version=7.1`,
  );
  expect(cap.init.method).toBe('POST');

  const headers = cap.init.headers as Record<string, string>;
  expect(headers.authorization).toBe(`Basic ${Buffer.from(':pat-123').toString('base64')}`);
  expect(headers['content-type']).toBe('application/json-patch+json');

  expect(field(cap.init, 'System.Title')).toBe('Automate claims triage');
  expect(field(cap.init, 'System.Description')).toContain('<h3>Problem</h3>');
  expect(field(cap.init, 'Microsoft.VSTS.Common.AcceptanceCriteria')).toContain('<ul>');
});

test('default_item_type overrides the Epic default (in the $<type> URL)', async () => {
  const cap = stubAdo({ status: 200, body: { id: 7 } });
  await deliverAzureDevOps(target({ default_item_type: 'Feature' }), payload(), SNAPSHOT);
  expect(cap.url).toContain('/_apis/wit/workitems/$Feature?');
});

test('falls back to a constructed _workitems URL when ADO returns no _links.html', async () => {
  stubAdo({ status: 200, body: { id: 99 } });
  const res = await deliverAzureDevOps(target(), payload(), SNAPSHOT);
  expect(res.externalUrl).toBe(`https://${HOST}/acme-org/Delivery/_workitems/edit/99`);
});

test('tags are sanitized (no ; or ,) and joined with "; "', async () => {
  const cap = stubAdo({ status: 200, body: { id: 1 } });
  await deliverAzureDevOps(
    target(),
    payload({ labels: ['Claims; Ops', 'Claims; Ops', 'a,b', 'source:commonpractice'] }),
    SNAPSHOT,
  );
  const tags = field(cap.init, 'System.Tags');
  expect(tags).toBe('Claims Ops; a b; source:commonpractice');
});

test('sanitizeAdoTags: ;/, → space, collapse ws, dedupe, drop empties, preserve order', () => {
  expect(sanitizeAdoTags(['Claims; Ops', 'a , b', '', '  ', 'X', 'Claims;  Ops'])).toEqual([
    'Claims Ops',
    'a b',
    'X',
  ]);
});

test('area path is injected only when configured', async () => {
  const without = stubAdo({ status: 200, body: { id: 1 } });
  await deliverAzureDevOps(target(), payload(), SNAPSHOT);
  expect(field(without.init, 'System.AreaPath')).toBeUndefined();

  const withArea = stubAdo({ status: 200, body: { id: 2 } });
  await deliverAzureDevOps(
    target({ config: { ado_area_path: 'Delivery\\Claims' } }),
    payload(),
    SNAPSHOT,
  );
  expect(field(withArea.init, 'System.AreaPath')).toBe('Delivery\\Claims');
});

test('base_url trailing slashes are normalized in the API URL', async () => {
  const cap = stubAdo({ status: 200, body: { id: 9 } });
  await deliverAzureDevOps(target({ base_url: `https://${HOST}/acme-org//` }), payload(), SNAPSHOT);
  expect(cap.url).toBe(
    `https://${HOST}/acme-org/Delivery/_apis/wit/workitems/$Epic?api-version=7.1`,
  );
});

test('all-empty sections produce VALID HTML (no empty <ul>; provenance survives)', () => {
  const html = buildAdoDescriptionHtml(
    payload({
      deliverables: [],
      requirements: [],
      data_access: [],
      needs_human: [],
      problem: '',
      outcome: '',
    }),
  );
  expect(html).not.toContain('<ul></ul>');
  expect(html).not.toContain('<p></p>');
  // Provenance is always present → never empty.
  expect(html).toContain('Provenance (Common Practice)');
  expect(html.length).toBeGreaterThan(0);
  // No acceptance criteria → the AcceptanceCriteria field renders as ''.
  expect(buildAdoAcceptanceCriteriaHtml(payload({ acceptance_criteria: [] }))).toBe('');
});

test('description text is HTML-escaped (no injection from payload content)', () => {
  const html = buildAdoDescriptionHtml(payload({ problem: 'a < b & c > "d"' }));
  expect(html).toContain('a &lt; b &amp; c &gt; &quot;d&quot;');
  expect(escapeHtml(`<script>'x'`)).toBe('&lt;script&gt;&#39;x&#39;');
});

test('an ADO 4xx → DeliveryDispatchError carrying the status + parsed error body', async () => {
  stubAdo({ status: 400, body: { message: 'TF401320: Rule Error' } });
  await expect(deliverAzureDevOps(target(), payload(), SNAPSHOT)).rejects.toMatchObject({
    name: 'DeliveryDispatchError',
    code: 'target_http_error',
    status: 400,
  });
});

test('a non-JSON 5xx body is wrapped as {raw} (jsonb-safe), not thrown as a parse error', async () => {
  stubAdo({ status: 503, body: '<html>Service Unavailable</html>' });
  try {
    await deliverAzureDevOps(target(), payload(), SNAPSHOT);
    throw new Error('expected throw');
  } catch (err) {
    expect(err).toBeInstanceOf(DeliveryDispatchError);
    expect((err as DeliveryDispatchError).status).toBe(503);
    expect((err as DeliveryDispatchError).body).toEqual({ raw: '<html>Service Unavailable</html>' });
  }
});

test('a 2xx without an id → DeliveryDispatchError (ADO accepted but returned nothing usable)', async () => {
  stubAdo({ status: 200, body: { message: 'ok but weird' } });
  await expect(deliverAzureDevOps(target(), payload(), SNAPSHOT)).rejects.toBeInstanceOf(
    DeliveryDispatchError,
  );
});

test('missing PAT → DeliveryConfigError (a config gap, not a dispatch failure)', () => {
  expect(() => assertAzureDevOpsConfigured(target({ credentials_encrypted: null }))).toThrow(
    DeliveryConfigError,
  );
});

test('missing project / base_url → DeliveryConfigError', () => {
  expect(() => assertAzureDevOpsConfigured(target({ project_key: null }))).toThrow(
    DeliveryConfigError,
  );
  expect(() => assertAzureDevOpsConfigured(target({ base_url: null }))).toThrow(DeliveryConfigError);
});


// ---- testAzureDevOpsConnection: a 2xx is not a project ----------------------------------------
// ⛔ THIS SURFACE HAD NO TESTS AT ALL before this file's last section — neither ADO nor its Jira
// sibling. The success arm reported `Connected to Azure DevOps project "X"` where X came from the
// target's CONFIG, never from the response, so the sentence was true by construction and no test
// could have caught it being wrong.

test('a 2xx that identifies the project succeeds, and prefers the name ADO returned', async () => {
  stubAdo({ status: 200, body: { id: 'p-1', name: 'Delivery Renamed', state: 'wellFormed' } });
  const r = await testAzureDevOpsConnection(target(), SNAPSHOT);
  expect(r.ok).toBe(true);
  expect(r.code).toBe('delivery_test_ado_ok');
  // The RETURNED name, not the configured `project_key` ('Delivery') — so a rename or a case
  // mismatch is visible to the admin instead of being echoed back at them.
  expect(r.detail).toContain('Delivery Renamed');
});

test('a 203 carrying no project is NOT a successful connection', async () => {
  // ⛔ THE DEFECT. dev.azure.com answers an auth failure with 203 Non-Authoritative Information
  // rather than 401 (Microsoft moderator answer, learn.microsoft.com/answers, 2025-07-08). 203 sits
  // inside the 2xx success arm, so the 401/403 branch below it is UNREACHABLE for that case: before
  // this check the admin was told the connector was good and the failure only surfaced later, at a
  // real dispatch, as a failed delivery.
  stubAdo({ status: 203, body: { message: 'sign in' } });
  const r = await testAzureDevOpsConnection(target(), SNAPSHOT);
  expect(r.ok).toBe(false);
  expect(r.code).toBe('delivery_test_ado_unauthorized');
});

test('a 2xx with an empty body is not a successful connection either', async () => {
  // Deliberately separate from the 203 case: this asserts the check keys on ABSENT IDENTIFICATION,
  // not on the status code. Hardening against 203 specifically would leave every other
  // body-less 2xx reading as success, and the "expired PAT returns an HTML sign-in page" detail is
  // folklore with no primary source — so the check must not depend on the body's shape.
  stubAdo({ status: 200, body: {} });
  const r = await testAzureDevOpsConnection(target(), SNAPSHOT);
  expect(r.ok).toBe(false);
  expect(r.code).toBe('delivery_test_ado_unauthorized');
});

test('a real 401 still reports unauthorized — the existing arm is untouched', async () => {
  stubAdo({ status: 401, body: {} });
  const r = await testAzureDevOpsConnection(target(), SNAPSHOT);
  expect(r.ok).toBe(false);
  expect(r.code).toBe('delivery_test_ado_unauthorized');
});
