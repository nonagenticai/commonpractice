// scripts/remap-user-sub.ts — re-key ONE CP user from one Keycloak `sub` to another, in one transaction.
//
// Why: realm-per-app P2 (2026-10-21). CommonPractice users move from Keycloak realm `portal` to realm
// `commonpractice`. A user that moves keeps their id (gitops Job realm-move-commonpractice-users) and
// needs nothing here. A user who must ALSO keep their portal account for other apps (Ola: fr / kag via
// tenant merqi) gets a NEW commonpractice-realm id — and CP keys everything on that id: `users.id` IS
// the Keycloak sub (`users.id = users.keycloak_sub`, 0001_init.sql), 40+ foreign keys point at
// `users.id`, and four more columns hold the sub without a foreign key. This script moves all of them.
//
//   bun run scripts/remap-user-sub.ts --from <old sub> --to <new sub>                  # dry run
//   bun run scripts/remap-user-sub.ts --from <old sub> --to <new sub> --apply          # remap
//   bun run scripts/remap-user-sub.ts --from <old> --to <new> --move-licence [--apply] # + seat
//   bun run scripts/remap-user-sub.ts --from <old> --to <new> --resolve-preexisting [--moved-after <ISO>] [--apply]
//
// PRE-EXISTING --to ROW (the user logged in to CP with the NEW sub before this ran): CP's login path
// (services/user-service.ts ensureUser) inserts a workspace-less `users` row id = keycloak_sub = <new>
// and queues a PENDING `signup_approvals` row for it (plus an audit_log row targeting it). The remap
// then cannot insert <new>. Without --resolve-preexisting the run refuses and prints the plan. With it,
// the same transaction first DELETEs that pending approval and that users row, then re-keys as usual.
// It only does so for a STUB OF THE SAME PERSON: lower(email) equals --from's, created at or after the
// Keycloak move (--moved-after <ISO timestamp>; DEFAULT: within the last 24 hours — pass the Job's
// run time when the remap runs later than that), no tenant, not deleted, id = keycloak_sub = <new>,
// and nothing else referencing <new> except pending signup_approvals and audit_log.target_id (those
// audit rows keep pointing at <new>, which is the same person after the remap). Anything more ⇒
// refused, merge by hand. Still a dry run unless --apply is also given.
//
// WHAT --apply DOES, IN ONE TRANSACTION ON THE OWNER POOL (RLS bypassed, reason `platform-admin`:
// the gate is the operator holding `kubectl exec` on the CP pod, which only a super_admin has):
//   1. lock the old `users` row; refuse unless it exists with keycloak_sub = --from and --to is unused;
//   2. free the unique `keycloak_sub` on the old row, INSERT a copy with id = keycloak_sub = --to;
//   3. UPDATE every column that references users(id) — DISCOVERED from pg_constraint at run time, so
//      a foreign key added by a later migration is covered without editing this file — plus the
//      non-FK sub columns in SUB_COLUMNS (each must exist, or the run refuses);
//   4. DELETE the old row (it is now referenced by nothing, so no ON DELETE action fires);
//   5. re-count every column for --from and roll the whole transaction back unless all are zero.
// The dry run prints the same per-table counts inside a READ ONLY transaction and writes nothing.
// Idempotent: --from absent and --to present ⇒ "already remapped", exit 0 (the licence step may run).
//
// --move-licence: the member's `commonpractice` seat on their tenant moves to the new subject.
// ⛔ SAFE ORDER, and why: licences has no "reassign subject" call and `POST /licenses/user/{sub}` is
// idempotent per (subject, tenant, app), so a new subject ALWAYS gets a new licence. Issuing first
// would hold TWO active seats (billed, and refused outright if the tenant is at its seat cap).
// Therefore: REVOKE the old seat first (`revokeMemberEntitlement`, by licence id — releases the seat),
// THEN mint the new one (`ensureMemberEntitlement` with the new sub; `subject_realm` comes from
// KEYCLOAK_USER_REALM, so this must run in a pod whose KEYCLOAK_USER_REALM is `commonpractice`).
// Between the two calls the member holds no seat (seconds). If the mint fails, the member is
// UNLICENSED until it succeeds: re-run the same command — the revoke is already settled and the mint
// is idempotent. It refuses when the tenant is admitted by a tenant-level (bundle) licence, because
// then `ensureMemberEntitlement` would NOT re-mint and the revoke would simply lose the seat.
// Already done (the new subject holds an active `commonpractice` licence on the tenant) ⇒ skipped.
//
// The licences SUBJECT row of the old sub is not touched (it may hold other apps' licences — Ola's
// portal subject does). Prints ids and counts only; never a token.
//
// Exit: 0 ok · 1 usage / refused (nothing written) · 2 licence step failed after the remap committed.
import { sql } from 'drizzle-orm';
import { config } from '../src/config';
import { closeConnection, db, runAsSystem } from '../src/db/client';
import { licencesAdminConfigured, licensesAdmin } from '../src/services/licenses-admin';
import {
  ensureMemberEntitlement,
  revokeMemberEntitlement,
  tenantHoldsTenantLevelLicence,
} from '../src/services/license-provisioning';

