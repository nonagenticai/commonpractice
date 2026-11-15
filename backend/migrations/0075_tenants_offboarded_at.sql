-- 0075_tenants_offboarded_at.sql — WHEN a workspace was offboarded, as a fact on the tenant row.
--
-- THE GAP. There has never been a way to offboard a TENANT. Member offboarding exists
-- (`routes/tenant-users.ts` `offboardTenantUser`), but emptying a workspace meant clicking every
-- member one at a time, and the last-admin guard (`tenant-users.ts` `tenantAdminIds`) means the
-- FINAL administrator can never be removed through it at all. So every departed customer left live
-- Keycloak identities and live, working `mcp_api_keys` behind — credentials that outlive the
-- commercial relationship and that nothing in the product could revoke.
--
-- `POST /api/tenants/:id/offboard` (routes/admin.ts) closes that, and this column is the one piece
-- of state it needs that `tenants` does not already carry.
--
-- ⛔ WHY A NULLABLE TIMESTAMP AND *NOT* A THIRD `tenant_status` VALUE. The obvious shape is
-- `ALTER TYPE tenant_status ADD VALUE 'offboarded'`, and it is wrong twice over:
--
--   1. EVERY reader of `status` in this product is a BINARY ternary — `status === 'active' ? … : …`
--      in the platform tenants screen, `status === 'suspended'` in the suspension gate, and the same
--      shape in `patchTenant`'s zod enum (`z.enum(['active','suspended'])`). A third value does not
--      render as a third state; it silently falls down the ELSE branch of each of them, so an
--      offboarded workspace would display as whatever "not active" happens to mean on that screen.
--      Suspension is ALREADY the correct runtime posture for an offboarded tenant — every gate that
--      must deny it already denies a suspended tenant — so the offboard sets `status='suspended'`
--      and records the additional fact HERE, where a reader has to opt in to seeing it.
--   2. `ALTER TYPE … ADD VALUE` cannot run in the same transaction that then uses the new value, and
--      db/migration-runner.ts applies every pending file inside ONE outer transaction. That is the
--      same wedge class as the `RAISE` note below: the migration would fail, the pod would never
--      start, and it would fail identically on every retry.
--
-- ⛔ NO `DO` BLOCK AND NO `RAISE` IN THIS FILE, DELIBERATELY. A prior migration in this repo raised
-- inside a DO block to report a condition it had found. A RAISE (of any level above NOTICE) aborts
-- the statement, which rolls back the runner's OUTER transaction — so the schema never advanced, the
-- boot migration failed, and the pod crash-looped: the exact same failure on every single retry,
-- with the migration's own diagnostic as the cause. An `ADD COLUMN IF NOT EXISTS` needs no branch and
-- must not grow one.
--
-- NULLABLE, NO DEFAULT, NO BACKFILL. NULL means "this workspace has not been offboarded", which is
-- true of every tenant that exists today, so there is nothing to backfill and a default would be a
-- lie. The route is idempotent BECAUSE this column is nullable: it writes
-- `offboarded_at = COALESCE(offboarded_at, now())`, so a second call preserves the original
-- timestamp byte-for-byte and reports `alreadyOffboarded`.
--
-- NO INDEX. Nothing filters or orders on this column — `listAllTenants` reads the whole (bounded)
-- tenant list and pulls this along for the ride, and `patchTenant` reads it by primary key. An index
-- here would cost every tenant write and serve no query.
--
-- NO GRANT AND NO RLS CHANGE. `tenants` is deliberately OUTSIDE the RLS regime (0028 §COVERAGE) and
-- `0028_rls.sql` issues a TABLE-level `GRANT … ON ALL TABLES` to `cp_app`; a table-level grant covers
-- columns added later, so both apply to this column with no edit here.
--
-- WHY `SET LOCAL lock_timeout`, ON A FILE THAT ADDS ONE NULLABLE COLUMN
-- --------------------------------------------------------------------
-- `ADD COLUMN … timestamptz` with no default is metadata-only in PG 11+ (no table rewrite), but it
-- still needs an ACCESS EXCLUSIVE lock on `tenants`, and it must QUEUE for it behind whatever is
-- reading the table. `tenants` is read by essentially every authenticated request path (the licence
-- gate, the seat cap's `SELECT … FOR UPDATE`, `resolveTenant`), so that queue is real. It is also
-- worse than the size of the change suggests: the runner applies every pending file inside ONE outer
-- transaction under `pg_advisory_xact_lock`, so a lock waited on here is held until the LAST pending
-- file commits, and every other pod's boot migration is queued behind the advisory lock the whole
-- time. Unbounded, that is a fleet-wide readiness stall during a rolling deploy caused by one ALTER
-- that does no work. With the 5s ceiling the savepoint rolls back instead, the schema stays at 0074,
-- and the pod retries on its next boot. A retried migration beats a wedged fleet.
SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM OF THIS FILE. `SET LOCAL` is scoped to the TRANSACTION, and the runner
-- applies every pending file inside ONE outer transaction with a savepoint per file — `RELEASE
-- SAVEPOINT` does not undo a SET LOCAL. Without the reset this 5s ceiling would silently apply to
-- 0076 and everything after it in the same boot, so a later migration that legitimately needs to
-- wait on a lock would fail for a reason nobody wrote down. `lock_timeout` is the ONLY GUC on
-- `MIGRATION_RESET_GUCS` (db/migration-runner.ts) and `tests/migration-guc-reset.test.ts`
-- statically scans every `.sql` in this directory — any other GUC set here reds CI.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS offboarded_at timestamptz;

COMMENT ON COLUMN tenants.offboarded_at IS
  'When this workspace was OFFBOARDED (POST /api/tenants/:id/offboard, routes/admin.ts). NULL = not '
  'offboarded, which is the state of every tenant created before migration 0075 and of every live '
  'one since. Set ONCE, via COALESCE(offboarded_at, now()), so a repeated offboard preserves the '
  'original timestamp and the route can report `alreadyOffboarded` truthfully. Deliberately NOT a '
  'third `tenant_status` enum value: every reader of `status` is a binary ternary and would render '
  'an offboarded tenant through the wrong branch. An offboard sets status = ''suspended'' (the '
  'correct runtime posture — every gate that must deny this workspace already denies a suspended '
  'one) and records the additional fact here. It is also the REACTIVATION BAR: `patchTenant` '
  'refuses status = ''active'' while this is non-null, because re-issuing a live Gate-2 licence for '
  'a tenant whose Keycloak identities have been deleted produces an accessible workspace nobody can '
  'log into.';

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
