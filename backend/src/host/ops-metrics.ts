// src/host/ops-metrics.ts — the platform Ops dashboard aggregates (Session 4,
// demo.html it-dash). Every number is a REAL aggregate over flow_runs / sandboxes
// / usage_counters (seed + live), not a fabricated headline:
//   * stats      — active sandboxes, today's LLM calls + spend, 24h P95 latency
//   * health     — 24 fixed hourly buckets (runs/hr + llm-calls/hr) for the sparkline
//   * topBlocks  — most-used blocks this week, counted from node_success trace events
//   * attention  — derived alerts (error sandboxes, high P95, repeated block errors)
//   * events     — recent platform activity (block publishes, runs, suspensions)
import { sql } from 'drizzle-orm';
import { db, buildingBlocks } from '../db/client';
import { and, inArray, isNull } from 'drizzle-orm';

const P95_LATENCY_ALERT_MS = 2000;
const MIN_RUNS_FOR_P95 = 5;

/**
 * The look-back window for the "this block keeps failing" alert.
 *
 * ⛔ ONE CONSTANT, TWO USES. This number appears in the SQL `WHERE finished_at >= now() - …` AND
 * in the sentence the operator reads ("… in the last 7 days"). They were two independent `7`
 * literals five lines apart; widening the query to 14 days without editing the copy would have
 * produced an alert that lies about its own window, and nothing would have caught it. Both now
 * read this. The frontend gets it on the wire as `windowDays` for the same reason — its catalog
 * message interpolates the number rather than spelling it out in eight languages.
 */
const BLOCK_ERROR_WINDOW_DAYS = 7;

/** The ≤N owners sampled for a `sandbox_error` alert. NOT the count — see `getAttention`. */
const SANDBOX_ERROR_OWNER_SAMPLE = 5;

export interface DashboardStats {
  activeSandboxes: number;
  dailyLlmCalls: number;
  spendTodayUsd: number;
  p95LatencyMs: number | null;
}
export interface HealthBucket {
  hourTs: string;
  activeRuns: number;
  llmCalls: number;
}
export interface TopBlock {
  slug: string;
  /** The PLATFORM block's human name, for the "Most used blocks" bar labels — which rendered the
   *  raw kebab-case `slug` in a mono font. NULLABLE, and the null case is REAL, not defensive.
   *  TWO ways it is null, both ordinary:
   *    • `getTopBlocks` derives its slugs from `flow_runs.trace` events, so a block that has since
   *      been deleted or renamed produces a slug with no `building_blocks` row at all.
   *    • the slug is owned by a TENANT and not by the platform. /it-dash is fleet-wide, so it
   *      resolves only `tenant_id IS NULL` rows — see the guard in `getTopBlocks`.
   *  Every reader must fall back to `slug`. */
  name: string | null;
  category: string | null;
  count: number;
  pct: number;
}
/**
 * ⛔ `title` / `detail` / `text` ARE NOT DEAD FIELDS. DO NOT DELETE THEM WITH THIS CHANGE.
 *
 * They are ENGLISH prose composed on a server that does not know — and must not know — who is
 * reading. That is the defect this change exists to remove: /it-dash rendered them raw inside a
 * Dutch frame. The words now belong to the browser, which reads the MACHINE fields below and
 * picks a catalog message.
 *
 * They stay populated, and byte-identical to what this file shipped before, for exactly one
 * deploy. The two containers share a pod, but the browser reaches the API through the k8s
 * SERVICE, which load-balances across old and new pods for the length of a rolling deploy — so
 * the OLD frontend, which renders `item.title` directly and knows nothing about `errorCount`,
 * really is answered by a NEW pod. Blanking these fields now blanks the alert panel of every
 * still-running old tab. That exact hazard blanked /governance (PR #233, second commit).
 *
 * TODO(one deploy after the i18n frontend is fully rolled out): delete `title`, `detail` and
 * `text` from these three interfaces, delete the LEGACY PROSE region at the bottom of this file,
 * and delete the middle branch of `opsAlertTitle`/`opsAlertDetail`/`opsEventText` plus their
 * "stripped fields" tests in the frontend.
 */
interface AttentionItemBase {
  /** @deprecated English prose — old-frontend fallback for one deploy. See the note above. */
  title: string;
  /** @deprecated English prose — old-frontend fallback for one deploy. See the note above. */
  detail: string;
  // Deep-link to the screen that lets an operator act on this alert, where one exists.
  href?: string;
}

