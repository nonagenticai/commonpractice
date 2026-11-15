-- 0104 — which licences BUNDLES CP ensured on a tenant, per bundle, and how that went.
--
-- A super_admin may name licences bundles at create (`POST /api/tenants` `licenceBundles`) or later
-- (`POST /api/tenants/:id/licence-bundles`). CP owns the tenant in licences, so CP calls
-- `POST /internal/tenants/{id}/bundles/{bundle}/ensure` for each one. Licences decides which keys
-- exist; CP keeps no list of them. What CP must keep is WHICH bundles were asked for and what
-- licences answered, so the workspace page can show them and a retry knows what to re-ensure.
--
-- `licence_bundles` maps bundle key → { status ok|failed|skipped, code, message, apps (app → decision),
-- refused [{app, reason}], attempts, lastAttemptAt, ensuredAt }. services/tenant-licence-bundles.ts
-- owns the shape. The `licence_bundles` step in `provisioning` (0101) carries the summary + claim.
--
-- A column on `tenants` (outside RLS, super_admin surfaces only), like 0101's `provisioning`.
-- `'{}'` = no bundle was ever requested.
--
-- FORWARD-ONLY, idempotent (runs at startup on every replica).

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS licence_bundles jsonb NOT NULL DEFAULT '{}'::jsonb;
