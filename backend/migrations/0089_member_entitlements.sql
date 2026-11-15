-- 0089_member_entitlements.sql — EVERY EMPLOYEE SHARES ONE LICENCE, SO NOTHING IN THIS PRODUCT CAN
-- COUNT A SEAT, RELEASE A SEAT, OR SAY WHO SPENT THE MONEY.
--
-- THE DEFECT, AND IT IS LIVE. `services/license-provisioning.ts` mints ONE licence per TENANT and
-- parks its token on `tenants.license_token_encrypted` (0031). Every member of that tenant then
-- authenticates against that one token: `middleware/license-gate.ts` loads it by TENANT
-- (`lib/license-status.ts` → `tenantLicenseToken(tenantId)`) and asserts four things — active, not
-- expired, `app.key`, `tenant_id` — none of which is the caller. The introspect response has carried
-- `subject_id` and `license_id` the whole time (`services/license-client.ts`
-- `LicenseIntrospectResponse`); this service has simply never read them.
--
-- THREE CONSEQUENCES, ALL MEASURED ON PRODUCTION 2026-09-17:
--
--   1. NO SEAT CAN BE COUNTED. Billing's seat basis is licences-service `human_subjects`
--      (`GET /internal/tenants/{id}/seat-count`). One licence per tenant means that number is 1 for
--      a tenant of fifty, forever. There is nothing to bill per user because there is nothing per
--      user.
--
--   2. NO SEAT CAN BE RELEASED. `services/offboarding.ts` `offboardOneUser` soft-deletes the row,
--      revokes API keys and kills sessions — and touches NO licence. `routes/tenant-users.ts` says
--      so in terms: "No license touch — licenses are tenant-level (Gate-2 checks tenant_id, not
--      subject_id)". A leaver's seat was never held, so it cannot be given back.
--
--   3. THE SPEND IS UNATTRIBUTABLE, AND THIS IS THE ONE WITH A NUMBER ON IT. All six
--      `billing_cost_daily` rows this service has ever produced carry
--      `license_id = 00000000-0000-0000-0000-000000000000` and `attribution_status = 'unlicensed'`
--      — 696 requests, $1.0008, none of it invoiceable. Their `subject_id` is ONE constant CP user
--      id (`32969c16-…`) repeated across two DIFFERENT tenants, because the emitter sends CP's own
--      `users.id` where billing expects the central Licences Subject UUID. That is the same class as
--      the `$3,386.52 across 22 licence-owning tenants` the invoice generator's
--      `excluded_unbillable_*` columns exist to disclose.
--
-- WHAT THIS FILE DOES. One row per (tenant, member, app): the member's own central licence id, their
-- central Subject UUID, and their own encrypted token. `tenants.license_token_encrypted` is left
-- ALONE here — this migration is EXPAND-ONLY, so an old replica cannot 42P01 on it and a rollback
-- needs no data move. The column is dropped in a later contract step, after the gate has run on
-- entitlements in production.
--
-- ---------------------------------------------------------------------------------------------
-- WHY A TABLE AND NOT A COLUMN ON `users`
-- ---------------------------------------------------------------------------------------------
-- A `users.license_token_encrypted` would be one column and would work today. It is refused because:
--   • A REVOKED entitlement must SURVIVE the member. Billing counts a seat for anyone licensed at
--     ANY instant in the period, so a leaver on the 20th is still a seat that month. A column on a
--     soft-deleted user row can express "not licensed now"; it cannot express "was licensed until
--     the 20th" once it has been overwritten.
--   • Provisioning is a SAGA across three systems (Keycloak, this database, licences-service) with
--     no shared transaction. It needs `status`, `attempts` and `last_error` to be retryable and to
--     be reconcilable by `host/onboarding-integrity.ts`. Those are row fields, not a token blob.
--   • A second app would need a second column. `app_key` is in the key instead.
--
-- ---------------------------------------------------------------------------------------------
-- WHY THE UNIQUE INDEX IS PARTIAL
-- ---------------------------------------------------------------------------------------------
-- `UNIQUE (tenant_id, user_id, app_key)` outright would make re-hiring impossible: a member who is
-- offboarded and later returns needs a SECOND entitlement, and the first one must stay put as the
-- evidence that they held a seat in an earlier billing period. Excluding `status='revoked'` keeps
-- the live-uniqueness guarantee (at most one ACTIVE entitlement per member per app, which is what
-- the gate depends on) while letting history accumulate underneath it.
--
-- ⚠️ `ON DELETE CASCADE` on `user_id` is deliberate and is NOT the historical record. A hard
-- `removeLocalUser` takes the entitlement rows with it. That is acceptable precisely because this
-- table is not the billing archive: the licences service holds the licence (revoked, with
-- `revoked_at` stamped on first transition only) and billing FREEZES the resolved seat count into
-- `billing_invoices.snapshot` at close. This table is the operational binding, and it says so in its
-- COMMENT so a future reader does not mistake it for the ledger.

SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM — `SET LOCAL` is TRANSACTION-scoped and the runner applies every pending
-- file inside ONE outer transaction with a savepoint per file, so `RELEASE SAVEPOINT` does not undo
-- it. Without the reset this 5s ceiling silently governs 0090 onwards on a fresh-cluster first boot.
-- Same pairing as 0066/0067/0068/0070.

