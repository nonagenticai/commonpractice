// tests/notifications.test.ts — the in-app notification feed (migration 0044, routes/notifications.ts).
//
// The feed is the PRIMARY channel for budget alerts (email is best-effort), so the behaviours that
// matter are: a tenant-wide row reaches every member, a user-addressed row reaches only them, the
// unread count drives the badge honestly, and marking read is idempotent.
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { db, notifications, tenants, users } from '../src/db/client';
import { Router } from '../src/utils/router';
import { ADMIN_ONLY_HREFS, registerNotificationRoutes } from '../src/routes/notifications';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { createNotification } from '../src/host/notification-service';
import type { User } from '../src/types';

const TENANT = '00000000-0000-4000-8000-0000000d1001';
const ALICE = '00000000-0000-4000-8000-0000000d1011';
const BOB = '00000000-0000-4000-8000-0000000d1012';

const asUser = (id: string, roles: string[] = ['member']): User => ({
  id,
  email: `${id}@notify.test`,
  name: id,
  roles,
  tenantId: TENANT,
});
const asAdmin = (id: string) => asUser(id, ['tenant_admin']);

let currentUser: User = asUser(ALICE);

const router = new Router();
registerNotificationRoutes(router);

async function call(method: string, path: string): Promise<Response> {
  const pathname = path.split('?')[0]!;
  const m = router.match(method, pathname);
  if (!m) throw new Error(`no route for ${method} ${path}`);
  return m.handler(new Request(`http://t${path}`, { method }), ...m.params);
}

async function cleanup() {
  await db.delete(notifications).where(eq(notifications.tenant_id, TENANT));
  await db.delete(users).where(inArray(users.id, [ALICE, BOB]));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  __setAuthOverridesForTests({ validateAuth: async () => currentUser });
  await cleanup();
  await db.insert(tenants).values({ id: TENANT, name: 'Notify Co', slug: 'notify-co' });
  await db.insert(users).values([
    { id: ALICE, email: 'alice@notify.test', name: 'Alice', tenant_id: TENANT },
    { id: BOB, email: 'bob@notify.test', name: 'Bob', tenant_id: TENANT },
  ]);
  currentUser = asAdmin(ALICE);
}, 30_000);

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  await cleanup();
}, 30_000);

test('a TENANT-WIDE notification is visible to every member', async () => {
  await createNotification({
    tenantId: TENANT,
    kind: 'budget.threshold',
    severity: 'warn',
    title: '75% of the welcome budget used',
    body: 'Add your own key.',
    href: '/llm-settings',
  });

  for (const who of [ALICE, BOB]) {
    currentUser = asUser(who); // plain members — everyone SEES a tenant-wide alert
    const res = await call('GET', '/api/notifications');
    expect(res.status).toBe(200);
    const out = (await res.json()) as {
      notifications: { title: string; href: string | null }[];
      unread: number;
    };
    expect(out.notifications.length).toBe(1);
    expect(out.notifications[0]!.title).toBe('75% of the welcome budget used');
    expect(out.unread).toBe(1);
    // ⚠️ CHANGED ASSERTION. This line used to read `.toBe('/llm-settings')` for a plain member.
    // The alert reaching them is the behaviour this test exists for and it is unchanged; the LINK
    // was never followable — every endpoint behind /llm-settings is requireTenantAdmin, so a member
    // who clicked it got a 403. The row still arrives and still says what happened.
    expect(out.notifications[0]!.href).toBeNull();
  }

  currentUser = asAdmin(ALICE); // ...and the reader who CAN act on it still gets the link
  const admin = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: { href: string | null }[];
  };
  expect(admin.notifications[0]!.href).toBe('/llm-settings');
});

test('a USER-addressed notification is invisible to everyone else', async () => {
  await createNotification({ tenantId: TENANT, userId: ALICE, kind: 'x', title: 'For Alice only' });

  currentUser = asUser(ALICE);
  const mine = (await (await call('GET', '/api/notifications')).json()) as { notifications: unknown[] };
  expect(mine.notifications.length).toBe(1);

  currentUser = asUser(BOB);
  const bob = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: unknown[];
    unread: number;
  };
  expect(bob.notifications.length).toBe(0);
  expect(bob.unread).toBe(0);
});

