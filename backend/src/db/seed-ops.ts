// src/db/seed-ops.ts — Session 4 Ops fidelity seed (demo.html it-dash + sandboxes).
// Provisions the demo's ~9 employees, one persistent sandbox each at the demo
// statuses, today's usage_counters, and a spread of completed flow_runs (with
// valid traces) over the last 7 days so the dashboard's stat cards, 24h sparkline,
// P95 latency, and most-used-blocks panels render from REAL aggregates.
//
// HONEST: this is seeded fidelity data — the logged-in user's own sandbox + runs
// are genuinely live and aggregate alongside it. We do not fabricate the demo's
// headline "312"; the stat cards show the real SUM over seed + live rows.
//
// Idempotent: users by email and sandboxes by deterministic slug. Demo flow runs carry explicit
// seed keys, so refresh deletes only fixture rows and preserves real executions/operator state.
import { and, eq, sql } from 'drizzle-orm';
import { db, users, sandboxes, flows, flowRuns } from './client';
import { config, DEMO_TENANT_ID } from '../config';
import { emptyGraph } from './flow-types';
import type { CostDelta, TraceEvent } from './trace-types';
import type { Sandbox } from './schema';
import { log } from '../host/logger';

interface DemoUser {
  key: string;
  name: string;
  email: string;
  initials: string;
}

const DEMO_USERS: DemoUser[] = [
  { key: 'lisa', name: 'Lisa Vermeer', email: 'lisa.vermeer@commonpractice.local', initials: 'LV' },
  { key: 'moa', name: 'Mo Ahmed', email: 'mo.ahmed@commonpractice.local', initials: 'MA' },
  { key: 'hannah', name: 'Hannah van Loon', email: 'hannah.vanloon@commonpractice.local', initials: 'HL' },
  { key: 'demoOwner', name: 'Demo Owner', email: 'demo-owner@commonpractice.local', initials: 'DO' },
  { key: 'peter', name: 'Peter Janssen', email: 'peter.janssen@commonpractice.local', initials: 'PJ' },
  { key: 'fatima', name: 'Fatima Hassani', email: 'fatima.hassani@commonpractice.local', initials: 'FH' },
  { key: 'bart', name: 'Bart Vermeer', email: 'bart.vermeer@commonpractice.local', initials: 'BV' },
  { key: 'jeremy', name: 'Jeremy de Wit', email: 'jeremy.dewit@commonpractice.local', initials: 'JW' },
  { key: 'karim', name: 'Karim Ouali', email: 'karim.ouali@commonpractice.local', initials: 'KO' },
];

type DemoStatus = Sandbox['status'];

interface DemoSandbox {
  user: string;
  slug: string;
  project: string;
  status: DemoStatus;
  startedMinAgo: number;
  callsToday: number;
  spendToday: number;
}

// Mirrors the demo.html sandboxes table rows (statuses, projects, calls, € today).
const DEMO_SANDBOXES: DemoSandbox[] = [
  { user: 'lisa', slug: 'lisa-vermeer-7c4d', project: 'Auto-summarize claims v0.4', status: 'running', startedMinAgo: 134, callsToday: 147, spendToday: 0.34 },
  { user: 'moa', slug: 'mo-ahmed-3a91', project: 'PDF OCR experiments', status: 'running', startedMinAgo: 34, callsToday: 208, spendToday: 0.51 },
  { user: 'hannah', slug: 'hannah-van-loon-b2e8', project: 'Inline review UI', status: 'idle', startedMinAgo: 1680, callsToday: 62, spendToday: 0.14 },
  { user: 'demoOwner', slug: 'demo-owner-9d12', project: 'Exploring solutions', status: 'idle', startedMinAgo: 240, callsToday: 3, spendToday: 0.01 },
  { user: 'peter', slug: 'peter-janssen-5f37', project: 'Fraud signals', status: 'running', startedMinAgo: 56, callsToday: 94, spendToday: 0.22 },
  { user: 'fatima', slug: 'fatima-hassani-1c80', project: 'Email auto-categorize', status: 'error', startedMinAgo: 12, callsToday: 0, spendToday: 0 },
  { user: 'bart', slug: 'bart-vermeer-44ab', project: 'Contract compliance', status: 'suspended', startedMinAgo: 4320, callsToday: 0, spendToday: 0 },
  { user: 'jeremy', slug: 'jeremy-de-wit-7e63', project: 'Policy compare', status: 'running', startedMinAgo: 480, callsToday: 28, spendToday: 0.07 },
  { user: 'karim', slug: 'karim-ouali-2f55', project: 'Power Automate flow', status: 'idle', startedMinAgo: 115, callsToday: 0, spendToday: 0 },
];

// Slug popularity → a weighted pool so most-used-blocks ranks ~ like the demo
// (read-claim-form > ai-summarize > extract-fields > …). Counts stay honest/small.
const POPULARITY: [string, number][] = [
  ['read-claim-form', 10],
  ['ai-summarize', 8],
  ['extract-fields', 7],
  ['lookup-policy', 5],
  ['flag-anomalies', 4],
  ['format-output', 3],
  ['classify', 2],
  ['ocr-scan', 1],
];
const POOL: string[] = POPULARITY.flatMap(([slug, w]) => Array.from({ length: w }, () => slug));
const LLM_SLUGS = new Set(['ai-summarize', 'extract-fields', 'classify', 'flag-anomalies', 'ocr-scan', 'compare-docs']);

