-- 0071_flow_snapshot_summary_code.sql — the MACHINE FIELDS behind a snapshot's summary sentence.
--
-- THE DEFECT. `flow_snapshots.summary` is ENGLISH PROSE composed on the server — nine templates,
-- seven in `src/ai/flow-edit-service.ts` (`added ${slug}`, `connected ${source}.${sourceHandle} →
-- ${target}.${targetHandle}`, …) and two in `src/routes/flows.ts` (`'Manual checkpoint'`,
-- `Restored snapshot from ${iso}`). `snapshotSummary()` hands it to the browser verbatim and
-- `FlowHistoryPanel.svelte` renders it TWICE — as the row body and as the row's `title=` tooltip —
-- inside a panel where every other string is `m.flow_history_*`. /build is the product's PRIMARY
-- authoring surface, so this is English prose sitting in the middle of a Dutch demo.
--
-- The server does not know, and must not know, who is reading. A snapshot is written once, at edit
-- time, and read later — possibly by a different person, in a different language, from a different
-- device. There is no locale to negotiate against at INSERT time and no second chance afterwards.
-- The only fix that works is the one 0066 took for notifications and #244 took for /it-dash: the
-- row carries the CODE plus the MACHINE FIELDS, and the browser owns the words
-- (`frontend/src/lib/i18n/flow-summary-label.ts`).
--
-- `source` alone cannot carry it. `source` is a two-value enum ('manual' | 'ai') and SEVEN distinct
-- sentences share `source = 'ai'`. The discriminator has to be per-template, which is what
-- `summary_code` is.
--
-- WHY A jsonb COLUMN AND NOT TYPED COLUMNS. The nine templates interpolate a UNION of fields —
-- `slug`, `nodeId`, `edgeId`, `key`, `source`/`sourceHandle`/`target`/`targetHandle`, `at` — and no
-- single template uses more than four of them. Eight nullable text columns that one template each
-- populates is how a narrow table becomes a union of every producer's schema. The trade-off is real
-- and is stated in the reader: the column is unvalidated by the database, so `flow-summary-label.ts`
-- treats EVERY field as possibly absent and falls back to the prose. Same call as 0066.
--
-- EXPAND-ONLY, AND `summary` STAYS. `summary` remains NOT NULL and keeps being written
-- BYTE-IDENTICALLY. It is not dead weight and it is not deprecated:
--   (a) it is the fallback below, and
--   (b) it is the correct output for the reader that is NOT a browser — `src/ai/mcp/tools.ts`
--       returns the same `EditResult.summary` to an MCP/LLM client, where English is right and
--       `flow-summary-label.ts` is never involved. That is why this change does not touch the
--       exported `EditResult` shape at all.
--
-- ⛔ NO BACKFILL, AND THE FALLBACK IS PERMANENT RATHER THAN TRANSITIONAL. This is the sharper half
-- of the difference from a wire-only change like `GraphIssue.detail`: a graph issue is recomputed
-- on every validate, so its fallback drains within one deploy. A snapshot is a STORED ROW. Every
-- row written before this migration has `summary_code IS NULL` FOREVER. `SNAPSHOT_KEEP = 50`
-- (`src/ai/flow-edit-service.ts`) only ages them out on a flow that keeps being edited — a flow
-- checkpointed twice a year keeps its pre-0071 rows until the flow is deleted. Anyone who reads the
-- three-branch fallback in the label module as transitional scaffolding and deletes it blanks those
-- rows in all eight locales. It is load-bearing, permanently.
--
-- Backfilling is not available either: `added ${slug}` could be re-parsed out of the English with a
-- regex, but `connected ${source}.${sourceHandle} → ${target}.${targetHandle}` cannot be split back
-- into four fields unambiguously (a node id may itself contain a dot), and inventing a plausible
-- parse to make a screen look uniform is worse than the honest English sentence those rows carry.
--
-- WHY `SET LOCAL lock_timeout`, ON A FILE THAT ADDS TWO NULLABLE COLUMNS
-- ---------------------------------------------------------------------
-- `ADD COLUMN … text` / `… jsonb` with no default is metadata-only in PG 11+ (no table rewrite),
-- but it still needs an ACCESS EXCLUSIVE lock on `flow_snapshots`, and it must QUEUE for it behind
-- whatever is reading the table. That queue is worse here than the size of the change suggests: the
-- runner (`src/db/migration-runner.ts`) applies every pending file inside ONE outer transaction
-- under `pg_advisory_xact_lock`, so a lock waited on in this file is held until the LAST pending
-- file commits, and every other pod's boot migration is queued behind the advisory lock the whole
-- time. Unbounded, that is a fleet-wide readiness stall during a rolling deploy caused by one ALTER
-- that does no work. With the 5s ceiling the savepoint rolls back instead, the schema stays at
-- 0070, and the pod retries on its next boot. A retried migration beats a wedged fleet.
--
-- ⚠️ 0065 has neither the SET nor the RESET. Do not read it as precedent; 0066 is the template.
--
-- NO GRANT AND NO RLS CHANGE IS NEEDED. `0028_rls.sql:158` enables RLS on `flow_snapshots` with a
-- ROW-scoped tenant policy, and `0028_rls.sql:242` issues a TABLE-level `GRANT … ON ALL TABLES`.
-- A table-level grant covers columns added later, and a row-scoped policy is not column-scoped, so
-- both apply to `summary_code`/`summary_params` with no edit here.
SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM OF THIS FILE. `SET LOCAL` is scoped to the TRANSACTION, and the runner
-- applies every pending file inside ONE outer transaction with a savepoint per file — `RELEASE
-- SAVEPOINT` does not undo a SET LOCAL. Without the reset this 5s ceiling would silently apply to
-- 0072 and everything after it in the same boot, so a later migration that legitimately needs to
-- wait on a lock would fail for a reason nobody wrote down. `lock_timeout` is the ONLY GUC on
-- `MIGRATION_RESET_GUCS` (`src/db/migration-runner.ts`) and `tests/migration-guc-reset.test.ts`
-- statically scans every file here — setting any other GUC reds that test.

