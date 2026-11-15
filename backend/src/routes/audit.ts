// src/routes/audit.ts — the platform "Audit log" feed (Session 6). Platform-gated.
// Append-only: every mutating action across the app writes a row via recordAudit;
// this surfaces them as a paginated, filterable feed (category chip + time range +
// actor/target search), joined to users for the actor name/initials. Seeded
// historical rows are a labelled fidelity baseline; live actions appear on top.
import { neutralizeFormula } from '../utils/spreadsheet-safe';
import { and, asc, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import { db, auditLog, users } from '../db/client';
import { requireSuperAdmin } from '../middleware/admin-guards';
import { jsonResponse, readJsonOptional, route } from '../utils/http';
import { likeTerm } from '../utils/search';
import type { Router } from '../utils/router';
import { runExport, utcDayString } from '../host/audit-export';

const PAGE_SIZE = 25;
// Every category `recordAudit` is actually called with — verified by walking the call sites, not
// by memory. `data` (31 call sites) and `tenant` (7) were MISSING here: `?category=data` fell
// through the allowlist below and silently returned the unfiltered feed, and `counts.data` /
// `counts.tenant` were seeded to 0 and then overwritten by the groupBy — the rows existed and
// were counted into `counts.all`, so the UI's "All events" total exceeded the sum of everything
// the user could actually select.
//
// ⚠️ HALF OF A CONTRACT. The other half is `AUDIT_CATEGORIES` in
// `frontend/src/lib/types/audit.ts` (the chip row). `frontend/…/audit-categories.backend-contract.test.ts`
// walks THIS list and the `recordAudit` call sites and fails on any drift in either direction.
// Note the zero-fill loop below is what makes an unwritten category render as "0" rather than
// disappearing, so adding a value here is safe before its first row exists.
const CATEGORIES = [
  'sandbox',
  'block',
  'policy',
  'deploy',
  'auth',
  'data',
  'system',
  'tenant',
] as const;
type Category = (typeof CATEGORIES)[number];

function initialsOf(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p.length === 1 ? p[0]!.slice(0, 2) : p[0]![0]! + p[p.length - 1]![0]!).toUpperCase();
}

// ---------------------------------------------------------------------------------------------
// The Result-cell projection: `audit_log.metadata` → the two PUBLIC fields `resultCode` /
// `resultParams`.
//
// ⛔ `metadata` IS AN INTERNAL BAG AND MUST NEVER BE FORWARDED WHOLE. It already carries
// `snapshotId`, the export machinery's `bucket`/`objectKey`/`sha256`, and — on the orphan-actor
// fallback in host/audit-service.ts — `actorSub`, the Keycloak subject of an actor this very feed
// renders as "System". Two derived fields, computed here, nothing else.
//
// ⛔⛔ AND THE ALLOWLIST HAS TO REACH INSIDE `summaryParams`, NOT JUST NAME IT. This is the part
// that was measured wrong. Emitting `resultParams` as a verbatim passthrough of an arbitrary
// sub-object means the payload's top-level shape is fixed while its DEPTH is not: a row seeded with
// `summaryParams: { at: 'z', actorSub: 'kc-inside-params' }` shipped `actorSub` to the browser, and
// `summaryParams: ['zleak']` shipped an ARRAY through a field typed `Record<string, unknown>`.
// Neither is reachable today — `summaryParams` is written in exactly one file (routes/flows.ts) as
// `null` or `{ at }` — but "unreachable today" is a property of the WRITERS, and the next
// `recordAudit` caller to stash something under that key inherits the hole silently. A key
// allowlist that only asserts the top level is the shape of a control that passes its own test and
// still leaks.
//
// ⚠️ ONE FLAT UNION, NOT A PER-CODE TABLE, AND THAT IS DELIBERATE. A per-code map would be a THIRD
// copy of the nine-template contract (backend/src/ai/flow-edit-service.ts declares
// `FlowSummaryParams`; frontend/src/lib/i18n/flow-summary-label.ts consumes it per code), and the
// failure mode of drift between them is a row that silently renders its English fallback instead of
// the reader's language — invisible, and exactly the class of defect this whole change is fixing.
// The union is nine short field names; it is small enough to be obviously right, and it is already
// as tight as the leak needs: `actorSub` is not in it.
//
// ⚠️ STRINGS ONLY, for the same reason: `flowSummaryLabel`'s `has()` predicate renders a param only
// when it is a NON-EMPTY STRING, so a number, an object, or a nested bag under a permitted key can
// never reach a reader's screen. Anything that cannot render is pure leak surface, so it is dropped
// rather than forwarded. An empty projection collapses to `null`, which is the value the label
// already treats as "no params" — the fallback, unchanged.
//
// Mirrors `FlowSummaryParams` in ../ai/flow-edit-service. A tenth template that adds a field must
// add it here too or its sentence silently falls back to English —
// frontend/.../flow-summary-label.backend-contract.test.ts is what reds on the vocabulary drifting.
const SUMMARY_PARAM_KEYS = [
  'slug',
  'nodeId',
  'edgeId',
  'key',
  'source',
  'sourceHandle',
  'target',
  'targetHandle',
  'at',
] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  // `typeof null === 'object'`, and an Array IS an object — both have to be excluded by hand.
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The row's flow-summary code, or `null` for the many rows that legitimately have none. */
function resultCodeOf(metadata: unknown): string | null {
  if (!isPlainObject(metadata)) return null;
  return typeof metadata.summaryCode === 'string' ? metadata.summaryCode : null;
}

