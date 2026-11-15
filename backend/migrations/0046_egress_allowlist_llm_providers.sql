-- 0046_egress_allowlist_llm_providers.sql
--
-- WHY: bring-your-own-key is dead in production for every external provider.
--
-- `ai/llm/select.ts buildAdapter` wraps every tenant adapter in `governedLlmFetch()`, which for an
-- external host calls `assertEgressAllowed` — and that requires the host to be on the
-- `data.egress_allowlist` policy. The provider catalog offers Anthropic, OpenAI, DeepSeek, Grok/xAI
-- and Cohere, but the LIVE prod row contains only:
--     ["fr-backend.fr.svc.cluster.local", "storage-api.storage.svc.cluster.local", "openrouter.ai"]
-- So a tenant admin opens LLM settings, selects Anthropic, pastes a VALID key, hits Test — and gets
-- an egress error. Nothing in the tenant UI can fix it: `policies` is a platform-global table that
-- only a super_admin can read or write (routes/governance.ts). The network is not the blocker —
-- api.anthropic.com is reachable from the pod (401, i.e. it answered) — this is purely the
-- app-level allowlist.
--
-- Why a migration and not the seed: `db/seed-platform.ts` DOES derive this row from
-- `CATALOG_PROVIDER_HOSTS`, but it seeds with `onConflictDoNothing`, so a database that already has
-- the row never gains a newly-catalogued host. Exactly the trap 0045 hit for `models.allowlist`.
-- A one-time additive merge is the right shape: it repairs existing installs once, is visible in the
-- migration log, and leaves the operator in control afterwards (a boot-time union would silently
-- re-add anything they deliberately removed).
--
-- The literals mirror provider-catalog.ts. That duplication is intentional: a migration must be a
-- fixed historical statement, not a reflection of whatever the code says at deploy time.
--
-- ADDITIVE / FORWARD-ONLY / PROD-SAFE + idempotent: each host is appended only when absent, nothing
-- is ever removed, and re-running is a no-op.
--
-- NOTE this does NOT open egress by itself. `models.external_http` must also be on (it is, in prod),
-- and the SSRF guard still refuses private/loopback targets. This only makes a host reachable.

DO $$
DECLARE
  h text;
  hosts text[] := ARRAY[
    'api.anthropic.com',   -- anthropic  (native, no base_url in the catalog)
    'api.openai.com',      -- openai
    'api.deepseek.com',    -- deepseek
    'api.x.ai',            -- xai / Grok
    'api.cohere.ai'        -- cohere (OpenAI-compat surface)
  ];
  added int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM policies WHERE key = 'data.egress_allowlist') THEN
    RAISE NOTICE '[0046] data.egress_allowlist absent → the seed will create it from the catalog';
  ELSE
    FOREACH h IN ARRAY hosts LOOP
      UPDATE policies
         SET value = value || to_jsonb(h)
       WHERE key = 'data.egress_allowlist'
         AND jsonb_typeof(value) = 'array'
         AND NOT (value @> to_jsonb(h));
      IF FOUND THEN added := added + 1; END IF;
    END LOOP;
    RAISE NOTICE '[0046] data.egress_allowlist: appended % provider host(s)', added;
  END IF;
END $$;
