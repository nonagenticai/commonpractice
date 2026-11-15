// src/services/seat-limit.ts — the per-tenant seat cap (migration 0044, `tenants.max_members`).
//
// A super-admin decides how many people a tenant-admin may bring into their own workspace. Before
// this, nothing in CP — or anywhere in the cluster's licensing/billing services — modelled seats at
// all: quotas were per-user and platform-global.
//
// Enforced on every path that ADDS a user to a tenant (super-admin invite, tenant-admin create,
// signup approve), immediately before the Keycloak identity is minted — so a rejected invite never
// leaves an orphaned realm user behind. The FOURTH path has no invite and no admin in the loop:
// an SSO/Entra JIT user, whom Keycloak has already created and tenant-bound before CP sees them.
// That one is enforced in `services/user-service.ts` via `claimSeatInTx` (see its doc).
//
// FOUR entry points, because the cap has four jobs. `assertSeatAvailable` is the PRE-FLIGHT: it
// fails a doomed invite early, before any realm write. `claimSeat` is the ENFORCEMENT: it holds the
// tenant row locked across the caller's own member-creating write, which is the only way a
// check-then-act cap survives two invites arriving at once (see its doc). `claimSeatInTx` is that
// same enforcement for a caller that ALREADY owns a transaction and must not open a second one.
// `probeSeatForUser` is the UNLOCKED triage that keeps the lock off the hot JIT path entirely unless
// a seat is genuinely about to be taken (see its doc — the lock is not free).
//
// NOT enforced retroactively: lowering the cap below the current headcount blocks new invites and
// never removes anyone. That is deliberate — a seat cap is a purchasing limit, not a reason to
// silently lock existing people out of work in progress.
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, runAsSystem, tenants, users } from '../db/client';
import { HttpError } from '../utils/http';

export interface SeatUsage {
  used: number;
  /** null = unlimited. */
  max: number | null;
  /** null when unlimited. */
  remaining: number | null;
}

/** The transaction handle `claimSeat` hands to its caller — drizzle's own, no new abstraction. */
export type SeatTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Seats in use (live members + pending, unexpired invites) + cap for a tenant. Reads across
 *  tenants → runAsSystem. */
