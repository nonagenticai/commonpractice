-- 0081_user_locale_nullable.sql — make `users.locale` able to say "I have no preference", so that
-- the Accept-Language negotiator we already wrote can actually run.
--
-- THE DEFECT. A Dutch reader, on a Dutch browser, in a Dutch insurance workspace, was served an
-- English UI — and the code written to prevent exactly that could never execute. Four facts, each
-- innocuous on its own:
--
--   1. `0009_i18n.sql:4` created the column as `text NOT NULL DEFAULT 'en'`. There is no value in
--      its domain that means "unset". Every row that has ever existed holds a locale.
--   2. `routes/me.ts` calls `negotiateLocale(req, row?.locale)` under the comment "Stored
--      preference wins; otherwise negotiate from Accept-Language."
--   3. `utils/locale.ts` `negotiateLocale` returns `userPref` immediately when it is supported, and
--      only falls through to the `accept-language` loop when it is absent or unsupported.
--   4. ⇒ Because (1) guarantees the stored value is always at least `'en'`, the fall-through in (3)
--      is UNREACHABLE FOR EVERY USER THAT EXISTS. The Accept-Language branch, its parser, its
--      q-value handling and its base-tag splitting are dead code in production. `/api/me` answers
--      `en` to a browser that asked for `nl-NL,nl;q=0.9`, and `+layout.svelte`'s
--      `locale.init(auth.user?.locale)` then overwrites whatever Paraglide had already negotiated
--      client-side with that `en`. The stored default beats the browser, on every device, forever.
--
-- Measured in production: 6 of the 7 `fr-test` demo users hold `locale='en'`; only
-- `fr-test@nonagentic.local` holds `nl`. Demonstrating the product as any of the other six shows an
-- English UI no matter what the machine's language is.
--
-- WHY THE COLUMN AND NOT THE NEGOTIATOR. The alternative fix is to keep the NOT NULL and teach
-- `me.ts` to treat `'en'` as "maybe not a real choice" — which is a lie the moment somebody
-- genuinely prefers English, and it makes English the one locale a user cannot pin. The honest
-- shape is a three-state column: a supported locale = "this person chose this"; NULL = "nobody has
-- ever said", which is what a first-touch row actually knows. `ensureUser`'s `upsertRow` and
-- `provisioning.upsertLocalUserTx` both insert `users` WITHOUT a locale, so with the default gone
-- every newly provisioned row is born NULL and negotiates from the browser on its first request.
--
-- ⛔ THE BACKFILL IS THE LOAD-BEARING HALF, AND IT IS A JUDGEMENT CALL — READ IT BEFORE COPYING IT.
-- Dropping NOT NULL alone fixes nothing for anyone who already has a row: all 22 rows here (and
-- every row in production) hold `'en'`, so the negotiator stays unreachable for them and only
-- accounts created after this migration ever see their own language. So the existing `'en'` rows
-- are reset to NULL.
--
-- The argument that `'en'` is a default rather than a choice: the ONLY writer of this column is
-- `PATCH /api/me/locale`, and the only caller of that is the topbar switcher
-- (`frontend/src/lib/stores/locale.svelte.ts` `set()`, "User-driven switch"). `init()` — the
-- boot-time seed — never PATCHes. And `set()` opens with
-- `if (!isSupported(next) || next === this.current) { … return; }`, so it cannot fire for a value
-- the store is already on. A user therefore cannot have CHOSEN `'en'` without first having been on
-- some other locale and switched back. Every other `'en'` in the table is migration 0009's default.
--
-- THE TRADE-OFF, STATED RATHER THAN HIDDEN. This backfill is not free and it is not reversible from
-- the data (a NULL cannot be told apart afterwards from an `'en'` that was deliberate). Two
-- populations, and they are very different sizes:
--
--   • The person who switched away from English and back again — a real choice, erased here. Their
--     cost: the next `/api/me` negotiates from their browser instead. If their browser says English
--     they notice nothing at all; if it does not, they get ONE paint in the negotiated language and
--     one click on the topbar switcher to pin English again, which this time stores a genuine
--     preference that no future migration will read as a default.
--   • Everyone else — every user in the table, since nobody has taken that path. Their cost if we
--     do NOT backfill: pinned to English permanently, on every device, with the fix shipped and
--     inert. That is precisely the defect, surviving its own repair.
--
-- One re-click for a rare user against a permanent lock-in for the common one. We take the click.
--
-- ⛔ NOT IDEMPOTENT IN THE "RE-RUNNABLE" SENSE, AND IT MUST NOT BE MADE SO. The two ALTERs are
-- naturally re-runnable (Postgres does not error on dropping an absent NOT NULL or DEFAULT), but
-- the UPDATE is a ONE-SHOT amnesty: run it a second time, after this fix is live, and it would
-- delete the deliberate `'en'` preferences the fix newly makes possible. That is safe here only
-- because `db/migration-runner.ts` records applied filenames in `_migrations` and never re-applies
-- one. Do not copy this UPDATE into a later file, and do not wrap it in an `IF NOT EXISTS`-shaped
-- guard that would invite re-running it.
--
-- NO CODE PATH NEEDS A NULL CHECK. `negotiateLocale(req, null)` already falls through to the header
-- and returns a concrete `Locale` (`DEFAULT_LOCALE` when there is no header at all), so `/api/me`
-- still always answers with a supported string and the frontend contract is unchanged. `me.ts:62`
-- is the ONLY reader of this column in the codebase — every other `locale` in the backend belongs
-- to `content_translations` or `mcp_prompts`, which are different tables and unaffected.
--
-- NO GRANT AND NO RLS CHANGE. `users` carries neither `relrowsecurity` nor `relforcerowsecurity`,
-- and `0028_rls.sql` grants at TABLE level (which covers columns whatever their nullability), so
-- there is nothing to re-issue.
--
-- WHY `SET LOCAL lock_timeout`. Both ALTERs are catalog-only (dropping a NOT NULL or a DEFAULT
-- rewrites nothing), but each still takes ACCESS EXCLUSIVE on `users` and must QUEUE behind every
-- reader of it — and `users` is read on essentially every authenticated request (`ensureUser` runs
-- on all of them). The runner applies every pending file inside ONE outer transaction under
-- `pg_advisory_xact_lock`, so a lock waited on here is held until the last pending file commits and
-- every other pod's boot migration queues behind the advisory lock for the duration. Unbounded that
-- is a fleet-wide readiness stall during a rolling deploy. With the 5s ceiling the savepoint rolls
-- back instead, the schema stays at 0080, and the pod retries on its next boot. Same reasoning as
-- 0075; the ceiling also covers the UPDATE, which does touch every row.
SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM OF THIS FILE. `SET LOCAL` is transaction-scoped and the runner applies
-- every pending file inside ONE outer transaction with a savepoint per file — `RELEASE SAVEPOINT`
-- does not undo a `SET LOCAL`. Without the reset this 5s ceiling would silently apply to 0082 and
-- everything after it in the same boot. `lock_timeout` is the ONLY GUC on `MIGRATION_RESET_GUCS`
-- (db/migration-runner.ts); `tests/migration-guc-reset.test.ts` statically scans every `.sql` here
-- and reds CI on any other.