/** The declared, string-valued params only — never the sub-object the writer handed us. */
function resultParamsOf(metadata: unknown): Record<string, string> | null {
  if (!isPlainObject(metadata)) return null;
  const raw = metadata.summaryParams;
  if (!isPlainObject(raw)) return null;
  const out: Record<string, string> = {};
  for (const k of SUMMARY_PARAM_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

// Build the time-window + search + category filters shared by the feed and the CSV export,
// so the export is exactly the rows the user is looking at (same filter semantics, no drift).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function buildAuditFilters(url: URL) {
  const catParam = url.searchParams.get('category');
  const category = CATEGORIES.includes(catParam as Category) ? (catParam as Category) : null;
  const range = url.searchParams.get('range') ?? '7d'; // today | 7d | 30d | all | custom
  const q = url.searchParams.get('q')?.trim();

  let sinceClause;
  if (range === 'custom') {
    const fromParam = url.searchParams.get('from');
    const toParam = url.searchParams.get('to');
    const fromC = fromParam && ISO_DATE.test(fromParam)
      ? gte(auditLog.created_at, sql`${fromParam}::timestamptz`)
      : undefined;
    // `to` is an inclusive end date → match through the END of that day.
    const toC = toParam && ISO_DATE.test(toParam)
      ? lte(auditLog.created_at, sql`(${toParam}::date + interval '1 day')`)
      : undefined;
    sinceClause = and(fromC, toC);
  } else {
    const days = range === 'today' ? 1 : range === '30d' ? 30 : range === 'all' ? null : 7;
    sinceClause = days
      ? gte(auditLog.created_at, sql`now() - (${days} || ' days')::interval`)
      : undefined;
  }
  // ⛔ `likeTerm`, NOT `%${q}%` — `%` and `_` are ILIKE metacharacters and `action` values are
  // literally underscore-separated (`dataset_created`), so an auditor pasting one back into the
  // box was matching `dataset<any char>created` too. utils/search.ts owns the escape.
  const like = q ? likeTerm(q) : '';
  const search = q
    ? or(ilike(auditLog.action, like), ilike(auditLog.target_id, like), ilike(users.name, like))
    : undefined;
  return { category, baseWhere: and(sinceClause, search) };
}

// GET /api/audit?category=&range=&q=&page=&from=&to=
//   range=custom + from/to (YYYY-MM-DD) selects an explicit inclusive date window;
//   any other range is a preset relative window (today | 7d | 30d | all).
const getAudit = route(async (req) => {
  await requireSuperAdmin(req);
  const url = new URL(req.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const { category, baseWhere } = buildAuditFilters(url);

  // Per-category counts over the time+search window (category filter NOT applied).
  const countRows = await db
    .select({ category: auditLog.category, n: sql<number>`count(*)::int` })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actor_id, users.id))
    .where(baseWhere)
    .groupBy(auditLog.category);
  const counts: Record<string, number> = { all: 0 };
  for (const c of CATEGORIES) counts[c] = 0;
  for (const r of countRows) {
    counts[r.category] = (counts[r.category] ?? 0) + r.n;
    counts.all = (counts.all ?? 0) + r.n;
  }

  const where = category ? and(baseWhere, eq(auditLog.category, category)) : baseWhere;
  const total = category ? (counts[category] ?? 0) : counts.all;

  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      category: auditLog.category,
      targetType: auditLog.target_type,
      targetId: auditLog.target_id,
      result: auditLog.result,
      resultTone: auditLog.result_tone,
      // ⛔ SELECTED, NEVER SHIPPED. `metadata` is an INTERNAL bag: `snapshotId`, pipeline internals
      // any future `recordAudit` caller stashes, and — on the orphan-actor fallback in
      // host/audit-service.ts — `actorSub`, the Keycloak subject of an actor this very feed renders
      // as "System". It is read here only so the two DERIVED fields below can be computed; a
      // `metadata: r.metadata` passthrough would hand the browser the identity the row anonymised.
      metadata: auditLog.metadata,
      createdAt: auditLog.created_at,
      actorName: users.name,
      actorInitials: users.avatar_initials,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actor_id, users.id))
    .where(where)
    // `id` LAST — the same total order host/audit-export.ts already pages the export by, and for
    // the same reason: one action can write several audit rows in ONE transaction, so `created_at`
    // ties, and a non-total ORDER BY under limit/offset lets Postgres order tied rows differently
    // per page query. On an APPEND-ONLY feed that is a compliance defect, not a cosmetic one: the
    // reader is told the log is complete while an entry sits on no page at all.
    .orderBy(desc(auditLog.created_at), asc(auditLog.id))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);

  const items = rows.map((r) => ({
    id: r.id,
    action: r.action,
    category: r.category,
    targetType: r.targetType,
    targetId: r.targetId,
    result: r.result,
    resultTone: r.resultTone,
    // ⛔ THE DEFECT THESE TWO FIELDS FIX. A Dutch reader saved a checkpoint on /build and read
    // "Handmatig checkpoint" in the flow-history drawer; the SAME event, written by the SAME
    // handler in the SAME transaction, read "Manual checkpoint" here. routes/flows.ts gave the
    // SNAPSHOT a `summary_code` (which frontend/src/lib/i18n/flow-summary-label.ts turns into the
    // reader's own language) and gave the AUDIT ROW the English prose only. The compliance surface
    // contradicted the authoring surface about a row it had just written.
    //
    // The code travels in `metadata` — the jsonb column `recordAudit` ALREADY persists — so this
    // needed no migration and no new column. `result` stays on the wire byte for byte: it is the
    // permanent fallback for the ~90 other English sentences the feed carries, for every row
    // written before this change (audit_log is append-only, there is no backfill and no sweep), and
    // for a checkpoint whose text the USER typed, which deliberately has no code.
    //
    // ⛔ TWO DERIVED FIELDS, NEVER THE BAG — see the note on the `.select()` above.
    //
    // ⚠️ NULL RATHER THAN OMITTED so the shape is the same for every row, and both values are
    // PROJECTED rather than forwarded — including the nested params. See SUMMARY_PARAM_KEYS above
    // for why the allowlist has to reach inside `summaryParams` and not merely name it.
    resultCode: resultCodeOf(r.metadata),
    resultParams: resultParamsOf(r.metadata),
    createdAt: r.createdAt,
    // ⛔ `null`, NOT `{ name: 'System', initials: 'SYS' }`. An audit row with no `actor_id` is a
    // row NO HUMAN wrote — a sweeper, a cron, a webhook. The old shape answered "who?" with an
    // English NOUN manufactured on the server, and the server does not know who is reading: the
    // /ontology "Recente wijzigingen" panel is otherwise fully localized, so a Dutch reader got
    // "System · Aangepaste entiteit aangemaakt · 2u geleden" — one English word inside a Dutch
    // sentence, on the one field that is not a proper name.
    //
    // The absence is the FACT; the words for it belong to the browser (`m.audit_actor_system()`,
    // AuditRow.svelte / routes/ontology/+page.svelte). This is the shape `/api/governance`
    // changelog already ships (`actor: {…} | null`, routes/governance/+page.svelte:312 renders
    // `c.actor?.name ?? m.governance_actor_system()`) — so it is this route catching up, not a new
    // convention.
    //
    // ⚠️ MID-ROLL IS SAFE IN BOTH DIRECTIONS. A NEW frontend answered by an OLD pod receives
    // `{ name: 'System' }` and renders "System" — today's behaviour, no worse. An OLD frontend
    // answered by a NEW pod would render nothing for the name; both consumers of this field ship
    // in the same bundle as this change, and neither is a third party.
    //
    // ⚠️ THE CSV EXPORT BELOW DELIBERATELY KEEPS THE LITERAL 'System' — see its own note.
    actor: r.actorName
      ? { name: r.actorName, initials: r.actorInitials ?? initialsOf(r.actorName) }
      : null,
  }));

  return jsonResponse({ items, total, page, pageSize: PAGE_SIZE, counts });
});

