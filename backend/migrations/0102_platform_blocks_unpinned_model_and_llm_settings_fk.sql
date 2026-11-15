-- 0102_platform_blocks_unpinned_model_and_llm_settings_fk.sql
--
-- TWO REPAIRS, ONE OWNER RULE (2026-10-13): commercial models are called ONLY with the tenant's own
-- key; the platform pays for local inference alone (services/byo-posture.ts `assertPlatformLocalOnly`).
--
-- PART 1 -- the five seeded GLOBAL blocks stop pinning a commercial model.
-- `ai-summarize`, `extract-fields`, `classify`, `compare-docs` (db/seed.ts) and `triage-claim`
-- (db/seed-example-blocks.ts) each called `ctx.llm({ model: "claude-sonnet-4-6", ... })`. A tenant on
-- the platform-paid router (the `local-llm` plan, or any keyless tenant) may not reach a commercial
-- model, so every one of those blocks was REFUSED (`llm_platform_local_only`) on every run. A platform
-- demo block must not name a model at all: with none on the request the broker resolves it -- the
-- tenant's own `tenant_llm_settings.model` when it has its own credential, otherwise AGENT_MODEL
-- (default `local-llm`). `host/llm-broker.ts` brokerLlmCall does that substitution.
--
-- WHY A MIGRATION AS WELL AS THE SEED EDIT: `seed()` skips a slug that already exists and production
-- runs with SEED_DEMO_DATA off, so the seed edit reaches only a database that has no such row yet. The
-- model lives in `block_versions.source_ts` (the module text), not in `descriptor` or any config jsonb.
--
-- SCOPE: GLOBAL blocks only (`building_blocks.tenant_id IS NULL`) and only these five slugs. A
-- tenant-owned block that happens to share a slug is the tenant's code and is never touched. EVERY
-- version of the slug is rewritten (the version picker can serve a non-current one). Idempotent: once
-- the pin is gone the regexp matches nothing.
--
-- PART 2 -- `tenant_llm_settings.tenant_id` gets the FOREIGN KEY it never had.
-- The table is keyed on `tenant_id` but referenced nothing, so offboarding a tenant left its settings
-- row behind -- including an ENCRYPTED PLATFORM OpenRouter key (prod holds one for the deleted tenant
-- 01a130e0...). Every other tenant-scoped table got `REFERENCES tenants(id) ON DELETE CASCADE` in 0028.
--
-- ORDER IS DELIBERATE: ADD ... NOT VALID first (a brief lock; from this instant no NEW orphan can be
-- written, so a pod still running the previous release cannot re-create one between the cleanup and the
-- validation), THEN delete the existing orphans, THEN VALIDATE (SHARE UPDATE EXCLUSIVE -- it does not
-- block writers). Concurrency across replicas is the runner's session advisory lock; each file also
-- runs in its own savepoint. The nil system tenant (00000000-...-0000) is NOT special-cased: it is kept
-- if it exists in `tenants` (migration 0014 backfilled it from the dev user) and is an orphan like any
-- other if it does not.
--
-- The migration runs as the table OWNER, which bypasses the table's RLS policy (ENABLE, not FORCE), so
-- the DELETE sees every row. `tenants` has no tenant-scoped policy that the FK check could trip on:
-- referential-integrity checks run as the owner of the referenced table.
SET LOCAL lock_timeout = '5s';

-- ---- PART 1 ---------------------------------------------------------------------------------
UPDATE block_versions
SET source_ts = regexp_replace(
      source_ts,
      'model\s*:\s*(["''`])claude-sonnet-4-6\1\s*,\s*',
      '',
      'g'
    )
WHERE block_id IN (
  SELECT id FROM building_blocks
  WHERE tenant_id IS NULL
    AND slug IN ('ai-summarize', 'extract-fields', 'classify', 'compare-docs', 'triage-claim')
)
  AND source_ts ~ 'model\s*:\s*["''`]claude-sonnet-4-6["''`]\s*,';

DO $$
DECLARE
  still_pinned int;
BEGIN
  SELECT count(*) INTO still_pinned
    FROM block_versions v
    JOIN building_blocks b ON b.id = v.block_id
   WHERE b.tenant_id IS NULL
     AND b.slug IN ('ai-summarize', 'extract-fields', 'classify', 'compare-docs', 'triage-claim')
     AND v.source_ts LIKE '%claude-sonnet-4-6%';
  IF still_pinned > 0 THEN
    RAISE EXCEPTION
      '0102: % global seeded block version(s) still name claude-sonnet-4-6 after the rewrite. The pin '
      'is in a shape the regexp does not match; a platform-paid tenant would keep being refused with '
      'llm_platform_local_only. Extend the pattern, do not delete this check.', still_pinned;
  END IF;
END $$;

-- ---- PART 2 ---------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tenant_llm_settings_tenant_fk'
       AND conrelid = 'tenant_llm_settings'::regclass
  ) THEN
    ALTER TABLE tenant_llm_settings
      ADD CONSTRAINT tenant_llm_settings_tenant_fk
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      NOT VALID;
  END IF;
END $$;

DELETE FROM tenant_llm_settings s
WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = s.tenant_id);

ALTER TABLE tenant_llm_settings VALIDATE CONSTRAINT tenant_llm_settings_tenant_fk;

RESET lock_timeout;
