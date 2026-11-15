-- 0084_tenant_id_is_a_uuid.sql — the last three `tenant_id text` columns become `uuid`.
--
-- WHAT
-- ----
-- `datasets.tenant_id`, `tenant_llm_settings.tenant_id` and `mcp_prompts.tenant_id` are the ONLY
-- tenant_id columns in this schema still stored as `text`. Every other one — 20-odd of them, from
-- `flows` and `usage_counters` (0028) through `agent_tool_rendezvous` (0070) — is `uuid`. This file
-- closes that split and, with it, retires `app_current_tenant_text()` as a policy helper.
--
-- ⛔ THIS IS A REPRESENTATION FIX, NOT A DATA FIX. Measured on prod (worker4) before writing:
--   tenant_llm_settings  14 rows / 14 distinct tenants / 0 NULL   (tenant_id is the PRIMARY KEY)
--   datasets             17 rows /  4 distinct tenants / 0 NULL   (NOT NULL)
--   mcp_prompts          24 rows /  0 distinct tenants / 24 NULL  (nullable — see §MCP_PROMPTS)
-- Every non-NULL value already parses as a uuid, none differ only by case, so `USING tenant_id::uuid`
-- is total and lossless. The acceptance test is that those three (rows, distinct) pairs are
-- BYTE-IDENTICAL afterwards: a falling distinct count is the one outcome this migration cannot undo.
--
-- WHY IT MATTERS THAT THEY WERE text
-- ----------------------------------
-- A `text` tenant key admits values a `uuid` key cannot: `'  <uuid>  '`, `'<UUID-IN-CAPS>'`, `''`,
-- and any typo at all. Under RLS that is not a cosmetic problem — the policy is an EQUALITY against
-- the request's GUC, so a row whose tenant_id differs from the real tenant by a space or a case is
-- not "slightly wrong", it is INVISIBLE and UNREACHABLE to its own owner, and it stays that way
-- silently (0058's header documents this exact silent-mismatch failure mode on usage_counters:
-- an ABSENT GUC errors loudly, a MISMATCHED one returns zero rows and no error). `uuid` makes the
-- whole class unrepresentable at the point of write instead of undetectable at the point of read.
-- It also makes the column joinable to `tenants.id` without a cast, which is what a future FK here
-- would need.
--
-- ⛔ WHAT THIS FILE DELIBERATELY DOES NOT DO — FOUR SCOPE BOUNDARIES, EACH CHECKED.
--
-- 1. `_purge_20260809b_llm_settings.tenant_id` IS ALSO `text`, AND IS LEFT ALONE. It is debris:
--    3 rows, one of eleven `_purge_20260809b_*` snapshot tables, with zero references anywhere on
--    `origin/main` — and `scripts/purge-fabricated-history.ts:592` already records that the family
--    should be dropped. Migrating it would dignify a snapshot as schema. Dropping it is an owner
--    decision about retention, not this migration's job. It staying `text` is the PROOF this file
--    was scoped rather than pattern-matched, and the acceptance check asserts exactly that.
--
-- 2. NO FOREIGN KEY TO `tenants` IS ADDED. None of the three has one today. `datasets.tenant_id` is
--    scoped-by-value on purpose (schema.ts:1632 note, matching the `challenges.tenant_id` house
--    pattern), and adding an FK is a behaviour change — it decides what a tenant deletion does to
--    these rows — that deserves its own migration and its own argument. A type change must not
--    smuggle one in.
--
-- 3. `mcp_prompts.tenant_id` STAYS NULLABLE, AND NO TENANT IS INVENTED FOR ITS 24 ROWS. See below.
--
-- 4. `app_current_tenant_text()` IS NOT DROPPED. After this file it has zero callers — but it is a
--    public function in a database with an in-flight branch or two, and dropping it is free to do
--    later and impossible to undo mid-deploy. Leaving a dead helper is cheaper than a 42883 on a
--    replica that has not rolled yet.
--
-- §MCP_PROMPTS — WHY 24/24 NULL IS CORRECT AND MUST STAY THAT WAY
-- ---------------------------------------------------------------
-- `mcp_prompts_read` is `tenant_id IS NULL OR tenant_id = <guc>`. NULL is not a gap in the data; it
-- is the encoding of "this is a GLOBAL prompt, visible to every tenant" — the same shape 0028 §4c
-- gives `ontology_entities`, `ontology_relations` and `dataset_mappings`, and 0037/0043 give
-- `building_blocks`/`block_templates`. So all 24 rows being NULL means the product currently ships
-- 24 global prompts and no tenant has authored one, which is a true and expected state. `ALTER TYPE`
-- preserves NULL exactly. ⛔ A `SET NOT NULL` here would make every shipped prompt invisible to
-- every tenant and break the MCP prompt surface outright.
--
-- ⚠️ WORTH FLAGGING, NOT WORTH FIXING HERE: "global" is carried by the ABSENCE of an id, which is
-- the same representational weakness that was fixed out of `core_app` and `karma`. The cost shows up
-- immediately below — the natural key cannot be `(name, locale, tenant_id)` because NULL is not equal
-- to NULL, so it has to be `coalesce(tenant_id, <sentinel>)`, and the sentinel is a magic value that
-- every reader must know. A `tenant_id NOT NULL` plus an explicit platform tenant row would remove
-- the sentinel, the coalesce, and the `IS NULL OR` in four policies. That is a data migration with a
-- product decision inside it. Flagged for an owner; explicitly out of scope for a type change.
--
-- ============================================================================================
-- THE CAST DECISION: USE THE EXISTING `app_current_tenant_uuid()`. NO CAST IS ADDED ANYWHERE.
-- ============================================================================================
-- Seven RLS policies compare these columns to `app_current_tenant_text()`, which returns `text`.
-- Against a `uuid` column that is `uuid = text` → 42883 `operator does not exist`, so every one of
-- them has to be rewritten. There were three ways to do it, and only one of them adds nothing new:
--
--   (a) ✅ CHOSEN — point the policies at `app_current_tenant_uuid()`, which has existed since
--       0028 §1 and is ALREADY what all ~20 uuid-keyed tables use. This is not a new construct, it
--       is the removal of an exception: 0028 §4b and §4c call these tables the "text variant" in so
--       many words, and the variant existed ONLY because the columns were text. Delete the reason,
--       delete the variant. Zero new SQL surface, and every tenant policy in the database now reads
--       identically, which is the property that makes a wrong one visible in review.
--   (b) ❌ `app_current_tenant_text()::uuid` inline in seven policies — duplicates, seven times over
--       and with no name, a helper that already exists three lines above it in the same schema.
--       Identical semantics to (a), strictly worse legibility, and it leaves the next author a
--       choice to make where there should be none.
--   (c) ❌ change `app_current_tenant_text()` to return uuid — a function whose NAME then lies, and
--       whose signature change is invisible at every call site.
--
-- FAIL-CLOSED — UNCHANGED BY (a), AND THAT IS THE POINT.
--   app_current_tenant_uuid() = `SELECT nullif(current_setting('app.current_tenant', true), '')::uuid`
--   app_current_tenant_text() = `SELECT nullif(current_setting('app.current_tenant', true), '')`
-- They are the same expression; one has a cast. So for the two inputs that matter the behaviour is
-- byte-identical before and after this file:
--   * GUC UNSET   → current_setting(…, true) → NULL → `tenant_id = NULL` → NULL → NOT TRUE
--                   → SELECT returns 0 rows, INSERT/UPDATE is rejected. FAIL-CLOSED.
--   * GUC EMPTY   → `nullif(…, '')` → NULL → identical to unset. FAIL-CLOSED.
--     (That `nullif` is load-bearing and 0028 §1 says why: after a RESET a custom GUC reads back as
--     `''`, not NULL, and `''::uuid` would RAISE. It is what keeps an unset GUC quiet.)
--
-- ⚠️ THE ONE BEHAVIOUR THAT DOES CHANGE, STATED PLAINLY: a GUC set to a NON-EMPTY NON-UUID string.
-- Under `_text()` that silently matched nothing (an empty result). Under `_uuid()` it raises 22P02
-- `invalid_text_representation`, which surfaces as a 500. This is a strict IMPROVEMENT and it is
-- also not new — it is the pre-existing contract for every other tenant table in this database
-- since 0028, so this file makes three tables agree with twenty rather than introducing a hazard.
-- It is the right direction because the two conditions are not equally likely to be a bug: an unset
-- GUC is a legitimate state (seed, migrations, schedulers, unauthenticated paths — the whole reason
-- `nullif` is there), whereas `app.current_tenant = 'not-a-uuid'` cannot be produced by any correct
-- path. It means the tenant resolver emitted garbage, and the failure mode that costs real money is
-- the one where that garbage returns an empty list that the caller renders as "you have no datasets".
-- A loud 500 on a corrupt tenant context beats a plausible-looking empty page, every time.
--
-- WHY EVERY POLICY MUST BE DROPPED FIRST, AND WHY IT IS ONE TRANSACTION
-- ---------------------------------------------------------------------
-- Postgres refuses `ALTER COLUMN … TYPE` on a column any policy expression depends on
-- (`cannot alter type of a column used in a policy definition`), so it is DROP → ALTER → CREATE.
-- There is no window: the runner applies every pending file inside ONE outer transaction with a
-- savepoint per file (db/migration-runner.ts), so the tables are never observably unprotected —
-- a failure anywhere below rolls back to the savepoint with all seven policies intact.
--
-- ⚠️ THE SEVENTH POLICY IS ON A DIFFERENT TABLE, AND IT IS THE ONE THAT GETS MISSED.
-- `mcp_prompt_versions_write` (0057 §4) never mentions `mcp_prompts` in its own table name, but its
-- subquery reads `p.tenant_id = app_current_tenant_text()`. That is a real recorded dependency:
-- leave it in place and the ALTER on `mcp_prompts` fails; drop it but recreate it unchanged and it
-- becomes `uuid = text` and 42883s on the first write to a prompt version — i.e. it would not fail
-- here, it would fail in production, later, on a write path. `pg_policies` filtered on the function
-- name is the only way to enumerate these; the table name is not enough.
-- (`mcp_prompt_versions_read`, `dataset_rows_via_parent` and `challenge_datasets_via_parent` were
-- checked and do NOT reference tenant_id — they are pure `EXISTS` against the RLS-filtered parent —
-- so they are untouched and stay untouched.)
--
-- INDEXES: ONE MUST BE REBUILT BY HAND, THE REST ARE AUTOMATIC.
-- Postgres reindexes a column's plain btree indexes and its PK/UNIQUE constraints itself during a
-- type change, so `tenant_llm_settings_pkey` (PRIMARY KEY on tenant_id — the whole PK is this
-- column), `datasets_tenant_slug_uq`, `datasets_tenant_id_idx` and `mcp_prompts_pkey` need nothing
-- here. `mcp_prompts_name_locale_tenant_uq` is the exception because it is an EXPRESSION index —
-- `COALESCE(tenant_id, ''::text)` from 0008:86-87 — and `''` is not a uuid, so it cannot be
-- re-derived. Recreated below against the zero-uuid sentinel this repo already uses for exactly this
-- job in 0018, 0019, 0023, 0037 and 0043.
--
-- ⛔ THAT SENTINEL SWAP IS NOT COSMETIC — CHECK IT BEFORE ASSUMING IT IS A NO-OP. The index enforces
-- "one prompt per (name, locale) per tenant, plus one global". `''` and the zero-uuid are both
-- values no real tenant has, so the partition of rows is unchanged and the index is equally unique.
-- The load-bearing part is that the sentinel keeps distinguishing global rows from tenant rows
-- rather than collapsing them; `coalesce(tenant_id, tenant_id)` or dropping the coalesce would let
-- two global prompts share a (name, locale) — NULL <> NULL — which is precisely what 0008 wrote this
-- index to prevent.
--
-- WHY `SET LOCAL lock_timeout`, ON THREE TABLES OF 14, 17 AND 24 ROWS.
-- Not the rewrite — that is microseconds at this size. The QUEUE for the ACCESS EXCLUSIVE lock.
-- `datasets` is read by every workspace request path, and the runner holds ONE outer transaction
-- under `pg_advisory_xact_lock`, so a lock waited on here is held until the last pending file
-- commits while every other pod's boot migration queues behind the advisory lock. Unbounded, that is
-- a fleet-wide readiness stall during a rolling deploy. With the 5s ceiling the savepoint rolls back,
-- the schema stays at 0083, and the pod retries on its next boot — a retried migration beats a
-- wedged fleet. Same reasoning as 0075.
SET LOCAL lock_timeout = '5s';
-- ⛔ RESET AT THE BOTTOM OF THIS FILE. `SET LOCAL` is transaction-scoped and `RELEASE SAVEPOINT`
-- does not undo it, so without the reset this ceiling would silently apply to every later file in
-- the same cold-boot run. `lock_timeout` is the only GUC on `MIGRATION_RESET_GUCS`, and
-- `tests/migration-guc-reset.test.ts` statically scans this directory — any other GUC set here
-- reds CI. (The runner also RESETs it on the success path; this file resets its own anyway, because
-- that is the house convention and it is what makes the file correct read in isolation.)

