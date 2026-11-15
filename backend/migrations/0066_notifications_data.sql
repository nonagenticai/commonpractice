-- 0066_notifications_data.sql — the MACHINE FIELDS behind a notification's sentence.
--
-- THE DEFECT. `notifications.title` / `.body` are ENGLISH PROSE composed on the server
-- (`host/budget-service.ts` `alertCopy`), and `routes/notifications.ts` `toView` hands them to the
-- browser verbatim — unlike `routes/marketplace-summary.ts` and `routes/blocks.ts`, which both
-- negotiate a locale. The topbar bell then renders `{n.title}` / `{n.body}` inside a fully
-- localized panel. The sharpest edge is not the English prose itself: the body tells the reader to
-- "open Administer → LLM settings" while the sidebar four inches away renders those exact two
-- labels in the reader's own language, so the breadcrumb names menu items that are not on screen.
--
-- The server does not know, and must not know, who is reading — a tenant-wide row (`user_id IS
-- NULL`, see host/notification-service.ts) is read by several people who may not share a language,
-- so there is no locale to negotiate against at INSERT time and no second chance later. The only
-- fix that works is the one `/it-dash` already took in #244: the wire carries the KIND plus the
-- MACHINE FIELDS, and the browser owns the words (`frontend/src/lib/i18n/notification-label.ts`).
--
-- `kind` alone cannot carry it. Every welcome-budget alert is `kind = 'budget.threshold'`, but
-- `alertCopy` writes THREE different sentences off `threshold` (75 / 90 / 100), and two of them
-- interpolate three values each — the remaining dollars, the granted limit, and the tenant's name.
-- Those numbers exist only inside that one function; nothing else in the row holds them, and
-- re-deriving them at read time would mean re-reading a `tenant_llm_budgets` row that has since
-- moved on. So they are persisted here, beside the prose, at the moment the sentence was true.
--
-- WHY A jsonb COLUMN AND NOT TYPED COLUMNS. `notifications` is deliberately generic (0044: "kept
-- generic so any future alert can use it rather than growing a second mechanism"). A second alert
-- kind carries a different field set, and four nullable numeric columns that only one kind ever
-- populates is how a generic table becomes a union of every producer's schema. The trade-off is
-- real and is stated in the reader: the column is unvalidated by the database, so
-- `notification-label.ts` treats EVERY field as possibly absent and falls back to the prose.
--
-- EXPAND-ONLY, and the prose columns STAY. `title`/`body` remain NOT NULL and keep being written
-- byte-identically for at least one deploy. The browser reaches the API through the k8s Service,
-- which load-balances across old and new pods for the length of a rolling deploy, so a NEW frontend
-- really is answered by an OLD pod whose rows have `data IS NULL` — and every row written before
-- this migration has `data IS NULL` FOREVER, which is the stronger reason: the fallback is not a
-- transitional branch, it is how the existing feed keeps rendering. That exact hazard blanked
-- /governance and was caught only at review in PR #233.
--
-- No backfill. The historical rows cannot be reconstructed — `remaining` came from a live
-- OpenRouter response at alert time — and inventing a plausible number to make a screen look
-- uniform is worse than the honest English sentence those rows already carry.
--
-- WHY `SET LOCAL lock_timeout`, ON A FILE THAT ADDS ONE NULLABLE COLUMN
-- --------------------------------------------------------------------
-- `ADD COLUMN … jsonb` with no default is metadata-only in PG 11+ (no table rewrite), but it still
-- needs an ACCESS EXCLUSIVE lock on `notifications`, and it must QUEUE for it behind whatever is
-- reading the table. That queue is worse here than the size of the change suggests: the runner
-- (db/migration-runner.ts:59-84) applies every pending file inside ONE outer transaction under
-- `pg_advisory_xact_lock`, so a lock waited on in this file is held until the LAST pending file
-- commits, and every other pod's boot migration is queued behind the advisory lock the whole time.
-- Unbounded, that is a fleet-wide readiness stall during a rolling deploy, caused by one ALTER that
-- does no work. With the 5s ceiling the savepoint rolls back instead, the schema stays at 0065, and
-- the pod retries on its next boot. A retried migration beats a wedged fleet.
--
-- ⚠️ 0065 has neither the SET nor the RESET — it is the one file since 0059 that dropped the
-- convention. Do not read it as precedent.
--
-- NO GRANT AND NO RLS CHANGE IS NEEDED. 0044 (lines 103-115) enabled RLS with a row-scoped
-- `notifications_tenant` policy and issued a TABLE-level `GRANT SELECT, INSERT, UPDATE, DELETE ON
-- notifications TO cp_app`. A table-level grant covers columns added later, and a row-scoped policy
-- is not column-scoped, so both apply to `data` with no edit here.
SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM OF THIS FILE. `SET LOCAL` is scoped to the TRANSACTION, and the runner
-- applies every pending file inside ONE outer transaction with a savepoint per file — `RELEASE
-- SAVEPOINT` does not undo a SET LOCAL. Without the reset this 5s ceiling would silently apply to
-- 0067 and everything after it in the same boot, so a later migration that legitimately needs to
-- wait on a lock would fail for a reason nobody wrote down. No effect today (0066 is last), which
-- is exactly why it would have been a confusing surprise later. 0059 and 0060 set without
-- resetting; that is the latent trap this file is not repeating.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS data jsonb;

COMMENT ON COLUMN notifications.data IS
  'Machine fields the reader''s BROWSER turns into a localized sentence (frontend/src/lib/i18n/'
  'notification-label.ts). NULL means "written before 0066, or by a producer that supplies none" — '
  'the row then renders its English title/body, which is why those columns are not deprecated. '
  'Deliberately unvalidated: the table is generic across alert kinds, so the shape belongs to the '
  'producer (host/budget-service.ts exports BudgetAlertData for the only kind that exists).';

-- No index. Nothing filters or orders on `data`: the feed reads by (tenant_id, created_at) and
-- pulls this column along for the ride. An index here would cost every INSERT and serve no query.
-- (`CREATE INDEX CONCURRENTLY` is structurally impossible in this runner anyway — it cannot run
-- inside a transaction block — so any index taken here is a plain, blocking one.)

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
