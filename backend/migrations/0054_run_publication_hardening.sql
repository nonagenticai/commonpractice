-- 0054_run_publication_hardening.sql
-- Durable run control, immutable marketplace publication, and provenance-safe demo data.

-- A pause caused by the idle watchdog is owner-resumable. An administrative pause is not.
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS suspension_reason text;
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false;
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS seed_key text;

UPDATE sandboxes s
SET suspension_reason = COALESCE(
  (
    SELECT CASE
      WHEN a.result LIKE 'Auto-suspended%' THEN 'idle'
      ELSE 'admin'
    END
    FROM audit_log a
    WHERE a.action = 'sandbox.suspend'
      AND a.target_id IN (s.id::text, s.slug)
    ORDER BY a.created_at DESC
    LIMIT 1
  ),
  'admin'
)
WHERE s.status = 'suspended' AND s.suspension_reason IS NULL;

UPDATE sandboxes s
SET is_primary = true
FROM (
  SELECT id, row_number() OVER (
    PARTITION BY tenant_id, owner_id ORDER BY created_at ASC, id ASC
  ) AS rn
  FROM sandboxes
) ranked
WHERE ranked.id = s.id AND ranked.rn = 1 AND s.is_primary = false;

CREATE UNIQUE INDEX IF NOT EXISTS sandboxes_primary_owner_uq
  ON sandboxes (tenant_id, owner_id) WHERE is_primary;
CREATE UNIQUE INDEX IF NOT EXISTS sandboxes_seed_key_uq
  ON sandboxes (seed_key) WHERE seed_key IS NOT NULL;

-- Keep the historical flow.solution_id backlink out of the truth model: backfill the canonical
-- side once, and stop reading the column in code.
--
-- The column itself is deliberately NOT dropped here. Migrations run at pod STARTUP and the HPA
-- keeps 2-4 replicas, so during a rolling update the new pod would drop the column while old pods
-- still serve traffic — and drizzle emits explicit column lists, so every `select().from(flows)`
-- on an old replica would fail 42703 for the whole rollout window. Expand now, contract in a
-- follow-up migration once this release is fully rolled out (see 0056, next release).
UPDATE solutions s
SET flow_id = f.id
FROM flows f
WHERE s.flow_id IS NULL AND f.solution_id = s.id;

-- A marketplace solution executes the exact graph and block manifest accepted at submission.
ALTER TABLE solutions ADD COLUMN IF NOT EXISTS published_graph jsonb;
ALTER TABLE solutions ADD COLUMN IF NOT EXISTS published_manifest jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE solutions ADD COLUMN IF NOT EXISTS published_hash text;
ALTER TABLE solutions ADD COLUMN IF NOT EXISTS published_at timestamptz;
ALTER TABLE solutions ADD COLUMN IF NOT EXISTS published_by uuid REFERENCES users(id);

UPDATE solutions s
SET published_graph = f.graph,
    published_hash = encode(sha256(convert_to(f.graph::text, 'UTF8')), 'hex'),
    published_at = COALESCE(s.created_at, now()),
    published_by = s.author_id
FROM flows f
WHERE s.flow_id = f.id AND s.published_graph IS NULL;

WITH manifests AS (
  SELECT s.id, (
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
  WHERE s.published_graph IS NOT NULL AND s.published_manifest = '[]'::jsonb
)
UPDATE solutions s
SET published_manifest = manifests.items
FROM manifests
WHERE s.id = manifests.id;

-- Crash-safe/idempotent run state. Existing duplicate active claims are failed before the unique
-- invariant is installed so the migration is safe on a previously wedged deployment.
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS trace_truncated boolean NOT NULL DEFAULT false;
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS event_count integer NOT NULL DEFAULT 0;
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS seed_key text;

UPDATE flow_runs
SET heartbeat_at = COALESCE(heartbeat_at, started_at),
    lease_expires_at = COALESCE(lease_expires_at, now())
WHERE status = 'running';

WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY sandbox_id ORDER BY started_at DESC, id DESC
  ) AS rn
  FROM flow_runs
  WHERE status = 'running' AND sandbox_id IS NOT NULL
)
UPDATE flow_runs fr
SET status = 'failed', finished_at = now(), lease_expires_at = NULL
FROM ranked r
WHERE fr.id = r.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS flow_runs_active_sandbox_uq
  ON flow_runs (sandbox_id) WHERE status = 'running' AND sandbox_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS flow_runs_idempotency_uq
  ON flow_runs (tenant_id, triggered_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS flow_runs_seed_key_uq
  ON flow_runs (seed_key) WHERE seed_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS flow_runs_lease_idx
  ON flow_runs (lease_expires_at) WHERE status = 'running';

-- Heal sandboxes stranded in 'running'. Before this release the run start transitioned the sandbox
-- unconditionally, so a pod crash (or a run row that never finalized) left the sandbox 'running'
-- forever; prod currently has 10 such rows against ZERO running flow_runs. The new claim only
-- accepts 'idle'/'error', so without this heal those owners would get 409 sandbox_busy on every
-- run, permanently. Only rows with no genuinely-running run are touched.
UPDATE sandboxes s
SET status = 'idle', updated_at = now()
WHERE s.status = 'running'
  AND NOT EXISTS (
    SELECT 1 FROM flow_runs fr
    WHERE fr.sandbox_id = s.id AND fr.status = 'running'
  );

-- Replica-independent SSE history. The sequence is generated by the runner and is idempotent on
-- reconnect/retry. The terminal event is always persisted even when the display trace is capped.
CREATE TABLE IF NOT EXISTS flow_run_events (
  run_id uuid NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
    DEFAULT app_current_tenant_uuid(),
  seq integer NOT NULL,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS flow_run_events_tenant_run_seq_idx
  ON flow_run_events (tenant_id, run_id, seq);
ALTER TABLE flow_run_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS flow_run_events_tenant ON flow_run_events;
CREATE POLICY flow_run_events_tenant ON flow_run_events
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());

-- Concurrent calls reserve estimated spend before contacting a provider.
ALTER TABLE usage_counters
  ADD COLUMN IF NOT EXISTS reserved_spend_usd numeric(12,6) NOT NULL DEFAULT 0;

DO $$ BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON flow_run_events TO cp_app;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
