// src/routes/blocks.ts — building-blocks library CRUD + versioning.
// Reads are open to any authenticated user and RLS-scoped to global (tenant_id NULL) ∪ the caller's
// tenant (0037 §4c). Writes are scope-aware (Phase 2 dual ownership): a GLOBAL/platform block
// (tenant_id NULL) is super_admin-only and mutated via runAsSystem (owner — the 4c policies reject
// NULL-tenant writes under the cp_app runtime role); a TENANT block is authored by a developer/admin
// of that tenant under the request's RLS-scoped connection. Registered into the shared Router by
// registerBlockRoutes(router) from server.ts.
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  buildingBlocks,
  blockVersions,
  blockTests,
  blockTestResults,
  users,
  withTenantDb,
} from '../db/client';
import { currentDbContext } from '../db/tenant-context';
import type { BlockVersion, BlockTest, BuildingBlock } from '../db/schema';
import { BLOCK_CATEGORIES, ASSERT_MODES } from '../db/block-types';
import type { User } from '../types';
import { validateAuth } from '../middleware/auth';
import {
  requireSuperAdmin,
  requireDeveloper,
  requireBlockAuthor,
} from '../middleware/admin-guards';
import {
  loadBlockBySlug,
  ownerOf,
  runForBlock,
  maintainerExists,
  createBlockCore,
  addVersionCore,
  saveVersionCore,
  publishVersionCore,
} from '../blocks/authoring-service';
import { getTranslationsBatch } from '../db/translations';
import { translatedBlockMatchSql } from '../db/translation-search';
import { likeTerm } from '../utils/search';
import {
  BLOCK_I18N,
  BLOCK_TENANT_I18N,
  blockI18nKey,
  tenantBlockI18nId,
} from '../blocks/i18n-key';
import { negotiateLocale } from '../utils/locale';
import { resolvePortLabels } from '../blocks/port-labels';
import { recordAudit } from '../host/audit-service';
import {
  jsonResponse,
  readJson,
  readJsonOptional,
  route,
  notFound,
  conflict,
  unprocessable,
  HttpError,
} from '../utils/http';
import { log } from '../host/logger';
import { descriptorSchema } from '../blocks/descriptor-schema';
import { lintBlock } from '../blocks/lint';
import {
  runBlockTests,
  simulateBlockVersion,
  sampleInputsFor,
  type BlockTestOutcome,
} from '../blocks/test-runner';
import type { Router } from '../utils/router';
import { simulateOutcomeFor } from '../host/run-cost-visibility';

// ---- validation schemas ----