/** Sandboxes sitting in `status = 'error'`. */
export interface SandboxErrorAlert extends AttentionItemBase {
  kind: 'sandbox_error';
  /**
   * The TRUE number of sandboxes in error — a separate `COUNT(*)`, not `owners.length`.
   * ⛔ These two are DIFFERENT NUMBERS on purpose; see the bug note in `getAttention`.
   */
  errorCount: number;
  /** A sample of at most `SANDBOX_ERROR_OWNER_SAMPLE` owners, newest first. */
  owners: { name: string; project: string | null }[];
}

/** 24h P95 above the alert threshold. */
export interface HighLatencyAlert extends AttentionItemBase {
  kind: 'high_latency';
  /** Raw milliseconds, exactly as measured. NOT seconds, NOT rounded, NO unit suffix — the
   *  browser decides both the unit and the decimal separator (nl writes "2,41s"). */
  p95Ms: number;
  /** Raw milliseconds. Same rule. */
  thresholdMs: number;
}

/** One block that errored in ≥2 separate runs inside the window. */
export interface BlockErrorsAlert extends AttentionItemBase {
  kind: 'block_errors';
  slug: string;
  /** Errored RUNS (deduped per run), not error events — see the query's own comment. */
  runCount: number;
  /** Always `BLOCK_ERROR_WINDOW_DAYS`; on the wire so the copy cannot drift from the query. */
  windowDays: number;
}

export type AttentionItem = SandboxErrorAlert | HighLatencyAlert | BlockErrorsAlert;

interface FeedEventBase {
  actor: string;
  /** @deprecated English prose — old-frontend fallback for one deploy. See the note above. */
  text: string;
  ts: string;
  // Deep-link to the subject of the event (block / flow / sandboxes), where resolvable.
  href?: string;
}

export interface BlockPublishedEvent extends FeedEventBase {
  kind: 'block_published';
  /** The block SLUG. An identifier — never translated. */
  block: string;
  /** The published version, as recorded (`block_versions.version`). */
  version: string;
}

export interface RunFinishedEvent extends FeedEventBase {
  kind: 'run_finished';
  /** The flow's name, as the author wrote it. A proper noun — never translated. */
  flow: string;
  /** The RAW `flow_runs.status` enum (running | ok | partial | failed). The browser routes it
   *  through `runStatusLabel`, which already owns that vocabulary. */
  runStatus: string;
}

export interface SandboxSuspendedEvent extends FeedEventBase {
  kind: 'sandbox_suspended';
  /** `sandboxes.project`, which is genuinely nullable — the sentence changes when it is null. */
  project: string | null;
}

export type FeedEvent = BlockPublishedEvent | RunFinishedEvent | SandboxSuspendedEvent;
export interface Dashboard {
  stats: DashboardStats;
  health: { buckets: HealthBucket[] };
  topBlocks: TopBlock[];
  attention: AttentionItem[];
  events: FeedEvent[];
}

type Row = Record<string, unknown>;
const rows = async (q: ReturnType<typeof sql>): Promise<Row[]> =>
  (await db.execute(q)) as unknown as Row[];

