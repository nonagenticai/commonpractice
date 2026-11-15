-- 0020_tenant_industry.sql — Phase 3.4: AI ontology reasoning.
-- Adds the INDUSTRY half of the (industry × department) cell the agent selects. It is
-- tenant-scoped (always resolvable from ctx.tenantId) where the department half derives
-- from a challenge's work_area at request time (no column needed). Nullable: a tenant
-- with no industry means the agent must pass `industry` explicitly (the always-works
-- path). Set via seed/DB this phase; a tenant-settings editor is 3.5.
-- Matches src/db/schema.ts (tenants.industry).

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS industry TEXT;
