// tests/delivery-jira.test.ts — Phase 5B: the Jira Cloud adapter, exercised end-to-end against
// the egress test-seam (__setEgressHooksForTests serves a canned Jira response — NO live Jira,
// NO network). Proves the request shape (project/issuetype/summary/Basic auth), empty-safe ADF,
// label sanitization, base_url normalization, and the config/dispatch error taxonomy.
import { test, expect, afterEach } from 'bun:test';
import { __setEgressHooksForTests } from '../src/host/egress-guard';
import {
  deliverJira,
  sanitizeJiraLabels,
  buildJiraDescription,
  assertJiraConfigured,
} from '../src/host/delivery/jira';
import { DeliveryConfigError, DeliveryDispatchError } from '../src/host/delivery/errors';
import { encryptSecret } from '../src/host/secret-box';
import type { DeliveryTarget } from '../src/db/schema';
import type { DeliveryPayload } from '../src/db/delivery-types';
import type { GovernanceSnapshot } from '../src/host/policy-store';

const HOST = 'cp-fake-jira.test';
const SNAPSHOT = { externalHttp: true, egressAllowlist: [HOST] } as unknown as GovernanceSnapshot;

afterEach(() => __setEgressHooksForTests(undefined));

function target(overrides: Partial<DeliveryTarget> = {}): DeliveryTarget {
  return {
    id: 't1',
    tenant_id: 'ten1',
    kind: 'jira',
    name: 'Acme Jira',
    base_url: `https://${HOST}`,
    project_key: 'DEL',
    default_item_type: null,
    config: {},
    credentials_encrypted: encryptSecret(JSON.stringify({ email: 'ops@acme.io', apiToken: 'tok-123' })),
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
    labels: ['Claims Ops', 'fast-track', 'source:commonpractice'],
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
function stubJira(response: { status: number; body: unknown }) {
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

test('creates a Jira issue: POSTs the right URL/body/auth and returns key + deep link', async () => {
  const cap = stubJira({ status: 201, body: { id: '10001', key: 'DEL-42', self: 'https://x/10001' } });
  const res = await deliverJira(target(), payload(), SNAPSHOT);

  expect(res.externalRef).toBe('DEL-42');
  expect(res.externalUrl).toBe(`https://${HOST}/browse/DEL-42`);
  expect(cap.url).toBe(`https://${HOST}/rest/api/3/issue`);
  expect(cap.init.method).toBe('POST');

  const headers = cap.init.headers as Record<string, string>;
  const expectedAuth = `Basic ${Buffer.from('ops@acme.io:tok-123').toString('base64')}`;
  expect(headers.authorization).toBe(expectedAuth);
  expect(headers['content-type']).toBe('application/json');

  const sent = JSON.parse(cap.init.body as string);
  expect(sent.fields.project.key).toBe('DEL');
  expect(sent.fields.issuetype.name).toBe('Epic'); // default when default_item_type is null
  expect(sent.fields.summary).toBe('Automate claims triage');
  expect(sent.fields.description.type).toBe('doc');
});

test('default_item_type overrides the Epic default', async () => {
  const cap = stubJira({ status: 201, body: { key: 'DEL-7' } });
  await deliverJira(target({ default_item_type: 'Story' }), payload(), SNAPSHOT);
  expect(JSON.parse(cap.init.body as string).fields.issuetype.name).toBe('Story');
});

test('labels are sanitized (no spaces / invalid chars), deduped', async () => {
  const cap = stubJira({ status: 201, body: { key: 'DEL-1' } });
  await deliverJira(
    target(),
    payload({ labels: ['Claims Ops', 'Claims Ops', 'source:commonpractice', '  '] }),
    SNAPSHOT,
  );
  expect(JSON.parse(cap.init.body as string).fields.labels).toEqual([
    'Claims-Ops',
    'source-commonpractice',
  ]);
});

test('sanitizeJiraLabels: whitespace→-, dedupe, drop empties, preserve order+case', () => {
  expect(sanitizeJiraLabels(['Claims Ops', 'a/b', 'a-b', '', '  ', 'X'])).toEqual([
    'Claims-Ops',
    'a-b',
    'X',
  ]);
});

test('base_url trailing slashes are normalized in both the API URL and the browse link', async () => {
  const cap = stubJira({ status: 201, body: { key: 'DEL-9' } });
  const res = await deliverJira(target({ base_url: `https://${HOST}//` }), payload(), SNAPSHOT);
  expect(cap.url).toBe(`https://${HOST}/rest/api/3/issue`);
  expect(res.externalUrl).toBe(`https://${HOST}/browse/DEL-9`);
});

test('all-empty sections produce a VALID ADF (no empty bulletList/text; provenance survives)', () => {
  const adf = buildJiraDescription(
    payload({
      acceptance_criteria: [],
      data_access: [],
      deliverables: [],
      requirements: [],
      needs_human: [],
      problem: '',
      outcome: '',
    }),
  );
  const content = (adf as { content: { type: string }[] }).content;
  // No empty bullet lists, no empty text nodes anywhere.
  const json = JSON.stringify(adf);
  expect(json).not.toContain('"text":""');
  expect(content.some((n) => n.type === 'bulletList')).toBe(false);
  // Provenance is always present → the doc is never empty.
  expect(content.length).toBeGreaterThan(0);
  expect(content.at(-1)!.type).toBe('codeBlock');
});

test('a Jira 4xx → DeliveryDispatchError carrying the status + parsed error body', async () => {
  stubJira({ status: 400, body: { errorMessages: [], errors: { summary: 'is required' } } });
  await expect(deliverJira(target(), payload(), SNAPSHOT)).rejects.toMatchObject({
    name: 'DeliveryDispatchError',
    code: 'target_http_error',
    status: 400,
  });
});

test('a non-JSON 5xx body is wrapped as {raw} (jsonb-safe), not thrown as a parse error', async () => {
  stubJira({ status: 502, body: '<html>Bad Gateway</html>' });
  try {
    await deliverJira(target(), payload(), SNAPSHOT);
    throw new Error('expected throw');
  } catch (err) {
    expect(err).toBeInstanceOf(DeliveryDispatchError);
    expect((err as DeliveryDispatchError).status).toBe(502);
    expect((err as DeliveryDispatchError).body).toEqual({ raw: '<html>Bad Gateway</html>' });
  }
});

test('missing credentials → DeliveryConfigError (a config gap, not a dispatch failure)', () => {
  expect(() => assertJiraConfigured(target({ credentials_encrypted: null }))).toThrow(
    DeliveryConfigError,
  );
});

test('missing project_key / base_url → DeliveryConfigError', () => {
  expect(() => assertJiraConfigured(target({ project_key: null }))).toThrow(DeliveryConfigError);
  expect(() => assertJiraConfigured(target({ base_url: null }))).toThrow(DeliveryConfigError);
});
