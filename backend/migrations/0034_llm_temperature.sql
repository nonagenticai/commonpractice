-- 0034_llm_temperature.sql — first-class sampling temperature on tenant LLM settings.
--
-- Tenants configure model_provider / model_name / api_token / temperature in the tenant-admin
-- LLM-settings screen. Temperature was previously expressible only as a free-form key inside the
-- `params` jsonb; promote it to a typed, validated column so the UI, the backfill (0035), and the
-- provider resolver (ai/llm/select.ts, which merges it into the request body) all agree on one
-- typed source of truth. NULL = the provider/adapter default.
--
-- ADDITIVE / FORWARD-ONLY / PROD-SAFE: one nullable column on tenant_llm_settings. The table is
-- RLS-enabled, but a column-add needs no policy/grant change (the existing cp_app grants cover it).

ALTER TABLE tenant_llm_settings ADD COLUMN IF NOT EXISTS temperature real;

COMMENT ON COLUMN tenant_llm_settings.temperature IS
  'Sampling temperature (0-2). NULL = provider/adapter default. Merged into the request body by '
  'ai/llm/select.ts. Set per tenant in the tenant-admin LLM-settings UI.';