test('the unread count is a cheap standalone endpoint and tracks reads', async () => {
  await createNotification({ tenantId: TENANT, kind: 'a', title: 'one' });
  await createNotification({ tenantId: TENANT, kind: 'b', title: 'two' });

  expect(((await (await call('GET', '/api/notifications/unread-count')).json()) as { unread: number }).unread).toBe(2);

  const list = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: { id: string }[];
  };
  const first = list.notifications[0]!.id;
  expect((await call('POST', `/api/notifications/${first}/read`)).status).toBe(200);
  expect(((await (await call('GET', '/api/notifications/unread-count')).json()) as { unread: number }).unread).toBe(1);
});

test('?unread=1 filters to unread only', async () => {
  await createNotification({ tenantId: TENANT, kind: 'a', title: 'one' });
  await createNotification({ tenantId: TENANT, kind: 'b', title: 'two' });
  const all = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: { id: string }[];
  };
  await call('POST', `/api/notifications/${all.notifications[0]!.id}/read`);

  const unread = (await (await call('GET', '/api/notifications?unread=1')).json()) as {
    notifications: unknown[];
  };
  expect(unread.notifications.length).toBe(1);
});

test('marking an already-read notification is a 404, not a silent success', async () => {
  await createNotification({ tenantId: TENANT, kind: 'a', title: 'one' });
  const list = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: { id: string }[];
  };
  const id = list.notifications[0]!.id;
  expect((await call('POST', `/api/notifications/${id}/read`)).status).toBe(200);
  expect((await call('POST', `/api/notifications/${id}/read`)).status).toBe(404);
});

test('read-all clears the badge in one call', async () => {
  for (let i = 0; i < 3; i++) {
    await createNotification({ tenantId: TENANT, kind: 'a', title: `n${i}` });
  }
  const res = await call('POST', '/api/notifications/read-all');
  expect(((await res.json()) as { read: number }).read).toBe(3);
  expect(((await (await call('GET', '/api/notifications/unread-count')).json()) as { unread: number }).unread).toBe(0);
});

test('an unknown id is a 404 and never leaks whether it exists', async () => {
  const res = await call('POST', '/api/notifications/00000000-0000-4000-8000-0000000d1fff/read');
  expect(res.status).toBe(404);
});

test('newest first, and the list is bounded', async () => {
  for (let i = 0; i < 5; i++) {
    await createNotification({ tenantId: TENANT, kind: 'a', title: `n${i}` });
  }
  const out = (await (await call('GET', '/api/notifications?limit=3')).json()) as {
    notifications: { title: string }[];
  };
  expect(out.notifications.length).toBe(3);
  expect(out.notifications[0]!.title).toBe('n4'); // most recent first
});

test('a plain MEMBER cannot dismiss a tenant-wide alert for everyone', async () => {
  // The budget alerts are tenant-wide rows whose audience is admins. Letting the lowest-privileged
  // member clear "your welcome budget is used up" would silence it before an admin ever saw it.
  //
  // ⛔ THE RULE IS UNCHANGED AND STILL PINNED HERE. WHAT CHANGED IS THE MECHANISM, AND THIS TEST'S
  // TWO ASSERTIONS ABOUT IT. It used to assert the member's dismissal was a 404 and their
  // "mark all read" a `{read: 0}`. Those two lines were the ONLY thing the old implementation could
  // do to keep the rule, and they are also the entire user-visible defect: they froze the badge at
  // 1 for every member of every tenant, forever, because the count and the dismissable set were
  // built from different predicates (`user_id IS NULL OR user_id = me` vs `user_id = me`) and CP's
  // only notification producer writes exclusively the row they disagree about.
  //
  // Per-reader receipts (0068) keep BOTH halves of the rule, which the 404 could only ever do by
  // taking one away: the member clears their OWN badge (200 / `{read: 1}`), and the admin's copy is
  // untouched. "A member must not dismiss on another's behalf" is now structural — a receipt names
  // one user — instead of resting on a role check that also blocked the member's own dismissal.
  //
  // A 404 here would now be the regression, not the guarantee.
  await createNotification({
    tenantId: TENANT,
    kind: 'budget.threshold',
    severity: 'critical',
    title: 'Welcome budget used up',
  });

  currentUser = asAdmin(ALICE);
  const list = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: { id: string }[];
  };
  const id = list.notifications[0]!.id;

  currentUser = asUser(BOB); // member — dismisses it for HIMSELF, via both paths
  expect((await call('POST', `/api/notifications/${id}/read`)).status).toBe(200);
  expect(((await (await call('POST', '/api/notifications/read-all')).json()) as { read: number }).read).toBe(0); // nothing left of his own
  expect(((await (await call('GET', '/api/notifications/unread-count')).json()) as { unread: number }).unread).toBe(0);

  // still unread for the admin
  currentUser = asAdmin(ALICE);
  expect(((await (await call('GET', '/api/notifications/unread-count')).json()) as { unread: number }).unread).toBe(1);

  // ...and the admin CAN dismiss it.
  expect((await call('POST', `/api/notifications/${id}/read`)).status).toBe(200);
});

