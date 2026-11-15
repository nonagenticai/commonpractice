-- 0090_usage_attribution_and_metering_outbox.sql — WHO SPENT IT, ON WHOSE LICENCE, AND A COST EVENT
-- THAT CANNOT BE LOST BETWEEN THE LEDGER AND BILLING.
--
-- TWO DEFECTS, BOTH MEASURED ON PRODUCTION 2026-09-17:
--
--   1. ATTRIBUTION. Every central cost row CP ever produced carries `license_id = 0…0` and
--      `attribution_status='unlicensed'`, and its `subject_id` is CP's own `users.id` — not a
--      licences-service Subject. None of it can be invoiced. Since 0089 each member holds their own
--      licence, so the ledger row can now say WHICH licence and WHICH Subject paid, and WHICH
--      authenticated person (Keycloak sub) acted.
--
--   2. DURABILITY. The cost event was a `void` XADD fired AFTER the ledger transaction committed, with
--      no retry and no record. On 2026-09-02, 168 metered calls produced 0 central rows and the cause
--      is unrecoverable. The outbox row is now written INSIDE the ledger transaction, so a committed
--      usage row without a pending cost event is unrepresentable, and a drainer delivers it.
--
-- ⚠️ ADDITIVE ONLY. Every new usage_events column is NULLABLE and NOT backfilled: no historical row
-- recorded a licence, an actor or a credential origin, so any value written for them would be
-- fabricated (the same rule `price_source` and `stage` follow).

SET LOCAL lock_timeout = '5s';

ALTER TABLE usage_events
  -- member_entitlements.license_id of the member at settle time.
  ADD COLUMN IF NOT EXISTS license_id uuid,
  -- licences-service Subject UUID — a cost event's `subject_id` (WHO PAYS).
  ADD COLUMN IF NOT EXISTS license_subject_id uuid,
  -- users.keycloak_sub — a cost event's `actor_id` (WHO ACTED). NULL for platform work.
  ADD COLUMN IF NOT EXISTS actor_id uuid,
  -- 'tenant_byo' | 'platform_managed' | 'none' — whose credential paid the provider.
  ADD COLUMN IF NOT EXISTS credential_source text,
  -- The provider's OWN reported charge, when it reports one (price_source='provider'). NULL otherwise;
  -- never the price-card estimate, so billing can prefer a real vendor figure.
  ADD COLUMN IF NOT EXISTS vendor_cost_usd numeric(20, 8),
  -- BrokerCallMeta.correlationId (flow run id / agent session id).
  ADD COLUMN IF NOT EXISTS correlation_id text;

CREATE TABLE IF NOT EXISTS metering_outbox (
  id              uuid        PRIMARY KEY DEFAULT uuidv7(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- One cost event per ledger row, by construction. Also the billing `event_key`, so a re-send after
  -- a crash between XADD and the `sent` update is deduplicated at the far end.
  usage_event_id  uuid        NOT NULL UNIQUE REFERENCES usage_events(id) ON DELETE CASCADE,
  -- The flat string→string field map `billing_service` cost_flusher parses, frozen at settle time.
  fields          jsonb       NOT NULL,
  -- pending : not yet acknowledged by Redis. sent : XADD returned an id.
  status          text        NOT NULL DEFAULT 'pending',
  attempts        integer     NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_metering_outbox_status CHECK (status IN ('pending', 'sent')),
  CONSTRAINT ck_metering_outbox_sent_is_stamped CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);

-- The drainer's read: oldest due pending rows. Partial — sent rows are history, not work.
CREATE INDEX IF NOT EXISTS metering_outbox_due_idx
  ON metering_outbox (next_attempt_at)
  WHERE status = 'pending';

COMMENT ON TABLE metering_outbox IS
  'Transactional outbox for the billing:costs stream. Written in the SAME transaction as the '
  'usage_events ledger row (host/llm-broker.ts settleSpend) and delivered by '
  'host/metering-outbox-drainer.ts. A pending row older than the drain interval is undelivered spend.';

-- ---- RLS: the strict 0028 §4a shape (tests/rls-coverage.test.ts requires it) -----------------
-- The broker writes under the request's tenant GUC; the drainer reads across tenants as SYSTEM.
ALTER TABLE metering_outbox ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS metering_outbox_tenant ON metering_outbox;
CREATE POLICY metering_outbox_tenant ON metering_outbox
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON metering_outbox TO cp_app;
    RAISE NOTICE '[0090] granted cp_app DML on metering_outbox';
  ELSE
    RAISE NOTICE '[0090] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;

RESET lock_timeout;
