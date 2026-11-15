-- 0031_tenant_license_token.sql — Phase 4 / F.1: the license dual-gate (CP-repo slice).
--
-- Spec: SPEC-PHASE4-admin-tenant-isolation.md Part 9 (full design) / 9.2 / 9.3 / 9.5.
-- CP enforces TWO gates on every non-exempt request: Gate 1 = Keycloak portal identity
-- (resolves tenant + role, already shipped) AND Gate 2 = an active `commonpractice` license
-- for the caller's tenant in the central licenses service (licenses.example.com). Gate 2 works
-- by introspecting the tenant's license TOKEN at request time — so CP stores that opaque token
-- per tenant. Tokens are secrets (licenses hashes them; possession grants access), so the token
-- is stored ENCRYPTED at rest (secret-box AES-256-GCM, same as tenant_llm_settings.api_key_
-- encrypted) and is NEVER returned by any read endpoint — write-only.
--
-- ADDITIVE / FORWARD-ONLY / PROD-SAFE: a single nullable column on the existing `tenants`
-- registry. `tenants` is a PLATFORM/GLOBAL table (NOT under the D.1 RLS regime — see 0028
-- COVERAGE note), so there is no policy to touch; the existing cp_app global grant + owner
-- ALTER DEFAULT PRIVILEGES already cover this new column (a column-add needs no fresh GRANT).
-- The column is NULL for every existing tenant — F.1 ships the enforcement machinery default-OFF
-- (LICENSE_GATE_2_ENABLED), and F.2 folds per-tenant token issuance into super_admin onboarding
-- (Spec 9.3 / 9.5 Phase C) and flips the flag on (Phase F). Until then the gate is a no-op.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS license_token_encrypted text;

COMMENT ON COLUMN tenants.license_token_encrypted IS
  'Phase 4 / F.1: the tenant''s commonpractice license token (licenses.example.com), secret-box '
  'encrypted at rest, write-only. Gate 2 decrypts + introspects it per request. NULL until F.2 '
  'onboarding issues it.';
