// tests/delivery-refusal-detail.test.ts — the machine fields behind a delivery refusal must reach
// the HTTP BODY, not just the exception.
//
// ⛔ THE DEFECT THIS PINS IS A SILENT DOWNGRADE, NOT A CRASH. `delivery_target_incomplete` is thrown
// from FIVE sites with five different English sentences and `delivery_target_credentials_invalid`
// from SIX (host/delivery/{jira,azure-devops,fr}.ts). Every one of them is re-thrown by the SAME
// line in routes/delivery.ts — `unprocessable(err.code, err.message, err.detail)` — so a browser
// keying on `code` alone can say no more than "this connector is not fully configured", which is
// strictly LESS than the English it replaces. `DeliveryConfigError.detail` is what makes the
// localized sentence an upgrade instead; drop the third argument and the SPA silently falls back to
// the coarse sentence for every one of these, with nothing in either project going red.
//
// ⛔ SO EVERY ASSERTION HERE IS AGAINST THE PARSED RESPONSE BODY. Asserting on the thrown
// `DeliveryConfigError` would prove the adapters populate the bag and prove nothing about the
// forwarding, which is the half that was missing and the half a route refactor breaks.
//
// ⛔ AND THE ENGLISH `message` IS ASSERTED BYTE FOR BYTE, DELIBERATELY. It is not legacy weight: it
// is the correct output for the reader that is NOT a browser (an MCP/LLM client, a curl in an
// incident) and it is the frontend's documented fallback for a pod that ships no `detail` — see
// frontend/src/lib/i18n/graph-issue-label.ts for the split. A "cleanup" that replaced the sentence
// with the code, or reworded it into the detail bag, has to red here.
//
// Drives the real router + tenant-bound db with auth faked, the governance snapshot pinned, and DNS
// stubbed through the egress seam. No network. Sibling of delivery-forward.test.ts, which owns the
// status/row-count half of these same refusals.
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { inArray } from 'drizzle-orm';
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
import type { GovernanceSnapshot } from '../src/host/policy-store';
import type { User } from '../src/types';

const T = '00000000-0000-0000-0000-00005e000001';
const USER = '00000000-0000-0000-0000-00005ea00001';
const CH = '00000000-0000-0000-0000-00005ec00001';
const SOL = '00000000-0000-0000-0000-00005ed00001';

const HOST = 'cp-detail-jira.test';
const SNAPSHOT = { externalHttp: true, egressAllowlist: [HOST] } as unknown as GovernanceSnapshot;

const admin: User = {
  id: USER,
  email: 'detail-admin@test',
  name: 'Admin',
  roles: ['tenant_admin'],
  tenantId: T,
};

const router = new Router();
registerDeliveryRoutes(router);

async function forward(targetId: string): Promise<Response> {
  const m = router.match('POST', `/api/solutions/${SOL}/forward`)!;
  const req = new Request(`http://t/api/solutions/${SOL}/forward`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target_id: targetId }),
  });
  return m.handler(req, ...m.params);
}

/**
 * The refusal body as the SPA's `unwrap` sees it.
 *
 * ⚠️ `details` AND THE TOP LEVEL ARE BOTH READ, because utils/http.ts writes BOTH — `details:
 * err.details` plus a spread of the same object at the top level, for clients that predate the
 * nested bag. The frontend lifts the NESTED one (`parse.ts`'s `detailsFrom(body)` reads
 * `body.details`), so `details` is the load-bearing half here and the top level is asserted as the
 * compatibility promise it is.
 */
async function refusal(res: Response): Promise<{
  error: string;
  message: string;
  details: Record<string, unknown>;
  top: Record<string, unknown>;
}> {
  const body = (await res.json()) as Record<string, unknown>;
  return {
    error: body.error as string,
    message: body.message as string,
    details: (body.details ?? {}) as Record<string, unknown>,
    top: body,
  };
}

type TargetKind = 'jira' | 'azure_devops' | 'fr';

// ⚠️ NO CASE FOR `delivery_target_kind_unsupported`, AND THAT IS A MEASUREMENT, NOT AN OMISSION.
// `SUPPORTED_FORWARD_KINDS` is byte-identical to the whole `delivery_target_kind` pg enum, so the
// gate at routes/delivery.ts:692/:749 cannot fire and no fixture can make it. A test that forced it
// by writing an out-of-band enum value would be testing postgres, not the route. It is registered
// as unreachable in frontend/src/lib/api/error-message.ts's NOT_LOCALIZED_CODES with that reason.

async function makeTarget(overrides: {
  kind?: TargetKind;
  base_url?: string | null;
  project_key?: string | null;
  /** `null` = no stored blob; a string = stored VERBATIM (for the undecryptable case). */
  credentials?: object | null | string;
}): Promise<string> {
  const creds = overrides.credentials;
  const [row] = await db
    .insert(deliveryTargets)
    .values({
      tenant_id: T,
      kind: overrides.kind ?? 'jira',
      name: `D-${Math.round(performance.now() * 1000)}`,
      base_url: overrides.base_url === undefined ? `https://${HOST}` : overrides.base_url,
      project_key: overrides.project_key === undefined ? 'DEL' : overrides.project_key,
      credentials_encrypted:
        creds === null
          ? null
          : typeof creds === 'string'
            ? creds
            : encryptSecret(JSON.stringify(creds ?? { email: 'a@b.test', apiToken: 'tok' })),
      enabled: true,
    })
    .returning({ id: deliveryTargets.id });
  return row!.id;
}