/** Non-FK columns that hold a user's Keycloak sub (= users.id). `users.keycloak_sub` is handled by
 *  the row copy itself. Every entry must exist — a renamed/dropped column refuses the run rather
 *  than silently leaving the old sub behind. */
export const SUB_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'signup_approvals', column: 'keycloak_sub' }, // text — the provisioned sub (0027)
  { table: 'tenant_invites', column: 'keycloak_sub' }, // text — the invitee's provisioned sub (0094)
  { table: 'usage_events', column: 'actor_id' }, // uuid — WHO ACTED, = users.keycloak_sub (0090)
  { table: 'tenant_llm_budgets', column: 'created_by' }, // uuid — no FK (0044)
  { table: 'audit_log', column: 'target_id' }, // text — the subject of a `targetType: 'user'` row (0007); no FK
];

export const EXPECTED_USER_REALM = 'commonpractice';
/** Validates --from / --to (parseArgs): a Keycloak sub is a UUID. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RemapRefused extends Error {}

export interface RemapOptions {
  /** delete a pre-existing --to stub (same person, created after the move) in the same transaction */
  resolvePreexisting?: boolean;
  /** ISO timestamp of the Keycloak move; the stub must be created at/after it. Default: now() - 24h */
  movedAfter?: string | null;
}
const opts = (o: boolean | RemapOptions | undefined): RemapOptions =>
  typeof o === 'boolean' ? { resolvePreexisting: o } : (o ?? {});

export interface ColumnRef {
  table: string;
  column: string;
  fk: boolean;
}
export interface ColumnCount extends ColumnRef {
  rows: number;
}
export interface Preexisting {
  userId: string;
  tenantId: string | null;
  deleted: boolean;
  /** pending signup_approvals rows whose keycloak_sub = --to (deleted by --resolve-preexisting) */
  pendingApprovals: number;
  /** audit_log rows whose target_id = --to (kept: they name the same person after the remap) */
  auditTargetRows: number;
  /** every OTHER reference to --to; non-empty ⇒ not a stub, cannot be resolved automatically */
  otherRefs: ColumnCount[];
  /** lower(email) of the --to row equals that of the --from row (same person) */
  sameEmail: boolean;
  /** the cut-off the --to row's created_at was checked against (ISO) */
  movedAfter: string;
  /** why it cannot be resolved automatically; empty ⇒ resolvable */
  blockers: string[];
}
export interface RemapPlan {
  state: 'ready' | 'already_remapped';
  tenantId: string | null;
  columns: ColumnCount[];
  total: number;
  preexisting?: Preexisting;
}

type Exec = { execute: (q: ReturnType<typeof sql.raw>) => Promise<unknown> };

const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const rows = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : ((r as { rows?: T[] }).rows ?? []));

/** Every column that references users(id) by a foreign key, plus SUB_COLUMNS (validated to exist). */
export async function referencingColumns(tx: Exec): Promise<ColumnRef[]> {
  const fks = rows<{ tbl: string; col: string; ncols: number }>(
    await tx.execute(
      sql.raw(`
        SELECT c.conrelid::regclass::text AS tbl, a.attname::text AS col, array_length(c.conkey, 1) AS ncols
          FROM pg_constraint c
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
         WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass
         ORDER BY 1, 2`),
    ),
  );
  const multi = fks.filter((f) => Number(f.ncols) !== 1);
  if (multi.length) throw new RemapRefused(`multi-column FK to users: ${multi.map((m) => m.tbl).join(', ')}`);
  const out: ColumnRef[] = fks.map((f) => ({ table: f.tbl.replace(/^public\./, ''), column: f.col, fk: true }));
  for (const sc of SUB_COLUMNS) {
    const found = rows<{ n: number }>(
      await tx.execute(
        sql.raw(`SELECT count(*)::int AS n FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = ${lit(sc.table)} AND column_name = ${lit(sc.column)}`),
      ),
    );
    if (Number(found[0]?.n ?? 0) !== 1) throw new RemapRefused(`expected column ${sc.table}.${sc.column} is missing`);
    if (!out.some((o) => o.table === sc.table && o.column === sc.column)) out.push({ ...sc, fk: false });
  }
  return out;
}