CREATE TABLE IF NOT EXISTS member_entitlements (
  -- uuidv7(), not gen_random_uuid(): 0039 adopted the team time-ordered-UUID standard for every
  -- generated PK and mirrors it in schema.ts as `.default(sql`uuidv7()`)`. Requires Postgres >= 18.
  id         uuid        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid        NOT NULL DEFAULT app_current_tenant_uuid()
                           REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- The licences-service app this entitlement is for. TEXT and not a FK: the app registry lives in
  -- another service and its UUID is resolved at runtime (`services/licenses-admin.ts`
  -- `resolveAppAndPlan`). `config.license.appKey` is the value the gate asserts against.
  app_key    text        NOT NULL DEFAULT 'commonpractice',

  -- The central licence. NULL while `status='pending'` — the row is created BEFORE the remote call
  -- so a crash between the two leaves a retryable record rather than an invisible gap.
  license_id uuid,
  -- ⭐ THE FIELD THIS WHOLE CHANGE EXISTS FOR. The licences-service Subject UUID, returned by
  -- `POST /licenses/user/{keycloak_sub}` and, until now, DISCARDED by `licenses-admin.ts`
  -- (`createLicense` returned `{licenseId}` only). This is what a cost event's `subject_id` must
  -- carry; sending `users.id` there is why 100% of this service's central spend reads `unlicensed`.
  license_subject_id uuid,
  -- The member's own token, sealed with `host/secret-box.ts` `encryptSecret`. Minted once and never
  -- returned again by the licences API, exactly like the tenant token it replaces.
  token_encrypted text,

  -- pending  : row exists, remote licence not yet confirmed. The gate DENIES.
  -- active   : licence + token present. The only state the gate admits.
  -- revoking : offboarding has begun. Access is ALREADY denied; the seat stays billable until the
  --            central revoke is acknowledged, which is a revenue fact and not a nicety.
  -- revoked  : central revoke acknowledged. Retained as history; excluded from the unique index.
  -- error    : the saga failed in a way retry did not clear. `last_error` says how.
  status     text        NOT NULL DEFAULT 'pending',

  provisioned_at timestamptz,
  revoked_at     timestamptz,
  -- Saga bookkeeping for the reconciler in `host/onboarding-integrity.ts`.
  attempts   integer     NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_member_entitlements_status
    CHECK (status IN ('pending', 'active', 'revoking', 'revoked', 'error')),
  -- An `active` entitlement without a licence or a token is a state the gate would have to guess
  -- about, so it is made unrepresentable instead.
  CONSTRAINT ck_member_entitlements_active_is_complete
    CHECK (status <> 'active' OR (license_id IS NOT NULL AND token_encrypted IS NOT NULL))
);

-- THE LIVE-UNIQUENESS GUARANTEE the gate depends on: at most one non-revoked entitlement per member
-- per app. Partial so re-hires and historical rows coexist beneath it (see the header).
CREATE UNIQUE INDEX IF NOT EXISTS member_entitlements_live_uq
  ON member_entitlements (tenant_id, user_id, app_key)
  WHERE status <> 'revoked';

-- The gate's read path is (tenant, user, app) and is served by the unique index above. This one is
-- for the RECONCILER, which sweeps by state across a tenant and would otherwise seq-scan.
CREATE INDEX IF NOT EXISTS member_entitlements_status_idx
  ON member_entitlements (tenant_id, status);

-- The drainer/reconciler also needs "which licence is this", for the revoke path and for joining a
-- cost event back to its member. Partial: a pending row has no licence to look up.
CREATE INDEX IF NOT EXISTS member_entitlements_license_idx
  ON member_entitlements (license_id)
  WHERE license_id IS NOT NULL;

COMMENT ON TABLE member_entitlements IS
  'One central licence per MEMBER per app, replacing the single tenant-level token on '
  'tenants.license_token_encrypted. Carries the member''s licence id, their licences-service Subject '
  'UUID (what a cost event''s subject_id must be) and their own encrypted token. This is the '
  'OPERATIONAL binding, not the billing archive: the licences service owns licence lifecycle and '
  'billing freezes the resolved seat count into billing_invoices.snapshot at period close, so a '
  'cascade from users does not destroy a closed period''s evidence.';

COMMENT ON COLUMN member_entitlements.license_subject_id IS
  'licences-service Subject UUID. Emit this as a cost event''s subject_id — NOT users.id, which is '
  'what made 100% of this service''s central spend land as attribution_status=unlicensed.';

-- ---- RLS: the strict 0028 §4a shape ----------------------------------------------------------
-- Same predicate in USING and WITH CHECK so the INSERT is bound too: an entitlement cannot be
-- written into another tenant, nor read out of one. The per-USER binding is the `user_id` term in
-- the application's own predicate, because RLS has no notion of the current user.
-- ⚠️ This table has a tenant_id, so `tests/rls-coverage.test.ts` REQUIRES this block — a new
-- tenant-scoped table without it fails the suite rather than shipping unguarded.
ALTER TABLE member_entitlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS member_entitlements_tenant ON member_entitlements;
CREATE POLICY member_entitlements_tenant ON member_entitlements
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());

-- ---- GRANTs to cp_app (role-existence-guarded, like 0070 / 0068 / 0044 / 0028 §5) -------------
-- Production connects as the non-owner, NOBYPASSRLS `cp_app` (verified live: `rolbypassrls=false`).
-- 0028's DEFAULT PRIVILEGES cover a table created by the same owner, but every table migration since
-- has also issued the explicit grant, because a cluster whose owner role differs gets nothing from
-- those defaults and the failure mode is a 500 on a green test suite.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON member_entitlements TO cp_app;
    RAISE NOTICE '[0089] granted cp_app DML on member_entitlements';
  ELSE
    RAISE NOTICE '[0089] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
