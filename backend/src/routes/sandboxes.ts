// src/routes/sandboxes.ts — the platform Ops "Sandboxes" surface (Session 4).
// Every route is platform-gated (requireRole 'platform') — this is the admin view
// over ALL users' sandboxes, not the owner-scoped run path. Cost/usage columns are
// derived live from usage_counters (per owner + today); project falls back to the
// sandbox's most-recent run's flow name. pause/resume flip status and are the
// "governable" lever — a suspended sandbox blocks that user's runs (run-controller).
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  sandboxes,
  users,
  usageCounters,
  flowRuns,
  flows,
  runAsSystem,
} from '../db/client';
import type { Sandbox } from '../db/schema';
import { requireSuperAdmin } from '../middleware/admin-guards';
import { jsonResponse, readJsonOptional, route, notFound, unprocessable } from '../utils/http';
import { likeTerm } from '../utils/search';
import { provisionSandbox, resumeOwnIdleSandbox, transitionSandbox } from '../host/sandbox-service';
import { cancelRunsForSandbox } from '../host/run-controller';
import { recordAudit } from '../host/audit-service';
import { resolveTenant } from '../middleware/tenant';
import type { Router } from '../utils/router';

const PAGE_SIZE = 12;
const STATUSES = ['running', 'idle', 'suspended', 'error'] as const;
type SbStatus = (typeof STATUSES)[number];

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/**
 * Today's usage per owner (llm calls + spend), keyed by user id.
 *
 * AGGREGATED on purpose — do not "simplify" this back to a plain row select. Every caller runs
 * inside `runAsSystem`, which binds the OWNER pool: RLS is bypassed and there is no tenant GUC,
 * so this query sees every tenant's rows. Once 0059 drops the pre-tenancy `(user_id, day)` key,
 * one user can hold one counter row PER TENANT per day, and an unaggregated select would return
 * N rows for that user — `map.set` would keep whichever the planner happened to emit last (there
 * is no ORDER BY), silently reporting one arbitrary tenant's slice as the user's whole day.
 * SUM/GROUP BY reports the true cross-tenant total, which is what this platform-wide Ops view
 * (super_admin, all users, all tenants) is meant to show.
 */
async function usageTodayFor(ownerIds: string[]): Promise<Map<string, { calls: number; spend: number }>> {
  const map = new Map<string, { calls: number; spend: number }>();
  if (!ownerIds.length) return map;
  const rows = await db
    .select({
      user_id: usageCounters.user_id,
      // ⛔ `llm_calls` ONLY — do NOT add `platform_llm_calls` here (migration 0061). This figure
      // lands in a PER-PERSON row of the sandbox list, labelled as that named individual's usage
      // today, and it answers "how much is this employee using". Platform background work is not
      // that: attributing 608 drainer calls to whoever last clicked Backfill is a false statement
      // about a human, printed next to their name, and it is the same category error migration
      // 0061 exists to undo. A person's own row must show a person's own usage.
      //
      // ⛔ THE ASYMMETRY WITH host/ops-metrics.ts:65 IS DELIBERATE, not an oversight. That query
      // sums BOTH columns because it is the FLEET-LOAD headline on /it-dash, where a background
      // call is exactly as real as a human one. Two questions, two answers. Nobody should
      // "harmonise" these — changing either one silently breaks the other's meaning, and each is
      // pinned by its own test (tests/sandboxes-routes.test.ts and tests/ops-metrics.test.ts seed
      // the SAME row shape and assert DIFFERENT numbers on purpose).
      //
      // ⛔ THERE IS A THIRD MEMBER: host/usage-metrics.ts (migration 0063). It answers the same
      // HUMAN-ONLY question this row does, but over the `usage_events` LEDGER rather than
      // `usage_counters`, so it excludes platform rows with `NOT ue.platform_actor` instead of by
      // reading one column. 0061 split the counter and left the ledger whole, which is why /usage
      // went on printing 608 drainer calls beside a real person's name long after this query
      // stopped. Three screens, three questions:
      //     host/ops-metrics.ts (/it-dash fleet load)  SUM(llm_calls + platform_llm_calls)  BOTH
      //     here (one person's sandbox row)            SUM(llm_calls)                       HUMAN
      //     host/usage-metrics.ts (/usage, all four)   NOT ue.platform_actor                HUMAN
      // Pinned by tests/usage-metrics-platform.test.ts. Read all three comments before touching
      // any one of them.
      calls: sql<number>`COALESCE(SUM(${usageCounters.llm_calls}), 0)::int`,
      spend: sql<string>`COALESCE(SUM(${usageCounters.spend_usd}), 0)::text`,
    })
    .from(usageCounters)
    .where(and(inArray(usageCounters.user_id, ownerIds), sql`${usageCounters.day} = current_date`))
    .groupBy(usageCounters.user_id);
  for (const r of rows) map.set(r.user_id, { calls: r.calls, spend: Number(r.spend) });
  return map;
}

