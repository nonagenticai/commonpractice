// src/ontology/ontology-changes.ts — the /ontology "Recent changes" panel, scoped to ONE workspace.
//
// ⛔ THE DEFECT THIS EXISTS TO FIX. The panel used to call `GET /api/audit?category=data&q=ontology`
// — the PLATFORM audit feed, the same endpoint `/audit` renders. That feed has no tenant predicate
// and cannot have one: `audit_log` has no `tenant_id` column and sits OUTSIDE RLS by design
// (migration 0028), because its whole job is to be the one cross-tenant record. So a super_admin
// opening /ontology — including one scope-switched into a customer's workspace via
// `X-Active-Tenant-Id` — read every OTHER tenant's ontology history in a panel captioned "Recent
// changes", sitting directly under a graph that IS tenant-scoped. Measured: an operator acting into
// tenant A saw "Custom entity 'rival_margin_secret'" from tenant B as the top row.
//
// ⛔⛔ AND THE FIX IS NOT "FILTER THE ROWS THE PAGE ALREADY HAS". Three reasons, each fatal on its
// own, which is why the attribution happens HERE and not in the browser:
//   · the page holds ONE compiled CELL of the graph (industry × department), so a row about the
//     tenant's own entity in a different cell would be dropped as foreign;
//   · a compiled graph MERGES the global ontology into the tenant's, so a `entity_hide` row naming
//     a global entity would be accepted as the reader's when any tenant could have written it;
//   · the feed is paginated at 25 and the panel slices 8, so 25 foreign rows push the reader's own
//     ninth-newest change off a page the browser never sees. That is a drop nothing can count.
//
// HOW A ROW IS ATTRIBUTED — two FACTS, never a guess:
//   1. `metadata->>'tenantId'` — written by every `ontology.*` recordAudit call site as of this
//      change (routes/ontology.ts). Exact, and it is the only thing that can ever attribute a
//      DELETE (the target row is gone by the time the row is read) or a hide/unhide (the target is
//      a GLOBAL entity, owned by nobody).
//   2. the target row's own `tenant_id` — for history written before (1) existed. `target_id` is
//      the `ontology_entities` / `ontology_relations` primary key for those actions, and neither
//      table's `tenant_id` is ever reassigned (grep: no update site touches it — entities do not
//      move between tenants the way USERS do, which is exactly why joining `users.tenant_id` on
//      `actor_id` was rejected as an attribution source: `PATCH /api/admin/users/:id/tenant` makes
//      that join retroactively wrong for every row the user wrote before their move).
//
// ⛔ WHAT IS DELIBERATELY *NOT* JOINED. `ontology_entity_sample` (from `sample_unbind`) and `block`
// (from `derive_block`) targets are unresolvable BY CONSTRUCTION and a join would be theatre: the
// sample row is DELETED before the audit row is written, and `derive_block` records a block SLUG,
// which is unique only per owner (migration 0037) so two tenants can hold the same one. Both are
// attributable through (1) going forward and are counted as unattributed before that.
//
// ⛔ AND WHAT THE CALLER MUST DO WITH `unattributed`. A row that resolves to ANOTHER tenant is not
// this reader's business and is simply absent — that is correct scoping, not a dropped row. A row
// that resolves to NOBODY is different: it MIGHT be the reader's, and dropping it silently is the
// "absent collapsed into empty" failure this codebase keeps shipping. The count is returned so the
// screen can say out loud that it hid something.
//
// ⚠️ AND IT IS A PLATFORM FIGURE, NOT THIS WORKSPACE'S. There is deliberately NO tenant predicate
// on the count and there CANNOT be one: the defining property of these rows is that no workspace
// can be derived for them, so there is nothing to filter on. Five unattributable rows written by
// tenant B raise tenant A's number by exactly five — measured. It is therefore an upper bound on
// what was hidden FROM THIS READER, and the screen copy has to say that in those terms; an earlier
// version of this comment claimed the copy already did while all eight catalogs said only
// "{n} changes … could not be linked to a workspace and are not shown", which a reader under a
// caption about their own workspace reads as their own. The copy now names the platform scope
// (`ontology_recent_changes_unattributed`, 8 catalogs). Note also the asymmetry the copy has to
// survive: `items` is the 8 most recent rows of THIS workspace's, while the count covers the whole
// 30-day window for EVERY workspace. It drains toward 0 as pre-change history ages out, because
// everything written from now on carries `metadata.tenantId`.
//
// ⛔ THE COMPARISON IS CASE-INSENSITIVE, AND THAT IS NOT COSMETIC. `owner_tenant` is TEXT — it has
// to be, because `metadata->>'tenantId'` is jsonb text this code does not control. Every OTHER
// tenant comparison in the codebase is a `uuid` one (`eq(tenants.id, …)`, RLS
// `app_current_tenant_uuid()`), and uuid equality normalises case for free. This one does not, and
// the reader's id arrives here in whatever case the request carried: `readActiveTenantHeader`'s
// `UUID_RE` is `/i` and deliberately accepts an uppercase `X-Active-Tenant-Id`. Measured through
// the real route before the fix: with an uppercase header the reader's own rows returned
// `{"items":[],"unattributed":0}` — accepted, graph rendered, panel blank, ZERO disclosure. And on
// the writer side it is worse: `coalesce` puts `metadata->>'tenantId'` FIRST, so a row stamped in
// any non-canonical case resolves NON-NULL and NON-MATCHING, i.e. "belongs to another workspace" —
// absent AND excluded from `unattributed`, because the whole disclosure keys on
// `owner_tenant IS NULL`. A row about the reader's OWN entity, neither rendered nor counted.
//
// ⛔ AND NOT `owner_tenant::uuid = $1` INSTEAD. That raises 22P02 on the WHOLE query the first time
// anything writes a non-uuid `tenantId` into `metadata` — turning a display bug into a 500 on a
// panel, for data this code does not own. `lower()` cannot fail on any text.
// Defence in depth: the ids are ALSO canonicalised at the two sources (`readActiveTenantHeader`
// and `effectiveHomeTenant` in `middleware/admin-guards.ts`), which stops NEW history being
// stamped in a stray case. The guard here stays regardless — `metadata` is historical data written
// by earlier releases, and no source-side fix reaches backwards.
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '../db/client';

