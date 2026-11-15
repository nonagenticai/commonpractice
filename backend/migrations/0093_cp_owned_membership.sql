-- 0093_cp_owned_membership.sql — CP owns tenancy and roles (the "cell" model).
--
-- Until now a user's tenant came from the Keycloak `tenant_id` claim and their role from portal
-- realm roles (tenant_admin / developer / member). Both live in the `portal` realm that CP SHARES
-- with fr, so a CP role change rewrote the user's role in fr, and any portal user whose fr
-- `tenant_id` happened to name a CP tenant was silently seated in it.
--
-- From this release: Keycloak AUTHENTICATES (sub, verified email, super_admin) and CP AUTHORIZES.
--   users.tenant_id    — the single home tenant (already existed; now authoritative).
--   users.tenant_role  — member | developer | tenant_admin (new; authoritative).
-- NULL tenant_role = "not yet backfilled from realm roles" and is read as `member` by the request
-- path; scripts/backfill-cp-membership.ts fills it once after the deploy.
--
-- tenants.central_link records HOW the CP tenant relates to the licences registry tenant with the
-- SAME id: 'registered' (CP created it there) or 'adopted' (it already existed — e.g. a customer
-- provisioned centrally before CP had a row — and a super_admin explicitly adopted it). NULL = a
-- pre-0093 tenant whose registration the onboarding-integrity sweep still owns.
--
-- FORWARD-ONLY, idempotent (runs at startup on every replica).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tenant_role') THEN
    CREATE TYPE tenant_role AS ENUM ('member', 'developer', 'tenant_admin');
  END IF;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_role tenant_role;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS central_link text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS central_linked_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_central_link_ck') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_central_link_ck
      CHECK (central_link IS NULL OR central_link IN ('registered', 'adopted'));
  END IF;
END $$;

-- SSO first login resolves alias -> tenant, so the alias must name exactly one tenant. Keycloak
-- already enforces realm-global alias uniqueness; this makes CP's mirror agree.
CREATE UNIQUE INDEX IF NOT EXISTS identity_providers_alias_uq ON identity_providers (alias);
