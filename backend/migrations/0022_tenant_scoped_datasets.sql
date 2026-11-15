-- 0022_tenant_scoped_datasets.sql — Phase 3.6 (Pillar A rework): test data is a
-- shared, org-level resource provisioned by IT, not private per-user data. Flip the
-- ownership/visibility axis of datasets from owner_id (who uploaded) to tenant_id
-- (the org). owner_id stays for audit; tenant_id becomes the scope every read filters
-- on and slugs are unique within. Challenges gain tenant_id so a challenge's tagged
-- datasets resolve within the org the challenge was raised in (the submitter no longer
-- needs to own the data they tag). Matches src/db/schema.ts (datasets, challenges).

-- ---- datasets: owner-scoped → tenant-scoped --------------------------------------
-- tenant_id has equalled owner_id to date (backfilled in 0014), so promoting it to the
-- scope key introduces no new (tenant_id, slug) collisions.
UPDATE datasets SET tenant_id = owner_id::text WHERE tenant_id IS NULL;

ALTER TABLE datasets ALTER COLUMN tenant_id SET NOT NULL;

-- Swap the slug-uniqueness key from (owner_id, slug) to (tenant_id, slug): a slug now
-- names one dataset within an org, so a challenge link's slug resolves deterministically.
ALTER TABLE datasets DROP CONSTRAINT IF EXISTS datasets_owner_slug_uq;

DO $$ BEGIN
  ALTER TABLE datasets ADD CONSTRAINT datasets_tenant_slug_uq UNIQUE (tenant_id, slug);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS datasets_tenant_id_idx ON datasets(tenant_id);

-- ---- challenges: carry the org the challenge was raised in -----------------------
-- So resolveChallengeDatasets / the §B6 involves chip / the agent context block scope
-- the challenge's tagged datasets by the challenge's tenant, not the submitter's space.
-- Scoped by value (no FK), consistent with datasets.tenant_id.
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- Backfill from the submitter's active tenant; fall back to the personal tenant
-- (id = user id, guaranteed by ensureUser / seedTenants) when active is unset.
UPDATE challenges c
   SET tenant_id = COALESCE(u.active_tenant_id, c.submitter_id)
  FROM users u
 WHERE u.id = c.submitter_id
   AND c.tenant_id IS NULL;

ALTER TABLE challenges ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS challenges_tenant_id_idx ON challenges(tenant_id);
