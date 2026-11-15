// tests/mcp-server.test.ts — the in-process MCP host (Stage C): dynamic tools/list,
// tools/call (backend), resources/read, prompts/get, and an audit_log row per call.
// Against the live :5433 DB; seeds its own block so it's self-contained.
import { test, expect, beforeEach, afterAll } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import {
  db,
  users,
  buildingBlocks,
  blockVersions,
  auditLog,
  mcpPrompts,
  datasets,
  datasetRows,
} from '../src/db/client';
import type { BlockDescriptor } from '../src/db/block-types';
import { McpHost, type McpAuthContext } from '../src/ai/mcp-server';
import { getPlatformTool } from '../src/ai/mcp/tools';
import { __setSnapshotOverrideForTests } from '../src/host/policy-store';
import type { GovernanceSnapshot } from '../src/host/policy-store';

// ⛔ Fixture ids must be UNIQUE PER TEST FILE. Every file runs against one database and each
// DELETEs then re-INSERTs its fixtures — so a shared id means one file rips a row out from under
// another's. (⚠️ CORRECTED 2026-08-16: this used to say "bun runs test files concurrently". It
// does not — `--parallel` is opt-in and implies `--isolate`, CI runs a plain `bun run test`, and
// file durations are additive. The sharing is sequential, and it is just as destructive: the
// canonical write-up is at the top of tests/metering-platform-calls.test.ts.) That is what the
// intermittent `usage_counters_user_id_fkey` / audit_log failures in the full suite were:
// this file previously shared its user/tenant ids with tests/runs.test.ts.
const USER_ID = '00000000-0000-0000-0000-0000000c1001';
// FIX 1: a distinct MCP-key ISSUER (e.g. a super_admin) whose OWN userId is not a member
// of TENANT_ID — reproduces routes/admin.ts issueMcpKey (issued_by = the super_admin,
// tenant = the path tenant), the live-prod shape (key 'ws2-test-key') that surfaced the bug.
const ISSUER_ID = '00000000-0000-0000-0000-0000000c1002';
const TENANT_ID = '00000000-0000-0000-0000-0000000c10aa';
const DATASET_SLUG = 'zz-mcp-test-dataset';
const SLUG = 'zz-mcp-test-block';
const ctx: McpAuthContext = { userId: USER_ID, tenantId: null, roles: ['employee'] };
const host = new McpHost();

const descriptor: BlockDescriptor = {
  inputs: { text: { type: 'string', required: true } },
  outputs: { summary: { type: 'string' } },
  capabilities: { llm: true },
};

async function cleanup() {
  await db.delete(auditLog).where(eq(auditLog.actor_id, USER_ID));
  await db.delete(auditLog).where(eq(auditLog.actor_id, ISSUER_ID));
  await db.delete(datasets).where(eq(datasets.slug, DATASET_SLUG));
  const blocks = await db
    .select({ id: buildingBlocks.id })
    .from(buildingBlocks)
    .where(eq(buildingBlocks.slug, SLUG));
  if (blocks.length) {
    await db
      .update(buildingBlocks)
      .set({ current_version_id: null })
      .where(eq(buildingBlocks.slug, SLUG));
    await db
      .delete(blockVersions)
      .where(inArray(blockVersions.block_id, blocks.map((b) => b.id)));
    await db.delete(buildingBlocks).where(eq(buildingBlocks.slug, SLUG));
  }
  await db.delete(users).where(eq(users.id, USER_ID));
  await db.delete(users).where(eq(users.id, ISSUER_ID));
}

