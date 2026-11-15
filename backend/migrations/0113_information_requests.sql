-- 0113_information_requests.sql — W8/P5: member requests about a challenge's information, held in an
-- approval queue.
--
-- Two kinds, one table:
--   • `missing_information` — a member describes a type of information that is missing (name, short
--     description, optional example field names);
--   • `example_records`     — a member uploads a few example records (CSV/XLSX) for a challenge. The
--     rows live in `information_request_rows`.
--
-- ⛔ A REQUEST NEVER WRITES THE ONTOLOGY OR A DATASET. Approving one only records the decision; the
-- approver then creates the entity / dataset through the EXISTING admin screens and their existing
-- role gates (requireOntologyManager / requireDataManager). Nothing reads these tables on a run path
-- or an AI path: runs inject from `datasets` only, and every AI-facing read is over `datasets` /
-- the ontology.
--
-- MASKED AT REST: an uploaded column the parser flags as personal data (the dataset name heuristic)
-- is stored redacted (`[redacted]`), so a real value never lands here even before review. Every
-- other value is shown only to approvers (tenant_admin / developer / super_admin — `isDeveloper`);
-- the member who uploaded sees column names and masked values. Enforced in the routes.
--
-- RLS: strict tenant shape on both tables (own column, no global branch), the same predicate in
-- USING and WITH CHECK, split per command so no policy is an implicit FOR ALL.
--
-- FORWARD-ONLY, idempotent (runs at startup on every replica). Numbered 0113: 0108-0110 and 0112 are
-- taken by open branches.

CREATE TABLE IF NOT EXISTS information_requests (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id    uuid NOT NULL DEFAULT app_current_tenant_uuid()
                 REFERENCES tenants(id) ON DELETE CASCADE,
  challenge_id uuid NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  name         text NOT NULL,
  description  text,
  field_names  jsonb NOT NULL DEFAULT '[]'::jsonb,
  file_name    text,
  columns      jsonb,
  row_count    integer,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  timestamptz,
  review_note  text,
  CONSTRAINT information_requests_kind_ck CHECK (kind IN ('missing_information', 'example_records')),
  CONSTRAINT information_requests_status_ck CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT information_requests_name_ck CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT information_requests_description_ck CHECK (description IS NULL OR char_length(description) <= 2000),
  CONSTRAINT information_requests_note_ck CHECK (review_note IS NULL OR char_length(review_note) <= 2000),
  -- A decision is recorded exactly when the request is no longer pending.
  CONSTRAINT information_requests_review_ck CHECK ((status = 'pending') = (reviewed_at IS NULL))
);

CREATE INDEX IF NOT EXISTS information_requests_tenant_status_idx ON information_requests (tenant_id, status);
CREATE INDEX IF NOT EXISTS information_requests_challenge_idx ON information_requests (challenge_id);

CREATE TABLE IF NOT EXISTS information_request_rows (
  request_id uuid NOT NULL REFERENCES information_requests(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL DEFAULT app_current_tenant_uuid()
               REFERENCES tenants(id) ON DELETE CASCADE,
  idx        integer NOT NULL,
  data       jsonb NOT NULL,
  CONSTRAINT information_request_rows_pk PRIMARY KEY (request_id, idx)
);

CREATE INDEX IF NOT EXISTS information_request_rows_tenant_idx ON information_request_rows (tenant_id);

ALTER TABLE information_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS information_requests_read ON information_requests;
DROP POLICY IF EXISTS information_requests_ins ON information_requests;
DROP POLICY IF EXISTS information_requests_upd ON information_requests;
DROP POLICY IF EXISTS information_requests_del ON information_requests;
CREATE POLICY information_requests_read ON information_requests FOR SELECT
  USING (tenant_id = app_current_tenant_uuid());
CREATE POLICY information_requests_ins ON information_requests FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_uuid());
CREATE POLICY information_requests_upd ON information_requests FOR UPDATE
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());
CREATE POLICY information_requests_del ON information_requests FOR DELETE
  USING (tenant_id = app_current_tenant_uuid());

ALTER TABLE information_request_rows ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS information_request_rows_read ON information_request_rows;
DROP POLICY IF EXISTS information_request_rows_ins ON information_request_rows;
DROP POLICY IF EXISTS information_request_rows_upd ON information_request_rows;
DROP POLICY IF EXISTS information_request_rows_del ON information_request_rows;
CREATE POLICY information_request_rows_read ON information_request_rows FOR SELECT
  USING (tenant_id = app_current_tenant_uuid());
CREATE POLICY information_request_rows_ins ON information_request_rows FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_uuid());
CREATE POLICY information_request_rows_upd ON information_request_rows FOR UPDATE
  USING (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());
CREATE POLICY information_request_rows_del ON information_request_rows FOR DELETE
  USING (tenant_id = app_current_tenant_uuid());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON information_requests TO cp_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON information_request_rows TO cp_app;
    RAISE NOTICE '[0113] granted cp_app DML on information_requests + information_request_rows';
  ELSE
    RAISE NOTICE '[0113] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;
