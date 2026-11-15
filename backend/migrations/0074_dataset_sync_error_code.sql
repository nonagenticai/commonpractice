-- 0074_dataset_sync_error_code.sql — the MACHINE FIELDS behind a connector's sync failure.
--
-- THE DEFECT. `datasets.sync_error` is ENGLISH PROSE, composed on the server and PERSISTED:
-- `datasets/connector-refresh.ts` writes `` `${code}: ${reason}` `` in the refresh `catch`, where
-- `reason` is `err.message` — "Host 'files.example.com' is not on the connector egress allowlist.",
-- "source returned HTTP 503", "connect ECONNREFUSED 10.1.2.3:5432". `routes/connectors.ts`
-- (`connectorOut`) hands that string to the browser verbatim and `/connectors` renders it TWICE:
-- as the drawer's error notice next to a localized label, and as the status badge's `title=`
-- tooltip. Every other string on that screen is `m.connectors_*`. A Dutch admin whose connector
-- failed read one English sentence in the middle of a Dutch page — and, because the text is a
-- COLUMN and not a response, it survived reload, re-render and re-login. It stayed English until
-- the next successful sync cleared it.
--
-- ⛔ WHY CI NEVER SAW IT. Every render fixture under frontend/src/routes/connectors/ sets
-- `syncError: null` (seven files, measured). The one surface where the English is guaranteed to
-- appear is the one no test ever constructed.
--
-- The server does not know, and must not know, who is reading. A sync failure is written once, by
-- a worker — possibly triggered by a webhook with no user in scope at all — and read later, by
-- whoever opens /connectors. There is no locale to negotiate against at write time. Same fix as
-- 0071 (flow snapshots) and 0072 (block test results): the row carries the CODE plus the MACHINE
-- FIELDS, and the browser owns the words (frontend/src/lib/api/error-message.ts `syncErrorText`).
--
-- ⛔ THE ENGLISH `sync_error` COLUMN STAYS, AND IS NOT DEPRECATED. Three readers need it:
--   1. `src/ai/mcp/tools.ts` (`describe_data`) returns the string to an LLM client, where English
--      is the CORRECT output and no browser catalog is involved.
--   2. It is the fallback for a code whose catalog entry needs a field this row does not carry —
--      `bad_config` discriminates on `details.reason`, `storage_format_unknown` on `details.key`,
--      and neither is in `sync_error_detail`. Those render the English sentence, on purpose,
--      because it says strictly MORE than a generic localized one would.
--   3. It is the fallback for every row written BEFORE this migration. See below.
--
-- ⛔ NO BACKFILL, AND THE FALL-THROUGH IS PERMANENT, NOT TRANSITIONAL. Every dataset row that
-- already carries a `sync_error` has `sync_error_code IS NULL` and always will. Unlike a wire-only
-- field, nothing recomputes it: `sync_error` is rewritten ONLY by the next refresh of that
-- connector, and a connector that is failing today because its host was de-allowlisted may not be
-- synced again for weeks — or ever, if the admin's response to the error is to delete it. Anyone
-- who reads `syncErrorText`'s legacy-text branch as scaffolding and deletes it blanks those rows
-- in all eight locales.
--
-- Backfilling is not available either. `sync_error` is `"<code>: <message>"`, so the code could be
-- split off the prefix by a regex — but the SECOND half is the part a reader acts on, and a
-- localized generic sentence derived from the prefix alone would say LESS than the row already
-- says. Re-deriving `host` from the message is worse still: four of the eight `egress_bad_target`
-- sentences do not contain it, and the ones that do quote it inside prose. Guessing to make a
-- screen look uniform is worse than the honest English those rows carry.
--
-- WHY `sync_error_detail` IS jsonb AND NOT TYPED COLUMNS. The bag differs per code — `host` for
-- the egress family, `reason` (the raw English) for everything, and the storage codes would want
-- `bucket`/`key`. Four nullable columns that one code apiece populates is how a wide table becomes
-- the union of every producer's schema; 0066, 0071 and 0072 all made the same call and state the
-- same trade-off. The cost is real and is stated in the reader: the column is unvalidated by the
-- database, so `error-message.ts` treats every field as possibly absent (`detailStr` returns null
-- for a blank or non-string) and falls back to the English `sync_error`.
--
-- WHY `SET LOCAL lock_timeout`, ON A FILE THAT ADDS TWO NULLABLE COLUMNS
-- ---------------------------------------------------------------------
-- `ADD COLUMN … text` / `… jsonb` with no default is metadata-only in PG 11+ (no table rewrite),
-- but it still needs an ACCESS EXCLUSIVE lock on `datasets`, and it must QUEUE for it behind
-- whatever is reading the table. `datasets` is read by EVERY flow run that touches a dataset block
-- (`ctx.dataset(slug)`), so that queue is real. It is also worse than the size of the change
-- suggests: the runner (db/migration-runner.ts) applies every pending file inside ONE outer
-- transaction under `pg_advisory_xact_lock`, so a lock waited on here is held until the LAST
-- pending file commits, and every other pod's boot migration is queued behind the advisory lock
-- the whole time. Unbounded, that is a fleet-wide readiness stall during a rolling deploy caused
-- by one ALTER that does no work. With the 5s ceiling the savepoint rolls back instead, the schema
-- stays at 0073, and the pod retries on its next boot. A retried migration beats a wedged fleet.
--
-- NO GRANT AND NO RLS CHANGE IS NEEDED. `0028_rls.sql` enables RLS on `datasets` with a ROW-scoped
-- tenant policy and issues a TABLE-level `GRANT … ON ALL TABLES` to `cp_app`. A table-level grant
-- covers columns added later, and a row-scoped policy is not column-scoped, so both apply to these
-- two with no edit here.
SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM OF THIS FILE. `SET LOCAL` is scoped to the TRANSACTION, and the runner
-- applies every pending file inside ONE outer transaction with a savepoint per file — `RELEASE
-- SAVEPOINT` does not undo a SET LOCAL. Without the reset this 5s ceiling would silently apply to
-- 0075 and everything after it in the same boot, so a later migration that legitimately needs to
-- wait on a lock would fail for a reason nobody wrote down. `lock_timeout` is the ONLY GUC on
-- `MIGRATION_RESET_GUCS` (db/migration-runner.ts) and `tests/migration-guc-reset.test.ts`
-- statically scans every `.sql` in this directory — any other GUC set here reds CI.