const exampleSchema = z
  .object({
    name: z.string(),
    inputs: z.record(z.string(), z.unknown()),
    expectedOutputs: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const slugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be kebab-case');

const createBlockSchema = z
  .object({
    slug: slugSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    category: z.enum(BLOCK_CATEGORIES),
    region: z.string().optional(),
    cost_class: z.string().optional(),
    license: z.string().optional(),
    docs_md: z.string().optional(),
    source_ts: z.string().optional(),
    descriptor: descriptorSchema.optional(),
    examples: z.array(exampleSchema).optional(),
  })
  .strict();

const createVersionSchema = z
  .object({
    version: z.string().optional(),
    from_version: z.string().optional(),
    docs_md: z.string().optional(),
    source_ts: z.string().optional(),
    descriptor: descriptorSchema.optional(),
    examples: z.array(exampleSchema).optional(),
    changelog: z.string().optional(),
  })
  .strict();

const saveVersionSchema = z
  .object({
    docs_md: z.string().optional(),
    source_ts: z.string().optional(),
    descriptor: descriptorSchema.optional(),
    examples: z.array(exampleSchema).optional(),
    changelog: z.string().optional(),
    // tests_passing is COMPUTED by the test runner (Phase 2-B) — no longer a manual flag.
  })
  .strict();

const publishSchema = z
  .object({ status: z.enum(['beta', 'stable']).optional() })
  .strict();

// ---- block-test schemas (Phase 2-B) ----
const createTestSchema = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    datasets: z.array(z.string()).optional(),
    expected: z.record(z.string(), z.unknown()).nullable().optional(),
    assert_mode: z.enum(ASSERT_MODES).optional(),
    expect_error: z.boolean().optional(),
    expected_error_kind: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const patchTestSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    datasets: z.array(z.string()).optional(),
    expected: z.record(z.string(), z.unknown()).nullable().optional(),
    assert_mode: z.enum(ASSERT_MODES).optional(),
    expect_error: z.boolean().optional(),
    expected_error_kind: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const lintBodySchema = z
  .object({ source_ts: z.string().optional() })
  .strict();

// Phase 2: one-off simulate — optional inputs map (missing/partial fields are
// auto-filled from the version's examples + descriptor defaults).
const simulateBodySchema = z
  .object({ inputs: z.record(z.string(), z.unknown()).optional() })
  .strict();

// ---- helpers ----

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * REAL per-block usage, counted from the flow-run traces — the same source the usage-trend
 * sparkline and the top-consumers list already read.
 *
 * `block_versions.usage_count` is NOT that number. It is written in exactly one place (the seed,
 * `db/seed.ts`) and incremented by nothing, ever: it is a frozen demo literal. It was the DEFAULT
 * SORT KEY of the library and the "Total uses" figure on the block-edit Usage-stats tab, so a
 * block genuinely executed 50 times read "Used 0×" and sorted last forever, while a seeded one
 * claimed 4,821 uses directly above a 30-day sparkline showing 2. Serving the trace-derived count
 * under the same field name means an older frontend gets the truth too.
 *
 * RUNS, not events: the lateral `jsonb_array_elements` yields one row per `node_success` EVENT,
 * so a block invoked once per row inside a `foreach` over 400 rows reported 400 "runs" for a
 * single execution. The UI says "runs", so runs is what is counted.
 *
 * DEDUPED PER RUN INSIDE THE LATERAL, not with a trailing `count(DISTINCT fr.id)`. Both produce
 * the identical number — "how many runs contain at least one node_success for this slug" — but
 * the DISTINCT aggregate has to feed EVERY expanded event into one sort: on a 5,000-run corpus
 * carrying 1.74 M events that is `Sort … rows=1739634, external merge Disk: 68832kB`, 1,121 ms,
 * and it is the sort — not the expansion — that dominates. Deduping to the ≤N distinct slugs a
 * single run touched collapses 1.74 M rows to 25 k BEFORE they leave the lateral: the top-level
 * aggregate becomes a HashAggregate with no batches, the per-run sort is a 25 kB in-memory
 * quicksort, and the same query measures 524 ms with ZERO temp-file traffic. Pushing the
 * candidate-slug filter INSIDE the lateral (rather than leaving it on the join) is what keeps
 * that per-run set small.
 *
 * It is still LINEAR IN EVENTS — ~370 ms of the 524 ms is `jsonb_array_elements` expanding every
 * trace on every request, and no rewrite of this query removes that. Closing it needs one of:
 * a counter upserted at run finalization in `run-controller.ts` (which already writes the trace),
 * or a short in-process cache of the slug→uses map. Neither is done here.
 *
 * ONE aggregate query for the whole candidate set — never one per block; this runs on every
 * /blocks list request.
 *
 * Three caveats, all deliberate:
 *  - trace events carry only the SLUG, never a version id, so usage is knowable per block, not
 *    per version. A global and a tenant block sharing a slug (legal since 0037) therefore share
 *    the count.
 *  - `flow_runs` is RLS-scoped, so a tenant sees usage from its own runs. That is the same scope
 *    the trend and consumers panels have always had.
 *  - `finished_at IS NOT NULL` — the same predicate the trend and consumers queries carry. A run
 *    still `status='running'` has an incomplete trace, and counting it made the tile read
 *    "1 total run" directly above a 30-day sparkline showing an empty chart, because the
 *    sparkline's own window is keyed on `finished_at`.
 * All-time (no window), because the label says "total runs"; the trend and consumers panels keep
 * their own 30-day windows.
 */
async function realUsageBySlug(slugs: string[]): Promise<Map<string, number>> {
  if (!slugs.length) return new Map();
  const rows = (await db.execute(sql`
    SELECT s.slug, count(*)::int AS uses
    FROM flow_runs fr
    CROSS JOIN LATERAL (
      SELECT DISTINCT ev->>'slug' AS slug
      FROM jsonb_array_elements(fr.trace) ev
      WHERE ev->>'type' = 'node_success' AND ev->>'slug' IN ${[...new Set(slugs)]}
    ) s
    WHERE fr.finished_at IS NOT NULL
    GROUP BY 1
  `)) as unknown as Record<string, unknown>[];
  return new Map(rows.map((r) => [String(r.slug), Number(r.uses)]));
}

/** Resolve the version a block's library card should display: current, else latest. */
function displayVersion(
  block: { current_version_id: string | null },
  versions: BlockVersion[],
): BlockVersion | undefined {
  if (block.current_version_id) {
    const cur = versions.find((v) => v.id === block.current_version_id);
    if (cur) return cur;
  }
  return versions[0]; // versions are newest-first
}

/**
 * Authorize a write to an EXISTING block and report whether it is a global (platform) block.
 *  - **global** (tenant_id NULL) → super_admin only; mutate via `runForBlock`→`runAsSystem` (owner),
 *    because the 4c policies reject NULL-tenant writes and the `current_version_id` update on a global
 *    row under the cp_app runtime role.
 *  - **tenant** → a developer/admin OF THAT TENANT; mutate under the request's RLS-scoped connection.
 * The block was loaded under RLS (global ∪ caller's tenant), so in prod a foreign tenant's block is
 * already invisible; the explicit tenant check is the belt-and-braces guard for the owner-bypass
 * dev/test connection.
 */
async function authorizeBlockWrite(
  req: Request,
  block: BuildingBlock,
): Promise<{ user: User; isGlobal: boolean }> {
  if (block.tenant_id === null) {
    const user = await requireSuperAdmin(req);
    return { user, isGlobal: true };
  }
  const ctx = await requireDeveloper(req);
  if (block.tenant_id !== ctx.effectiveTenantId) {
    throw notFound('block_not_found', `No block '${block.slug}'`);
  }
  return { user: ctx.user, isGlobal: false };
}

// ---- handlers ----

// GET /api/blocks?category=&status=&sort=usage|recent|alpha&q=
const listBlocks = route(async (req) => {
  await validateAuth(req);
  const url = new URL(req.url);
  const category = url.searchParams.get('category');
  const status = url.searchParams.get('status');
  const sort = url.searchParams.get('sort') ?? 'usage';
  const q = url.searchParams.get('q')?.trim();
  // Negotiated HERE and not beside the overlay below, because the SEARCH needs it too: this
  // library renders localized name/description and must therefore also MATCH on them.
  const locale = negotiateLocale(req);

  const filters = [eq(buildingBlocks.archived, false)];
  if (category && (BLOCK_CATEGORIES as readonly string[]).includes(category)) {
    filters.push(eq(buildingBlocks.category, category as (typeof BLOCK_CATEGORIES)[number]));
  }
  if (q) {
    // ⛔ `likeTerm`, NOT `%${q}%` — `%` and `_` are ILIKE metacharacters, so a library search
    // for `100%` or `a_b` used to wildcard-expand into garbage. utils/search.ts owns the escape.
    const like = likeTerm(q);
    // ⛔ THE PREDICATE SEARCHES THE PROSE THIS ROUTE RENDERS. `name`/`description` are OVERLAID
    // from `content_translations` a few dozen lines below, so matching the EN base columns alone
    // meant a reader on `nl` searching the Dutch name in front of them got an empty library. The
    // translated arm is keyed by OWNERSHIP, never by the bare slug (blocks/i18n-key.ts): 0037
    // dropped global slug uniqueness, so a bare-slug match would let one tenant's prose surface
    // another tenant's row. The base arms STAY (a reader may type the English name, and `slug` is
    // a locale-free identifier that is never translated). On `en` the arm is `undefined`.
    filters.push(
      or(
        ilike(buildingBlocks.name, like),
        ilike(buildingBlocks.slug, like),
        ilike(buildingBlocks.description, like),
        translatedBlockMatchSql(
          buildingBlocks.slug,
          buildingBlocks.tenant_id,
          locale,
          ['name', 'description'],
          like,
        ),
      )!,
    );
  }

  // ORDER BY slug: the JS `items.sort()` below is stable, so whatever order Postgres hands back
  // survives every tie — and with the usage figure now REAL, 16 of the 24 seeded blocks tie at 0.
  // Without a deterministic base order that tail is heap order, which reshuffles after any UPDATE
  // or VACUUM: the library's second page changed order for no reason a user could see, and the
  // same request could not be diffed against itself.
  const blocks = await db
    .select()
    .from(buildingBlocks)
    .where(and(...filters))
    .orderBy(asc(buildingBlocks.slug));

  const blockIds = blocks.map((b) => b.id);
  const allVersions = blockIds.length
    ? await db
        .select()
        .from(blockVersions)
        .where(inArray(blockVersions.block_id, blockIds))
        .orderBy(desc(blockVersions.created_at))
    : [];
  const maintainerIds = [...new Set(blocks.map((b) => b.maintainer_id).filter(Boolean))] as string[];
  const maintainers = maintainerIds.length
    ? await db.select().from(users).where(inArray(users.id, maintainerIds))
    : [];
  const maintainerById = new Map(maintainers.map((m) => [m.id, m]));
  const versionsByBlock = new Map<string, BlockVersion[]>();
  for (const v of allVersions) {
    const arr = versionsByBlock.get(v.block_id) ?? [];
    arr.push(v);
    versionsByBlock.set(v.block_id, arr);
  }

  // Localized overlay (Phase 2-G): EN base name/description fall through when absent.
  //
  // TWO PASSES, keyed by OWNERSHIP — `blocks` is the RLS-scoped global ∪ own-tenant set, so a
  // single bare-slug batch would mix the two and serve another tenant's prose for any slug both
  // own (0037 dropped global slug uniqueness precisely to allow that). Same shape as
  // ontology-service.ts:337-368. See blocks/i18n-key.ts for why there is no bare-slug fallback.
  // (`locale` was negotiated at the top of the handler — the search predicate needs the same
  // value, so the rows matched in this reader's language are the rows rendered in it.)
  const globalBlocks = blocks.filter((b) => b.tenant_id === null);
  const ownedBlocks = blocks.filter((b) => b.tenant_id !== null);
  const globalTx = globalBlocks.length
    ? await getTranslationsBatch(BLOCK_I18N, globalBlocks.map((b) => b.slug), locale, [
        'name',
        'description',
      ])
    : new Map();
  const ownedTx = ownedBlocks.length
    ? await getTranslationsBatch(
        BLOCK_TENANT_I18N,
        ownedBlocks.map((b) => tenantBlockI18nId(b.tenant_id!, b.slug)),
        locale,
        ['name', 'description'],
      )
    : new Map();

  // Real usage for every candidate block, in ONE aggregate query (see realUsageBySlug).
  const usesBySlug = await realUsageBySlug(blocks.map((b) => b.slug));

  let items = blocks.map((b) => {
    const v = displayVersion(b, versionsByBlock.get(b.id) ?? []);
    const m = b.maintainer_id ? maintainerById.get(b.maintainer_id) : undefined;
    const k = blockI18nKey(b);
    const t = (b.tenant_id === null ? globalTx : ownedTx).get(k.entityId) ?? {};
    return {
      slug: b.slug,
      name: t.name ?? b.name,
      description: t.description ?? b.description,
      category: b.category,
      owner: ownerOf(b),
      source_entity_key: b.source_entity_key,
      region: b.region,
      cost_class: b.cost_class,
      version: v?.version ?? null,
      status: v?.status ?? null,
      // ⛔ THE CARD CANNOT SEE THE DESCRIPTOR, WHICH IS WHY THIS FIELD EXISTS.
      // `capabilities.mockData` says the block answers from `ctx.mockData()` — a deterministic
      // fixture inside the runner (exec/mock-data.ts), not a real result. `ocr-scan` declared it,
      // advertised "Tesseract+Claude hybrid OCR", and returned "Lorem ipsum dolor sit amet"; the
      // catalogue and the build palette had no way to say so because this endpoint served no
      // descriptor at all. It still does not — the full descriptor is 5-10x the size of a card row
      // and every screen that needs the ports fetches the detail route anyway — so the ONE bit the
      // card needs is projected here, and the frontend renders `block_simulated_badge` from it.
      // Boolean, never `undefined`: an old descriptor without the key means "no", and a tri-state
      // would make the badge's absence ambiguous between "not simulated" and "backend too old".
      //
      // ⛔ `mockData` ONLY — NEVER `|| capabilities.dataset`. Those are two different claims since
      // the split (db/block-types.ts): `dataset` merely grants ctx.dataset access to the tenant's
      // REAL rows, so ORing it in here would badge `load-dataset` and every ontology-derived data
      // block "Simulated" and tell a customer their own data is fabricated — which is precisely the
      // defect this projection exists to avoid and precisely what the old shared flag caused.
      mock_data: v?.descriptor?.capabilities?.mockData === true,
      // Trace-derived, NOT `v.usage_count` (the frozen seed literal — see realUsageBySlug).
      usage_count: usesBySlug.get(b.slug) ?? 0,
      maintainer: m ? { name: m.name, initials: m.avatar_initials ?? initialsOf(m.name) } : null,
      created_at: b.created_at,
    };
  });

  if (status) items = items.filter((i) => i.status === status);

  items.sort((a, b) => {
    if (sort === 'alpha') return a.name.localeCompare(b.name);
    if (sort === 'recent') return +new Date(b.created_at) - +new Date(a.created_at);
    // 'usage' (default) — now the real trace-derived count, so "Most used" ranks what is
    // actually being run rather than what the seed happened to stamp.
    return b.usage_count - a.usage_count;
  });

  return jsonResponse({ items, total: items.length });
});

// GET /api/blocks/:slug — full block + all versions (full detail).
const getBlock = route(async (req, slug) => {
  await validateAuth(req);
  const block = await loadBlockBySlug(slug!);
  const versions = await db
    .select()
    .from(blockVersions)
    .where(eq(blockVersions.block_id, block.id))
    .orderBy(desc(blockVersions.created_at));
  const m = block.maintainer_id
    ? (await db.select().from(users).where(eq(users.id, block.maintainer_id)))[0]
    : undefined;
  // Resolve each version's publisher (published_by → name/initials) so the history
  // sidebar can attribute and date each version instead of showing a bare number.
  const publisherIds = [...new Set(versions.map((v) => v.published_by).filter((x): x is string => !!x))];
  const publishers = publisherIds.length
    ? await db.select().from(users).where(inArray(users.id, publisherIds))
    : [];
  const publisherById = new Map(publishers.map((u) => [u.id, u]));

  // Localized overlay (Phase 2-G): EN base falls through when no translation. name +
  // description live on the block; docs_md is translated for the current published
  // version (overlaid onto that version row), keyed by slug.
  // Keyed by the BLOCK ROW's ownership, not the reader's tenant — see blocks/i18n-key.ts. Before
  // this, the lookup was a bare slug with no tenant predicate, so a tenant reading its own
  // `invoice-parser` was served whichever tenant published that slug last. There is deliberately
  // NO fallback to the bare key for a tenant block: that would re-serve the poisoned row. A miss
  // degrades to the EN base columns below, exactly as an untranslated block always has.
  const locale = negotiateLocale(req);
  const blockKey = blockI18nKey(block);
  const tx = await getTranslationsBatch(
    blockKey.entityType,
    [blockKey.entityId],
    locale,
    ['name', 'description', 'docs_md'],
  );
  const t = tx.get(blockKey.entityId) ?? {};

  // The block's REAL total uses (see realUsageBySlug). Surfaced twice on purpose:
  //  - as top-level `usageCount`, which is what the Usage-stats tab reads;
  //  - overwritten onto every version row's `usage_count` IN THE RESPONSE ONLY (the column is
  //    untouched), so a frontend still on the old build — which reads the SELECTED VERSION's
  //    usage_count — is served the truth instead of the seed literal during a roll. Nothing is
  //    lost by the overwrite: the column is dead (never incremented) and trace events carry no
  //    version, so per-version usage is not a number that exists.
  const usageCount = (await realUsageBySlug([block.slug])).get(block.slug) ?? 0;

  const localizedVersions = versions.map((v) => {
    const base = v.id === block.current_version_id && t.docs_md ? { ...v, docs_md: t.docs_md } : v;
    const pub = v.published_by ? publisherById.get(v.published_by) : undefined;
    const author = pub ? { name: pub.name, initials: pub.avatar_initials ?? initialsOf(pub.name) } : null;
    return { ...base, usage_count: usageCount, author };
  });

  // Top consumers (last 30 days): which flows / solutions actually run this block, counted
  // from real node_success trace events. Powers the "Usage stats" tab's "where is it used"
  // list so the tab is more than three bare numbers.
  //
  // Aggregated PER FLOW in a subquery, then joined out, for two reasons the old flat shape got
  // wrong. (1) `count(*)` over the lateral counted node_success EVENTS, so one execution of a
  // block inside a `foreach` over 400 rows was reported as 400 runs — the "N runs" label means
  // runs, so the trace is deduped per run inside the lateral (see realUsageBySlug for why the
  // dedup sits there and not in a trailing count(DISTINCT): same number, no 66 MB sort spill).
  // For a single slug the lateral emits at most one row per run, so `count(*)` over it IS the
  // run count. (2) `solutions.flow_id` is neither unique nor NOT NULL, so the LEFT JOIN split
  // one flow across as many GROUP BY rows as it has published solutions, listing the same flow
  // repeatedly and crowding real consumers out of the top 6. One representative solution is
  // picked deterministically instead (oldest, id tie-break).
  //
  // ⛔ AND THE `LIMIT 6` IS DISCLOSED, NOT HIDDEN. The list said "Waar het wordt gebruikt" over six
  // rows whether the block had six consumers or sixty, with no total and no wording — so a
  // maintainer deciding whether a change is safe read a COMPLETE-looking inventory of its blast
  // radius that was silently truncated. `count(*) OVER ()` is evaluated BEFORE `LIMIT` (it is a
  // window over the whole result set of the SELECT), so the total costs no second query and no
  // second scan; it rides on the six rows that are already being returned.
  const consumerRows = (await db.execute(sql`
    SELECT f.id AS flow_id, f.name AS flow_name, s.id AS solution_id, s.title AS solution_title,
           r.runs, count(*) OVER ()::int AS total_consumers
    FROM (
      SELECT fr.flow_id AS flow_id, count(*)::int AS runs
      FROM flow_runs fr
      CROSS JOIN LATERAL (
        SELECT DISTINCT ev->>'slug' AS slug
        FROM jsonb_array_elements(fr.trace) ev
        WHERE ev->>'type' = 'node_success' AND ev->>'slug' = ${block.slug}
      ) hit
      WHERE fr.finished_at >= now() - interval '30 days'
      GROUP BY 1
    ) r
    JOIN flows f ON f.id = r.flow_id
    LEFT JOIN LATERAL (
      SELECT sol.id, sol.title FROM solutions sol
      WHERE sol.flow_id = f.id ORDER BY sol.created_at ASC, sol.id ASC LIMIT 1
    ) s ON true
    ORDER BY r.runs DESC, f.id LIMIT 6
  `)) as unknown as Record<string, unknown>[];
  const consumers = consumerRows.map((r) => ({
    flowId: String(r.flow_id),
    flowName: String(r.flow_name),
    solutionId: r.solution_id == null ? null : String(r.solution_id),
    solutionTitle: r.solution_title == null ? null : String(r.solution_title),
    runs: Number(r.runs),
  }));
  // Every row carries the same window value; with NO rows there is no row to read it off, and zero
  // is then the right answer rather than a missing one — the list renders its empty state, and a
  // disclosure about a cap nothing hit would be noise.
  const consumersTotal = consumerRows.length ? Number(consumerRows[0]!.total_consumers) : 0;

  // Usage trend: daily run counts over the last 30 days, from the same real node_success
  // trace events. A full continuous series (zero-filled via generate_series) so the
  // Usage-stats sparkline has a readable, gap-free shape instead of three bare numbers.
  const trendRows = (await db.execute(sql`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', now()) - interval '29 days',
        date_trunc('day', now()),
        interval '1 day'
      ) AS day
    ),
    runs AS (
      -- Deduped per run inside the lateral: jsonb_array_elements yields one row per
      -- node_success EVENT, so a block invoked inside a foreach over 400 rows spiked the
      -- sparkline to 400 for a single execution. The axis label says "runs". For a single slug
      -- the lateral emits at most one row per run, so count(*) over it IS the run count — and
      -- unlike a trailing count(DISTINCT fr.id) it never sorts the expanded events (see
      -- realUsageBySlug).
      SELECT date_trunc('day', fr.finished_at) AS day, count(*)::int AS runs
      FROM flow_runs fr
      CROSS JOIN LATERAL (
        SELECT DISTINCT ev->>'slug' AS slug
        FROM jsonb_array_elements(fr.trace) ev
        WHERE ev->>'type' = 'node_success' AND ev->>'slug' = ${block.slug}
      ) hit
      WHERE fr.finished_at >= date_trunc('day', now()) - interval '29 days'
      GROUP BY 1
    )
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COALESCE(r.runs, 0)::int AS runs
    FROM days d LEFT JOIN runs r ON r.day = d.day
    ORDER BY d.day
  `)) as unknown as Record<string, unknown>[];
  const usageTrend = trendRows.map((r) => ({ day: String(r.day), runs: Number(r.runs) }));

  // Port labels for the reader's locale (blocks/port-labels.ts), one map for the block. The author's
  // label comes ONLY from the current version — the one /build treats as current
  // (`current_version_id`, else the newest) — never from a draft or a superseded version. SEPARATE from `versions[].descriptor` on purpose: the block editor
  // and the fork picker save that descriptor back, and a resolved Dutch label written into it would
  // become the author's base label. A port absent here has no label anywhere — the client
  // humanizes its key.
  const servedVersion = versions.find((v) => v.id === block.current_version_id) ?? versions[0];
  const portLabels = await resolvePortLabels(
    block,
    servedVersion?.descriptor,
    versions.map((v) => v.descriptor),
    locale,
  );

  return jsonResponse({
    ...block,
    name: t.name ?? block.name,
    description: t.description ?? block.description,
    owner: ownerOf(block),
    maintainer: m ? { id: m.id, name: m.name, initials: m.avatar_initials ?? initialsOf(m.name) } : null,
    versions: localizedVersions,
    // Additive + optional on the client: an older frontend ignores it and reads the (now
    // equally true) per-version usage_count above.
    usageCount,
    consumers,
    // Additive + optional on the client, like `usageCount` above: an older frontend ignores it and
    // renders the six rows exactly as it does today.
    consumersTotal,
    usageTrend,
    // Additive + optional on the client: an older frontend ignores it and humanizes the keys.
    portLabels,
  });
});

// POST /api/blocks[?scope=tenant] — new block + initial draft version.
// Scope (Phase 2 dual ownership): super_admin → GLOBAL (tenant_id NULL, via runAsSystem) by default,
// or a TENANT block with ?scope=tenant; developer/tenant_admin → always a TENANT block (own tenant).
const createBlock = route(async (req) => {
  const { user, scope, tenantId } = await requireBlockAuthor(req);
  const body = createBlockSchema.parse(await readJson(req));
  const created = await createBlockCore({ userId: user.id, scope, tenantId }, body);
  return jsonResponse(created, 201);
});

// POST /api/blocks/:slug/versions — new draft version.
const createVersion = route(async (req, slug) => {
  const block = await loadBlockBySlug(slug!);
  const { isGlobal } = await authorizeBlockWrite(req, block);
  const body = createVersionSchema.parse(await readJson(req));
  const draft = await addVersionCore({ isGlobal }, block, body);
  return jsonResponse(draft, 201);
});

async function loadDraftVersion(slug: string, version: string) {
  const block = await loadBlockBySlug(slug);
  const [v] = await db
    .select()
    .from(blockVersions)
    .where(
      and(eq(blockVersions.block_id, block.id), eq(blockVersions.version, version)),
    );
  if (!v) throw notFound('version_not_found', `No version ${version} for '${slug}'`);
  return { block, version: v };
}

// PATCH /api/blocks/:slug/versions/:version — edit a draft.
const saveVersion = route(async (req, slug, version) => {
  const { block, version: v } = await loadDraftVersion(slug!, version!);
  const { isGlobal } = await authorizeBlockWrite(req, block);
  const body = saveVersionSchema.parse(await readJson(req));
  const updated = await saveVersionCore({ isGlobal }, v, body);
  return jsonResponse(updated);
});

// POST /api/blocks/:slug/versions/:version/publish — lint (scan + tsc) then, for a
// `stable` publish (when the governance policy requires it), re-run the block's tests
// and require ≥1 enabled test all passing. `beta` publishes skip the test gate.
const publishVersion = route(async (req, slug, version) => {
  const { block, version: v } = await loadDraftVersion(slug!, version!);
  const { user, isGlobal } = await authorizeBlockWrite(req, block);
  const body = publishSchema.parse(await readJsonOptional(req));
  const published = await publishVersionCore(
    { userId: user.id, tenantId: currentDbContext()?.tenantId ?? null, isGlobal },
    block,
    v,
    body.status,
  );
  return jsonResponse(published);
});

// ---- block tests (Phase 2-B) ----

interface LastResult {
  status: string;
  actual: unknown;
  /** ⛔ The backend's ENGLISH, and the guaranteed fallback — see the column comment in 0072. */
  error: string | null;
  /**
   * ⛔ THE HALF THAT MAKES THE FIX SURVIVE A REFRESH. `runBlockTests` streams its outcome once over
   * SSE; every subsequent /block-edit page load rebuilds the panel from THIS shape. Drop these two
   * here and the localized sentence appears when the suite runs and reverts to English on reload,
   * with every frontend render test still green.
   */
  error_rule: string | null;
  error_detail: unknown;
  duration_ms: number;
  run_at: Date;
}

function testOut(t: BlockTest, lastResult?: LastResult | null) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    inputs: t.inputs,
    datasets: t.datasets,
    expected: t.expected,
    assert_mode: t.assert_mode,
    expect_error: t.expect_error,
    expected_error_kind: t.expected_error_kind,
    enabled: t.enabled,
    created_at: t.created_at,
    updated_at: t.updated_at,
    last_result: lastResult ?? null,
  };
}

