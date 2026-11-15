-- 0042_flow_solution_tenant_align.sql
--
-- A build flow linked to a solution (solutions.flow_id) must share that solution's tenant.
-- A historical showcase seed reused a flow row created under a different tenant, so the
-- winning solution (tenant A) pointed at a flow row stamped tenant B. The solution-detail
-- route resolves the flow under the SOLUTION OWNER's RLS, so the cross-tenant flow was
-- invisible → "This solution isn't linked to a runnable flow yet" and "Try it" was dead on
-- the top solution. Heal the invariant: realign each linked flow's tenant to its solution's.
-- Idempotent (only rows that actually differ are touched).

UPDATE flows f
SET tenant_id = s.tenant_id
FROM solutions s
WHERE s.flow_id = f.id
  AND f.tenant_id IS DISTINCT FROM s.tenant_id;
