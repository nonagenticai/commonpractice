-- 0028_rls.sql — Phase 4 / Phase D: Postgres Row-Level Security backstop (provable tenant isolation).
--
-- Spec: SPEC-PHASE4-admin-tenant-isolation.md Part 3.6 / Part 7-D. Application-layer isolation
-- (the per-query `WHERE tenant_id = ?`) cannot PROVE that no code path leaks across tenants. This
-- migration adds the database-level backstop: every tenant-scoped table gets RLS keyed on a
-- per-request session GUC `app.current_tenant`, and a dedicated non-superuser, NOBYPASSRLS role
-- `cp_app` that the policy actually binds.
--
-- PROD-SAFE / FORWARD-ONLY: this runs on prod boot (self-migrate) as the table OWNER
-- (`commonpractice`), BEFORE the runtime-role cutover (D.1.1). It is designed to be a no-op for the
-- owner-connected app:
--   * RLS is ENABLE (not FORCE) → the owner BYPASSES it → zero behaviour change in prod until the
--     runtime connects as cp_app (D.1.1). Enforcement is proven in CI by tests connecting AS cp_app.
--   * Role creation is graceful when the owner lacks CREATEROLE (D.1.1 creates cp_app as superuser).
--   * Backfill is non-failing and non-destructive: resolve tenant from owner/parent, else the pinned
--     demo tenant (00000000-0000-0000-0000-000000000001, pinned in 0026). New columns are NULLABLE in
--     D.1 (a NULL tenant_id is fail-closed under RLS — invisible — and harmless); SET NOT NULL is
--     deferred to D.1.1 once the out-of-ALS insert paths (run-pump, schedulers) thread the tenant.
--     Never RAISE EXCEPTION (would break boot).
--
-- COVERAGE: tenant-scoped tables get RLS; PLATFORM/GLOBAL tables (tenants, users, signup_approvals,
-- email_domain_tenants, free_email_providers, policies, policy_changes, audit_log, audit_exports,
-- marketplace_cycles, building_blocks/_versions/_tests/_test_results, content_translations,
-- translation_jobs, _migrations) and the PLATFORM Operate pipeline (pipeline_items — requireRole
-- 'platform', a super_admin cross-tenant surface reached via the narrow platform path, Part 3.6) stay
-- OUTSIDE RLS. The Discover marketplace (challenges/solutions/votes/comments/weekly_winners) becomes
-- tenant-scoped per the isolation mandate — RLS scopes the existing predicate-less queries with no
-- route changes (effective once prod is on cp_app).

-- ============================================================================
-- 1. GUC helpers — fail-closed, never error on an unset/blank GUC.
--    current_setting(...,true) → NULL when unset. After a RESET a custom GUC reads as '' which would
--    raise on ::uuid, so nullif(...,'') normalises it to NULL (→ predicate false → zero rows).
-- ============================================================================
CREATE OR REPLACE FUNCTION app_current_tenant_uuid() RETURNS uuid
  LANGUAGE sql STABLE AS
  $fn$ SELECT nullif(current_setting('app.current_tenant', true), '')::uuid $fn$;

CREATE OR REPLACE FUNCTION app_current_tenant_text() RETURNS text
  LANGUAGE sql STABLE AS
  $fn$ SELECT nullif(current_setting('app.current_tenant', true), '') $fn$;

-- ============================================================================
-- 2. The runtime role. NOLOGIN here (no password in source); CI's isolation test elevates it to
--    LOGIN PASSWORD in beforeAll and back in afterAll; D.1.1 creates it with a SOPS password in prod.
--    Graceful when the migrating owner lacks CREATEROLE → skip; GRANTs below are role-existence-guarded.
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    CREATE ROLE cp_app NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
    RAISE NOTICE '[0028] created role cp_app (NOLOGIN, NOBYPASSRLS)';
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE '[0028] cp_app not created (owner lacks CREATEROLE); D.1.1 creates it as superuser';
END $$;

-- ============================================================================
-- 3. Add + backfill tenant_id on the convention-leak tables (scoped only by owner/flow today).
--    Add NULLABLE + no-default first (a function default would evaluate to NULL for existing rows at
--    ADD time), backfill, THEN add the GUC default + FK (hard-scoped) + index. Stays nullable in D.1.
-- ============================================================================
ALTER TABLE flows          ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE sandboxes      ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE usage_counters ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE chat_sessions  ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE flow_runs      ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE flow_snapshots ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE solutions      ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE votes          ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE comments       ADD COLUMN IF NOT EXISTS tenant_id uuid;
ALTER TABLE weekly_winners ADD COLUMN IF NOT EXISTS tenant_id uuid;

