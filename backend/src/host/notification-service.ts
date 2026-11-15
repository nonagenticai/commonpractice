// src/host/notification-service.ts — in-app notifications (migration 0044, read receipts 0068).
//
// CP had no notification system at all. This is the minimal one the budget alerts need, kept
// generic so any future alert can use it rather than growing a second mechanism.
//
// Addressing: `user_id` NULL = the whole tenant sees it; set = one recipient. A tenant-wide row is
// how the budget alerts reach every tenant_admin without fanning out one row per admin (and
// without going stale when the admin set changes).
//
// READ STATE: a fact about a (notification, READER) pair, held in `notification_reads` (0068) —
// NOT `notifications.read_at`, which is superseded and no longer read or written here. A
// tenant-wide row is read by several people independently, and one column on the shared row cannot
// record that. See the 0068 header for why receipts beat both alternatives (write-time fan-out;
// scoping the count to what the user may dismiss).
//
// ⛔ ONE PREDICATE. The defect this file shipped was not a wrong WHERE clause, it was TWO of them:
// the badge counted `user_id IS NULL OR user_id = me` while the dismissable set was `user_id = me`
// for anyone who was not a tenant_admin. Every notification CP actually produces is a tenant-wide
// broadcast (host/budget-service.ts is the only production writer), so for a plain member those
// two predicates disagreed on EVERY row: the bell showed 1, the click 404ed, "mark all read"
// returned `{read: 0}`, and the 60-second poll put the badge back — permanently.
//
// So all four surfaces below — the feed, the badge count, mark-one and mark-all — are derived from
// the single `visibleUnreadTo()` fragment, and the two writers embed that same fragment object in
// their statement rather than restating it. They cannot drift apart without deleting the helper.
//
// RLS: `notifications` and `notification_reads` are both §4a strict-tenant, so a request-context
// read is automatically scoped. The scheduler works ACROSS tenants and therefore calls these under
// runAsSystem. RLS is the TENANT boundary and was never the per-user one: "Bob cannot dismiss on
// Alice's behalf" is enforced here, by binding `user_id` to the authenticated caller and never to
// anything the request supplies.
import { desc, getTableColumns, sql, type SQL } from 'drizzle-orm';
import { db, notifications, type NewNotification } from '../db/client';

export interface NotificationInput {
  tenantId: string;
  /** NULL/undefined = addressed to the whole tenant. */
  userId?: string | null;
  kind: string;
  severity?: 'info' | 'warn' | 'critical';
  /**
   * ⚠️ ENGLISH. There is no locale to negotiate against here and no second chance later: a
   * tenant-wide row is read by several people who need not share a language, and the row is written
   * once, by a scheduler, with no reader in sight. So the browser composes what it shows from
   * `kind` + `data` (frontend/src/lib/i18n/notification-label.ts, 0066) and these two are its
   * fallback — required, not deprecated, because a row with no `data` must still say something.
   */
  title: string;
  body?: string;
  href?: string;
  /** Machine fields for the reader's browser (0066). Numbers and identifiers only — never a
   *  pre-composed sentence, which would defeat the point. */
  data?: Record<string, unknown>;
}

/** Insert one notification. Caller supplies tenantId explicitly (the scheduler is cross-tenant). */
export async function createNotification(input: NotificationInput): Promise<void> {
  const row: NewNotification = {
    tenant_id: input.tenantId,
    user_id: input.userId ?? null,
    kind: input.kind,
    severity: input.severity ?? 'info',
    title: input.title,
    body: input.body ?? null,
    href: input.href ?? null,
    data: input.data ?? null,
  };
  await db.insert(notifications).values(row);
}

// ==================================================================================================
// THE PREDICATE. Everything below is built from these three fragments and nothing restates them.
// They are deliberately raw `sql` rather than the `and`/`or` builders, because the same object has
// to serve BOTH a `.where()` on the query builder AND an `INSERT … SELECT` statement — and a
// fragment that only one of the two can consume is how the second copy gets written.
// ==================================================================================================

/** Rows this user is a recipient of: their own + the tenant-wide ones.
 *
 * ⛔ AND ONLY IF THE READER EXISTS LOCALLY. A receipt in `notification_reads` FKs `users.id`, so a
 * principal with no local row cannot be given one — and without this clause the badge counted a
 * broadcast for them while `markRead`/`markAllRead` died on
 * `notification_reads_user_id_fkey` (23503), unhandled, as a 500. That is the divergence this file
 * exists to make impossible, reappearing in a new shape: badge 1, no action can ever clear it.
 *
 * The principal is real — `validateAuth` derives `user.id` from the token `sub` with no `users`
 * lookup, and `provisioning.ts`'s `removeLocalUser` HARD-deletes the local row on the
 * failed-onboard rollback path while the Keycloak identity survives. (Offboarding uses
 * `softDeleteLocalUser`, which leaves the row, so a tombstoned user is unaffected — verified.)
 *
 * Making the count agree (0 visible, 0 dismissable) rather than making the write tolerate a
 * missing row is the choice that keeps ONE predicate. Showing someone a badge they can never
 * clear is the defect; showing nothing until their first tenant-scoped request runs `ensureUser`
 * is recoverable and self-heals. */