/** Load a version of any status (publish gate / test / lint can target any version). */
async function loadVersionAny(slug: string, version: string) {
  const block = await loadBlockBySlug(slug);
  const [v] = await db
    .select()
    .from(blockVersions)
    .where(and(eq(blockVersions.block_id, block.id), eq(blockVersions.version, version)));
  if (!v) throw notFound('version_not_found', `No version ${version} for '${slug}'`);
  return { block, version: v };
}

async function loadTest(slug: string, testId: string) {
  const block = await loadBlockBySlug(slug);
  const [t] = await db
    .select()
    .from(blockTests)
    .where(and(eq(blockTests.block_id, block.id), eq(blockTests.id, testId)));
  if (!t) throw notFound('test_not_found', `No test '${testId}' for '${slug}'`);
  return { block, test: t };
}

/** Resolve the version id whose results the test list should show (?version=, else
 *  the block's current published version, else the newest). Returns null if none. */
async function resolveResultVersionId(blockId: string, versionParam: string | null): Promise<string | null> {
  if (versionParam) {
    const [v] = await db
      .select({ id: blockVersions.id })
      .from(blockVersions)
      .where(and(eq(blockVersions.block_id, blockId), eq(blockVersions.version, versionParam)));
    return v?.id ?? null;
  }
  const [block] = await db
    .select({ current: buildingBlocks.current_version_id })
    .from(buildingBlocks)
    .where(eq(buildingBlocks.id, blockId));
  if (block?.current) return block.current;
  const [latest] = await db
    .select({ id: blockVersions.id })
    .from(blockVersions)
    .where(eq(blockVersions.block_id, blockId))
    .orderBy(desc(blockVersions.created_at))
    .limit(1);
  return latest?.id ?? null;
}

