// tests/ontology-mcp.test.ts — Phase 3.4: AI ontology reasoning via MCP.
// Drives the three ontology tools + the ontology:// resource + the seed-ai drift-update
// through the in-process McpHost against real CI Postgres :5433 (no HTTP server):
//   (a) get_ontology resolves the (industry × department) cell — explicitly, and by
//       auto-selection from a tenant.industry + a challenge.work_area; a null-industry
//       tenant returns the explicit-args hint, not a crash;
//   (b) map_dataset returns a heuristic proposal, an opt-in LLM proposal (test-injected
//       broker), and the human-confirmed mapping once one is persisted;
//   (c) explain_relations returns the Claim —under→ Policy edge with cardinality;
//   (d) the ontology:// resource reads + lists;
//   (e) seedAi() drift-updates a stale global prompt (bump + history) and leaves a
//       tenant-overridden prompt untouched.
// Depends on a seeded ontology (3.2 — seedOntology is idempotent, called in beforeAll)
// and on migration 0020 (tenants.industry).
import { test, expect, beforeAll, afterAll, afterEach, describe } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { mcpHost, type McpAuthContext } from '../src/ai/mcp-server';
import { seedOntology } from '../src/db/seed-ontology';
import { seedAi } from '../src/db/seed-ai';
import { __setBrokerDepsForTests } from '../src/host/llm-broker';
import { upsertMapping } from '../src/datasets/mapping-service';
import type { CompiledOntology } from '../src/ontology/ontology-service';
import {
  db,
  withTenantDb,
  users,
  tenants,
  challenges,
  datasets,
  datasetRows,
  datasetMappings,
  usageCounters,
  mcpPrompts,
  mcpPromptVersions,
} from '../src/db/client';

const OWNER_ID = '00000000-0000-0000-0000-00000d340001';
const TENANT_INS = '00000000-0000-0000-0000-00000d340010'; // industry = insurance
const TENANT_NONE = '00000000-0000-0000-0000-00000d340011'; // industry = null
const CHALLENGE_ID = '00000000-0000-0000-0000-00000d340020'; // work_area = Claims
// ⛔ MUST BE A UUID. `mcp_prompts.tenant_id` is `uuid` as of migration 0084 (it was `text`,
// which is what the old 'test-drift-tenant-340' value relied on). A non-uuid here now raises
// 22P02 at the INSERT below, so the test errors out before it can assert anything about the
// seeder leaving tenant overrides alone.
const DRIFT_TENANT = '00000000-0000-0000-0000-00000d340012';
const SLUG = 'claims-april-mcptest';

let datasetId = '';

function ctx(over: Partial<McpAuthContext> = {}): McpAuthContext {
  // Phase 3.6: dataset tools scope by tenant_id; the owner's data lives in the owner's
  // (personal) tenant, so default the ctx tenant to OWNER_ID. Ontology-cell tests
  // override tenantId explicitly (TENANT_INS / TENANT_NONE).
  return { userId: OWNER_ID, tenantId: OWNER_ID, roles: [], ...over };
}

async function cleanup() {
  const owned = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.owner_id, OWNER_ID));
  for (const d of owned) {
    await db.delete(datasetMappings).where(eq(datasetMappings.dataset_id, d.id));
    await db.delete(datasetRows).where(eq(datasetRows.dataset_id, d.id));
  }
  await db.delete(datasets).where(eq(datasets.owner_id, OWNER_ID));
  await db.delete(usageCounters).where(eq(usageCounters.user_id, OWNER_ID));
  await db.delete(challenges).where(eq(challenges.id, CHALLENGE_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT_INS));
  await db.delete(tenants).where(eq(tenants.id, TENANT_NONE));
  await db.delete(mcpPrompts).where(sql`${mcpPrompts.tenant_id} = ${DRIFT_TENANT}`);
  await db.delete(users).where(eq(users.id, OWNER_ID));
  await db.delete(tenants).where(eq(tenants.id, OWNER_ID));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await seedOntology(); // idempotent — guarantees the insurance × Claims cell exists.
  await cleanup();
  await db.insert(tenants).values({ id: OWNER_ID, name: 'MCP Personal', slug: 'mcp-personal-340' });
  await db.insert(users).values({ id: OWNER_ID, email: 'mcp@test', name: 'MCP Owner', tenant_id: OWNER_ID }).onConflictDoNothing();
  await db.insert(tenants).values({ id: TENANT_INS, name: 'Ins Co', slug: 'ins-co-340', industry: 'insurance' });
  await db.insert(tenants).values({ id: TENANT_NONE, name: 'No Industry', slug: 'no-ind-340' });
  await db.insert(challenges).values({
    id: CHALLENGE_ID,
    title: 'Speed up claims triage',
    work_area: 'Claims',
    submitter_id: OWNER_ID,
    tenant_id: OWNER_ID,
  });
  const [d] = await db
    .insert(datasets)
    .values({
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
    })
    .returning({ id: datasets.id });
  datasetId = d!.id;
}, 30_000);