async function countRefs(tx: Exec, cols: ColumnRef[], sub: string): Promise<ColumnCount[]> {
  const out: ColumnCount[] = [];
  for (const c of cols) {
    const r = rows<{ n: number }>(
      await tx.execute(
        sql.raw(`SELECT count(*)::int AS n FROM public.${ident(c.table)} WHERE ${ident(c.column)}::text = ${lit(sub)}`),
      ),
    );
    out.push({ ...c, rows: Number(r[0]?.n ?? 0) });
  }
  return out;
}

async function userRow(tx: Exec, id: string, lock: boolean): Promise<{ id: string; keycloak_sub: string | null; tenant_id: string | null } | null> {
  const r = rows<{ id: string; keycloak_sub: string | null; tenant_id: string | null }>(
    await tx.execute(
      sql.raw(`SELECT id::text, keycloak_sub, tenant_id::text FROM public.users
                WHERE id::text = ${lit(id)} OR keycloak_sub = ${lit(id)}${lock ? ' FOR UPDATE' : ''}`),
    ),
  );
  if (r.length > 1) throw new RemapRefused(`${id} matches ${r.length} users rows (id vs keycloak_sub disagree)`);
  return r[0] ?? null;
}

/** What a pre-existing --to row holds, and whether it is a stub --resolve-preexisting may remove. */
async function inspectPreexisting(
  tx: Exec,
  cols: ColumnRef[],
  from: string,
  to: string,
  newU: { id: string; keycloak_sub: string | null; tenant_id: string | null },
  movedAfter: string | null | undefined,
): Promise<Preexisting> {
  const cutoff = movedAfter ? `${lit(movedAfter)}::timestamptz` : `now() - interval '24 hours'`;
  const [u] = rows<{ deleted: boolean; same_email: boolean; after_move: boolean; cutoff: string }>(
    await tx.execute(
      sql.raw(`SELECT (s.deleted_at IS NOT NULL) AS deleted,
                      (lower(s.email) IS NOT DISTINCT FROM lower(f.email) AND s.email IS NOT NULL) AS same_email,
                      (s.created_at >= ${cutoff}) AS after_move,
                      to_char((${cutoff}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS cutoff
                 FROM public.users s, public.users f
                WHERE s.id::text = ${lit(newU.id)} AND f.id::text = ${lit(from)}`),
    ),
  );
  const approvals = rows<{ status: string; n: number }>(
    await tx.execute(
      sql.raw(`SELECT status::text AS status, count(*)::int AS n FROM public.signup_approvals
                WHERE keycloak_sub = ${lit(to)} GROUP BY 1 ORDER BY 1`),
    ),
  );
  const pendingApprovals = Number(approvals.find((a) => a.status === 'pending')?.n ?? 0);
  const refs = (await countRefs(tx, cols, to)).filter((c) => c.rows > 0);
  const auditTargetRows = refs.find((c) => c.table === 'audit_log' && c.column === 'target_id')?.rows ?? 0;
  const sa = refs.find((c) => c.table === 'signup_approvals' && c.column === 'keycloak_sub');
  const otherRefs = refs.filter(
    (c) =>
      !(c.table === 'audit_log' && c.column === 'target_id') &&
      !(c.table === 'signup_approvals' && c.column === 'keycloak_sub' && c.rows === pendingApprovals),
  );
  const blockers: string[] = [];
  if (newU.id !== to || newU.keycloak_sub !== to) blockers.push(`its id/keycloak_sub (${newU.id}/${newU.keycloak_sub}) ≠ --to`);
  if (newU.tenant_id) blockers.push(`it already has a workspace (tenant ${newU.tenant_id})`);
  if (u?.deleted) blockers.push('it is soft-deleted (offboarded)');
  if (!u?.same_email) blockers.push("its email differs from --from's — it is a DIFFERENT person, not the same user's stub");
  if (!u?.after_move) blockers.push(`it was created before the move (--moved-after ${u?.cutoff ?? '?'})`);
  if (sa && sa.rows !== pendingApprovals) blockers.push(`it has ${sa.rows - pendingApprovals} DECIDED signup_approvals row(s)`);
  if (otherRefs.length) blockers.push(`other rows reference it: ${fmt(otherRefs)}`);
  return {
    userId: newU.id,
    tenantId: newU.tenant_id,
    deleted: Boolean(u?.deleted),
    pendingApprovals,
    auditTargetRows,
    otherRefs,
    sameEmail: Boolean(u?.same_email),
    movedAfter: u?.cutoff ?? '',
    blockers,
  };
}

