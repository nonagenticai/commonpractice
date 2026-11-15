-- 0025_drop_multimembership.sql — Phase 4 / C.1: single-tenant-per-identity.
--
-- Phase B left tenancy membership-based: `resolveTenant` read `users.active_tenant_id`
-- (a switcher, personal-tenant fallback), and a normal tenant_admin was authorized by a
-- `tenant_members` row whose `role` enum was a SECOND role taxonomy parallel to the
-- super_admin/tenant_admin/member realm roles. C.1 collapses this to one model
-- (SPEC-PHASE4 Parts 3 / 6.0):
--   • tenant identity = the `tenant_id` JWT claim (fail-closed; resolved in app code),
--   • role = realm roles only (tenant_members + its enum dropped — no mapping table),
--   • `users.active_tenant_id` becomes `users.tenant_id`: a single, immutable home-tenant
--     FK (NOT a switcher) kept ONLY for the no-JWT code paths that hold a userId and so
--     cannot read the claim (agent-session token, MCP-key serving, owner resolution,
--     background usage attribution). Synced from the claim on touch.
--
-- Forward-only: all data is demo/seed, re-seeded by db/seed-platform.ts under this model.
-- Idempotent (guarded) so a partially-migrated DB converges.

-- 1) Rename the switcher column to the single home-tenant column (guarded rename).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'active_tenant_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'tenant_id'
  ) THEN
    ALTER TABLE users RENAME COLUMN active_tenant_id TO tenant_id;
  END IF;
END $$;

-- 2) Drop the membership junction + its role enum (the second taxonomy).
DROP TABLE IF EXISTS tenant_members CASCADE;
DROP TYPE IF EXISTS tenant_member_role;