export async function getSeatUsage(tenantId: string): Promise<SeatUsage> {
  const [row] = await runAsSystem('tenant-parameterised', () =>
    db
      .select({
        max: tenants.max_members,
        // NB: reference the outer table LITERALLY as `tenants.id` — interpolating ${tenants.id}
        // renders as an unqualified "id" that binds to the inner users row, making the count
        // always 0 (same gotcha as routes/admin.ts memberCount).
        // `deleted_at IS NULL` (0050): an offboarded member must stop consuming a seat. Every
        // seat count in this file carries it — miss one and offboarding silently frees nothing.
        // ⛔ PLUS pending, unexpired invites — each reserves a seat, exactly as `claimSeatInTx`
        // enforces it. Counting members only reported free seats the next invite would be refused.
        used: sql<number>`(
          (SELECT count(*)::int FROM users AS su WHERE su.tenant_id = tenants.id AND su.deleted_at IS NULL)
          + (SELECT count(*)::int FROM tenant_invites AS ti
              WHERE ti.tenant_id = tenants.id AND ti.status = 'pending' AND ti.expires_at > now())
        )`,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1),
  );
  const used = row?.used ?? 0;
  const max = row?.max ?? null;
  return { used, max, remaining: max === null ? null : Math.max(0, max - used) };
}

/**
 * Throw 409 `seat_limit_reached` if the tenant has no seat left for a NEW member.
 *
 * `existingEmail` matters more than it looks. Onboarding is deliberately resumable: the approve
 * path checkpoints the Keycloak sub and leaves the approval `pending` so a failure in a later step
 * (licence issuance, say) can be retried. But a retry re-runs this check — and by then the local
 * `users` row from the first attempt already exists, so a tenant sitting exactly on its cap would
 * count that half-onboarded person against itself and 409 forever. That would re-create the very
 * "one-off outage becomes a permanent failure" class this branch set out to remove. So an email
 * that is ALREADY a member of this tenant occupies a seat it has already been counted for, and
 * passes.
 *
 * `details` carries used/max so the UI can say "12 of 12 seats used" instead of a bare error — the
 * whole point of the 409 is that the tenant-admin can see what to ask for.
 */
export async function assertSeatAvailable(
  tenantId: string,
  existingEmail?: string,
): Promise<SeatUsage> {
  // Locks the tenant row for the duration of the check, so a `claimSeat` holding that lock is
  // never counted around: this call blocks until the claim commits and then sees its new member.
  // On its own it is still only a PRE-FLIGHT — see the note on `claimSeat` below.
  return runAsSystem('tenant-parameterised', () => db.transaction((tx) => claimSeatInTx(tx, tenantId, existingEmail)));
}

/**
 * Take a seat and do the work that fills it, atomically.
 *
 * A seat cap is check-then-act, and a check that has already RETURNED cannot stop the write that
 * follows it. Two invites arriving together on the last seat both counted 2-of-3, both passed, and
 * both inserted: `used: 4, max: 3`. A row lock only closes that if it is still held when the seat
 * is actually TAKEN, which means the lock, the count and the caller's user-creating write have to
 * share one transaction. That is what this function is: `SELECT … FOR UPDATE` on the tenant row
 * serialises every concurrent claim for that tenant, so the loser cannot even begin counting until
 * the winner has COMMITTED its new member — and therefore counts it.
 *
 * The Keycloak identity is deliberately NOT minted inside `fn`: a realm write cannot be rolled back
 * by a database ROLLBACK, so `fn` should do the local `users` insert only, and callers keep the
 * cheap `assertSeatAvailable` pre-flight before the realm write so a doomed invite still fails
 * before it leaves an orphaned identity behind.
 *
 * ⚠️ `assertSeatAvailable` is a PRE-FLIGHT ONLY — it releases its lock before the caller inserts.
 * The three CP onboarding routes (approve, invite, tenant-admin create) now wrap their member
 * insert in `claimSeat`, which is what actually enforces the cap.
 *
 * The SSO/JIT first login does NOT come through here: it already owns a transaction (and needs no
 * owner privileges) so it calls `claimSeatInTx` directly — see `services/user-service.ts`.
 */
export async function claimSeat<T>(
  tenantId: string,
  opts: { existingEmail?: string; excludeInviteId?: string },
  fn: (tx: SeatTx) => Promise<T>,
): Promise<T> {
  return runAsSystem('tenant-parameterised', () =>
    db.transaction(async (tx) => {
      await claimSeatInTx(tx, tenantId, opts.existingEmail, { excludeInviteId: opts.excludeInviteId });
      return fn(tx);
    }),
  );
}

/**
 * The cap check itself, against a tenant row locked FOR UPDATE — the ONE copy of the locking logic.
 *
 * `SELECT … FOR UPDATE` and not `getSeatUsage`'s correlated subquery: the lock is the whole point,
 * and it must be taken on the TENANT row (the one thing every concurrent claim for this workspace
 * shares) rather than on the members being counted, which do not exist yet. The lock is held until
 * the CALLER'S transaction commits, so the caller must fill the seat inside `tx` — a second
 * transaction would re-open exactly the check-then-act race described on `claimSeat`.
 *
 * Under the same lock:
 *   • a workspace that is not `active`, or carries `offboarded_at`, seats nobody → 409
 *     `tenant_not_active` (checked even when uncapped);
 *   • `used` = live members + pending, unexpired invites — an invite reserves its seat. The invite
 *     being accepted (`excludeInviteId`) and any pending invite to the person being seated
 *     (`seatEmail`, defaulting to `existingEmail`) are not counted, so a person can always take the
 *     seat their own invite reserved.
 *
 * `tenant_invites` is RLS-scoped (0094): run this in a transaction scoped to `tenantId`
 * (`withTenantTransaction`, or the JIT request's own) or under `runAsSystem` — never in a transaction
 * bound to ANOTHER tenant, where the pending-invite count would silently read zero.
 */
export async function claimSeatInTx(
  tx: SeatTx,
  tenantId: string,
  existingEmail?: string,
  opts: { excludeInviteId?: string; seatEmail?: string } = {},
): Promise<SeatUsage> {
  const [tenantRow] = await tx
    .select({ max: tenants.max_members, status: tenants.status, offboardedAt: tenants.offboarded_at })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .for('update');
  if (tenantRow && (tenantRow.status !== 'active' || tenantRow.offboardedAt)) {
    throw new HttpError(
      409,
      'tenant_not_active',
      'This workspace is suspended or offboarded and cannot take new members.',
      { status: tenantRow.status, offboarded: tenantRow.offboardedAt != null },
    );
  }
  const max = tenantRow?.max ?? null;
  const members = await countMembers(tx, tenantId);
  if (max === null) return { used: members, max: null, remaining: null };
  const pending = await countPendingInvites(
    tx,
    tenantId,
    opts.seatEmail ?? existingEmail,
    opts.excludeInviteId,
  );
  const used = members + pending;
  const usage: SeatUsage = { used, max, remaining: Math.max(0, max - used) };

  if (used >= max && existingEmail) {
    const [alreadyMember] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.tenant_id, tenantId),
          isNull(users.deleted_at),
          sql`lower(${users.email}) = lower(${existingEmail})`,
        ),
      )
      .limit(1);
    if (alreadyMember) return usage; // occupies a seat it is already counted for
  }
  if (used >= max) {
    throw new HttpError(
      409,
      'seat_limit_reached',
      `This workspace has used all ${max} of its seats. Ask your Common Practice contact to raise the limit.`,
      { used, max },
    );
  }
  return usage;
}