async function setup() {
  await db
    .insert(users)
    .values({ id: USER_ID, email: 'mcp@test', name: 'Mcp Test' })
    .onConflictDoNothing({ target: users.id });
  await db
    .insert(users)
    .values({ id: ISSUER_ID, email: 'mcp-issuer@test', name: 'Mcp Issuer' })
    .onConflictDoNothing({ target: users.id });
  // A dataset that belongs to TENANT_ID (owned — uploaded — by USER_ID, a real tenant
  // member), used by the FIX 1 test below.
  await db
    .insert(datasets)
    .values({
      owner_id: USER_ID,
      tenant_id: TENANT_ID,
      name: 'ZZ Mcp Test Dataset',
      slug: DATASET_SLUG,
      source_type: 'json',
      columns: [],
      row_count: 3,
    })
    .onConflictDoNothing();
  const [block] = await db
    .insert(buildingBlocks)
    .values({ slug: SLUG, name: 'ZZ Mcp Test Block', description: 'a test summarizer', category: 'ai' })
    .returning();
  const [version] = await db
    .insert(blockVersions)
    .values({
      block_id: block!.id,
      version: '1.0.0',
      status: 'stable',
      descriptor,
      published_at: new Date(),
    })
    .returning();
  await db
    .update(buildingBlocks)
    .set({ current_version_id: version!.id })
    .where(eq(buildingBlocks.id, block!.id));
  // Ensure the agent.system prompt exists (idempotent with the seed).
  await db
    .insert(mcpPrompts)
    .values({ name: 'agent.system', locale: 'en', tenant_id: null, template: 'SYSTEM PROMPT TEXT', arguments: [] })
    .onConflictDoNothing();
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  await cleanup();
  await setup();
}, 30_000);
afterAll(cleanup, 30_000);

test('tools/list merges platform tools + classifies edit tools as frontend', async () => {
  const tools = await host.listTools(ctx);
  const names = tools.map((t) => t.name);
  expect(names).toContain('search_blocks');
  expect(names).toContain('get_block');
  expect(names).toContain('validate_flow');
  expect(names).toContain('add_node');
  expect(tools.find((t) => t.name === 'add_node')?.surface).toBe('frontend');
  expect(tools.find((t) => t.name === 'search_blocks')?.surface).toBe('backend');
});

test('tools/call search_blocks finds the seeded block + writes an audit row', async () => {
  const out = await host.callTool('search_blocks', { query: 'zz-mcp-test' }, ctx);
  expect(out.isError).toBe(false);
  const items = (out.result as { items: { slug: string }[] }).items;
  expect(items.some((b) => b.slug === SLUG)).toBe(true);

  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actor_id, USER_ID), eq(auditLog.action, 'mcp.tool_call')));
  expect(audits.length).toBe(1);
  expect(audits[0]!.target_id).toBe('search_blocks');
});

test('tools/call get_block returns the descriptor', async () => {
  const out = await host.callTool('get_block', { slug: SLUG }, ctx);
  expect(out.isError).toBe(false);
  const block = out.result as { slug: string; descriptor: BlockDescriptor };
  expect(block.slug).toBe(SLUG);
  expect(block.descriptor.outputs.summary).toBeDefined();
});

test('tools/call on an unknown tool is an audited error', async () => {
  const out = await host.callTool('nope_tool', {}, ctx);
  expect(out.isError).toBe(true);
  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actor_id, USER_ID), eq(auditLog.action, 'mcp.tool_call')));
  expect(audits[0]!.result_tone).toBe('error');
});

test('resources/read block:// returns the descriptor + audits the read', async () => {
  const contents = await host.readResource(`block://${SLUG}@1.0.0`, ctx);
  expect(contents.mimeType).toBe('application/json');
  expect(JSON.parse(contents.text).slug).toBe(SLUG);

  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actor_id, USER_ID), eq(auditLog.action, 'mcp.resource_read')));
  expect(audits.length).toBe(1);
});

test('resources/read doc:// returns the getting-started chapter', async () => {
  const contents = await host.readResource('doc://book/getting-started?lang=en', ctx);
  expect(contents.mimeType).toBe('text/markdown');
  expect(contents.text).toContain('Getting started');
});

test('resources/list + resources/read scope data://dataset by ctx.tenantId, not the issuer ctx.userId', async () => {
  // FIX 1: mcp-server.ts previously passed only ctx.userId into listResources/readResource,
  // which then filtered datasets by owner_id. A super_admin-issued MCP key has ctx.userId =
  // the ISSUER but ctx.tenantId = the key's actual tenant — exactly this shape. Before the
  // fix, the issuer's own (empty) dataset list won, and the tenant's real dataset 404'd.
  const issuerCtx: McpAuthContext = { userId: ISSUER_ID, tenantId: TENANT_ID, roles: ['super_admin'] };

  const list = await host.listResources(issuerCtx);
  expect(list.some((r) => r.uri === `data://dataset/${DATASET_SLUG}`)).toBe(true);

  const contents = await host.readResource(`data://dataset/${DATASET_SLUG}`, issuerCtx);
  expect(contents.mimeType).toBe('application/json');
  expect(JSON.parse(contents.text).slug).toBe(DATASET_SLUG);
});