ALTER TABLE datasets
  ADD COLUMN IF NOT EXISTS sync_error_code text,
  ADD COLUMN IF NOT EXISTS sync_error_detail jsonb;

COMMENT ON COLUMN datasets.sync_error_code IS
  'The wire code behind `sync_error`, so the reader''s BROWSER can write the sentence '
  '(`syncErrorText` in frontend/src/lib/api/error-message.ts, which resolves it through the same '
  'VALIDATION_MESSAGES catalog the 400/422 refusal path uses). Values are `EgressBlockedError.code` '
  '(src/host/egress-guard.ts), an `HttpError.code` reachable from the fetch path, or the literal '
  '''sync_failed'' for anything else. NULL means "written before 0074" and renders the English '
  '`sync_error` raw — which is why that column is not deprecated. Deliberately plain text and not '
  'an enum: `HttpError.code` is an open string space, and a code shipped backend-first must be '
  'storable one deploy before the browser knows the word for it.';

COMMENT ON COLUMN datasets.sync_error_detail IS
  'Machine tokens for `sync_error_code`''s sentence: `host` (the connector''s egress host, from '
  'connection_meta) and `reason` (the RAW English message the code was concatenated onto, kept so '
  'a catalog entry that needs it can still show it). Shape belongs to the producer '
  '(src/datasets/connector-refresh.ts) and is deliberately unvalidated by the database, so the '
  'reader treats every field as possibly absent and falls back to `sync_error`.';

-- No index. Nothing filters or orders on either column: /connectors reads by (tenant_id, slug)
-- and pulls these along for the ride. An index here would cost every INSERT and every refresh and
-- serve no query. (`CREATE INDEX CONCURRENTLY` is structurally impossible in this runner anyway —
-- it cannot run inside a transaction block — so any index taken here is a plain, blocking one.)

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