/** Latest run's flow name per sandbox (for the project fallback + last-run chip). */
async function latestRunFor(
  sandboxIds: string[],
): Promise<Map<string, { flowName: string; status: string; finishedAt: Date | null }>> {
  const map = new Map<string, { flowName: string; status: string; finishedAt: Date | null }>();
  if (!sandboxIds.length) return map;
  const rows = await db
    .select({
      sandbox_id: flowRuns.sandbox_id,
      flowName: flows.name,
      status: flowRuns.status,
      finished_at: flowRuns.finished_at,
      started_at: flowRuns.started_at,
    })
    .from(flowRuns)
    .innerJoin(flows, eq(flowRuns.flow_id, flows.id))
    .where(inArray(flowRuns.sandbox_id, sandboxIds))
    .orderBy(desc(flowRuns.started_at));
  for (const r of rows) {
    if (!r.sandbox_id || map.has(r.sandbox_id)) continue; // first = newest
    map.set(r.sandbox_id, { flowName: r.flowName, status: r.status, finishedAt: r.finished_at });
  }
  return map;
}

function rowOf(
  s: Sandbox & { ownerName: string; ownerInitials: string | null },
  usage: { calls: number; spend: number } | undefined,
  latest: { flowName: string } | undefined,
) {
  return {
    id: s.id,
    slug: s.slug,
    owner: { name: s.ownerName, initials: s.ownerInitials ?? initialsOf(s.ownerName) },
    project: s.project ?? latest?.flowName ?? null,
    status: s.status,
    suspensionReason: s.suspension_reason,
    isPrimary: s.is_primary,
    region: s.region,
    memCapMb: s.mem_cap_mb,
    startedAt: s.last_active_at,
    llmCallsToday: usage?.calls ?? 0,
    costTodayUsd: usage?.spend ?? 0,
  };
}

