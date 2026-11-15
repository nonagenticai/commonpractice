-- 0039_uuidv7_defaults.sql — adopt the team UUIDv7 generation standard for primary keys.
--
-- The team standard is UUIDv7 (time-ordered) for generated IDs. CP generated UUIDv4 everywhere
-- (Drizzle .defaultRandom() → gen_random_uuid()). This switches every `id uuid` PK default to the
-- native Postgres 18 uuidv7() function so NEWLY inserted rows get time-ordered, index-local IDs.
--
-- Forward-only, additive, non-destructive: existing rows keep their v4 IDs (immutable, still valid —
-- IDs are never regenerated). Validation deliberately stays version-agnostic (z.string().uuid()) so
-- legacy v4 rows and cross-service v4 tenant UUIDs continue to resolve (see solutions.ts comment +
-- license-authz _is_uuid). Mirrors schema.ts `.default(sql`uuidv7()`)`. Requires Postgres >= 18.

ALTER TABLE agent_sessions ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE audit_exports ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE audit_log ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE block_tests ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE block_versions ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE building_blocks ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE challenges ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE chat_messages ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE chat_sessions ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE comments ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE dataset_mappings ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE datasets ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE delivery_targets ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE flow_runs ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE flow_snapshots ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE flows ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE identity_providers ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE marketplace_cycles ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE mcp_api_keys ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE mcp_prompt_versions ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE mcp_prompts ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE mcp_tool_versions ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE mcp_tools ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE ontology_attributes ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE ontology_entities ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE ontology_entity_samples ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE ontology_relations ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE pipeline_items ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE policy_changes ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE sandboxes ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE signup_approvals ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE solution_deliveries ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE solutions ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE tenants ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE translation_jobs ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE usage_events ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE users ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE votes ALTER COLUMN id SET DEFAULT uuidv7();
ALTER TABLE weekly_winners ALTER COLUMN id SET DEFAULT uuidv7();