type Db = typeof defaultDb;

/** One row of the panel — the same shape `/api/audit` returns, so the client type is unchanged. */
export interface OntologyChange {
  id: string;
  action: string;
  category: string;
  targetType: string;
  targetId: string | null;
  result: string | null;
  resultTone: 'ok' | 'warn' | 'error' | null;
  createdAt: Date;
  /** `null` when no human wrote the row — the browser supplies the word (see the mapper below). */
  actor: { name: string; initials: string } | null;
}

export interface OntologyChangeFeed {
  items: OntologyChange[];
  /** Rows in the same window that matched `ontology.*` but could not be attributed to ANY
   *  workspace. Never rendered as the reader's; disclosed as a count so the hiding is not silent. */
  unattributed: number;
}

export const DEFAULT_WINDOW_DAYS = 30;
export const DEFAULT_LIMIT = 8;

function initialsOf(name: string): string {
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return (p.length === 1 ? p[0]!.slice(0, 2) : p[0]![0]! + p[p.length - 1]![0]!).toUpperCase();
}

/**
 * `ontology.*` audit rows in the last `days`, with each row's owning tenant resolved.
 *
 * ⚠️ RUN THIS UNDER `runAsSystem`. `ontology_entities` and `ontology_relations` BOTH carry RLS
 * (`relrowsecurity = t`, verified against the live schema — the tables are readable as
 * "global ∪ own tenant"). On a tenant-scoped connection another tenant's entity is INVISIBLE, so
 * the join yields NULL and a row that is definitively someone else's would be counted as
 * UNATTRIBUTED and disclosed to this reader as "might be yours". The route wraps the call; this
 * note is here because nothing in the SQL below makes that visible.
 */
