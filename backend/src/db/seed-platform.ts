// src/db/seed-platform.ts — Session 6 platform-governance fidelity seed (demo.html
// Pipeline / Governance / Audit screens). Provisions:
//   • the 16 governance policies at the demo's displayed values — these are the LIVE
//     source of truth the runtime reads (broker caps/ceiling/model-allowlist, idle
//     sweep, the run-gate, the pipeline promotion gate). config.governance.* is only
//     the code-level fallback when a row is absent.
//     (This line read "14" until 2026-08-09. It was wrong: `data.egress_allowlist` and
//     `block_publish.require_passing_tests` were added to POLICIES without updating it,
//     and the stale count then propagated into downstream specs. Count is asserted in
//     tests/seed-fabrication-guard.test.ts, which spells the 16 keys out longhand.)
//   • the production-pipeline kanban mirroring the demo's 4 columns. Lisa's Week-21
//     winning solution is the featured ★ #CH-284 card (linked to her real solution),
//     so the winner screen's "Hardening · day 3 of 5" timeline reads REAL pipeline state.
//   • the demo's ~12 historical audit rows as a labelled fidelity baseline (metadata
//     {seed:true}); live actions append genuine rows on top (S4/S5 posture).
//
// Idempotent: policies by key (ON CONFLICT DO NOTHING — preserves live edits);
// pipeline skipped if Lisa's solution already has a card; policy_changes seeded only
// when empty; audit baseline = delete-where-seed then reinsert (live rows preserved).
//
// ⛔ FABRICATION GATE (config.seedFabricatedTelemetry, overridable per-call via
// `seedPlatform({ fabricate })`). Three of this file's writes do not describe the system, they
// ASSERT EVENTS THAT NEVER HAPPENED, and they ran on prod:
//   • `policy_changes` × 3 — "Tom Kemper raised the weekly ceiling €10 → €15 three days ago".
//     Tom made no such change; the governance change log was reading an invention.
//   • `pipeline_items` × 18 — invented card titles with `reviewed`/`reviewer_count`/`live:true`
//     and named authors, i.e. a claim that nine solutions shipped to production.
//   • `usage_events` × 42 (seedTenants) — 14 days of `anthropic`/`claude-sonnet-4-6` spend on a
//     deployment that holds no Anthropic key and routes every call to the local inference-router.
// `policies` is NOT gated: those rows are the live source of truth the broker cap, the model
// allowlist and the promotion gate read at runtime — configuration the system obeys, not a claim
// about the past. Same for `tenants` / `tenant_llm_settings` / `users.tenant_id` /
// `free_email_providers`: identity + configuration wiring.
// The scoped audit DELETE is also NOT gated — see the comment at the audit block.
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  db,
  users,
  solutions,
  policies,
  policyChanges,
  pipelineItems,
  auditLog,
  tenants,
  tenantLlmSettings,
  usageEvents,
  freeEmailProviders,
} from './client';
import { mintKey, listKeys } from '../services/mcp-api-key';
import { config, DEMO_TENANT_ID } from '../config';
import { providerCatalog } from '../ai/llm/provider-catalog';
import type { NewPolicy, PolicyValue } from './schema';
import { log } from '../host/logger';
// The pipeline board's week is DERIVED, never a literal — see `showcaseWeeks`. A hardcoded week
// makes seeded demo content read as months old the moment the calendar moves past it, which is the
// same staleness that emptied the challenge board.
import { showcaseWeeks } from './seed-marketplace';

const DEMO_TENANT_SLUG = 'common-practice-demo';
const DEMO_KEY_NAME = 'Seeded demo key';

// Derive the governance defaults from the provider catalog (the single source of truth for the
// tenant-admin LLM dropdowns) so the broker model-allowlist and connector egress-allowlist stay
// in sync with what tenants can actually pick. local-llm is in the catalog (the local preset);
// Anthropic's native host has no base_url in the catalog so it's added explicitly.
const CATALOG_MODELS = [...new Set(providerCatalog().flatMap((p) => p.models))];
const CATALOG_PROVIDER_HOSTS = [
  ...new Set([
    'api.anthropic.com',
    ...providerCatalog()
      .filter((p) => p.requiresKey && p.defaultBaseUrl)
      .map((p) => new URL(p.defaultBaseUrl!).hostname),
  ]),
];

// Common free / consumer mail providers (Phase 4 / C.2a). A signup from one of these is
// NEVER auto-routed to a tenant by email domain (held for explicit super_admin assignment),
// so corporate-domain routing (email_domain_tenants) doesn't accidentally swallow a personal
// address. Editable live via the super_admin onboarding screen.
const FREE_EMAIL_PROVIDERS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com',
  'yandex.com', 'pm.me', 'fastmail.com',
];