async function getStats(): Promise<DashboardStats> {
  const [active] = await rows(
    sql`SELECT count(*)::int AS n FROM sandboxes WHERE status <> 'suspended'`,
  );
  // ⛔ BOTH COUNTERS, SUMMED (migration 0061). This is the /it-dash FLEET-LOAD headline, and the
  // question it answers is "how much LLM traffic is this platform generating right now" — for
  // which a background call is exactly as real as a human one. The translation drainer alone can
  // produce ~240 calls/hour; counting only `llm_calls` would make all of it invisible on the one
  // screen whose entire job is to see it.
  //
  // ⛔ DELIBERATELY ASYMMETRIC with routes/sandboxes.ts:56, which sums `llm_calls` ONLY. That one
  // sits in a PER-PERSON row and answers a different question. Do not "harmonise" them — read the
  // comment there before changing either.
  //
  // ⛔ AND WITH host/usage-metrics.ts, the THIRD member of the trio (migration 0063): all four
  // /usage aggregates read the `usage_events` LEDGER and EXCLUDE platform rows entirely
  // (`NOT ue.platform_actor`), because /usage is the tenant-admin's budget + chargeback +
  // per-person screen and background work is none of those. Three screens, three questions:
  //     here (/it-dash fleet load)      SUM(llm_calls + platform_llm_calls)   BOTH
  //     routes/sandboxes.ts (a person)  SUM(llm_calls)                        HUMAN
  //     host/usage-metrics.ts (/usage)  NOT ue.platform_actor                 HUMAN
  // Each is pinned by its own test — this file's ops-metrics.test.ts, sandboxes-routes.test.ts,
  // and usage-metrics-platform.test.ts — which seed the SAME shape and assert DIFFERENT numbers
  // on purpose. Making any one match another reds exactly one of the three.
  const [usage] = await rows(
    sql`SELECT COALESCE(SUM(llm_calls + platform_llm_calls),0)::int AS calls,
               COALESCE(SUM(spend_usd),0) AS spend
        FROM usage_counters WHERE day = current_date`,
  );
  const [lat] = await rows(
    sql`SELECT count(*)::int AS n,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY total_ms) AS p95
        FROM flow_runs
        WHERE finished_at >= now() - interval '24 hours' AND total_ms IS NOT NULL`,
  );
  const enoughRuns = Number(lat?.n ?? 0) >= MIN_RUNS_FOR_P95;
  return {
    activeSandboxes: Number(active?.n ?? 0),
    dailyLlmCalls: Number(usage?.calls ?? 0),
    spendTodayUsd: Number(usage?.spend ?? 0),
    p95LatencyMs: enoughRuns && lat?.p95 != null ? Math.round(Number(lat.p95)) : null,
  };
}

async function getHealth(): Promise<HealthBucket[]> {
  const r = await rows(sql`
    WITH hours AS (
      SELECT generate_series(
        date_trunc('hour', now()) - interval '23 hours',
        date_trunc('hour', now()),
        interval '1 hour'
      ) AS h
    )
    SELECT h AS hour_ts,
           COALESCE(count(fr.id),0)::int AS active_runs,
           COALESCE(SUM(fr.llm_calls),0)::int AS llm_calls
    FROM hours
    LEFT JOIN flow_runs fr ON date_trunc('hour', fr.finished_at) = h
    GROUP BY h ORDER BY h
  `);
  return r.map((x) => ({
    hourTs: new Date(x.hour_ts as string).toISOString(),
    activeRuns: Number(x.active_runs),
    llmCalls: Number(x.llm_calls),
  }));
}

