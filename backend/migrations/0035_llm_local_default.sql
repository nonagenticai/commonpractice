-- 0035_llm_local_default.sql — set EVERY existing tenant's LLM provider to the local pgx-vLLM
-- default (inference-router, model alias `local-llm`) at temperature 0.1, and retire the
-- misleading seed rows.
--
-- Why: provider selection was previously (a) silently ignored for per-tenant rows (an RLS-read bug,
-- fixed in ai/llm/select.ts) and (b) seeded with a fake `anthropic`/`claude-sonnet-4-6` row that
-- implied Claude when every call actually went to the in-cluster inference-router. This makes the
-- stored truth match reality and gives every tenant an explicit, UI-visible row.
--
-- PRESERVE BYO KEYS: a tenant that has configured its own provider key (api_key_encrypted IS NOT
-- NULL) is left untouched — only keyless rows are reset to the local default. New tenants created
-- AFTER this migration need no row: the resolver's env fallback already points at the inference-router.
--
-- Idempotent. Runs as the owner (migrations) so it bypasses RLS on tenant_llm_settings.

-- 1. Retire the legacy placeholder row (tenant_id='stub' is not a real tenant; it never resolved).
DELETE FROM tenant_llm_settings WHERE tenant_id = 'stub';

-- 2. Upsert the local default for every real tenant, preserving any row that holds a real BYO key.
INSERT INTO tenant_llm_settings (tenant_id, provider, model, base_url, temperature, params, updated_at)
SELECT
  t.id::text,
  'openai_compatible',
  'local-llm',
  'http://inference-router.inference-router.svc.cluster.local:8150/api',
  0.1,
  '{}'::jsonb,
  now()
FROM tenants t
ON CONFLICT (tenant_id) DO UPDATE SET
  provider    = EXCLUDED.provider,
  model       = EXCLUDED.model,
  base_url    = EXCLUDED.base_url,
  temperature = EXCLUDED.temperature,
  updated_at  = now()
WHERE tenant_llm_settings.api_key_encrypted IS NULL;  -- never clobber a configured BYO key
