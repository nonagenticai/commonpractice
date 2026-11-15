-- 0098 — a welcome-budget GRANT key is the platform's money, not the tenant's own key.
--
-- Migration 0091 backfilled every keyed tenant_llm_settings row as `tenant_byo`, and
-- host/budget-service.ts wrote the grant key into that table without declaring it. So a row whose
-- key IS the tenant's OpenRouter grant read "own key" — measured in prod for raisemytickets, whose
-- api_key_encrypted is byte-identical to its tenant_llm_budgets.or_key_encrypted. Under byo_required
-- such a tenant would spend the grant; under platform_only it would lose it.
--
-- budget-service copies the grant CIPHERTEXT verbatim into the settings row, so byte equality is the
-- exact test for those rows. secret-box uses a random IV, so a key that was re-encrypted would not
-- match here; ai/llm/select.ts `effectiveDeclared` also compares DECRYPTED keys at call time, so
-- that case is still treated as platform-funded. Idempotent: only `tenant_byo` rows are touched.
SET LOCAL lock_timeout = '5s';

UPDATE tenant_llm_settings s
   SET credential_source = 'trial_managed'
  FROM tenant_llm_budgets b
 WHERE b.tenant_id = s.tenant_id
   AND s.credential_source = 'tenant_byo'
   AND s.api_key_encrypted IS NOT NULL
   AND b.or_key_encrypted IS NOT NULL
   AND s.api_key_encrypted = b.or_key_encrypted;

RESET lock_timeout;
