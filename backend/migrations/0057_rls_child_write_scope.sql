-- 0057_rls_child_write_scope.sql
-- Cross-tenant WRITE on the children of PLATFORM-GLOBAL parents.
--
-- THE TRAP: `CREATE POLICY x ON t USING (…) WITH CHECK (…)` with NO `FOR` clause defaults to
-- `FOR ALL`. 0028 §4d and 0037 §4 both wrote the child-via-parent policies that way and reasoned
-- about them purely as VISIBILITY ("a child row is visible iff its parent is") — the comments in
-- both migrations say exactly that. But `FOR ALL` also governs INSERT/UPDATE/DELETE, and the
-- predicate only asks "IS THE PARENT ROW VISIBLE?".
--
-- That is safe while the parent's own policy is the STRICT shape `tenant_id = app_current_tenant_*()`
-- — visible ⇒ owned. It is NOT safe for a parent on the 4c "nullable global-override" shape
--   USING (tenant_id IS NULL OR tenant_id = app_current_tenant_*())
-- because a platform-GLOBAL parent (tenant_id IS NULL) is visible to EVERY tenant. Visible no
-- longer implies owned, so every tenant inherited UPDATE/DELETE/INSERT on the child rows of every
-- global parent: the platform block catalogue's versions and tests, the global ontology's
-- attributes, and the shipped MCP system prompts' versions. The parents themselves were never
-- writable (4c splits read from write correctly) — only their children were.
--
-- EMPIRICALLY PROVEN before this migration, as role `cp_app` with a fabricated tenant GUC
-- ('9999…9999') that owns nothing, everything inside BEGIN…ROLLBACK on the dev database:
--     UPDATE block_versions      … WHERE block_id  IN (global blocks)   → UPDATE 24
--     UPDATE block_tests         … WHERE block_id  IN (global blocks)   → UPDATE 17
--     INSERT INTO block_tests (block_id, name) VALUES (<global>, …)     → INSERT 0 1
--     UPDATE block_test_results  … (global chain)                       → UPDATE 2
--     DELETE block_test_results  … (global chain)                       → DELETE 2
--     UPDATE ontology_attributes … WHERE entity_id IN (global entities) → UPDATE 133
--     DELETE ontology_attributes … WHERE entity_id IN (global entities) → DELETE 133
--     UPDATE mcp_prompt_versions … WHERE prompt_id IN (global prompts)  → UPDATE 26
--     DELETE mcp_prompt_versions … WHERE prompt_id IN (global prompts)  → DELETE 26
--   CONTROL (the parents, already correct):
--     UPDATE building_blocks   WHERE tenant_id IS NULL                  → UPDATE 0
--     UPDATE ontology_entities WHERE tenant_id IS NULL                  → UPDATE 0
--     UPDATE mcp_prompts       WHERE tenant_id IS NULL                  → UPDATE 0
--
-- THE FIX: split each affected `FOR ALL` policy into
--   * `<child>_read`  FOR SELECT — the ORIGINAL visibility predicate, unchanged. The marketplace,
--     the block catalogue, the global ontology and the shipped prompts must stay readable by every
--     tenant; that is the product, not the bug.
--   * `<child>_write` FOR ALL — the same EXISTS, but additionally requiring the parent to be OWNED
--     by the current tenant (`p.tenant_id = app_current_tenant_*()`, which is NULL-false for a
--     global parent). Same predicate in USING and WITH CHECK, so INSERT is bound too.
-- For SELECT both policies apply and PERMISSIVE policies are OR'ed, so reads are exactly as before.
-- For INSERT/UPDATE/DELETE only `_write` applies, so writes are own-tenant-only.
--
-- Writing GLOBAL children is unaffected: those paths run through `runAsSystem` (db/client.ts), which
-- uses the OWNER pool. RLS is ENABLE, not FORCE, so the owner bypasses policies entirely. The one
-- path that did NOT is fixed in the same change (blocks/test-runner.ts persists block_test_results
-- and block_versions.tests_passing; it now wraps those two writes in runAsSystem for a global block).
--
-- SCOPE — only the five children whose parent uses the global-readable 4c shape are touched:
--   block_versions, block_tests, block_test_results  (parent chain → building_blocks, 0037 §4c, uuid)
--   ontology_attributes                              (parent ontology_entities, 0028 §4c, uuid)
--   mcp_prompt_versions                              (parent mcp_prompts,       0028 §4c, TEXT)
-- The other three 4d children are LEFT ALONE and stay `FOR ALL` on visibility, which is correct for
-- them: challenge_datasets→challenges, chat_messages→chat_sessions and dataset_rows→datasets all
-- have parents on the STRICT §4a/§4b shape with no `IS NULL` branch, so visible ⇒ owned there.
-- NOTE the helper differs per parent: mcp_prompts stores tenant_id as TEXT and its own policies use
-- app_current_tenant_text(); the other four parents are uuid → app_current_tenant_uuid().
-- (mcp_tool_versions was in the 0028 §4d list but mcp_tools/mcp_tool_versions were dropped in 0052.)
--
-- ANTI-DRIFT GAP worth naming: tests/rls-coverage.test.ts only enumerates tables that CARRY a
-- `tenant_id` column. All eight 4d children carry none — they are scoped purely through their
-- parent — so they were structurally invisible to that guard and it could never have caught this.
-- The enforcement proof for these five lives in tests/rls-child-write.test.ts.
--
-- IDEMPOTENT / RE-RUNNABLE: migrations run at pod STARTUP with 2-4 replicas, so every statement is
-- DROP … IF EXISTS then CREATE. Re-running converges; a partially-applied state converges too.
-- FORWARD-ONLY and read-compatible for SELECT: no old replica loses a read it had.
--
-- ⚠️ IT IS *NOT* WRITE-COMPATIBLE, AND THERE IS A REAL (BOUNDED) OUTAGE WINDOW. An earlier draft of
-- this header claimed "the only writes it loses are the cross-tenant ones this migration exists to
-- remove". That is FALSE and the correction matters, because migrations run at pod STARTUP with 2-4
-- replicas: the instant the FIRST replica applies 0057, the policies are cluster-wide, while the
-- other 1-3 replicas are still running PRE-0057 application code. That old code performs ONE
-- LEGITIMATE write that 0057 now rejects — testing a PLATFORM (global) block. Pre-0057
-- blocks/test-runner.ts persisted block_test_results and block_versions.tests_passing in the
-- CALLER's tenant context, leaning on the very `visible ⇒ writable` looseness being removed here.
-- Proven by running the pre-0057 statement verbatim inside withTenantDbAsRuntimeRoleForTests
-- against a global block:
--     old code → 42501 new row violates row-level security policy for table "block_test_results"
--     new code → write lands
-- What breaks on an un-rolled replica, for a PLATFORM block only:
--     POST /api/blocks/:slug/versions/:version/test   → 500 (JSON) / `event: error` (SSE)
--     publishVersionCore → 'stable' when block_publish.require_passing_tests is ON
--                                                     → 500 (authoring-service.ts, runBlockTests call)
--     MCP tool `run_block_test`                       → tool error (ai/mcp/tools.ts)
-- BLAST RADIUS: super_admin ONLY. authorizeBlockWriteByRoles (authoring-service.ts:74) rejects every
-- non-super_admin write to a tenant_id IS NULL block before the runner is ever reached, so no tenant
-- user, tenant_admin or developer can be in this path. Tenant-owned blocks are unaffected in both
-- code versions (their parent is OWNED, so `_write` passes exactly as `_via_parent` did).
-- NO DATA LOSS: the failure is a clean pre-write RLS rejection (42501), not a partial write — no row
-- is half-inserted and no tests_passing rollup is left wrong-but-persisted. Re-running the block's
-- tests after the rollout fully restores state.
-- DECISION: the window is ACCEPTED, not sequenced. It is bounded by the rolling update (the seconds
-- between the first replica's startup migration and the last old pod terminating), it is confined to
-- one super_admin authoring action on the platform catalogue, it is retryable, and it costs nothing
-- but a retry. Sequencing it (drain to a single replica, migrate, then roll) would trade a
-- retryable super_admin 500 for a real availability dip on every tenant-facing route. If a platform
-- block publish must not be interrupted, do it BEFORE the deploy or AFTER the rollout completes.

-- ---------------------------------------------------------------------------------------------
-- 1. Children of `building_blocks` (0037 §4c parent, uuid tenant_id).
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('block_versions', 'block_id'),
    ('block_tests',    'block_id')
  ) AS v(child, fk) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', r.child);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.child || '_via_parent', r.child);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.child || '_read', r.child);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.child || '_write', r.child);
    -- READ: unchanged visibility — global ∪ own-tenant blocks, via building_blocks' own SELECT policy.
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (EXISTS (SELECT 1 FROM building_blocks p WHERE p.id = %I.%I))',
      r.child || '_read', r.child, r.child, r.fk);
    -- WRITE: the parent must be OWNED. NULL (global) fails `= app_current_tenant_uuid()`.
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL '
      || 'USING (EXISTS (SELECT 1 FROM building_blocks p WHERE p.id = %I.%I AND p.tenant_id = app_current_tenant_uuid())) '
      || 'WITH CHECK (EXISTS (SELECT 1 FROM building_blocks p WHERE p.id = %I.%I AND p.tenant_id = app_current_tenant_uuid()))',
      r.child || '_write', r.child, r.child, r.fk, r.child, r.fk);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 2. block_test_results — parent is block_versions, which carries NO tenant_id of its own, so