test("a member's read-all does not clear a tenant-wide alert for the admin", async () => {
  // The bulk path deserves its own rung: `markAllRead` is a set-based INSERT … SELECT, so a missing
  // user_id binding there would silently dismiss the whole tenant's feed in one call — a much
  // bigger blast radius than the single-row path, and invisible to a test that only checks counts
  // from the actor's own side.
  for (let i = 0; i < 3; i++) {
    await createNotification({ tenantId: TENANT, kind: 'budget.threshold', title: `alert ${i}` });
  }

  currentUser = asUser(BOB);
  expect(((await (await call('POST', '/api/notifications/read-all')).json()) as { read: number }).read).toBe(3);
  expect(((await (await call('GET', '/api/notifications/unread-count')).json()) as { unread: number }).unread).toBe(0);

  currentUser = asAdmin(ALICE);
  expect(((await (await call('GET', '/api/notifications/unread-count')).json()) as { unread: number }).unread).toBe(3);
});

test('the badge count and the dismissable set are the same set, by construction', async () => {
  // ⛔ THE INVARIANT THE DEFECT BROKE, asserted directly rather than through its symptoms. Whatever
  // the badge counts must be exactly what "mark all read" can clear — for EVERY role, and for a
  // feed mixing both addressing modes. Two predicates that merely agree today drift apart the next
  // time one of them is edited; this fails the moment they do.
  await createNotification({ tenantId: TENANT, kind: 'budget.threshold', title: 'broadcast' });
  await createNotification({ tenantId: TENANT, userId: BOB, kind: 'x', title: 'for Bob' });
  await createNotification({ tenantId: TENANT, userId: ALICE, kind: 'x', title: 'for Alice' });

  for (const who of [asUser(BOB), asAdmin(ALICE)]) {
    currentUser = who;
    const counted = ((await (await call('GET', '/api/notifications/unread-count')).json()) as {
      unread: number;
    }).unread;
    const cleared = ((await (await call('POST', '/api/notifications/read-all')).json()) as {
      read: number;
    }).read;
    expect(cleared).toBe(counted);
    expect(
      ((await (await call('GET', '/api/notifications/unread-count')).json()) as { unread: number })
        .unread,
    ).toBe(0);
  }
});

test('a member CAN dismiss a notification addressed to them personally', async () => {
  await createNotification({ tenantId: TENANT, userId: BOB, kind: 'x', title: 'For Bob' });
  currentUser = asUser(BOB);
  const list = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: { id: string }[];
  };
  expect((await call('POST', `/api/notifications/${list.notifications[0]!.id}/read`)).status).toBe(200);
});

// ==================================================================================================
// ⛔ THE MACHINE FIELDS (migration 0066). `title`/`body` are ENGLISH composed by the scheduler with
// no reader in sight, so `routes/notifications.ts` cannot negotiate a locale for them and a
// tenant-wide row has no single reader to negotiate for anyway. The wire therefore carries `kind` +
// `data` and the BROWSER composes the sentence (frontend/src/lib/i18n/notification-label.ts).
//
// These tests pin the BACKEND half of that contract. Without them the frontend renders from fields
// nothing produces, and the whole change is green on both sides while shipping nothing.
// ==================================================================================================
test('the wire carries `data` alongside the English prose, not instead of it', async () => {
  await createNotification({
    tenantId: TENANT,
    kind: 'budget.threshold',
    severity: 'critical',
    title: 'Welcome budget used up',
    body: 'The $50.00 welcome budget for Notify Co is fully consumed.',
    href: '/llm-settings',
    // ⚠️ `remainingUsd: 0` — legal, and the entire point of this rung. A `!x` presence check
    // anywhere in the chain drops the most urgent alert CP sends back to English.
    data: { threshold: 100, tenantName: 'Notify Co', limitUsd: 50, remainingUsd: 0 },
  });

  currentUser = asAdmin(ALICE);
  const out = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: { title: string; body: string; data?: Record<string, unknown> }[];
  };
  const row = out.notifications[0]!;
  expect(row.data).toEqual({ threshold: 100, tenantName: 'Notify Co', limitUsd: 50, remainingUsd: 0 });
  // ⛔ AND THE PROSE IS STILL THERE. An old frontend renders `title`/`body` and knows nothing about
  // `data`; the browser reaches the API through the k8s Service, which load-balances across old and
  // new pods for the length of a rolling deploy. Dropping the prose breaks that half.
  expect(row.title).toBe('Welcome budget used up');
  expect(row.body).toContain('fully consumed');
});