async function getTopBlocks(): Promise<TopBlock[]> {
  // RUNS, not events: `jsonb_array_elements` yields one row per node_success EVENT, so a block
  // sitting in a `foreach` body scored one point per iterated row and ranked far above blocks
  // that ran in more actual flows. "Most used blocks" counts runs.
  //
  // The dedup is INSIDE the lateral rather than a trailing count(DISTINCT flow_runs.id). Same
  // number, but count(DISTINCT) sorts every expanded event — 1.74 M rows and a 66 MB external
  // merge on a 5,000-run corpus, which is what took /it-dash from 288 ms to 872 ms. Deduping
  // per run first leaves the top-level aggregate a few rows per run. See
  // routes/blocks.ts realUsageBySlug for the full measurement and the residual coupling.
  const r = await rows(sql`
    SELECT s.slug, count(*)::int AS n
    FROM flow_runs fr
    CROSS JOIN LATERAL (
      SELECT DISTINCT ev->>'slug' AS slug
      FROM jsonb_array_elements(fr.trace) ev
      WHERE ev->>'type' = 'node_success'
    ) s
    WHERE fr.finished_at >= now() - interval '7 days'
    GROUP BY 1 ORDER BY n DESC LIMIT 6
  `);
  if (!r.length) return [];
  const slugs = r.map((x) => String(x.slug));
  // The same lookup already ran for `category`; `name` is one more column off the same rows, and
  // it is what the bar labels should have been reading all along.
  //
  // ⛔⛔ `isNull(tenant_id)` IS A CROSS-TENANT LEAK GUARD, NOT A NARROWING OPTIMISATION. DO NOT DROP
  // IT, AND DO NOT SPLIT `name` AND `category` INTO TWO LOOKUPS.
  //
  // Since 0037 the slug is unique only PER OWNER (`building_blocks_slug_owner_uq` on
  // `(slug, coalesce(tenant_id, zero-uuid))`), so ONE slug legally names a platform block AND a
  // private block in every tenant at once — 0037 exists precisely to enable that. The route runs
  // this whole dashboard inside `runAsSystem` (routes/ops.ts:13), so RLS is not filtering: an
  // unscoped `inArray(slug, slugs)` returns every owner's row and `new Map(...)` silently keeps
  // WHICHEVER ONE THE HEAP YIELDS LAST. /it-dash is the FLEET-WIDE super_admin screen, so that put
  // one tenant's private block NAME in front of every other tenant's operator, non-deterministically.
  // `?? b.slug` at the render site is no defence — a name is present, just the wrong tenant's.
  //
  // This repo has fixed this exact class once before: see `src/blocks/i18n-key.ts`, on bare-slug
  // keying letting "tenant B publishing `invoice-parser` OVERWRITE tenant A's row".
  //
  // THE RULE: a fleet-wide screen resolves the PLATFORM-owned row or nothing. A tenant-owned slug
  // therefore reports `name: null` / `category: null` and the bar falls back to the slug — exactly
  // what this screen rendered before `name` existed, so nothing regresses and nothing leaks. The
  // predicate also makes the result DETERMINISTIC by construction: the unique index admits at most
  // one `tenant_id IS NULL` row per slug, so there is no row order left to depend on.
  const meta = await db
    .select({
      slug: buildingBlocks.slug,
      name: buildingBlocks.name,
      category: buildingBlocks.category,
    })
    .from(buildingBlocks)
    .where(and(inArray(buildingBlocks.slug, slugs), isNull(buildingBlocks.tenant_id)));
  const bySlug = new Map(meta.map((c) => [c.slug, c]));
  const max = Number(r[0]!.n) || 1;
  return r.map((x) => {
    const count = Number(x.n);
    const slug = String(x.slug);
    const found = bySlug.get(slug);
    return {
      slug,
      // null, NOT `?? slug`, at this layer: the DTO must be able to say "there is no block row for
      // this slug" so a reader can tell a missing block from a block literally named like its slug.
      // The `?? slug` fallback belongs at the render site.
      name: found?.name ?? null,
      category: (found?.category as string | undefined) ?? null,
      count,
      pct: Math.round((count / max) * 100),
    };
  });
}