--    ownership has to be traced one hop further, through block_versions.block_id → building_blocks.
--    (`p.tenant_id = app_current_tenant_uuid()` on the GRANDparent; the intermediate block_versions
--    row is reachable in the subquery under its own `block_versions_read` policy above.)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE block_test_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS block_test_results_via_parent ON block_test_results;
DROP POLICY IF EXISTS block_test_results_read ON block_test_results;
DROP POLICY IF EXISTS block_test_results_write ON block_test_results;
CREATE POLICY block_test_results_read ON block_test_results FOR SELECT
  USING (EXISTS (SELECT 1 FROM block_versions p WHERE p.id = block_test_results.version_id));
CREATE POLICY block_test_results_write ON block_test_results FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM block_versions v
      JOIN building_blocks p ON p.id = v.block_id
      WHERE v.id = block_test_results.version_id
        AND p.tenant_id = app_current_tenant_uuid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM block_versions v
      JOIN building_blocks p ON p.id = v.block_id
      WHERE v.id = block_test_results.version_id
        AND p.tenant_id = app_current_tenant_uuid()
    )
  );

-- ---------------------------------------------------------------------------------------------
-- 3. ontology_attributes — parent ontology_entities (0028 §4c, uuid tenant_id).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE ontology_attributes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ontology_attributes_via_parent ON ontology_attributes;
DROP POLICY IF EXISTS ontology_attributes_read ON ontology_attributes;
DROP POLICY IF EXISTS ontology_attributes_write ON ontology_attributes;
CREATE POLICY ontology_attributes_read ON ontology_attributes FOR SELECT
  USING (EXISTS (SELECT 1 FROM ontology_entities p WHERE p.id = ontology_attributes.entity_id));