/** The operator-facing plan for a pre-existing --to row (printed on refusal and in the dry run). */
export function preexistingPlan(from: string, to: string, p: Preexisting): string {
  const head =
    `--to ${to} already has a users row (tenant ${p.tenantId ?? '-'}) — the user logged in to CP with the new ` +
    `sub before this remap ran.`;
  if (p.blockers.length) {
    return (
      `${head} It is NOT a removable stub: ${p.blockers.join('; ')}. Merge by hand: decide which row's data ` +
      `survives, move the --to references onto --from (or delete them), delete the --to row, then re-run.`
    );
  }
  return (
    `${head} Plan (one transaction): 1) DELETE its ${p.pendingApprovals} pending signup_approvals row(s); ` +
    `2) DELETE users row ${to} (same email as --from, created after ${p.movedAfter}, no workspace, nothing ` +
    `else references it); 3) re-key ${from} → ${to} as ` +
    `usual. ${p.auditTargetRows} audit_log row(s) targeting ${to} are kept (same person after the remap). ` +
    `Run with --resolve-preexisting to see this as a dry run, add --apply to do it.`
  );
}

async function preflight(
  tx: Exec,
  from: string,
  to: string,
  lock: boolean,
  o: RemapOptions = {},
): Promise<RemapPlan & { cols: ColumnRef[] }> {
  const cols = await referencingColumns(tx);
  const oldU = await userRow(tx, from, lock);
  const newU = await userRow(tx, to, lock);
  if (!oldU && newU) {
    const left = (await countRefs(tx, cols, from)).filter((c) => c.rows > 0);
    if (left.length) throw new RemapRefused(`--from is gone from users but still referenced: ${fmt(left)}`);
    return { state: 'already_remapped', tenantId: newU.tenant_id, columns: [], total: 0, cols };
  }
  if (!oldU) throw new RemapRefused(`no users row for --from ${from}`);
  if (oldU.id !== from || oldU.keycloak_sub !== from) {
    throw new RemapRefused(`users row ${oldU.id} does not have id = keycloak_sub = --from; refusing to guess`);
  }
  let preexisting: Preexisting | undefined;
  if (newU) {
    preexisting = await inspectPreexisting(tx, cols, from, to, newU, o.movedAfter);
    const plan = preexistingPlan(from, to, preexisting);
    if (!o.resolvePreexisting || preexisting.blockers.length) {
      throw new RemapRefused(`--to ${to} is already a users id/keycloak_sub (${newU.id}). ${plan}`);
    }
  }
  const columns = await countRefs(tx, cols, from);
  return {
    state: 'ready',
    tenantId: oldU.tenant_id,
    columns,
    total: columns.reduce((s, c) => s + c.rows, 0),
    cols,
    ...(preexisting ? { preexisting } : {}),
  };
}

function fmt(cs: ColumnCount[]): string {
  return cs.map((c) => `${c.table}.${c.column}=${c.rows}`).join(', ');
}

/** Dry run: the per-table counts, inside a READ ONLY transaction. */
export async function planRemap(from: string, to: string, o?: boolean | RemapOptions): Promise<RemapPlan> {
  return runAsSystem('platform-admin', () =>
    db.transaction(
      async (tx) => {
        const { cols: _cols, ...plan } = await preflight(tx as unknown as Exec, from, to, false, opts(o));
        return plan;
      },
      { accessMode: 'read only' },
    ),
  );
}