// GET /api/blocks/:slug/tests?version= — the suite + each test's last result for a version.
const listTests = route(async (req, slug) => {
  await validateAuth(req);
  const block = await loadBlockBySlug(slug!);
  const url = new URL(req.url);
  const tests = await db
    .select()
    .from(blockTests)
    .where(eq(blockTests.block_id, block.id))
    .orderBy(asc(blockTests.created_at));

  const versionId = await resolveResultVersionId(block.id, url.searchParams.get('version'));
  const resultByTest = new Map<string, LastResult>();
  if (versionId && tests.length) {
    const rows = await db
      .select()
      .from(blockTestResults)
      .where(
        and(
          eq(blockTestResults.version_id, versionId),
          inArray(blockTestResults.test_id, tests.map((t) => t.id)),
        ),
      );
    for (const r of rows) {
      resultByTest.set(r.test_id, {
        status: r.status,
        actual: r.actual,
        error: r.error,
        error_rule: r.error_rule ?? null,
        error_detail: r.error_detail ?? null,
        duration_ms: r.duration_ms,
        run_at: r.run_at,
      });
    }
  }

  return jsonResponse({
    items: tests.map((t) => testOut(t, resultByTest.get(t.id))),
    total: tests.length,
    version_id: versionId,
  });
});

// POST /api/blocks/:slug/tests — create a test.
const createTest = route(async (req, slug) => {
  const block = await loadBlockBySlug(slug!);
  const { user, isGlobal } = await authorizeBlockWrite(req, block);
  const body = createTestSchema.parse(await readJson(req));

  const [dup] = await db
    .select({ id: blockTests.id })
    .from(blockTests)
    .where(and(eq(blockTests.block_id, block.id), eq(blockTests.name, body.name)));
  // `test` + `block` named so a locale rebuilds the sentence around them.
  if (dup) {
    throw conflict('test_name_taken', `A test '${body.name}' already exists for '${slug}'`, {
      test: body.name,
      block: slug!,
    });
  }

  const createdBy = (await maintainerExists(user.id)) ? user.id : null;
  const [created] = await runForBlock(isGlobal, () =>
    db
      .insert(blockTests)
      .values({
        block_id: block.id,
        name: body.name,
        description: body.description ?? null,
        inputs: body.inputs ?? {},
        datasets: body.datasets ?? [],
        expected: body.expected ?? null,
        assert_mode: body.assert_mode ?? 'subset',
        expect_error: body.expect_error ?? false,
        expected_error_kind: body.expected_error_kind ?? null,
        enabled: body.enabled ?? true,
        created_by: createdBy,
      })
      .returning(),
  );

  await recordAudit({
    actorId: user.id,
    action: 'block.test_create',
    category: 'block',
    targetType: 'block',
    targetId: `${slug}/${created!.name}`,
    result: 'Test created',
    resultTone: 'ok',
  });
  return jsonResponse(testOut(created!), 201);
});