const minsAgo = (now: Date, mins: number) => new Date(now.getTime() - mins * 60_000);

async function ensureDemoUsers(): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>();
  for (const u of DEMO_USERS) {
    const [existing] = await db.select().from(users).where(eq(users.email, u.email));
    if (existing) {
      out.set(u.key, { id: existing.id, name: existing.name });
      continue;
    }
    const [created] = await db
      .insert(users)
      .values({ email: u.email, name: u.name, avatar_initials: u.initials, role: 'employee' })
      .returning();
    out.set(u.key, { id: created!.id, name: created!.name });
  }
  return out;
}

async function ensureDemoSandboxes(
  now: Date,
  userIds: Map<string, { id: string; name: string }>,
): Promise<Map<string, Sandbox>> {
  const out = new Map<string, Sandbox>();
  for (const s of DEMO_SANDBOXES) {
    const owner = userIds.get(s.user)!;
    const values = {
      owner_id: owner.id,
      tenant_id: DEMO_TENANT_ID,
      slug: s.slug,
      label: `${owner.name}'s sandbox`,
      project: s.project,
      status: s.status,
      suspension_reason: s.status === 'suspended' ? 'admin' : null,
      is_primary: true,
      seed_key: `ops:sandbox:${s.user}`,
      last_active_at: minsAgo(now, s.startedMinAgo),
      updated_at: now,
    };
    const [row] = await db
      .insert(sandboxes)
      .values(values)
      .onConflictDoUpdate({
        target: sandboxes.slug,
        set: {
          project: values.project,
          seed_key: values.seed_key,
        },
      })
      .returning();
    out.set(s.user, row!);
  }
  return out;
}

async function seedUsageToday(userIds: Map<string, { id: string; name: string }>): Promise<void> {
  // ⛔ This is the single most destructive statement in the seed corpus, and it must not run in
  // production. Unlike every other seed write it is not additive and not idempotent-by-skip: the
  // `DO UPDATE SET llm_calls = …, spend_usd = …` below OVERWRITES whatever the broker metered,
  // every boot, for `current_date`. That is how prod came to read an identical 1049 calls / $2.50
  // on six consecutive days with eight demo users parked above the daily cap of 50 that 0058/0059
  // exist to enforce. See config.seedFabricatedTelemetry.
  if (!config.seedFabricatedTelemetry) {
    log.info('seed_ops_usage_counters_skipped', { component: 'seed', reason: 'production' });
    return;
  }
  for (const s of DEMO_SANDBOXES) {
    const owner = userIds.get(s.user)!;
    // The conflict target MUST name the tenant-aligned key. `DO UPDATE` cannot be untargeted the
    // way the broker's `DO NOTHING` is, so this site was moved in the SAME release that created
    // `usage_counters_tenant_user_day_uq` (0058); 0059 has now dropped the pre-tenancy
    // `(user_id, day)`, so naming that old target here would 42P10 and break `bun run seed`.
    // `tenant_id` is passed EXPLICITLY because this runs with no tenant GUC, so the column
    // DEFAULT `app_current_tenant_uuid()` would resolve NULL and violate NOT NULL.
    // The 0058→0059 transient is gone: a demo user with a today-row under a different tenant no
    // longer trips a narrow 23505, because that constraint no longer exists — the two rows now
    // legitimately coexist and this upsert touches only the demo tenant's.
    await db.execute(
      sql`INSERT INTO usage_counters (user_id, tenant_id, day, llm_calls, spend_usd)
          VALUES (${owner.id}, ${DEMO_TENANT_ID}, current_date, ${s.callsToday}, ${s.spendToday})
          ON CONFLICT (tenant_id, user_id, day)
          DO UPDATE SET llm_calls = ${s.callsToday}, spend_usd = ${s.spendToday}`,
    );
  }
}

/** One demo flow per user (FK target for the seeded runs), matched by owner+name. */
async function ensureDemoFlows(
  userIds: Map<string, { id: string; name: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const s of DEMO_SANDBOXES) {
    const owner = userIds.get(s.user)!;
    const name = `[demo] ${s.project}`;
    const [existing] = await db
      .select({ id: flows.id })
      .from(flows)
      .where(and(eq(flows.owner_id, owner.id), eq(flows.name, name)));
    if (existing) {
      out.set(s.user, existing.id);
      continue;
    }
    const [created] = await db
      .insert(flows)
      .values({ name, owner_id: owner.id, tenant_id: DEMO_TENANT_ID, graph: emptyGraph(), last_saved_at: new Date() })
      .returning({ id: flows.id });
    out.set(s.user, created!.id);
  }
  return out;
}