/** Pending, unexpired invites — each reserves a seat. Excludes `excludeInviteId` and any invite to
 *  `email` (the person being seated cannot also be a reservation). */
function countPendingInvites(
  tx: SeatTx,
  tenantId: string,
  email: string | undefined,
  excludeInviteId: string | undefined,
): Promise<number> {
  return tx
    .execute(
      sql`SELECT count(*)::int AS n FROM tenant_invites ti
           WHERE ti.tenant_id = ${tenantId}
             AND ti.status = 'pending'
             AND ti.expires_at > now()
             ${excludeInviteId ? sql`AND ti.id <> ${excludeInviteId}` : sql``}
             ${email ? sql`AND lower(ti.email) <> lower(${email})` : sql``}`,
    )
    .then((rows) => Number((rows as unknown as { n: number }[])[0]?.n ?? 0));
}

/** LIVE headcount for a tenant — tombstoned members (0050) do not occupy a seat. Indexed by the
 *  partial `users_tenant_id_active_idx` (0050), which replaces the plain `users_tenant_id_idx`
 *  (0048) for this predicate; before 0048 this was a full sequential scan on every seat check. */
function countMembers(tx: SeatTx, tenantId: string): Promise<number> {
  return tx
    .select({ used: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.tenant_id, tenantId), isNull(users.deleted_at)))
    .then(([row]) => row?.used ?? 0);
}

/** What the unlocked triage needs to know, in one round trip. */
export interface JitSeatProbe {
  /** null = uncapped. */
  max: number | null;
  /** Headcount. Only populated when `max` is non-null — see the doc on `probeSeatForUser`. */
  used: number;
  /** This user's own `users.tenant_id`, or null if they hold no seat yet. */
  seat: string | null;
  /** `status = 'active'` and not offboarded. Unlocked — `claimSeatInTx` re-checks under the lock. */
  active: boolean;
}

