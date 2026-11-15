// tests/dataset-mappings.test.ts — Phase 3.3: the dataset → ontology mapping bridge.
// Depends on a seeded ontology (3.2 — seedOntology is idempotent, called in beforeAll).
// Drives the /api/datasets/:slug/mappings sub-routes against real CI Postgres :5433:
//   (a) heuristic suggest maps clm_amt → Claim.amount (synonym) for insurance × Claims;
//   (b) useLlm pass (test-injected chat provider) places an otherwise-unmatched column;
//   (c) PUT persists confirmed (source='human') rows, GET returns them;
//   (d) PUT is idempotent (one row per (dataset, entity));
//   (e) DELETE removes one mapping.
import { test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { eq } from 'drizzle-orm';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { __setBrokerDepsForTests } from '../src/host/llm-broker';
import { Router } from '../src/utils/router';
import { registerDatasetRoutes } from '../src/routes/datasets';
import { seedOntology } from '../src/db/seed-ontology';
import { db, withTenantDb, users, tenants, datasets, datasetRows, datasetMappings, usageCounters } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { User } from '../src/types';

const OWNER_ID = '00000000-0000-0000-0000-00000d300001';
const owner: User = { id: OWNER_ID, email: 'map@test', name: 'Map Owner', roles: ['super_admin', 'employee'], tenantId: OWNER_ID };

const router = new Router();
registerDatasetRoutes(router);

async function call(method: string, path: string, body?: unknown) {
  const matched = router.match(method, path.split('?')[0]!);
  if (!matched) throw new Error(`no route for ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await matched.handler(req, ...matched.params);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const SLUG = 'claims-april-maptest';

async function cleanup() {
  const owned = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, OWNER_ID));
  for (const d of owned) {
    await db.delete(datasetMappings).where(eq(datasetMappings.dataset_id, d.id));
    await db.delete(datasetRows).where(eq(datasetRows.dataset_id, d.id));
  }
  await db.delete(datasets).where(eq(datasets.owner_id, OWNER_ID));
  // The useLlm path meters through the broker → a usage_counters row (no FK cascade).
  await db.delete(usageCounters).where(eq(usageCounters.user_id, OWNER_ID));
  await db.update(users).set({ tenant_id: null }).where(eq(users.id, OWNER_ID));
  await db.delete(users).where(eq(users.id, OWNER_ID));
  await db.delete(tenants).where(eq(tenants.id, OWNER_ID));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await seedOntology(); // idempotent — guarantees the insurance × Claims cell exists.
  await cleanup();
  await db.insert(tenants).values({ id: OWNER_ID, name: 'Map Org', slug: `map-${OWNER_ID.slice(-6)}` }).onConflictDoNothing({ target: tenants.id });
  await db.insert(users).values({ id: OWNER_ID, email: owner.email, name: owner.name, tenant_id: OWNER_ID }).onConflictDoNothing();
  // A dataset with company-specific column names (clm_amt/pol_no/clm_status) + one junk col.
  await db.insert(datasets).values({
    owner_id: OWNER_ID,
    tenant_id: OWNER_ID,
    name: 'Claims April',
    slug: SLUG,
    source_type: 'json',
    columns: [
      { name: 'clm_amt', type: 'number' },
      { name: 'pol_no', type: 'string' },
      { name: 'clm_status', type: 'string' },
      { name: 'zzz_unknown', type: 'string' },
    ],
    row_count: 0,
  });
  __setAuthOverridesForTests({ validateAuth: async () => owner });
}, 30_000);
afterAll(async () => {
  await cleanup();
  __setAuthOverridesForTests(undefined);
  __setBrokerDepsForTests(undefined);
}, 30_000);
afterEach(() => __setBrokerDepsForTests(undefined));

test('heuristic suggest maps clm_amt → Claim.amount via synonym', async () => {
  const { status, json } = await call('POST', `/api/datasets/${SLUG}/mappings/suggest`, {
    industry: 'insurance',
    department: 'Claims',
    useLlm: false,
  });
  expect(status).toBe(200);
  expect(json.threshold).toBe(0.7);
  const claim = json.suggestions.find((s: { entityName: string }) => s.entityName === 'Claim');
  expect(claim).toBeDefined();
  expect(claim.columnMap.clm_amt).toBe('amount');
  expect(claim.columnMap.clm_status).toBe('status');
  expect(claim.confidence).toBeGreaterThan(0.7);
  // pol_no resolves to the Policy entity (policy_no synonym).
  const policy = json.suggestions.find((s: { entityName: string }) => s.entityName === 'Policy');
  expect(policy?.columnMap.pol_no).toBe('policy_no');
  // The junk column is left unmatched by the heuristic.
  const allMapped = json.suggestions.flatMap((s: { columnMap: Record<string, string> }) => Object.keys(s.columnMap));
  expect(allMapped).not.toContain('zzz_unknown');
});

test('useLlm places an otherwise-unmatched column via the metered broker', async () => {
  __setBrokerDepsForTests({
    chatProvider: {
      async chat() {
        return {
          text: '[{"column":"zzz_unknown","entity":"Claim","attribute":"reserve","confidence":0.6}]',
          usage: { tokensIn: 12, tokensOut: 8 },
        };
      },
    },
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  const { status, json } = await withTenantDb(DEMO_TENANT_ID, () =>
    call('POST', `/api/datasets/${SLUG}/mappings/suggest`, {
      industry: 'insurance',
      department: 'Claims',
      useLlm: true,
    }),
  );
  expect(status).toBe(200);
  const claim = json.suggestions.find((s: { entityName: string }) => s.entityName === 'Claim');
  expect(claim.columnMap.zzz_unknown).toBe('reserve');
  const llmCol = claim.columns.find((c: { column: string }) => c.column === 'zzz_unknown');
  expect(llmCol.origin).toBe('llm');
});

test('PUT persists confirmed mappings, GET returns them, and PUT is idempotent', async () => {
  // Get the Claim entity id from a suggest call.
  const sug = await call('POST', `/api/datasets/${SLUG}/mappings/suggest`, { industry: 'insurance', department: 'Claims' });
  const claim = sug.json.suggestions.find((s: { entityName: string }) => s.entityName === 'Claim');
  const payload = {
    mappings: [
      {
        entityId: claim.entityId,
        industry: 'insurance',
        department: 'Claims',
        columnMap: { clm_amt: 'amount', clm_status: 'status' },
        confidence: 0.95,
      },
    ],
  };
  const put1 = await call('PUT', `/api/datasets/${SLUG}/mappings`, payload);
  expect(put1.status).toBe(200);
  expect(put1.json.mappings).toHaveLength(1);
  expect(put1.json.mappings[0].source).toBe('human');
  expect(put1.json.mappings[0].confirmed).toBe(true);
  expect(put1.json.mappings[0].entityName).toBe('Claim');

  const get = await call('GET', `/api/datasets/${SLUG}/mappings`);
  expect(get.json.mappings).toHaveLength(1);
  expect(get.json.mappings[0].columnMap.clm_amt).toBe('amount');

  // Idempotent: a second PUT updates the same row, not a duplicate.
  const put2 = await call('PUT', `/api/datasets/${SLUG}/mappings`, payload);
  expect(put2.json.mappings).toHaveLength(1);
});

test('DELETE removes the one mapping it names, and leaves the others', async () => {
  // ⛔ SELF-CONTAINED ON PURPOSE. This case used to open with
  //     const entityId = (await call('GET', …)).json.mappings[0].entityId;
  // and so read a row the PUT case above had written. In FILE ORDER that always worked; under
  // `bun test --randomize` it died as `TypeError: undefined is not an object` whenever it drew a
  // slot before PUT — measured 10 red across 15 seeds (including --seed=3666192967), 0 red in file
  // order. CI does not randomize, so it was latent rather than flaky, which is worse: the day
  // someone reorders the file or turns randomization on, the failure names DELETE and not the
  // dependency. It now creates what it deletes.
  const sug = await call('POST', `/api/datasets/${SLUG}/mappings/suggest`, { industry: 'insurance', department: 'Claims' });
  const claim = sug.json.suggestions.find((s: { entityName: string }) => s.entityName === 'Claim');
  const policy = sug.json.suggestions.find((s: { entityName: string }) => s.entityName === 'Policy');
  expect(claim?.entityId).toBeTruthy();
  expect(policy?.entityId).toBeTruthy();
  expect(claim.entityId).not.toBe(policy.entityId);

  // TWO mappings, not one. A single-row fixture cannot tell "deleted the row I named" from
  // "emptied the table", and the assertion this case has to make is the former.
  const seeded = await call('PUT', `/api/datasets/${SLUG}/mappings`, {
    mappings: [
      { entityId: claim.entityId, industry: 'insurance', department: 'Claims', columnMap: { clm_amt: 'amount' }, confidence: 0.95 },
      { entityId: policy.entityId, industry: 'insurance', department: 'Claims', columnMap: { pol_no: 'policy_no' }, confidence: 0.95 },
    ],
  });
  expect(seeded.status).toBe(200);
  expect(seeded.json.mappings).toHaveLength(2);

  const del = await call('DELETE', `/api/datasets/${SLUG}/mappings/${claim.entityId}`);
  expect(del.status).toBe(200);

  // The row it named is GONE and the other one is untouched — a 200 alone proves neither.
  const after = await call('GET', `/api/datasets/${SLUG}/mappings`);
  const remaining = after.json.mappings.map((m: { entityId: string }) => m.entityId);
  expect(remaining).toHaveLength(1);
  expect(remaining).not.toContain(claim.entityId);
  expect(remaining).toEqual([policy.entityId]);

  // A second delete of the same id 404s (nothing left to remove).
  const del2 = await call('DELETE', `/api/datasets/${SLUG}/mappings/${claim.entityId}`);
  expect(del2.status).toBe(404);

  // Leave the dataset as this case found it (no mappings), so no later case inherits the survivor.
  expect((await call('DELETE', `/api/datasets/${SLUG}/mappings/${policy.entityId}`)).status).toBe(200);
  expect((await call('GET', `/api/datasets/${SLUG}/mappings`)).json.mappings).toHaveLength(0);
});
