-- 0014_tenants.sql — Phase 2-D: real tenants + membership, MCP API keys, usage events.
-- Matches src/db/schema.ts (tenants + tenant_members + mcp_api_keys + usage_events,
-- users.active_tenant_id, tenant_status / tenant_member_role enums).
--
-- Until now each user was their own "tenant" by convention (tenant_id = user.id, a TEXT
-- column on tenant_llm_settings/datasets). This makes tenants first-class WITHOUT
-- rewriting that data: the backfill below creates, for every existing user, a PERSONAL
-- tenant whose id = user.id, so every existing tenant_id value still resolves to a real
-- tenant row. usage_events is an append-only per-call ledger for the spend dashboards;
-- usage_counters stays the per-user/day CAP ledger (unchanged).

DO $$ BEGIN
  CREATE TYPE tenant_status AS ENUM ('active', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE tenant_member_role AS ENUM ('tenant_admin', 'member');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS tenants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  status      tenant_status NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_members (
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        tenant_member_role NOT NULL DEFAULT 'member',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS tenant_members_user_id_idx ON tenant_members(user_id);

-- The tenant a user's session currently acts under (defaults to their personal tenant).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS active_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL;

-- Issuable/revocable API keys for EXTERNAL MCP clients. Only the sha256 hash is stored;
-- key_prefix is the human-readable head shown in the UI (the raw is returned once).
CREATE TABLE IF NOT EXISTS mcp_api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  issued_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  key_prefix    TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  scopes        JSONB NOT NULL DEFAULT '["tools","resources","prompts"]'::jsonb,
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_api_keys_tenant_id_idx ON mcp_api_keys(tenant_id);

-- Append-only per-call usage ledger (one row per brokered LLM call). Powers the
-- per-model / per-day spend dashboards. Retention is a documented sweep, never silent.
CREATE TABLE IF NOT EXISTS usage_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID REFERENCES tenants(id) ON DELETE SET NULL,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost_usd    NUMERIC(12, 6) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_events_tenant_created_idx ON usage_events(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS usage_events_user_created_idx ON usage_events(user_id, created_at);

-- Backfill (idempotent): a personal tenant per existing user, id = user.id, so every
-- existing tenant_id (TEXT = user.id) keeps resolving. slug is uuid-derived → unique.
INSERT INTO tenants (id, name, slug, status)
SELECT u.id,
       COALESCE(NULLIF(u.name, ''), u.email) AS name,
       'u-' || replace(u.id::text, '-', '')  AS slug,
       'active'
FROM users u
ON CONFLICT (id) DO NOTHING;

INSERT INTO tenant_members (tenant_id, user_id, role)
SELECT u.id, u.id, 'tenant_admin'
FROM users u
ON CONFLICT (tenant_id, user_id) DO NOTHING;

UPDATE users SET active_tenant_id = id WHERE active_tenant_id IS NULL;