-- 3a. Owner-derived (independent).
UPDATE flows f          SET tenant_id = u.tenant_id FROM users u WHERE u.id = f.owner_id    AND f.tenant_id IS NULL;
UPDATE sandboxes s      SET tenant_id = u.tenant_id FROM users u WHERE u.id = s.owner_id    AND s.tenant_id IS NULL;
UPDATE usage_counters c SET tenant_id = u.tenant_id FROM users u WHERE u.id = c.user_id     AND c.tenant_id IS NULL;
UPDATE agent_sessions a SET tenant_id = u.tenant_id FROM users u WHERE u.id = a.user_id     AND a.tenant_id IS NULL;

-- 3b. Flow-derived (flows backfilled above).
UPDATE flow_runs fr      SET tenant_id = f.tenant_id FROM flows f WHERE f.id = fr.flow_id   AND fr.tenant_id IS NULL;
UPDATE flow_snapshots fs SET tenant_id = f.tenant_id FROM flows f WHERE f.id = fs.flow_id   AND fs.tenant_id IS NULL;
UPDATE chat_sessions cs  SET tenant_id = COALESCE(
  (SELECT f.tenant_id FROM flows f WHERE f.id = cs.flow_id),
  (SELECT u.tenant_id FROM users u WHERE u.id = cs.user_id)) WHERE cs.tenant_id IS NULL;

-- 3c. Marketplace: normalise the legacy challenges.tenant_id (seed set it to the author's user id, a
--     pre-C.1 "personal tenant" artifact) to the demo tenant, then derive the rest from it.
UPDATE challenges
  SET tenant_id = '00000000-0000-0000-0000-000000000001'
  WHERE NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = challenges.tenant_id)
    AND EXISTS (SELECT 1 FROM tenants WHERE id = '00000000-0000-0000-0000-000000000001');
UPDATE solutions s SET tenant_id = c.tenant_id FROM challenges c WHERE c.id = s.challenge_id AND s.tenant_id IS NULL;
UPDATE votes v SET tenant_id = c.tenant_id FROM challenges c
  WHERE v.target_type = 'challenge' AND c.id = v.target_id AND v.tenant_id IS NULL;
UPDATE votes v SET tenant_id = s.tenant_id FROM solutions s
  WHERE v.target_type = 'solution' AND s.id = v.target_id AND v.tenant_id IS NULL;
UPDATE comments cm SET tenant_id = c.tenant_id FROM challenges c WHERE c.id = cm.challenge_id AND cm.tenant_id IS NULL;
UPDATE weekly_winners w SET tenant_id = s.tenant_id FROM solutions s WHERE s.id = w.solution_id AND w.tenant_id IS NULL;

-- 3d. Residuals → pinned demo tenant if it exists (non-destructive). Marketplace has no FK so the
--     demo-coalesce is unconditional there; the FK tables only coalesce when demo exists.
DO $$
DECLARE demo uuid := '00000000-0000-0000-0000-000000000001';
        has_demo boolean := EXISTS (SELECT 1 FROM tenants WHERE id = demo);
BEGIN
  IF has_demo THEN
    UPDATE flows          SET tenant_id = demo WHERE tenant_id IS NULL;
    UPDATE sandboxes      SET tenant_id = demo WHERE tenant_id IS NULL;
    UPDATE usage_counters SET tenant_id = demo WHERE tenant_id IS NULL;
    UPDATE agent_sessions SET tenant_id = demo WHERE tenant_id IS NULL;
    UPDATE chat_sessions  SET tenant_id = demo WHERE tenant_id IS NULL;
    UPDATE flow_runs      SET tenant_id = demo WHERE tenant_id IS NULL;
    UPDATE flow_snapshots SET tenant_id = demo WHERE tenant_id IS NULL;
  END IF;
  -- marketplace (no FK to violate): coalesce residuals to demo regardless.
  UPDATE solutions      SET tenant_id = demo WHERE tenant_id IS NULL;
  UPDATE votes          SET tenant_id = demo WHERE tenant_id IS NULL;
  UPDATE comments       SET tenant_id = demo WHERE tenant_id IS NULL;
  UPDATE weekly_winners SET tenant_id = demo WHERE tenant_id IS NULL;
END $$;

-- 3e. Lock in: GUC default + FK (hard-scoped tables) + index. Columns stay NULLABLE in D.1
--     (residual NULLs are fail-closed under RLS); D.1.1 adds NOT NULL after threading the tenant
--     through the out-of-ALS insert paths. FK still allows NULL (checks non-null values only).
DO $$
DECLARE tbl text;
BEGIN
  -- hard-scoped (FK to tenants)
  FOREACH tbl IN ARRAY ARRAY['flows','sandboxes','usage_counters','agent_sessions','chat_sessions','flow_runs','flow_snapshots'] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT app_current_tenant_uuid()', tbl);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = tbl || '_tenant_fk') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE', tbl, tbl || '_tenant_fk');
    END IF;
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)', tbl || '_tenant_id_idx', tbl);
  END LOOP;
  -- marketplace (scoped-by-value, no FK — matches challenges.tenant_id)
  FOREACH tbl IN ARRAY ARRAY['solutions','votes','comments','weekly_winners'] LOOP
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT app_current_tenant_uuid()', tbl);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id)', tbl || '_tenant_id_idx', tbl);
  END LOOP;