test('a row with NO `data` omits the key rather than sending null', async () => {
  // Every row written before 0066 is this shape, permanently — there is nothing to backfill it
  // from. `undefined` (absent) is what the frontend's optional field is typed as; a literal `null`
  // would satisfy neither `data?.threshold` nor a `=== undefined` check written against the type.
  await createNotification({ tenantId: TENANT, kind: 'budget.threshold', title: 'Legacy row' });
  currentUser = asAdmin(ALICE);
  const out = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: Record<string, unknown>[];
  };
  expect(out.notifications[0]!.data).toBeUndefined();
  expect('data' in JSON.parse(JSON.stringify(out.notifications[0]))).toBe(false);
  expect(out.notifications[0]!.title).toBe('Legacy row');
});

// ==================================================================================================
// ⛔ THE BADGE THAT CANNOT BE CLEARED — the user story, end to end.
//
// The ONLY production writer of notifications is host/budget-service.ts (`user_id: null`, a
// tenant-wide broadcast), so EVERY notification CP actually produces is a broadcast. The unread
// COUNT has always counted broadcasts for everyone (`user_id IS NULL OR user_id = me`) while the
// DISMISSABLE set was `user_id = me` for anyone who is not a tenant_admin. Two predicates over one
// feed, disagreeing on the exact rows the product emits.
//
// The tests below walk what a member sees rather than what an endpoint returns: badge 1 → dismiss →
// badge still 1, for BOTH dismissal paths the UI offers. A test that only asserts the 404 pins the
// mechanism and misses the outcome — which is how this shipped.
// ==================================================================================================
test('a member who dismisses the only notification CP produces has an EMPTY badge afterwards', async () => {
  // Exactly the row host/budget-service.ts writes when the tenant crosses 75%.
  await createNotification({
    tenantId: TENANT,
    kind: 'budget.threshold',
    severity: 'warn',
    title: '75% of the welcome budget used',
    body: 'Add your own key.',
    href: '/llm-settings',
    data: { threshold: 75, tenantName: 'Notify Co', limitUsd: 50, remainingUsd: 12.5 },
  });

  currentUser = asUser(BOB); // a plain member — most of every tenant
  const list = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: { id: string }[];
    unread: number;
  };
  expect(list.unread).toBe(1); // the bell shows 1
  const id = list.notifications[0]!.id;

  // Bob clicks it. This is the only gesture the panel offers for one row.
  expect((await call('POST', `/api/notifications/${id}/read`)).status).toBe(200);

  // ...and the badge is gone. Today it is still 1, forever.
  const after = (await (await call('GET', '/api/notifications/unread-count')).json()) as {
    unread: number;
  };
  expect(after.unread).toBe(0);
});

test('"mark all read" empties a member\'s badge, and the next poll agrees', async () => {
  await createNotification({ tenantId: TENANT, kind: 'budget.threshold', title: '75% used' });
  await createNotification({ tenantId: TENANT, kind: 'budget.threshold', title: '90% used' });

  currentUser = asUser(BOB);
  expect(
    ((await (await call('GET', '/api/notifications/unread-count')).json()) as { unread: number })
      .unread,
  ).toBe(2);

  const cleared = (await (await call('POST', '/api/notifications/read-all')).json()) as {
    read: number;
  };
  expect(cleared.read).toBe(2); // the panel is told it cleared two...

  // ...and the 60-second poll that follows must not restore them. (The store clears `unread` to 0
  // optimistically, so a lying `read` count is invisible until the poll snaps the badge back.)
  expect(
    ((await (await call('GET', '/api/notifications/unread-count')).json()) as { unread: number })
      .unread,
  ).toBe(0);
});

