-- 0072_block_test_result_error_machine_fields.sql — the MACHINE FIELDS behind a block-test refusal.
--
-- THE DEFECT. `block_test_results.error` is ENGLISH PROSE composed on the server
-- (`blocks/test-runner.ts` for the verdict, `exec/descriptor.ts` + `exec/flow-executor.ts` for the
-- refusal inside it), and `routes/blocks.ts` `listTests` hands it to the browser verbatim.
-- `BlockResultView.svelte` then renders `{errorMessage}` raw inside a fully localized panel — so a
-- Dutch author whose block failed a descriptor check read a Dutch coral pill, a Dutch explanatory
-- paragraph, and, underneath both, "output does not match the declared descriptor: 'doubled' must
-- be a finite number". The one line that says WHAT IS WRONG was the only English on the screen.
--
-- The server does not know, and must not know, who is reading. The fix is the one `/build`'s graph
-- issues and the topbar bell already took: the wire carries the RULE plus the MACHINE FIELDS, and
-- the browser owns the words (`frontend/src/lib/i18n/block-test-error-label.ts`).
--
-- ⛔ WHY THIS MIGRATION IS NOT OPTIONAL, WHICH IS THE WHOLE POINT OF THE FILE.
-- `block_test_results` is the ONLY record of a test's outcome: `runBlockTests` streams the result
-- once over SSE and then every subsequent /block-edit page load re-reads THIS ROW. Ship `rule` +
-- `detail` on the live response alone and the localized sentence appears the instant the suite
-- runs and REVERTS TO ENGLISH ON REFRESH — silently, with every frontend render test still green,
-- because those tests build their own props. That is exactly the "green in every test, inert in
-- production" failure the HEAD commit (#309) is named after, and it is why
-- `tests/block-test-error-machine-fields.test.ts` asserts through the LIST endpoint rather than
-- through the run response.
--
-- ⛔ THE ENGLISH `error` COLUMN STAYS, AND IS NOT DEPRECATED. Three independent readers need it:
--   1. `ai/mcp/tools.ts` (`run_block_test`) returns the string verbatim to an LLM — English is the
--      CORRECT output for that reader, and this migration's browser path is never involved.
--   2. `BlockFixAssistant.svelte` puts the SAME string into an LLM PROMPT ("Fix with AI"). One
--      string, browser-facing and machine-facing, on one screen.
--   3. It is the fallback: every row written before this migration has `error_rule IS NULL`
--      FOREVER, and so does every row whose text is a BLOCK AUTHOR'S OWN `throw` — the absence of
--      a rule is precisely what tells the browser "these are not our words, render them raw".
-- (3) is the stronger reason: the fallback is not a transitional branch, it is how half the live
-- traffic renders permanently.
--
-- NO BACKFILL, AND NONE IS POSSIBLE. The historical rows cannot be reconstructed: the tokens
-- (`field`, `options`, `actualKind`, the per-issue bag) existed only inside the function that
-- composed the sentence, and re-deriving them by re-parsing English prose would guess wrong the
-- first time a block author's message happened to look like a product one. Guessing to make a
-- screen look uniform is worse than the honest English those rows already carry.
--
-- WHY `error_detail` IS jsonb AND NOT TYPED COLUMNS. The bag differs per rule — 28 rules, and the
-- widest of them carries a nested array of `{rule, message, detail}` records (`detail.issues`, the
-- per-field issues that used to be `join('; ')`ed into an unrecoverable string). Nine nullable
-- columns that one rule apiece populates is how a table becomes the union of every producer's
-- schema; 0066 made the same call for `notifications.data` and states the same trade-off. The cost
-- is real and is stated in the reader: the column is unvalidated by the database, so
-- `block-test-error-label.ts` treats EVERY field as possibly absent and falls back to the prose.
--
-- WHY `SET LOCAL lock_timeout`, ON A FILE THAT ADDS TWO NULLABLE COLUMNS
-- ---------------------------------------------------------------------
-- `ADD COLUMN … text` / `… jsonb` with no default is metadata-only in PG 11+ (no table rewrite),
-- but it still needs an ACCESS EXCLUSIVE lock on `block_test_results`, and it must QUEUE for it
-- behind whatever is reading the table. That queue is worse than the size of the change suggests:
-- the runner (db/migration-runner.ts) applies every pending file inside ONE outer transaction under
-- `pg_advisory_xact_lock`, so a lock waited on here is held until the LAST pending file commits,
-- and every other pod's boot migration is queued behind the advisory lock the whole time.
-- Unbounded, that is a fleet-wide readiness stall during a rolling deploy, caused by one ALTER that
-- does no work. With the 5s ceiling the savepoint rolls back instead, the schema stays put, and the
-- pod retries on its next boot. A retried migration beats a wedged fleet.
--
-- NO GRANT AND NO RLS CHANGE IS NEEDED. `block_test_results` already carries its RLS policies and a
-- TABLE-level grant to `cp_app` (0037, narrowed by 0057 to "the parent block is OWNED by the
-- current tenant"). A table-level grant covers columns added later, and a row-scoped policy is not
-- column-scoped, so both apply to these two with no edit here.
SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM OF THIS FILE. `SET LOCAL` is scoped to the TRANSACTION, and the runner
-- applies every pending file inside ONE outer transaction with a savepoint per file — `RELEASE
-- SAVEPOINT` does not undo a SET LOCAL. Without the reset this 5s ceiling would silently apply to
-- 0073 and everything after it in the same boot, so a later migration that legitimately needs to
-- wait on a lock would fail for a reason nobody wrote down. `lock_timeout` is the ONLY GUC on
-- `MIGRATION_RESET_GUCS` (db/migration-runner.ts) and `tests/migration-guc-reset.test.ts` statically
-- scans every `.sql` in this directory — any other GUC set here reds CI.

ALTER TABLE block_test_results
  ADD COLUMN IF NOT EXISTS error_rule text,
  ADD COLUMN IF NOT EXISTS error_detail jsonb;

COMMENT ON COLUMN block_test_results.error_rule IS
  'The product rule behind `error`, so the reader''s BROWSER can write the sentence '
  '(frontend/src/lib/i18n/block-test-error-label.ts). Values are the BlockErrorRule union in '
  'backend/src/db/trace-types.ts. NULL means one of two things and BOTH render the English `error` '
  'column raw: the row was written before 0072, or the text is the BLOCK AUTHOR''S OWN `throw` — '
  'which is why `error` is not deprecated. Deliberately plain text, not an enum: a rule shipped '
  'backend-first must be storable one deploy before the browser knows the word for it.';

COMMENT ON COLUMN block_test_results.error_detail IS
  'Machine tokens for `error_rule`''s sentence (field names, enum options, ErrorKind tokens, the '
  'raw `cause` a product sentence was concatenated onto, and the nested per-field `issues` array '
  'that used to be join(''; '')ed into an unrecoverable string). Shape: BlockErrorDetail in '
  'backend/src/db/trace-types.ts. Deliberately unvalidated by the database — the shape belongs to '
  'the producer, and the reader treats every field as possibly absent and falls back to `error`.';

-- No index. Nothing filters or orders on either column: the panel reads results by
-- (version_id, test_id) and pulls these along for the ride. An index here would cost every INSERT
-- and serve no query. (`CREATE INDEX CONCURRENTLY` is structurally impossible in this runner
-- anyway — it cannot run inside a transaction block — so any index taken here is a plain,
-- blocking one.)

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
