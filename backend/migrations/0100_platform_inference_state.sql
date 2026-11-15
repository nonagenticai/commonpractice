-- 0100 — the PLATFORM's own inference-router credential, with a persisted retry backoff.
--
-- Platform background work (content translation) and tenant-less LLM calls carry an
-- inference-router licence token held by a DEDICATED licences service tenant (`svc-commonpractice`,
-- config `INFERENCE_PLATFORM_TENANT_ID`), not by CP's nil system tenant: in licences the nil uuid is
-- `default-anon`, and inference-router DROPS every cost event on it (metering.py
-- UNATTRIBUTED_TENANT_ID) — platform spend would be silently unmetered.
--
-- One row (id = 1). `holder_tenant_id` records which licences tenant the stored token belongs to; a
-- token for any other holder is never used (the config moved). `attempts` / `next_attempt_at`
-- persist the exponential backoff of a failing provisioning so it survives restarts and holds across
-- replicas (the onboarding-integrity tick would otherwise mint + revoke a licence every 5 minutes).
-- `op_id` / `op_until` are a single-statement lease, the same shape as tenants.licence_op_* (0096).
-- `revoke_pending` holds a smoke-failed licence whose revoke also failed; the next attempt retries it.
--
-- No tenant_id column and no RLS: this is platform state, read only by the host.
-- FORWARD-ONLY, idempotent (runs at startup on every replica).
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS platform_inference_state (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  holder_tenant_id uuid,
  token_encrypted  text,
  licence_id       uuid,
  provisioned_at   timestamptz,
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz,
  last_error       text,
  revoke_pending   uuid[] NOT NULL DEFAULT '{}'::uuid[],
  op_id            uuid,
  op_until         timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO platform_inference_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON platform_inference_state TO cp_app;
    RAISE NOTICE '[0100] granted cp_app DML on platform_inference_state';
  ELSE
    RAISE NOTICE '[0100] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;

RESET lock_timeout;