ALTER TABLE flow_snapshots
  ADD COLUMN IF NOT EXISTS summary_code text,
  ADD COLUMN IF NOT EXISTS summary_params jsonb;

COMMENT ON COLUMN flow_snapshots.summary_code IS
  'Which of the nine summary templates wrote this row (`FlowSummaryCode` in '
  'src/ai/flow-edit-service.ts), so the reader''s BROWSER can render the sentence in their own '
  'language (frontend/src/lib/i18n/flow-summary-label.ts). NULL means "written before 0071, or by '
  'a caller that supplies none — a MANUAL checkpoint whose text the USER typed" — the row then '
  'renders its English `summary`, which is why that column is not deprecated. A user who literally '
  'types "Manual checkpoint" gets NULL here and their own words back, verbatim.';

COMMENT ON COLUMN flow_snapshots.summary_params IS
  'The machine fields `summary_code`''s sentence interpolates — slugs, node ids, edge ids, config '
  'keys, or the RAW ISO instant a restore rolled back to. Never a pre-formatted date: the browser '
  'owns the formatting too, or there are two sources of truth. Deliberately unvalidated by the DB '
  '(the shape belongs to the code that wrote it), so the reader treats every field as possibly '
  'absent and falls back to the English `summary`.';

-- No index. Nothing filters or orders on either column: the timeline reads by (flow_id,
-- created_at) — the index `flow_snapshots_flow_id_created_at_idx` already serves it — and pulls
-- these along for the ride. An index here would cost every INSERT and serve no query.
-- (`CREATE INDEX CONCURRENTLY` is structurally impossible in this runner anyway — it cannot run
-- inside a transaction block — so any index taken here is a plain, blocking one.)

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