async function getAttention(p95: number | null): Promise<AttentionItem[]> {
  const out: AttentionItem[] = [];

  // ⛔ THE HEADLINE COUNT AND THE OWNER SAMPLE ARE TWO QUERIES ON PURPOSE.
  // This was a real correctness bug, not a refactor: the count came from `errored.length`, and
  // `errored` is `LIMIT 5`. Twelve broken sandboxes therefore rendered "5 sandboxes in error" —
  // the alert under-reported the incident by more than half, and the deep-link it offers
  // (`/sandboxes?status=error`) then showed twelve rows, contradicting the headline that sent
  // the operator there. The count must not be derived from a sample.
  //
  // ⚠️ SAME `FROM`/`WHERE` AS THE SAMPLE, INCLUDING THE JOIN. A bare
  // `COUNT(*) FROM sandboxes WHERE status='error'` would count rows the sample cannot show (an
  // owner_id with no `users` row), so the two numbers would describe different populations and
  // `errorCount - owners.length` — which the frontend renders as "+N more" — would be wrong.
  const [erroredCount] = await rows(sql`
    SELECT count(*)::int AS n
    FROM sandboxes s JOIN users u ON s.owner_id = u.id
    WHERE s.status = 'error'
  `);
  const errorCount = Number(erroredCount?.n ?? 0);
  const errored = await rows(sql`
    SELECT u.name AS owner, s.project AS project
    FROM sandboxes s JOIN users u ON s.owner_id = u.id
    WHERE s.status = 'error' ORDER BY s.updated_at DESC LIMIT ${SANDBOX_ERROR_OWNER_SAMPLE}
  `);
  if (errorCount > 0) {
    const owners = errored.map((e) => ({
      name: String(e.owner),
      project: e.project == null ? null : String(e.project),
    }));
    out.push({
      kind: 'sandbox_error',
      errorCount,
      owners,
      // ⚠️ Composed from the TRUE count, so this deliberately CHANGES today's English string
      // whenever more than 5 sandboxes are in error ("5 sandboxes in error" → "12 sandboxes in
      // error"). That is the bug fix landing, not an i18n regression.
      title: legacySandboxErrorTitle(errorCount),
      detail: legacySandboxErrorDetail(owners),
      href: '/sandboxes?status=error',
    });
  }

  if (p95 != null && p95 > P95_LATENCY_ALERT_MS) {
    out.push({
      kind: 'high_latency',
      p95Ms: p95,
      thresholdMs: P95_LATENCY_ALERT_MS,
      title: 'P95 latency rising',
      detail: legacyHighLatencyDetail(p95, P95_LATENCY_ALERT_MS),
    });
  }

  // Same event-vs-run multiplication as getTopBlocks: the alert's own copy says "N errored
  // runs", and a single run of a `foreach` whose body block throws on every one of 400 rows is
  // ONE errored run, not 400. The `>= 2` threshold means "failed in at least two separate
  // runs" — counting events, a single flaky run armed the alert by itself. Deduping per run in
  // the lateral makes both the SELECT and the HAVING count runs without sorting every expanded
  // event (see getTopBlocks).
  const blockErrors = await rows(sql`
    SELECT s.slug, count(*)::int AS n
    FROM flow_runs fr
    CROSS JOIN LATERAL (
      SELECT DISTINCT ev->>'slug' AS slug
      FROM jsonb_array_elements(fr.trace) ev
      WHERE ev->>'type' = 'node_error'
    ) s
    WHERE fr.finished_at >= now() - (${BLOCK_ERROR_WINDOW_DAYS}::int * interval '1 day')
    GROUP BY 1 HAVING count(*) >= 2 ORDER BY n DESC LIMIT 3
  `);
  for (const b of blockErrors) {
    const slug = String(b.slug);
    const runCount = Number(b.n);
    out.push({
      kind: 'block_errors',
      slug,
      runCount,
      windowDays: BLOCK_ERROR_WINDOW_DAYS,
      title: legacyBlockErrorsTitle(slug),
      detail: legacyBlockErrorsDetail(runCount, BLOCK_ERROR_WINDOW_DAYS),
      href: `/block-edit?slug=${encodeURIComponent(slug)}`,
    });
  }

  return out;
}

async function getEvents(): Promise<FeedEvent[]> {
  const r = await rows(sql`
    (
      -- A block with no recorded publisher is a platform/seed publish — attribute it to the
      -- product rather than the placeholder-looking "someone" (which also yields a "?" avatar).
      SELECT 'block_published' AS kind, COALESCE(u.name,'Common Practice') AS actor,
             bv.published_at AS ts, bb.slug AS subject, bv.version AS detail,
             ('/block-edit?slug=' || bb.slug) AS link
      FROM block_versions bv
      JOIN building_blocks bb ON bv.block_id = bb.id
      LEFT JOIN users u ON bv.published_by = u.id
      WHERE bv.published_at IS NOT NULL
      ORDER BY bv.published_at DESC LIMIT 6
    )
    UNION ALL
    (
      SELECT 'run_finished', u.name, fr.finished_at, f.name, fr.status::text,
             ('/build?id=' || fr.flow_id::text)
      FROM flow_runs fr
      JOIN flows f ON fr.flow_id = f.id
      JOIN users u ON fr.triggered_by = u.id
      WHERE fr.finished_at IS NOT NULL
      ORDER BY fr.finished_at DESC LIMIT 6
    )
    UNION ALL
    (
      SELECT 'sandbox_suspended', u.name, s.updated_at, s.project, s.status::text,
             '/sandboxes?status=suspended'
      FROM sandboxes s JOIN users u ON s.owner_id = u.id
      WHERE s.status = 'suspended'
      ORDER BY s.updated_at DESC LIMIT 4
    )
    ORDER BY ts DESC LIMIT 8
  `);

  return r.map((x): FeedEvent => {
    const actor = String(x.actor);
    // The UNION ALL packs three different subjects into one column: block slug / flow name /
    // sandbox project. Only the third is genuinely nullable, so only that one keeps `null` —
    // the other two coerce to '' exactly as they did before, to keep `text` byte-identical.
    const subject = x.subject == null ? '' : String(x.subject);
    const detail = x.detail == null ? '' : String(x.detail);
    const ts = new Date(x.ts as string).toISOString();
    const href = x.link == null ? undefined : String(x.link);
    switch (x.kind) {
      case 'block_published':
        return {
          kind: 'block_published',
          block: subject,
          version: detail,
          actor,
          text: legacyBlockPublishedText(subject, detail),
          ts,
          href,
        };
      case 'run_finished':
        return {
          kind: 'run_finished',
          flow: subject,
          // The raw pg enum. `runStatusLabel` on the frontend already owns these four words;
          // minting `ops_event_run_ok` etc. here would be a second, drifting vocabulary.
          runStatus: detail,
          actor,
          text: legacyRunFinishedText(subject, detail),
          ts,
          href,
        };
      default:
        return {
          kind: 'sandbox_suspended',
          // '' collapses to null: the legacy sentence appends nothing for an empty project, and
          // the frontend must reach the SAME branch, or the two wire versions disagree.
          project: subject === '' ? null : subject,
          actor,
          text: legacySandboxSuspendedText(subject),
          ts,
          href,
        };
    }
  });
}

