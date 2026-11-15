// tests/mcp-block-authoring.test.ts — the MCP block-authoring tools (ai/mcp/tools.ts) delegate to the
// shared authoring-service and are gated by the caller's realm roles. Like the other block tests these
// run against the owner connection (RLS bypassed in dev/test — provable isolation lives in
// rls-isolation.test.ts); here we assert the application-layer authoring + authorization logic.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { mcpHost } from '../src/ai/mcp-server';
import type { McpAuthContext } from '../src/ai/mcp-server';
import { seed } from '../src/db/seed';
import { db, buildingBlocks, blockVersions, tenants, users } from '../src/db/client';

const TENANT_A = '0000000c-b000-0000-0000-00000000a001';
const TENANT_B = '0000000c-b000-0000-0000-00000000b001';
const DEV_A = '0000000c-b000-0000-0000-00000000dda1';
const DEV_B = '0000000c-b000-0000-0000-00000000ddb1';
const MEMBER = '0000000c-b000-0000-0000-00000000ce01';
const SLUG = 'mcp-auth-blk';
const PROPOSE_SLUG = 'mcp-propose-blk';

// A minimal lint-clean block module (the create-route default stub).
const GOOD_SRC =
  'export default {\n  descriptor: { inputs: {}, outputs: {}, capabilities: { network: false } },\n' +
  '  async run(inputs, ctx) {\n    return {};\n  }\n};\n';
// A source that the static scan rejects (banned global `fetch`).
const BAD_SRC =
  'export default {\n  descriptor: { inputs: {}, outputs: {}, capabilities: { network: false } },\n' +
  '  async run(inputs, ctx) {\n    await fetch("https://x.invalid");\n    return {};\n  }\n};\n';

function ctx(over: Partial<McpAuthContext> = {}): McpAuthContext {
  return { userId: DEV_A, tenantId: TENANT_A, roles: ['developer'], flowId: null, challengeId: null, ...over };
}

const PATCH_SLUG = 'mcp-patch-blk';