// ---- governance policies (the demo governance screen, verbatim values) ----
const POLICIES: NewPolicy[] = [
  // Data & isolation
  {
    key: 'data.block_prod_data',
    category: 'data_isolation',
    label: 'Block real production data from sandboxes',
    // ⛔ "prepared by the nightly job" WAS A FABRICATION and it shipped in all eight locales. There
    // is no nightly job for mock data: exactly four schedulers boot (audit export, marketplace
    // cycle, translation drainer, budget poller — server.ts), and `ctx.mockData()` is a
    // deterministic FNV-1a hash resolved INSIDE the runner (exec/mock-data.ts). What actually keeps
    // production data out is `run-backend.ts`'s `scrubbedEnv()`: the run process is started without
    // DATABASE_URL or any provider key. That is architecture, not this toggle — see
    // host/policy-enforcement.ts.
    description:
      'A run is started with a scrubbed environment — no database URL, no provider keys — so no production data is reachable from it. Sample data comes from ctx.mockData(), generated deterministically inside the runner.',
    control: 'toggle',
    value: true,
    sort: 10,
  },
  {
    key: 'data.pii_scrubbing',
    category: 'data_isolation',
    label: 'PII scrubbing on submitted material',
    description:
      'Personal data in uploaded material is masked before it can reach a block. PII-typed inputs may only be fed from a mock-data source.',
    control: 'toggle',
    value: true,
    sort: 20,
  },
  {
    key: 'data.cross_sandbox_isolation',
    category: 'data_isolation',
    label: 'Cross-sandbox isolation',
    description:
      'Every run gets its own operating-system process, started fresh and torn down afterwards. There is no shared state for one sandbox to read out of another.',
    control: 'toggle',
    value: true,
    sort: 30,
  },
  {
    // ⛔ RETIRED CLAIM — STILL SEEDED ON PURPOSE. `policy_changes.policy_key` is a foreign key onto
    // `policies.key` with ON DELETE CASCADE, so dropping this row would delete every recorded change
    // ever made against it. It is classified `'retired'` in host/policy-enforcement.ts, is no longer
    // parsed into the GovernanceSnapshot, and the PATCH route refuses to write it. It is seeded so
    // the FK target exists and so an auditor reading an old change log still finds the rail it names.
    key: 'data.eu_only',
    category: 'data_isolation',
    label: 'EU-only execution',
    description:
      'Withdrawn. No residency check exists anywhere in the platform: sandboxes.region is recorded but never compared, and the seeded provider endpoints are public-internet hosts outside the EU.',
    control: 'toggle',
    value: true,
    sort: 40,
  },
  {
    key: 'data.validation_mode',
    category: 'data_isolation',
    label: 'Validate injected data against the ontology',
    description:
      'Before a run, a dataset bound to an ontology entity is checked: each mapped column’s values must match the entity attribute’s type, and a PII attribute must map to a column that gets redacted. "block" refuses the run (422); "warn" records a finding and proceeds.',
    control: 'select',
    value: 'warn',
    options: ['warn', 'block'],
    sort: 50,
  },
  // Spend & quotas
  {
    key: 'spend.daily_llm_cap',
    category: 'spend_quota',
    label: 'Per-user daily LLM call cap',
    description:
      'The metered LLM broker rejects a call once a user passes this many calls in a day.',
    control: 'number',
    value: 50,
    unit: 'calls/day',
    sort: 10,
  },
  {
    key: 'spend.weekly_spend_ceiling',
    category: 'spend_quota',
    label: 'Per-user weekly spend ceiling',
    description:
      'The broker rejects a call once a user’s rolling 7-day brokered spend reaches this ceiling.',
    control: 'number',
    value: 15,
    // ⛔ '$', NOT '€'. This unit is a LABEL on a number the broker enforces in DOLLARS: every
    // per-token rate in the system is USD (`LLM_IN_RATE_USD`/`LLM_OUT_RATE_USD`, the vendor list
    // prices in `provider-catalog.ts`, `usage_events.cost_usd`), `reserveCall` compares this value
    // against a USD sum, and the rejection it raises reads `weekly spend ceiling reached ($15)`.
    // Seeding '€' made the Governance screen the only place in the product that called those same
    // 15 units euros. Nothing converted anything — it was a mislabel, not a currency bug, which is
    // exactly why it survived: no arithmetic ever disagreed with it.
    // ⚠ ON CONFLICT DO NOTHING (see seedPlatform) — this fixes new databases only. A deployment
    // that already seeded the row keeps '€' until an operator edits it on the Governance screen;
    // there is no reconciler for policy metadata.
    unit: '$',
    sort: 20,
  },
  {
    key: 'spend.auto_suspend_idle',
    category: 'spend_quota',
    label: 'Auto-suspend idle sandboxes after',
    description:
      'The idle-sweep watchdog suspends any sandbox with no activity for longer than this window.',
    control: 'select',
    value: '7 days',
    options: ['3 days', '7 days', '14 days'],
    sort: 30,
  },
  // Models & tools
  {
    key: 'models.allowlist',
    category: 'models_tools',
    label: 'Allowlisted models',
    description:
      'The broker refuses any model not on this list before it ever reaches a provider.',
    control: 'list',
    // Derived from the provider catalog so every model a tenant can select is governed by the
    // same allowlist (local-llm + the curated Anthropic/OpenAI/DeepSeek/Grok/Cohere ids).
    value: CATALOG_MODELS,
    sort: 10,
  },
  {
    key: 'models.external_http',
    category: 'models_tools',
    label: 'External HTTP from sandboxes',
    description:
      'When off, a run that uses a network-capable block is refused at submit time (the runner also strips fetch).',
    control: 'toggle',
    value: false,
    sort: 20,
  },
  {
    key: 'models.code_exec_outside_blocks',
    category: 'models_tools',
    label: 'Code execution outside building blocks',
    // ⛔ "banned at save time and refused at run time" WAS FALSE IN BOTH HALVES. Nothing reads
    // `codeExecOutsideBlocks` anywhere, so no save and no run has ever been refused because of it.
    // What is true is narrower and worth saying precisely: a FLOW RUN executes pinned, published
    // block versions, while the authoring tools deliberately run the draft you are editing.
    description:
      'A flow run executes published building blocks only. The authoring tools — testing a block, simulating a flow — deliberately run the draft source you are editing.',
    control: 'toggle',
    value: false,
    sort: 30,
  },
  {
    key: 'data.egress_allowlist',
    category: 'models_tools',
    label: 'Connector egress allowlist',
    description:
      'Read-only data connectors (Postgres / storage / HTTP) may only reach hosts on this list (host or host:port). Empty = no external host is reachable. External HTTP must also be enabled, and private/loopback IPs are always refused (SSRF guard).',
    control: 'list',
    // The tenant LLM cloud-provider hosts (so a tenant BYO-key path can reach them once an
    // operator turns external HTTP on). External HTTP must still be enabled and the SSRF guard
    // always refuses private/loopback IPs. Add data-connector hosts here too as needed.
    value: CATALOG_PROVIDER_HOSTS,
    sort: 40,
  },
  // Promotion to production
  {
    key: 'promotion.mandatory_review',
    category: 'promotion',
    label: 'Mandatory code review for winning solutions',
    description:
      'A pipeline card cannot enter Production until it has been marked reviewed by the platform team.',
    control: 'toggle',
    value: true,
    sort: 10,
  },
  {
    key: 'promotion.required_reviewers',
    category: 'promotion',
    label: 'Required reviewers',
    description: 'Minimum number of reviewers a card needs before it can ship to Production.',
    control: 'select',
    value: '2',
    options: ['1', '2', '3'],
    sort: 20,
  },
  {
    key: 'promotion.staging_canary_pct',
    category: 'promotion',
    label: 'Staging canary percent',
    description: 'The initial rollout percentage a card receives when it enters Staging.',
    control: 'number',
    value: 5,
    unit: '%',
    sort: 30,
  },
  {
    // Phase 2-B: gates publishing a block version to `stable` on its per-block tests.
    key: 'block_publish.require_passing_tests',
    category: 'promotion',
    label: 'Require passing tests to publish a block',
    description:
      'A block version cannot be published to stable until it has at least one enabled test and all of its tests pass (re-run at publish).',
    control: 'toggle',
    value: true,
    sort: 40,
  },
  // 0107: the marketplace voting-cycle cadence. In a real deployment the row already exists when
  // the seed runs: server.ts calls `ensureCadencePolicy()` (host/cycle-cadence.ts) BEFORE seeding,
  // with the value CYCLE_ENABLED bootstraps — and ON CONFLICT DO NOTHING keeps that. This literal is
  // what a seed-only database (dev, CI) gets: the weekly cadence production runs. Keep its label,
  // description and options identical to `CADENCE_POLICY_ROW` (asserted in cycle-cadence.test.ts).
  {
    key: 'cycle.cadence',
    category: 'marketplace',
    label: 'Voting cycle',
    description:
      'How often challenges are voted on and a winner is chosen: weekly, monthly, quarterly, yearly, or off. Off keeps votes as a ranking with no winners. A change starts at the next period.',
    control: 'select',
    value: 'week',
    options: ['off', 'week', 'month', 'quarter', 'year'],
    sort: 10,
  },
];