async function cleanup() {
  await db.delete(solutionDeliveries).where(inArray(solutionDeliveries.tenant_id, [T]));
  await db.delete(deliveryTargets).where(inArray(deliveryTargets.tenant_id, [T]));
  await db.delete(solutions).where(inArray(solutions.tenant_id, [T]));
  await db.delete(challenges).where(inArray(challenges.tenant_id, [T]));
  await db.delete(users).where(inArray(users.id, [USER]));
  await db.delete(tenants).where(inArray(tenants.id, [T]));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values({ id: T, name: 'Detail Tenant', slug: 'detail-tenant' });
  await db.insert(users).values({ id: USER, email: 'da@test', name: 'A', tenant_id: T });
  await db.insert(challenges).values({
    id: CH,
    title: 'Claims triage',
    description: 'Triage is slow',
    business_impact: 'High backlog',
    work_area: 'Claims Ops',
    metrics: { timeSavedPerWeek: '10h' },
    tags: ['fast-track'],
    submitter_id: USER,
    tenant_id: T,
  });
  await db.insert(solutions).values({
    id: SOL,
    challenge_id: CH,
    title: 'Automate triage',
    author_id: USER,
    blocks_used: ['Classifier'],
    tenant_id: T,
  });
  __setAuthOverridesForTests({ validateAuth: async () => admin, requireRole: async () => admin });
  __setSnapshotOverrideForTests(SNAPSHOT);
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
  __setEgressHooksForTests(undefined);
  __setSnapshotOverrideForTests(undefined);
}, 30_000);

beforeEach(async () => {
  await db.delete(solutionDeliveries).where(inArray(solutionDeliveries.tenant_id, [T]));
  await db.delete(deliveryTargets).where(inArray(deliveryTargets.tenant_id, [T]));
  __setEgressHooksForTests(undefined);
}, 30_000);

/**
 * One config refusal: the target row, and the exact wire shape it must produce.
 *
 * ⛔ `message` IS THE ADAPTER'S SENTENCE, COPIED CHARACTER FOR CHARACTER out of
 * host/delivery/*.ts. That is what makes this a pin rather than a paraphrase — see the header.
 */
const CONFIG_CASES: {
  what: string;
  target: Parameters<typeof makeTarget>[0];
  code: string;
  message: string;
  detail: Record<string, unknown>;
}[] = [
  {
    what: 'jira.ts:133 — no base URL',
    target: { kind: 'jira', base_url: null },
    code: 'delivery_target_incomplete',
    message: 'This Jira connector is missing its base URL',
    detail: { kind: 'jira', field: 'base_url' },
  },
  {
    what: 'jira.ts:136 — no project key',
    target: { kind: 'jira', project_key: null },
    code: 'delivery_target_incomplete',
    message: 'This Jira connector is missing its project key',
    detail: { kind: 'jira', field: 'project_key' },
  },
  {
    // ⛔ THE ONE THAT PROVES `field` IS THE FORM'S BOX, NOT THE VENDOR'S NOUN. ADO's English says
    // "organization URL"; the input the reader has to fill is the same `base_url` the form labels
    // "Base URL" for all three kinds. A bag that invented an `organization_url` value would leave
    // the frontend with a fourth arm to write and the reader with a field name the UI never shows.
    what: 'azure-devops.ts:149 — no organization URL',
    target: { kind: 'azure_devops', base_url: null },
    code: 'delivery_target_incomplete',
    message: 'This Azure DevOps connector is missing its organization URL',
    detail: { kind: 'azure_devops', field: 'base_url' },
  },
  {
    what: 'azure-devops.ts:155 — no project',
    target: { kind: 'azure_devops', project_key: null, credentials: { pat: 'p' } },
    code: 'delivery_target_incomplete',
    message: 'This Azure DevOps connector is missing its project',
    detail: { kind: 'azure_devops', field: 'project_key' },
  },
  {
    what: 'fr.ts:93 — no base URL',
    target: { kind: 'fr', base_url: null, credentials: { licenseToken: 'lic' } },
    code: 'delivery_target_incomplete',
    message: 'This fr connector is missing its base URL',
    detail: { kind: 'fr', field: 'base_url' },
  },
  {
    // A stored blob that is not this box's ciphertext at all — `decryptSecret` throws inside the
    // adapter's try, which is the `undecryptable` arm.
    what: 'jira.ts:108 — ciphertext will not decrypt',
    target: { kind: 'jira', credentials: 'bm90LWEtY2lwaGVydGV4dA==' },
    code: 'delivery_target_credentials_invalid',
    message: 'The stored Jira credentials could not be decrypted',
    detail: { kind: 'jira', reason: 'undecryptable' },
  },
  {
    // Decrypts fine, wrong shape — the `malformed` arm. Two causes, one repair, but only this one
    // tells the admin a token IS stored.
    what: 'jira.ts:116 — decrypts to the wrong shape',
    target: { kind: 'jira', credentials: { email: 'a@b.test' } },
    code: 'delivery_target_credentials_invalid',
    message: 'Jira credentials must include a non-empty {email, apiToken}',
    detail: { kind: 'jira', reason: 'malformed' },
  },
  {
    what: 'azure-devops.ts:130 — decrypts to the wrong shape',
    target: { kind: 'azure_devops', credentials: { notPat: 'x' } },
    code: 'delivery_target_credentials_invalid',
    message: 'Azure DevOps credentials must include a non-empty {pat}',
    detail: { kind: 'azure_devops', reason: 'malformed' },
  },
  {
    what: 'fr.ts:77 — decrypts to the wrong shape',
    target: { kind: 'fr', credentials: { notAToken: 'x' } },
    code: 'delivery_target_credentials_invalid',
    message: 'fr credentials must include a non-empty {licenseToken}',
    detail: { kind: 'fr', reason: 'malformed' },
  },
  {
    // No `field`/`reason` — there is only ONE sentence per kind here, so `kind` is the whole bag.
    what: 'azure-devops.ts:114 — no stored credentials',
    target: { kind: 'azure_devops', credentials: null },
    code: 'delivery_target_credentials_missing',
    message: 'This Azure DevOps connector has no stored credentials',
    detail: { kind: 'azure_devops' },
  },
  {
    what: 'fr.ts:61 — no stored license token',
    target: { kind: 'fr', credentials: null },
    code: 'delivery_target_credentials_missing',
    message: 'This fr connector has no stored license token',
    detail: { kind: 'fr' },
  },
];