// PATCH /api/blocks/:slug/tests/:id — edit a test.
const patchTest = route(async (req, slug, testId) => {
  const { block, test } = await loadTest(slug!, testId!);
  const { user, isGlobal } = await authorizeBlockWrite(req, block);
  const body = patchTestSchema.parse(await readJson(req));

  if (body.name !== undefined && body.name !== test.name) {
    const [dup] = await db
      .select({ id: blockTests.id })
      .from(blockTests)
      .where(and(eq(blockTests.block_id, block.id), eq(blockTests.name, body.name)));
    // Same code and the same two named details as the create path above.
    if (dup) {
      throw conflict('test_name_taken', `A test '${body.name}' already exists for '${slug}'`, {
        test: body.name,
        block: slug!,
      });
    }
  }

  const [updated] = await runForBlock(isGlobal, () =>
    db
      .update(blockTests)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.inputs !== undefined ? { inputs: body.inputs } : {}),
        ...(body.datasets !== undefined ? { datasets: body.datasets } : {}),
        ...(body.expected !== undefined ? { expected: body.expected } : {}),
        ...(body.assert_mode !== undefined ? { assert_mode: body.assert_mode } : {}),
        ...(body.expect_error !== undefined ? { expect_error: body.expect_error } : {}),
        ...(body.expected_error_kind !== undefined ? { expected_error_kind: body.expected_error_kind } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        updated_at: new Date(),
      })
      .where(eq(blockTests.id, test.id))
      .returning(),
  );

  await recordAudit({
    actorId: user.id,
    action: 'block.test_update',
    category: 'block',
    targetType: 'block',
    targetId: `${slug}/${updated!.name}`,
    result: 'Test updated',
    resultTone: 'ok',
  });
  return jsonResponse(testOut(updated!));
});