// ---- PII-gaps hunt, FIX 2 — the MCP data path bypasses PII redaction entirely ----
// describe_data (mcp/tools.ts) and the data://dataset resource (mcp/resources.ts) both
// called raw readRows() with no redaction, unlike the run-injection path
// (loadInjectedDatasets), even though both feed straight into the LLM conversation
// (ai/agent.ts) — i.e. to whatever external provider the tenant configured. Governance's
// data.pii_scrubbing switch must cover BOTH data paths, not just the run path.
async function seedPiiRow(): Promise<void> {
  const [d] = await db.select({ id: datasets.id }).from(datasets).where(eq(datasets.slug, DATASET_SLUG));
  await db
    .update(datasets)
    .set({
      columns: [
        { name: 'name', type: 'string' },
        { name: 'ssn', type: 'string', pii: true },
      ],
    })
    .where(eq(datasets.id, d!.id));
  await db
    .insert(datasetRows)
    .values({ dataset_id: d!.id, idx: 0, data: { name: 'Alice', ssn: '123-45-6789' } });
}

// ⛔ SUPERSEDED BY OWNER DECISION W8 (2026-10-14): example data is never sent to the external AI.
// These three cases used to pin "redact the pii column when governance scrubbing is ON, ship it raw
// when OFF". Neither surface carries a row (or a column `sample`) any more, so the assertion is now
// the stronger one: whatever the governance switch says, no value of any column leaves.
for (const scrubbing of [true, false]) {
  test(`describe_data MCP tool returns the schema and NO values (pii scrubbing ${scrubbing ? 'ON' : 'OFF'})`, async () => {
    await seedPiiRow();
    __setSnapshotOverrideForTests({ piiScrubbing: scrubbing } as unknown as GovernanceSnapshot);
    try {
      const tool = getPlatformTool('describe_data')!;
      const out = (await tool.handler(
        { slug: DATASET_SLUG },
        { userId: USER_ID, tenantId: TENANT_ID, roles: [], db },
      )) as Record<string, unknown>;
      expect(out.columns).toEqual([
        { name: 'name', type: 'string', pii: false },
        { name: 'ssn', type: 'string', pii: true },
      ]);
      expect('sample' in out).toBe(false);
      const wire = JSON.stringify(out);
      expect(wire).not.toContain('Alice');
      expect(wire).not.toContain('123-45-6789');
    } finally {
      __setSnapshotOverrideForTests(undefined);
    }
  });
}

test('data://dataset resource returns the schema and NO values', async () => {
  await seedPiiRow();
  __setSnapshotOverrideForTests({ piiScrubbing: false } as unknown as GovernanceSnapshot);
  try {
    const issuerCtx: McpAuthContext = { userId: USER_ID, tenantId: TENANT_ID, roles: ['employee'] };
    const contents = await host.readResource(`data://dataset/${DATASET_SLUG}`, issuerCtx);
    const parsed = JSON.parse(contents.text) as Record<string, unknown>;
    expect(parsed.columns).toEqual([
      { name: 'name', type: 'string', pii: false },
      { name: 'ssn', type: 'string', pii: true },
    ]);
    expect('sample' in parsed).toBe(false);
    expect(contents.text).not.toContain('Alice');
    expect(contents.text).not.toContain('123-45-6789');
  } finally {
    __setSnapshotOverrideForTests(undefined);
  }
});

test('prompts/get + getSystemPromptText resolve the system prompt + audit', async () => {
  const prompt = await host.getPrompt('agent.system', ctx);
  expect(prompt.template.length).toBeGreaterThan(0);
  expect(prompt.messages[0]!.content.text).toBe(prompt.template);

  const sys = await host.getSystemPromptText(ctx);
  expect(sys.length).toBeGreaterThan(0);

  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actor_id, USER_ID), eq(auditLog.action, 'mcp.prompt_get')));
  expect(audits.length).toBe(1);
});