END $$;

-- ============================================================================
-- 4. Enable RLS + policies.
--    Strict tables: USING/WITH CHECK (tenant_id = app_current_tenant_*()). Unset GUC → NULL → zero
--    rows (read) / rejected (write) — fail-closed. ENABLE (not FORCE): the owner bypasses (so seed /
--    migrations / schedulers stay simple); cp_app (non-owner, NOBYPASSRLS) is fully bound.
-- ============================================================================

-- 4a. Strict, non-null uuid.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'mcp_api_keys','challenges','usage_events',
    'flows','sandboxes','usage_counters','agent_sessions','chat_sessions','flow_runs','flow_snapshots',
    'solutions','votes','comments','weekly_winners'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_tenant', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant_uuid()) WITH CHECK (tenant_id = app_current_tenant_uuid())',
      tbl || '_tenant', tbl);
  END LOOP;
END $$;

-- 4b. Strict, non-null text (tenant_id stored as text).
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['datasets','tenant_llm_settings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_tenant', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant_text()) WITH CHECK (tenant_id = app_current_tenant_text())',
      tbl || '_tenant', tbl);
  END LOOP;
END $$;

-- 4c. Nullable global-override tables: read global (NULL) + own-tenant; writes own-tenant only
--     (only the owner/platform seeds global rows — INSERT WITH CHECK rejects NULL because
--     NULL = uuid is NULL → fails). uuid + text variants.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['ontology_entities','ontology_relations','dataset_mappings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_read', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_ins', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_upd', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_del', tbl);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id IS NULL OR tenant_id = app_current_tenant_uuid())', tbl || '_read', tbl);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (tenant_id = app_current_tenant_uuid())', tbl || '_ins', tbl);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (tenant_id = app_current_tenant_uuid()) WITH CHECK (tenant_id = app_current_tenant_uuid())', tbl || '_upd', tbl);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (tenant_id = app_current_tenant_uuid())', tbl || '_del', tbl);
  END LOOP;
  FOREACH tbl IN ARRAY ARRAY['mcp_prompts','mcp_tools'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_read', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_ins', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_upd', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_del', tbl);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (tenant_id IS NULL OR tenant_id = app_current_tenant_text())', tbl || '_read', tbl);
    EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (tenant_id = app_current_tenant_text())', tbl || '_ins', tbl);
    EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE USING (tenant_id = app_current_tenant_text()) WITH CHECK (tenant_id = app_current_tenant_text())', tbl || '_upd', tbl);
    EXECUTE format('CREATE POLICY %I ON %I FOR DELETE USING (tenant_id = app_current_tenant_text())', tbl || '_del', tbl);
  END LOOP;
END $$;

-- 4d. Child tables (no own tenant_id; RLS does NOT cascade through FKs). EXISTS against the
--     already-RLS-filtered parent — a child row is visible iff its parent is. Cheap PK lookup.
--     (parent table, child table, fk column)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('challenge_datasets','challenges','challenge_id'),
    ('dataset_rows','datasets','dataset_id'),
    ('chat_messages','chat_sessions','session_id'),
    ('ontology_attributes','ontology_entities','entity_id'),
    ('mcp_prompt_versions','mcp_prompts','prompt_id'),
    ('mcp_tool_versions','mcp_tools','tool_id')
  ) AS v(child, parent, fk) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.child);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.child || '_via_parent', r.child);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I)) WITH CHECK (EXISTS (SELECT 1 FROM %I p WHERE p.id = %I.%I))',
      r.child || '_via_parent', r.child, r.parent, r.child, r.fk, r.parent, r.child, r.fk);
  END LOOP;
END $$;

-- ============================================================================
-- 5. GRANTs to cp_app (role-existence-guarded). cp_app is NOBYPASSRLS + non-owner, so RLS is the row
--    boundary; table-level grant breadth is not the risk. Future tables auto-grant via DEFAULT PRIVS.
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT USAGE ON SCHEMA public TO cp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cp_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cp_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cp_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO cp_app;
    EXECUTE 'GRANT EXECUTE ON FUNCTION app_current_tenant_uuid() TO cp_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION app_current_tenant_text() TO cp_app';
    RAISE NOTICE '[0028] granted cp_app DML on public + default privileges';
  ELSE
    RAISE NOTICE '[0028] cp_app absent → GRANTs skipped (D.1.1 will create + grant in prod)';
  END IF;
END $$;