// GET /api/sandboxes?status=&q=&page= — paginated, with per-status tab counts.
const listSandboxes = route(async (req) => {
  await requireSuperAdmin(req);
  return runAsSystem('platform-admin', async () => {
  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status');
  const status = STATUSES.includes(statusParam as SbStatus) ? (statusParam as SbStatus) : null;
  const q = url.searchParams.get('q')?.trim();
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);

  // Search predicate spans owner name, project, and slug (joined to users).
  // ⛔ `likeTerm`, NOT `%${q}%` — see utils/search.ts. Slugs are hyphen/underscore-shaped, and
  // `_` is an ILIKE metacharacter, so the raw pattern matched neighbours of the typed slug.
  const like = q ? likeTerm(q) : '';
  const search = q
    ? or(ilike(users.name, like), ilike(sandboxes.project, like), ilike(sandboxes.slug, like))
    : undefined;

  // Per-status counts over the search set (status filter NOT applied → tab totals).
  const countRows = await db
    .select({ status: sandboxes.status, n: sql<number>`count(*)::int` })
    .from(sandboxes)
    .innerJoin(users, eq(sandboxes.owner_id, users.id))
    .where(search)
    .groupBy(sandboxes.status);
  const counts = { all: 0, running: 0, idle: 0, suspended: 0, error: 0 };
  for (const r of countRows) {
    counts[r.status] = r.n;
    counts.all += r.n;
  }

  const where = status ? and(search, eq(sandboxes.status, status)) : search;
  const total = status ? counts[status] : counts.all;

  const rows = await db
    .select({
      id: sandboxes.id,
      owner_id: sandboxes.owner_id,
      slug: sandboxes.slug,
      label: sandboxes.label,
      project: sandboxes.project,
      status: sandboxes.status,
      suspension_reason: sandboxes.suspension_reason,
      is_primary: sandboxes.is_primary,
      region: sandboxes.region,
      mem_cap_mb: sandboxes.mem_cap_mb,
      last_active_at: sandboxes.last_active_at,
      created_at: sandboxes.created_at,
      updated_at: sandboxes.updated_at,
      ownerName: users.name,
      ownerInitials: users.avatar_initials,
    })
    .from(sandboxes)
    .innerJoin(users, eq(sandboxes.owner_id, users.id))
    .where(where)
    // `id` LAST, because `last_active_at` ties freely — every sandbox provisioned by one batch
    // shares a timestamp, and the never-used ones all tie on the same default. A non-total ORDER BY
    // under limit/offset lets Postgres order the tied rows differently for each page's query, so a
    // sandbox can be listed on two pages or on none. See routes/challenges' `orderForSort` header.
    .orderBy(desc(sandboxes.last_active_at), asc(sandboxes.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  const ownerIds = [...new Set(rows.map((r) => r.owner_id))];
  const usage = await usageTodayFor(ownerIds);
  const latest = await latestRunFor(rows.map((r) => r.id));

  const items = rows.map((r) =>
    rowOf(r as never, usage.get(r.owner_id), latest.get(r.id)),
  );
  return jsonResponse({ items, total, page, pageSize: PAGE_SIZE, counts });
  });
});

// GET /api/sandboxes/:id — inspect: sandbox + owner + derived usage + recent runs.
const getSandbox = route(async (req, id) => {
  await requireSuperAdmin(req);
  return runAsSystem('platform-admin', async () => {
  const [sb] = await db
    .select({
      id: sandboxes.id,
      owner_id: sandboxes.owner_id,
      slug: sandboxes.slug,
      label: sandboxes.label,
      project: sandboxes.project,
      status: sandboxes.status,
      suspension_reason: sandboxes.suspension_reason,
      is_primary: sandboxes.is_primary,
      region: sandboxes.region,
      mem_cap_mb: sandboxes.mem_cap_mb,
      last_active_at: sandboxes.last_active_at,
      created_at: sandboxes.created_at,
      updated_at: sandboxes.updated_at,
      ownerName: users.name,
      ownerInitials: users.avatar_initials,
    })
    .from(sandboxes)
    .innerJoin(users, eq(sandboxes.owner_id, users.id))
    .where(eq(sandboxes.id, id!));
  if (!sb) throw notFound('sandbox_not_found', `No sandbox '${id}'`);

  const usage = (await usageTodayFor([sb.owner_id])).get(sb.owner_id);
  const recentRuns = await db
    .select({
      id: flowRuns.id,
      flowName: flows.name,
      status: flowRuns.status,
      total_ms: flowRuns.total_ms,
      total_cost_usd: flowRuns.total_cost_usd,
      llm_calls: flowRuns.llm_calls,
      started_at: flowRuns.started_at,
      finished_at: flowRuns.finished_at,
    })
    .from(flowRuns)
    .innerJoin(flows, eq(flowRuns.flow_id, flows.id))
    .where(eq(flowRuns.sandbox_id, sb.id))
    .orderBy(desc(flowRuns.started_at))
    .limit(10);

  return jsonResponse({
    ...rowOf(sb as never, usage, recentRuns[0] ? { flowName: recentRuns[0].flowName } : undefined),
    label: sb.label,
    createdAt: sb.created_at,
    recentRuns: recentRuns.map((r) => ({
      id: r.id,
      flowName: r.flowName,
      status: r.status,
      totalMs: r.total_ms,
      costUsd: Number(r.total_cost_usd),
      llmCalls: r.llm_calls,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    })),
  });
  });
});

async function loadSandbox(id: string): Promise<Sandbox> {
  const [sb] = await db.select().from(sandboxes).where(eq(sandboxes.id, id));
  if (!sb) throw notFound('sandbox_not_found', `No sandbox '${id}'`);
  return sb;
}

// POST /api/sandboxes/:id/pause — suspend (blocks the owner's runs).
const pauseSandbox = route(async (req, id) => {
  const actor = await requireSuperAdmin(req);
  return runAsSystem('platform-admin', async () => {
  const sb = await loadSandbox(id!);
  await transitionSandbox(sb.id, 'suspended', db, {
    touchActivity: false,
    suspensionReason: 'admin',
  });
  const cancelled = await cancelRunsForSandbox(sb.id);
  await recordAudit({ actorId: actor.id, action: 'sandbox.suspend', category: 'sandbox', targetType: 'sandbox', targetId: sb.slug, result: 'Suspended', resultTone: 'warn' });
  const [updated] = await db.select().from(sandboxes).where(eq(sandboxes.id, sb.id));
  return jsonResponse({ ...updated, cancelledRunIds: cancelled });
  });
});

// POST /api/sandboxes/:id/resume — back to idle (resets the idle clock).
const resumeSandbox = route(async (req, id) => {
  const actor = await requireSuperAdmin(req);
  return runAsSystem('platform-admin', async () => {
  const sb = await loadSandbox(id!);
  if (sb.status !== 'suspended' && sb.status !== 'error') {
    throw unprocessable('not_resumable', `Sandbox is ${sb.status}, not suspended/error`);
  }
  await transitionSandbox(sb.id, 'idle', db, { touchActivity: true });
  await recordAudit({ actorId: actor.id, action: 'sandbox.resume', category: 'sandbox', targetType: 'sandbox', targetId: sb.slug, result: 'Resumed · idle', resultTone: 'ok' });
  const [updated] = await db.select().from(sandboxes).where(eq(sandboxes.id, sb.id));
  return jsonResponse(updated);
  });
});

const provisionSchema = z.object({ ownerId: z.string().uuid().optional() }).strict();

// POST /api/sandboxes — provision a new sandbox (for the caller or a given owner).
const createSandbox = route(async (req) => {
  const actor = await requireSuperAdmin(req);
  return runAsSystem('platform-admin', async () => {
  const body = provisionSchema.parse(await readJsonOptional(req));
  const ownerId = body.ownerId ?? actor.id;
  // Tombstones excluded (0050): provisioning is a GRANT, not attribution, so an offboarded person
  // must not be a valid owner. `ownerId` arrives as a bare caller-supplied uuid with no membership
  // check, so this lookup is the only gate — without the filter a super_admin could mint a sandbox
  // owned by someone who can never sign in to use it.
  const [owner] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, ownerId), isNull(users.deleted_at)));
  if (!owner) throw unprocessable('owner_not_found', `No user '${ownerId}'`);
  const created = await provisionSandbox({ id: owner.id, name: owner.name }, db, owner.tenant_id);
  await recordAudit({ actorId: actor.id, action: 'sandbox.provision', category: 'sandbox', targetType: 'sandbox', targetId: created.slug, result: 'Ready', resultTone: 'ok' });
  return jsonResponse(created, 201);
  });
});