// DELETE /api/blocks/:slug/tests/:id — delete a test (cascades its results).
const deleteTest = route(async (req, slug, testId) => {
  const { block, test } = await loadTest(slug!, testId!);
  const { user, isGlobal } = await authorizeBlockWrite(req, block);
  await runForBlock(isGlobal, () => db.delete(blockTests).where(eq(blockTests.id, test.id)));
  await recordAudit({
    actorId: user.id,
    action: 'block.test_delete',
    category: 'block',
    targetType: 'block',
    targetId: `${slug}/${test.name}`,
    result: 'Test deleted',
    resultTone: 'warn',
  });
  return jsonResponse({ deleted: true });
});

// DELETE /api/blocks/:slug — archive, never physically delete. Flow dependencies live in JSONB and
// therefore cannot be protected by an FK; a cascading delete used to erase the pinned version from
// published solutions. Archived parents are refused by publication/run validation while their
// immutable versions, tests, and provenance remain inspectable.
const deleteBlock = route(async (req, slug) => {
  const block = await loadBlockBySlug(slug!);
  const { user, isGlobal } = await authorizeBlockWrite(req, block);
  await runForBlock(isGlobal, () =>
    db
      .update(buildingBlocks)
      .set({ archived: true, updated_at: new Date() })
      .where(eq(buildingBlocks.id, block.id)),
  );
  await recordAudit({
    actorId: user.id,
    action: 'block.archive',
    category: 'block',
    targetType: 'block',
    targetId: slug!,
    result: `Archived block '${block.name}'`,
    resultTone: 'warn',
  });
  return jsonResponse({ archived: true });
});

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};