CREATE POLICY ontology_attributes_write ON ontology_attributes FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM ontology_entities p
      WHERE p.id = ontology_attributes.entity_id
        AND p.tenant_id = app_current_tenant_uuid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ontology_entities p
      WHERE p.id = ontology_attributes.entity_id
        AND p.tenant_id = app_current_tenant_uuid()
    )
  );

-- ---------------------------------------------------------------------------------------------
-- 4. mcp_prompt_versions — parent mcp_prompts (0028 §4c, but tenant_id is TEXT → the _text helper).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE mcp_prompt_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mcp_prompt_versions_via_parent ON mcp_prompt_versions;
DROP POLICY IF EXISTS mcp_prompt_versions_read ON mcp_prompt_versions;
DROP POLICY IF EXISTS mcp_prompt_versions_write ON mcp_prompt_versions;
CREATE POLICY mcp_prompt_versions_read ON mcp_prompt_versions FOR SELECT
  USING (EXISTS (SELECT 1 FROM mcp_prompts p WHERE p.id = mcp_prompt_versions.prompt_id));
CREATE POLICY mcp_prompt_versions_write ON mcp_prompt_versions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM mcp_prompts p
      WHERE p.id = mcp_prompt_versions.prompt_id
        AND p.tenant_id = app_current_tenant_text()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM mcp_prompts p
      WHERE p.id = mcp_prompt_versions.prompt_id
        AND p.tenant_id = app_current_tenant_text()
    )
  );

DO $$
BEGIN
  RAISE NOTICE '[0057] child-via-parent write scope tightened on 5 tables (read unchanged)';
END $$;
