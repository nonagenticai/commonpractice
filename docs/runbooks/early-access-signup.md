# Early-access self-signup: intake, Turnstile, Telegram approval

George's decision (2026-10-14): people sign up for early access from the nonagentic.ai website form or a chat. George approves each one from Telegram. Early-access v2 (2026-10-19): he approves **inside Telegram** (callback buttons, relayed by chat-bridge), the workspace **and the person's licence** exist before any email goes out, and the one email (set password + book link, in the person's language) lands them straight in the app. Early-access workspaces get plan `local-llm` (`services/plan-posture.ts` `NEW_TENANT_PLAN`, posture `local_allowed`, plus a per-tenant inference-router licence); they get `byo` only when the approver picks the `byo_required` posture.

Everything here ships **dark**. Each part switches on only when gitops sets its env vars and secrets. No secret values appear in this file.

## 1. Flow

1. The website form (`nonagentic.ai/early-access`) posts to the shared `early-access-intake` handler (repo `early-access-intake`, deployed by gitops in namespace `nonagentic-homepage`). The handler checks Turnstile and rate limits, then calls `POST /api/signup-approvals/intake` in-cluster with a Keycloak service-account token. A chat may call the same endpoint the same way.
2. CP writes a `pending` row in `signup_approvals`. It uses the same queue, de-dupe and admission rules as the in-app `notify-self`.
3. When the row is **new** and its source is **trusted**, CP sends one Telegram message to the "CP signups" forum topic. A de-duplicated re-submit sends nothing. The message shows name, email, company, source, language, which trusted path admitted it, a message excerpt (≤300 characters, one line), the pending count and the signup id. Untrusted signups are handled differently (see §1a). Its buttons:
   - row 1: **callback** buttons **Approve** / **Reject**, `callback_data` = `ea1:cp:a:<signupId>` / `ea1:cp:r:<signupId>` (contract C1, ≤64 bytes);
   - row 2: a URL button **Open in CommonPractice** → `https://<CP>/onboarding?signup=<id>` (the approve dialog for that signup, for a custom name or plan).
4. A tap on Approve/Reject goes to **chat-bridge** (the bot's only update consumer). chat-bridge checks the tapper is an approver and calls `POST /api/signup-approvals/<id>/telegram-decision` with its own service-account token (§3c). CP runs the same approve (with defaults) or reject as the super_admin screen. chat-bridge then answers the callback and edits the message (buttons removed, outcome appended).
5. On approve or reject, CP posts a follow-up in the same topic: the outcome, the requester (name, email), who decided (Telegram user or the CP screen), the workspace name, slug and id, whether the requester was seated and how the email went, and every provisioning step that did not finish `ok`.

### 1a. Which signups reach Telegram one by one

`notify-self` is open to anyone. Its only limit is an anonymous bucket of 10 requests per minute per IP, and Turnstile is off until a widget exists. Announcing every anonymous row would let anyone flood George's phone, so a new row is announced individually **only** when one of these vouches for it (stored in `signup_approvals.trust`, migration 0106):

| `trust` | Path |
|---|---|
| `intake` | `POST /api/signup-approvals/intake`, authenticated with the website/chat service account |
| `verified_email` | `notify-self` with a token whose verified email is the address (the row stores the Keycloak sub) |
| `turnstile` | anonymous `notify-self` whose Turnstile token **passed** siteverify |
| NULL | anything else, including an anonymous `notify-self` without Turnstile and a signed-in caller whose token does not prove the address |

An untrusted (NULL) row is queued exactly as before and appears on `/onboarding`. Telegram hears about such rows only through the **digest**. Every replica polls every 15 minutes. When at least one pending untrusted row has not been counted yet, CP sends **at most one** message per `SIGNUP_DIGEST_INTERVAL_HOURS` (default 6): "K unverified signups waiting (M new since the last digest)", with an **Open signup queue** button. The rate limit is the `scheduler_ticks` row `signup_digest`, so it holds across replicas and restarts. Rows counted as new are stamped `digested_at`, so the digest stays quiet until something new arrives. A failed digest send is counted (`digest_failed`) and not re-sent; the queue stays the source of truth. The digest contains only counts, never anything a requester typed.

⚠️ `scheduler_ticks` row `signup_digest` only moves when there is something to report. A freshness alert on `commonpractice_scheduler_last_run_timestamp_seconds{scheduler="signup_digest"}` would fire on a quiet week, so it must not have one.

**Recommendation:** once the nonagentic.ai website form exists and relays a Turnstile token, set `TURNSTILE_REQUIRED=true` (with `TURNSTILE_SECRET`). An anonymous `notify-self` must then pass Turnstile, so every anonymous row is trusted and is announced individually. The digest then only covers rows from other paths.

### 1b. What a requester can put in the message

`name` and `company` are normalised at input validation (`utils/untrusted-text.ts`):
- control characters (Unicode Cc) and line/paragraph separators become spaces;
- format characters (Cf: bidi overrides and isolates, zero-width characters, BOM) are removed;
- whitespace collapses to single spaces and the value is trimmed.

The result must be 1–160 characters; a value that is empty after stripping returns 422. The notifier also renders every requester-typed value (name, email, company, the message excerpt) on its own labelled line inside a Telegram `code` entity, with no `parse_mode`; each value is forced onto one line first, so a newline cannot forge a line of the message. A URL in a name shows as inert monospace text, not a link, and link previews are disabled. The **Open in CommonPractice** button is the only link in the message, and CP builds it.

**Personal data in Telegram (George 2026-10-19).** The new-signup and decision messages carry the requester's name, email, company and a message excerpt: the topic is George's private chat, and approving from Telegram needs to know who is asking. (Before v2 they carried ids and counts only.) The digest still carries counts only.

CP never calls `setWebhook`, `deleteWebhook` or `getUpdates`, because chat-bridge owns the bot's webhook. A test greps `backend/src` to enforce this. CP only *sends*; decisions reach CP from chat-bridge's service account (§3c), never from Telegram directly.

## 2. Calling the intake (intake handler / chat)

Get a token with client credentials:

```
POST https://auth.nonagentic.ai/realms/portal/protocol/openid-connect/token
  grant_type=client_credentials&client_id=cp-signup-intake&client_secret=<secret>
```

Then:

```
POST https://<CP backend>/api/signup-approvals/intake
Authorization: Bearer <access_token>
Content-Type: application/json

{ "email": "ann@globex.com", "name": "Ann Early", "company": "Globex",
  "source": "web", "locale": "de" }
```

- `locale` (optional, migration 0121) is the visitor's language from the website. It is normalised to one of `ar de en es fr he nl pl` (`de-DE` → `de`). An **unknown** language is treated as absent (stored NULL → English), never a 422; only a non-string is refused.

- `email` and `name` are required. `company`, `locale` and `message` (multi-line, ≤2000 chars, never logged; a one-line ≤300-char excerpt is shown in the Telegram notice) are optional. `name` and `company` are normalised to a single line (≤160 chars, see §1b). `source` is `web` or `chat`. `turnstileToken` is optional; the intake handler never sends it, because it already verified Turnstile itself. The schema is strict, so an unknown field returns 422.
- **202** `{"status":"queued"}` means a new pending row. **202** `{"status":"already_pending"}` means a pending row for that address already existed. Treat both as success.
- **401**: the token is missing, invalid or expired.
- **403** `signup_intake_forbidden`: wrong `azp`, an `aud` that does not contain the token's `azp`, the role is missing, or the token carries `super_admin`. An operator session is refused on purpose.
- **403** `turnstile_failed`: a relayed Turnstile token was rejected by siteverify.
- **503** `turnstile_unavailable`: siteverify could not be reached. Retry.
- **503** `signup_queue_full` / `signup_queue_anonymous_full`: the queue is at its ceiling. These are the same refusals as `notify-self`. Retry later.
- The handler reaches CP by in-cluster Service DNS (`INTAKE_TARGETS` in gitops `services/nonagentic-homepage/early-access-intake-patch.yaml`), never the public host. CORS stays limited to the CP app origin.
- The row is stored **without a Keycloak sub** (the service account is not the requester). Approve therefore sends an invite to the address, and accepting the invite proves the person owns it.

## 3. Approving

`POST /api/signup-approvals/:id/approve` still requires a super_admin JWT. For `{"mode":"new_tenant"}` both fields are now optional:

- `tenantName` defaults to, in order: the company; the organisation part of the email domain (`ann@mail.acme.co.uk` → `acme`), except for public mailbox providers (the built-in list in `services/onboarding-service.ts` plus the `free_email_providers` table), where the requester's name is used; then the email local part. CP slugifies the result.
- `byoMode` defaults to the posture the plan fixes: new workspaces get `local-llm`, which gives `local_allowed`. Choosing `byo_required` puts the workspace on the deployment default plan instead.
- **Auto-suffix, self-signup approval only.** If the name is taken, in CP or in CP's own licences namespace (licences `409` → `licences_name_unavailable`), CP tries `<name>-2` … `<name>-10` and then returns a 409. The final name is returned (`tenant.slug`, `tenant.licencesName`), written to the `signup.approve` audit metadata and included in the Telegram follow-up. `POST /api/tenants` (super_admin manual create) **never** auto-suffixes and still returns the 409.
- The CP slug and the licences name are now always the **same** name. CP used to suffix its own slug while registering the unsuffixed name in licences.
- **Both are immutable after create.** `PATCH /api/tenants/:id {name}` changes only the display name; it no longer renames the licences tenant. That rename used to split the pair on the first rename. Renaming the slug as well was rejected for three reasons. The slug is the tenant's SSO identifier: the Entra IdP alias `entra-<slug>` lives in Keycloak, which cannot rename an alias, and `?tenant=<slug>` sign-in links derive the alias from the slug. The offboard confirmation is typed against the slug. The onboarding-integrity repair re-registers a tenant in licences under its slug. The `tenant.rename` audit row records the unchanged slug and licences name.
- The first tenant admin is the signup's email and name. It is a direct seat when a verified sub is on the row; otherwise it is an invite — and, for a workspace this approval founds, the invitee is **seated at approval** (§3d).

The queue listing and `GET /api/signup-approvals/:id` now include `company`, `source` and `suggested_tenant_name`.

### 3a. Inviting someone directly (pre-approved)

George can invite a person without them filling in the public form: **Onboarding → "Invite to early access"** (email, name, company optional). The form calls `POST /api/signup-approvals/invite` (super_admin JWT; strict body `{email, name, company?, tenantName?}`, unknown fields → 422).

- CP records a signup row with `source = 'invite'` (migration 0120 widens the `source` CHECK), no Keycloak sub, `requested_role = tenant_admin`, and then runs **the same approve path** as `{"mode":"new_tenant"}` above: a new workspace on `local-llm`, the person invited as its tenant admin, the invite email (for a new identity, Keycloak's set-password email) and the Telegram decision follow-up. The response is the approve payload.
- If the address already has a **pending** signup (from the website, the chat or the app), that row is reused and approved now; the queue never holds two rows for one address.
- An address that already belongs to a workspace gets the same `409 user_belongs_to_another_workspace` approve gives, and nothing is written.
- No new-signup Telegram notice is sent and the anonymous queue ceiling does not apply (this is a super_admin action). Audit: `signup.invite` (`metadata.approvalId`, `metadata.reusedPending`), followed by the usual `signup.approve`.
- The form has an **Email language** select (the eight locales, default English): `locale` in the body (strict — anything else is 422). For a reused pending row, the choice overwrites the row's language.
- When CP mints the person's Keycloak identity, they are **seated at approval** and licensed before the email goes out (§3d). An address that already has a realm identity (e.g. someone's fr login) is invited as before and seated when they accept with a verified email.

### 3b. What the invitee sees

1. One email: for a new identity, Keycloak's "set password" email in their language, with the book download link (CommonPractice variant, §3e). It returns them to the **app root** (`CP_PUBLIC_URL/`): they were seated and licensed at approval, so there is nothing to accept. The link carries no per-send token, so a resend never invalidates an earlier email.
2. They set a password. With the Keycloak auto-login SPI (contract C5) they are signed in at once; without it, they sign in.
3. The invite link from the approve response (`/invite/accept?token=…`, for handing over by hand) still works and is **instant**: the invite is already accepted by them, so it only confirms it (no licence call).
4. They land **straight in the app**. There is no "Access granted" screen and no button to press. If a licence is still missing, the app itself shows the "access is being set up" state until the tick finishes it.

An ordinary invite (an existing identity, or an invite into an existing workspace) still seats + licenses at accept, which takes a few seconds ("Setting up your workspace…").

### 3c. Deciding from Telegram (chat-bridge → CP)

`POST /api/signup-approvals/:id/telegram-decision`, body (strict) `{"action": "approve"|"reject", "telegramUserId": <number>}`.

- **Auth** (`middleware/signup-decider-auth.ts`): a portal-realm bearer token whose `azp` is in `CP_SIGNUP_DECIDER_AZP` (default `chat-bridge-signup-decider`), whose `aud` contains that `azp`, that carries the realm role `CP_SIGNUP_DECIDER_ROLE` (default `cp-signup-decide`), and that does **not** carry `super_admin`. No licence gate. Missing/invalid token → 401; anything else wrong → 403 `signup_decider_forbidden`. The intake client cannot decide and the decider client cannot submit.
- **Approve** = the super_admin approve with defaults: `{mode: "new_tenant"}` (the suggested workspace name, `local-llm`), even when the email domain matches an existing workspace (the new-signup message names that workspace — "Matches workspace" — so George can open CP instead). **Reject** = the super_admin reject.
- **One decider at a time, across replicas:** every approve first takes a claim on the row (`signup_approvals.approving_until` + a per-claim token `approving_claim`, migration 0121; one conditional UPDATE whose returned row is what the approve works from). A heartbeat renews the 5-minute window every minute while the approve runs (workspace creation can take ~20 min), up to a 30-minute ceiling; only the holder renews or releases it, and the final `approved` write requires the holder's token. While it is live, another approve answers 409 `approval_in_progress` on the screen and `already_decided` / `outcome: "in_progress"` to Telegram, and reject answers 409. The final `approved` / `rejected` write is itself conditional on `pending`.
- **Resume:** a workspace founded by an earlier attempt of the same approval that then failed or died at any point (`tenants.provisioning.signupApprovalId`, written in the tenant row's own INSERT) is finished — seat, licence, email — by the next approve (screen or Telegram), never a second workspace. A requester already seated there counts as success. A target a super_admin checkpointed for an `existing` approve is finished as that `existing` approve.
- **Audit**: `signup.approve` / `signup.reject` with `actor_id` NULL (the service account has no CP user) and metadata `decidedVia: "telegram"`, `actor: "telegram:<telegramUserId>"`, `deciderAzp`. `signup_approvals.decided_by` is NULL for the same reason.
- **Replies**: 200 `{"status": "approved", "tenantId", "summary"}` / `{"status": "rejected", "summary"}` / `{"status": "already_decided", "tenantId"?, "outcome", "summary"}` (idempotent: a decided row, or a decision for that row already running on this replica); 404 unknown id; 401/403 auth; 422 body; 502 `{"status": "failed", "code", "summary"}` when the decision could not be carried out (for example the address already belongs to a workspace) — the row then stays pending. `summary` is plain text, ≤200 characters, for chat-bridge to show in Telegram.

### 3d. Licence at approval (George 2026-10-19)

For a workspace the approval founds, when CP mints the requester's Keycloak identity (no realm account existed for the address), the approve path records three provisioning steps on the new workspace (visible on Platform → Tenants → the workspace's setup list, retryable there):

| Step | What | Retried by the 5-min tick? |
|---|---|---|
| `member_seat` | the CP user (= the minted sub) is the workspace's `tenant_admin`, and the invite is recorded `accepted` by it — in the same transaction as the seat claim | no (the approve's own transaction; Retry re-seats) |
| `member_licence` | `ensureTenantLicense` + `ensureMemberEntitlement` | **yes**, bounded backoff |
| `invite_email` | the set-password email (§3e) — **only after `member_licence` is `ok`/`skipped`** | **yes**; while the licence is outstanding it waits (`waiting_for_member_licence`) and is woken the moment the licence lands |

The approve request runs `member_licence` and `invite_email` **under each step's claim** (the same per-(tenant, step) lease the tick and Retry take), so the request and the tick can never both send the email. A step that has landed is not re-run.

The approve response's `invite.emailDelivery` is `keycloak_actions` when the email went out in the request, or `deferred` when it waits for the licence or failed to send (the tick sends it). The requester's email/name/sub/invite id/language are held on the workspace row (`provisioning.signupAdmin`) only until `invite_email` lands, and are dropped on offboard.

**Why no verified email is required for this seat:** everywhere else CP seats a sub only when Keycloak proves it owns the address. This identity has no such history: CP created it in this request, for this address, with no password and no IdP link. Nobody can sign in as it until the password is set, and the only way to set it is the link mailed to that address, which also completes `VERIFY_EMAIL`. An identity that already existed is never seated early.

### 3e. The approval email (book link, language)

Right before Keycloak's `execute-actions-email` (`UPDATE_PASSWORD`, `VERIFY_EMAIL`, client `commonpractice-frontend`, `redirect_uri` = the app root, 14-day link), CP writes three user attributes with a read-modify-write of the whole Keycloak user (no other attribute is touched):

- `locale` — the row's language, else `en`;
- `signup_app` = `commonpractice` — the email theme picks the CommonPractice partial;
- `signup_book_url` — the epub link from book-fulfillment: `POST {BOOK_FULFILLMENT_URL}/internal/download-links {email, lang}` with a client-credentials token for `commonpractice-book-links` (contract C4).

After the email call returns, CP removes `signup_book_url` again. A book-link failure never blocks the email: it goes out without the link, the failure is logged (`signup_book_link_failed`) and counted (`commonpractice_signup_book_link_total{outcome="failed"}`; `disabled` when unconfigured, `ok` otherwise). An attribute-write failure is logged (`signup_email_attributes_failed`) and the email still goes out (Keycloak's generic variant).

A refusal (wrong account, expired or already-used invite, no free seats, …) stays on `/invite/accept` with its explanation and, for a wrong account, the "Sign in with another account" button.

## 4. Configuration (backend env)

| Env var | Secret? | Default | Meaning |
|---|---|---|---|
| `CP_SIGNUP_INTAKE_AZP` | no | `cp-signup-intake` | Comma list of Keycloak client ids allowed to call intake |
| `CP_SIGNUP_INTAKE_ROLE` | no | `cp-signup-intake` | Realm role the intake token must carry |
| `TURNSTILE_SECRET` | **yes** | unset | Cloudflare Turnstile secret. When set, a token that is sent gets verified |
| `TURNSTILE_REQUIRED` | no | `false` | `true` means an **anonymous** `notify-self` must carry a valid token. Without a secret, anonymous signups are refused (503) |
| `TELEGRAM_BOT_TOKEN` | **yes** | unset | @nonagenticaibot token |
| `TELEGRAM_SIGNUP_CHAT_ID` | no | unset | `-1003934173351` |
| `TELEGRAM_SIGNUP_THREAD_ID` | no | unset | `message_thread_id` of the new "CP signups" topic (**not 167**) |
| `CP_PUBLIC_URL` | no | first CORS origin | Origin used in the Approve/Reject links |
| `SIGNUP_DIGEST_INTERVAL_HOURS` | no | `6` | At most one unverified-signup digest per this many hours (§1a). `0` turns it off. Values below 0.25 are raised to 0.25 |
| `CP_SIGNUP_DECIDER_AZP` | no | `chat-bridge-signup-decider` | Comma list of Keycloak client ids allowed to call the Telegram decision (§3c) |
| `CP_SIGNUP_DECIDER_ROLE` | no | `cp-signup-decide` | Realm role the decision token must carry |
| `BOOK_FULFILLMENT_URL` | no | unset | In-cluster base URL of book-fulfillment (§3e). Unset = no book link |
| `BOOK_LINKS_CLIENT_ID` | no | `commonpractice-book-links` | Portal-realm client CP mints book links with |
| `BOOK_LINKS_CLIENT_SECRET` | **yes** | unset | That client's secret (or `BOOK_LINKS_SECRET_FILE`, a mounted file holding it) |
| `BOOK_LINKS_TOKEN_URL` | no | `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token` | Token endpoint for that client |
| `BOOK_LINKS_TIMEOUT_MS` | no | `5000` | Per call (token, mint) |

Telegram stays disabled unless all three `TELEGRAM_*` values are set. At boot the backend logs `signup_telegram_enabled`, or `signup_telegram_disabled` with the missing names. Turnstile logs `turnstile_enabled`, `turnstile_disabled`, or `turnstile_required_without_secret` (error).

Sends are fire-and-forget: at most 3 attempts with backoff, `retry_after` honoured on 429 (capped at 30 s), and no retry on other 4xx. A failure never blocks or fails a signup or a decision. The counter is `commonpractice_signup_telegram_send_total{outcome=new_signup_ok|new_signup_failed|decision_ok|decision_failed|digest_ok|digest_failed}`. At boot the digest logs `signup_digest_armed` or `signup_digest_disabled`. The bot token is redacted from logs.

## 5. Infra to create before go-live

1. **Telegram:** in chat `-1003934173351`, create a forum topic "CP signups" with @nonagenticaibot. Read its `message_thread_id` (for example from the topic link `t.me/c/3934173351/<thread_id>`). Make sure the bot may post in that topic.
2. **Keycloak (realm `portal`)** is gitops-managed: `SIGNUP_INTAKE_CLIENTS` in `clusters/strato/services/keycloak/realm-patch-script-configmap.yaml`, applied by the hand-run Job `realm-patch-job-cp-signup-intake.yaml`. It converges:
   - realm role `cp-signup-intake`, granted to the service account and nothing else (never `super_admin`)
   - confidential client `cp-signup-intake`: service accounts only, `fullScopeAllowed=false`
   - audience mapper `cp-signup-intake-audience` (aud=`cp-signup-intake`), which CP's guard requires
   - the client secret reaches the intake handler through its own Secret in `nonagentic-homepage`, never CP's
3. **gitops (commonpractice backend Deployment + SOPS secret):**
   - env: `TELEGRAM_SIGNUP_CHAT_ID`, `TELEGRAM_SIGNUP_THREAD_ID`, and optionally `CP_SIGNUP_INTAKE_AZP`, `CP_SIGNUP_INTAKE_ROLE`, `TURNSTILE_REQUIRED`
   - secret keys: `TELEGRAM_BOT_TOKEN`, and `TURNSTILE_SECRET` once a Turnstile widget exists
   - **egress:** the backend must reach `api.telegram.org:443` and, with Turnstile, `challenges.cloudflare.com:443`. As of gitops `origin/main` 00a0497bbd, `services/commonpractice/networkpolicy.yaml` (`commonpractice-default`) already allows public `0.0.0.0/0:443` minus RFC1918, so no NetworkPolicy change is expected. These calls use plain `fetch` and do not go through the LLM egress guard. Prove it with the first real send after go-live: watch for `signup_telegram_send_total{outcome="new_signup_ok"}`.
4. **Cloudflare Turnstile:** the "nonagentic.ai early access" widget exists and is verified by the intake handler. CP needs `TURNSTILE_SECRET` only for anonymous `notify-self`.
5. **Early-access v2 (Keycloak + gitops):**
   - realm role `cp-signup-decide` + confidential client `chat-bridge-signup-decider` (service accounts only, `fullScopeAllowed=false`, audience mapper aud=`chat-bridge-signup-decider`, never `super_admin`); its secret goes to chat-bridge only;
   - confidential client `commonpractice-book-links` (service account, realm role `book-links-mint`, audience mapper aud=`commonpractice-book-links`); its secret goes to CP as `BOOK_LINKS_CLIENT_SECRET`;
   - CP backend env `BOOK_FULFILLMENT_URL` (in-cluster Service URL); egress from `commonpractice` to book-fulfillment's namespace/port;
   - CP's Keycloak admin service account must be allowed to update users (`manage-users`) for the attribute writes;
   - user-profile attributes `signup_app`, `signup_book_url` (admin view/edit only) and the `nonagentic` email theme's CommonPractice partial (contract C5, nonagenticai/keycloak).
6. Migration `0121_signup_locale.sql` adds `signup_approvals.locale` (nullable, CHECKed to the eight locales). It runs on boot.
7. Migrations `0105_signup_company_source.sql` (adds `signup_approvals.company` and `.source`) and `0106_signup_trust_and_digest.sql` (adds `.trust` and `.digested_at`) run on boot. 0106 backfills `trust='intake'` on existing `web`/`chat` rows. Every other older row stays NULL, so the first digest after deploy counts every older pending row that is still waiting.
8. The website form is live and goes through the handler (trust `intake`). `TURNSTILE_REQUIRED` only matters for anonymous `notify-self`; see §1a.
