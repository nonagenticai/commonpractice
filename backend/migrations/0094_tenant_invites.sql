-- 0094_tenant_invites.sql — CP-native invitations (replaces "create the Keycloak user, write its
-- tenant_id attribute and realm role").
--
-- An invite binds an EMAIL to (tenant, role). It is accepted explicitly by a signed-in user whose
-- VERIFIED email matches, either from the emailed link (token) or from the "no workspace" screen
-- (invite id). Only the hex SHA-256 of the token is stored. Pending invites count against
-- tenants.max_members together with live members.
--
-- RLS: tenant-scoped like identity_providers (0030). The accept path looks invites up ACROSS
-- tenants by email/token and therefore runs as the owner (runAsSystem).
--
-- FORWARD-ONLY, idempotent.

CREATE TABLE IF NOT EXISTS tenant_invites (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL DEFAULT app_current_tenant_uuid()
                 REFERENCES tenants(id) ON DELETE CASCADE,
  email        text NOT NULL,
  role         tenant_role NOT NULL DEFAULT 'member',
  token_hash   text NOT NULL UNIQUE,      -- hex SHA-256 of the emailed token; the token itself is never stored
  keycloak_sub text,
  invited_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   timestamptz,
  resent_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_invites_one_pending_per_email
  ON tenant_invites (tenant_id, lower(email)) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS tenant_invites_email_pending
  ON tenant_invites (lower(email)) WHERE status = 'pending';

ALTER TABLE tenant_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_invites_tenant ON tenant_invites;
CREATE POLICY tenant_invites_tenant ON tenant_invites
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_invites TO cp_app;
    RAISE NOTICE '[0094] granted cp_app DML on tenant_invites';
  ELSE
    RAISE NOTICE '[0094] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;