// ==================================================================================== LEGACY-PROSE
// ⛔ BEGIN LEGACY PROSE — DELETE THIS WHOLE REGION ONE DEPLOY AFTER THE I18N FRONTEND SHIPS.
//
// Every English sentence this file still puts on the wire is composed HERE and nowhere else. The
// words a reader actually sees now come from `frontend/src/lib/i18n/ops-alert-label.ts` and
// `ops-event-label.ts`, driven by the machine fields on the same objects. These functions exist
// only so an OLD frontend, served a NEW pod's response mid-roll, still renders a sentence instead
// of a blank row.
//
// ⚠️ The pluralisation below is ENGLISH-ONLY and DELIBERATELY DUMB. Real pluralisation is a
// per-locale CLDR problem the backend cannot solve for eight languages — it lives in the catalog
// (`ops_alert_sandbox_error_title`, `ops_alert_block_errors_detail`), which declares only the
// categories each language genuinely writes. Nothing outside this region may choose a word form
// from a number; `ops-metrics.i18n-contract` in tests/ops-metrics.test.ts holds that line.
//
// The one intentional behaviour change vs. what this file shipped before: the sandbox-error title
// is composed from the TRUE `COUNT(*)`, not from the ≤5 sample. See `getAttention`.

/** @deprecated old-frontend fallback. */
function legacySandboxErrorTitle(n: number): string {
  return `${n} ${n === 1 ? 'sandbox' : 'sandboxes'} in error`;
}

/** @deprecated old-frontend fallback. */
function legacySandboxErrorDetail(owners: { name: string; project: string | null }[]): string {
  return owners.map((o) => `${o.name}${o.project ? ` · ${o.project}` : ''}`).join('; ');
}

/** @deprecated old-frontend fallback. */
function legacyHighLatencyDetail(p95Ms: number, thresholdMs: number): string {
  return `24h P95 is ${(p95Ms / 1000).toFixed(2)}s, above the ${(thresholdMs / 1000).toFixed(1)}s target.`;
}

/** @deprecated old-frontend fallback. */
function legacyBlockErrorsTitle(slug: string): string {
  return `${slug} failing repeatedly`;
}

/** @deprecated old-frontend fallback. */
function legacyBlockErrorsDetail(runCount: number, windowDays: number): string {
  return `${runCount} errored runs in the last ${windowDays} days hit the same block.`;
}

/** @deprecated old-frontend fallback. */
function legacyBlockPublishedText(block: string, version: string): string {
  return `published ${block} v${version}`;
}

/** @deprecated old-frontend fallback. */
function legacyRunFinishedText(flow: string, runStatus: string): string {
  return `ran ${flow} → ${runStatus}`;
}

/** @deprecated old-frontend fallback. */
function legacySandboxSuspendedText(project: string): string {
  return `sandbox suspended${project ? ` · ${project}` : ''}`;
}

// ⛔ END LEGACY PROSE
// ================================================================================ END-LEGACY-PROSE

export async function getDashboard(): Promise<Dashboard> {
  const stats = await getStats();
  const [health, topBlocks, attention, events] = await Promise.all([
    getHealth(),
    getTopBlocks(),
    getAttention(stats.p95LatencyMs),
    getEvents(),
  ]);
  return { stats, health: { buckets: health }, topBlocks, attention, events };
}