function buildTrace(
  runId: string,
  slugs: string[],
  finishedAt: Date,
  totalMs: number,
  status: 'ok' | 'partial' | 'failed',
  totals: CostDelta,
): TraceEvent[] {
  const startTs = finishedAt.getTime() - totalMs;
  const per = Math.max(1, Math.round(totalMs / slugs.length));
  const events: TraceEvent[] = [
    { type: 'run_start', runId, ts: startTs, nodeCount: slugs.length },
  ];
  slugs.forEach((slug, i) => {
    const nodeId = `n${i + 1}`;
    const ts = startTs + per * i;
    events.push({ type: 'node_start', runId, ts, nodeId, slug });
    const llm = LLM_SLUGS.has(slug);
    events.push({
      type: 'node_success',
      runId,
      ts: ts + per,
      nodeId,
      slug,
      durationMs: per,
      cost: llm
        ? { usd: 0.0005, tokensIn: 45, tokensOut: 24, llmCalls: 1 }
        : { usd: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0 },
      outputPreview: '',
    });
  });
  events.push({ type: 'run_complete', runId, ts: finishedAt.getTime(), totalMs, status, totals });
  return events;
}

/** Delete + reinsert demo runs (scoped to demo flow ids) so re-seeding is clean. */
async function seedDemoRuns(
  now: Date,
  userIds: Map<string, { id: string; name: string }>,
  sandboxesByUser: Map<string, Sandbox>,
  flowsByUser: Map<string, string>,
): Promise<number> {
  // Fabricated run history carries invented `total_cost_usd`/`llm_calls` and feeds the same
  // dashboards the meter does, so it is gated with the counters. The DELETE is scoped by
  // `seed_key` and would not touch real runs — but re-inserting 56 invented ones would.
  if (!config.seedFabricatedTelemetry) {
    log.info('seed_ops_flow_runs_skipped', { component: 'seed', reason: 'production' });
    return 0;
  }
  await db.delete(flowRuns).where(sql`${flowRuns.seed_key} LIKE 'ops:run:%'`);

  const userKeys = DEMO_SANDBOXES.map((s) => s.user);
  const rows: (typeof flowRuns.$inferInsert)[] = [];
  const TOTAL = 56; // ~40 within 24h (sparkline) + the rest spread across 7d (top-blocks)
  for (let i = 0; i < TOTAL; i++) {
    const userKey = userKeys[i % userKeys.length]!;
    const owner = userIds.get(userKey)!;
    const sandbox = sandboxesByUser.get(userKey)!;
    const flowId = flowsByUser.get(userKey)!;

    // First 40 spread across the last ~24h; remainder across days 1–6.
    const finishedAt =
      i < 40 ? minsAgo(now, 8 + i * 35) : minsAgo(now, 24 * 60 + (i - 40) * (7 * 60));
    const nSlugs = 1 + (i % 3); // 1..3 nodes
    const slugs = Array.from({ length: nSlugs }, (_, k) => POOL[(i * 7 + k * 13) % POOL.length]!);
    const totalMs = 200 + ((i * 149) % 2500);
    // The error sandbox occasionally fails; everything else succeeds/partial.
    const status: 'ok' | 'partial' | 'failed' =
      userKey === 'fatima' && i % 9 === 0 ? 'failed' : i % 11 === 0 ? 'partial' : 'ok';

    const llmCount = slugs.filter((s) => LLM_SLUGS.has(s)).length;
    const totals: CostDelta = {
      usd: Number((llmCount * 0.0005).toFixed(6)),
      tokensIn: llmCount * 45,
      tokensOut: llmCount * 24,
      llmCalls: llmCount,
    };

    const id = Bun.randomUUIDv7();
    rows.push({
      id,
      seed_key: `ops:run:${i}`,
      flow_id: flowId,
      tenant_id: DEMO_TENANT_ID,
      triggered_by: owner.id,
      sandbox_id: sandbox.id,
      status: status === 'failed' ? 'failed' : status === 'partial' ? 'partial' : 'ok',
      trace: buildTrace(id, slugs, finishedAt, totalMs, status, totals),
      total_ms: totalMs,
      total_cost_usd: totals.usd.toFixed(6),
      tokens_in: totals.tokensIn,
      tokens_out: totals.tokensOut,
      llm_calls: totals.llmCalls,
      started_at: new Date(finishedAt.getTime() - totalMs),
      finished_at: finishedAt,
    });
  }

  // Batch insert in chunks to keep the statement size sane.
  for (let i = 0; i < rows.length; i += 20) {
    await db.insert(flowRuns).values(rows.slice(i, i + 20));
  }
  return rows.length;
}

export async function seedOps(): Promise<{ users: number; sandboxes: number; runs: number }> {
  const now = new Date();
  const userIds = await ensureDemoUsers();
  const sandboxesByUser = await ensureDemoSandboxes(now, userIds);
  await seedUsageToday(userIds);
  const flowsByUser = await ensureDemoFlows(userIds);
  const runs = await seedDemoRuns(now, userIds, sandboxesByUser, flowsByUser);
  return { users: userIds.size, sandboxes: sandboxesByUser.size, runs };
}
