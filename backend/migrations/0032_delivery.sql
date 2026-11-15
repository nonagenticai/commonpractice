-- 0032_delivery.sql — Phase 5 / 5A: solution-to-delivery scaffolding.
--
-- Spec: SPEC-PHASE5-solution-to-delivery.md Parts 3 / 4.1 / 6 / 8. CP produces solutions; a
-- tenant_admin will "Forward to delivery" a winning solution into the customer's own backlog
-- (Atlassian Jira / Azure DevOps — the productized primary) or, for internal testing, an fr
-- draft project request. 5A is the DATA + CONFIG scaffolding only — no dispatch yet (the Jira/
-- ADO adapters + the POST /forward action land in 5B/5C; the fr bridge in 5D).
--
-- Two tenant-scoped tables, both under the D.1 RLS regime (mirrors 0030_identity_providers):
--   * delivery_targets    — a tenant's configured external backlog connector. Credentials
--                           (Jira {email,apiToken} / ADO {pat} / fr {licenseToken}) live in
--                           `credentials_encrypted` (secret-box AES-256-GCM, like
--                           tenant_llm_settings.api_key_encrypted); write-only, never returned.
--   * solution_deliveries — one row per "Forward to delivery" attempt (both targets). 5A ships
--                           the table (zero rows); 5B's dispatch writes it. The full status enum
--                           + idempotency index ship now so 5B/5D need no enum/index migration.
--
-- FORWARD-ONLY / PROD-SAFE: created by the table OWNER on boot; tenant_id defaults to the request
-- GUC (0028 convention) + FK hard-scopes to a real tenant. RLS is ENABLE (owner bypasses for
-- migrations / runAsSystem); cp_app (non-owner, NOBYPASSRLS) is fully bound.

-- Target kinds + the delivery lifecycle (full set per spec §4.1; 5A only ever inserts 'pending').
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'delivery_target_kind') THEN
    CREATE TYPE delivery_target_kind AS ENUM ('jira', 'azure_devops', 'fr');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'delivery_status') THEN
    CREATE TYPE delivery_status AS ENUM (
      'pending', 'sent', 'created', 'draft_created', 'approved', 'promoted', 'rejected', 'failed'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS delivery_targets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RLS scope. Defaults to the per-request GUC (0028 convention); FK hard-scopes to a real tenant.
  tenant_id             uuid NOT NULL DEFAULT app_current_tenant_uuid()
                          REFERENCES tenants(id) ON DELETE CASCADE,
  kind                  delivery_target_kind NOT NULL,
  name                  text NOT NULL,                  -- tenant-chosen label, unique per tenant
  base_url              text,                           -- Jira site / ADO org URL / fr ingress (allowlisted in 5B)
  project_key           text,                           -- Jira projectKey / ADO project
  default_item_type     text,                           -- 'Epic' (default) | 'Story' | 'Feature'
  config                jsonb NOT NULL DEFAULT '{}'::jsonb,  -- non-secret extras (ADO area path, Jira issuetype id)
  credentials_encrypted text,                           -- secret-box blob; write-only, never returned
  enabled               boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS delivery_targets_tenant_id_idx ON delivery_targets (tenant_id);

CREATE TABLE IF NOT EXISTS solution_deliveries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL DEFAULT app_current_tenant_uuid()
                 REFERENCES tenants(id) ON DELETE CASCADE,
  solution_id  uuid NOT NULL REFERENCES solutions(id) ON DELETE CASCADE,
  -- null allowed (an ad-hoc fr default); ON DELETE SET NULL keeps delivery history if the
  -- connector config is later removed.
  target_id    uuid REFERENCES delivery_targets(id) ON DELETE SET NULL,
  target_kind  delivery_target_kind NOT NULL,
  initiated_by uuid NOT NULL REFERENCES users(id),
  status       delivery_status NOT NULL DEFAULT 'pending',
  external_ref text,                                    -- Jira key / ADO id / fr_draft_id
  external_url text,                                    -- deep link to the created item/draft
  fr_project_id text,                                   -- set when fr promotes (Target B, via 5.1 feedback)
  payload      jsonb NOT NULL,                          -- the canonical delivery payload (spec Part 3)
  response     jsonb,                                   -- the target's raw response (success or error body)
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS solution_deliveries_solution_id_idx ON solution_deliveries (solution_id);
CREATE INDEX IF NOT EXISTS solution_deliveries_tenant_id_idx ON solution_deliveries (tenant_id);
-- Idempotency (spec §4.1 / Part 9#3): one LIVE delivery per (solution, target). Re-forwarding the
-- same solution to the same target while a delivery is still live → unique violation → 409 in 5B.
-- 'failed'/'rejected' rows are excluded, so they are re-sendable.
CREATE UNIQUE INDEX IF NOT EXISTS solution_deliveries_live_uq
  ON solution_deliveries (solution_id, target_id)
  WHERE status IN ('pending', 'sent', 'created', 'draft_created', 'approved', 'promoted');

-- RLS: tenant-scoped, fail-closed (unset GUC → NULL → zero rows). ENABLE (not FORCE) so the owner
-- bypasses for migrations / runAsSystem; cp_app is bound. Mirrors 0028 §4a / 0030.
DO $$
DECLARE tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['delivery_targets', 'solution_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_tenant', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = app_current_tenant_uuid()) WITH CHECK (tenant_id = app_current_tenant_uuid())',
      tbl || '_tenant', tbl);
  END LOOP;
END $$;

-- GRANT to cp_app (role-existence-guarded, like 0028 §5 / 0030). Owner default-privileges also
-- auto-grant future owner-created tables, but grant explicitly so the tables are self-contained.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON delivery_targets TO cp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON solution_deliveries TO cp_app;
    RAISE NOTICE '[0032] granted cp_app DML on delivery_targets + solution_deliveries';
  ELSE
    RAISE NOTICE '[0032] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;
