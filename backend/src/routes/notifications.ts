// src/routes/notifications.ts — the in-app notification feed (migration 0044, receipts 0068).
//
// Open to any authenticated member (not admin-gated): a tenant-wide alert like "the welcome budget
// is nearly gone" is something everyone in the workspace benefits from seeing, and RLS already
// scopes every row to the caller's tenant.
//
// Read state is PER READER (`notification_reads`, 0068), so every member — not only a tenant_admin
// — can clear their own badge, and no member can clear anyone else's. See notification-service.ts.
import type { Notification } from '../db/client';
import { validateAuth } from '../middleware/auth';
import { hasTenantAdmin } from '../middleware/admin-guards';
import { jsonResponse, route, notFound } from '../utils/http';
import {
  listNotifications,
  markAllRead,
  markRead,
  unreadCount,
} from '../host/notification-service';
import type { Router } from '../utils/router';

/**
 * Deep links that only a tenant_admin can actually open.
 *
 * A notification's `href` is written by a producer that knows what it is pointing at; this route is
 * the only place that knows WHO is reading. `/llm-settings` is the budget alerts' href and every
 * endpoint behind that page is `requireTenantAdmin` (routes/llm-settings.ts), so handing a member
 * that link turns the whole notification into a button whose only outcome is a 403. The row still
 * reaches them and still explains what happened — it just is not clickable.
 *
 * ⚠️ A HAND-KEPT LIST IS A LIABILITY, so it is not kept by hand: `tests/notifications.test.ts`
 * enumerates every `href:` literal any notification producer in src/ writes and fails if one is
 * neither listed here nor free of an admin guard. A new alert kind pointing at an admin-only page
 * cannot be added without this set noticing.
 */
export const ADMIN_ONLY_HREFS: ReadonlySet<string> = new Set(['/llm-settings']);

/**
 * ⛔ THIS ROUTE DOES NOT NEGOTIATE A LOCALE, AND THAT IS NOT AN OVERSIGHT TO COPY FROM
 * `routes/marketplace-summary.ts` OR `routes/blocks.ts`. Both of those serve content that EXISTS in
 * several languages in the database, so there is something to pick. A notification has exactly one
 * stored sentence, written by a scheduler with no reader in sight — and a tenant-wide row
 * (`user_id IS NULL`) is read by several people who need not share a language, so there is no
 * single reader to negotiate for even in principle.
 *
 * So the split is the one `/it-dash` took in #244: ship `kind` + the machine `data` and let the
 * BROWSER compose the sentence (frontend/src/lib/i18n/notification-label.ts). `title` and `body`
 * ride along as the fallback for rows that have no `data` — every row written before migration
 * 0066, permanently, plus anything an old pod writes mid-roll.
 */
function toView(row: Notification & { read: boolean }, isTenantAdmin: boolean) {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    // ⚠️ NESTED, not spread onto this object — deliberately unlike `ops-metrics.ts`, which puts its
    // machine fields at the top level. There the DTO is composed in code from a typed struct; here
    // the payload round-trips through an unvalidated jsonb column that any future producer fills,
    // and spreading it would let a careless writer shadow `id`, `read` or `href` on the wire.
    data: row.data ?? undefined,
    href: row.href !== null && !isTenantAdmin && ADMIN_ONLY_HREFS.has(row.href) ? null : row.href,
    // ⚠️ THIS READER's read state (a `notification_reads` receipt), not the superseded
    // `notifications.read_at`. A broadcast another member dismissed is still unread here.
    read: row.read,
    createdAt: row.created_at.toISOString(),
  };
}

/** GET /api/notifications?unread=1&limit=30 — newest first. */
const list = route(async (req) => {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  const rows = await listNotifications(user.id, {
    unreadOnly: url.searchParams.get('unread') === '1',
    limit: Number.parseInt(url.searchParams.get('limit') ?? '', 10) || undefined,
  });
  const admin = hasTenantAdmin(user);
  return jsonResponse({
    notifications: rows.map((r) => toView(r, admin)),
    unread: await unreadCount(user.id),
  });
});

/** GET /api/notifications/unread-count — cheap poll for the topbar badge. */
const count = route(async (req) => {
  const user = await validateAuth(req);
  return jsonResponse({ unread: await unreadCount(user.id) });
});

/** POST /api/notifications/:id/read — dismiss one, FOR THIS CALLER. A tenant-wide alert stays
 *  unread for everyone who has not dismissed it themselves (notification-service.markRead). */
const read = route(async (req, id) => {
  const user = await validateAuth(req);
  const ok = await markRead(id!, user.id);
  // Already-read or not-visible are indistinguishable on purpose: a 404 must not tell the caller
  // whether a notification they cannot see exists.
  if (!ok) throw notFound('notification_not_found', `No unread notification '${id}'`);
  return jsonResponse({ id, read: true });
});

/** POST /api/notifications/read-all — dismiss everything this caller may dismiss. */
const readAll = route(async (req) => {
  const user = await validateAuth(req);
  return jsonResponse({ read: await markAllRead(user.id) });
});

export function registerNotificationRoutes(router: Router): void {
  router.add('GET', '/api/notifications', list);
  router.add('GET', '/api/notifications/unread-count', count);
  router.add('POST', '/api/notifications/read-all', readAll);
  router.add('POST', '/api/notifications/:id/read', read);
}