// Owner recovery surface. It deliberately exposes only the caller's primary sandbox and resumes
// only an idle-watchdog suspension. An administrative pause remains fail-closed.
const getMySandbox = route(async (req) => {
  const { user, tenantId } = await resolveTenant(req);
  const [sandbox] = await db
    .select()
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.tenant_id, tenantId),
        eq(sandboxes.owner_id, user.id),
        eq(sandboxes.is_primary, true),
      ),
    )
    .limit(1);
  return jsonResponse(sandbox ? ownerSandboxDto(sandbox) : null);
});

function ownerSandboxDto(sandbox: Sandbox) {
  return {
    id: sandbox.id,
    slug: sandbox.slug,
    status: sandbox.status,
    suspensionReason: sandbox.suspension_reason,
    isPrimary: sandbox.is_primary,
    region: sandbox.region,
  };
}

const resumeMySandbox = route(async (req) => {
  const { user, tenantId } = await resolveTenant(req);
  const resumed = await resumeOwnIdleSandbox(db, { ownerId: user.id, tenantId });
  if (!resumed) {
    const [current] = await db
      .select()
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.tenant_id, tenantId),
          eq(sandboxes.owner_id, user.id),
          eq(sandboxes.is_primary, true),
        ),
      );
    if (!current) throw notFound('sandbox_not_found', 'You do not have a primary sandbox yet.');
    if (current.status === 'suspended' && current.suspension_reason === 'admin') {
      throw unprocessable(
        'sandbox_admin_suspended',
        'This sandbox was paused by an administrator and cannot be self-resumed.',
      );
    }
    throw unprocessable('not_resumable', `Sandbox is ${current.status}, not auto-suspended.`);
  }
  await recordAudit({
    actorId: user.id,
    action: 'sandbox.resume',
    category: 'sandbox',
    targetType: 'sandbox',
    targetId: resumed.slug,
    result: 'Owner resumed · idle watchdog',
    resultTone: 'ok',
  });
  return jsonResponse(ownerSandboxDto(resumed));
});

export function registerSandboxRoutes(router: Router): void {
  router.add('GET', '/api/sandboxes/me', getMySandbox);
  router.add('POST', '/api/sandboxes/me/resume', resumeMySandbox);
  router.add('GET', '/api/sandboxes', listSandboxes);
  router.add('POST', '/api/sandboxes', createSandbox);
  router.add('GET', '/api/sandboxes/:id', getSandbox);
  router.add('POST', '/api/sandboxes/:id/pause', pauseSandbox);
  router.add('POST', '/api/sandboxes/:id/resume', resumeSandbox);
}