// POST /api/blocks/:slug/versions/:version/test?testId= — run the suite (or one
// test) against this version's source. Streams per-test results over SSE when the
// client Accepts text/event-stream; otherwise returns the summary as JSON.
const runVersionTests = route(async (req, slug, version) => {
  const { block, version: v } = await loadVersionAny(slug!, version!);
  const { user } = await authorizeBlockWrite(req, block);
  const url = new URL(req.url);
  const testId = url.searchParams.get('testId') ?? undefined;
  const wantsSse = (req.headers.get('accept') ?? '').includes('text/event-stream');
  // Captured HERE — inside the handler, after the guards have run and refreshTenantGuc has settled
  // the authoritative effective tenant — because the SSE branch below needs it AFTER this request's
  // context is gone. See the long note there. `?? null` keeps the bare-handler test callers (and
  // any unauthenticated path) on today's no-context behaviour.
  const runTenantId = currentDbContext()?.tenantId ?? null;

  const auditSummary = (passed: number, total: number, passing: boolean) =>
    recordAudit({
      actorId: user.id,
      action: 'block.test_run',
      category: 'block',
      targetType: 'block',
      targetId: `${slug}@${version}`,
      result: `${passed}/${total} passing`,
      resultTone: passing ? 'ok' : 'warn',
    });

  if (!wantsSse) {
    const summary = await runBlockTests(v.id, { ctxUserId: user.id, tenantId: runTenantId, testId });
    await auditSummary(summary.passed, summary.total, summary.testsPassing);
    return jsonResponse(summary);
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let seq = 0;
      const onResult = (o: BlockTestOutcome) => {
        seq++;
        controller.enqueue(enc.encode(`id: ${seq}\nevent: test_result\ndata: ${JSON.stringify(o)}\n\n`));
      };
      void (async () => {
        try {
          // ⛔ THE SUITE RUNS AFTER THIS RESPONSE IS RETURNED, so server.ts:356's per-request
          // `withTenantDb` has already unwound: its `finally` has blanked `app.current_tenant` on
          // the reserved connection and `release()`d it back to the pool, while each test is still
          // spawning a sandboxed subprocess (seconds). The AsyncLocalStorage store IS inherited by
          // this detached IIFE, so `runBlockTests`'s default `database` (the `db` Proxy) cheerfully
          // resolves to that released, blanked connection — which is worse than having no context,
          // because it looks like one.
          //
          // For a TENANT-owned block `runBlockTests`'s `persist` wrapper is a no-op
          // (`isGlobalBlock ? runAsSystem('tenant-parameterised', fn) : fn()`), so under the production `cp_app` role
          // (NOBYPASSRLS) the whole run died on its FIRST read — `building_blocks` is invisible
          // with no GUC, so it threw "block for version '…' not found" — and further down 0057's
          // WITH CHECK would have 42501'd the `block_test_results` INSERT and
          // `recomputeTestsPassing`'s UPDATE would have matched 0 rows while still returning the
          // computed value, streaming "N/N passing" over a `tests_passing` that never flipped.
          // None of it was visible on an owner DSN, which is why the JSON branch (correct: it
          // `await`s inside the handler) and this one disagreed silently.
          //
          // ⛔ `withTenantDb`, NOT `withTenantTx` — and this is the distinction that made PR #300's
          // first attempt at this class a no-op. `withTenantTx` reserves nothing and the `db` Proxy
          // injects the GUC ONLY on `.transaction`; every statement `runBlockTests` issues is a
          // PLAIN statement, so under withTenantTx they would all still run un-scoped. Re-reserving
          // is also the honest cost comparison: the JSON branch above holds the request's reserved
          // connection for exactly this same duration.
          //
          // ⛔ AND NOT `runAsSystem` (the shape routes/connectors.ts:955 uses for its NOTIFY
          // fan-out). That would bypass RLS for the whole run, and `runOneBlockTest` resolves the
          // author's fixtures through `loadInjectedDatasets` — `datasets` is on the STRICT RLS
          // shape, so a slug lookup with no tenant would range over EVERY tenant's datasets. The
          // note in blocks/test-runner.ts spells out why execution must stay in the caller's tenant
          // scope and only the two persist statements may be systematised. This is the third
          // instance of the pattern documented at routes/agent.ts:141.
          await withTenantDb(runTenantId, async () => {
            const summary = await runBlockTests(v.id, {
              ctxUserId: user.id,
              tenantId: runTenantId,
              testId,
              onResult,
            });
            seq++;
            controller.enqueue(
              enc.encode(`id: ${seq}\nevent: summary\ndata: ${JSON.stringify(summary)}\n\n`),
            );
            // Inside the scope too — but NOT for the reason you would guess, and an adversarial
            // verifier caught the earlier comment here asserting the wrong one. `audit_log` has no
            // `tenant_id` column and `relrowsecurity = f`, so this write needs no tenant GUC and
            // would have succeeded outside the scope. It sits inside because the row is part of
            // the same logical unit as the results above, not because RLS requires it. Do not cite
            // this line as evidence that `audit_log` is tenant-scoped; it is not.
            await auditSummary(summary.passed, summary.total, summary.testsPassing);
          });
        } catch (err) {
          // The SSE frame is the ONLY record of this failure: we are inside a detached
          // `void (async () => …)` after the Response headers went out, so nothing upstream
          // (route wrapper, access log) ever sees the throw — a test run that dies on an
          // infrastructure error would leave no server-side trace to debug from.
          log.error('block_test_run_stream_failed', { slug, version, err });
          // ⛔ THE ENGLISH `message` STAYS ON THE WIRE, BYTE FOR BYTE. Three readers need it and
          // none of them is a browser: `ai/mcp/tools.ts` `run_block_test` returns it verbatim to an
          // LLM, `BlockFixAssistant` puts it INTO a prompt, and nine backend assertions pin it
          // character for character. The full argument is at the head of
          // `frontend/src/lib/i18n/block-test-error-label.ts`; do not "fix" this by localizing here.
          //
          // WHAT WAS MISSING IS THE MACHINE FIELDS BESIDE IT. The frame carried `message` alone, so
          // the browser had one string and no way to tell a 402 licence refusal from a 500
          // infrastructure fault — `BlockTesting.svelte` rendered it raw and a Dutch author read
          // English inside a Dutch coral banner. `code`/`status` let the client rebuild the SAME
          // `ApiError` every other refusal on this screen goes through, so the wording comes from
          // the catalog and this sentence stays available to the three readers above.
          //
          // ⚠️ NO NEW REFUSAL CODE IS MINTED HERE. These are the `HttpError`'s OWN `code`/`status`,
          // already on the wire everywhere else this error can surface, so
          // `error-message.backend-contract.test.ts` and `NOT_LOCALIZED_CODES` are untouched. An
          // `err` that is not an `HttpError` (a TypeError, an abort) contributes neither key and
          // `JSON.stringify` omits both — the client then reads it as a 500 with no code, which is
          // exactly what it is.
          //
          // ⛔ `details` RIDES ALONG TOO, AND IT IS NOT SPECULATIVE ON THIS PATH. `runBlockTests`
          // calls `assertRunnableSource` (blocks/test-runner.ts:605) BEFORE the first test, and
          // that gate throws `unprocessable('lint_failed', 'Block failed lint', { findings })`
          // (blocks/source-gate.ts:75) — an `HttpError` whose ENTIRE actionable content is in the
          // bag. The browser's `lint_failed` entry (frontend error-message.ts:757) reads
          // `details.findings` and returns `null` without it, which lands the Dutch author back on
          // the English `Block failed lint` — the exact fall-through this frame was fixed to close.
          // ~20 further catalog entries interpolate `{attribute}` / `{slug}` / `{limitMb}` the same
          // way, so the bag is forwarded as a bag rather than field by field.
          //
          // Nested under `details` — the same key `utils/http.ts:161-168` uses on the JSON error
          // body, so the client lifts it with the SAME `detailsFrom(body)` every other `unwrap` in
          // `frontend/src/lib/api` uses. `JSON.stringify` omits all three machine keys when `err`
          // is not an `HttpError`, which is what an infrastructure fault actually is.
          const message = err instanceof Error ? err.message : String(err);
          const code = err instanceof HttpError ? err.code : undefined;
          const status = err instanceof HttpError ? err.status : undefined;
          const details = err instanceof HttpError ? err.details : undefined;
          controller.enqueue(
            enc.encode(
              `event: error\ndata: ${JSON.stringify({ message, code, status, details })}\n\n`,
            ),
          );
        } finally {
          controller.enqueue(enc.encode('event: end\ndata: {}\n\n'));
          controller.close();
        }
      })();
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
});

// POST /api/blocks/:slug/versions/:version/lint — static-scan + tsc type-check.
// Lints the body's `source_ts` (unsaved editor buffer) when given, else the saved source.
const lintVersion = route(async (req, slug, version) => {
  const { block, version: v } = await loadVersionAny(slug!, version!);
  await authorizeBlockWrite(req, block);
  const body = lintBodySchema.parse(await readJsonOptional(req));
  const source = body.source_ts ?? v.source_ts;
  return jsonResponse(lintBlock(source));
});

// POST /api/blocks/:slug/versions/:version/simulate — run the block ONCE with the
// body's `inputs` (auto-filled from examples + descriptor defaults where absent) and
// return the trace outcome (outputs, ctx.log lines, classified error, cost, duration).
// Persists nothing — this is the developer's "try it" before saving a test. Dev-gated
// via authorizeBlockWrite (same guard as /test, /lint). JSON only (single run).
const simulateVersion = route(async (req, slug, version) => {
  const { block, version: v } = await loadVersionAny(slug!, version!);
  const { user } = await authorizeBlockWrite(req, block);
  const body = simulateBodySchema.parse(await readJsonOptional(req));
  const inputs = { ...sampleInputsFor(v.descriptor, v.examples), ...(body.inputs ?? {}) };
  // The request's authoritative tenant, read the same way `runVersionTests` reads it — AFTER the
  // guards have run and `refreshTenantGuc` has settled it. Fixtures resolve in THIS tenant.
  const outcome = await simulateBlockVersion(
    block,
    v,
    inputs,
    user.id,
    currentDbContext()?.tenantId ?? null,
  );
  await recordAudit({
    actorId: user.id,
    action: 'block.simulate',
    category: 'block',
    targetType: 'block',
    targetId: `${slug}@${version}`,
    result: outcome.status === 'ok' ? 'Simulated (ok)' : `Simulated (${outcome.error?.kind ?? 'error'})`,
    resultTone: outcome.status === 'ok' ? 'ok' : 'warn',
  });
  // `cost` is tenant_admin+ on the wire (run-cost-visibility.ts); a developer gets the rest.
  return jsonResponse({ ...simulateOutcomeFor(user.roles, outcome), inputs });
});

export function registerBlockRoutes(router: Router): void {
  router.add('GET', '/api/blocks', listBlocks);
  router.add('POST', '/api/blocks', createBlock);
  router.add('GET', '/api/blocks/:slug', getBlock);
  router.add('DELETE', '/api/blocks/:slug', deleteBlock);
  router.add('POST', '/api/blocks/:slug/versions', createVersion);
  router.add('PATCH', '/api/blocks/:slug/versions/:version', saveVersion);
  router.add('POST', '/api/blocks/:slug/versions/:version/publish', publishVersion);
  // Phase 2-B: per-block tests + lint.
  router.add('GET', '/api/blocks/:slug/tests', listTests);
  router.add('POST', '/api/blocks/:slug/tests', createTest);
  router.add('PATCH', '/api/blocks/:slug/tests/:id', patchTest);
  router.add('DELETE', '/api/blocks/:slug/tests/:id', deleteTest);
  router.add('POST', '/api/blocks/:slug/versions/:version/test', runVersionTests);
  router.add('POST', '/api/blocks/:slug/versions/:version/lint', lintVersion);
  router.add('POST', '/api/blocks/:slug/versions/:version/simulate', simulateVersion);
}
