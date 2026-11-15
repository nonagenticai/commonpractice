-- 0053_llm_price_source_and_model_pricing.sql
--
-- WHY: `usage_events.cost_usd` was priced by multiplying tokens by two flat constants
-- (config.llm.inRateUsd/outRateUsd, $3/$15 per Mtok — "Claude-Sonnet-ish"), whose own config
-- comment said it was "Mock pricing … so totals look real". It was model-blind AND provider-blind:
-- the in-cluster `local-llm` (marginal cost ~$0) and `google/gemma-4-26b-a4b-it:free` (real price
-- exactly zero) were billed at Claude-Sonnet rates like everything else.
--
-- That was never merely cosmetic. host/llm-broker.ts sums `usage_counters.spend_usd` over a
-- rolling 7 days and refuses the call with `llm_capped` once it crosses the
-- `spend.weekly_spend_ceiling` policy. A tenant running ONLY free or local models could therefore
-- be REFUSED SERVICE for spend that never happened.
--
-- This migration ships the two persistent halves of the fix:
--   1. `usage_events.price_source` — provenance, so a provider-reported figure can stop being
--      hedged as an estimate in the UI and rows priced under the old regime stay distinguishable.
--   2. the `models.pricing` governance row — the per-model price table, operator-editable.
--
-- Why a governance row and not a code constant: there is NO pricing API for the five direct
-- providers (Anthropic, OpenAI, DeepSeek, xAI, Cohere) — `/v1/models` returns ids and
-- capabilities, never prices. So the table is hand-maintained and WILL go stale, and a stale price
-- must be correctable on the Governance screen rather than by cutting a release. This is the exact
-- precedent `models.work_tiers` set in 0045, using the same `map` control, for the same reason.
--
-- ADDITIVE / FORWARD-ONLY / PROD-SAFE. CP runs migrations at backend STARTUP against the live
-- database, so nothing here may block:
--   * ADD COLUMN with no default and no NOT NULL is a catalogue-only change in PG11+ (no rewrite).
--   * The CHECK is added NOT VALID on purpose: it constrains every future row (which is all we
--     need) without scanning the existing table at boot. Every pre-existing row is NULL anyway.
--   * The policy INSERT is ON CONFLICT DO NOTHING, so an operator's edited row is never clobbered.

-- ---- 1. price_source: where cost_usd came from ------------------------------------------------
-- NULLABLE by design, and historical rows are deliberately NOT backfilled. Every existing row was
-- priced flat with no per-call price record kept, so there is nothing to reconstruct from —
-- stamping them 'flat' would assert a provenance we never recorded. NULL means "priced before this
-- column existed", and it is what makes a /usage range spanning the cutover visibly mixed rather
-- than silently reconciled.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS price_source TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'usage_events_price_source_chk'
  ) THEN
    ALTER TABLE usage_events
      ADD CONSTRAINT usage_events_price_source_chk
      CHECK (price_source IS NULL OR price_source IN ('provider', 'table', 'flat'))
      NOT VALID;
    RAISE NOTICE '[0053] usage_events.price_source: column + CHECK added';
  END IF;
END $$;

-- ---- 2. models.pricing: the editable per-model price table ------------------------------------
-- Key is `<presetKey>/<model>` split on the FIRST slash, so an OpenRouter id that already contains
-- slashes round-trips intact. Value is "<inputUsdPerMtok>/<outputUsdPerMtok>" — the unit every
-- vendor quotes. A `<preset>/*` key prices every model of that preset.
--
-- The literals below mirror provider-catalog.ts at the time of writing. That duplication is
-- intentional and safe, exactly as in 0045: a migration must be a fixed historical statement, not
-- a reflection of whatever the code says at deploy time.
--
-- Sourced 2026-07-29 from each vendor's own pricing page. Two deliberate omissions:
--   * cohere/command-a-plus-05-2026, command-a-reasoning-08-2025, command-a-03-2025 — Cohere
--     publishes NO per-token rate for the Command A family (it has moved behind contact-sales).
--     They are left unpriced rather than guessed, and will bill at the flat estimate with
--     price_source='flat' until someone fills them in from a quote.
--   * every `custom` preset model — unpriceable by definition.
-- One known inaccuracy, accepted: xAI doubles both rates above a 200k-token prompt and this table
-- has no prompt-length branch, so a >200k call under-bills by half. It fails safe (never
-- over-charges, never falsely trips the ceiling).
INSERT INTO policies (key, category, label, description, control, value, enabled, sort)
VALUES (
  'models.pricing',
  'spend_quota',
  'Per-model prices (USD per million tokens)',
  'What the metered LLM broker charges a call at, as "input/output" USD per million tokens, keyed by <provider>/<model>. A provider that reports its own cost per call (OpenRouter) always overrides this; a model missing from this list falls back to a flat estimate and is flagged as such on the Usage screen. Editing a price takes effect on the next call, without a deploy.',
  'map',
  '{
    "local/*": "0/0",
    "anthropic/claude-opus-4-8": "5/25",
    "anthropic/claude-sonnet-4-6": "3/15",
    "anthropic/claude-haiku-4-5": "1/5",
    "anthropic/claude-fable-5": "10/50",
    "openai/gpt-4o": "2.5/10",
    "openai/gpt-4.1": "2/8",
    "openai/o4-mini": "1.1/4.4",
    "deepseek/deepseek-v4-flash": "0.14/0.28",
    "deepseek/deepseek-v4-pro": "0.435/0.87",
    "xai/grok-4.5": "2/6",
    "xai/grok-4.3": "1.25/2.5",
    "xai/grok-4.20-0309-reasoning": "1.25/2.5",
    "xai/grok-4.20-0309-non-reasoning": "1.25/2.5",
    "cohere/command-r-plus-08-2024": "2.5/10",
    "openrouter/google/gemma-4-26b-a4b-it:free": "0/0",
    "openrouter/nvidia/nemotron-3-super-120b-a12b": "0.085/0.4",
    "openrouter/z-ai/glm-5.2": "0.6958/2.1868"
  }'::jsonb,
  true,
  25
)
ON CONFLICT (key) DO NOTHING;
