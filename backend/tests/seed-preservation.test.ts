// Boot showcase seeding is additive: fixture refreshes must never delete real comments/runs/usage
// or overwrite an operator pause and live daily counters on seeded identities.
import { test, expect } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  users,
  challenges,
  comments,
  flows,
  flowRuns,
  sandboxes,
  usageCounters,
  usageEvents,
  runAsSystem,
} from '../src/db/client';
import { seedTenantShowcase } from '../src/db/seed-tenant-showcase';
import { DEMO_TENANT_ID } from '../src/config';

const VIEWER_ID = '00000000-0000-4000-8000-0000005eed99';
const COMMENT_BODY = 'ZSEED genuine member comment — preserve me';

test('reseed preserves a genuine comment, viewer run, usage event, daily counter, and admin pause', async () => {
  await runAsSystem('boot-seed', () => seedTenantShowcase(DEMO_TENANT_ID));
  const [challenge] = await db.select().from(challenges).where(and(
    eq(challenges.tenant_id, DEMO_TENANT_ID),
    eq(challenges.title, 'Auto-summarize claim forms'),
  ));
  const [flow] = await db.select().from(flows).where(eq(flows.name, "[demo] Sara's claim-summary solution"));
  const [seededSandbox] = await db.select().from(sandboxes).where(sql`${sandboxes.seed_key} LIKE ${`showcase:${DEMO_TENANT_ID}:sandbox:%`}`).limit(1);
  expect(challenge).toBeDefined();
  expect(flow).toBeDefined();
  expect(seededSandbox).toBeDefined();

  const originalSandbox = { ...seededSandbox! };
  // ⚠️ TENANT-SCOPED, and it must stay that way. `usage_counters` is keyed
  // (tenant_id, user_id, day) since 0058/0059, and the showcase seeder re-homes these same six
  // `*.fr-demo@` users into whatever tenant it is called with — seed-vote-fabrication-guard.test.ts
  // seeds two more tenants with them concurrently. Without the tenant predicate this `[0]` picks an
  // arbitrary one of several rows for the same user and day, and the 987 assertion below becomes a
  // coin flip.
  const counterKey = and(
    eq(usageCounters.tenant_id, DEMO_TENANT_ID),
    eq(usageCounters.user_id, seededSandbox!.owner_id),
    eq(usageCounters.day, sql`current_date`),
  );
  const [originalCounter] = await db.select().from(usageCounters).where(counterKey);
  await db.insert(users).values({
    id: VIEWER_ID,
    email: 'seed-preservation@test',
    name: 'Seed Preservation Viewer',
    tenant_id: DEMO_TENANT_ID,
  }).onConflictDoNothing({ target: users.id });
  const [viewerSandbox] = await db.insert(sandboxes).values({
    owner_id: VIEWER_ID,
    tenant_id: DEMO_TENANT_ID,
    slug: 'zseed-preservation-viewer',
    status: 'idle',
    is_primary: true,
  }).onConflictDoUpdate({ target: sandboxes.slug, set: { status: 'idle' } }).returning();
  const [comment] = await db.insert(comments).values({
    challenge_id: challenge!.id,
    tenant_id: DEMO_TENANT_ID,
    author_id: VIEWER_ID,
    body: COMMENT_BODY,
  }).returning();
  const [viewerRun] = await db.insert(flowRuns).values({
    flow_id: flow!.id,
    tenant_id: DEMO_TENANT_ID,
    triggered_by: VIEWER_ID,
    sandbox_id: viewerSandbox!.id,
    status: 'ok',
    finished_at: new Date(),
  }).returning();
  const [usage] = await db.insert(usageEvents).values({
    tenant_id: DEMO_TENANT_ID,
    user_id: seededSandbox!.owner_id,
    provider: 'test-provider',
    model: 'genuine-call',
    tokens_in: 3,
    tokens_out: 2,
    cost_usd: '0.000123',
  }).returning();
  await db.update(usageCounters).set({ llm_calls: 987, spend_usd: '9.876000' }).where(counterKey);
  await db.update(sandboxes).set({
    status: 'suspended',
    suspension_reason: 'admin',
    last_active_at: new Date('2026-01-01T00:00:00Z'),
  }).where(eq(sandboxes.id, seededSandbox!.id));

  try {
    await runAsSystem('boot-seed', () => seedTenantShowcase(DEMO_TENANT_ID));
    expect(await db.select().from(comments).where(eq(comments.id, comment!.id))).toHaveLength(1);
    expect(await db.select().from(flowRuns).where(eq(flowRuns.id, viewerRun!.id))).toHaveLength(1);
    expect(await db.select().from(usageEvents).where(eq(usageEvents.id, usage!.id))).toHaveLength(1);
    const [counter] = await db.select().from(usageCounters).where(counterKey);
    const [paused] = await db.select().from(sandboxes).where(eq(sandboxes.id, seededSandbox!.id));
    expect(counter!.llm_calls).toBe(987);
    expect(Number(counter!.spend_usd)).toBe(9.876);
    expect(paused!.status).toBe('suspended');
    expect(paused!.suspension_reason).toBe('admin');
    expect(paused!.last_active_at!.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  } finally {
    await db.delete(comments).where(eq(comments.id, comment!.id));
    await db.delete(flowRuns).where(eq(flowRuns.id, viewerRun!.id));
    await db.delete(sandboxes).where(eq(sandboxes.id, viewerSandbox!.id));
    await db.delete(usageEvents).where(eq(usageEvents.id, usage!.id));
    if (originalCounter) {
      await db.update(usageCounters).set({
        llm_calls: originalCounter.llm_calls,
        spend_usd: originalCounter.spend_usd,
        reserved_spend_usd: originalCounter.reserved_spend_usd,
      }).where(counterKey);
    }
    await db.update(sandboxes).set({
      status: originalSandbox.status,
      suspension_reason: originalSandbox.suspension_reason,
      last_active_at: originalSandbox.last_active_at,
      updated_at: originalSandbox.updated_at,
    }).where(eq(sandboxes.id, seededSandbox!.id));
    await db.delete(users).where(eq(users.id, VIEWER_ID));
  }
}, 60_000);