-- ============================================================================================
-- 1. Drop every policy that depends on one of the three columns. Seven, across FOUR tables.
-- ============================================================================================
DROP POLICY IF EXISTS datasets_tenant             ON datasets;
DROP POLICY IF EXISTS tenant_llm_settings_tenant  ON tenant_llm_settings;
DROP POLICY IF EXISTS mcp_prompts_read            ON mcp_prompts;
DROP POLICY IF EXISTS mcp_prompts_ins             ON mcp_prompts;
DROP POLICY IF EXISTS mcp_prompts_upd             ON mcp_prompts;
DROP POLICY IF EXISTS mcp_prompts_del             ON mcp_prompts;
-- The cross-table one (0057 §4). See the note above — this is the dependency that is easy to miss.
DROP POLICY IF EXISTS mcp_prompt_versions_write   ON mcp_prompt_versions;

-- The one index whose EXPRESSION cannot survive the type change (0008:86-87).
DROP INDEX IF EXISTS mcp_prompts_name_locale_tenant_uq;

-- ============================================================================================
-- 2. The type change. `USING tenant_id::uuid` is total over the live data (measured, see header);
--    on a fresh database these tables are empty and it is trivially total.
--    NULLability and NOT NULL constraints are preserved by ALTER TYPE — nothing here relaxes or
--    tightens them, which is deliberate for all three.
-- ============================================================================================
ALTER TABLE datasets            ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
ALTER TABLE tenant_llm_settings ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
ALTER TABLE mcp_prompts         ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;

