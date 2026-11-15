-- 0044_tenant_budgets_and_notifications.sql
--
-- WHY: three things a super-admin could not do and a tenant-admin could not see.
--
--   1. `tenants.max_members` — cap how many people a tenant-admin may invite on their own.
--      Every quota in CP so far is PER-USER and PLATFORM-GLOBAL (the `spend.*` policy rows);
--      there was no per-tenant seat concept anywhere in the product or the cluster.
--   2. `tenant_llm_budgets` — the "welcome budget" a super-admin grants a new tenant. The dollar
--      cap lives on an OpenRouter provisioned API key (`limit` + `limit_reset: null`), which
--      OpenRouter itself enforces; this table is CP's record of that key plus the usage mirror the
--      alert scheduler polls. `alerted_threshold` is the idempotency key that stops the 75/90/100 %
--      alerts from re-firing on every tick (precedent: the audit_exports day-claim, 0015).
--   3. `notifications` — CP had NO in-app notification system at all (verified: no table, no route,
--      no bell). The budget alerts need one, and it is generic enough to carry future alerts.
--
-- ADDITIVE / FORWARD-ONLY / PROD-SAFE: one nullable column on an existing table plus two new
-- tables. Nothing is rewritten, nothing is dropped, no existing behaviour changes — with no budget
-- row and no notifications, every code path behaves exactly as before.

-- ---- 1. seat cap -----------------------------------------------------------------------------
-- NULL = unlimited (the behaviour every existing tenant has today, so the column needs no backfill).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_members integer;
ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_max_members_positive;
ALTER TABLE tenants ADD CONSTRAINT tenants_max_members_positive
  CHECK (max_members IS NULL OR max_members > 0);

COMMENT ON COLUMN tenants.max_members IS
  'Seat cap: max users in this tenant. NULL = unlimited. Enforced on invite / tenant-user create.';

-- ---- 2. per-tenant LLM welcome budget --------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_llm_budgets (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id           uuid NOT NULL DEFAULT app_current_tenant_uuid()
                        REFERENCES tenants(id) ON DELETE CASCADE,
  -- Only 'openrouter' today; the column exists so a second grantable provider does not need a
  -- migration to model.
  provider            text NOT NULL DEFAULT 'openrouter',
  -- OpenRouter's key identifier (`hash`) — the handle for GET/PATCH/DELETE /api/v1/keys/{hash}.
  or_key_hash         text,
  -- The key itself, secret-box encrypted (host/secret-box.ts), same as every other stored secret
  -- in this schema (identity_providers.client_secret_encrypted, tenants.license_token_encrypted,
  -- delivery_targets.credentials_encrypted). OpenRouter returns it exactly ONCE on create.
  or_key_encrypted    text,
  limit_usd           numeric(12, 2) NOT NULL,
  -- Mirrors of OpenRouter's own accounting, refreshed by the budget scheduler. OpenRouter is
  -- AUTHORITATIVE: CP's usage_events.cost_usd is priced from a flat per-token rate and cannot
  -- match real per-model spend, so it is never used to decide a threshold.
  usage_usd           numeric(12, 6) NOT NULL DEFAULT 0,
  limit_remaining_usd numeric(12, 6),
  -- active   → the grant is live and being polled
  -- exhausted→ OpenRouter is refusing calls on this key (100 % consumed)
  -- replaced → the tenant configured their own provider/key; stop alerting
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'exhausted', 'replaced')),
  -- Highest percentage threshold already alerted on (0 | 75 | 90 | 100). Monotonic, so an alert
  -- fires exactly once per threshold no matter how often the scheduler ticks.
  alerted_threshold   smallint NOT NULL DEFAULT 0
                        CHECK (alerted_threshold IN (0, 75, 90, 100)),
  last_synced_at      timestamptz,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- One live grant per tenant; a replaced/exhausted grant is kept for history.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_llm_budgets_active_uq
  ON tenant_llm_budgets (tenant_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS tenant_llm_budgets_tenant_id_idx ON tenant_llm_budgets (tenant_id);

-- RLS §4a (strict uuid): own-tenant only, both directions. Cross-tenant work (the alert scheduler,
-- the super-admin grant) runs under runAsSystem on the owner pool, which bypasses.
ALTER TABLE tenant_llm_budgets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_llm_budgets_tenant ON tenant_llm_budgets;
CREATE POLICY tenant_llm_budgets_tenant ON tenant_llm_budgets
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());

-- ---- 3. in-app notifications -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id  uuid NOT NULL DEFAULT app_current_tenant_uuid()
               REFERENCES tenants(id) ON DELETE CASCADE,
  -- NULL = addressed to the whole tenant (every member sees it); set = one recipient.
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  -- Machine-readable class, e.g. 'budget.threshold'. Kept free-form: a new alert kind must not
  -- need a migration.
  kind       text NOT NULL,
  severity   text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'critical')),
  title      text NOT NULL,
  body       text,
  -- Where clicking the notification takes the user, e.g. '/llm-settings'.
  href       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_tenant_created_idx
  ON notifications (tenant_id, created_at DESC);
-- Backs the unread badge: the common query is "unread for me or for my whole tenant".
CREATE INDEX IF NOT EXISTS notifications_unread_idx
  ON notifications (tenant_id, user_id, created_at DESC) WHERE read_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_tenant ON notifications;
CREATE POLICY notifications_tenant ON notifications
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());

-- ---- GRANTs to cp_app (role-existence-guarded, like 0037 §5 / 0043) --------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_llm_budgets TO cp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO cp_app;
    RAISE NOTICE '[0044] granted cp_app DML on tenant_llm_budgets + notifications';
  ELSE
    RAISE NOTICE '[0044] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;