/** Apply: the whole re-key in ONE transaction; any failure (including the post-check) rolls it back. */
export async function applyRemap(from: string, to: string, o?: boolean | RemapOptions): Promise<RemapPlan> {
  return runAsSystem('platform-admin', () =>
    db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Exec;
      const plan = await preflight(tx, from, to, true, opts(o));
      if (plan.state === 'already_remapped') {
        const { cols: _c, ...p } = plan;
        return p;
      }
      if (plan.preexisting) {
        // A verified stub (preflight refused anything else): its pending approval, then the row. Nothing
        // else references it, so the DELETE fires no ON DELETE action.
        await tx.execute(
          sql.raw(`DELETE FROM public.signup_approvals WHERE keycloak_sub = ${lit(to)} AND status = 'pending'`),
        );
        await tx.execute(
          sql.raw(`DELETE FROM public.users WHERE id = ${lit(to)}::uuid AND keycloak_sub = ${lit(to)} AND tenant_id IS NULL`),
        );
        if (await userRow(tx, to, false)) throw new Error('pre-existing --to row was not removed — rolled back');
      }
      const ucols = rows<{ c: string }>(
        await tx.execute(
          sql.raw(`SELECT column_name::text AS c FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'users' ORDER BY ordinal_position`),
        ),
      ).map((r) => r.c);
      const select = ucols
        .map((c) => (c === 'id' ? `${lit(to)}::uuid` : c === 'keycloak_sub' ? lit(to) : ident(c)))
        .join(', ');
      await tx.execute(sql.raw(`UPDATE public.users SET keycloak_sub = NULL WHERE id = ${lit(from)}::uuid`));
      await tx.execute(
        sql.raw(`INSERT INTO public.users (${ucols.map(ident).join(', ')})
                 SELECT ${select} FROM public.users WHERE id = ${lit(from)}::uuid`),
      );
      for (const c of plan.cols) {
        if (c.table === 'users') continue;
        await tx.execute(
          sql.raw(`UPDATE public.${ident(c.table)} SET ${ident(c.column)} = ${lit(to)}
                    WHERE ${ident(c.column)}::text = ${lit(from)}`),
        );
      }
      await tx.execute(sql.raw(`DELETE FROM public.users WHERE id = ${lit(from)}::uuid`));
      const left = (await countRefs(tx, plan.cols, from)).filter((c) => c.rows > 0);
      if (left.length) throw new Error(`post-check: --from still referenced (${fmt(left)}) — rolled back`);
      const moved = await countRefs(tx, plan.cols, to);
      const before = new Map(plan.columns.map((c) => [`${c.table}.${c.column}`, c.rows]));
      const short = moved.filter((c) => c.rows < (before.get(`${c.table}.${c.column}`) ?? 0));
      if (short.length) throw new Error(`post-check: rows lost (${fmt(short)}) — rolled back`);
      const { cols: _c, ...p } = plan;
      return p;
    }),
  );
}

export type LicenceMoveOutcome =
  | { state: 'already_moved'; licenseId: string }
  | { state: 'moved'; licenseId: string; subjectId: string }
  | { state: 'would_move' };

/** Move the member's `commonpractice` seat on `tenantId` to the subject `to` (revoke-then-issue). */
export async function moveMemberLicence(tenantId: string, to: string, apply: boolean): Promise<LicenceMoveOutcome> {
  if (!licencesAdminConfigured()) throw new RemapRefused('licences admin API is not configured in this environment');
  if (config.keycloak.userRealm !== EXPECTED_USER_REALM) {
    throw new RemapRefused(
      `KEYCLOAK_USER_REALM is '${config.keycloak.userRealm}', not '${EXPECTED_USER_REALM}' — the new licence ` +
        `would be minted with the wrong subject_realm; run this in a pod on the cutover env`,
    );
  }
  if (apply && !config.license.issuanceEnabled) throw new RemapRefused('LICENSE_ISSUANCE_ENABLED is off');
  const appKey = config.license.appKey;
  const client = licensesAdmin();
  if (typeof client.listSubjectLicences !== 'function') {
    throw new RemapRefused('the licences admin client cannot list subject licences — cannot tell whether the seat already moved');
  }
  const held = await client.listSubjectLicences(to);
  const live = held.find((l) => l.tenantId === tenantId && l.status === 'active' && l.appKey === appKey);
  if (live) return { state: 'already_moved', licenseId: live.id };
  if (await tenantHoldsTenantLevelLicence(tenantId)) {
    throw new RemapRefused(
      `tenant ${tenantId} is admitted by a tenant-level licence: ensureMemberEntitlement would NOT re-mint, ` +
        `so revoking the member seat would just lose it — decide by hand`,
    );
  }
  if (!apply) return { state: 'would_move' };
  await revokeMemberEntitlement(tenantId, to); // 1. release the OLD subject's seat (by licence id)
  const out = await ensureMemberEntitlement(tenantId, to, to); // 2. mint for the NEW subject
  if (out.state !== 'active') throw new Error(`mint for the new subject did not settle: ${out.state}`);
  return { state: 'moved', licenseId: out.licenseId, subjectId: out.subjectId };
}