-- ============================================================================================
-- 3. Rebuild the expression index against the house zero-uuid sentinel.
-- ============================================================================================
CREATE UNIQUE INDEX IF NOT EXISTS mcp_prompts_name_locale_tenant_uq
  ON mcp_prompts (
    name,
    locale,
    coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- ============================================================================================
-- 4. Recreate all seven policies, verbatim except that `app_current_tenant_text()` becomes
--    `app_current_tenant_uuid()`. Shapes are otherwise unchanged from 0028 §4b/§4c and 0057 §4 —
--    same commands, same permissive/restrictive kind, same `IS NULL OR` on the prompts read.
-- ============================================================================================

-- 4a. Strict (0028 §4b): own-tenant only, read and write.
CREATE POLICY datasets_tenant ON datasets
  USING       (tenant_id = app_current_tenant_uuid())
  WITH CHECK  (tenant_id = app_current_tenant_uuid());

CREATE POLICY tenant_llm_settings_tenant ON tenant_llm_settings
  USING       (tenant_id = app_current_tenant_uuid())
  WITH CHECK  (tenant_id = app_current_tenant_uuid());

-- 4b. Global-override (0028 §4c): read global (NULL) + own-tenant; write own-tenant only.
--     The INSERT check rejects NULL because `NULL = uuid` is NULL, not TRUE — so only the table
--     owner (which BYPASSes RLS: the tables are ENABLE, not FORCE) can seed a global prompt. That
--     asymmetry is the existing design and is preserved exactly.
CREATE POLICY mcp_prompts_read ON mcp_prompts FOR SELECT
  USING (tenant_id IS NULL OR tenant_id = app_current_tenant_uuid());
CREATE POLICY mcp_prompts_ins  ON mcp_prompts FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant_uuid());
CREATE POLICY mcp_prompts_upd  ON mcp_prompts FOR UPDATE
  USING      (tenant_id = app_current_tenant_uuid())
  WITH CHECK (tenant_id = app_current_tenant_uuid());
