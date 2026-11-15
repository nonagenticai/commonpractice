// src/db/seed-tenant-showcase.ts — populate ONE tenant with a complete, believable
// showcase dataset so a demo login (e.g. the `fr-test` user) sees a fully-populated app
// on every RLS-scoped screen: marketplace (challenges / solutions / votes / weekly
// winner), the builder (runnable flows), the IT-ops dashboard (sandboxes / recent runs /
// today's usage / 14-day spend), and the data screen (datasets).
//
// WHY THIS EXISTS: RLS scopes every tenant read by the effective tenant (middleware/tenant.ts,
// migration 0028), so a tenant with no stamped rows shows empty screens. Global tables
// (building_blocks, pipeline_items, policies — no tenant_id, not RLS'd) were already
// visible, so they are intentionally NOT seeded here.
//
// Re-runnable + idempotent: members by email, challenges by (tenant,title), solutions by
// (challenge,title), votes by their unique key, the winner by week, flows by (owner,name),
// sandboxes by slug. Time-relative fixture runs/events carry explicit seed keys and only those
// rows are refreshed; existing counters, member activity, and operator state are preserved.
//
// Run (owner connection, bypasses RLS):
//   MIGRATE_DATABASE_URL=<owner-url> DATABASE_URL=<owner-url> \
//     bun run src/db/seed-tenant-showcase.ts [tenantId]
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  closeConnection,
  runAsSystem,
  users,
  tenants,
  buildingBlocks,
  blockVersions,
  flows,
  flowRuns,
  sandboxes,
  usageCounters,
  usageEvents,
  challenges,
  solutions,
  votes,
  comments,
  weeklyWinners,
  datasets,
  tenantLlmSettings,
} from './client';
import { config, DEMO_TENANT_ID } from '../config';
import { LISA_NODES, LISA_EDGES, showcaseWeeks } from './seed-marketplace';
import { recountVotes } from '../host/vote-service';
import { periodSolutionStats } from '../host/cycle-eligibility';
import { createDataset } from '../datasets/dataset-service';
import { ensureTenantLicense } from '../services/license-provisioning';
import { parseJsonValue } from '../datasets/parse/json';
import type { FlowGraph, FlowNode } from './flow-types';
import type { CostDelta, TraceEvent } from './trace-types';
import type { ChallengeMetrics } from './schema';
import type { BlockDescriptor } from './block-types';
import { graphContentHash } from '../host/publication-service';
// ⛔ THE SEED IS A SECOND CREATE PATH AND IT HAD NO ENQUEUE. `POST /api/challenges`
// (routes/challenges.ts:543) and `POST /api/solutions` (routes/solutions.ts:661) both queue the
// non-`en` locales right after their INSERT; this file INSERTs the same two entity types directly
// and never did, so every seeded showcase row was born English-only and stayed that way — measured
// in prod as 15 of 17 challenges translated, the 2 misses being exactly the seeded ones. The field
// lists below are copied from those two routes deliberately: a field translated on one path and not
// the other is the same defect one layer down.
import { enqueueTranslations } from '../host/translation-service';
import { log } from '../host/logger';

// Default target = the demo tenant. NOTE: a tenant id, NOT the fr-test user's id/sub below.
const DEFAULT_TENANT_ID = DEMO_TENANT_ID;
const FR_TEST_USER_ID = '32969c16-6ecd-49fe-a106-ba13e6640dc8';

// ---- in-tenant member users (the demo colleagues — distinct emails so they never
// collide with the existing per-tenant demo users) ----
interface Member {
  key: string;
  name: string;
  email: string;
  initials: string;
}
const MEMBERS: Member[] = [
  { key: 'emma', name: 'Emma de Boer', email: 'emma.fr-demo@commonpractice.local', initials: 'EB' },
  { key: 'noah', name: 'Noah Visser', email: 'noah.fr-demo@commonpractice.local', initials: 'NV' },
  { key: 'sara', name: 'Sara El Amrani', email: 'sara.fr-demo@commonpractice.local', initials: 'SE' },
  { key: 'liam', name: 'Liam Bakker', email: 'liam.fr-demo@commonpractice.local', initials: 'LB' },
  { key: 'yuki', name: 'Yuki Tanaka', email: 'yuki.fr-demo@commonpractice.local', initials: 'YT' },
  { key: 'omar', name: 'Omar Haddad', email: 'omar.fr-demo@commonpractice.local', initials: 'OH' },
];