// ---- pipeline cards (mirror the demo's 4 columns: 3 / 4 / 2 / 9) ----
// Lisa's winning solution is the featured ★ #CH-284 card in Hardening, day 3 of 5
// — solution-linked so the winner screen reads real pipeline state. The rest are
// cosmetic fidelity cards (labelled): the demo's named authors aren't all seeded.
//
// ⛔ ALL 18 are fabrication-gated (see the file header) and NONE of them carries a review claim
// any more. `reviewed` / `reviewerCount` were dropped from this fixture outright: they are the
// record of a human having reviewed the card and of how many people signed off, and no human
// ever did. The promotion gate (promotion.mandatory_review + promotion.required_reviewers) reads
// exactly those columns, so a seeded `reviewed: true, reviewer_count: 2` did not merely display a
// falsehood — it pre-satisfied the review gate for a card nobody reviewed. The columns default
// to `false` / `0` in the schema; a card earns them through the PATCH route, which also stamps
// `reviewed_by` / `reviewed_at`, and that is the only way they should ever become true.
interface CardSeed {
  title: string;
  stage: 'review' | 'hardening' | 'staging' | 'production';
  position: number;
  authorKey?: string;
  lisaSolution?: boolean;
  featured?: boolean;
  progress?: { day: number; ofDays: number };
  rolloutPct?: number;
  live?: boolean;
  /** When a live card was created and how long it took to ship, in minutes.
   *
   *  ⛔ REQUIRED ON EVERY `live: true` FIXTURE. The seeder used to insert `live: true` and never
   *  stamp `live_at`, so all nine Production fixtures had a NULL ship timestamp. That is why every
   *  dev and CI database reproduced the /pipeline contradiction — "avg time to live —, none live
   *  yet" sitting beside "in production 9, live now" — and why a metrics test written against a
   *  seeded DB is so easy to write vacuously: with no `live_at` anywhere, the average is computed
   *  over the empty set and every assertion about it holds trivially.
   *
   *  The spread is deliberate and must keep BOTH ends: at least one SUB-DAY interval (a 41-minute
   *  ship is the real production interval, and it is the case the old whole-days rounding erased)
   *  and at least one MULTI-DAY one. A fixture set that is all-multi-day cannot distinguish a
   *  correct duration from `Math.round(x / DAY_MS)`. */
  shipped?: { createdDaysAgo: number; tookMins: number };
}

