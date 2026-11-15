-- Add fixture provenance to the append-only usage ledger. Boot seeding may refresh only rows that
-- carry its own natural key; genuine provider calls for showcase members must remain untouched.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS seed_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS usage_events_seed_key_uq
  ON usage_events (seed_key)
  WHERE seed_key IS NOT NULL;

-- 0054 may already have been applied by a canary before its legacy manifest/hash backfill was
-- tightened. Heal those rows idempotently here as well.
WITH healed AS (
  SELECT s.id,
    encode(sha256(convert_to(s.published_graph::text, 'UTF8')), 'hex') AS hash,
    (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'nodeId', node->>'id',
        'blockId', node->>'blockId',
        'versionId', node->>'blockVersionId',
        'slug', node->>'slug',
        'descriptor', v.descriptor
      )), '[]'::jsonb)
      FROM jsonb_array_elements(COALESCE(s.published_graph->'nodes', '[]'::jsonb)) node
      JOIN block_versions v ON v.id = (node->>'blockVersionId')::uuid
      WHERE COALESCE(node->>'kind', '') <> 'foreach'
    ) AS items
  FROM solutions s
  WHERE s.published_graph IS NOT NULL
    AND (length(COALESCE(s.published_hash, '')) <> 64 OR s.published_manifest = '[]'::jsonb)
)
UPDATE solutions s
SET published_hash = healed.hash, published_manifest = healed.items
FROM healed
WHERE s.id = healed.id;

-- Publication is immutable TO THE APPLICATION. The guard is scoped to the runtime role on purpose:
-- 0054 backfills published_at onto every existing solution, so an unscoped trigger would freeze the
-- whole table against its own migration tooling, the seeders and any support fix — with no bypass.
-- Migrations and runAsSystem connect as the owner, so they pass; cp_app (every request path) cannot.
CREATE OR REPLACE FUNCTION reject_published_solution_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'cp_app' AND OLD.published_at IS NOT NULL AND (
    NEW.published_graph IS DISTINCT FROM OLD.published_graph OR
    NEW.published_manifest IS DISTINCT FROM OLD.published_manifest OR
    NEW.published_hash IS DISTINCT FROM OLD.published_hash OR
    NEW.published_at IS DISTINCT FROM OLD.published_at OR
    NEW.published_by IS DISTINCT FROM OLD.published_by
  ) THEN
    RAISE EXCEPTION 'published solution revision is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS solutions_published_immutable ON solutions;
CREATE TRIGGER solutions_published_immutable
  BEFORE UPDATE OF published_graph, published_manifest, published_hash, published_at, published_by
  ON solutions
  FOR EACH ROW EXECUTE FUNCTION reject_published_solution_mutation();