test('one member dismissing a broadcast does not dismiss it for anyone else', async () => {
  // The invariant the old 404 was protecting, kept: a member must not be able to clear "your
  // welcome budget is used up" before the tenant_admin who can act on it has seen it.
  await createNotification({
    tenantId: TENANT,
    kind: 'budget.threshold',
    severity: 'critical',
    title: 'Welcome budget used up',
  });

  currentUser = asUser(BOB);
  const id = (
    (await (await call('GET', '/api/notifications')).json()) as { notifications: { id: string }[] }
  ).notifications[0]!.id;
  expect((await call('POST', `/api/notifications/${id}/read`)).status).toBe(200);
  expect(
    ((await (await call('GET', '/api/notifications/unread-count')).json()) as { unread: number })
      .unread,
  ).toBe(0);

  // The admin's copy is untouched, and still says unread in the list as well as the badge.
  currentUser = asAdmin(ALICE);
  const admin = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: { read: boolean }[];
    unread: number;
  };
  expect(admin.unread).toBe(1);
  expect(admin.notifications[0]!.read).toBe(false);
  expect((await call('POST', `/api/notifications/${id}/read`)).status).toBe(200);
});

test('read state is per reader, not per row, in the list as well as the count', async () => {
  await createNotification({ tenantId: TENANT, kind: 'a', title: 'broadcast' });
  currentUser = asUser(BOB);
  const id = (
    (await (await call('GET', '/api/notifications')).json()) as { notifications: { id: string }[] }
  ).notifications[0]!.id;
  await call('POST', `/api/notifications/${id}/read`);

  // Bob sees it read; ?unread=1 no longer returns it for him...
  const bobAll = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: { read: boolean }[];
  };
  expect(bobAll.notifications[0]!.read).toBe(true);
  expect(
    (
      (await (await call('GET', '/api/notifications?unread=1')).json()) as {
        notifications: unknown[];
      }
    ).notifications.length,
  ).toBe(0);

  // ...but Alice's own view of the same row is untouched.
  currentUser = asUser(ALICE);
  const aliceAll = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: { read: boolean }[];
  };
  expect(aliceAll.notifications[0]!.read).toBe(false);
  expect(
    (
      (await (await call('GET', '/api/notifications?unread=1')).json()) as {
        notifications: unknown[];
      }
    ).notifications.length,
  ).toBe(1);
});

test('a member cannot mark another member\'s personal notification read', async () => {
  // Read receipts must not become a way to reach across users: the row is not visible to Bob, so
  // dismissing it is a 404 exactly as before, and Alice's badge is untouched.
  await createNotification({ tenantId: TENANT, userId: ALICE, kind: 'x', title: 'For Alice only' });
  currentUser = asAdmin(ALICE);
  const id = (
    (await (await call('GET', '/api/notifications')).json()) as { notifications: { id: string }[] }
  ).notifications[0]!.id;

  currentUser = asUser(BOB);
  expect((await call('POST', `/api/notifications/${id}/read`)).status).toBe(404);
  expect(
    ((await (await call('POST', '/api/notifications/read-all')).json()) as { read: number }).read,
  ).toBe(0);

  currentUser = asAdmin(ALICE);
  expect(
    ((await (await call('GET', '/api/notifications/unread-count')).json()) as { unread: number })
      .unread,
  ).toBe(1);
});

test('a member is not offered a deep link they would be 403ed on', async () => {
  // The budget alert's own href is '/llm-settings', whose every endpoint is behind
  // requireTenantAdmin (routes/llm-settings.ts). Following it as a member is a 403 — the panel must
  // not turn the row into a button that goes there. The prose still explains what happened.
  await createNotification({
    tenantId: TENANT,
    kind: 'budget.threshold',
    title: '75% of the welcome budget used',
    href: '/llm-settings',
  });

  currentUser = asUser(BOB);
  const member = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: { href: string | null; title: string }[];
  };
  expect(member.notifications[0]!.href).toBeNull();
  expect(member.notifications[0]!.title).toBe('75% of the welcome budget used');

  currentUser = asAdmin(ALICE);
  const admin = (await (await call('GET', '/api/notifications')).json()) as {
    notifications: { href: string | null }[];
  };
  expect(admin.notifications[0]!.href).toBe('/llm-settings');
});

