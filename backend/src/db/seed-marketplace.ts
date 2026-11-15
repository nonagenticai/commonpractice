// src/db/seed-marketplace.ts — Session 5 marketplace fidelity seed (demo.html
// Discover screens). Provisions the demo's 5 challenges (the Challenge leaderboard), 5 solutions to
// challenge #1 (the Solution leaderboard), Lisa's winning solution linked to a real Build flow, the
// challenge-detail discussion thread, and the most-recently-closed week's weekly winner (the week is
// derived, not hardcoded — see `showcaseWeeks` below).
//
// ⚠️ RETRACTION — the paragraph that used to sit here said, under the heading "HONEST", that
// "votes_count carries the demo's seeded fidelity baseline (284/316/…) — far more than the 9 demo
// users … We do not fabricate live votes". It is preserved rather than deleted because it is the
// sentence that made the defect look deliberate and therefore reviewable-as-designed. Both halves
// were wrong where it counts:
//   * writing 316 into `votes_count` IS fabricating votes. The claim "316 colleagues upvoted this"
//     is made by the column, not by the table it is a cache of; declining to also forge rows in
//     `votes` withheld the EVIDENCE, it did not withhold the CLAIM. Prod displayed 4,760 votes
//     against 18 real `votes` rows platform-wide.
//   * "fidelity baseline" describes a display value. This column is the first key of WINNER_ORDER
//     (host/cycle-eligibility.ts:71), so it does not just render the leaderboard, it DECIDES the
//     winner — the seeder outranking every real vote that will ever be cast.
// `votes_count` is now clamped to 0 on the INSERT path whenever fabrication is off (see the
// `fabricate` seam below); migration 0064 reconciled the rows that already existed.
//
// Idempotent: challenges by (tenant_id, code) — the one key the database makes unique, see the
// block comment on that lookup — solutions by (challenge, title) tie-broken on oldest id, Lisa's
// flow by (owner, name), fixture comments additively by (challenge, author, body), winner by
// (tenant, week).
import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  db,
  users,
  buildingBlocks,
  blockVersions,
  flows,
  challenges,
  solutions,
  comments,
  weeklyWinners,
} from './client';
import { config, DEMO_TENANT_ID } from '../config';
import { periodSolutionStats } from '../host/cycle-eligibility';
import { DAY, weekStart, weekString } from '../host/iso-week';
import type { FlowGraph, FlowNode, FlowEdge } from './flow-types';
import type { BlockDescriptor } from './block-types';
import type { ChallengeMetrics } from './schema';
import { graphContentHash } from '../host/publication-service';

/**
 * The two ISO weeks the showcase/demo seeds stamp their content into, derived from `now` instead
 * of a hardcoded literal.
 *
 * WHY: this file used to carry `const WEEK = '2026-W21'` (seed-tenant-showcase.ts carried a
 * sibling `WINNER_WEEK = '2026-W23'`). The product owner needs demo content ready AT ALL TIMES, and
 * a hardcoded week goes stale purely because the calendar advances — both literals were measured 13
 * weeks stale on arrival. Worse than merely stale: re-seeding stamped challenges into a week whose
 * cycle had already closed, and prod accumulated 16 challenges permanently stuck advertising "in
 * voting" for votes that could never be counted (see the incident history in
 * host/cycle-service.ts's `healOrphanedChallenges`). That sweep is now REPORT-ONLY — it writes
 * nothing to `challenges.status` at all, it only names the orphans — so a hardcoded week is
 * papered over by nothing whatsoever downstream; deriving it here is the actual fix.
 *
 * `openWeek` is the ISO week of `now` — the week a freshly-submitted challenge would compete in.
 * `winnerWeek` is the week immediately before it: a week whose voting+solution phases are freshly
 * over, so the seed can plausibly present it as an already-decided "this week's winner" without
 * itself having to run the cycle engine forward. Both this file and seed-tenant-showcase.ts (which
 * imports this) use `winnerWeek` for exactly that reason.
 *
 * Pure — takes `now` as a parameter rather than reading the clock — so a test can pin a fixed
 * instant; the seeds themselves call it with `new Date()`.
 */
