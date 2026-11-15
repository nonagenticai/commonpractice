-- 0096_tenant_licence_op_lease.sql — a per-tenant lease serialising tenant-licence mutations.
--
-- Every operation that mints, swaps or revokes a tenant's own licence (plan/date change, the
-- onboarding-integrity re-home, ensure/reissue, suspend/offboard revoke) makes several licences HTTP
-- calls between reading the tenant row and compare-and-setting it. Two of them interleaving left a
-- workspace 402 with nothing to repair it (re-audit probe 2b: a re-home CAS landing between a plan
-- change's mint and its CAS). They now take this lease first:
--
--   UPDATE tenants SET licence_op_id = $op, licence_op_until = now() + $ttl
--    WHERE id = $t AND (licence_op_until IS NULL OR licence_op_until < now())
--
-- A single statement — NO connection or advisory lock is held across the HTTP calls (a transaction
-- pooler reassigns server connections; nested reserves have wedged pods before). The TTL bounds a
-- crashed holder; `finally` releases on every normal exit.
--
-- FORWARD-ONLY, idempotent (runs at startup on every replica).

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS licence_op_id uuid;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS licence_op_until timestamptz;
