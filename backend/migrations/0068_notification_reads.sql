-- 0068_notification_reads.sql — READ IS A FACT ABOUT A READER, NOT ABOUT A ROW.
--
-- THE DEFECT. `notifications.read_at` is a single column on a row that SEVERAL people read. 0044
-- deliberately addresses a tenant-wide alert as ONE row with `user_id IS NULL` (so it cannot go
-- stale as the admin set changes), and `host/budget-service.ts` — the ONLY production writer of a
-- notification in this product — writes exactly that shape. So every notification CP actually
-- produces is shared, and one `read_at` cannot record what several readers have each done with it.
--
-- The old code split into two predicates rather than one, and they disagreed on precisely the rows
-- the product emits:
--   COUNT      (host/notification-service.ts unreadCount) → user_id IS NULL OR user_id = me
--   DISMISSABLE (markRead / markAllRead, non-admin)       → user_id = me
-- A member's badge therefore counted a broadcast it refused to let them dismiss. Clicking it
-- returned 404, "mark all read" returned 200 `{read: 0}`, and the 60-second poll restored the
-- badge — permanently, for the rest of that tenant's life. The 404 was not the bug; it was the
-- visible end of a divergence between two hand-written WHERE clauses over one feed.
--
-- WHY A RECEIPT TABLE AND NOT THE TWO ALTERNATIVES
-- ------------------------------------------------
--   • "Fan out one row per user at INSERT time." This is the thing 0044 explicitly refused, and for
--     a reason that has not changed: the writer is a scheduler inside the budget transaction
--     (`budget-service.ts`, the same commit that claims `alerted_threshold`), so fanning out turns a
--     one-row insert into an unbounded one, and a member who joins the tenant an hour later never
--     receives an alert that is still true. The addressing model is right; only the read state was
--     stored on the wrong object.
--   • "Just scope the count to what the user may dismiss." That makes the two predicates agree by
--     BLINDING the member: the tenant's LLM spend crossing 100% would stop reaching anyone but a
--     tenant_admin, and 0044/routes/notifications.ts both state, as product intent, that a
--     tenant-wide alert is something everyone in the workspace benefits from seeing. It fixes the
--     badge by deleting the feature.
--
-- A receipt keeps BOTH halves of the old rule true at once, which the 404 could only ever do by
-- taking one away: a member CAN clear their own badge, and a member CANNOT clear anyone else's —
-- including the tenant_admin whose alert it is. Nobody, at any role, dismisses on another's behalf,
-- so the "the lowest-privileged member silences the admins' alert" hazard 0044 was defending
-- against is now structurally impossible rather than defended against by a role check.
--
-- ONE PREDICATE, ONE PLACE. The divergence is what shipped the bug, so the fix is not two corrected
-- WHERE clauses: `host/notification-service.ts` now derives all four surfaces (list, unread count,
-- mark-one, mark-all) from a single exported `visibleUnreadTo(userId)` predicate, and
-- `tests/notifications.test.ts` pins that the count and the dismissable set answer identically.
--
-- WHY tenant_id IS DENORMALISED ONTO A PURE JOIN TABLE. It is redundant — every row's tenant is
-- reachable through `notifications` — and carrying it is still the right call. RLS could scope this
-- table through its parent (the 0028 §4d "child-via-parent" shape), and that shape is SAFE here
-- (the parent policy is the strict §4a `tenant_id = app_current_tenant_uuid()`, so visible implies
-- owned — this is not the 0057 hazard). But `tests/rls-coverage.test.ts` enumerates only tables
-- that CARRY a `tenant_id` column and says so in its own header: all eight child-via-parent tables
-- are structurally invisible to it, which is exactly how five of them shipped a cross-tenant write
-- hole that stayed green for months. A column that costs 16 bytes buys membership in the anti-drift
-- guard. NOT NULL + FK, so it cannot drift to NULL and fail open.
--
-- ⚠️ `notifications.read_at` IS NOT DROPPED, AND IS NO LONGER READ. Expand-only, like 0065 and
-- 0066: migrations run at pod STARTUP with 2-4 replicas, so for the length of a roll an OLD pod is
-- still writing `read_at` and a NEW pod is writing receipts. Dropping the column would 42703 every
-- old replica's feed mid-deploy. It is backfilled below and then left alone; the DROP belongs in a
-- later contract migration once no running code names it. Its COMMENT says so, in the one place a
-- future reader will be standing when they wonder why it is always NULL.
SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM. `SET LOCAL` is transaction-scoped and the runner applies every pending
-- file inside ONE outer transaction (one savepoint per file), so without the reset this 5s ceiling
-- silently governs 0068 and everything after it on a cold boot. 0066 established the pairing;
-- `MIGRATION_RESET_GUCS` in db/migration-runner.ts is the belt to this file's braces.
--
-- The ceiling is not ceremony here. `CREATE TABLE … REFERENCES notifications/users/tenants` takes a
-- SHARE ROW EXCLUSIVE lock on each parent, and the backfill below reads `notifications` and `users`
-- — all of which must QUEUE behind live traffic while every other pod's boot migration waits on the
-- advisory lock. A retried migration beats a wedged fleet.

CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  -- ON DELETE CASCADE on both sides: a receipt is meaningless without its notification, and a
  -- deleted user's receipts are not evidence anyone wants to keep. Neither deletion may be blocked
  -- by this table.
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL DEFAULT app_current_tenant_uuid()
                    REFERENCES tenants(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  -- THE PK IS THE IDEMPOTENCE. "Bob has read notification X" is true or it is not; it cannot be
  -- true twice. Two concurrent clicks (the panel is optimistic, and the poll runs underneath it)
  -- race to the same key and the loser is a no-op, not a duplicate that inflates a count.
  -- It is also the index the hot query needs: every read path is an anti-join
  -- `NOT EXISTS (… WHERE notification_id = n.id AND user_id = $me)`, which is a PK probe.
  PRIMARY KEY (notification_id, user_id)
);

-- No second index. Nothing scans this table by user alone, by tenant, or by read_at: every query
-- enters through a notification id that the feed query already has in hand. An index on (user_id)
-- would cost every dismissal and serve nothing.

COMMENT ON TABLE notification_reads IS
  'Per-reader read receipts for notifications. Read state is a fact about a (notification, reader) '
  'pair, not about the row: a tenant-wide notification (notifications.user_id IS NULL) is read by '
  'several people independently. Presence of a row = that user has dismissed that notification. '
  'Written only by host/notification-service.ts, whose visibleUnreadTo() is the single predicate '
  'behind the feed, the badge count and both dismissal endpoints.';

-- ---- Backfill ---------------------------------------------------------------------------------
-- Both halves preserve what each reader SAW before this migration; neither invents a fact.
--
-- 1. A personally-addressed row that was read: the reader is unambiguous — it is the addressee.
INSERT INTO notification_reads (notification_id, user_id, tenant_id, read_at)
SELECT n.id, n.user_id, n.tenant_id, n.read_at
FROM notifications n
WHERE n.user_id IS NOT NULL
  AND n.read_at IS NOT NULL
ON CONFLICT DO NOTHING;

-- 2. A tenant-wide row that was read: under the OLD semantics one dismissal cleared it for the
-- whole workspace, and every member's badge was already 0 for it. The truthful translation is a
-- receipt for each of that tenant's users, which reproduces exactly the badge they had this
-- morning. Without it, every historically-dismissed broadcast resurrects on deploy — the bug this
-- migration exists to fix, arriving as its own regression.
--
-- Soft-deleted users (0050) are included deliberately: excluding them would resurrect the alert if
-- such a user were ever restored, and a receipt for an account nobody logs into costs nothing.
-- Bounded by (tenant-wide read notifications × tenant members), which for CP's only producer is
-- three budget alerts per tenant per grant.
INSERT INTO notification_reads (notification_id, user_id, tenant_id, read_at)
SELECT n.id, u.id, n.tenant_id, n.read_at
FROM notifications n
JOIN users u ON u.tenant_id = n.tenant_id
WHERE n.user_id IS NULL
  AND n.read_at IS NOT NULL
ON CONFLICT DO NOTHING;

COMMENT ON COLUMN notifications.read_at IS
  'SUPERSEDED by notification_reads (0068) and no longer read or written by application code. It '
  'could not be correct: one column cannot record what several readers of a tenant-wide row have '
  'each done. Kept, not dropped, because migrations apply at pod startup while 2-4 replicas are '
  'live and an old replica still names this column mid-roll; drop it in a later contract migration '
  'once nothing running does. Backfilled into notification_reads by 0068 — do not backfill BACK.';

-- ---- RLS: the strict §4a shape, identical to the parent (0044) --------------------------------
-- Same predicate in USING and WITH CHECK, so INSERT is bound too — a receipt cannot be written into
-- another tenant. Note this is TENANT scope, not USER scope: RLS has no notion of the current user
-- (only `app.current_tenant` is set, 0028 §1), so "Bob cannot write a receipt as Alice" is enforced
-- where the user identity actually exists — in host/notification-service.ts, which binds user_id to
-- the authenticated caller and never to a request parameter. RLS is the tenant boundary; it was
-- never the per-user one.
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_reads_tenant ON notification_reads;
CREATE POLICY notification_reads_tenant ON notification_reads
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());

-- ---- GRANTs to cp_app (role-existence-guarded, like 0044 / 0037 §5) ---------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON notification_reads TO cp_app;
    RAISE NOTICE '[0068] granted cp_app DML on notification_reads';
  ELSE
    RAISE NOTICE '[0068] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