const CARDS: CardSeed[] = [
  // In review (3)
  { title: 'Plain-language policy explainer', stage: 'review', position: 0, authorKey: 'hannah' },
  { title: 'Churn-signal segment digest', stage: 'review', position: 1, authorKey: 'lisa' },
  { title: 'Contract-change compliance checker', stage: 'review', position: 2, authorKey: 'bart' },
  // Hardening (4) — Lisa's featured winner
  {
    title: 'Auto-summarize claim forms',
    stage: 'hardening',
    position: 0,
    authorKey: 'lisa',
    lisaSolution: true,
    featured: true,
    progress: { day: 3, ofDays: 5 },
  },
  { title: 'Streaming summarizer with PDF OCR', stage: 'hardening', position: 1, authorKey: 'moa', progress: { day: 5, ofDays: 7 } },
  { title: 'Inline review UI for Claims', stage: 'hardening', position: 2, authorKey: 'hannah', progress: { day: 2, ofDays: 4 } },
  { title: 'Email auto-categorize router', stage: 'hardening', position: 3, authorKey: 'fatima', progress: { day: 1, ofDays: 3 } },
  // Staging · canary (2)
  { title: 'Multi-doc compare with audit trail', stage: 'staging', position: 0, authorKey: 'peter', rolloutPct: 8 },
  { title: 'No-code Power Automate variant', stage: 'staging', position: 1, authorKey: 'karim', rolloutPct: 12 },
  // Production (9) — all live, each with an explicit created_at → live_at interval (see `shipped`).
  // The spread runs from 41 minutes to 9 days on purpose: minutes, hours, just-over-a-day and
  // several-days are all represented, so the board exercises every branch of the duration
  // formatter rather than only the one that whole-day rounding happens to survive.
  { title: 'Policy compare assistant', stage: 'production', position: 0, authorKey: 'jeremy', live: true, rolloutPct: 100, shipped: { createdDaysAgo: 40, tookMins: 41 } },
  { title: 'Claims triage summarizer', stage: 'production', position: 1, authorKey: 'demoOwner', live: true, rolloutPct: 100, shipped: { createdDaysAgo: 35, tookMins: 190 } },
  { title: 'Fraud-signal flagger', stage: 'production', position: 2, authorKey: 'peter', live: true, rolloutPct: 100, shipped: { createdDaysAgo: 30, tookMins: 1560 } },
  { title: 'Customer-record lookup helper', stage: 'production', position: 3, authorKey: 'moa', live: true, rolloutPct: 100, shipped: { createdDaysAgo: 25, tookMins: 2880 } },
  { title: 'OCR scan normalizer', stage: 'production', position: 4, authorKey: 'karim', live: true, rolloutPct: 100, shipped: { createdDaysAgo: 21, tookMins: 6120 } },
  { title: 'Anomaly review panel', stage: 'production', position: 5, authorKey: 'hannah', live: true, rolloutPct: 100, shipped: { createdDaysAgo: 17, tookMins: 8640 } },
  { title: 'Document field extractor', stage: 'production', position: 6, authorKey: 'lisa', live: true, rolloutPct: 100, shipped: { createdDaysAgo: 13, tookMins: 12960 } },
  { title: 'Format-output templater', stage: 'production', position: 7, authorKey: 'jeremy', live: true, rolloutPct: 100, shipped: { createdDaysAgo: 9, tookMins: 660 } },
  { title: 'Classifier for service tickets', stage: 'production', position: 8, authorKey: 'fatima', live: true, rolloutPct: 100, shipped: { createdDaysAgo: 5, tookMins: 5040 } },
];