// ==================================================================================================
// ⛔ THE BOUNDARY BEHIND `ADMIN_ONLY_HREFS`. Suppressing '/llm-settings' for a member is a
// hand-written set, and a hand-written set is exactly the shape of the defect above: a second list
// kept in sync with reality by memory. This scans what notification PRODUCERS actually write and
// fails when a new href appears that nobody has adjudicated — so the set cannot silently go stale
// as alert kinds are added.
// ==================================================================================================
test('every href a notification producer writes has been adjudicated against ADMIN_ONLY_HREFS', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const SRC = path.resolve(import.meta.dir, '..', 'src');

  async function walk(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  // A producer is anything that writes a notification row: through the helper, or directly (which
  // host/budget-service.ts does on purpose — it needs the row inside its own transaction).
  const producers: string[] = [];
  for (const file of await walk(SRC)) {
    const text = await readFile(file, 'utf8');
    if (/createNotification\s*\(/.test(text) || /insert\s*\(\s*notifications\s*\)/.test(text)) {
      producers.push(text);
    }
  }
  expect(producers.length).toBeGreaterThan(0); // ⛔ a scan that finds no producers proves nothing

  const hrefs = new Set<string>();
  for (const text of producers) {
    for (const m of text.matchAll(/href:\s*'([^']+)'/g)) hrefs.add(m[1]!);
  }

  // Reachable by any member — no admin guard on the page. Empty today: CP has exactly one alert.
  const MEMBER_REACHABLE = new Set<string>();

  for (const href of hrefs) {
    expect(
      ADMIN_ONLY_HREFS.has(href) || MEMBER_REACHABLE.has(href),
      `notification href '${href}' is not adjudicated: add it to ADMIN_ONLY_HREFS in ` +
        `src/routes/notifications.ts if its page is behind requireTenantAdmin, or to ` +
        `MEMBER_REACHABLE here if any member can open it`,
    ).toBe(true);
  }

  // ...and the set is not carrying entries no producer emits any more. EMPTY since 0099: the only
  // producer that wrote an href was the retired welcome-budget alert (host/budget-service.ts).
  // `/llm-settings` stays in ADMIN_ONLY_HREFS for the legacy alert rows still in people's bells.
  expect([...hrefs].sort()).toEqual([]);
});

// ⛔ A PRINCIPAL WITH NO LOCAL `users` ROW — the regression this fix introduced and an adversarial
// review found. A read receipt FKs `users.id`, so before this clause the badge counted a broadcast
// for such a caller while `read`/`read-all` died on `notification_reads_user_id_fkey` (23503),
// unhandled, as a 500 — badge stuck at 1 with no action able to clear it. That is exactly the
// user-visible symptom this whole change exists to remove, reappearing in a new shape.
//
// The principal is reachable: `validateAuth` takes `user.id` from the token `sub` with no `users`
// lookup, and `provisioning.ts`'s `removeLocalUser` HARD-deletes the local row on the
// failed-onboard rollback while the Keycloak identity survives.
//
// The contract asserted here is AGREEMENT, not visibility: whatever the badge says, the dismiss
// path must be able to reach it. 0 and 0 agree. 1 and a 500 do not.
const GHOST = '00000000-0000-4000-8000-0000000d19ff';

test('a caller with no local users row gets a badge it CAN clear — not a 500 and not a stuck 1', async () => {
  await createNotification({ tenantId: TENANT, kind: 'budget', title: 'Tenant-wide' });

  currentUser = asUser(GHOST);

  const count = await call('GET', '/api/notifications/unread-count');
  expect(count.status).toBe(200);
  const counted = ((await count.json()) as { unread: number }).unread;

  const all = await call('POST', '/api/notifications/read-all');
  expect(all.status).toBe(200); // was an unhandled 23503 → 500
  const cleared = ((await all.json()) as { read: number }).read;

  // The invariant, stated as the invariant: the badge and the dismissable set are one set.
  expect(cleared).toBe(counted);

  const after = await call('GET', '/api/notifications/unread-count');
  expect(((await after.json()) as { unread: number }).unread).toBe(0);
});

test('the ghost caller does not hide the notification from a real member', async () => {
  await createNotification({ tenantId: TENANT, kind: 'budget', title: 'Tenant-wide' });

  currentUser = asUser(GHOST);
  await call('POST', '/api/notifications/read-all');

  // Non-vacuity for the case above: a real user must still see and clear the same row, so the fix
  // cannot be "nobody sees anything".
  currentUser = asUser(BOB);
  const before = await call('GET', '/api/notifications/unread-count');
  expect(((await before.json()) as { unread: number }).unread).toBe(1);
  const cleared = await call('POST', '/api/notifications/read-all');
  expect(((await cleared.json()) as { read: number }).read).toBe(1);
  const after = await call('GET', '/api/notifications/unread-count');
  expect(((await after.json()) as { unread: number }).unread).toBe(0);
});
