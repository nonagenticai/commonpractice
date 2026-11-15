-- 0091_llm_credential_source.sql — WHOSE CREDENTIAL PAID IS *DECLARED* ON THE ROW, NOT INFERRED
-- FROM WHETHER A CIPHERTEXT HAPPENS TO BE PRESENT.
--
-- ⛔ THE DEFECT, AND IT IS A BILLING ONE. `ai/llm/select.ts` decided the BYO axis with
-- `credentialSource: tenantKey ? 'tenant_byo' : 'platform_managed'` (:368, and the same shape at
-- :270 in `resolveAdHocChat`). That is a GUESS off key PRESENCE, and it is the value
-- `host/metering-emit.ts:246` turns into `extra.byo = true` — i.e. it decides whether the customer
-- is charged a BYO markup instead of resale-at-cost. Emitting one as the other is a direct mis-bill
-- in either direction, and nothing on any screen reveals it.
--
-- ⛔ AND THE GUESS IS ALREADY MEASURABLY WRONG FOR ONE WHOLE COHORT. `host/budget-service.ts:367`
-- and `:462` write the PLATFORM's own OpenRouter welcome-budget key into
-- `tenant_llm_settings.api_key_encrypted` — a grant the platform funded. Key present ⇒ the
-- inference says `tenant_byo` ⇒ the tenant is charged a BYO markup on spend they never paid a
-- provider for. `api_key_encrypted` answers "is there a key in this row", which is not, and never
-- was, the same question as "whose money is it".
--
-- The four values are the four commercial states the product actually has:
--   tenant_byo       — the tenant's own provider token. BYO markup, no base cost resold.
--   platform_managed — the platform's credential (env key / a managed vendor account). Resold.
--   trial_managed    — a platform-FUNDED grant that happens to live in the tenant's row
--                      (host/budget-service.ts's welcome budget). Platform money, so NOT BYO.
--   local            — the in-cluster inference-router. No vendor credential at all.
--
-- ⚠️ ADDITIVE AND MEANING-PRESERVING, in migration 0090's house style. The backfill below writes
-- EXACTLY what `select.ts` computes today, so no ledger row changes meaning on the deploy; the
-- column only makes the decision WRITABLE, so the PUT route can start declaring it (see
-- routes/llm-settings.ts) instead of every reader re-deriving it.
--
-- ⚠️ WHAT THIS MIGRATION DELIBERATELY DOES **NOT** DO, so the next reader does not mistake the
-- column for a repair that has already happened: it does not reclassify the welcome-budget cohort
-- to `trial_managed`. Doing that needs a join to `tenant_llm_budgets.or_key_encrypted`, and a
-- backfill that MOVES money between two billing treatments is a decision to take deliberately with
-- a measured row count, not a side effect of adding a column. Rows reached by
-- `budget-service.ts`'s `onConflictDoUpdate` also keep whatever `credential_source` they already
-- had — that writer does not set the column — so an existing BYO row repointed at a grant stays
-- labelled `tenant_byo`. That is UNCHANGED from today, not a new hole; it is filed as the follow-up
-- this column exists to make possible.

SET LOCAL lock_timeout = '5s';

-- NULLABLE FIRST, then backfill, then DEFAULT + NOT NULL. ⛔ Not `ADD COLUMN … NOT NULL DEFAULT`
-- plus an UPDATE: this file must be safe to re-run (every other migration here is), and a
-- re-running `UPDATE … WHERE api_key_encrypted IS NOT NULL` would CLOBBER a row an operator or the
-- PUT route had since declared `platform_managed`/`trial_managed`, silently putting the guess back.
-- `WHERE credential_source IS NULL` is empty on every run after the first, by construction.
ALTER TABLE tenant_llm_settings
  ADD COLUMN IF NOT EXISTS credential_source text;

UPDATE tenant_llm_settings
   SET credential_source = CASE
         WHEN api_key_encrypted IS NOT NULL AND length(api_key_encrypted) > 0 THEN 'tenant_byo'
         ELSE 'platform_managed'
       END
 WHERE credential_source IS NULL;

-- ⭐ `platform_managed` IS THE RIGHT DEFAULT AND THE DIRECTION MATTERS. A row created without an
-- explicit declaration is one nobody has said anything about; defaulting to `tenant_byo` would bill
-- a markup on that silence. Under-claiming the markup is recoverable from the ledger; over-claiming
-- it is an invoice the customer disputes. This is also what makes a NEW welcome-budget tenant
-- correct on day one: budget-service.ts inserts a row it does not declare, and the default no
-- longer calls the platform's own grant "BYO".
ALTER TABLE tenant_llm_settings
  ALTER COLUMN credential_source SET DEFAULT 'platform_managed';
ALTER TABLE tenant_llm_settings
  ALTER COLUMN credential_source SET NOT NULL;

-- A CHECK rather than a pg enum: `llm_provider` is an enum and 0084 shows what that costs — an
-- enum's value set cannot be extended inside a transaction with other DDL in older servers, and a
-- fifth commercial state is far likelier than a fifth provider kind.
ALTER TABLE tenant_llm_settings
  DROP CONSTRAINT IF EXISTS ck_tenant_llm_settings_credential_source;
ALTER TABLE tenant_llm_settings
  ADD CONSTRAINT ck_tenant_llm_settings_credential_source
  CHECK (credential_source IN ('tenant_byo', 'platform_managed', 'trial_managed', 'local'));

COMMENT ON COLUMN tenant_llm_settings.credential_source IS
  'WHOSE credential pays the provider for this tenant''s LLM calls — declared, not inferred from '
  'api_key_encrypted being non-null. Read by ai/llm/select.ts into ResolvedChat.credentialSource, '
  'which host/metering-emit.ts turns into the billing `byo` flag. Written by '
  'routes/llm-settings.ts PUT. One of tenant_byo | platform_managed | trial_managed | local.';

-- ---- RLS: the strict 0028 §4a shape, re-asserted (tests/rls-coverage.test.ts requires it) -------
--
-- ⚠️ THE TABLE ALREADY HAD THIS POLICY (0028 §4b, re-created verbatim by 0084:211) AND IT IS
-- RE-ASSERTED HERE ON PURPOSE. `tests/rls-coverage.test.ts` enumerates every table carrying a
-- `tenant_id` and demands RLS-enabled + ≥1 policy; that guard reads the LIVE catalog, so it says
-- nothing about which migration file a policy came from. Re-asserting it in the same file that
-- widens the table is what makes this migration self-contained: applied alone against a database
-- that somehow lost the policy, it still leaves the table compliant, and a reader diffing THIS file
-- can see the row-scoping rule the new column inherits rather than having to go and find 0084.
--
-- ⛔ BYTE-IDENTICAL TO 0084:210-212, deliberately. This is a re-assertion, not a redesign — any
-- difference in the predicate here would be a silent RLS change smuggled in on a billing migration.
ALTER TABLE tenant_llm_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_llm_settings_tenant ON tenant_llm_settings;
CREATE POLICY tenant_llm_settings_tenant ON tenant_llm_settings
  USING       (tenant_id = app_current_tenant_uuid())
  WITH CHECK  (tenant_id = app_current_tenant_uuid());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_llm_settings TO cp_app;
    RAISE NOTICE '[0091] granted cp_app DML on tenant_llm_settings';
  ELSE
    RAISE NOTICE '[0091] cp_app absent → GRANT skipped (owner default-privileges cover it in prod)';
  END IF;
END $$;

RESET lock_timeout;