// ---- challenges (the leaderboard + home trending/active). `you` = the fr-test user, so
// "Your activity → submitted" fills. The top one moves to solution_phase + gets solutions. ----
interface ChallengeSeed {
  key: string;
  authorKey: string; // member key or 'you'
  title: string;
  workArea: string;
  code: string;
  status: 'voting' | 'solution_phase' | 'closed';
  votes: number;
  tags: string[];
  description: string;
  businessImpact: string;
  metrics: ChallengeMetrics;
}
const CHALLENGES: ChallengeSeed[] = [
  {
    key: 'claims', authorKey: 'emma', title: 'Auto-summarize claim forms', workArea: 'Claims',
    code: 'CH-284', status: 'solution_phase', votes: 312, tags: ['PDF', 'NL', 'Summarize'],
    description:
      'Every Tuesday I work through a stack of claim PDFs — 40 to 60 forms. Each takes ~4 minutes to read, pull the key fields, and write a 3-line summary for the case file. The forms are non-standard: every intermediary uses its own template.',
    businessImpact: '~3 hrs/week per claims associate × 28 staff in Claims NL. Cuts the case-handling backlog by an estimated 12%.',
    metrics: { timeSavedPerWeek: '~3 hrs', affectedStaff: '28', backlogReduction: '~12%' },
  },
  {
    key: 'renewals', authorKey: 'you', title: 'Draft renewal letters from policy data', workArea: 'Sales',
    code: 'CH-281', status: 'voting', votes: 198, tags: ['Policies', 'Drafting', 'LLM'],
    description:
      'Renewal season means hand-writing hundreds of near-identical letters from each policy record. The wording barely changes but every figure has to be exactly right.',
    businessImpact: 'Every advisor drafts dozens of these a week. A reliable first draft frees them for the genuine edge cases.',
    metrics: { timeSavedPerWeek: '~2 hrs', affectedStaff: '40', backlogReduction: '~9%' },
  },
  {
    key: 'inbox', authorKey: 'noah', title: 'Auto-categorize the shared service inbox', workArea: 'Service',
    code: 'CH-277', status: 'voting', votes: 176, tags: ['Email', 'Routing'],
    description:
      'Our shared service inbox gets hundreds of emails a day and a human triages each one to the right team. Most are obvious from the first line.',
    businessImpact: 'Triage is the equivalent of a full-time role. Auto-routing the obvious ones frees that person for the hard cases.',
    metrics: { timeSavedPerWeek: '~6 hrs', affectedStaff: '15', backlogReduction: '~20%' },
  },
  {
    key: 'contracts', authorKey: 'sara', title: 'Compliance pre-check on contract edits', workArea: 'Legal',
    code: 'CH-269', status: 'voting', votes: 154, tags: ['Contract', 'Compliance'],
    description:
      'When a contract is amended I check each change against our compliance rulebook by hand. The rulebook is 60 pages and the review is the bottleneck before anything ships.',
    businessImpact: 'Catching issues automatically de-risks every amendment and removes the manual gate.',
    metrics: { timeSavedPerWeek: '~4 hrs', affectedStaff: '9', backlogReduction: '~15%' },
  },
  {
    key: 'churn', authorKey: 'liam', title: 'Churn-risk digest per segment', workArea: 'Marketing',
    code: 'CH-258', status: 'voting', votes: 132, tags: ['Marketing', 'Analytics'],
    description:
      'I want to see which customer segments are showing early churn signals without exporting three dashboards into a spreadsheet first.',
    businessImpact: 'Earlier per-segment churn detection lets us target retention spend where it actually moves the needle.',
    metrics: { timeSavedPerWeek: '~3 hrs', affectedStaff: '12', backlogReduction: '~10%' },
  },
  {
    key: 'broker', authorKey: 'you', title: 'Reconcile broker payment files', workArea: 'Finance',
    code: 'CH-243', status: 'voting', votes: 88, tags: ['Finance', 'Reconcile'],
    description:
      'Each broker sends a differently-shaped payment file and I match the lines against our ledger by hand every month-end.',
    businessImpact: 'Automated matching closes the month faster and surfaces mismatches before they become disputes.',
    metrics: { timeSavedPerWeek: '~5 hrs', affectedStaff: '6', backlogReduction: '~18%' },
  },
];

// ---- solutions to the top challenge (the solution leaderboard). One is the winner. ----
interface SolutionSeed {
  authorKey: string;
  title: string;
  votes: number;
  status: 'voting' | 'shipping';
  // ⛔ NO `buildMinutes` / `demoSeconds` — see the identical note in seed-marketplace.ts. Build time
  // has no honest source and left the product; demo time is measured from the solution's own runs
  // (0065 → host/solution-demo.ts), so a seeded constant here would be a fabricated duration on the
  // board, in the same class as a fabricated `votes_count`.
  blocksUsed: string[];
  linkFlow?: boolean;
}
const SOLUTIONS: SolutionSeed[] = [
  { authorKey: 'sara', title: 'Streaming summarizer with OCR fallback', votes: 316, status: 'shipping', blocksUsed: ['read-claim-form', 'lookup-policy', 'flag-anomalies', 'if-else', 'format-output'], linkFlow: true },
  { authorKey: 'noah', title: 'Inline review queue for associates', votes: 271, status: 'voting', blocksUsed: ['read-claim-form', 'ai-summarize', 'review-panel'] },
  { authorKey: 'liam', title: 'Multi-template field extractor', votes: 233, status: 'voting', blocksUsed: ['ocr-scan', 'extract-fields', 'ai-summarize'] },
  { authorKey: 'yuki', title: 'Low-code variant with audit log', votes: 188, status: 'voting', blocksUsed: ['extract-fields', 'format-output'] },
];

const COMMENTS: { authorKey: string; body: string }[] = [
  { authorKey: 'sara', body: "Taking this one. v1 by Thursday — wiring read-claim-form into ai-summarize with the policy lookup in between." },
  { authorKey: 'emma', body: 'Yes please. Come watch me do five of these by hand first — you’ll see exactly what slows me down.' },
  { authorKey: 'noah', body: "I’ll prep mock data: 25 anonymized claim forms across the templates we actually see, PII scrubbed." },
];

// Sara's runnable winning flow uses the same explicit, all-green graph as the legacy demo
// (every leaf input config-supplied; no ctx.llm) so a "Try it" run finishes green offline.
const LISA_FLOW_SLUGS = ['read-claim-form', 'lookup-policy', 'flag-anomalies', 'if-else', 'format-output'];