export function showcaseWeeks(now: Date): { openWeek: string; winnerWeek: string } {
  const openWeek = weekString(now);
  const winnerWeek = weekString(new Date(weekStart(openWeek).getTime() - 7 * DAY));
  return { openWeek, winnerWeek };
}

interface ChallengeSeed {
  key: string;
  authorKey: string;
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

// The challenges leaderboard, verbatim from the demo (home + challenges screens).
const CHALLENGES: ChallengeSeed[] = [
  {
    key: 'claims',
    authorKey: 'demoOwner',
    title: 'Auto-summarize claim forms',
    workArea: 'Claims',
    code: 'CH-284',
    status: 'solution_phase',
    votes: 284,
    tags: ['PDF', 'NL', 'Summarize'],
    description:
      'Every Tuesday I get a stack of claim PDFs to process — typically 40 to 60 forms. Each takes about 4 minutes to read, pull out the key fields, and write a 3-line summary I can paste into the case file. That\'s about 3 hours, every Tuesday, before I even start the actual work of judging the claims. The forms aren\'t standard — every intermediary uses their own template.',
    businessImpact:
      '~3 hrs/week per claims associate × 28 staff in Claims NL. Reduces case-handling backlog by an estimated 12%.',
    metrics: {
      timeSavedPerWeek: '~3 hrs',
      affectedStaff: '28',
      backlogReduction: '~12%',
    },
  },
  {
    key: 'policies',
    authorKey: 'jeremy',
    title: 'Compare policies in natural language',
    workArea: 'Sales',
    code: 'CH-241',
    status: 'voting',
    votes: 241,
    tags: ['Policies', 'Compare', 'LLM'],
    description:
      'When a customer asks how two of our policies differ, I read both documents end to end and write up the differences by hand. It is slow and easy to miss a clause.',
    businessImpact:
      'Every sales advisor hits this several times a week. Faster, more accurate comparisons mean fewer mis-sold policies.',
    metrics: {
      timeSavedPerWeek: '~2 hrs',
      affectedStaff: '40',
      backlogReduction: '~8%',
    },
  },
  {
    key: 'email',
    authorKey: 'fatima',
    title: 'Auto-categorize customer email',
    workArea: 'Service',
    code: 'CH-203',
    status: 'voting',
    votes: 203,
    tags: ['Email', 'Routing'],
    description:
      'Our shared service inbox gets hundreds of emails a day and a human triages each one to the right team. Most are obvious from the first line.',
    businessImpact:
      'Triage takes the equivalent of one full-time role. Auto-routing the obvious ones frees that person for the hard cases.',
    metrics: {
      timeSavedPerWeek: '~6 hrs',
      affectedStaff: '15',
      backlogReduction: '~20%',
    },
  },
  {
    key: 'contracts',
    authorKey: 'bart',
    title: 'Compliance checks on contract changes',
    workArea: 'Legal',
    code: 'CH-178',
    status: 'voting',
    votes: 178,
    tags: ['Contract', 'Compliance'],
    description:
      'When a contract is amended I check each change against our compliance rulebook by hand. The rulebook is 60 pages.',
    businessImpact:
      'Manual review is the bottleneck before any contract change can ship. Catching issues automatically de-risks every amendment.',
    metrics: {
      timeSavedPerWeek: '~4 hrs',
      affectedStaff: '9',
      backlogReduction: '~15%',
    },
  },
  {
    key: 'churn',
    authorKey: 'lisa',
    title: 'Visibility into churn signals per segment',
    workArea: 'Marketing',
    code: 'CH-162',
    status: 'voting',
    votes: 162,
    tags: ['Marketing', 'Analytics'],
    description:
      'I want to see which customer segments are showing early churn signals without exporting three dashboards into a spreadsheet first.',
    businessImpact:
      'Earlier churn detection per segment lets us target retention spend where it actually moves the needle.',
    metrics: {
      timeSavedPerWeek: '~3 hrs',
      affectedStaff: '12',
      backlogReduction: '~10%',
    },
  },
];

interface SolutionSeed {
  authorKey: string;
  title: string;
  votes: number;
  status: 'voting' | 'shipping';
  // ⛔ NO `buildMinutes` / `demoSeconds`. Both used to be seeded here and both were inventions.
  // Build time is gone from the product for want of any honest source (see the comment on
  // `solutions.build_time_minutes` in db/schema.ts). Demo time is now MEASURED from the solution's
  // own runs (`flow_runs.solution_id`, migration 0065 → host/solution-demo.ts) — seeding a constant
  // into the column the measurement replaced would put a fabricated duration on the board again,
  // which is the same class of defect as the fabricated `votes_count` this file's header warns
  // about. A seeded solution simply has no demo time until someone runs it.
  blocksUsed: string[];
  linkFlow?: boolean; // Lisa's winning solution links a real Build flow.
}

// Solutions to challenge #1 (the demo's solution leaderboard).
const SOLUTIONS: SolutionSeed[] = [
  {
    authorKey: 'lisa',
    title: 'GPT flow with policy context in 7 steps',
    votes: 316,
    status: 'shipping',
    blocksUsed: ['read-claim-form', 'lookup-policy', 'flag-anomalies', 'if-else', 'format-output'],
    linkFlow: true,
  },
  {
    authorKey: 'moa',
    title: 'Streaming summarizer with PDF OCR',
    votes: 289,
    status: 'voting',
    blocksUsed: ['ocr-scan', 'extract-fields', 'ai-summarize'],
  },
  {
    authorKey: 'hannah',
    title: 'Inline review UI for the Claims associate',
    votes: 244,
    status: 'voting',
    blocksUsed: ['read-claim-form', 'ai-summarize', 'review-panel'],
  },
  {
    authorKey: 'peter',
    title: 'Multi-doc compare with audit trail',
    votes: 201,
    status: 'voting',
    blocksUsed: ['read-claim-form', 'compare-docs', 'flag-anomalies'],
  },
  {
    authorKey: 'karim',
    title: 'No-code Power Automate variant',
    votes: 157,
    status: 'voting',
    blocksUsed: ['extract-fields', 'format-output'],
  },
];

// The challenge #1 discussion thread (challenge-detail screen).
const COMMENTS: { authorKey: string; body: string }[] = [
  { authorKey: 'lisa', body: "Picking this up. I'll have a v1 by Thursday — going to wire read-claim-form into ai-summarize with the policy lookup in between." },
  { authorKey: 'demoOwner', body: 'Yes please. 9:00 in the Claims room if you want to watch me do five of these by hand first — you\'ll see exactly what slows me down.' },
  { authorKey: 'moa', body: "I'll prep mock data: 25 anonymized claim forms across the templates we actually see, PII scrubbed." },
];

// Lisa's flow uses the 6 real seeded blocks (the demo's 7th, display-to-user, was
// never seeded in S1 — format-output is the terminal). The cosmetic "Built with"
// chips still show all 7 slugs (blocks_used above).
// Lisa's winning flow, authored as an explicit, runnable graph (NOT the generic
// buildChain). Every required input is supplied by a config literal or a
// type-matching edge, and no node invokes ctx.llm — so a "Try it" run is
// deterministic and finishes all-green (status 'ok') offline / dev / prod alike.
// (The old buildChain wired outputs[0]->inputs[0] with empty configs, leaving
// required inputs unset and crossing field types; it rendered but could never run.)
// ⛔ THE REASON THIS LIST OMITS `review-panel` IS NOW ONLY "IT IS NOT IN THE GRAPH".
// It used to read "review-panel is deliberately excluded because its descriptor omits the mockData
// capability its code uses" — a true observation of a DEFECT, written down as if it were a design
// constraint, and left in place while `SOLUTIONS` above kept advertising the slug in a solution's
// `blocksUsed`. The descriptor is repaired (db/seed.ts + migrations/0078_review_panel_mock_data.sql
// for databases that already hold the broken row), so the block runs and nothing here is routing
// around it any more.
//
// ⚠️ THE LIST IS NOT A CHOICE OF BLOCKS, IT IS A MIRROR OF `LISA_NODES` BELOW — `resolveBlocks`
// is fed this array and `buildLisaGraph` then looks up every `LISA_NODES` slug in the result, so a
// slug here that no node uses resolves a block nobody wires, and a node whose slug is missing here
// throws. The graph has exactly the five nodes n1-n5 below; re-checked with this change and it
// matches. Adding `review-panel` means adding a NODE (and an edge into its required `item` input,
// and updating tests/runs.test.ts, which asserts one `node_success` per LISA_NODES entry) — a
// change to the demo graph, not a change to this list, and not what repairing the block requires.
const LISA_FLOW_SLUGS = ['read-claim-form', 'lookup-policy', 'flag-anomalies', 'if-else', 'format-output'];

export interface LisaNodeSpec {
  nodeId: string;
  slug: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
}

// Parse the claim form, then fan out: flag anomalous pages, branch on whether OCR was
// needed, and render the claim text — plus a policy-context lookup. All leaf inputs are
// config-supplied; all edges connect identical FieldTypes (validated at runtime).
export const LISA_NODES: LisaNodeSpec[] = [
  { nodeId: 'n1', slug: 'read-claim-form', config: { file: { ref: 'demo-claim-001' }, force_ocr: false }, position: { x: 80, y: 220 } },
  { nodeId: 'n2', slug: 'lookup-policy', config: { policy_id: 'POL-44821' }, position: { x: 360, y: 400 } },
  { nodeId: 'n3', slug: 'flag-anomalies', config: { threshold: 3 }, position: { x: 360, y: 60 } },
  { nodeId: 'n4', slug: 'if-else', config: { if_true: { route: 'needs-ocr' }, if_false: { route: 'native-text' } }, position: { x: 640, y: 220 } },
  { nodeId: 'n5', slug: 'format-output', config: { format: 'markdown' }, position: { x: 920, y: 220 } },
];

export const LISA_EDGES: FlowEdge[] = [
  { id: 'e1', source: 'n1', sourceHandle: 'pages', target: 'n3', targetHandle: 'records' }, // json -> json
  { id: 'e2', source: 'n1', sourceHandle: 'ocr_used', target: 'n4', targetHandle: 'condition' }, // boolean -> boolean
  { id: 'e3', source: 'n1', sourceHandle: 'text', target: 'n5', targetHandle: 'content' }, // string -> string
];

interface ResolvedBlock {
  blockId: string;
  versionId: string;
  category: 'data' | 'ai' | 'logic' | 'output' | 'ui';
  descriptor: BlockDescriptor;
}

/** Resolve demo users (seeded by seed-ops) to ids, keyed by their seed key. */
async function resolveUsers(keys: string[]): Promise<Map<string, { id: string; name: string }>> {
  const EMAIL: Record<string, string> = {
    lisa: 'lisa.vermeer@commonpractice.local',
    moa: 'mo.ahmed@commonpractice.local',
    hannah: 'hannah.vanloon@commonpractice.local',
    demoOwner: 'demo-owner@commonpractice.local',
    peter: 'peter.janssen@commonpractice.local',
    fatima: 'fatima.hassani@commonpractice.local',
    bart: 'bart.vermeer@commonpractice.local',
    jeremy: 'jeremy.dewit@commonpractice.local',
    karim: 'karim.ouali@commonpractice.local',
  };
  const out = new Map<string, { id: string; name: string }>();
  for (const key of keys) {
    const email = EMAIL[key];
    if (!email) continue;
    const [u] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, email));
    if (u) out.set(key, u);
  }
  return out;
}

