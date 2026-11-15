# Restore runbook: CP OpenRouter welcome budget (grant)

Written against commonpractice `origin/main` **7891d35** (2026-10-13) and gitops-production `origin/main` **e3f498b500**.
The last commit where the feature was complete is **`ba350d6`** (#429). It was retired by **`220002d`** (#430, Part B).
The remaining OpenRouter code (`openrouter-admin.ts`, `revokeLegacyGrantKeys`, the `openrouter`/`budget` config) was **removed in `2922e54`; restore from its parent** (`git show 2922e54^:<path>`).
No secret values appear in this file.

## 1. What it did
- A super_admin granted a tenant a dollar budget with `POST /api/tenants/:id/budget {limitUsd, workTier?}`. Creating a tenant never granted one; it was always a separate, manual step. There was no fixed default amount: the operator typed it. Known grants: raisemytickets $5, and the Netcare orphan $10.
- Each grant was its **own OpenRouter provisioned key** (`POST /api/v1/keys`, `limit`=USD, `limit_reset: null`, so the limit was lifetime). CP minted it with the **management key**, an admin-only key that OpenRouter refuses on inference. The key was named `commonpractice/<slug>`.
- OpenRouter enforced the cap itself. Its `usage` / `limit_remaining` were the **authoritative** figures. CP's `usage_events.cost_usd` was advisory only and never decided an alert.
- Storage: the key was secret-box encrypted (`encryptSecret`, host/secret-box) into `tenant_llm_budgets.or_key_encrypted` + `or_key_hash`. The **same ciphertext** was copied into `tenant_llm_settings.api_key_encrypted` with `provider=openai_compatible`, `base_url=https://openrouter.ai/api/v1`, `model=work_tiers[tier]` (default `medium`) and `credential_source='trial_managed'`. Both writes happened in one transaction.
- A top-up raised `limit` on the SAME key (`PATCH keys/{hash}`) for both `active` and `exhausted` rows. It never minted a second key.
- Alerts: a scheduler polled each live key every `BUDGET_CHECK_INTERVAL_MIN` (15) and sent 75/90/100 % in-app notifications (`kind='budget.threshold'`) plus email to the tenant admins. `alerted_threshold` only rises and is claimed with a conditional UPDATE in the same transaction as the notification. The tick lock is `TICK_LOCK.budget`.
- If the tenant saved its own key (`PUT /api/llm-settings` with apiKey), the grant was set to `replaced` and **the key was left live on purpose**.
- Offboard: before #430 nothing revoked the key. Since #430, offboard calls `revokeLegacyGrantKeys`, which disables the key, then deletes it, then marks the row `revoked`.
- Metering/billing: `trial_managed` collapses to the ledger value `platform_managed` (select.ts `ledgerCredentialSource`). Grant spend was therefore billed as platform money **at full resale price**, never as a BYO markup. 0091 introduced the 4-value declaration. 0098 relabelled the one prod row (raisemytickets) that 0091's backfill had wrongly made `tenant_byo`, which would have billed markup-only. #402 fixed the vendor identity: before it, spend was keyed `openai_compatible`, which has no price row. Pricing now uses `presetKey=openrouter` + OpenRouter's reported `usage.cost`.

## 2. Inventory at `ba350d6` (restore source)
Backend:
- `backend/src/services/openrouter-admin.ts`. Client with `createKey` :227, `getKey` :271, `updateKey` :276, `stopSpending` :319 (PATCH disabled, read back, fall back to delete), `deleteKey` :359, `openRouterAdmin()` :369, test seam `__setOpenRouterAdminForTests` :376, counter `openrouter_disable_unconfirmed_total` :36. Still present on 7891d35; **removed in `2922e54`; restore from its parent**.
- `backend/src/host/budget-service.ts`. `grantTenantBudget` :190: cent validation :211, `models.external_http` + egress-allowlist preconditions :226-243, top-up :253-405, mint :428, transaction :445-484, orphan cleanup on failure :486-511. Also `markBudgetReplaced` :526, `alertCopy` :586, `checkTenantBudgets` :646, `getTenantBudget` :131, `getBudgetsForTenants` :156. On 7891d35 this file is reduced to `revokeLegacyGrantKeys` :60 plus the legacy notification types; `2922e54` removed `revokeLegacyGrantKeys` too (restore from its parent).
- `backend/src/host/budget-scheduler.ts`, `startBudgetScheduler` :43. Deleted in #430.
- `backend/src/server.ts` :110 import, :378 `startBudgetScheduler()`.
- `backend/src/routes/admin.ts`: `grantBudgetSchema` :129 (`limitUsd` positive, max 1e6, multipleOf 0.01), `grantBudget` :370, `getBudget` :396, route registration :1346.
- `backend/src/routes/llm-settings.ts` :25 import, :411 `markBudgetReplaced`.
- `backend/src/config.ts` :584-605 (`openrouter.{baseUrl,managementKey,timeoutMs}`, `budget.{enabled,intervalMinutes}`). These lines still existed on 7891d35; removed in `2922e54` (restore from its parent).
- `backend/src/ai/llm/provider-catalog.ts`: `DEFAULT_WORK_TIER_MODELS` :60 (small `google/gemma-4-26b-a4b-it:free`, medium `nvidia/nemotron-3-super-120b-a12b`, large `z-ai/glm-5.2`), `OPENROUTER_BASE_URL`/`HOST` :69-70, preset `openrouter` :205. All still on main.
- `backend/src/ai/llm/select.ts` (main): `DeclaredCredentialSource` :107, `ledgerCredentialSource` :122, `ownKeyDisabled` :439, `effectiveDeclared` :451, the byo_required refusal for platform-funded rows :496-506.
- `backend/src/db/schema.ts` (main): `tenantLlmBudgets` :2275, `credential_source` :1379. `tick-locks.ts` :49/:196.

Migrations (all stay; migrations are forward-only):
- `0044_tenant_budgets_and_notifications.sql`: `tenant_llm_budgets` :31, `tenant_llm_budgets_active_uq` :66 (one live grant per tenant), RLS :74, `notifications`.
- `0045_openrouter_governance.sql`: merges the work-tier models into `models.allowlist`, adds `openrouter.ai` to `data.egress_allowlist`, and creates the `models.work_tiers` policy.
- `0053` price rows `openrouter/*`. `0066` `notifications.data` for budget alerts.
- `0091_llm_credential_source.sql`: CHECK covers `tenant_byo|platform_managed|trial_managed|local`, DEFAULT `platform_managed`.
- `0098_llm_grant_key_not_byo.sql`: relabels rows whose settings ciphertext equals `or_key_encrypted` to `trial_managed`.
- `0099_tenant_inference_credential.sql`: adds status `revoked`. The table is kept for history.

Frontend (deleted or rewritten in #430): `src/lib/billing/budget-status.ts`, the budget panel in `(tenant)/llm-settings/+page.svelte`, the budget section in `(platform)/tenants/[id]/+page.svelte` (:78-90, :276-300, :583+), `adminApi.grantBudget` in `src/lib/api/admin.ts` :195, and the i18n `admin_tenants_budget_*` keys in 8 locales.

Tests:
- Deleted in #430: `backend/tests/budget-service.test.ts` (816 lines), `frontend/src/lib/billing/budget-status.test.ts`, `(platform)/tenants/[id]/tenant-page.budget.render.test.ts`, `(tenant)/llm-settings/budget-claim.render.test.ts`.
- Still on 7891d35, removed in `2922e54` (restore from its parent): `backend/tests/openrouter-admin.test.ts` (25 cases), the `revokeLegacyGrantKeys` case in `part-b-plans-billing.test.ts` :440-447, and the `openrouter_disable_unconfirmed_total` pin in `metrics-counter-preseed.test.ts`.
- ⚠️ `frontend/src/lib/i18n/retired-welcome-budget.test.ts` **asserts the copy is absent**. A restore must change it deliberately; do not just delete it to make CI pass.

gitops (`clusters/strato/services/commonpractice/`):
- `secrets.yaml` (SOPS secret `commonpractice-env`) holds key **name** `OPENROUTER_MANAGEMENT_KEY` (line 16).
- `deployment.yaml` :536-550 sets `BUDGET_ALERTS_ENABLED="true"` and `BUDGET_CHECK_INTERVAL_MIN="15"`. These are now dead env.
- `networkpolicy.yaml` :153 opens SMTP 587 for alert mail.
- `configmap.yaml` :51 has a comment about the `:free` suffix.
- `OPENROUTER_BASE_URL` / `OPENROUTER_TIMEOUT_MS` are unset, so the defaults apply.

Recover any file with `git show ba350d6:<path>`. For the full set, `git diff 220002d ba350d6 -- <paths>` reverses the retirement. Do NOT revert #430 wholesale: it also carries the plans, the IR licence and billing terms.

## 3. Why it was retired
- #430 Part B (owner decision, 2026-10-12): plans became `local-llm` and `byo`. A tenant's LLM money is now the billing-service **money budget** (prepaid credit, topped up and invoiced). The grant overlapped that and was a second spend ledger.
- Owner rule: **the platform never pays for commercial models**, and **no commercial API tokens live in CP's gitops**. `OPENROUTER_MANAGEMENT_KEY` in `commonpractice-env` violates the second rule, which is why the remaining code and the secret are being deleted.

## 4. Restore plan
1. **Management key off CP.** Do not put it back into `commonpractice-env`. Put a platform-side **grant broker** in front of OpenRouter. The preferred home is the inference-router: it already holds per-tenant licences, introspects in enforce mode, and meters. CP sends `POST grant {tenantId, limitUsd}` with its own service credential and gets back an opaque grant id.
   - Option (a): calls go through IR, and CP stores only the grant id. No OpenRouter key ever enters CP. This is the preferred option.
   - Option (b): the broker returns the per-tenant capped key, and CP stores it encrypted as before. Under (b) CP still holds a commercial token in its DB, which the owner should explicitly accept or reject.
   - Under either option, the broker owns create/top-up/disable/delete and the authoritative usage read.
2. **Port `openrouter-admin.ts` into the broker unchanged in behaviour.** That means lifetime `limit`, `limit_reset:null`, and #393's read-back-before-believing-disable. In CP, replace `openRouterAdmin()` with a broker client that keeps the same interface, so `grantTenantBudget` and its tests port with minimal change.
3. **Guard exception.** The "platform-paid ⇒ local models only" guard is `assertPlatformLocalOnly` in `backend/src/services/byo-posture.ts` (throws `PlatformLocalOnlyError`, 403 `llm_platform_local_only`). It allows a call only when `isPlatformLocalTarget` in `backend/src/ai/llm/provider-catalog.ts` is true: the target is the in-cluster router (the `local` preset base url) **and** the model is in `LOCAL_LLM_MODELS` (`['local-llm']`). It is called wherever the credential is not a declared `tenant_byo` key: `select.ts` `resolveChatProvider` (a stored key on a `trial_managed` / `platform_managed` / `local` row — exactly where a restored grant key sits, so a grant would be REFUSED today), `platformKeyFor` (router token), `resolveAdHocChat` (stored non-BYO key), and `host/llm-broker.ts` `brokerLlmCall` (the mode-driven router provider). Tests: `backend/tests/llm-platform-local-only.test.ts`. A deliberate capped-grant exception would have to change **`resolveChatProvider`'s call** (and `resolveAdHocChat`'s, for the save probe), not the shared predicate: skip `assertPlatformLocalOnly` only when `declared === 'trial_managed'` **and** a live, capped grant row exists for the tenant (`tenant_llm_budgets.status='active'`, `limit_usd>0`, its `or_key_encrypted` equal to the row's key) **and** the target is the OpenRouter preset (`OPENROUTER_BASE_URL`) **and** the model is in `models.work_tiers`. Give it its own named function next to `assertPlatformLocalOnly` so it is greppable. Pin it with a test pair: the exception without a grant row must still throw `PlatformLocalOnlyError`, and a grant row with a non-tier model must still throw. Never widen `isPlatformLocalTarget`, `LOCAL_LLM_MODELS` or `platform_managed`. Note also that CP no longer reads `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` and `backend/tests/config-no-provider-keys.test.ts` fails if config reads any `*_KEY`/`*_TOKEN` env of a commercial provider — under option (a) the broker credential must be a CP service credential, not an `OPENROUTER_*` env var.
4. **Billing terms.** Decide whether grant spend is (i) free promo credit, a platform cost with a zero-price invoice line, or (ii) drawn from the tenant's prepaid money budget. If (i), the rate card needs a "grant" line, or billing will resell it at full price (the current `trial_managed`→`platform_managed` collapse). Whichever is chosen, keep `ledgerCredentialSource` exhaustive. A new value must fail `tsc`.
5. **Restore** budget-service grant/top-up/replaced/alerts, the scheduler, the routes, and the frontend panels from `ba350d6`. Use a new migration if the table needs a `grant_id` column for option (a). Re-enable the `BUDGET_*` env.
6. **Tests to bring back:** `budget-service.test.ts`, `budget-status.test.ts`, the two render tests, and `openrouter-admin.test.ts` moved to the broker. Invert `retired-welcome-budget.test.ts`. Keep the `revokeLegacyGrantKeys` cases. Add the guard-exception pair from step 3 and an offboard test that confirms revoke-failure is reported.

## 5. Traps from its history
- **Orphan keys.** The 2026-10-12 Netcare create failure left a half-created CP tenant (`01a130e0`) holding a **$10** grant key. It was deleted by hand that day. A mint followed by a failed DB write leaves a paid key that nothing references. The existing cleanup (:486) only logs `budget_openrouter_key_orphaned` if the delete also fails. Needed: an orphan sweep that lists keys named `commonpractice/*` against `tenant_llm_budgets`.
- **Keys stay spendable.** `replaced` deliberately keeps the key live. Before #430, offboard never revoked. `revokeLegacyGrantKeys` leaves a key `active` if the disable fails and only retries on the *next offboard*; nothing else retries it. A 2xx disable was believed without read-back until #393.
- **Top-up of an exhausted row** used to mint a second key and strand the first. Match `active` and `exhausted`.
- **Sub-cent limits** truncate to $0.00 in `numeric(12,2)`, so the budget never alerts and never exhausts. The fix was a whole-cents check in the service, not only in zod.
- **Dead grants.** With `models.external_http` off, or `openrouter.ai` missing from the egress allowlist, a funded grant can never be spent. That is why 0045 exists and why the precondition 409s exist.
- **Mislabel.** Copying the grant ciphertext into the settings row made it read as BYO (0091 backfill, fixed by 0098). Secret-box uses a random IV, so a re-encrypted copy no longer matches byte-for-byte.
- **`:free` ids.** OpenRouter's `:free` suffix means a zero-price model (`pricing.ts` :117), with the price rows to match. The `small` tier `google/gemma-4-26b-a4b-it:free` costs $0 but is rate-limited and can disappear. `z-ai/glm-5.2` has a blended price that moves. Tier ids live in the `models.work_tiers` policy, not in code.
- **Flow runs.** Flow runs once ignored `tenant_llm_settings`, so a grant covered agent chat only. Use `resolveTenantChatProviderIfConfigured`, not `resolveChatProvider`, or `agent-loop.test.ts` makes real network calls.