CREATE POLICY mcp_prompts_del  ON mcp_prompts FOR DELETE
  USING (tenant_id = app_current_tenant_uuid());

-- 4c. Child write-scope (0057 §4). `mcp_prompt_versions_read` is NOT recreated because it was never
--     dropped: it does not reference tenant_id at all.
CREATE POLICY mcp_prompt_versions_write ON mcp_prompt_versions FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM mcp_prompts p
      WHERE p.id = mcp_prompt_versions.prompt_id
        AND p.tenant_id = app_current_tenant_uuid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM mcp_prompts p
      WHERE p.id = mcp_prompt_versions.prompt_id
        AND p.tenant_id = app_current_tenant_uuid()
    )
  );

COMMENT ON COLUMN datasets.tenant_id IS
  'Owning workspace. `uuid` since 0084 (was `text` from 0028). Scoped-by-value with NO foreign key '
  'to `tenants`, matching the `challenges.tenant_id` house pattern — adding one is a decision about '
  'what a tenant deletion does to datasets, not a side effect of a type change. NOT NULL: every '
  'dataset belongs to exactly one workspace. Enforced by RLS policy `datasets_tenant` '
  '(tenant_id = app_current_tenant_uuid()).';

COMMENT ON COLUMN tenant_llm_settings.tenant_id IS
  'Owning workspace, and the PRIMARY KEY of this table — one LLM settings row per workspace. `uuid` '
  'since 0084 (was `text` from 0008/0028). Enforced by RLS policy `tenant_llm_settings_tenant`.';

COMMENT ON COLUMN mcp_prompts.tenant_id IS
  'Owning workspace, or NULL for a GLOBAL prompt visible to every workspace. `uuid` since 0084 (was '
  '`text` from 0008). ⛔ NULLABLE ON PURPOSE — as of 0084 all 24 rows are NULL, i.e. every prompt '
  'the product ships is global and no tenant has authored one. A NOT NULL here would hide every '
  'shipped prompt from every tenant. Read scope is `tenant_id IS NULL OR tenant_id = '
  'app_current_tenant_uuid()` (policy mcp_prompts_read); writes are own-tenant only, so only the '
  'table owner (which bypasses RLS) can seed a global row. The natural key is '
  '(name, locale, coalesce(tenant_id, ''00000000-0000-0000-0000-000000000000'')) because NULL is '
  'not equal to NULL — the sentinel is what stops two global prompts sharing a (name, locale).';

-- Scope the lock ceiling to THIS file (see the note beside the SET LOCAL above).
RESET lock_timeout;