/** Resolve seeded blocks (by slug) to their id + current published version + descriptor. */
async function resolveBlocks(slugs: string[]): Promise<Map<string, ResolvedBlock>> {
  const out = new Map<string, ResolvedBlock>();
  const rows = await db
    .select({
      slug: buildingBlocks.slug,
      blockId: buildingBlocks.id,
      category: buildingBlocks.category,
      versionId: blockVersions.id,
      descriptor: blockVersions.descriptor,
    })
    .from(buildingBlocks)
    .innerJoin(blockVersions, eq(buildingBlocks.current_version_id, blockVersions.id))
    .where(inArray(buildingBlocks.slug, slugs));
  for (const r of rows) {
    out.set(r.slug, {
      blockId: r.blockId,
      versionId: r.versionId,
      category: r.category,
      descriptor: r.descriptor,
    });
  }
  return out;
}

/** Build Lisa's explicit, runnable demo graph from the resolved blocks (see LISA_NODES). */
function buildLisaFlow(blocks: Map<string, ResolvedBlock>): FlowGraph {
  const nodes: FlowNode[] = LISA_NODES.map((spec) => {
    const b = blocks.get(spec.slug);
    if (!b) throw new Error(`seedMarketplace: block '${spec.slug}' is not seeded — run seedBlocks first`);
    return {
      id: spec.nodeId,
      blockId: b.blockId,
      blockVersionId: b.versionId,
      slug: spec.slug,
      label: spec.slug,
      category: b.category,
      config: spec.config,
      position: spec.position,
    };
  });
  return { nodes, edges: LISA_EDGES.map((e) => ({ ...e })) };
}

