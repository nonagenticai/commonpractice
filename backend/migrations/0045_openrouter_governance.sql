-- 0045_openrouter_governance.sql
--
-- WHY: adding the `openrouter` preset to the provider catalog is not enough on an EXISTING
-- database. Two governance rows are derived from that catalog at SEED time
-- (`models.allowlist`, `data.egress_allowlist` in db/seed-platform.ts) and seeded with
-- `onConflictDoNothing`, so a database that already has them keeps the old values forever. The
-- result would be a tenant holding a funded OpenRouter budget whose every call is refused —
-- `models.allowlist` rejects an unlisted model before it reaches a provider (host/llm-broker.ts)
-- and `data.egress_allowlist` blocks the host (ai/llm/egress-fetch.ts).
--
-- A ONE-TIME additive merge is deliberately the right shape here, rather than making the seed
-- union these lists on every boot: these rows are operator-governed, and a boot-time union would
-- silently re-add anything an operator had chosen to remove. This runs once, is visible in the
-- migration log, and leaves the operator in control afterwards.
--
-- The literals below mirror provider-catalog.ts (DEFAULT_WORK_TIER_MODELS + OPENROUTER_HOST). That
-- duplication is intentional and safe: a migration must be a fixed historical statement, not a
-- reflection of whatever the code says at deploy time.
--
-- ADDITIVE / FORWARD-ONLY / PROD-SAFE + idempotent: each element is only appended when absent, so
-- re-running is a no-op and no existing entry is ever removed.

-- ---- models.allowlist: append the three work-tier models -------------------------------------
DO $$
DECLARE
  m text;
  models text[] := ARRAY[
    'google/gemma-4-26b-a4b-it:free',      -- work tier: small
    'nvidia/nemotron-3-super-120b-a12b',   -- work tier: medium
    'z-ai/glm-5.2'                         -- work tier: large
  ];
  added int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM policies WHERE key = 'models.allowlist') THEN
    RAISE NOTICE '[0045] models.allowlist absent → seed will create it from the catalog';
  ELSE
    FOREACH m IN ARRAY models LOOP
      UPDATE policies
         SET value = value || to_jsonb(m)
       WHERE key = 'models.allowlist'
         AND jsonb_typeof(value) = 'array'
         AND NOT (value @> to_jsonb(m));
      IF FOUND THEN added := added + 1; END IF;
    END LOOP;
    RAISE NOTICE '[0045] models.allowlist: appended % model(s)', added;
  END IF;
END $$;

-- ---- data.egress_allowlist: append the OpenRouter host ---------------------------------------
-- External HTTP must still be enabled separately (`models.external_http`) and the SSRF guard still
-- refuses private/loopback IPs — this only makes the host reachable, it does not open egress.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM policies WHERE key = 'data.egress_allowlist') THEN
    UPDATE policies
       SET value = value || to_jsonb('openrouter.ai'::text)
     WHERE key = 'data.egress_allowlist'
       AND jsonb_typeof(value) = 'array'
       AND NOT (value @> to_jsonb('openrouter.ai'::text));
    IF FOUND THEN
      RAISE NOTICE '[0045] data.egress_allowlist: appended openrouter.ai';
    ELSE
      RAISE NOTICE '[0045] data.egress_allowlist: openrouter.ai already present';
    END IF;
  END IF;
END $$;

-- ---- models.work_tiers: the editable small/medium/large map ----------------------------------
-- A governance row rather than a code constant so the model ids can be changed on the Governance
-- screen without a deploy — model ids churn far faster than releases do.
INSERT INTO policies (key, category, label, description, control, value, enabled, sort)
VALUES (
  'models.work_tiers',
  'models_tools',
  'Work-tier models',
  'Which model each work tier (small / medium / large) resolves to. A tenant granted a platform welcome budget runs against these; changing one takes effect on the next call, without a deploy.',
  'map',
  '{"small":"google/gemma-4-26b-a4b-it:free","medium":"nvidia/nemotron-3-super-120b-a12b","large":"z-ai/glm-5.2"}'::jsonb,
  true,
  15
)
ON CONFLICT (key) DO NOTHING;
