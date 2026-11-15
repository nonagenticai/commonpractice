-- 0027_signup_onboarding.sql — Phase 4 / C.2a: controlled onboarding (super_admin half).
--
-- Three platform-scoped tables that drive the controlled-onboarding flow (spec §1.5/§6.3):
--   signup_approvals     — the super_admin approval queue. A prospective user is recorded
--                          (self-signup notify, or a direct super_admin invite), then
--                          approved (→ Keycloak realm user + tenant + role + magic-link) or
--                          rejected. Identity is born in Keycloak first; the local users row
--                          materialises on approve/invite (id = the Keycloak sub).
--   email_domain_tenants — corporate email domain → tenant auto-routing (matched_tenant).
--   free_email_providers — gmail/outlook/… blocklist: a free-mail signup is never
--                          auto-routed (held for explicit super_admin assignment).
--
-- These are pre-tenant / cross-tenant by nature (they FK *to* tenants, are not scoped *by*
-- a tenant) so they sit OUTSIDE the per-tenant RLS that lands in Phase D. Forward-only;
-- CREATE … IF NOT EXISTS keeps it safe to re-run on an already-migrated DB.

CREATE TABLE IF NOT EXISTS signup_approvals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Set once the user exists in Keycloak (NULL for a self-signup that only notified).
  keycloak_sub       text,
  email              text NOT NULL,
  name               text,
  -- pending | approved | rejected
  status             text NOT NULL DEFAULT 'pending',
  -- auto-routed from the email domain (email_domain_tenants); NULL for free-mail/unknown.
  matched_tenant_id  uuid REFERENCES tenants(id) ON DELETE SET NULL,
  -- the super_admin's explicit choice at approve time (overrides matched).
  assigned_tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  -- realm role to grant on approve (member | tenant_admin). super_admin is never granted here.
  requested_role     text NOT NULL DEFAULT 'member',
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  decided_at         timestamptz,
  decided_by         uuid REFERENCES users(id) ON DELETE SET NULL
);

-- One PENDING row per email (case-insensitive) so notify-self / invite de-dupe; a decided
-- row doesn't block a future re-signup.
CREATE UNIQUE INDEX IF NOT EXISTS signup_approvals_pending_email
  ON signup_approvals (lower(email)) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS signup_approvals_status_idx ON signup_approvals (status);

CREATE TABLE IF NOT EXISTS email_domain_tenants (
  domain      text PRIMARY KEY,          -- lower-cased bare domain (no '@')
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  auto_assign boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_domain_tenants_tenant_id_idx ON email_domain_tenants (tenant_id);

CREATE TABLE IF NOT EXISTS free_email_providers (
  domain text PRIMARY KEY                -- lower-cased bare domain: gmail.com, outlook.com, …
);