export async function listTenantOntologyChanges(
  tenantId: string,
  opts: { days?: number; limit?: number } = {},
  database: Db = defaultDb,
): Promise<OntologyChangeFeed> {
  const days = opts.days ?? DEFAULT_WINDOW_DAYS;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // NB `e.id::text = al.target_id`, not `al.target_id::uuid = e.id`: `audit_log.target_id` is free
  // text and `derive_block` really does write a slug into it, so casting the TEXT side would raise
  // 22P02 on the whole query the first time anyone derived a block.
  const scoped = sql`
    select
      al.id,
      al.action,
      al.category,
      al.target_type,
      al.target_id,
      al.result,
      al.result_tone,
      al.created_at,
      u.name            as actor_name,
      u.avatar_initials as actor_initials,
      coalesce(
        al.metadata->>'tenantId',
        e.tenant_id::text,
        r.tenant_id::text
      ) as owner_tenant
    from audit_log al
    left join users u on u.id = al.actor_id
    left join ontology_entities  e
      on al.target_type = 'ontology_entity'   and e.id::text = al.target_id
    left join ontology_relations r
      on al.target_type = 'ontology_relation' and r.id::text = al.target_id
    where al.category = 'data'
      and al.action like 'ontology.%'
      and al.created_at >= now() - (${String(days)} || ' days')::interval
  `;

  // ⛔ ONE STATEMENT, NOT TWO, AND THE `scoped` CTE APPEARS TWICE INSIDE IT ON PURPOSE.
  // The list and the disclosure used to be two separate `execute` calls. That is two read
  // snapshots, so a write landing between them could make the panel say "0 hidden" beside a list
  // that had just dropped one — a disclosure that disagrees with the thing it is disclosing about
  // is worse than none. It was also two full 30-day `audit_log` scans plus four joins per page
  // load. Postgres does NOT inline a CTE referenced more than once (the `MATERIALIZED` default
  // since 12), so `scoped` is now computed exactly once and read twice from the same snapshot.
  //
  // `unattributed` is always exactly one row, so the LEFT JOIN keeps the count reachable even when
  // this workspace has nothing to show — a panel that renders only the disclosure is a supported
  // state (`+page.svelte` opens on `changesUnattributed > 0` alone), and an inner join would have
  // silently turned that into an empty panel.
  //
  // ⛔ `lower(owner_tenant) = lower(...)`, NOT `owner_tenant = ...`. See the case note above.
  const raw = (await database.execute(sql`
    with scoped as (${scoped}),
    mine as (
      select * from scoped
       where lower(owner_tenant) = lower(${tenantId})
       order by created_at desc
       limit ${limit}
    ),
    orphaned as (
      select count(*)::int as n from scoped where owner_tenant is null
    )
    select o.n as unattributed, m.*
      from orphaned o
      left join mine m on true
     order by m.created_at desc nulls last
  `)) as unknown as {
    unattributed: number;
    id: string | null;
    action: string;
    category: string;
    target_type: string;
    target_id: string | null;
    result: string | null;
    result_tone: 'ok' | 'warn' | 'error' | null;
    created_at: string | Date;
    actor_name: string | null;
    actor_initials: string | null;
  }[];

  // The `orphaned`-only row (every `m.*` column null) is the "nothing of this workspace's to show"
  // case, not an item.
  const rows = raw.filter((r) => r.id !== null) as (Omit<(typeof raw)[number], 'id'> & {
    id: string;
  })[];

  return {
    items: rows.map((r) => ({
      id: r.id,
      action: r.action,
      category: r.category,
      targetType: r.target_type,
      targetId: r.target_id,
      result: r.result,
      resultTone: r.result_tone,
      // ⛔ NOT `r.created_at` STRAIGHT THROUGH. A raw `db.execute` bypasses drizzle's column
      // parsers, so postgres-js hands back the wire text `2026-08-16 03:57:22.962161+00` — a
      // SPACE, six fractional digits, a two-digit offset. Bun and V8 parse it; the ECMAScript
      // spec does not require it and Safari answers `Invalid Date`, which on this panel renders
      // as a broken timestamp beside every change for one browser's readers only. Normalising to
      // a real `Date` here means `JSON.stringify` emits ISO-8601, exactly what `/api/audit`
      // returned and what `AuditItem.createdAt` is typed as.
      createdAt: new Date(r.created_at),
      // ⛔ `null`, NOT `{ name: 'System', initials: 'SYS' }` — and THIS is the panel where it hurt.
      // "Recente wijzigingen" on /ontology is otherwise fully localized (`ontologyActionLabel`,
      // `timeAgo`), so an unattributed row read "System · Aangepaste entiteit aangemaakt ·
      // 2u geleden": one English word manufactured server-side, in the middle of a Dutch sentence,
      // in the slot a reader scans for a NAME. The server cannot know the reader's language; the
      // absence of a human actor is the fact, and `m.audit_actor_system()` in the browser is the
      // word for it. Same change, same reasoning, as routes/audit.ts — see the longer note there.
      actor: r.actor_name
        ? { name: r.actor_name, initials: r.actor_initials ?? initialsOf(r.actor_name) }
        : null,
    })),
    unattributed: raw[0]?.unattributed ?? 0,
  };
}