// ---- IT-ops sandboxes (one per member; mixed statuses for a believable board) ----
interface SandboxSeed {
  user: string; project: string; status: 'running' | 'idle' | 'suspended' | 'error';
  startedMinAgo: number; callsToday: number; spendToday: number;
}
const SANDBOXES: SandboxSeed[] = [
  { user: 'emma', project: 'Auto-summarize claims v0.5', status: 'running', startedMinAgo: 122, callsToday: 151, spendToday: 0.36 },
  { user: 'sara', project: 'OCR fallback experiments', status: 'running', startedMinAgo: 41, callsToday: 198, spendToday: 0.49 },
  { user: 'noah', project: 'Inbox routing', status: 'idle', startedMinAgo: 1605, callsToday: 58, spendToday: 0.13 },
  { user: 'liam', project: 'Churn digest', status: 'running', startedMinAgo: 63, callsToday: 88, spendToday: 0.2 },
  { user: 'yuki', project: 'Low-code extractor', status: 'idle', startedMinAgo: 210, callsToday: 12, spendToday: 0.03 },
  { user: 'omar', project: 'Contract pre-check', status: 'error', startedMinAgo: 14, callsToday: 0, spendToday: 0 },
];

// Block popularity → weighted run pool so "Most used blocks" ranks believably.
const POPULARITY: [string, number][] = [
  ['read-claim-form', 10], ['ai-summarize', 8], ['extract-fields', 7], ['lookup-policy', 5],
  ['flag-anomalies', 4], ['format-output', 3], ['classify', 2], ['ocr-scan', 1],
];
const POOL: string[] = POPULARITY.flatMap(([slug, w]) => Array.from({ length: w }, () => slug));
const LLM_SLUGS = new Set(['ai-summarize', 'extract-fields', 'classify', 'flag-anomalies', 'ocr-scan', 'compare-docs']);

const minsAgo = (now: Date, mins: number) => new Date(now.getTime() - mins * 60_000);

// ---- datasets for the Data screen ----
const SAMPLE_DATASETS: { name: string; rows: Record<string, unknown>[] }[] = [
  {
    name: 'Claims Q1', rows: [
      { claim_id: 'CLM-2001', type: 'auto', amount: 2500, status: 'open', filed: '2026-01-15' },
      { claim_id: 'CLM-2002', type: 'home', amount: 5400, status: 'review', filed: '2026-02-03' },
      { claim_id: 'CLM-2003', type: 'auto', amount: 780, status: 'approved', filed: '2026-02-19' },
      { claim_id: 'CLM-2004', type: 'travel', amount: 1200, status: 'open', filed: '2026-03-02' },
      { claim_id: 'CLM-2005', type: 'home', amount: 9800, status: 'escalated', filed: '2026-03-21' },
    ],
  },
  {
    name: 'Policyholders', rows: [
      { id: 'POL-1', name: 'Alice Brandt', email: 'alice@example.invalid', tier: 'gold', renews: '2026-07-01' },
      { id: 'POL-2', name: 'Bram de Vries', email: 'bram@example.invalid', tier: 'silver', renews: '2026-08-14' },
      { id: 'POL-3', name: 'Chloe Martens', email: 'chloe@example.invalid', tier: 'bronze', renews: '2026-09-30' },
    ],
  },
  {
    name: 'Broker Payments', rows: [
      { ref: 'BRK-901', broker: 'Noord BV', amount: 12450.5, currency: 'EUR', period: '2026-05' },
      { ref: 'BRK-902', broker: 'Zuid Assuradeuren', amount: 8830.0, currency: 'EUR', period: '2026-05' },
      { ref: 'BRK-903', broker: 'West Makelaars', amount: 5210.75, currency: 'EUR', period: '2026-05' },
    ],
  },
];

// ---------------------------------------------------------------------------

async function ensureTenant(tenantId: string): Promise<void> {
  await db
    .insert(tenants)
    .values({ id: tenantId, name: 'FR Test', slug: `t-${tenantId.replace(/-/g, '').slice(0, 24)}`, industry: 'insurance' })
    .onConflictDoNothing({ target: tenants.id });
}

/** Members (by email) + the fr-test user, all keyed for reference. 'you' → fr-test. */
async function ensureMembers(tenantId: string): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>();
  for (const m of MEMBERS) {
    const [existing] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, m.email));
    if (existing) {
      out.set(m.key, existing);
      await db.update(users).set({ tenant_id: tenantId }).where(eq(users.id, existing.id));
      continue;
    }
    const [created] = await db
      .insert(users)
      .values({ email: m.email, name: m.name, avatar_initials: m.initials, role: 'employee', tenant_id: tenantId })
      .returning({ id: users.id, name: users.name });
    out.set(m.key, created!);
  }
  // The fr-test user is 'you'. On a cold DB the row is materialised here so the seed is
  // self-contained. An EXISTING row is never re-homed: `users.tenant_id` is fr-test's real CP
  // membership (authoritative since CP owns tenancy), and fr-test is a super_admin who reaches the
  // showcase tenant through `X-Active-Tenant-Id` anyway.
  await db.insert(users)
    .values({ id: FR_TEST_USER_ID, keycloak_sub: FR_TEST_USER_ID, email: 'fr-test@nonagentic.local', name: 'FR Test', avatar_initials: 'FT', role: 'employee', tenant_id: tenantId })
    .onConflictDoNothing();
  const [you] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, FR_TEST_USER_ID));
  out.set('you', you!);
  return out;
}

