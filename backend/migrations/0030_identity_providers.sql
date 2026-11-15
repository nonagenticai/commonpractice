-- 0030_identity_providers.sql — Phase 4 / Phase E.1: per-tenant Entra OIDC SSO (the CP mirror).
--
-- Spec: SPEC-PHASE4-admin-tenant-isolation.md Part 8 (full design) / Part 6.2 / Part 6.0#1.
-- Each tenant registers their own Microsoft Entra ID as a Keycloak Identity Provider (alias
-- `entra-<slug>`), brokered through the single `portal` realm. Keycloak is the runtime broker;
-- THIS table is CP's editable mirror + audit anchor. It is TENANT-SCOPED and falls under the
-- D.1 RLS regime (correcting specra's platform-flat `identity_providers`, Part 6.0#1): a
-- tenant_admin sees only their own IdP via `app.current_tenant`; the super_admin cross-tenant
-- overview reads through the platform path (runAsSystem / owner-bypass).
--
-- The Entra `client_secret` is NEVER stored in plaintext and NEVER returned by a read endpoint:
-- it lives in `client_secret_encrypted` (secret-box AES-256-GCM, like tenant_llm_settings).
-- The `config` jsonb holds the non-secret OIDC block (discovery_url, client_id, scopes,
-- trust_email) only. The hardcoded `tenant_id` IdP mapper that BINDS a brokered user to this
-- tenant (Part 8.4 keystone) lives in Keycloak, authored backend-side — never here, never a form.
--
-- FORWARD-ONLY / PROD-SAFE: created by the table OWNER on boot; tenant_id defaults to the
-- request GUC (same convention as 0028's hard-scoped tables). RLS is ENABLE (owner bypasses for
-- migrations / runAsSystem); cp_app (non-owner, NOBYPASSRLS) is fully bound.

CREATE TABLE IF NOT EXISTS identity_providers (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RLS scope. Defaults to the per-request GUC (0028 convention); FK hard-scopes to a real tenant.
  tenant_id               uuid NOT NULL DEFAULT app_current_tenant_uuid()
                            REFERENCES tenants(id) ON DELETE CASCADE,
  alias                   text NOT NULL,           -- the Keycloak IdP alias / routing key: 'entra-<slug>'
  display_name            text NOT NULL,
  provider_type           text NOT NULL DEFAULT 'oidc',
  enabled                 boolean NOT NULL DEFAULT true,
  config                  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- OIDC block: discovery_url, client_id, scopes, trust_email (NO secret)
  client_secret_encrypted text,                    -- secret-box blob; write-only, never returned
  link_only               boolean NOT NULL DEFAULT false,      -- Part 8.5 per-tenant opt-in (default JIT-create)
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- One IdP per (tenant, alias). Keycloak independently enforces realm-global alias uniqueness.
  UNIQUE (tenant_id, alias)
);

-- RLS: tenant-scoped, fail-closed (unset GUC → NULL → zero rows). ENABLE (not FORCE) so the
-- owner bypasses for migrations / runAsSystem; cp_app is bound. Mirrors 0028 §4a.
ALTER TABLE identity_providers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS identity_providers_tenant ON identity_providers;
CREATE POLICY identity_providers_tenant ON identity_providers
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());

-- GRANT to cp_app (role-existence-guarded, like 0028 §5). Owner default-privileges (D.1.2) also
-- auto-grant future owner-created tables, but grant explicitly so the table is self-contained.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON identity_providers TO cp_app;
    RAISE NOTICE '[0030] granted cp_app DML on identity_providers';
  ELSE
    RAISE NOTICE '[0030] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;
