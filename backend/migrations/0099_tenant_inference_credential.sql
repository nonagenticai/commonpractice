-- 0099 — a per-tenant inference-router credential, and the end of the OpenRouter welcome budget.
--
-- (1) A `local-llm` tenant calls the in-cluster inference-router with ITS OWN `inference-router`
--     licence token instead of the shared `Bearer EMPTY` sentinel, so IR attributes, meters and
--     budgets the call to the tenant (ai/llm/select.ts, services/tenant-inference.ts). The token is
--     stored exactly like `license_token_encrypted`: secret-box encrypted, write-only, never returned
--     by a read endpoint. `inference_licence_id` is the licence it was minted from (revoked on plan
--     change away from local-llm and on offboard).
--
-- (2) The welcome budget is retired: nothing grants, polls or alerts on `tenant_llm_budgets` any
--     more. The table stays (history, and the offboard path reads it once to revoke a still-live
--     OpenRouter grant key); `revoked` records that the key was disabled at OpenRouter.
--
-- FORWARD-ONLY, idempotent (runs at startup on every replica).
SET LOCAL lock_timeout = '5s';

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS inference_token_encrypted text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS inference_licence_id uuid;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS inference_provisioned_at timestamptz;

ALTER TABLE tenant_llm_budgets DROP CONSTRAINT IF EXISTS tenant_llm_budgets_status_check;
ALTER TABLE tenant_llm_budgets ADD CONSTRAINT tenant_llm_budgets_status_check
  CHECK (status IN ('active', 'exhausted', 'replaced', 'revoked'));

RESET lock_timeout;