for (const c of CONFIG_CASES) {
  test(`the detail bag reaches the 422 body — ${c.what}`, async () => {
    const targetId = await makeTarget(c.target);
    const res = await forward(targetId);
    expect(res.status).toBe(422);

    const { error, message, details, top } = await refusal(res);
    expect(error).toBe(c.code);
    // BYTE FOR BYTE — see the header. The English is the non-browser reader's output and the
    // frontend's mid-roll fallback; it is not free to drift.
    expect(message).toBe(c.message);
    // The load-bearing half: the nested bag `parse.ts`'s `detailsFrom(body)` lifts.
    expect(details).toEqual(c.detail);
    // …and the top-level spread utils/http.ts promises to pre-`details` clients.
    for (const [k, v] of Object.entries(c.detail)) expect(top[k]).toBe(v as string);
  });
}

test('egress_bad_target carries the connector kind, which the egress guard itself does not know', async () => {
  // ⛔ THE BAG IS ADDED AT THE ROUTE, NOT AT THE THROW. `EgressBlockedError` is minted in
  // host/egress-guard.ts, which is shared with the connector-refresh path and has no notion of a
  // delivery connector — so `{ kind: target.kind }` is attached in routes/delivery.ts where `target`
  // is in scope. Without it the SPA cannot name the tool and falls back to the English.
  __setEgressHooksForTests({
    lookup: async () => {
      throw new Error('nxdomain');
    },
  });
  const targetId = await makeTarget({ kind: 'azure_devops', credentials: { pat: 'p' } });
  const res = await forward(targetId);
  expect(res.status).toBe(422);

  const { error, message, details } = await refusal(res);
  expect(error).toBe('egress_bad_target');
  expect(message).toBe(`cannot resolve host '${HOST}'`);
  expect(details).toEqual({ kind: 'azure_devops' });
});

test('⛔ the case table really exercises both overloaded codes and all three adapters', () => {
  // Non-vacuity. Every assertion above lives inside a generated `test`, so an emptied or narrowed
  // table would take the whole file green with it — the failure mode this repo keeps meeting.
  const codes = new Set(CONFIG_CASES.map((c) => c.code));
  expect(codes.has('delivery_target_incomplete')).toBe(true);
  expect(codes.has('delivery_target_credentials_invalid')).toBe(true);
  expect(codes.has('delivery_target_credentials_missing')).toBe(true);

  const kinds = new Set(CONFIG_CASES.map((c) => c.detail.kind));
  expect([...kinds].sort()).toEqual(['azure_devops', 'fr', 'jira']);

  // Both discriminators are exercised, in both of their values — a table that only ever asserted
  // `{kind}` would pass while `field`/`reason` were dropped at the route.
  const fields = CONFIG_CASES.map((c) => c.detail.field).filter(Boolean);
  const reasons = CONFIG_CASES.map((c) => c.detail.reason).filter(Boolean);
  expect([...new Set(fields)].sort()).toEqual(['base_url', 'project_key']);
  expect([...new Set(reasons)].sort()).toEqual(['malformed', 'undecryptable']);

  // Every English sentence is distinct: the whole reason the bag exists is that ONE code carries
  // several of them, so a table with duplicates would be testing one arm several times.
  expect(new Set(CONFIG_CASES.map((c) => c.message)).size).toBe(CONFIG_CASES.length);
});