/** The 18 fabricated card titles, exported so the one-shot purge (scripts/purge-fabricated-history.ts)
 *  can assert every row it is about to delete from `pipeline_items` came out of THIS fixture, rather
 *  than hard-coding a second copy of the list that could drift away from the seeder it describes. */
export const FABRICATED_CARD_TITLES: readonly string[] = CARDS.map((c) => c.title);

// ---- audit baseline (the demo's audit feed, ~12 rows) ----
interface AuditSeed {
  minsAgo: number;
  actorKey?: string; // omitted → System
  action: string;
  category: string;
  targetType: string;
  targetId: string;
  result: string;
  tone: 'ok' | 'warn' | 'error';
}

const AUDIT: AuditSeed[] = [
  { minsAgo: 4, actorKey: 'lisa', action: 'sandbox.run', category: 'sandbox', targetType: 'flow', targetId: 'lisa-vermeer-7c4d / flow#0.4', result: 'Success · 2.31s', tone: 'ok' },
  { minsAgo: 9, actorKey: 'moa', action: 'block.publish', category: 'block', targetType: 'block', targetId: 'ocr-scan@1.2', result: 'Approved by Tom K.', tone: 'ok' },
  { minsAgo: 16, actorKey: 'tom', action: 'deploy.staging', category: 'deploy', targetType: 'solution', targetId: 'solution#CH-284 → staging · 5% canary', result: 'Healthy', tone: 'ok' },
  { minsAgo: 31, actorKey: 'fatima', action: 'sandbox.error', category: 'sandbox', targetType: 'flow', targetId: 'fatima-hassani-8d2c / read-pdf', result: 'Parse failure · auto-ticketed', tone: 'error' },
  { minsAgo: 43, actorKey: 'demoOwner', action: 'challenge.submit', category: 'block', targetType: 'challenge', targetId: 'CH-284 · "Auto-summarize claim forms"', result: 'Published to voting', tone: 'ok' },
  { minsAgo: 69, actorKey: 'tom', action: 'policy.change', category: 'policy', targetType: 'policy', targetId: 'spend.weekly · €10 → €15', result: 'Applied', tone: 'warn' },
  { minsAgo: 95, actorKey: 'jeremy', action: 'sandbox.provision', category: 'sandbox', targetType: 'sandbox', targetId: 'jeremy-dewit-5c7e', result: 'Ready in 4.2s', tone: 'ok' },
  { minsAgo: 110, action: 'data.refresh', category: 'system', targetType: 'dataset', targetId: 'mock-data nightly · claims dataset', result: '4,820 records · 38s', tone: 'ok' },
  { minsAgo: 142, actorKey: 'hannah', action: 'solution.submit', category: 'block', targetType: 'solution', targetId: 'SOL-339 → CH-284', result: 'In voting', tone: 'ok' },
  { minsAgo: 168, actorKey: 'tom', action: 'block.deprecate', category: 'block', targetType: 'block', targetId: 'old-pdf-parse@1.4 → deprecated', result: '3 active users notified', tone: 'warn' },
  { minsAgo: 185, actorKey: 'karim', action: 'auth.login', category: 'auth', targetType: 'session', targetId: 'SSO · Azure AD · IP NL', result: 'OK', tone: 'ok' },
  { minsAgo: 204, action: 'quota.warn', category: 'system', targetType: 'user', targetId: 'peter-janssen-9e11 · 80% of daily LLM calls', result: 'User notified', tone: 'warn' },
];

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
  tom: 'tom@commonpractice.local', // seeded as a block maintainer in seed.ts
};

async function resolveUsers(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const [key, email] of Object.entries(EMAIL)) {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    if (u) out.set(key, u.id);
  }
  return out;
}

const minsAgo = (now: number, m: number) => new Date(now - m * 60_000);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Phase 4 / D.1.1: create the shared demo-org tenant row up front (idempotent). seedAll calls this
 * FIRST so every tenant-scoped sub-seed (flows / sandboxes / runs / marketplace) can stamp the demo
 * tenant_id and satisfy its FK + the NOT NULL constraint (migration 0029). seedTenants still runs
 * later to set users.tenant_id + the demo's LLM/MCP/usage_events extras (its tenant insert no-ops).
 */
export async function ensureDemoTenant(): Promise<void> {
  await db
    .insert(tenants)
    .values({
      id: DEMO_TENANT_ID,
      name: 'Common Practice Demo',
      slug: DEMO_TENANT_SLUG,
      industry: 'insurance',
    })
    .onConflictDoNothing({ target: tenants.id });
}