/**
 * UNLOCKED seat triage against the caller's own transaction — the cheap decision about whether the
 * lock is worth taking at all.
 *
 * `claimSeatInTx` is correct but not free: it takes a row lock that serialises every concurrent
 * claim for the tenant, and each waiter holds one of the four `DB_TX_POOL_MAX` transaction slots
 * while it queues. That is the right trade for an invite. It is the wrong trade for the SSO/JIT
 * first-login path, which re-runs on EVERY request from EVERY user the cap has refused, forever:
 * 39 concurrent refused logins pushed unrelated tenants' transactions from ~2 ms to 260 ms, and
 * five queued behind a single held tenant row starved the pool outright.
 *
 * The lock only exists to prevent OVER-admission. It is therefore unnecessary on the two outcomes
 * that admit nobody:
 *   • no cap at all (the default, and the overwhelming majority of first logins) — nothing to race,
 *   • already at the cap — refusing is fail-closed and idempotent, and the worst an unlocked read
 *     can do is refuse someone who would have fit a microsecond later, who is refused for exactly
 *     one request and admitted on their next one.
 * Only the admit-into-a-capped-tenant case needs the lock, and that happens once per member ever.
 * This is the same pre-flight/enforcement split `assertSeatAvailable` + `claimSeat` already use.
 *
 * ONE round trip, deliberately. The transaction slot is the scarce resource here, not the query:
 * three statements instead of one triples how long each refusal pins a slot, and with 39 refusals
 * queued on four slots that showed up directly as collateral latency for unrelated tenants
 * (271 ms vs a 64 ms floor). Folding the cap, the headcount and the caller's own seat into a single
 * statement puts refusal back on par with the do-nothing fast path.
 *
 * ⚠️ `used` is 0 when `max` is null rather than counted: `CASE` short-circuits, so an uncapped
 * tenant never pays for the headcount at all. Never read `used` without checking `max` first —
 * `getSeatUsage` is the one that always answers truthfully.
 *
 * The correlated subqueries are hand-written rather than composed from drizzle column refs: an
 * interpolated `${tenants.id}` renders UNQUALIFIED and would bind to the inner `users` row, making
 * the count silently 0 (the same trap documented on `getSeatUsage`). Explicit `su.`/`t.` aliases.
 */
export async function probeSeatForUser(
  tx: SeatTx,
  tenantId: string,
  userId: string,
  email?: string | null,
): Promise<JitSeatProbe> {
  // Both subqueries exclude tombstones (0050). The `used` count for the obvious reason — an
  // offboarded member must not hold a seat. The `seat` read for a subtler one: it is what the
  // caller uses to decide "this person is already seated, let them straight through", and a
  // tombstoned row keeps its `tenant_id`. Without the predicate, an offboarded person signing back
  // in via SSO would read as already-seated and be readmitted to the workspace for free, past the
  // cap. `ensureUser` refuses them outright as well — this is the belt to that pair of braces.
  const rows = (await tx.execute(sql`
    SELECT t.max_members AS max,
           (t.status = 'active' AND t.offboarded_at IS NULL) AS active,
           CASE WHEN t.max_members IS NULL THEN 0
                ELSE (SELECT count(*)::int FROM users su
                       WHERE su.tenant_id = t.id AND su.deleted_at IS NULL)
                   + (SELECT count(*)::int FROM tenant_invites ti
                       WHERE ti.tenant_id = t.id AND ti.status = 'pending' AND ti.expires_at > now()
                         ${email ? sql`AND lower(ti.email) <> lower(${email})` : sql``}) END AS used,
           (SELECT u.tenant_id FROM users u
             WHERE u.id = ${userId} AND u.deleted_at IS NULL) AS seat
      FROM tenants t
     WHERE t.id = ${tenantId}
  `)) as unknown as { max: number | null; active: boolean; used: number; seat: string | null }[];
  const row = rows[0];
  // No row at all = an unprovisioned tenant in the claim. Uncapped, so nothing to enforce; the
  // FK-safe nested SELECT in the caller's UPDATE turns the write into a no-op.
  if (!row) return { max: null, used: 0, seat: null, active: true };
  return {
    max: row.max ?? null,
    used: Number(row.used ?? 0),
    seat: row.seat ?? null,
    active: row.active === true,
  };
}

/**
 * Revoke every pending invite to `email` in `tenantId`, inside the caller's seating transaction.
 * Called whenever a person is seated or their level changes: a stale invite must not later re-seat
 * them at the level it was written with. `exceptInviteId` keeps the invite being accepted.
 */
export async function revokePendingInvitesInTx(
  tx: SeatTx,
  tenantId: string,
  email: string,
  exceptInviteId?: string,
): Promise<number> {
  const rows = (await tx.execute(sql`
    UPDATE tenant_invites SET status = 'revoked', revoked_at = now()
     WHERE tenant_id = ${tenantId}
       AND status = 'pending'
       AND lower(email) = lower(${email})
       ${exceptInviteId ? sql`AND id <> ${exceptInviteId}` : sql``}
    RETURNING id
  `)) as unknown as { id: string }[];
  return rows.length;
}