interface ResolvedBlock { blockId: string; versionId: string; category: 'data' | 'ai' | 'logic' | 'output' | 'ui'; descriptor: BlockDescriptor; }
async function resolveBlocks(slugs: string[]): Promise<Map<string, ResolvedBlock>> {
  const out = new Map<string, ResolvedBlock>();
  const rows = await db
    .select({ slug: buildingBlocks.slug, blockId: buildingBlocks.id, category: buildingBlocks.category, versionId: blockVersions.id, descriptor: blockVersions.descriptor })
    .from(buildingBlocks)
    .innerJoin(blockVersions, eq(buildingBlocks.current_version_id, blockVersions.id))
    .where(inArray(buildingBlocks.slug, slugs));
  for (const r of rows) out.set(r.slug, { blockId: r.blockId, versionId: r.versionId, category: r.category, descriptor: r.descriptor });
  return out;
}

function buildLisaFlow(blocks: Map<string, ResolvedBlock>): FlowGraph {
  const nodes: FlowNode[] = LISA_NODES.map((spec) => {
    const b = blocks.get(spec.slug);
    if (!b) throw new Error(`seed-tenant-showcase: block '${spec.slug}' not found in the global catalogue`);
    return {
      id: spec.nodeId, blockId: b.blockId, blockVersionId: b.versionId, slug: spec.slug,
      label: spec.slug, category: b.category, config: spec.config, position: spec.position,
    };
  });
  return { nodes, edges: LISA_EDGES.map((e) => ({ ...e })) };
}

function buildTrace(runId: string, slugs: string[], finishedAt: Date, totalMs: number, status: 'ok' | 'partial' | 'failed', totals: CostDelta): TraceEvent[] {
  const startTs = finishedAt.getTime() - totalMs;
  const per = Math.max(1, Math.round(totalMs / slugs.length));
  const events: TraceEvent[] = [{ type: 'run_start', runId, ts: startTs, nodeCount: slugs.length }];
  slugs.forEach((slug, i) => {
    const nodeId = `n${i + 1}`;
    const ts = startTs + per * i;
    events.push({ type: 'node_start', runId, ts, nodeId, slug });
    const llm = LLM_SLUGS.has(slug);
    events.push({
      type: 'node_success', runId, ts: ts + per, nodeId, slug, durationMs: per,
      cost: llm ? { usd: 0.0005, tokensIn: 45, tokensOut: 24, llmCalls: 1 } : { usd: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0 },
      outputPreview: '',
    });
  });
  events.push({ type: 'run_complete', runId, ts: finishedAt.getTime(), totalMs, status, totals });
  return events;
}

// ---------------------------------------------------------------------------

export interface ShowcaseResult {
  tenantId: string;
  members: number;
  challengesCreated: number;
  solutionsCreated: number;
  runs: number;
  sandboxes: number;
  usageEvents: number;
  winnerWeek: string;
}

/** Per-call override for the fabrication gate — same seam and same rationale as
 *  `SeedPlatformOpts` (seed-platform.ts:533-540) and `SeedMarketplaceOpts`. `config.ts` sets
 *  `seedFabricatedTelemetry` true whenever NODE_ENV !== 'production', so a test that does not pass
 *  `{ fabricate: false }` explicitly runs the UN-GATED branch and asserts nothing about the gate.
 *  This file used to read the config inline at three sites; threading one local through them all
 *  is what makes those three, and the four vote sites below, overridable together. */
export interface SeedTenantShowcaseOpts {
  fabricate?: boolean;
}