async function cleanupBlocks() {
  for (const slug of [SLUG, PROPOSE_SLUG, PATCH_SLUG]) {
    const rows = await db.select({ id: buildingBlocks.id }).from(buildingBlocks).where(eq(buildingBlocks.slug, slug));
    for (const r of rows) {
      // Break the building_blocks → current_version_id FK before deleting the versions it points at.
      await db.update(buildingBlocks).set({ current_version_id: null }).where(eq(buildingBlocks.id, r.id));
      await db.delete(blockVersions).where(eq(blockVersions.block_id, r.id));
    }
    await db.delete(buildingBlocks).where(eq(buildingBlocks.slug, slug));
  }
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeAll(async () => {
  await seed();
  await cleanupBlocks();
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
  await db.insert(tenants).values([
    { id: TENANT_A, name: 'MCB Tenant A', slug: 'mcb-tenant-a' },
    { id: TENANT_B, name: 'MCB Tenant B', slug: 'mcb-tenant-b' },
  ]);
  await db
    .insert(users)
    .values([
      { id: DEV_A, email: 'mcb-dev-a@test', name: 'Dev A', tenant_id: TENANT_A },
      { id: DEV_B, email: 'mcb-dev-b@test', name: 'Dev B', tenant_id: TENANT_B },
      { id: MEMBER, email: 'mcb-member@test', name: 'Member', tenant_id: TENANT_A },
    ])
    .onConflictDoNothing();
}, 30_000);

afterAll(async () => {
  await cleanupBlocks();
  await db.delete(users).where(inArray(users.id, [DEV_A, DEV_B, MEMBER]));
  await db.delete(tenants).where(inArray(tenants.id, [TENANT_A, TENANT_B]));
}, 30_000);

test('lint_block flags a banned global and passes a clean source', async () => {
  const bad = await mcpHost.callTool('lint_block', { source_ts: BAD_SRC }, ctx());
  expect(bad.isError).toBe(false);
  expect((bad.result as { ok: boolean }).ok).toBe(false);

  const good = await mcpHost.callTool('lint_block', { source_ts: GOOD_SRC }, ctx());
  expect((good.result as { ok: boolean }).ok).toBe(true);
}, 30_000);

test('create_block → save_block_version → publish_block round-trips to a beta tenant block', async () => {
  const created = await mcpHost.callTool(
    'create_block',
    { slug: SLUG, name: 'MCP Auth Block', category: 'logic', source_ts: 'export default {};' },
    ctx(),
  );
  expect(created.isError).toBe(false);
  expect(created.result).toMatchObject({ slug: SLUG, version: '0.1.0', status: 'draft', owner: 'tenant' });

  const saved = await mcpHost.callTool(
    'save_block_version',
    { slug: SLUG, version: '0.1.0', source_ts: GOOD_SRC },
    ctx(),
  );
  expect(saved.isError).toBe(false);

  const published = await mcpHost.callTool('publish_block', { slug: SLUG, version: '0.1.0' }, ctx());
  expect(published.isError).toBe(false);
  expect(published.result).toMatchObject({ slug: SLUG, version: '0.1.0', status: 'beta' });

  // The block is a tenant block stamped to TENANT_A.
  const [row] = await db.select().from(buildingBlocks).where(eq(buildingBlocks.slug, SLUG));
  expect(row!.tenant_id).toBe(TENANT_A);
}, 30_000);

test('a non-developer (member) cannot author via MCP', async () => {
  const out = await mcpHost.callTool(
    'create_block',
    { slug: 'mcp-member-blk', name: 'Nope', category: 'logic' },
    ctx({ userId: MEMBER, roles: ['member'] }),
  );
  expect(out.isError).toBe(true);
  expect(String((out.result as { error: string }).error)).toMatch(/[Dd]eveloper/);
});

test('a developer of another tenant cannot save this tenant block (isolation)', async () => {
  const out = await mcpHost.callTool(
    'save_block_version',
    { slug: SLUG, version: '0.1.0', source_ts: GOOD_SRC },
    ctx({ userId: DEV_B, tenantId: TENANT_B, roles: ['developer'] }),
  );
  expect(out.isError).toBe(true);
  expect(String((out.result as { error: string }).error)).toMatch(/block/i);
});

test('propose_block_draft headless fallback creates the block (developer)', async () => {
  const out = await mcpHost.callTool(
    'propose_block_draft',
    {
      name: 'MCP Propose Block',
      slug: PROPOSE_SLUG,
      category: 'logic',
      description: 'drafted by the copilot',
      source_ts: GOOD_SRC,
      docs_md: '# proposed',
      descriptor: { inputs: {}, outputs: {}, capabilities: { network: false } },
    },
    ctx(),
  );
  expect(out.isError).toBe(false);
  expect(out.result).toMatchObject({ slug: PROPOSE_SLUG, version: '0.1.0', created: true });

  // It persisted a real tenant block via the same authoring service create_block uses.
  const [row] = await db.select().from(buildingBlocks).where(eq(buildingBlocks.slug, PROPOSE_SLUG));
  expect(row!.tenant_id).toBe(TENANT_A);
});

test('propose_block_draft is developer-gated (member denied)', async () => {
  const out = await mcpHost.callTool(
    'propose_block_draft',
    { name: 'Nope', category: 'logic', source_ts: GOOD_SRC, descriptor: {} },
    ctx({ userId: MEMBER, roles: ['member'] }),
  );
  expect(out.isError).toBe(true);
  expect(String((out.result as { error: string }).error)).toMatch(/[Dd]eveloper/);
});

test('simulate_block runs a published block and returns an ok outcome; developer-gated', async () => {
  // SLUG was created + published beta with GOOD_SRC (returns {}) by the round-trip test above.
  const out = await mcpHost.callTool('simulate_block', { slug: SLUG, version: '0.1.0' }, ctx());
  expect(out.isError).toBe(false);
  expect(out.result).toMatchObject({ status: 'ok' });

  const denied = await mcpHost.callTool(
    'simulate_block',
    { slug: SLUG, version: '0.1.0' },
    ctx({ userId: MEMBER, roles: ['member'] }),
  );
  expect(denied.isError).toBe(true);
  expect(String((denied.result as { error: string }).error)).toMatch(/[Dd]eveloper/);
});

test('run_block_test runs the suite (no tests → empty summary) and is write-gated by tenant', async () => {
  const out = await mcpHost.callTool('run_block_test', { slug: SLUG, version: '0.1.0' }, ctx());
  expect(out.isError).toBe(false);
  expect(out.result).toMatchObject({ total: 0, testsPassing: false });

  const denied = await mcpHost.callTool(
    'run_block_test',
    { slug: SLUG, version: '0.1.0' },
    ctx({ userId: DEV_B, tenantId: TENANT_B, roles: ['developer'] }),
  );
  expect(denied.isError).toBe(true);
});

test('propose_block_patch headless fallback saves the draft when slug+version are given', async () => {
  await mcpHost.callTool(
    'create_block',
    { slug: PATCH_SLUG, name: 'Patch Blk', category: 'logic', source_ts: 'export default {};' },
    ctx(),
  );
  const patched = await mcpHost.callTool(
    'propose_block_patch',
    { slug: PATCH_SLUG, version: '0.1.0', source_ts: GOOD_SRC, summary: 'fix', rationale: 'why' },
    ctx(),
  );
  expect(patched.isError).toBe(false);
  expect(patched.result).toMatchObject({ slug: PATCH_SLUG, version: '0.1.0', applied: true });

  // Without slug+version it no-ops (a browser session applies the diff in the editor instead).
  const noop = await mcpHost.callTool('propose_block_patch', { source_ts: GOOD_SRC }, ctx());
  expect(noop.isError).toBe(false);
  expect(noop.result).toMatchObject({ applied: false });
});

test('propose_block_patch is developer-gated (member denied)', async () => {
  const out = await mcpHost.callTool(
    'propose_block_patch',
    { source_ts: GOOD_SRC },
    ctx({ userId: MEMBER, roles: ['member'] }),
  );
  expect(out.isError).toBe(true);
  expect(String((out.result as { error: string }).error)).toMatch(/[Dd]eveloper/);
});

test('create_data_block_from_entity is developer-gated and fails cleanly on a bogus entity', async () => {
  const denied = await mcpHost.callTool(
    'create_data_block_from_entity',
    { entityId: '00000000-0000-0000-0000-0000000000ff' },
    ctx({ userId: MEMBER, roles: ['member'] }),
  );
  expect(denied.isError).toBe(true);
  expect(String((denied.result as { error: string }).error)).toMatch(/[Dd]eveloper/);

  const missing = await mcpHost.callTool(
    'create_data_block_from_entity',
    { entityId: '00000000-0000-0000-0000-0000000000ff' },
    ctx(),
  );
  expect(missing.isError).toBe(true); // entity not found → clean error, not a crash
});

// ---- Phase 5A/5D: template grounding + save-as-template tools ----

test('list_templates / get_template surface the seeded catalogue to the agent (read-only, open to any role)', async () => {
  // Read/context tools are NOT developer-gated (unlike the authoring writes) — a member can ground on them.
  const listed = await mcpHost.callTool('list_templates', { category: 'logic' }, ctx({ userId: MEMBER, roles: ['member'] }));
  expect(listed.isError).toBe(false);
  const res = listed.result as { templates: { id: string; category: string }[] };
  expect(res.templates.length).toBeGreaterThan(0);
  expect(res.templates.every((t) => t.category === 'logic')).toBe(true);

  const one = await mcpHost.callTool('get_template', { id: res.templates[0]!.id }, ctx({ userId: MEMBER, roles: ['member'] }));
  expect(one.isError).toBe(false);
  expect(one.result).toMatchObject({ id: res.templates[0]!.id });
  expect(typeof (one.result as { source_ts: string }).source_ts).toBe('string');

  const missing = await mcpHost.callTool('get_template', { id: '00000000-0000-0000-0000-0000000000ff' }, ctx());
  expect(missing.isError).toBe(true);
});

test('create_template saves a developer-gated tenant template, scoped to the caller tenant', async () => {
  const descriptor = { inputs: {}, outputs: {}, capabilities: { network: false } };

  const made = await mcpHost.callTool(
    'create_template',
    { name: 'mcp-tpl-a', label: 'MCP Tpl A', category: 'logic', descriptor, source_ts: GOOD_SRC, docs_md: 'docs' },
    ctx(),
  );
  expect(made.isError).toBe(false);
  const id = (made.result as { id: string }).id;
  expect(id).toBeTruthy();

  // Visible to its own tenant…
  const listA = await mcpHost.callTool('list_templates', {}, ctx());
  expect((listA.result as { templates: { id: string }[] }).templates.some((t) => t.id === id)).toBe(true);
  // …but NOT to another tenant (service-level scope; DB RLS is the prod backstop — rls-isolation.test.ts).
  const listB = await mcpHost.callTool('list_templates', {}, ctx({ userId: DEV_B, tenantId: TENANT_B, roles: ['developer'] }));
  expect((listB.result as { templates: { id: string }[] }).templates.some((t) => t.id === id)).toBe(false);

  // Duplicate (category, domain, name) for the same tenant → conflict.
  const dup = await mcpHost.callTool(
    'create_template',
    { name: 'mcp-tpl-a', label: 'MCP Tpl A again', category: 'logic', descriptor },
    ctx(),
  );
  expect(dup.isError).toBe(true);

  // A non-developer cannot create a template.
  const denied = await mcpHost.callTool(
    'create_template',
    { name: 'mcp-tpl-x', label: 'X', category: 'logic', descriptor },
    ctx({ userId: MEMBER, roles: ['member'] }),
  );
  expect(denied.isError).toBe(true);
  expect(String((denied.result as { error: string }).error)).toMatch(/[Dd]eveloper/);
});

test('delete_template removes an own-tenant template (developer-gated, own-tenant only)', async () => {
  const descriptor = { inputs: {}, outputs: {}, capabilities: { network: false } };
  const made = await mcpHost.callTool(
    'create_template',
    { name: 'mcp-tpl-del', label: 'MCP Tpl Del', category: 'logic', descriptor },
    ctx(),
  );
  const id = (made.result as { id: string }).id;

  // Non-developer cannot delete.
  const denied = await mcpHost.callTool('delete_template', { id }, ctx({ userId: MEMBER, roles: ['member'] }));
  expect(denied.isError).toBe(true);
  expect(String((denied.result as { error: string }).error)).toMatch(/[Dd]eveloper/);

  // Another tenant's developer → no-match (own-tenant clause).
  const cross = await mcpHost.callTool('delete_template', { id }, ctx({ userId: DEV_B, tenantId: TENANT_B, roles: ['developer'] }));
  expect(cross.isError).toBe(true);

  // Owner deletes → gone from its own list.
  const ok = await mcpHost.callTool('delete_template', { id }, ctx());
  expect(ok.isError).toBe(false);
  expect(ok.result).toMatchObject({ id, deleted: true });
  const listA = await mcpHost.callTool('list_templates', {}, ctx());
  expect((listA.result as { templates: { id: string }[] }).templates.some((t) => t.id === id)).toBe(false);
});
