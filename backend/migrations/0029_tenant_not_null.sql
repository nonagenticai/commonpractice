-- 0029_tenant_not_null.sql — Phase 4 / D.1.1: enforce NOT NULL on the tenant_id columns 0028 added.
--
-- 0028 added tenant_id as NULLABLE on the convention-leak + marketplace tables and backfilled it
-- (resolve from owner/parent, else the pinned demo tenant). It left the columns nullable because the
-- out-of-ALS insert paths (run-pump, schedulers, seed) did not yet thread the tenant — a stray NULL
-- there would have hard-failed boot. D.1.1's code changes now make every insert path carry the
-- tenant (request GUC default, runAsSystem, or explicit value), so this migration finishes the job:
-- SET NOT NULL on the 11 columns, turning "fail-closed-invisible" into "structurally impossible".
--
-- PROD-SAFE / FORWARD-ONLY: runs on prod boot as the OWNER. SET NOT NULL aborts the migration tx if
-- ANY row still has a NULL tenant_id, so — defensively — each column is re-backfilled (idempotent,
-- copies 0028's derivation), residual NULLs are coalesced to the pinned demo tenant when it exists,
-- and any truly-unresolvable residual is DELETEd with a RAISE NOTICE of the count (0 in CI/prod after
-- 0028; these would be unreachable working docs of a tenant-less user). Never RAISE EXCEPTION.
-- pipeline_items stays NULLABLE (platform-global Operate board — explicitly outside the tenant regime).

-- ============================================================================
-- 1. Re-backfill + demo-coalesce, then SET NOT NULL — hard-scoped (FK to tenants) tables.
--    Order: flows before its dependents (flow_runs / flow_snapshots / chat_sessions).
-- ============================================================================
DO $$
DECLARE
  demo uuid := '00000000-0000-0000-0000-000000000001';
  has_demo boolean := EXISTS (SELECT 1 FROM tenants WHERE id = demo);
  tbl text;
  n bigint;
BEGIN
  -- 1a. Owner/flow-derived re-backfill (idempotent; only touches still-NULL rows).
  UPDATE flows f          SET tenant_id = u.tenant_id FROM users u WHERE u.id = f.owner_id    AND f.tenant_id IS NULL AND u.tenant_id IS NOT NULL;
  UPDATE sandboxes s      SET tenant_id = u.tenant_id FROM users u WHERE u.id = s.owner_id    AND s.tenant_id IS NULL AND u.tenant_id IS NOT NULL;
  UPDATE usage_counters c SET tenant_id = u.tenant_id FROM users u WHERE u.id = c.user_id     AND c.tenant_id IS NULL AND u.tenant_id IS NOT NULL;
  UPDATE agent_sessions a SET tenant_id = u.tenant_id FROM users u WHERE u.id = a.user_id     AND a.tenant_id IS NULL AND u.tenant_id IS NOT NULL;
  UPDATE flow_runs fr      SET tenant_id = f.tenant_id FROM flows f WHERE f.id = fr.flow_id   AND fr.tenant_id IS NULL AND f.tenant_id IS NOT NULL;
  UPDATE flow_snapshots fs SET tenant_id = f.tenant_id FROM flows f WHERE f.id = fs.flow_id   AND fs.tenant_id IS NULL AND f.tenant_id IS NOT NULL;
  UPDATE chat_sessions cs  SET tenant_id = COALESCE(
    (SELECT f.tenant_id FROM flows f WHERE f.id = cs.flow_id),
    (SELECT u.tenant_id FROM users u WHERE u.id = cs.user_id)) WHERE cs.tenant_id IS NULL;

  FOREACH tbl IN ARRAY ARRAY['flows','sandboxes','usage_counters','agent_sessions','chat_sessions','flow_runs','flow_snapshots'] LOOP
    IF has_demo THEN
      EXECUTE format('UPDATE %I SET tenant_id = $1 WHERE tenant_id IS NULL', tbl) USING demo;
    END IF;
    EXECUTE format('DELETE FROM %I WHERE tenant_id IS NULL', tbl);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE NOTICE '[0029] deleted % unresolved NULL-tenant row(s) from %', n, tbl; END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', tbl);
  END LOOP;
END $$;

-- ============================================================================
-- 2. Re-backfill + demo-coalesce, then SET NOT NULL — marketplace value-scoped (no FK) tables.
-- ============================================================================
DO $$
DECLARE
  demo uuid := '00000000-0000-0000-0000-000000000001';
  has_demo boolean := EXISTS (SELECT 1 FROM tenants WHERE id = demo);
  tbl text;
  n bigint;
BEGIN
  UPDATE solutions s SET tenant_id = c.tenant_id FROM challenges c WHERE c.id = s.challenge_id AND s.tenant_id IS NULL;
  UPDATE votes v SET tenant_id = c.tenant_id FROM challenges c
    WHERE v.target_type = 'challenge' AND c.id = v.target_id AND v.tenant_id IS NULL;
  UPDATE votes v SET tenant_id = s.tenant_id FROM solutions s
    WHERE v.target_type = 'solution' AND s.id = v.target_id AND v.tenant_id IS NULL;
  UPDATE comments cm SET tenant_id = c.tenant_id FROM challenges c WHERE c.id = cm.challenge_id AND cm.tenant_id IS NULL;
  UPDATE weekly_winners w SET tenant_id = s.tenant_id FROM solutions s WHERE s.id = w.solution_id AND w.tenant_id IS NULL;

  FOREACH tbl IN ARRAY ARRAY['solutions','votes','comments','weekly_winners'] LOOP
    IF has_demo THEN
      EXECUTE format('UPDATE %I SET tenant_id = $1 WHERE tenant_id IS NULL', tbl) USING demo;
    END IF;
    EXECUTE format('DELETE FROM %I WHERE tenant_id IS NULL', tbl);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE NOTICE '[0029] deleted % unresolved NULL-tenant row(s) from %', n, tbl; END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', tbl);
  END LOOP;
END $$;