// GET /api/audit/export.csv?category=&range=&q=&from=&to= — download the CURRENT filtered
// feed as CSV (the rows the admin is looking at, across all pages). Platform-gated. Distinct
// from POST /api/audit/export, which is the dated compliance batch written to storage.
const EXPORT_MAX = 10000;
function csvCell(v: unknown): string {
  // Formula-safe first (utils/spreadsheet-safe.ts): `target_id` / `result` carry member-typed names.
  const s = v == null ? '' : neutralizeFormula(String(v));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const getAuditCsv = route(async (req) => {
  await requireSuperAdmin(req);
  const url = new URL(req.url);
  const { category, baseWhere } = buildAuditFilters(url);
  const where = category ? and(baseWhere, eq(auditLog.category, category)) : baseWhere;

  const rows = await db
    .select({
      action: auditLog.action,
      category: auditLog.category,
      targetType: auditLog.target_type,
      targetId: auditLog.target_id,
      result: auditLog.result,
      createdAt: auditLog.created_at,
      actorName: users.name,
    })
    .from(auditLog)
    .leftJoin(users, eq(auditLog.actor_id, users.id))
    .where(where)
    .orderBy(desc(auditLog.created_at))
    .limit(EXPORT_MAX);

  // ⛔ THE CSV STAYS ENGLISH, AND THAT IS A DECISION, NOT AN OVERSIGHT. The feed above hands the
  // reader's browser a null actor because the browser knows the reader's language; this file has no
  // reader. Every other cell it emits is already a machine token in one fixed language — the header
  // row (`time,actor,category,…`), the category enum, the action enum (`ontology.entity_create`),
  // the target_type — and `result` is the backend's own English prose. Translating exactly ONE cell
  // would produce a file whose language depends on who happened to click Download: two exports of
  // the same rows would no longer diff, and a compliance pipeline grepping for the system actor
  // would have to know eight spellings of it. `''` was the other candidate and is worse: it makes an
  // unattributed row indistinguishable from a row whose actor was deleted.
  //
  // ⚠️ THAT NOW COVERS `result` TOO, EXPLICITLY. The FEED above localizes `result` for the rows that
  // carry a `resultCode`, so the CSV and the screen deliberately disagree for those rows — the same
  // asymmetry, for the same reason, as the actor cell one paragraph up: the screen has a reader and
  // the file does not. `result` is emitted here as the raw English the backend composed, which is
  // also exactly what the NDJSON compliance bundle (host/audit-export.ts, a whole-row `select()`)
  // archives, so the two artifacts an auditor diffs against each other still agree with each other.
  const header = ['time', 'actor', 'category', 'event', 'target_type', 'target_id', 'result'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.createdAt.toISOString(),
        r.actorName ?? 'System',
        r.category,
        r.action,
        r.targetType,
        r.targetId ?? '',
        r.result ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="audit-log.csv"',
    },
  });
});

// POST /api/audit/export — trigger a compliance export on demand (Phase 2-F).
// Platform-gated. Body { date?: 'YYYY-MM-DD', force?: boolean }; default = yesterday UTC.
// Used for ad-hoc compliance pulls + the live verification. The run records itself in
// audit_exports and writes an audit.export row.
const postExport = route(async (req) => {
  const actor = await requireSuperAdmin(req);
  const body = (await readJsonOptional(req)) as { date?: string; force?: boolean };
  const date =
    typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : utcDayString(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const result = await runExport({
    date,
    triggeredBy: 'manual',
    actorId: actor.id,
    force: body.force === true,
  });
  return jsonResponse(result);
});

export function registerAuditRoutes(router: Router): void {
  router.add('GET', '/api/audit', getAudit);
  router.add('GET', '/api/audit/export.csv', getAuditCsv);
  router.add('POST', '/api/audit/export', postExport);
}