export async function seedTenantShowcase(
  tenantId: string,
  opts: SeedTenantShowcaseOpts = {},
): Promise<ShowcaseResult> {
  const fabricate = opts.fabricate ?? config.seedFabricatedTelemetry;
  const now = new Date();
  // The demo's weekly-winner story is anchored to LAST week, not a hardcoded literal — this used to
  // be `const WINNER_WEEK = '2026-W23'` at module scope, which goes stale purely because the
  // calendar advances (measured 13 weeks stale on arrival before this fix). `showcaseWeeks`
  // (seed-marketplace.ts, shared with that file's identical need) derives `winnerWeek` as the ISO
  // week immediately before `now`'s own week: a week whose voting+solution phases are freshly over,
  // so it can be seeded as an already-decided "this week's winner" without this seed having to run
  // the cycle engine itself.
  //
  // ⚠️ This is NOT "fixed by `healOrphanedChallenges`" the way the old comment here claimed, and it
  // would be wrong to rely on that even if it still worked that way: `healOrphanedChallenges`
  // (host/cycle-service.ts) no longer CLOSES anything — it only advances a challenge stranded in a
  // dead week to `solution_phase` — and closing was never the right fix for a week going stale under
  // a hardcoded literal. The actual fix is that there is no longer a literal to go stale: this week
  // is real for every run, at the moment it runs.
  const { winnerWeek } = showcaseWeeks(now);
  await ensureTenant(tenantId);
  const u = await ensureMembers(tenantId);
  const memberIds = MEMBERS.map((m) => u.get(m.key)!.id);
  const uid = (key: string) => u.get(key)!.id;

  // ---- challenges (idempotent by tenant+title) ----
  const challengeIdByKey = new Map<string, string>();
  let challengesCreated = 0;
  for (const c of CHALLENGES) {
    const [existing] = await db.select({ id: challenges.id, code: challenges.code }).from(challenges).where(and(eq(challenges.tenant_id, tenantId), eq(challenges.title, c.title)));
    if (existing) {
      challengeIdByKey.set(c.key, existing.id);
      // Self-heal the display code only (older seeds set it equal to the vote count, which
      // read as a fake/unstable id and drifted with votes). NEVER touch votes_count — that
      // carries live vote state.
      if (existing.code !== c.code) await db.update(challenges).set({ code: c.code }).where(eq(challenges.id, existing.id));
      continue;
    }
    const [created] = await db.insert(challenges).values({
      title: c.title, description: c.description, business_impact: c.businessImpact, work_area: c.workArea,
      submitter_id: uid(c.authorKey), tenant_id: tenantId, status: c.status, week: winnerWeek,
      // ⛔ 0 IS NOT A PLACEHOLDER: this is the INSERT, so the row has existed for no time at all
      // and its real vote count is provably 0. `c.votes` (312/198/176/…) is the fabrication.
      metrics: c.metrics, tags: c.tags, code: c.code, votes_count: fabricate ? c.votes : 0,
    }).returning({ id: challenges.id });
    challengeIdByKey.set(c.key, created!.id);
    challengesCreated++;
    // Mirror of routes/challenges.ts:543 — SAME entity type and SAME three fields. Best-effort for
    // the reason the route is: a translation hiccup must not abort a boot seed half-way through the
    // showcase. `uid(c.authorKey)` is the row's own `submitter_id`, so it is a real `users` id —
    // ⛔ a NULL `requested_by` would be UNDRAINABLE (`processPendingBatch` fails it with
    // `no metering actor`), which is worse than not queueing at all.
    try {
      await enqueueTranslations(
        'challenge',
        created!.id,
        [
          { field: 'title', value: c.title },
          { field: 'description', value: c.description },
          { field: 'business_impact', value: c.businessImpact },
        ],
        uid(c.authorKey),
      );
    } catch (e) {
      log.warn('seed_challenge_translation_enqueue_failed', { component: 'translation', challengeId: created!.id, err: e });
    }
  }
  const claimsId = challengeIdByKey.get('claims')!;

  // ---- Sara's runnable winning flow (links her solution) ----
  const blocks = await resolveBlocks(LISA_FLOW_SLUGS);
  const lisaGraph = buildLisaFlow(blocks);
  const winFlowName = "[demo] Sara's claim-summary solution";
  let winFlowId: string;
  {
    const [existing] = await db.select({ id: flows.id }).from(flows).where(and(eq(flows.owner_id, uid('sara')), eq(flows.name, winFlowName)));
    if (existing) {
      winFlowId = existing.id;
      // Never overwrite an existing working graph on boot. Publication below owns its immutable
      // graph; a deliberate showcase reset belongs in an explicit disposable-tenant job.
      await db.update(flows).set({ tenant_id: tenantId }).where(eq(flows.id, existing.id));
    } else {
      const [created] = await db.insert(flows).values({
        name: winFlowName, description: 'Auto-summarize claim forms — the winning solution.',
        owner_id: uid('sara'), tenant_id: tenantId, status: 'submitted', graph: lisaGraph, last_saved_at: now,
      }).returning({ id: flows.id });
      winFlowId = created!.id;
    }
  }

  // ---- solutions (idempotent by challenge+title) ----
  const solutionIdByAuthor = new Map<string, string>();
  let solutionsCreated = 0;
  for (const s of SOLUTIONS) {
    const [existing] = await db.select({ id: solutions.id, flowId: solutions.flow_id, publishedGraph: solutions.published_graph }).from(solutions).where(and(eq(solutions.challenge_id, claimsId), eq(solutions.title, s.title)));
    if (existing) {
      solutionIdByAuthor.set(s.authorKey, existing.id);
      if (s.linkFlow && (!existing.flowId || !existing.publishedGraph)) {
        await db.update(solutions).set({
          ...(!existing.flowId ? { flow_id: winFlowId } : {}),
          ...(!existing.publishedGraph ? {
            published_graph: lisaGraph,
            published_manifest: lisaGraph.nodes.map((node) => ({ nodeId: node.id, blockId: node.blockId, versionId: node.blockVersionId, slug: node.slug, descriptor: blocks.get(node.slug)!.descriptor })),
            published_hash: await graphContentHash(lisaGraph),
            published_at: now,
            published_by: uid(s.authorKey),
          } : {}),
        }).where(eq(solutions.id, existing.id));
      }
      continue;
    }
    const [created] = await db.insert(solutions).values({
      challenge_id: claimsId, tenant_id: tenantId, title: s.title, author_id: uid(s.authorKey),
      flow_id: s.linkFlow ? winFlowId : null, status: s.status, week: winnerWeek,
      published_graph: s.linkFlow ? lisaGraph : null,
      published_manifest: s.linkFlow ? lisaGraph.nodes.map((node) => ({ nodeId: node.id, blockId: node.blockId, versionId: node.blockVersionId, slug: node.slug, descriptor: blocks.get(node.slug)!.descriptor })) : [],
      published_hash: s.linkFlow ? await graphContentHash(lisaGraph) : null,
      published_at: s.linkFlow ? now : null,
      published_by: s.linkFlow ? uid(s.authorKey) : null,
      blocks_used: s.blocksUsed,
      // Same as the challenge INSERT above, with higher stakes: this column is the first key of
      // WINNER_ORDER, so a fabricated value does not misreport the winner, it picks one.
      votes_count: fabricate ? s.votes : 0,
    }).returning({ id: solutions.id });
    solutionIdByAuthor.set(s.authorKey, created!.id);
    solutionsCreated++;
    // Mirror of routes/solutions.ts:661 — `title` is the ONLY translated field there, so it is the
    // only one here. `uid(s.authorKey)` is the row's own `author_id`, i.e. a real metering actor.
    try {
      await enqueueTranslations('solution', created!.id, [{ field: 'title', value: s.title }], uid(s.authorKey));
    } catch (e) {
      log.warn('seed_solution_translation_enqueue_failed', { component: 'translation', solutionId: created!.id, err: e });
    }
  }
  const winSolutionId = solutionIdByAuthor.get('sara')!;

  // ---- additive fixture comments; genuine member discussion is live data ----
  for (let i = 0; i < COMMENTS.length; i++) {
    const c = COMMENTS[i]!;
    const [existing] = await db.select({ id: comments.id }).from(comments).where(and(
      eq(comments.challenge_id, claimsId), eq(comments.author_id, uid(c.authorKey)), eq(comments.body, c.body),
    ));
    if (existing) continue;
    await db.insert(comments).values({
      challenge_id: claimsId, tenant_id: tenantId, author_id: uid(c.authorKey), body: c.body,
      created_at: new Date(now.getTime() - (COMMENTS.length - i) * 6 * 3600_000),
    });
  }

  // ---- genuine votes (so home "Voted on" fills for the fr-test user) ----
  const voteSpecs: { user: string; target: 'challenge' | 'solution'; id: string }[] = [
    { user: 'you', target: 'challenge', id: challengeIdByKey.get('inbox')! },
    { user: 'you', target: 'challenge', id: challengeIdByKey.get('contracts')! },
    { user: 'you', target: 'challenge', id: challengeIdByKey.get('churn')! },
    { user: 'you', target: 'solution', id: solutionIdByAuthor.get('noah')! },
    { user: 'you', target: 'solution', id: winSolutionId },
    { user: 'emma', target: 'solution', id: winSolutionId },
    { user: 'noah', target: 'challenge', id: claimsId },
    { user: 'liam', target: 'challenge', id: claimsId },
  ];
  for (const v of voteSpecs) {
    await db.insert(votes).values({ user_id: uid(v.user), tenant_id: tenantId, target_type: v.target, target_id: v.id })
      .onConflictDoNothing({ target: [votes.user_id, votes.target_type, votes.target_id] });
  }

  // ⛔ UN-GATED, AND NOT OPTIONAL. The eight rows above are GENUINE votes, but they are inserted
  // with a raw `db.insert(votes)` that bypasses `castVote` — deliberately, since castVote would
  // 404/self-vote/closed-cycle them — and so nothing bumps `votes_count`. With fabrication OFF the
  // targets are inserted at 0, really do receive those votes, and would sit at 0 forever: this
  // seeder would ship a NEW drift, in the OPPOSITE direction, on every fresh tenant, and migration
  // 0064 would have to be re-run after every boot. Recomputing here is the only place that closes
  // it, because only here do we know which ids the loop touched.
  //
  // Un-gated for the reason the scoped `flow_runs` DELETE below is un-gated, and the scoped audit
  // DELETE in seed-platform.ts:34: a fabrication-OFF boot must clean up its own past output rather
  // than leave it stranded. It is scoped to ids this seeder itself just wrote to, so it cannot
  // touch a row the seeder has no claim on — and because it RECOMPUTES rather than assigns, it is
  // equally correct on a tenant whose members have since cast real votes.
  //
  // ⚠️ This deliberately changes dev/CI numbers even with fabrication ON: the six voteSpecs targets
  // read their real 1-2 votes while the untouched rows keep their invented hundreds. That is not
  // an inconsistency to paper over — it is the fabricated rows standing out against real ones.
  await recountVotes('challenge', [...new Set(voteSpecs.filter((v) => v.target === 'challenge').map((v) => v.id))]);
  await recountVotes('solution', [...new Set(voteSpecs.filter((v) => v.target === 'solution').map((v) => v.id))]);

  // ---- weekly winner (idempotent per (tenant_id, week)) ----
  // ⛔ GATED. `1180 / 14 / 7 / 9` is a hard-coded object literal, NOT a sum of the votes_count
  // values above — so clamping the counters leaves it untouched, and the winner screen prints it
  // beside the live count in the same stat row (winner/+page.svelte:88-89): "2 stemmen ontvangen ·
  // 1.180 stemmen uitgebracht". With fabrication off, write what the CLOSE would have written.
  // ⚠️ ORDER MATTERS: this must stay AFTER the recount above, or `totalVotesCast` sums the
  // pre-recount counters and freezes the inflated total into an artifact that is only ever
  // recomputed when EMPTY (marketplace-summary.ts:355).
  const winnerStats = fabricate
    ? { totalVotesCast: 1180, solutionsSubmitted: 14, firstTimeBuilders: 7, crossDomain: 9 }
    : await periodSolutionStats(winnerWeek, tenantId, db);
  await db.insert(weeklyWinners).values({
    week: winnerWeek, solution_id: winSolutionId, challenge_id: claimsId, tenant_id: tenantId,
    stats: winnerStats,
  }).onConflictDoNothing({ target: [weeklyWinners.tenant_id, weeklyWinners.week] });

  // ---- sandboxes (idempotent by slug) ----
  const sandboxByUser = new Map<string, string>();
  for (const s of SANDBOXES) {
    const owner = u.get(s.user)!;
    const slug = `frd-${s.user}-${tenantId.slice(0, 4)}`;
    const [row] = await db.insert(sandboxes).values({
      owner_id: owner.id, tenant_id: tenantId, slug, label: `${owner.name}'s sandbox`,
      project: s.project, status: s.status, suspension_reason: s.status === 'suspended' ? 'admin' : null,
      is_primary: true, seed_key: `showcase:${tenantId}:sandbox:${s.user}`,
      last_active_at: minsAgo(now, s.startedMinAgo), updated_at: now,
    }).onConflictDoUpdate({
      target: sandboxes.slug,
      // Preserve status/activity: these may reflect a real run or an operator pause.
      set: { project: s.project, seed_key: `showcase:${tenantId}:sandbox:${s.user}` },
    }).returning({ id: sandboxes.id });
    sandboxByUser.set(s.user, row!.id);
  }

  // ---- today's usage_counters (IT-dash daily calls / spend) ----
  // ⛔ UNTARGETED `ON CONFLICT DO NOTHING`, deliberately — do not name a target here.
  // 0058 added `(tenant_id, user_id, day)` and 0059 dropped the pre-tenancy `(user_id, day)`;
  // untargeted was the only form valid in BOTH states, which is what let the pair ship as a
  // rolling deploy. Keep it that way — it stays correct the next time the key moves, and it
  // arbitrates on whatever unique constraints exist rather than on one this file has to know
  // about. (In the 0058→0059 window, naming the wide key would have found no conflict for a
  // user who already had a row under another tenant, inserted, and then tripped the still-live
  // narrow constraint as an unhandled 23505. Untargeted degraded to a skip instead.)
  // `tenant_id` is passed EXPLICITLY: this seed runs under `runAsSystem`, which carries no tenant
  // GUC, so the column DEFAULT `app_current_tenant_uuid()` would resolve NULL and violate NOT NULL.
  // ⛔ Gated in production (config.seedFabricatedTelemetry, overridable per-call via `seedTenantShowcase(id, { fabricate })`). `ON CONFLICT DO NOTHING` makes this
  // additive rather than destructive, but "additive" is not harmless here: it invents the meter.
  // These very rows are why prod read an identical 1049 calls / $2.50 for six days running, with
  // five of these six users (198/151/88/58 calls) parked above the daily cap of 50.
  if (fabricate) {
    for (const s of SANDBOXES) {
      await db.execute(sql`INSERT INTO usage_counters (user_id, tenant_id, day, llm_calls, spend_usd)
          VALUES (${u.get(s.user)!.id}, ${tenantId}, current_date, ${s.callsToday}, ${s.spendToday})
          ON CONFLICT DO NOTHING`);
    }
  } else {
    log.info('seed_showcase_usage_counters_skipped', { component: 'seed', reason: 'fabrication_off' });
  }

  // ---- one demo flow per member (FK target for runs) ----
  const flowByUser = new Map<string, string>();
  flowByUser.set('sara', winFlowId);
  for (const s of SANDBOXES) {
    if (flowByUser.has(s.user)) continue;
    const owner = u.get(s.user)!;
    const name = `[demo] ${s.project}`;
    const [existing] = await db.select({ id: flows.id }).from(flows).where(and(eq(flows.owner_id, owner.id), eq(flows.name, name)));
    if (existing) { flowByUser.set(s.user, existing.id); continue; }
    const [created] = await db.insert(flows).values({ name, owner_id: owner.id, tenant_id: tenantId, graph: { nodes: [], edges: [] }, last_saved_at: now })
      .returning({ id: flows.id });
    flowByUser.set(s.user, created!.id);
  }

  // ---- flow_runs (delete-then-reinsert, scoped to the seeded flows; recent timestamps
  // so the 24h sparkline / P95 / today's aggregates render) ----
  await db.delete(flowRuns).where(sql`${flowRuns.seed_key} LIKE ${`showcase:${tenantId}:run:%`}`);
  const sandboxUserKeys = SANDBOXES.map((s) => s.user);
  const runRows: (typeof flowRuns.$inferInsert)[] = [];
  const TOTAL = 52;
  for (let i = 0; i < TOTAL; i++) {
    const userKey = sandboxUserKeys[i % sandboxUserKeys.length]!;
    const flowId = flowByUser.get(userKey)!;
    const sandboxId = sandboxByUser.get(userKey)!;
    const finishedAt = i < 40 ? minsAgo(now, 8 + i * 35) : minsAgo(now, 24 * 60 + (i - 40) * (7 * 60));
    const nSlugs = 1 + (i % 3);
    const slugs = Array.from({ length: nSlugs }, (_, k) => POOL[(i * 7 + k * 13) % POOL.length]!);
    const totalMs = 200 + ((i * 149) % 2500);
    const status: 'ok' | 'partial' | 'failed' = userKey === 'omar' && i % 9 === 0 ? 'failed' : i % 11 === 0 ? 'partial' : 'ok';
    const llmCount = slugs.filter((sl) => LLM_SLUGS.has(sl)).length;
    const totals: CostDelta = { usd: Number((llmCount * 0.0005).toFixed(6)), tokensIn: llmCount * 45, tokensOut: llmCount * 24, llmCalls: llmCount };
    const id = Bun.randomUUIDv7();
    runRows.push({
      id, flow_id: flowId, tenant_id: tenantId, triggered_by: u.get(userKey)!.id, sandbox_id: sandboxId,
      seed_key: `showcase:${tenantId}:run:${i}`,
      status, trace: buildTrace(id, slugs, finishedAt, totalMs, status, totals),
      total_ms: totalMs, total_cost_usd: totals.usd.toFixed(6), tokens_in: totals.tokensIn, tokens_out: totals.tokensOut,
      llm_calls: totals.llmCalls, started_at: new Date(finishedAt.getTime() - totalMs), finished_at: finishedAt,
    });
  }
  // ⛔ The scoped DELETE above always runs, but the reinsert is gated
  // (config.seedFabricatedTelemetry, per-call overridable). Keeping the delete un-gated is deliberate: it is keyed on
  // `showcase:<tenant>:run:%`, so it touches only rows this seeder itself invented, which means a
  // boot with fabrication disabled cleans up its own past output instead of leaving it stranded.
  if (fabricate) {
    for (let i = 0; i < runRows.length; i += 20) await db.insert(flowRuns).values(runRows.slice(i, i + 20));
  } else {
    log.info('seed_showcase_flow_runs_skipped', { component: 'seed', reason: 'fabrication_off' });
  }

  // ---- usage_events (14-day spend chart). Scoped delete on the seeded members so the
  // real fr-test user's own events are untouched, then reinsert. ----
  await db.delete(usageEvents).where(sql`${usageEvents.seed_key} LIKE ${`showcase:${tenantId}:usage:%`}`);
  const models = [
    { provider: 'anthropic', model: 'claude-sonnet-4-6', tIn: 1200, tOut: 380, cost: 0.018 },
    { provider: 'anthropic', model: 'claude-haiku-4-5', tIn: 800, tOut: 210, cost: 0.004 },
  ];
  const usageRows: (typeof usageEvents.$inferInsert)[] = [];
  for (let day = 0; day < 14; day++) {
    for (let k = 0; k < 3; k++) {
      const m = models[(day + k) % models.length]!;
      usageRows.push({
        tenant_id: tenantId, user_id: memberIds[(day + k) % memberIds.length]!, provider: m.provider, model: m.model,
        seed_key: `showcase:${tenantId}:usage:${day}:${k}`,
        tokens_in: m.tIn, tokens_out: m.tOut, cost_usd: String(m.cost),
        created_at: new Date(now.getTime() - (day * 24 * 60 + k * 90) * 60_000),
      });
    }
  }
  // Same shape as the runs above: scoped delete always, reinsert only when fabrication is allowed.
  // Note what these rows claim — 14 days of `anthropic`/`claude-sonnet-4-6` spend on a deployment
  // that holds no Anthropic key at all and routes every call to the in-cluster inference-router.
  // The 14-day spend chart was not merely stale, it attributed cost to a provider never called.
  if (fabricate) {
    await db.insert(usageEvents).values(usageRows);
  } else {
    log.info('seed_showcase_usage_events_skipped', { component: 'seed', reason: 'fabrication_off' });
  }

  // ---- tenant LLM setting (so the tenant has a configured model) ----
  await db.insert(tenantLlmSettings).values({
    tenant_id: tenantId, provider: 'openai_compatible', model: 'local-llm',
    base_url: config.llm.openaiBaseUrl || null, temperature: 0.1,
  }).onConflictDoNothing({ target: tenantLlmSettings.tenant_id });

  // ---- datasets (Data screen). createDataset derives a unique slug; guard by name. ----
  for (const d of SAMPLE_DATASETS) {
    const [existing] = await db.select({ id: datasets.id }).from(datasets).where(and(eq(datasets.tenant_id, tenantId), eq(datasets.name, d.name)));
    if (existing) continue;
    await createDataset({ ownerId: uid('you'), tenantId, name: d.name, sourceType: 'json', parsed: parseJsonValue(d.rows) });
  }

  // Issue (idempotent) the showcase tenant's `commonpractice` license so Gate 2 passes for fr-test.
  // The seed creates the tenant + its data but historically never licensed it, so once Gate 2 went
  // live every fr-test request 402'd. No-op when issuance is disabled (CI/local) or already licensed.
  // Bound to the fr-test Keycloak sub (FR_TEST_USER_ID); Gate 2 only asserts the tenant_id.
  await ensureTenantLicense(tenantId, FR_TEST_USER_ID);

  return {
    tenantId,
    members: MEMBERS.length,
    challengesCreated,
    solutionsCreated,
    runs: runRows.length,
    sandboxes: SANDBOXES.length,
    usageEvents: usageRows.length,
    winnerWeek,
  };
}

if (import.meta.main) {
  const tenantId = process.argv[2] ?? DEFAULT_TENANT_ID;
  const r = await runAsSystem('boot-seed', () => seedTenantShowcase(tenantId));
  log.info('seed_tenant_showcase_cli_done', {
    component: 'seed-tenant-showcase',
    tenantId: r.tenantId,
    members: r.members,
    challengesCreated: r.challengesCreated,
    solutionsCreated: r.solutionsCreated,
    runs: r.runs,
    sandboxes: r.sandboxes,
    usageEvents: r.usageEvents,
    winnerWeek: r.winnerWeek,
  });
  await closeConnection();
  process.exit(0);
}