/** Tenants seed (Phase 4 / C.1 — single-tenant-per-identity). All seeded users belong to
 *  ONE shared DEMO ORG tenant (the fixed id DEMO_TENANT_ID, so dev-bypass / tests / the
 *  live super_admin agree); their `users.tenant_id` home tenant is set to it. There is no
 *  personal tenant and no membership table. Roles come from realm roles (AUTH_BYPASS in
 *  dev; the portal realm live) — the seed does NOT write Keycloak roles (that's C.2). The
 *  demo tenant carries a tenant-scoped LLM setting, one (unusable) listed MCP key, and a
 *  spread of usage_events so the dashboard renders. */
async function seedTenants(
  userIds: Map<string, string>,
  fabricate: boolean,
): Promise<{ tenants: number; usageEvents: number }> {
  let tenantsCreated = 0;

  // --- the shared demo org tenant (fixed id) ---
  const tomId = userIds.get('tom');
  const lisaId = userIds.get('lisa');
  if (!tomId) return { tenants: tenantsCreated, usageEvents: 0 };

  const demoTenantId = DEMO_TENANT_ID;
  const res = await db
    .insert(tenants)
    .values({
      id: demoTenantId,
      name: 'Common Practice Demo',
      slug: DEMO_TENANT_SLUG,
      industry: 'insurance',
    })
    .onConflictDoNothing({ target: tenants.id })
    .returning({ id: tenants.id });
  if (res.length) tenantsCreated++;
  // Phase 3.4: backfill the industry on an already-seeded demo tenant so the agent's
  // (industry × department) cell resolves to a real cell. Idempotent (only sets if null).
  await db
    .update(tenants)
    .set({ industry: 'insurance' })
    .where(and(eq(tenants.id, demoTenantId), isNull(tenants.industry)));

  // Every seeded user's home tenant is the demo org (single-tenant model). Idempotent:
  // only set where unset, so a later real claim isn't clobbered.
  const allUserIds = (await db.select({ id: users.id }).from(users)).map((u) => u.id);
  if (allUserIds.length) {
    await db
      .update(users)
      .set({ tenant_id: demoTenantId })
      .where(and(inArray(users.id, allUserIds), isNull(users.tenant_id)));
  }

  // The honest platform default for the demo tenant: the in-cluster inference-router (local-llm)
  // at temp 0.1 — NOT a hosted Claude model (CP brokers locally unless a tenant BYOs a key).
  // Matches seed-ai.ts + the 0035 backfill; onConflictDoNothing never clobbers an existing row.
  await db
    .insert(tenantLlmSettings)
    .values({
      tenant_id: demoTenantId,
      provider: 'openai_compatible',
      model: 'local-llm',
      base_url: config.llm.openaiBaseUrl || null,
      temperature: 0.1,
    })
    .onConflictDoNothing({ target: tenantLlmSettings.tenant_id });

  // One listed-but-UNUSABLE MCP key: minted with a random secret that is discarded, so
  // the key renders in the UI (prefix/last-used) without exposing a usable raw value.
  const existingKeys = await listKeys(demoTenantId);
  if (!existingKeys.some((k) => k.name === DEMO_KEY_NAME)) {
    await mintKey({ tenantId: demoTenantId, issuedBy: tomId, name: DEMO_KEY_NAME });
  }

  // --- usage_events spread so the spend dashboard isn't empty (idempotent) ---
  // ⛔ FABRICATED — gated. These 42 rows claim 14 days of `anthropic`/`claude-sonnet-4-6` calls at
  // invented per-call costs, on a deployment that holds no Anthropic key at all and brokers every
  // call to the in-cluster inference-router. The 14-day spend chart was not merely stale: it
  // attributed cost to a provider that was never called. Same reasoning (and same numbers) as the
  // showcase seeder's usage_events block — see seed-tenant-showcase.ts.
  //
  // No scoped delete to keep un-gated here, unlike the audit baseline below: these rows carry no
  // seed marker of their own (the `seed_key` column exists but this seeder never set it), so there
  // is no predicate that provably selects only this seeder's own output. Cleaning up the rows it
  // already wrote on prod is the purge script's job (scripts/purge-fabricated-history.ts), not a
  // guess made at boot.
  const usageRows = (await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM usage_events WHERE tenant_id = ${demoTenantId}`,
  )) as unknown as { n: number }[];
  let usageCreated = 0;
  if (fabricate && (usageRows[0]?.n ?? 0) === 0) {
    const now = Date.now();
    const models = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6', tIn: 1200, tOut: 380, cost: 0.018 },
      { provider: 'anthropic', model: 'claude-haiku-4-5', tIn: 800, tOut: 210, cost: 0.004 },
    ];
    const members = lisaId ? [tomId, lisaId] : [tomId];
    const events: (typeof usageEvents.$inferInsert)[] = [];
    // ~3 calls/day over the last 14 days, alternating model + member.
    for (let day = 0; day < 14; day++) {
      for (let k = 0; k < 3; k++) {
        const m = models[(day + k) % models.length]!;
        const uid = members[(day + k) % members.length]!;
        events.push({
          tenant_id: demoTenantId,
          user_id: uid,
          provider: m.provider,
          model: m.model,
          tokens_in: m.tIn,
          tokens_out: m.tOut,
          cost_usd: String(m.cost),
          created_at: new Date(now - (day * 24 * 60 + k * 90) * 60_000),
        });
      }
    }
    await db.insert(usageEvents).values(events);
    usageCreated = events.length;
  } else if (!fabricate) {
    log.info('seed_platform_usage_events_skipped', { component: 'seed', reason: 'fabrication_off' });
  }

  // The free-email blocklist for onboarding auto-routing (idempotent). No tenant link.
  await db
    .insert(freeEmailProviders)
    .values(FREE_EMAIL_PROVIDERS.map((domain) => ({ domain })))
    .onConflictDoNothing({ target: freeEmailProviders.domain });

  return { tenants: tenantsCreated, usageEvents: usageCreated };
}

/** Per-call override for the fabrication gate. Exists so the gate is TESTABLE: `config.ts` sets
 *  `seedFabricatedTelemetry` true whenever NODE_ENV !== 'production', so every CI run — and every
 *  test that does not say otherwise — exercises the UN-gated branch. A test asserting the gate
 *  MUST pass `{ fabricate: false }` explicitly; reading the config would make it assert nothing.
 *  Same injectable-seam style as `database: Db = defaultDb` elsewhere in the repo. */
export interface SeedPlatformOpts {
  fabricate?: boolean;
}

export async function seedPlatform(opts: SeedPlatformOpts = {}): Promise<{
  policies: number;
  pipeline: number;
  audit: number;
  tenants: number;
  usageEvents: number;
}> {
  const fabricate = opts.fabricate ?? config.seedFabricatedTelemetry;
  const userIds = await resolveUsers();

  // --- policies (idempotent by key; preserves live edits) ---
  // ⛔ DELIBERATELY UN-GATED. A policy row is not a claim about the past — it is the live value
  // the broker reads for the daily cap and weekly ceiling, the model allowlist it refuses calls
  // against, and the reviewer minimum the promotion gate enforces. `config.governance.*` is only
  // the fallback when a row is ABSENT, so gating these would silently change enforcement on a
  // fabrication-off boot. Configuration seeds; history does not.
  let policiesCreated = 0;
  for (const p of POLICIES) {
    const res = await db
      .insert(policies)
      .values(p)
      .onConflictDoNothing({ target: policies.key })
      .returning({ key: policies.key });
    if (res.length) policiesCreated++;
  }

  // --- policy_changes (the 3 demo "Recent changes"); only when empty ---
  // ⛔ FABRICATED — gated. Each row names a real person (`changed_by` = Tom's user id) as having
  // made a governance change on a specific date. Tom made none of them. This is the governance
  // change log — the screen an auditor opens to ask "who raised the spend ceiling, and when" —
  // and it was answering with an invention. No scoped delete to keep un-gated: these rows carry
  // no seed marker, so no predicate provably selects only this seeder's output. The rows already
  // on prod are the purge script's job (scripts/purge-fabricated-history.ts).
  const pcRows = (await db.execute(
    sql`SELECT COUNT(*)::int AS count FROM policy_changes`,
  )) as unknown as { count: number }[];
  if (fabricate && (pcRows[0]?.count ?? 0) === 0) {
    const tom = userIds.get('tom') ?? null;
    const now = Date.now();
    await db.insert(policyChanges).values([
      { policy_key: 'spend.weekly_spend_ceiling', old_value: 10, new_value: 15, changed_by: tom, created_at: minsAgo(now, 3 * 24 * 60) },
      { policy_key: 'models.allowlist', old_value: ['claude-sonnet-4-6', 'claude-haiku-4-5'] as PolicyValue, new_value: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'] as PolicyValue, changed_by: tom, created_at: minsAgo(now, 7 * 24 * 60) },
      { policy_key: 'promotion.required_reviewers', old_value: '1', new_value: '2', changed_by: tom, created_at: minsAgo(now, 14 * 24 * 60) },
    ]);
  } else if (!fabricate) {
    log.info('seed_platform_policy_changes_skipped', { component: 'seed', reason: 'fabrication_off' });
  }

  // --- pipeline cards (skip if Lisa's solution already has a card) ---
  // ⛔ FABRICATED — gated, all 18. The board asserts that nine named people shipped nine solutions
  // to production (`live: true`, 100% rollout) in week 2026-W21 and that two more are canarying in
  // staging. None of it happened. The `reviewed`/`reviewer_count` claims are gone from the fixture
  // entirely (see CardSeed above) — that pair is what the promotion gate reads, so seeding it true
  // pre-satisfied the gate. Lisa's anchor card is gated with the rest: its `progress: {day 3 of 5}`
  // is rendered verbatim by the winner screen, which makes it a fabricated measurement even though
  // the solution it links to is real.
  // ⛔ TENANT-SCOPED + ORDERED. `solutions.title` carries no uniqueness the database enforces, so
  // an unscoped `.where(title = …)` picked whichever row Postgres handed back first — heap order —
  // and the anchor card would then point at another tenant's solution, or at a different row on the
  // next run. Same defect class, and the same fix, as seed-marketplace-i18n.ts (see its header):
  // scope to the tenant this seeder writes, and pin the tie-break. `asc(id)` is oldest-first
  // because ids are uuidv7.
  const [lisaSolution] = await db
    .select({ id: solutions.id })
    .from(solutions)
    .where(
      and(
        eq(solutions.tenant_id, DEMO_TENANT_ID),
        eq(solutions.title, 'GPT flow with policy context in 7 steps'),
      ),
    )
    .orderBy(asc(solutions.id))
    .limit(1);
  const lisaSolutionId = lisaSolution?.id ?? null;

  let pipelineCreated = 0;
  const anchored = lisaSolutionId
    ? await db.select({ id: pipelineItems.id }).from(pipelineItems).where(eq(pipelineItems.solution_id, lisaSolutionId))
    : [];
  if (fabricate && anchored.length === 0) {
    const seedNow = Date.now();
    // Same derivation the marketplace seed uses, so the pipeline board and the winner story agree.
    const pipelineWeek = showcaseWeeks(new Date(seedNow)).winnerWeek;
    for (const c of CARDS) {
      // A live card gets BOTH ends of its interval stamped. `created_at` has a DB default, so it
      // is only overridden when there is a `live_at` to measure from — the alternative (a default
      // `now()` created_at beside a backdated live_at) yields a NEGATIVE time-to-live.
      const createdAt = c.shipped ? new Date(seedNow - c.shipped.createdDaysAgo * DAY_MS) : null;
      const liveAt = c.shipped ? new Date(createdAt!.getTime() + c.shipped.tookMins * 60_000) : null;
      await db.insert(pipelineItems).values({
        title: c.title,
        solution_id: c.lisaSolution ? lisaSolutionId : null,
        author_id: c.authorKey ? (userIds.get(c.authorKey) ?? null) : null,
        stage: c.stage,
        week: pipelineWeek,
        rollout_pct: c.rolloutPct ?? 0,
        progress: c.progress ?? null,
        featured: c.featured ?? false,
        live: c.live ?? false,
        position: c.position,
        ...(createdAt ? { created_at: createdAt, live_at: liveAt } : {}),
      });
      pipelineCreated++;
    }
  } else if (!fabricate) {
    log.info('seed_platform_pipeline_items_skipped', { component: 'seed', reason: 'fabrication_off' });
  }

  // --- audit baseline (delete seeded rows, reinsert; live rows preserved) ---
  // ⛔ The scoped DELETE always runs; only the REINSERT is gated. Keeping the delete un-gated is
  // deliberate and is the #208 precedent (seed-tenant-showcase.ts:526-533 / :556-563): the
  // predicate is `metadata @> {"seed":true}`, a marker only this seeder ever writes, so it touches
  // exclusively rows this seeder itself invented. A fabrication-off boot therefore CLEANS UP ITS
  // OWN PAST OUTPUT instead of leaving twelve invented entries stranded in the audit trail forever.
  // Live rows (which carry no such marker) are untouched either way.
  //
  // Why the reinsert is fabrication: each row asserts a person did something at a time with a
  // result — "Mo published ocr-scan@1.2, approved by Tom K., 9 minutes ago". None of it happened.
  // An audit trail that contains invented entries is not a weaker audit trail; it is not one.
  await db.delete(auditLog).where(sql`metadata @> '{"seed":true}'::jsonb`);
  const now = Date.now();
  let auditCreated = 0;
  if (fabricate) {
    for (const a of AUDIT) {
      await db.insert(auditLog).values({
        actor_id: a.actorKey ? (userIds.get(a.actorKey) ?? null) : null,
        action: a.action,
        category: a.category,
        target_type: a.targetType,
        target_id: a.targetId,
        result: a.result,
        result_tone: a.tone,
        metadata: { seed: true },
        created_at: minsAgo(now, a.minsAgo),
      });
      auditCreated++;
    }
  } else {
    log.info('seed_platform_audit_log_skipped', { component: 'seed', reason: 'fabrication_off' });
  }

  const tenantSeed = await seedTenants(userIds, fabricate);

  return {
    policies: policiesCreated,
    pipeline: pipelineCreated,
    audit: auditCreated,
    tenants: tenantSeed.tenants,
    usageEvents: tenantSeed.usageEvents,
  };
}
