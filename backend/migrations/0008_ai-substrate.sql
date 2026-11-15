-- 0008_ai-substrate.sql — the Retrofit task (SPEC §7): the AI-substrate tables
-- (SPEC §4) that the S0–S6 build predates. Matches src/db/schema.ts. This session
-- is STUB-FIRST: the tables are real + wired into a real agent loop / MCP server /
-- two-token auth, but the provider is a deterministic stub (no real model). Real
-- Anthropic/OpenAI adapters are Session 7; i18n (§5B) is a separate later session
-- (content_translations is created here but left UNWIRED — D4 of the plan).
--
--   tenant_llm_settings — per-tenant provider choice + BYO key (selected at runtime
--                         in S7). Seeded with a single 'stub' row this session.
--   agent_sessions      — the two-token model: Keycloak JWT → issue → refresh-token
--                         row (sha256 hash, replaced_by replay chain) → short-lived
--                         HS256 agent token on /api/agent/chat. Mirrors fr.
--   mcp_prompts(+vers)  — DB-backed MCP prompts (per-locale-capable; en seeded). The
--                         agent's system prompt lives here → governable + localizable.
--   mcp_tools(+vers)    — DB-defined customer/enterprise tools the dynamic tools/list
--                         returns (platform tools stay in code). Empty this session.
--   chat_sessions       — one conversation thread bound to a flow.
--   chat_messages       — full transcript (Anthropic message shape) for replay + audit.
--   flow_snapshots      — every AI (and manual) graph mutation snapshots the graph →
--                         undo/redo + an auditable diff trail. Keep last N per flow.
--   content_translations— i18n string side-table. CREATED, UNWIRED this session (§5B).

DO $$ BEGIN
  CREATE TYPE llm_provider AS ENUM ('anthropic', 'openai', 'openai_compatible');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE chat_role AS ENUM ('user', 'assistant', 'tool');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE snapshot_source AS ENUM ('manual', 'ai');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---- tenant_llm_settings (per-customer provider + BYO key) ----
-- One row per tenant selects the adapter at runtime (S7). `api_key_encrypted` holds
-- the BYO key (encrypted; never reaches the frontend or the block runner). Env
-- defaults cover dev/self-host. The 'stub' tenant row this session has no key.
CREATE TABLE IF NOT EXISTS tenant_llm_settings (
  tenant_id          TEXT PRIMARY KEY,
  provider           llm_provider NOT NULL DEFAULT 'anthropic',
  model              TEXT NOT NULL DEFAULT '',
  base_url           TEXT,
  params             JSONB NOT NULL DEFAULT '{}'::jsonb,
  api_key_encrypted  TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- agent_sessions (the two-token model — mirror fr) ----
-- Only the sha256 HASH of the refresh token is stored (raw returned once). On
-- rotation the consumed row's `replaced_by` points at its successor; a replay of a
-- consumed token revokes the whole forward chain. `revoked_at` is set on logout /
-- replay. The short-lived access token itself is a stateless HS256 JWT (not stored).
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash  TEXT NOT NULL UNIQUE,
  replaced_by         UUID REFERENCES agent_sessions(id) ON DELETE SET NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_sessions_user_id_idx ON agent_sessions(user_id);

-- ---- mcp_prompts (+ versions) — DB-backed MCP prompts primitive ----
-- Per-locale (en seeded this session), tenant-scoped (NULL = platform-global),
-- versioned. The agent's system prompt is a row here. `arguments` is the MCP prompt
-- argument schema. Uniqueness is per (name, locale, tenant) — coalesce NULL tenant
-- to '' so the platform-global prompt is unique per name+locale.
CREATE TABLE IF NOT EXISTS mcp_prompts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  locale           TEXT NOT NULL DEFAULT 'en',
  tenant_id        TEXT,
  template         TEXT NOT NULL,
  arguments        JSONB NOT NULL DEFAULT '[]'::jsonb,
  current_version  INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_prompts_name_locale_tenant_uq
  ON mcp_prompts(name, locale, COALESCE(tenant_id, ''));

CREATE TABLE IF NOT EXISTS mcp_prompt_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id       UUID NOT NULL REFERENCES mcp_prompts(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  template        TEXT NOT NULL,
  arguments       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_prompt_versions_prompt_id_idx ON mcp_prompt_versions(prompt_id);

-- ---- mcp_tools (+ versions) — DB-defined customer/enterprise tools ----
-- The dynamic tools/list handler returns these (per tenant) ALONGSIDE the in-code
-- platform tools; tools/call dispatches by name. `impl` is a handler ref/definition.
-- Empty this session; the registry path is wired + tested with no rows.
CREATE TABLE IF NOT EXISTS mcp_tools (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  tenant_id        TEXT,
  description      TEXT NOT NULL DEFAULT '',
  input_schema     JSONB NOT NULL DEFAULT '{}'::jsonb,
  impl             JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_version  INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mcp_tools_name_tenant_uq
  ON mcp_tools(name, COALESCE(tenant_id, ''));

CREATE TABLE IF NOT EXISTS mcp_tool_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_id         UUID NOT NULL REFERENCES mcp_tools(id) ON DELETE CASCADE,
  version_number  INTEGER NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  input_schema    JSONB NOT NULL DEFAULT '{}'::jsonb,
  impl            JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_tool_versions_tool_id_idx ON mcp_tool_versions(tool_id);

-- ---- chat_sessions — one conversation thread bound to a flow ----
CREATE TABLE IF NOT EXISTS chat_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id     UUID REFERENCES flows(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_sessions_flow_id_idx ON chat_sessions(flow_id);
CREATE INDEX IF NOT EXISTS chat_sessions_user_id_idx ON chat_sessions(user_id);

-- ---- chat_messages — full transcript (Anthropic message shape) ----
-- `content` is the message content blocks: text + tool_use / tool_result. Role
-- 'tool' carries a tool_result. Replayed into the loop + auditable.
CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role        chat_role NOT NULL,
  content     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_session_id_created_at_idx
  ON chat_messages(session_id, created_at);

-- ---- flow_snapshots — undo/redo + auditable diff trail ----
-- Every AI (source='ai') and manual (source='manual') graph mutation snapshots the
-- full graph + a human summary ("inserted ai-summarize after extract-fields"). Keep
-- last N per flow (prune helper in flow-edit-service.ts).
CREATE TABLE IF NOT EXISTS flow_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id     UUID NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  graph       JSONB NOT NULL,
  source      snapshot_source NOT NULL DEFAULT 'manual',
  summary     TEXT NOT NULL DEFAULT '',
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS flow_snapshots_flow_id_created_at_idx
  ON flow_snapshots(flow_id, created_at DESC);

-- ---- content_translations — i18n side-table (CREATED, UNWIRED this session) ----
-- Localized strings for book/docs + (best-effort) user-generated content. No i18n
-- wiring lands until the §5B session; this table is created now because it's listed
-- in SPEC §4 and is cheap.
CREATE TABLE IF NOT EXISTS content_translations (
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  locale       TEXT NOT NULL,
  field        TEXT NOT NULL,
  value        TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, locale, field)
);