export function parseArgs(argv: string[]): {
  from: string;
  to: string;
  apply: boolean;
  moveLicence: boolean;
  resolvePreexisting: boolean;
  movedAfter: string | null;
} {
  const val = (flag: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? '') : '';
  };
  const from = val('--from').trim().toLowerCase();
  const to = val('--to').trim().toLowerCase();
  if (!UUID.test(from) || !UUID.test(to)) throw new RemapRefused('--from and --to must both be UUIDs (Keycloak subs)');
  if (from === to) throw new RemapRefused('--from and --to are the same');
  const movedAfterRaw = argv.includes('--moved-after') ? val('--moved-after').trim() : '';
  if (argv.includes('--moved-after') && (!movedAfterRaw || Number.isNaN(Date.parse(movedAfterRaw)))) {
    throw new RemapRefused('--moved-after must be an ISO timestamp (the realm-move Job run time)');
  }
  return {
    from,
    to,
    apply: argv.includes('--apply'),
    moveLicence: argv.includes('--move-licence'),
    resolvePreexisting: argv.includes('--resolve-preexisting'),
    movedAfter: movedAfterRaw ? new Date(movedAfterRaw).toISOString() : null,
  };
}

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`[remap] ${(e as Error).message}`);
    console.error(
      'usage: bun run scripts/remap-user-sub.ts --from <old sub> --to <new sub> [--resolve-preexisting [--moved-after <ISO>]] [--move-licence] [--apply]',
    );
    return 1;
  }
  const { from, to, apply, moveLicence, resolvePreexisting, movedAfter } = args;
  let plan: RemapPlan;
  try {
    const o: RemapOptions = { resolvePreexisting, movedAfter };
    plan = apply ? await applyRemap(from, to, o) : await planRemap(from, to, o);
  } catch (e) {
    console.error(`[remap] REFUSED/ROLLED BACK — nothing written: ${(e as Error).message}`);
    return 1;
  }
  if (plan.state === 'already_remapped') {
    console.log(`[remap] ${from} → ${to}: already remapped (no users row for --from).`);
  } else {
    if (plan.preexisting) {
      console.log(`[remap] pre-existing --to row: ${preexistingPlan(from, to, plan.preexisting)}`);
      console.log(
        `[remap] pre-existing --to row ${apply ? 'REMOVED' : 'would be removed'}: users ${to} + ` +
          `${plan.preexisting.pendingApprovals} pending signup_approvals row(s)`,
      );
    }
    for (const c of plan.columns) console.log(`[remap] ${c.table}.${c.column}${c.fk ? '' : ' (no FK)'}: ${c.rows}`);
    console.log(
      `[remap] users row ${from} → ${to} · tenant ${plan.tenantId ?? '-'} · ${plan.total} referencing rows · ` +
        (apply ? 'COMMITTED' : 'DRY RUN — nothing written. Re-run with --apply.'),
    );
  }
  if (!moveLicence) return 0;
  const tenantId = plan.tenantId;
  if (!tenantId) {
    console.error('[licence] user has no tenant — nothing to move');
    return apply ? 2 : 1;
  }
  try {
    const out = await moveMemberLicence(tenantId, to, apply);
    if (out.state === 'already_moved') console.log(`[licence] ${to} already holds active licence ${out.licenseId} on ${tenantId} — skipped.`);
    else if (out.state === 'would_move') console.log(`[licence] DRY RUN — would revoke the old seat on ${tenantId}, then mint for ${to}.`);
    else console.log(`[licence] moved: revoked the old seat, new licence ${out.licenseId} (subject ${out.subjectId}) on ${tenantId}.`);
    return 0;
  } catch (e) {
    console.error(`[licence] FAILED: ${(e as Error).message}`);
    if (apply) {
      console.error('[licence] the DB remap is committed. Re-run the SAME command: the revoke is settled and the mint is idempotent.');
      return 2;
    }
    return 1;
  }
}

if (import.meta.main) {
  let code = 1;
  try {
    code = await main();
  } finally {
    await closeConnection();
  }
  process.exit(code);
}