afterAll(async () => {
  await cleanup();
  __setBrokerDepsForTests(undefined);
}, 30_000);
afterEach(() => __setBrokerDepsForTests(undefined));

describe('get_ontology', () => {
  test('explicit (insurance, Claims) returns the merged graph + the under relation', async () => {
    const out = await mcpHost.callTool('get_ontology', { industry: 'insurance', department: 'Claims' }, ctx());
    expect(out.isError).toBe(false);
    const r = out.result as CompiledOntology;
    const names = r.entities.map((e) => e.name);
    expect(names).toContain('Claim');
    expect(names).toContain('Policy');
    // The industry_dept Claims cell adds 'reserve' to Claim (proves the layers merged).
    const claim = r.entities.find((e) => e.name === 'Claim')!;
    expect(claim.attributes.map((a) => a.name)).toContain('reserve');
    const under = r.relations.find((x) => x.from === 'Claim' && x.to === 'Policy' && x.predicate === 'under');
    expect(under?.cardinality).toBe('many-to-one');
  });

  test('no args resolves the cell from tenant.industry × challenge.work_area', async () => {
    const out = await mcpHost.callTool('get_ontology', {}, ctx({ tenantId: TENANT_INS, challengeId: CHALLENGE_ID }));
    expect(out.isError).toBe(false);
    const r = out.result as CompiledOntology;
    expect(r.industry).toBe('insurance');
    expect(r.department).toBe('Claims');
    expect(r.entities.some((e) => e.name === 'Claim')).toBe(true);
  });

  test('a null-industry tenant returns the explicit-args hint, not a crash', async () => {
    const out = await mcpHost.callTool('get_ontology', {}, ctx({ tenantId: TENANT_NONE, challengeId: CHALLENGE_ID }));
    expect(out.isError).toBe(false);
    expect((out.result as { error?: string }).error).toBe('no_industry');
  });
});

describe('map_dataset', () => {
  test('no saved mapping → heuristic proposal clm_amt → Claim.amount', async () => {
    const out = await mcpHost.callTool('map_dataset', { slug: SLUG, industry: 'insurance', department: 'Claims' }, ctx());
    expect(out.isError).toBe(false);
    const r = out.result as { source: string; suggestions: { entityName: string; columnMap: Record<string, string> }[] };
    expect(r.source).toBe('proposed');
    const claim = r.suggestions.find((s) => s.entityName === 'Claim')!;
    expect(claim.columnMap.clm_amt).toBe('amount');
    const policy = r.suggestions.find((s) => s.entityName === 'Policy')!;
    expect(policy.columnMap.pol_no).toBe('policy_no');
  });

  test('useLlm:true places an otherwise-unmatched column via the metered broker', async () => {
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
    const out = await withTenantDb(OWNER_ID, () =>
      mcpHost.callTool(
        'map_dataset',
        { slug: SLUG, industry: 'insurance', department: 'Claims', useLlm: true },
        ctx(),
      ),
    );
    if (out.isError) throw new Error(`map_dataset failed: ${JSON.stringify(out.result)}`);
    const r = out.result as { suggestions: { entityName: string; columnMap: Record<string, string> }[] };
    const claim = r.suggestions.find((s) => s.entityName === 'Claim')!;
    expect(claim.columnMap.zzz_unknown).toBe('reserve');
  });

  test('returns the human-confirmed mapping once one is persisted', async () => {
    // Grab the Claim entity id from the compiled cell, then persist a confirmed mapping.
    const onto = (await mcpHost.callTool('get_ontology', { industry: 'insurance', department: 'Claims' }, ctx()))
      .result as CompiledOntology;
    const claimId = onto.entities.find((e) => e.name === 'Claim')!.id;
    await upsertMapping({
      datasetId,
      entityId: claimId,
      industry: 'insurance',
      department: 'Claims',
      columnMap: { clm_amt: 'amount', clm_status: 'status' },
      confidence: 0.95,
      source: 'human',
      confirmed: true,
      // tenantId: null = the GLOBAL scope this fixture has always written in (mapping writes became
      // tenant-scoped; readers still resolve "mine OR global", so behaviour here is unchanged).
      tenantId: null,
    });
    const out = await mcpHost.callTool('map_dataset', { slug: SLUG, industry: 'insurance', department: 'Claims' }, ctx());
    const r = out.result as { source: string; mappings: { entityName: string; columnMap: Record<string, string> }[] };
    expect(r.source).toBe('confirmed');
    const claim = r.mappings.find((m) => m.entityName === 'Claim')!;
    expect(claim.columnMap.clm_amt).toBe('amount');
    // Clean up so the proposal-path tests above stay independent of run order.
    await db.delete(datasetMappings).where(eq(datasetMappings.dataset_id, datasetId));
  });
});