ALTER TABLE users ALTER COLUMN locale DROP NOT NULL;
ALTER TABLE users ALTER COLUMN locale DROP DEFAULT;

-- The one-shot amnesty. See "THE BACKFILL IS THE LOAD-BEARING HALF" above before touching this.
UPDATE users SET locale = NULL WHERE locale = 'en';

COMMENT ON COLUMN users.locale IS
  'The user''s EXPLICIT UI locale preference, or NULL when they have never expressed one. '
  'Three-state on purpose: NULL is not "English", it is "nobody has said" — routes/me.ts passes it '
  'to negotiateLocale(), which falls through to the request''s Accept-Language header and only then '
  'to DEFAULT_LOCALE. Before 0081 this column was NOT NULL DEFAULT ''en'' (0009), which made that '
  'fall-through unreachable for every user that exists and pinned a Dutch reader on a Dutch browser '
  'to an English UI. Written ONLY by PATCH /api/me/locale, whose only caller is the topbar switcher '
  '(locale.svelte.ts set(), which early-returns when the value is already current) — so a stored '
  'value is always a deliberate act, and 0081 reset the pre-existing ''en'' rows to NULL on that '
  'basis. Read by routes/me.ts and nowhere else; content_translations.locale and mcp_prompts.locale '
  'are unrelated columns on other tables.';

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