export function addressedTo(userId: string): SQL {
  return sql`(${notifications.user_id} IS NULL OR ${notifications.user_id} = ${userId}::uuid)
    AND EXISTS (SELECT 1 FROM users lu WHERE lu.id = ${userId}::uuid)`;
}

/**
 * Has this user dismissed this row? A receipt, not a column on the shared row.
 *
 * The subquery is aliased `r` on purpose: `markRead`/`markAllRead` embed this inside an
 * `INSERT INTO notification_reads … SELECT`, where an unaliased mention would be ambiguous.
 */
export function readBy(userId: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM notification_reads r
    WHERE r.notification_id = ${notifications.id} AND r.user_id = ${userId}::uuid
  )`;
}

/** The single definition of "in this user's badge". The count and the dismissable set are the
 *  SAME SET — that they were not is the whole defect. */
export function visibleUnreadTo(userId: string): SQL {
  return sql`${addressedTo(userId)} AND NOT ${readBy(userId)}`;
}

/** Rows visible to this user: their own + the tenant-wide ones, each carrying THIS reader's read
 *  state. Newest first. */
export async function listNotifications(
  userId: string,
  opts: { limit?: number; unreadOnly?: boolean } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const where = opts.unreadOnly ? visibleUnreadTo(userId) : addressedTo(userId);
  return db
    .select({
      ...getTableColumns(notifications),
      // ⚠️ `read` is per-READER and is the only read flag the wire ever carries. `read_at` on the
      // row is superseded (0068) and is NOT what this reports; a row another member dismissed is
      // still unread here.
      read: sql<boolean>`${readBy(userId)}`.as('read'),
    })
    .from(notifications)
    .where(where)
    .orderBy(desc(notifications.created_at))
    .limit(limit);
}

/** Unread count for the nav badge. Same predicate as `markAllRead` — by construction. */
export async function unreadCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(visibleUnreadTo(userId));
  return row?.n ?? 0;
}

/**
 * Mark one notification read FOR THIS USER, by writing a receipt.
 *
 * ⛔ NO ROLE CHECK, AND THAT IS THE FIX RATHER THAN A RELAXATION. The rule this used to enforce —
 * "the lowest-privileged member must not clear 'your welcome budget is used up' before the
 * tenant_admin who can act on it has seen it" — is real, and it is now STRUCTURAL: a receipt names
 * one user, so nobody at any role can dismiss on anybody else's behalf. The old code bought that
 * guarantee by refusing the member their own dismissal too, which is what left the badge stuck.
 *
 * Returns false for a row that is not addressed to this user (→ 404) and for one they have already
 * dismissed. The `ON CONFLICT DO NOTHING` is what makes the second case atomic: the optimistic
 * panel and the 60-second poll can race to the same key, and the loser reports "already read"
 * rather than inflating anything.
 */
export async function markRead(id: string, userId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    INSERT INTO notification_reads (notification_id, user_id, tenant_id)
    SELECT ${notifications.id}, ${userId}::uuid, ${notifications.tenant_id}
    FROM ${notifications}
    WHERE ${notifications.id} = ${id}::uuid AND ${visibleUnreadTo(userId)}
    ON CONFLICT DO NOTHING
    RETURNING notification_id
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** Mark every notification this user may dismiss read. Returns how many changed.
 *
 *  Set-based on purpose: `WHERE visibleUnreadTo` is the same fragment `unreadCount` filters on, so
 *  the number this returns and the number the badge showed a moment ago are answers to one
 *  question. Reading the ids out and inserting them back would be a second predicate in disguise. */
export async function markAllRead(userId: string): Promise<number> {
  const rows = (await db.execute(sql`
    INSERT INTO notification_reads (notification_id, user_id, tenant_id)
    SELECT ${notifications.id}, ${userId}::uuid, ${notifications.tenant_id}
    FROM ${notifications}
    WHERE ${visibleUnreadTo(userId)}
    ON CONFLICT DO NOTHING
    RETURNING notification_id
  `)) as unknown as unknown[];
  return rows.length;
}