describe('explain_relations', () => {
  test('returns the under edge between Claim and Policy with cardinality', async () => {
    const out = await mcpHost.callTool(
      'explain_relations',
      { entities: ['Claim', 'Policy'], industry: 'insurance', department: 'Claims' },
      ctx(),
    );
    expect(out.isError).toBe(false);
    const r = out.result as { relations: { from: string; to: string; predicate: string; cardinality: string }[] };
    const under = r.relations.find((x) => x.from === 'Claim' && x.to === 'Policy' && x.predicate === 'under');
    expect(under).toBeDefined();
    expect(under!.cardinality).toBe('many-to-one');
  });
});

describe('ontology:// resource', () => {
  test('readResource returns the compiled cell JSON', async () => {
    const contents = await mcpHost.readResource('ontology://insurance/Claims', ctx());
    expect(contents.mimeType).toBe('application/json');
    const parsed = JSON.parse(contents.text) as CompiledOntology;
    expect(parsed.industry).toBe('insurance');
    expect(parsed.entities.some((e) => e.name === 'Claim')).toBe(true);
  });

  test('listResources includes the cell URIs', async () => {
    const list = await mcpHost.listResources(ctx());
    expect(list.some((r) => r.uri === 'ontology://insurance/Claims')).toBe(true);
  });
});

describe('seedAi drift-update', () => {
  test('updates a stale global prompt (bump + history) and leaves tenant overrides untouched', async () => {
    await seedAi(); // ensure the global agent.system rows exist + are canonical.
    const [globalRow] = await db
      .select({ id: mcpPrompts.id, template: mcpPrompts.template, current_version: mcpPrompts.current_version })
      .from(mcpPrompts)
      .where(sql`${mcpPrompts.name} = 'agent.system' AND ${mcpPrompts.locale} = 'en' AND ${mcpPrompts.tenant_id} IS NULL`);
    expect(globalRow).toBeDefined();
    const canonical = globalRow!.template;
    const v0 = globalRow!.current_version;

    // Make the global row stale, and add a tenant-overridden row that must NOT be touched.
    await db.update(mcpPrompts).set({ template: 'STALE PROMPT' }).where(eq(mcpPrompts.id, globalRow!.id));
    await db.insert(mcpPrompts).values({
      name: 'agent.system',
      locale: 'en',
      tenant_id: DRIFT_TENANT,
      template: 'TENANT CUSTOM PROMPT',
      arguments: [],
      current_version: 1,
    });

    await seedAi();

    const [after] = await db
      .select({ id: mcpPrompts.id, template: mcpPrompts.template, current_version: mcpPrompts.current_version })
      .from(mcpPrompts)
      .where(sql`${mcpPrompts.name} = 'agent.system' AND ${mcpPrompts.locale} = 'en' AND ${mcpPrompts.tenant_id} IS NULL`);
    expect(after!.template).toBe(canonical); // restored from the constant
    expect(after!.current_version).toBe(v0 + 1); // bumped

    const versionRow = await db
      .select({ id: mcpPromptVersions.id })
      .from(mcpPromptVersions)
      .where(sql`${mcpPromptVersions.prompt_id} = ${globalRow!.id} AND ${mcpPromptVersions.version_number} = ${v0 + 1}`);
    expect(versionRow.length).toBe(1); // history recorded

    const [tenantRow] = await db
      .select({ template: mcpPrompts.template })
      .from(mcpPrompts)
      .where(sql`${mcpPrompts.name} = 'agent.system' AND ${mcpPrompts.tenant_id} = ${DRIFT_TENANT}`);
    expect(tenantRow!.template).toBe('TENANT CUSTOM PROMPT'); // untouched
  }, 30_000);
});
