-- 0095_tenant_licence_state.sql — per-tenant licence terms, owned by CP.
--
-- Until now every licence CP minted (tenant AND member) was issued on ONE global plan
-- (`LICENSE_PLAN_CODE`, prod 'standard') with no expiry, the licence id was never stored, and the
-- tenant's licences-registry name was assumed to equal its CP slug. A super_admin could change a
-- tenant's name, status and seats — never its plan, start, expiry or registry name.
--
--   plan_code           the licences plan code this tenant's licences are minted on.
--   licence_id          the licences id behind `license_token_encrypted` (NULL = unknown: minted
--                       before this column existed; resolved by introspecting the token on change).
--   licence_subject_sub the Keycloak sub that licence is bound to (same caveat).
--   licence_starts_at   requested start (NULL = from mint time).
--   licence_expires_at  requested expiry (NULL = perpetual).
--   licences_name       CP's OWN licences-registry tenant name: the slug, or `<slug>-cp`,
--                       `<slug>-cp-2`, … when the slug is held by a tenant CP does not own.
--
-- Backfill: plan_code = 'standard' — the value of LICENSE_PLAN_CODE in every deployment
-- (gitops clusters/strato/services/commonpractice/deployment.yaml); a migration cannot read the env.
-- licences_name = slug for every tenant already linked centrally (registered OR adopted — both were
-- registered/adopted under exactly the slug).
--
-- TODO(A2 prod step 3): once the one `central_link = 'adopted'` row (01a0ef72, Netcare) is deleted,
-- a follow-up migration tightens tenants_central_link_ck to `IN ('registered')`. Not done here:
-- the row still exists in prod at deploy time and the CHECK would fail the startup migration.
--
-- FORWARD-ONLY, idempotent (runs at startup on every replica).

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan_code text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS licence_id uuid;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS licence_subject_sub text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS licence_starts_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS licence_expires_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS licences_name text;

UPDATE tenants SET plan_code = 'standard' WHERE plan_code IS NULL;
UPDATE tenants SET licences_name = slug WHERE licences_name IS NULL AND central_link IS NOT NULL;

-- The registry name is unique there; mirror it so two CP rows can never claim one registry name.
CREATE UNIQUE INDEX IF NOT EXISTS tenants_licences_name_uq ON tenants (licences_name)
  WHERE licences_name IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_licence_window_ck') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_licence_window_ck
      CHECK (licence_starts_at IS NULL OR licence_expires_at IS NULL
             OR licence_expires_at > licence_starts_at);
  END IF;
END $$;