/** Per-call override for the fabrication gate — the same injectable seam, and for the same reason,
 *  as `SeedPlatformOpts` (seed-platform.ts:533-540): `config.ts` sets `seedFabricatedTelemetry`
 *  true whenever NODE_ENV !== 'production', so every CI run and every test that does not say
 *  otherwise exercises the UN-GATED branch. A test asserting the gate MUST pass
 *  `{ fabricate: false }` explicitly; reading the config would make it assert nothing. */
export interface SeedMarketplaceOpts {
  fabricate?: boolean;
}

export async function seedMarketplace(
  opts: SeedMarketplaceOpts = {},
): Promise<{ challenges: number; solutions: number; winners: number }> {
  const fabricate = opts.fabricate ?? config.seedFabricatedTelemetry;
  // See `showcaseWeeks` above — the week this seed's content competes in is derived from `now`,
  // not hardcoded, so it never goes calendar-stale.
  const { winnerWeek } = showcaseWeeks(new Date());
  const allKeys = [...new Set([...CHALLENGES.map((c) => c.authorKey), ...SOLUTIONS.map((s) => s.authorKey), ...COMMENTS.map((c) => c.authorKey)])];
  const userIds = await resolveUsers(allKeys);
  if (userIds.size === 0) {
    // seed-ops hasn't run — nothing to anchor the marketplace to.
    return { challenges: 0, solutions: 0, winners: 0 };
  }

  // --- challenges (idempotent by title) ---
  const challengeIdByKey = new Map<string, string>();
  let challengesCreated = 0;
  for (const c of CHALLENGES) {
    const author = userIds.get(c.authorKey);
    if (!author) continue;
    // ⛔ TENANT-SCOPED, AND KEYED ON `code`, NOT ON `title`.
    //
    // ⚠️ CORRECTED — the comment that stood here claimed "`seed-tenant-showcase.ts` seeds four of
    // these same five titles into ITS tenant". MEASURED, the overlap is ONE. The showcase's six
    // titles are: 'Auto-summarize claim forms', 'Draft renewal letters from policy data',
    // 'Auto-categorize the shared service inbox', 'Compliance pre-check on contract edits',
    // 'Churn-risk digest per segment', 'Reconcile broker payment files'
    // (seed-tenant-showcase.ts:102-151). Only the FIRST is string-equal to anything in CHALLENGES
    // above; the other four near-misses ('Auto-categorize customer email' vs '…the shared service
    // inbox', 'Compliance checks on contract changes' vs 'Compliance pre-check on contract edits',
    // 'Visibility into churn signals per segment' vs 'Churn-risk digest per segment') are DIFFERENT
    // strings, and `eq()` does not care that they are the same idea. Overstating the collision
    // count is not harmless: it is the number a reader uses to decide how much this predicate buys.
    //
    // Two separate things are wrong with `(tenant_id, title)` and both are fixed here:
    //   1. TENANT. `challenges.tenant_id` is scoped by value; without the predicate a same-titled
    //      row in ANY other tenant stood in for the marketplace's own and this loop skipped an
    //      INSERT it owed. NB the showcase writes to `config.tenantShowcaseId`, which defaults to
    //      `TENANT_SHOWCASE_ID || DEMO_TENANT_ID` (config.ts:301) — i.e. by default the SAME tenant
    //      as this seeder, so the foreign rows this predicate excludes come from a deployment that
    //      sets TENANT_SHOWCASE_ID, from pre-C.1 per-user tenants, and from the test suite (three
    //      files seed this title into other tenants against one database).
    //   2. DETERMINISM. The tenant predicate alone does not make the pick unique: NOTHING stops one
    //      tenant holding two rows with this title — routes/challenges.ts inserts with no duplicate
    //      guard — so `(tenant_id, title)` returned a row in HEAP ORDER, a function of the last
    //      UPDATE or VACUUM. `(tenant_id, code)` carries the partial unique index
    //      `challenges_tenant_code_key` (schema.ts:760, `WHERE code IS NOT NULL`) and `c.code` is a
    //      non-null literal, so AT MOST ONE ROW CAN MATCH: unique by construction, not by hope.
    //      `asc(challenges.id)` is defence in depth — if that index is ever dropped the pick
    //      degrades to "oldest uuidv7 wins", a rule a reader can state, not back to heap order.
    //
    // Keying on `code` rather than `title` also removes a live boot-crash path: were the showcase
    // to rename the one title it shares with this file, a title-keyed lookup would miss, INSERT,
    // and hit 23505 on the shared CH-284 badge. It is safe in the other direction too — the
    // showcase SELF-HEALS `code` on a title it matches (seed-tenant-showcase.ts:359), and the two
    // files agree that 'Auto-summarize claim forms' is CH-284. That agreement is load-bearing.
    //
    // Every INSERT below stamps DEMO_TENANT_ID and `c.code`, so nothing this seeder ever created
    // falls outside the predicate. Same key seed-marketplace-i18n.ts resolves challenges by,
    // deliberately: two seeders keyed on different columns can disagree about which row is "the"
    // challenge, and then one of them localizes a row the other never wrote.
    const [existing] = await db
      .select({ id: challenges.id })
      .from(challenges)
      .where(and(eq(challenges.tenant_id, DEMO_TENANT_ID), eq(challenges.code, c.code)))
      .orderBy(asc(challenges.id))
      .limit(1);
    if (existing) {
      challengeIdByKey.set(c.key, existing.id);
      continue;
    }
    const [created] = await db
      .insert(challenges)
      .values({
        title: c.title,
        description: c.description,
        business_impact: c.businessImpact,
        work_area: c.workArea,
        submitter_id: author.id,
        // Phase 4 / D.1.1: the demo-org tenant (a pre-C.1 artifact previously stamped the author's
        // user id here, which RLS + 0028 normalised to the demo tenant). Stamp it directly so the
        // Discover board renders correctly once the runtime is scoped by the non-owner cp_app role.
        tenant_id: DEMO_TENANT_ID,
        status: c.status,
        week: winnerWeek,
        metrics: c.metrics,
        tags: c.tags,
        code: c.code,
        // ⛔ 0 IS NOT A PLACEHOLDER. This is the INSERT: the row does not exist until this
        // statement, so nothing can have voted on it and its real vote count is provably 0. The
        // live toggle takes it from there (castVote's ±1). `c.votes` is the fabrication.
        votes_count: fabricate ? c.votes : 0,
      })
      .returning({ id: challenges.id });
    challengeIdByKey.set(c.key, created!.id);
    challengesCreated++;
  }

  const claimsChallengeId = challengeIdByKey.get('claims');
  if (!claimsChallengeId) return { challenges: challengesCreated, solutions: 0, winners: 0 };

  // --- Lisa's linked Build flow (the 6 real blocks) ---
  const lisa = userIds.get('lisa')!;
  const blocks = await resolveBlocks(LISA_FLOW_SLUGS);
  const lisaGraph = buildLisaFlow(blocks);
  const lisaFlowName = "[demo] Lisa's claim-summary solution";
  let lisaFlowId: string | null = null;
  {
    const [existing] = await db
      .select({ id: flows.id })
      .from(flows)
      .where(and(eq(flows.owner_id, lisa.id), eq(flows.name, lisaFlowName)));
    if (existing) {
      lisaFlowId = existing.id;
    } else {
      const [created] = await db
        .insert(flows)
        .values({
          name: lisaFlowName,
          description: 'Auto-summarize claim forms — the winning Week 21 solution.',
          owner_id: lisa.id,
          tenant_id: DEMO_TENANT_ID,
          status: 'submitted',
          graph: lisaGraph,
          last_saved_at: new Date(),
        })
        .returning({ id: flows.id });
      lisaFlowId = created!.id;
    }
  }

  // --- solutions to challenge #1 (idempotent by challenge+title) ---
  const solutionIdByAuthor = new Map<string, string>();
  let solutionsCreated = 0;
  for (const s of SOLUTIONS) {
    const author = userIds.get(s.authorKey);
    if (!author) continue;
    // ⛔ NO TENANT PREDICATE HERE, ON PURPOSE — and `asc(solutions.id)` is doing the work the
    // tenant predicate does elsewhere in this file.
    //
    // `challenge_id` already pins the tenant transitively: `claimsChallengeId` was resolved above
    // inside DEMO_TENANT_ID, and a solution hangs off exactly one challenge. Adding
    // `eq(solutions.tenant_id, DEMO_TENANT_ID)` would NOT be a no-op, it would be a REGRESSION:
    // the winner block at the bottom of this function documents that this lookup deliberately
    // adopts legacy solutions stamped with the old per-USER tenants (`u-<hex>`), and derives the
    // weekly winner's tenant FROM the adopted row precisely so that adoption stays safe. Scoping
    // this SELECT would stop adopting them and INSERT a duplicate solution beside each one on
    // every boot — the exact row-doubling migration 0047 exists to heal.
    //
    // What WAS missing is determinism. `(challenge_id, title)` is backed by no unique index and
    // this file seeds five solutions onto one challenge, so a duplicate title returned a row in
    // heap order. `asc(solutions.id)` pins it: ids are uuidv7, so ascending id is oldest-first and
    // the originally-seeded row keeps winning instead of alternating with a later duplicate —
    // which matters because the row this returns is the one that gets `published_graph` and, via
    // `lisaSolutionId`, becomes the weekly winner. Same tie-break, same reason, as
    // seed-marketplace-i18n.ts's solution resolver.
    const [existing] = await db
      .select({ id: solutions.id, flowId: solutions.flow_id, publishedGraph: solutions.published_graph })
      .from(solutions)
      .where(and(eq(solutions.challenge_id, claimsChallengeId), eq(solutions.title, s.title)))
      .orderBy(asc(solutions.id))
      .limit(1);
    if (existing) {
      solutionIdByAuthor.set(s.authorKey, existing.id);
      if (s.linkFlow && lisaFlowId && (!existing.flowId || !existing.publishedGraph)) {
        await db.update(solutions).set({
          ...(!existing.flowId ? { flow_id: lisaFlowId } : {}),
          ...(!existing.publishedGraph ? {
            published_graph: lisaGraph,
            published_manifest: lisaGraph.nodes.map((node) => ({
              nodeId: node.id,
              blockId: node.blockId,
              versionId: node.blockVersionId,
              slug: node.slug,
              descriptor: blocks.get(node.slug)!.descriptor,
            })),
            published_hash: await graphContentHash(lisaGraph),
            published_at: new Date(),
            published_by: author.id,
          } : {}),
        }).where(eq(solutions.id, existing.id));
      }
      continue;
    }
    const [created] = await db
      .insert(solutions)
      .values({
        challenge_id: claimsChallengeId,
        tenant_id: DEMO_TENANT_ID,
        title: s.title,
        author_id: author.id,
        flow_id: s.linkFlow ? lisaFlowId : null,
        published_graph: s.linkFlow ? lisaGraph : null,
        published_manifest: s.linkFlow ? lisaGraph.nodes.map((node) => ({
          nodeId: node.id,
          blockId: node.blockId,
          versionId: node.blockVersionId,
          slug: node.slug,
          descriptor: blocks.get(node.slug)!.descriptor,
        })) : [],
        published_hash: s.linkFlow ? await graphContentHash(lisaGraph) : null,
        published_at: s.linkFlow ? new Date() : null,
        published_by: s.linkFlow ? author.id : null,
        status: s.status,
        week: winnerWeek,
        blocks_used: s.blocksUsed,
        // Same reasoning as the challenge INSERT above — and higher stakes: this column is the
        // first key of WINNER_ORDER, so a fabricated value here picks the winner.
        votes_count: fabricate ? s.votes : 0,
      })
      .returning({ id: solutions.id });
    solutionIdByAuthor.set(s.authorKey, created!.id);
    solutionsCreated++;
  }

  const lisaSolutionId = solutionIdByAuthor.get('lisa');

  // --- fixture comments (additive; genuine member comments survive every boot) ---
  const now = Date.now();
  for (let i = 0; i < COMMENTS.length; i++) {
    const c = COMMENTS[i]!;
    const author = userIds.get(c.authorKey);
    if (!author) continue;
    const [existing] = await db.select({ id: comments.id }).from(comments).where(and(
      eq(comments.challenge_id, claimsChallengeId),
      eq(comments.author_id, author.id),
      eq(comments.body, c.body),
    ));
    if (existing) continue;
    await db.insert(comments).values({
      challenge_id: claimsChallengeId,
      tenant_id: DEMO_TENANT_ID,
      author_id: author.id,
      body: c.body,
      created_at: new Date(now - (COMMENTS.length - i) * 6 * 3600_000),
    });
  }

  // --- weekly winner (idempotent per (tenant_id, week)) ---
  //
  // The tenant comes from the SOLUTION, never from DEMO_TENANT_ID. This block used to hardcode the
  // demo tenant, and on any database carrying pre-C.1 data that manufactured a CROSS-TENANT winner
  // row: the solution lookup above is idempotent by (challenge, title), so it happily adopts a
  // legacy row that lives in one of the old per-USER tenants (`u-<hex>`), and pairing that id with
  // a hardcoded demo tenant_id produces a winner whose solution belongs to somebody else.
  //
  // That row is precisely what migration 0047 exists to heal — and because the seed runs at every
  // backend BOOT, it re-created the row nine seconds after 0047 deleted it in production. Deriving
  // the tenant from the solution makes the heal durable and makes a cross-tenant winner
  // unrepresentable here rather than merely unlikely.
  let winnersCreated = 0;
  if (lisaSolutionId) {
    const [sol] = await db
      .select({ tenant_id: solutions.tenant_id })
      .from(solutions)
      .where(eq(solutions.id, lisaSolutionId));
    const winnerTenant = sol?.tenant_id ?? DEMO_TENANT_ID;
    // ⛔ GATED, and note WHAT is gated: `1207 / 17 / 9 / 11` is a hard-coded object literal, NOT a
    // sum of the votes_count values above. Clamping the counters therefore does nothing to it —
    // which is precisely how the winner screen ends up printing the live count and this frozen
    // total eight pixels apart (winner/+page.svelte:88-89) and contradicting itself. With
    // fabrication off, write what the CLOSE would have written: `periodSolutionStats`, the same
    // helper closeCycle stamps and marketplace-summary recomputes with, so the artifact and any
    // later recompute cannot disagree. Its two keys are also the whole predicate migration 0064
    // step 3 uses to tell a seeder artifact from a close-written one — `firstTimeBuilders` and
    // `crossDomain` are computable by nothing in this codebase, so their presence is the marker.
    const stats = fabricate
      ? { totalVotesCast: 1207, solutionsSubmitted: 17, firstTimeBuilders: 9, crossDomain: 11 }
      : await periodSolutionStats(winnerWeek, winnerTenant, db);
    const [w] = await db
      .insert(weeklyWinners)
      .values({
        week: winnerWeek,
        solution_id: lisaSolutionId,
        challenge_id: claimsChallengeId,
        tenant_id: winnerTenant,
        stats,
      })
      .onConflictDoNothing({ target: [weeklyWinners.tenant_id, weeklyWinners.week] })
      .returning({ id: weeklyWinners.id });
    if (w) winnersCreated++;
  }

  return { challenges: challengesCreated, solutions: solutionsCreated, winners: winnersCreated };
}
