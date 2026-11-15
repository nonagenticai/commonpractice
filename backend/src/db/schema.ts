// src/db/schema.ts
// Session 0: `users`. Session 1 adds the building-blocks library:
// `building_blocks` (one row per block slug) + `block_versions` (semver
// history; docs/code/descriptor as JSONB). Flows / runs land in Sessions 2–3.
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  smallint,
  boolean,
  jsonb,
  timestamp,
  numeric,
  real,
  date,
  unique,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';
import type { BlockDescriptor, BlockExample } from './block-types';
import { EMPTY_SCANNED_SOURCE, type ScannedSource } from '../blocks/scanned-source';
import type { FlowGraph } from './flow-types';
import type { TraceEvent, BlockErrorRule, BlockErrorDetail } from './trace-types';
import { sql } from 'drizzle-orm';
import type { PeriodKind } from '../host/period';
/** A row's period kind: a period, 'off' (filed while the cadence was off), or NULL (legacy unfiled). */
export type PeriodRowKind = PeriodKind | 'off';
import type {
  DatasetColumn,
  ConnectorMeta,
  ConnectorEventSource,
  DatasetSyncErrorDetail,
} from './dataset-types';
import type {
  DeliveryPayload,
  DeliveryTargetConfig,
} from './delivery-types';

// Phase D (RLS): the per-request tenant GUC default. New tenant-scoped columns default to the
// request's `app.current_tenant` (set by withTenantDb), so request-path inserts need no explicit
// tenant_id. The SQL function is created in migration 0028_rls.sql. Columns are NULLABLE in D.1
// (NOT NULL is deferred to D.1.1, after the out-of-ALS paths — run-pump, schedulers, sandbox
// provisioning — thread the tenant): a NULL tenant_id is fail-closed under RLS (invisible) and
// non-destructive, and keeps the existing test suite (owner-bypass, no GUC) green unchanged.
// `tenants` is the FK target for the hard-scoped tables; marketplace tables are scoped-by-value
// (no FK), matching the existing challenges.tenant_id house pattern.
const tenantGucDefault = sql`app_current_tenant_uuid()`;

export const userRoleEnum = pgEnum('user_role', ['employee', 'platform']);

// The role a user holds IN THEIR HOME TENANT (0093). CP-owned and authoritative: the request path
// reads it from here, never from Keycloak realm roles (the portal realm is shared with fr, so a
// realm role is not CP's to read or write). `super_admin` stays a realm role — platform operator,
// not a tenant role.
export const tenantRoleEnum = pgEnum('tenant_role', ['member', 'developer', 'tenant_admin']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  keycloak_sub: text('keycloak_sub').unique(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  avatar_initials: text('avatar_initials'),
  role: userRoleEnum('role').notNull().default('employee'),
  // The user's EXPLICIT UI locale preference (§5B) — one of the 8 supported locales — or NULL
  // when they have never expressed one.
  //
  // ⛔ NULLABLE, WITH NO DEFAULT, AND THAT IS THE WHOLE POINT (0081). This was
  // `.notNull().default('en')` from 0009 until 0081, which meant the column had no value that
  // could mean "unset": every row held at least 'en'. `routes/me.ts` calls
  // `negotiateLocale(req, row?.locale)` and `utils/locale.ts` returns a supported `userPref`
  // IMMEDIATELY — so the Accept-Language fall-through underneath it was unreachable for every user
  // that existed, and a Dutch reader on a Dutch browser was served an English UI by a codebase that
  // had already written the negotiator to prevent that. NULL is the three-state column's "nobody
  // has said", which is exactly what a first-touch row knows: neither `ensureUser`'s `upsertRow`
  // nor `provisioning.upsertLocalUserTx` writes this column, so a new row is born NULL and
  // negotiates from the browser. Do NOT restore the default to "keep the type non-optional" —
  // that re-lands the defect. `me.ts` is the only reader and it still always answers a concrete
  // `Locale`, because `negotiateLocale(req, null)` ends at `DEFAULT_LOCALE`.
  locale: text('locale'),
  // The user's single home tenant — AUTHORITATIVE since 0093 (services/cp-identity.ts reads it
  // on every request; the Keycloak `tenant_id` claim is ignored). Written only by CP: invite
  // accept, signup approval, SSO first login, and the super_admin move. NOT a switcher.
  tenant_id: uuid('tenant_id').references(() => tenants.id, {
    onDelete: 'set null',
  }),
  // Role in the home tenant (0093). NULL = not yet backfilled from the old realm roles; the
  // request path reads NULL as `member` (services/cp-identity.ts).
  tenant_role: tenantRoleEnum('tenant_role'),
  // Offboarding tombstone (0050). Set = this person has been removed from the workspace: their
  // Keycloak identity is gone, their seat is released and they are absent from every roster.
  // The ROW survives because 14 FKs reference it ON DELETE NO ACTION (`usage_counters.user_id`
  // among them, so anyone who ever made a metered call is undeletable), and because deleting it
  // would erase the authorship of everything they made. Reads meaning "who is in this workspace"
  // filter `deleted_at IS NULL`; reads meaning "who made this" resolve tombstones too.
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// ---- Tenants (Phase 2-D, single-tenant-per-identity since Phase 4 / C.1) ----
// Real tenant entities. A user belongs to exactly one tenant (users.tenant_id) with one role
// there (users.tenant_role), both owned by CP's DB since 0093; only `super_admin` is a Keycloak
// realm role. Tenant-scoped authz is `requireTenantAdmin` (middleware/admin-guards.ts).

export const tenantStatusEnum = pgEnum('tenant_status', ['active', 'suspended']);

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  status: tenantStatusEnum('status').notNull().default('active'),
  // Phase 3.4: the industry half of the (industry × department) ontology cell the
  // build agent reasons over. Nullable — unset means the agent passes industry
  // explicitly. Set via seed/DB this phase; a tenant-settings editor is 3.5.
  industry: text('industry'),
  // Phase 4 / F.1 (license dual-gate, Spec Part 9): the tenant's `commonpractice` license
  // token (licenses.example.com), secret-box encrypted at rest, write-only — never returned by a
  // read endpoint. Gate 2 (middleware/license-gate.ts) decrypts + introspects it per request.
  // NULL until F.2 onboarding issues it; the gate is a no-op while NULL / flag-off.
  license_token_encrypted: text('license_token_encrypted'),
  // Seat cap (migration 0044): how many users this tenant may hold. NULL = unlimited, which is
  // every pre-0044 tenant. Enforced on the invite / tenant-user-create paths, not retroactively —
  // lowering it below the current headcount blocks new invites, it never removes anyone.
  max_members: integer('max_members'),
  // Tenant offboarding (migration 0075). Set = this WORKSPACE has been offboarded: its status was
  // driven to 'suspended', every member row was tombstoned, every MCP API key issued in it was
  // revoked, every agent session was revoked and each member's Keycloak identity was deleted
  // (POST /api/tenants/:id/offboard, routes/admin.ts). NULL = not offboarded, which is every tenant
  // that predates 0075.
  //
  // ⛔ NOT a third `tenant_status` value, and the distinction is load-bearing: every reader of
  // `status` in this product is a binary ternary (`=== 'active' ? … : …`), so a third enum value
  // would render through the wrong branch on every screen. 'suspended' IS the correct runtime
  // posture — every gate that must deny an offboarded workspace already denies a suspended one —
  // and this column carries the extra fact for the readers that want it.
  //
  // Written ONCE, as `COALESCE(offboarded_at, now())`, which is what makes the offboard route
  // idempotent: a second call preserves the original timestamp and reports `alreadyOffboarded`.
  // It is also the reactivation bar — `patchTenant` refuses `status: 'active'` while it is set.
  offboarded_at: timestamp('offboarded_at', { withTimezone: true }),
  // How this tenant relates to the licences-registry tenant with the SAME id (0093):
  // 'registered' = CP created it there; 'adopted' = it already existed (provisioned elsewhere)
  // and a super_admin explicitly adopted it. NULL = pre-0093 row; the onboarding-integrity sweep
  // still owns its registration.
  // ⚠️ 'adopted' is LEGACY (A2 removed adoption: CP always registers its own licences tenant). The
  // CHECK still admits it until the last adopted prod row is deleted — see migration 0095's TODO.
  central_link: text('central_link').$type<'registered' | 'adopted'>(),
  central_linked_at: timestamp('central_linked_at', { withTimezone: true }),
  // Per-tenant licence terms (0095). `plan_code` NULL reads as `config.license.planCode`.
  plan_code: text('plan_code'),
  licence_id: uuid('licence_id'),
  licence_subject_sub: text('licence_subject_sub'),
  licence_starts_at: timestamp('licence_starts_at', { withTimezone: true }),
  licence_expires_at: timestamp('licence_expires_at', { withTimezone: true }),
  // CP's OWN licences-registry tenant name (slug, or `<slug>-cp[-n]` on a clash). NULL = slug.
  licences_name: text('licences_name'),
  // Per-tenant lease serialising tenant-licence mutations (0096; license-provisioning.ts
  // `withLicenceLease`). Never held across a transaction — a single conditional UPDATE.
  licence_op_id: uuid('licence_op_id'),
  licence_op_until: timestamp('licence_op_until', { withTimezone: true }),
  // An OLD tenant licence a swap still has to revoke (0097) — written in the swap's CAS, cleared when
  // licences confirms; the onboarding-integrity sweep retries it.
  licence_revoke_pending: uuid('licence_revoke_pending').array().notNull().default(sql`'{}'::uuid[]`),
  // The tenant's own inference-router licence token (0099) — what a `local-llm` tenant's calls to
  // the in-cluster router carry instead of `Bearer EMPTY`. Secret-box encrypted, write-only, exactly
  // like `license_token_encrypted`. services/tenant-inference.ts owns all three columns.
  inference_token_encrypted: text('inference_token_encrypted'),
  inference_licence_id: uuid('inference_licence_id'),
  inference_provisioned_at: timestamp('inference_provisioned_at', { withTimezone: true }),
  // What workspace creation did, per step, plus the input a retry needs (0101;
  // services/tenant-provisioning.ts owns the shape). `{}` = created before 0101.
  provisioning: jsonb('provisioning').notNull().default(sql`'{}'::jsonb`),
  // Licences bundles CP ensured on this tenant, per bundle key, with licences' answer (0104;
  // services/tenant-licence-bundles.ts owns the shape). `{}` = none requested.
  licence_bundles: jsonb('licence_bundles').notNull().default(sql`'{}'::jsonb`),
  created_at: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

// ---- Tenant invites (0094) ----
// CP-native invitations: an EMAIL bound to (tenant, role), accepted explicitly by a signed-in user
// whose verified email matches. Tenant-scoped RLS; the cross-tenant accept lookup runs as the
// owner. `token_hash` = hex SHA-256 of the emailed token (the token is never stored).
export const tenantInvites = pgTable('tenant_invites', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  tenant_id: uuid('tenant_id')
    .notNull()
    .default(tenantGucDefault)
    .references(() => tenants.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: tenantRoleEnum('role').notNull().default('member'),
  token_hash: text('token_hash').notNull().unique(),
  keycloak_sub: text('keycloak_sub'),
  invited_by: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
  status: text('status')
    .$type<'pending' | 'accepted' | 'revoked' | 'expired'>()
    .notNull()
    .default('pending'),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  accepted_at: timestamp('accepted_at', { withTimezone: true }),
  accepted_by: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
  revoked_at: timestamp('revoked_at', { withTimezone: true }),
  resent_at: timestamp('resent_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type TenantInvite = typeof tenantInvites.$inferSelect;

// Phase 4 / E.1: the CP mirror of a tenant's Keycloak Identity Provider (per-tenant Entra
// OIDC SSO, spec Part 8). Tenant-scoped (RLS, migration 0030) — a tenant_admin manages only
// their own row; Keycloak is the runtime broker. `config` holds the non-secret OIDC block;
// the Entra client_secret lives encrypted in `client_secret_encrypted` (never returned).
export interface IdpOidcConfig {
  /** Entra discovery URL — Keycloak auto-imports authz/token/JWKS/userinfo from it. */
  discovery_url: string;
  /** Entra App Registration "Application (client) ID". */
  client_id: string;
  /** OIDC scopes (default 'openid profile email'). */
  scopes: string;
  /** Trust Entra-verified emails (skip Keycloak re-verification). */
  trust_email: boolean;
}

export const identityProviders = pgTable(
  'identity_providers',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // The Keycloak IdP alias / routing key: 'entra-<slug>'. Derived backend-side from the
    // tenant's own slug — never caller-supplied (Part 8.4).
    alias: text('alias').notNull(),
    display_name: text('display_name').notNull(),
    provider_type: text('provider_type').notNull().default('oidc'),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').$type<IdpOidcConfig>().notNull(),
    // secret-box AES-256-GCM blob; write-only — stripped from every read response.
    client_secret_encrypted: text('client_secret_encrypted'),
    // Part 8.5 per-tenant opt-in: true rejects first-login users with no pre-existing CP
    // account (high-security tenants); default false = JIT-create the brokered user.
    link_only: boolean('link_only').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique('identity_providers_tenant_alias_uq').on(t.tenant_id, t.alias)],
);

// Issuable/revocable API keys for external MCP clients. sha256(raw) only; the raw
// `cp_mcp_<prefix>_<secret>` is shown once. Mirrors agent_sessions' hash pattern.
export const mcpApiKeys = pgTable(
  'mcp_api_keys',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    issued_by: uuid('issued_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    key_prefix: text('key_prefix').notNull(),
    key_hash: text('key_hash').notNull().unique(),
    scopes: jsonb('scopes')
      .$type<string[]>()
      .notNull()
      .default(['tools', 'resources', 'prompts']),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
    expires_at: timestamp('expires_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('mcp_api_keys_tenant_id_idx').on(t.tenant_id)],
);

// Append-only per-call usage ledger (one row per brokered LLM call) for the spend
// dashboards. usage_counters stays the per-user/day CAP ledger.
export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenant_id: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'set null',
    }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    tokens_in: integer('tokens_in').notNull().default(0),
    tokens_out: integer('tokens_out').notNull().default(0),
    cost_usd: numeric('cost_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    /**
     * How `cost_usd` was derived (migration 0053) — 'provider' | 'table' | 'flat', plus
     * 'abort_estimate' (migration 0087) for a stream settled after a caller abort or a
     * mid-stream provider death that had already delivered real text: `tokens_out` there is
     * `estimateTokens(text)`, never a provider-reported or table-priced count.
     *
     * NULL means "priced before this column existed", i.e. under the old flat two-constant
     * estimate. It is deliberately left NULL rather than backfilled to 'flat': every historical
     * row was priced with NO per-call price record, so there is nothing to reconstruct from and
     * asserting a source for them would be a fabrication. A /usage range spanning the cutover
     * therefore mixes two regimes, and this column is what makes that visible instead of silent.
     */
    price_source: text('price_source').$type<'provider' | 'table' | 'flat' | 'abort_estimate'>(),
    /**
     * Optional sub-step label for the call that produced this row (migration 0061) — the same
     * `BrokerCallMeta.stage` the fleet cost emit already carried ('flow-run' | 'agent-chat' |
     * 'content-translation' | …). The value was threaded into `emitCostEvent` long before it was
     * threaded into this INSERT, so the OPTIONAL Redis emit knew a call was background
     * translation and the authoritative billing ledger did not.
     *
     * NULL means "written by a caller that passed no stage, or before this column existed".
     * Deliberately not backfilled, for the same reason `price_source` is not: no historical row
     * recorded one, so there is nothing to reconstruct from. Correlation only — nothing gates on
     * it.
     */
    stage: text('stage'),
    /**
     * TRUE when this ledger row came from work the PLATFORM itself initiated with no human in
     * the loop — today, the translation drainer (migration 0063). The persisted form of
     * `BrokerCallMeta.platformActor`, written by `settleSpend` from the SAME
     * `meta?.platformActor === true` expression that decides the daily-cap exemption and the
     * `usage_counters` split, so the ledger and the counter cannot disagree.
     *
     * ⛔ NOT a correlation label — this one is READ, by all four /usage aggregates in
     * host/usage-metrics.ts, every one of which EXCLUDES it. 0061 split the COUNTER and left the
     * LEDGER whole, so /usage went on billing a named human for 608 platform calls. Read the
     * ⛔ block at the top of host/usage-metrics.ts before changing any of this, including why
     * this column exists rather than a filter on `stage`.
     *
     * NOT NULL DEFAULT false: `NOT NULL_value` is NULL, not TRUE, so a nullable column would make
     * the /usage predicate silently DROP real human rows — failing in the opposite direction from
     * the defect, and just as quietly.
     */
    platform_actor: boolean('platform_actor').notNull().default(false),
    /** Migration 0090. The member's licence at settle time (`member_entitlements.license_id`).
     *  NULL for rows written before 0090 or by a member with no entitlement — never backfilled. */
    license_id: uuid('license_id'),
    /** Migration 0090. licences-service Subject UUID — the cost event's `subject_id` (WHO PAYS). */
    license_subject_id: uuid('license_subject_id'),
    /** Migration 0090. `users.keycloak_sub` of the person who acted — the cost event's `actor_id`.
     *  NULL for platform work (`platform_actor = true`), where no person acted. */
    actor_id: uuid('actor_id'),
    /** Migration 0090. Whose credential paid the provider — `ResolvedChat.credentialSource`. */
    credential_source: text('credential_source').$type<'tenant_byo' | 'platform_managed' | 'none'>(),
    /** Migration 0090. The provider's OWN reported charge (price_source='provider'); NULL otherwise. */
    vendor_cost_usd: numeric('vendor_cost_usd', { precision: 20, scale: 8 }),
    /** Migration 0090. `BrokerCallMeta.correlationId`. */
    correlation_id: text('correlation_id'),
    seed_key: text('seed_key'),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('usage_events_tenant_created_idx').on(t.tenant_id, t.created_at),
    index('usage_events_user_created_idx').on(t.user_id, t.created_at),
    uniqueIndex('usage_events_seed_key_uq').on(t.seed_key).where(sql`${t.seed_key} IS NOT NULL`),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type McpApiKey = typeof mcpApiKeys.$inferSelect;
export type NewMcpApiKey = typeof mcpApiKeys.$inferInsert;
export type UsageEvent = typeof usageEvents.$inferSelect;
export type NewUsageEvent = typeof usageEvents.$inferInsert;

// ---- Controlled onboarding (Phase 4 / C.2a — super_admin half) ----
// Identity is born in Keycloak first (services/keycloak-admin.ts); the local users row
// materialises on approve/invite. These three tables drive the super_admin onboarding
// flow (spec §1.5/§6.3) and are platform-scoped (FK *to* tenants, not scoped *by* one),
// so they sit OUTSIDE the per-tenant RLS that lands in Phase D. See 0027_signup_onboarding.sql.

export const signupApprovals = pgTable(
  'signup_approvals',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    // Set once the user exists in Keycloak (NULL for a self-signup that only notified).
    keycloak_sub: text('keycloak_sub'),
    email: text('email').notNull(),
    name: text('name'),
    // pending | approved | rejected
    status: text('status').notNull().default('pending'),
    // auto-routed from the email domain (email_domain_tenants); NULL for free-mail/unknown.
    matched_tenant_id: uuid('matched_tenant_id').references(() => tenants.id, {
      onDelete: 'set null',
    }),
    // the super_admin's explicit choice at approve time (overrides matched).
    assigned_tenant_id: uuid('assigned_tenant_id').references(() => tenants.id, {
      onDelete: 'set null',
    }),
    // realm role to grant on approve (member | tenant_admin). super_admin is never granted here.
    requested_role: text('requested_role').notNull().default('member'),
    note: text('note'),
    // 0105 — the company the requester named (free text), and where the signup came from:
    // 'web' | 'chat' (server-to-server intake) | 'app' (notify-self) | 'invite' (0120, the
    // super_admin's pre-approved invite, POST /api/signup-approvals/invite). NULL = another writer.
    company: text('company'),
    source: text('source'),
    // 0119 — the applicant's free-text message from the early-access intake (≤2000 chars, CHECKed).
    message: text('message'),
    // 0121 — the requester's language ('ar'|'de'|'en'|'es'|'fr'|'he'|'nl'|'pl', CHECKed); NULL = not
    // told. Written onto the Keycloak user as `locale` at approve, so the set-password email speaks it.
    locale: text('locale'),
    // 0121 — the approve claim (routes/onboarding.ts `claimApproval`): live = someone is approving.
    approving_until: timestamp('approving_until', { withTimezone: true }),
    approving_claim: uuid('approving_claim'),
    // 0122 — a reject's cleanup and its state (services/signup-reject-repair.ts); NULL = nothing to undo.
    reject_repair: jsonb('reject_repair').$type<SignupRejectRepair>(),
    // 0122 — what an `existing`-mode approve did in a customer workspace (a seat, an invite) before it
    // aborted; a reject revokes exactly these.
    approve_effects: jsonb('approve_effects').$type<SignupApproveEffect[]>(),
    // 0106 — the TRUSTED path that admitted the row ('intake' | 'verified_email' | 'turnstile'),
    // NULL = untrusted (never announced singly in Telegram, summarised by the digest instead), and
    // when the digest last counted an untrusted row as new.
    trust: text('trust'),
    digested_at: timestamp('digested_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    decided_at: timestamp('decided_at', { withTimezone: true }),
    decided_by: uuid('decided_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  // The pending-email uniqueness is a partial expression index (lower(email) WHERE
  // status='pending') in the migration — drizzle can't express it here.
  (t) => [index('signup_approvals_status_idx').on(t.status)],
);

export const emailDomainTenants = pgTable(
  'email_domain_tenants',
  {
    domain: text('domain').primaryKey(), // lower-cased bare domain (no '@')
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    auto_assign: boolean('auto_assign').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('email_domain_tenants_tenant_id_idx').on(t.tenant_id)],
);

export const freeEmailProviders = pgTable('free_email_providers', {
  domain: text('domain').primaryKey(), // lower-cased bare domain: gmail.com, outlook.com, …
});

/** 0122 `signup_approvals.reject_repair` — see services/signup-reject-repair.ts. */
export interface SignupRejectRepair {
  /** pending = still to do (the tick retries) · blocked = the workspace is in use (nothing destroyed;
   *  a super_admin decides) · failed = gave up after REJECT_REPAIR_MAX_ATTEMPTS (the tick no longer
   *  retries; listed on the onboarding screen, whose Retry resets it) · done = everything undone ·
   *  resolved_manually = a super_admin closed a `failed` / `blocked` row whose cause is permanent, with
   *  a note (`resolution`); terminal, never retried, not listed. */
  state: 'pending' | 'blocked' | 'failed' | 'done' | 'resolved_manually';
  /** The workspace the signup's approve FOUNDED, when it founded one. */
  tenantId: string | null;
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  /** Machine codes of `lastError` (services/signup-reject-repair.ts REJECT_REPAIR_ERROR_CODES): the
   *  onboarding screen shows per-code guidance. */
  lastErrorCodes?: string[];
  blockers?: string[];
  keycloakIdentity?: string | null;
  /** Set with `resolved_manually`: who closed it, why, and the error it was closed on. */
  resolution?: {
    note: string;
    actorId: string | null;
    actorSub: string;
    at: string;
    priorState: 'failed' | 'blocked';
    attempts: number;
    lastError: string | null;
    lastErrorCodes: string[];
    blockers: string[];
    /** The close left the rejected requester's access live (blocked, or failed on a seat / licence /
     *  IdP / identity / offboard cause) — acknowledged explicitly by the super_admin. */
    leavesLiveAccess?: boolean;
  } | null;
  /** The run lease: the tick, the screen and Telegram never repair the same row at once. */
  claimedUntil?: string | null;
  /** The lease holder's token: every write a run makes is conditional on still holding it. */
  leaseToken?: string | null;
}

/** 0122 `signup_approvals.approve_effects` entry: one thing an `existing`-mode approve did. */
export interface SignupApproveEffect {
  tenantId: string;
  /** The users row this approve SEATED (it was not a live member of `tenantId` before). */
  seatedUserId?: string | null;
  /** The invite this approve created. */
  inviteId?: string | null;
  at: string;
}

export type SignupApproval = typeof signupApprovals.$inferSelect;
export type NewSignupApproval = typeof signupApprovals.$inferInsert;
export type EmailDomainTenant = typeof emailDomainTenants.$inferSelect;
export type NewEmailDomainTenant = typeof emailDomainTenants.$inferInsert;
export type FreeEmailProvider = typeof freeEmailProviders.$inferSelect;
export type NewFreeEmailProvider = typeof freeEmailProviders.$inferInsert;

// ---- Building blocks (Session 1) ----

export const blockCategoryEnum = pgEnum('block_category', [
  'data',
  'ai',
  'logic',
  'output',
  'ui',
]);
export const blockStatusEnum = pgEnum('block_status', [
  'draft',
  'beta',
  'stable',
  'deprecated',
]);
// `language` reserves room for Python (SPEC: TS-only in v1).
export const blockLanguageEnum = pgEnum('block_language', ['typescript']);

export const buildingBlocks = pgTable('building_blocks', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  // Slug is unique PER OWNER, not globally (migration 0037 swapped the column UNIQUE for the
  // building_blocks_slug_owner_uq expression index on (slug, coalesce(tenant_id, zero-uuid))).
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  category: blockCategoryEnum('category').notNull(),
  // Dual ownership (0037): NULL = platform/global (shipped, seeded via runAsSystem), set =
  // tenant-authored. RLS 0028 §4c (read global ∪ own-tenant; write own-tenant only).
  tenant_id: uuid('tenant_id').references(() => tenants.id, {
    onDelete: 'cascade',
  }),
  // Points at the published version shown in the library. Nullable until first
  // publish (the FK is added in the migration after both tables exist).
  current_version_id: uuid('current_version_id'),
  maintainer_id: uuid('maintainer_id').references(() => users.id),
  region: text('region'),
  cost_class: text('cost_class'),
  license: text('license'),
  // Provenance (0038): the reseed-stable natural key of the ontology entity this block was DERIVED
  // from (Phase 3 data blocks). NULL for hand-authored / platform blocks. Drives the palette's
  // "Derived from <entity>" badge + the find-or-version idempotency of the derive route.
  source_entity_key: text('source_entity_key'),
  archived: boolean('archived').notNull().default(false),
  created_at: timestamp('created_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const blockVersions = pgTable(
  'block_versions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    block_id: uuid('block_id')
      .notNull()
      .references(() => buildingBlocks.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    status: blockStatusEnum('status').notNull().default('draft'),
    language: blockLanguageEnum('language').notNull().default('typescript'),
    docs_md: text('docs_md').notNull().default(''),
    // ⛔ BRANDED ON PURPOSE — see blocks/scanned-source.ts. A plain `string` does not type-check
    // here, so no INSERT or UPDATE of a block source can be written without going through
    // `blocks/source-gate.ts`. This is the structural half of the fix; the runtime half (the
    // gate itself) only covers the writers that exist today.
    source_ts: text('source_ts').$type<ScannedSource>().notNull().default(EMPTY_SCANNED_SOURCE),
    descriptor: jsonb('descriptor').$type<BlockDescriptor>().notNull(),
    examples: jsonb('examples').$type<BlockExample[]>().notNull().default([]),
    changelog: text('changelog').notNull().default(''),
    tests_passing: boolean('tests_passing').notNull().default(false),
    usage_count: integer('usage_count').notNull().default(0),
    published_by: uuid('published_by').references(() => users.id),
    published_at: timestamp('published_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [unique('block_versions_block_version_uq').on(t.block_id, t.version)],
);

export type BuildingBlock = typeof buildingBlocks.$inferSelect;
export type NewBuildingBlock = typeof buildingBlocks.$inferInsert;
export type BlockVersion = typeof blockVersions.$inferSelect;
export type NewBlockVersion = typeof blockVersions.$inferInsert;

// ---- Flows (Session 2) ----
// A user's working flow on the Build canvas. The graph ({nodes, edges}) lives
// as JSONB; flows are owner-scoped working documents (no version-history table —
// that's blocks). `solution_id` is reserved for the S5 marketplace link.

export const flowStatusEnum = pgEnum('flow_status', [
  'draft',
  'submitted',
  'archived',
]);

export const flows = pgTable(
  'flows',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    owner_id: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    // Phase D: tenant scope (RLS). Denormalized from the owner's tenant; defaults to the
    // request GUC so the Build canvas insert needs no change.
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    status: flowStatusEnum('status').notNull().default('draft'),
    graph: jsonb('graph').$type<FlowGraph>().notNull(),
    version: text('version').notNull().default('0.1.0'),
    last_saved_at: timestamp('last_saved_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('flows_owner_id_idx').on(t.owner_id),
    index('flows_status_idx').on(t.status),
  ],
);

export type Flow = typeof flows.$inferSelect;
export type NewFlow = typeof flows.$inferInsert;

// ---- Flow runs + usage counters (Session 3) ----
// A `flow_run` is one execution of a flow in the isolated subprocess runner. The
// streamed NDJSON trace is persisted as a JSONB array on completion. Money is
// kept as numeric(12,6) and read back as strings (postgres-js) — never floated.
// `usage_counters` is the per-user/day ledger the LLM broker checks (FOR UPDATE)
// before each brokered call, so the daily-call cap + weekly spend ceiling hold
// under concurrent runs.

export const flowRunStatusEnum = pgEnum('flow_run_status', [
  'running',
  'ok',
  'partial',
  'failed',
]);

export const flowRuns = pgTable(
  'flow_runs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    flow_id: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    // Phase D: tenant scope (RLS). Derived from the run's flow at insert.
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    triggered_by: uuid('triggered_by')
      .notNull()
      .references(() => users.id),
    // The sandbox this run executed in (Session 4). Nullable — pre-S4 runs and
    // runs whose sandbox was later removed keep their history (FK = SET NULL).
    sandbox_id: uuid('sandbox_id').references(() => sandboxes.id, {
      onDelete: 'set null',
    }),
    // The SOLUTION this run was a demo of (0065). Set by `POST /api/runs {solutionId}` — the
    // "Try it" button on a solution page, i.e. literally the live demo. Null for /build draft
    // runs, block tests and every run predating 0065.
    //
    // ⛔ NOT a resurrection of `flows.solution_id`, which 0056 dropped. That one pointed the wrong
    // way down a one-to-many and duplicated `solutions.flow_id`; this is a fact about a RUN that
    // no column carries. `flow_id` cannot substitute — a submitted flow keeps being edited while
    // the published graph is frozen, and one flow can back several solutions. Full reasoning is in
    // the 0065 migration header; read it before deleting this as a repeat offence.
    //
    // ⚠️ Thunk form is REQUIRED: `solutions` is declared far below this table, so a direct
    // reference is a TDZ error at import time.
    solution_id: uuid('solution_id').references(() => solutions.id, {
      onDelete: 'set null',
    }),
    status: flowRunStatusEnum('status').notNull().default('running'),
    trace: jsonb('trace').$type<TraceEvent[]>().notNull().default([]),
    total_ms: integer('total_ms'),
    total_cost_usd: numeric('total_cost_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    tokens_in: integer('tokens_in').notNull().default(0),
    tokens_out: integer('tokens_out').notNull().default(0),
    llm_calls: integer('llm_calls').notNull().default(0),
    idempotency_key: text('idempotency_key'),
    heartbeat_at: timestamp('heartbeat_at', { withTimezone: true }),
    lease_expires_at: timestamp('lease_expires_at', { withTimezone: true }),
    cancel_requested_at: timestamp('cancel_requested_at', { withTimezone: true }),
    trace_truncated: boolean('trace_truncated').notNull().default(false),
    event_count: integer('event_count').notNull().default(0),
    seed_key: text('seed_key'),
    started_at: timestamp('started_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('flow_runs_flow_id_idx').on(t.flow_id),
    index('flow_runs_triggered_by_idx').on(t.triggered_by),
    index('flow_runs_sandbox_id_idx').on(t.sandbox_id),
    // Serves `host/solution-demo.ts` demoMsForSolutions: DISTINCT ON (solution_id) … ORDER BY
    // solution_id, finished_at DESC. Partial on the SUCCESS status — 'ok', not 'succeeded'; the
    // enum above has no such value — because that predicate is in the query and excludes the
    // running/failed bulk. 'partial' is out on purpose: a half-failed run is not a demo time.
    index('flow_runs_solution_finished_idx')
      .on(t.solution_id, t.finished_at.desc())
      .where(sql`${t.status} = 'ok'`),
  ],
);

export const usageCounters = pgTable(
  'usage_counters',
  {
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // Phase D: tenant scope (RLS). Derived from the user's tenant; defaults to the request GUC.
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    day: date('day').notNull(),
    llm_calls: integer('llm_calls').notNull().default(0),
    /**
     * LLM calls made by PLATFORM background work (the translation drainer, and anything like it
     * that follows), attributed to this (tenant, user, day) row. Migration 0061.
     *
     * ⛔ SEPARATE FROM `llm_calls` ON PURPOSE — the two columns answer different questions and
     * overloading one for both was the defect. `llm_calls` is a GOVERNANCE QUOTA: it is what
     * `spend.daily_llm_cap` bounds, and it belongs to a named human. This is a LOAD METER: it
     * records what the platform caused and is EXEMPT from that cap. Prod symptom of the overload:
     * 608 pending `translation_jobs`, all attributed to one user, whose counter sat at
     * llm_calls = 50 against a cap of 50 with spend_usd = 0.000000 — a $0 backlog permanently
     * blocked by a per-person CALL cap.
     *
     * Both the reserve AND the release path in host/llm-broker.ts move THIS column for a platform
     * call and never `llm_calls`; that symmetry is what stops a failed platform call from handing
     * back (i.e. stealing) a slot the human never used.
     *
     * `spend_usd` is deliberately NOT split — the weekly spend ceiling still bounds platform work.
     * Read `llm_calls` alone for "how much is this employee using" (routes/sandboxes.ts:56); read
     * the SUM of both for fleet load (host/ops-metrics.ts:65). That asymmetry is intentional.
     */
    platform_llm_calls: integer('platform_llm_calls').notNull().default(0),
    spend_usd: numeric('spend_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    reserved_spend_usd: numeric('reserved_spend_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
  },
  // The natural key is (tenant_id, user_id, day) — created by 0058 as a UNIQUE INDEX, and since
  // 0059 dropped the pre-tenancy `usage_counters_user_day_uq (user_id, day)` it is the ONLY one.
  //
  // ⛔ Do NOT "tidy" this back to `unique('usage_counters_user_day_uq').on(t.user_id, t.day)`.
  // That pre-tenancy key (0004) disagreed with the tenant_id column (0028) and silently
  // disabled the daily LLM call cap and the weekly spend ceiling for any user metering under
  // more than one tenant on the same UTC day: RLS hid the other tenant's row, the upsert
  // conflicted on it invisibly, and the broker fell back to a zero counter.
  //
  // Re-adding it is not merely a regression, it is UNAPPLIABLE: 0059 is a one-way door, and once
  // any user has metered under two tenants on one UTC day the narrow constraint can never be
  // created again without destroying real metering data. This declaration and the live schema
  // agree as of 0059 (they were knowingly out of step for the single release in between, when
  // both keys existed — see 0058's header for why that overlap was required).
  (t) => [uniqueIndex('usage_counters_tenant_user_day_uq').on(t.tenant_id, t.user_id, t.day)],
);

export type FlowRun = typeof flowRuns.$inferSelect;
export type NewFlowRun = typeof flowRuns.$inferInsert;
export type UsageCounter = typeof usageCounters.$inferSelect;
export type NewUsageCounter = typeof usageCounters.$inferInsert;

export const flowRunEvents = pgTable(
  'flow_run_events',
  {
    run_id: uuid('run_id')
      .notNull()
      .references(() => flowRuns.id, { onDelete: 'cascade' }),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    seq: integer('seq').notNull(),
    event: jsonb('event').$type<TraceEvent>().notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.run_id, t.seq] }),
    index('flow_run_events_tenant_run_seq_idx').on(t.tenant_id, t.run_id, t.seq),
  ],
);

export type FlowRunEvent = typeof flowRunEvents.$inferSelect;
export type NewFlowRunEvent = typeof flowRunEvents.$inferInsert;

// ---- Sandboxes (Session 4) ----
// A sandbox is a persistent per-user execution context (the demo: "every employee
// gets a personal sandbox"). It's lazily provisioned on first run and transitioned
// by the run path: idle ⇄ running → error (last run failed); idle/error → suspended
// (manual pause or the idle-sweep). A suspended sandbox blocks that user's runs
// (host/run-controller.ts). cost_today / llm_calls_today / project are NOT stored —
// they are derived live (usage_counters per owner+day; latest flow_run → flow.name)
// so there is one source of truth and they reset naturally each day.

export const sandboxStatusEnum = pgEnum('sandbox_status', [
  'running',
  'idle',
  'suspended',
  'error',
]);

export const sandboxes = pgTable(
  'sandboxes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    owner_id: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    // Phase D: tenant scope (RLS). Denormalized from the owner's tenant; defaults to the request GUC.
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    slug: text('slug').notNull().unique(),
    label: text('label').notNull().default(''),
    project: text('project'),
    status: sandboxStatusEnum('status').notNull().default('idle'),
    suspension_reason: text('suspension_reason'),
    is_primary: boolean('is_primary').notNull().default(false),
    seed_key: text('seed_key'),
    region: text('region').notNull().default('eu-west'),
    mem_cap_mb: integer('mem_cap_mb').notNull().default(1200),
    last_active_at: timestamp('last_active_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('sandboxes_owner_id_idx').on(t.owner_id),
    index('sandboxes_status_idx').on(t.status),
  ],
);

export type Sandbox = typeof sandboxes.$inferSelect;
export type NewSandbox = typeof sandboxes.$inferInsert;

// ---- Marketplace (Session 5) ----
// The Discover half: challenges (the Challenge leaderboard) → solutions (the Solution leaderboard, built on a flow)
// → votes (one upvote per user per target) → weekly_winners. Plus comments for the
// challenge-detail discussion. `votes_count` is a DENORMALIZED leaderboard counter:
// it carries a seeded fidelity baseline and is bumped ±1 by the live vote toggle in
// a transaction; the `votes` table holds only genuine per-user rows (no fabrication).

export const challengeStatusEnum = pgEnum('challenge_status', [
  'voting',
  'solution_phase',
  'closed',
]);
export const solutionStatusEnum = pgEnum('solution_status', [
  'draft',
  'voting',
  'shipping',
  'archived',
]);
export const voteTargetTypeEnum = pgEnum('vote_target_type', [
  'challenge',
  'solution',
]);

export interface ChallengeMetrics {
  timeSavedPerWeek?: string;
  affectedStaff?: string;
  backlogReduction?: string;
}

export const challenges = pgTable(
  'challenges',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    business_impact: text('business_impact').notNull().default(''),
    work_area: text('work_area').notNull(),
    submitter_id: uuid('submitter_id')
      .notNull()
      .references(() => users.id),
    status: challengeStatusEnum('status').notNull().default('voting'),
    // Phase 3.6: the org the challenge was raised in. Denormalized from the submitter's
    // active tenant at creation; scopes which datasets the creator can tag + which the
    // builder/agent resolve for it (the submitter no longer needs to own that data).
    // Scoped by value (no FK), consistent with datasets.tenant_id.
    tenant_id: uuid('tenant_id').notNull(),
    week: text('week').notNull().default(''),
    // 0107: the competition PERIOD this row belongs to. `week` keeps the period KEY for one more
    // release (then dropped); ordering and gates read `period_start`. kind 'off' = filed while the
    // cycle cadence was off (never stale); NULL = legacy unfiled row. A DB trigger derives both from
    // `week` when a writer sets only `week`.
    period_kind: text('period_kind').$type<PeriodRowKind>(),
    period_start: timestamp('period_start', { withTimezone: true }),
    metrics: jsonb('metrics').$type<ChallengeMetrics>().notNull().default({}),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    code: text('code'),
    votes_count: integer('votes_count').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('challenges_status_idx').on(t.status),
    index('challenges_submitter_id_idx').on(t.submitter_id),
    index('challenges_work_area_idx').on(t.work_area),
    index('challenges_tenant_id_idx').on(t.tenant_id),
    // `code` (the CH-nnn display badge) is a PER-TENANT running number, so it must be unique
    // per tenant and not globally — two orgs may both hold CH-12. Partial so the historical
    // code-less rows (nothing but the seeds ever set a code before 0047) stay legal. This is
    // what makes the allocator's max+1 in routes/challenges.ts safe under concurrent submits:
    // the loser of the race gets a 23505 and retries instead of silently duplicating a badge.
    uniqueIndex('challenges_tenant_code_key')
      .on(t.tenant_id, t.code)
      .where(sql`code IS NOT NULL`),
  ],
);

// Phase 3.0 (Pillar A): which datasets a challenge is about, as marked by its creator,
// with an optional free-text note. dataset_slug (not an FK to datasets.id) matches the
// slug-addressed app; resolved owner-scoped at write time. Composite PK = idempotent link.
export const challengeDatasets = pgTable(
  'challenge_datasets',
  {
    challenge_id: uuid('challenge_id')
      .notNull()
      .references(() => challenges.id, { onDelete: 'cascade' }),
    dataset_slug: text('dataset_slug').notNull(),
    note: text('note').notNull().default(''),
    added_by: uuid('added_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.challenge_id, t.dataset_slug] }),
    index('challenge_datasets_challenge_id_idx').on(t.challenge_id),
  ],
);

// W8/P2 (0111): the types of information (ontology entities) a challenge's creator links DIRECTLY.
// A link belongs to the challenge, never to the ontology. Strict tenant RLS (see the migration).
export const challengeEntities = pgTable(
  'challenge_entities',
  {
    challenge_id: uuid('challenge_id')
      .notNull()
      .references(() => challenges.id, { onDelete: 'cascade' }),
    entity_id: uuid('entity_id')
      .notNull()
      .references(() => ontologyEntities.id, { onDelete: 'cascade' }),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ name: 'challenge_entities_pk', columns: [t.challenge_id, t.entity_id] }),
    index('challenge_entities_tenant_idx').on(t.tenant_id),
    index('challenge_entities_entity_idx').on(t.entity_id),
  ],
);

// W8/P5 (0113): member requests about a challenge's information — "missing information" or a few
// uploaded example records — held for an approver. A request never writes the ontology or a dataset.
// Strict tenant RLS on both tables (see the migration).
export const informationRequests = pgTable(
  'information_requests',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    challenge_id: uuid('challenge_id')
      .notNull()
      .references(() => challenges.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'missing_information' | 'example_records'>().notNull(),
    status: text('status').$type<'pending' | 'approved' | 'rejected'>().notNull().default('pending'),
    name: text('name').notNull(),
    description: text('description'),
    field_names: jsonb('field_names').$type<string[]>().notNull().default([]),
    file_name: text('file_name'),
    columns: jsonb('columns').$type<DatasetColumn[]>(),
    row_count: integer('row_count'),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    reviewed_by: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
    review_note: text('review_note'),
  },
  (t) => [
    index('information_requests_tenant_status_idx').on(t.tenant_id, t.status),
    index('information_requests_challenge_idx').on(t.challenge_id),
  ],
);

export const informationRequestRows = pgTable(
  'information_request_rows',
  {
    request_id: uuid('request_id')
      .notNull()
      .references(() => informationRequests.id, { onDelete: 'cascade' }),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ name: 'information_request_rows_pk', columns: [t.request_id, t.idx] }),
    index('information_request_rows_tenant_idx').on(t.tenant_id),
  ],
);

export const solutions = pgTable(
  'solutions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    challenge_id: uuid('challenge_id')
      .notNull()
      .references(() => challenges.id, { onDelete: 'cascade' }),
    // Phase D: tenant scope (RLS). Scoped-by-value (no FK), like challenges.tenant_id —
    // the challenge's tenant; defaults to the request GUC.
    tenant_id: uuid('tenant_id').notNull().default(tenantGucDefault),
    title: text('title').notNull(),
    author_id: uuid('author_id')
      .notNull()
      .references(() => users.id),
    // The built flow on the Build canvas (S2). SET NULL on delete keeps the
    // solution's leaderboard history if its flow is later archived/removed.
    flow_id: uuid('flow_id').references(() => flows.id, { onDelete: 'set null' }),
    // Immutable publication boundary. The source flow remains editable; runs from a solution use
    // this graph and its pinned, validated block manifest.
    published_graph: jsonb('published_graph').$type<FlowGraph>(),
    published_manifest: jsonb('published_manifest')
      .$type<Array<{ nodeId: string; blockId: string; versionId: string; slug: string; descriptor: BlockDescriptor }>>()
      .notNull()
      .default([]),
    published_hash: text('published_hash'),
    published_at: timestamp('published_at', { withTimezone: true }),
    published_by: uuid('published_by').references(() => users.id),
    status: solutionStatusEnum('status').notNull().default('voting'),
    week: text('week').notNull().default(''),
    // 0107: the competition PERIOD this row belongs to. `week` keeps the period KEY for one more
    // release (then dropped); ordering and gates read `period_start`. kind 'off' = filed while the
    // cycle cadence was off (never stale); NULL = legacy unfiled row. A DB trigger derives both from
    // `week` when a writer sets only `week`.
    period_kind: text('period_kind').$type<PeriodRowKind>(),
    period_start: timestamp('period_start', { withTimezone: true }),
    // ⛔ BOTH COLUMNS BELOW ARE DEAD TO THE APPLICATION AND DELIBERATELY NOT DROPPED.
    //
    // Nothing reads or writes either one: no route selects them, no seeder sets them, the create
    // schema rejects them (`.strict()`), and no screen renders them. They are left in place because
    // migrations run at pod STARTUP with 2-4 replicas and drizzle emits explicit column lists — a
    // DROP in the same release the code stopped reading them 42703s every `select().from(solutions)`
    // on the old replicas for the whole rollout window. That is this repo's own stated rule; see
    // `0056_drop_flows_solution_id.sql:8-13`. A later, separate release may drop them.
    //
    // `build_time_minutes` — HOW LONG THE SOLUTION TOOK TO BUILD. Removed from the product because
    // there was never an honest source for it. Every solution created through Build → Submit had it
    // NULL (`frontend/src/routes/build/entry.ts` never sent it), and /winner rendered the resulting
    // literal '—' as a hero stat on the demo's payoff screen. The obvious derivation is wrong:
    // `flows.created_at → submit` reports 30,240 minutes for a three-week-old canvas someone opened
    // once. A human-entered field is unverifiable self-report collected on the most fragile step of
    // the loop.
    //   IF THE CONCEPT RETURNS, IT MUST COME FROM `flow_snapshots`: first snapshot of the flow →
    //   `solutions.published_at` is the only interval in this schema that brackets real authoring
    //   activity rather than the age of a row. Bring it back with that evidence, or not at all —
    //   do not reinvent it from `created_at`.
    //
    // `demo_seconds` — SUPERSEDED, not unsourceable. It was a seeded constant. The real figure is
    // measured: `flow_runs.solution_id` (0065) + `host/solution-demo.ts`, shipped as `demoMs`.
    build_time_minutes: integer('build_time_minutes'),
    demo_seconds: integer('demo_seconds'),
    blocks_used: jsonb('blocks_used').$type<string[]>().notNull().default([]),
    votes_count: integer('votes_count').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('solutions_challenge_id_idx').on(t.challenge_id),
    index('solutions_author_id_idx').on(t.author_id),
    index('solutions_status_idx').on(t.status),
  ],
);

export const votes = pgTable(
  'votes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id),
    // Phase D: tenant scope (RLS). The voter's tenant (= the target's tenant under RLS);
    // scoped-by-value (no FK), defaults to the request GUC so castVote needs no change.
    tenant_id: uuid('tenant_id').notNull().default(tenantGucDefault),
    target_type: voteTargetTypeEnum('target_type').notNull(),
    // Loose UUID — points at challenges OR solutions per target_type (no single FK).
    target_id: uuid('target_id').notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('votes_user_target_uq').on(t.user_id, t.target_type, t.target_id),
    index('votes_target_idx').on(t.target_type, t.target_id),
  ],
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    challenge_id: uuid('challenge_id')
      .notNull()
      .references(() => challenges.id, { onDelete: 'cascade' }),
    // Phase D: tenant scope (RLS). The challenge's tenant; scoped-by-value, defaults to the request GUC.
    tenant_id: uuid('tenant_id').notNull().default(tenantGucDefault),
    author_id: uuid('author_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('comments_challenge_id_idx').on(t.challenge_id)],
);

export interface WeeklyWinnerStats {
  totalVotesCast?: number;
  solutionsSubmitted?: number;
  firstTimeBuilders?: number;
  crossDomain?: number;
}

export const weeklyWinners = pgTable(
  'weekly_winners',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    // Per-tenant winner artifact: uniqueness is per (tenant_id, week), NOT global week —
    // otherwise only one tenant could ever own a given ISO week and every other tenant's
    // winner insert silently no-ops (the bug that left "This week's winner" blank). See
    // migration 0041.
    week: text('week').notNull(),
    // 0107: the competition PERIOD this row belongs to. `week` keeps the period KEY for one more
    // release (then dropped); ordering and gates read `period_start`. kind 'off' = filed while the
    // cycle cadence was off (never stale); NULL = legacy unfiled row. A DB trigger derives both from
    // `week` when a writer sets only `week`.
    period_kind: text('period_kind').$type<PeriodRowKind>(),
    period_start: timestamp('period_start', { withTimezone: true }),
    // Phase D: tenant scope (RLS). The winning solution's tenant; scoped-by-value. The cycle
    // scheduler (no request GUC) sets this explicitly from the solution.
    tenant_id: uuid('tenant_id').notNull().default(tenantGucDefault),
    solution_id: uuid('solution_id')
      .notNull()
      .references(() => solutions.id, { onDelete: 'cascade' }),
    challenge_id: uuid('challenge_id').references(() => challenges.id, {
      onDelete: 'set null',
    }),
    stats: jsonb('stats').$type<WeeklyWinnerStats>(),
    announced_at: timestamp('announced_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [unique('weekly_winners_tenant_week_key').on(t.tenant_id, t.week)],
);

export type Challenge = typeof challenges.$inferSelect;
export type NewChallenge = typeof challenges.$inferInsert;
export type ChallengeDataset = typeof challengeDatasets.$inferSelect;
export type NewChallengeDataset = typeof challengeDatasets.$inferInsert;
export type Solution = typeof solutions.$inferSelect;
export type NewSolution = typeof solutions.$inferInsert;
export type Vote = typeof votes.$inferSelect;
export type NewVote = typeof votes.$inferInsert;
export type Comment = typeof comments.$inferSelect;
export type NewComment = typeof comments.$inferInsert;
export type WeeklyWinner = typeof weeklyWinners.$inferSelect;
export type NewWeeklyWinner = typeof weeklyWinners.$inferInsert;

// ---- Marketplace cycle engine (Phase 2-E) ----
// One row per ISO week = the cycle's live phase + boundary timestamps AND its
// idempotency claims (UNIQUE(week) open-claim, closed_at IS NULL close-claim).
// weekly_winners stays the durable winner artifact; this is the PROCESS state that
// advances voting → solution_phase → closed over time (host/cycle-service.ts).
export const marketplaceCyclePhaseEnum = pgEnum('marketplace_cycle_phase', [
  'voting',
  'solution_phase',
  'closed',
]);

export const marketplaceCycles = pgTable('marketplace_cycles', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  // 0110: the tenant whose cycle this is. 0114 deleted the pre-0110 platform (NULL-tenant) rows and
  // made it NOT NULL: every cycle row belongs to exactly one tenant.
  tenant_id: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  // 0107: the period KEY for every kind ('2026-W41' | '2026-10' | '2026'); mirrors `period_key` for
  // one more release, then dropped. No longer unique on its own — (period_kind, period_key) is.
  week: text('week').notNull(),
  period_kind: text('period_kind').$type<PeriodKind>().notNull(),
  period_key: text('period_key').notNull(),
  period_start: timestamp('period_start', { withTimezone: true }).notNull(),
  phase: marketplaceCyclePhaseEnum('phase').notNull().default('voting'),
  voting_ends_at: timestamp('voting_ends_at', { withTimezone: true }).notNull(),
  solution_ends_at: timestamp('solution_ends_at', { withTimezone: true }).notNull(),
  closes_at: timestamp('closes_at', { withTimezone: true }).notNull(),
  // the at-most-once close guard (set when the week is closed + a winner selected).
  closed_at: timestamp('closed_at', { withTimezone: true }),
  winner_solution_id: uuid('winner_solution_id').references(() => solutions.id, {
    onDelete: 'set null',
  }),
  stats: jsonb('stats').$type<WeeklyWinnerStats>(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('marketplace_cycles_phase_idx').on(t.phase),
  // 0110: per tenant (0114 dropped NULLS NOT DISTINCT — every key column is NOT NULL now).
  uniqueIndex('marketplace_cycles_tenant_period_key_uq').on(t.tenant_id, t.period_kind, t.period_key),
  uniqueIndex('marketplace_cycles_tenant_period_start_uq').on(t.tenant_id, t.period_kind, t.period_start),
]);

export type MarketplaceCycle = typeof marketplaceCycles.$inferSelect;
export type NewMarketplaceCycle = typeof marketplaceCycles.$inferInsert;

// 0110: a tenant's OWN voting-cycle cadence (overrides the platform `cycle.cadence` policy; no row =
// inherit). `effective_from` + `previous_value`: a pending switch, exactly like `policies` (0107).
export const tenantCycleCadence = pgTable('tenant_cycle_cadence', {
  tenant_id: uuid('tenant_id')
    .primaryKey()
    .default(sql`app_current_tenant_uuid()`)
    .references(() => tenants.id, { onDelete: 'cascade' }),
  value: text('value').$type<'off' | PeriodKind>().notNull(),
  effective_from: timestamp('effective_from', { withTimezone: true }),
  previous_value: text('previous_value').$type<'off' | PeriodKind>(),
  updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  // 0112: the row only CARRIES a pending return to the platform default (PATCH {value: null}); once
  // `effective_from` has passed (or with none) the tenant inherits as if it had no row.
  follows_platform: boolean('follows_platform').notNull().default(false),
});
export type TenantCycleCadence = typeof tenantCycleCadence.$inferSelect;

// 0110: the append-only history of a tenant's cadence switches (the catch-up replays it).
export const tenantCycleCadenceChanges = pgTable(
  'tenant_cycle_cadence_changes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenant_id: uuid('tenant_id')
      .notNull()
      .default(sql`app_current_tenant_uuid()`)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    old_value: text('old_value'),
    new_value: text('new_value').notNull(),
    effective_from: timestamp('effective_from', { withTimezone: true }),
    actor_id: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // 0112: this entry is a return to the platform default — the platform trail applies again after it.
    follows_platform: boolean('follows_platform').notNull().default(false),
  },
  (t) => [index('tenant_cycle_cadence_changes_tenant_idx').on(t.tenant_id, t.created_at, t.id)],
);

// ---- Platform governance triad (Session 6) ----
// The Operate half's last three screens, turned into a live enforcement spine:
//   policies        — the editable governance rails AND the live source of truth
//                     the runtime reads (LLM broker daily-cap/weekly-ceiling/model
//                     allowlist, idle-sweep watchdog, the run-gate's network/PII/
//                     code-exec checks, and the pipeline promotion gate). Editing a
//                     row changes runtime behaviour — config.governance.* is only the
//                     code-level fallback when a row is absent.
//   policy_changes  — old→new diff per edit (governance "Recent changes").
//   pipeline_items  — production-pipeline kanban cards; promotion gated by promotion.*.
//   audit_log       — append-only feed; every mutating action writes one row. Seeded
//                     historical rows are a labelled fidelity baseline (S4/S5 posture).

// `value` is the live value per control; `control` discriminates the widget/zod shape.
// `map` (0045) is a string→string dictionary with a FIXED key set, edited as one labelled field
// per key. Added for `models.work_tiers` so the small/medium/large model ids are operator-editable
// on the Governance screen instead of being a code constant behind a deploy.
export type PolicyControl = 'toggle' | 'number' | 'select' | 'list' | 'map';
export type PolicyValue = boolean | number | string | string[] | Record<string, string>;

export const policies = pgTable(
  'policies',
  {
    key: text('key').primaryKey(),
    category: text('category').notNull(),
    label: text('label').notNull(),
    description: text('description').notNull().default(''),
    control: text('control').$type<PolicyControl>().notNull(),
    value: jsonb('value').$type<PolicyValue>().notNull(),
    options: jsonb('options').$type<string[]>(),
    unit: text('unit'),
    enabled: boolean('enabled').notNull().default(true),
    sort: integer('sort').notNull().default(0),
    // 0107: a value that takes effect LATER. Before `effective_from` the `previous_value` is in
    // force (used by `cycle.cadence`: a change starts at the next period boundary). NULL = the
    // value is in force now.
    effective_from: timestamp('effective_from', { withTimezone: true }),
    previous_value: jsonb('previous_value').$type<PolicyValue>(),
    updated_by: uuid('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('policies_category_idx').on(t.category)],
);

export const policyChanges = pgTable(
  'policy_changes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    policy_key: text('policy_key')
      .notNull()
      .references(() => policies.key, { onDelete: 'cascade' }),
    old_value: jsonb('old_value').$type<PolicyValue>(),
    new_value: jsonb('new_value').$type<PolicyValue>(),
    // 0107: when `new_value` takes over (NULL = at once). `cycle.cadence` switches at the next period
    // boundary, and the catch-up replays this trail to know what was in force at every past boundary.
    effective_from: timestamp('effective_from', { withTimezone: true }),
    changed_by: uuid('changed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('policy_changes_created_at_idx').on(t.created_at),
    index('policy_changes_policy_key_idx').on(t.policy_key),
  ],
);

export const pipelineStageEnum = pgEnum('pipeline_stage', [
  'review',
  'hardening',
  'staging',
  'production',
]);

export interface PipelineProgress {
  day?: number;
  ofDays?: number;
}

export const pipelineItems = pgTable(
  'pipeline_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    solution_id: uuid('solution_id').references(() => solutions.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    author_id: uuid('author_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    stage: pipelineStageEnum('stage').notNull().default('review'),
    week: text('week'),
    // 0107: the competition PERIOD this row belongs to. `week` keeps the period KEY for one more
    // release (then dropped); ordering and gates read `period_start`. kind 'off' = filed while the
    // cycle cadence was off (never stale); NULL = legacy unfiled row. A DB trigger derives both from
    // `week` when a writer sets only `week`.
    period_kind: text('period_kind').$type<PeriodRowKind>(),
    period_start: timestamp('period_start', { withTimezone: true }),
    rollout_pct: integer('rollout_pct').notNull().default(0),
    progress: jsonb('progress').$type<PipelineProgress>(),
    reviewed: boolean('reviewed').notNull().default(false),
    reviewer_count: integer('reviewer_count').notNull().default(0),
    // Who marked the card reviewed (the acting admin) + when — for card attribution.
    reviewed_by: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
    featured: boolean('featured').notNull().default(false),
    live: boolean('live').notNull().default(false),
    position: integer('position').notNull().default(0),
    // first time the card entered Production (→ avgTimeToLiveDays); set once.
    live_at: timestamp('live_at', { withTimezone: true }),
    // the card was pulled back from Production (→ rolledBack count).
    rolled_back_at: timestamp('rolled_back_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('pipeline_items_stage_idx').on(t.stage),
    index('pipeline_items_solution_id_idx').on(t.solution_id),
  ],
);

// pipeline_reviews (0062) — one row = one DISTINCT human approved one pipeline card, once.
//
// THE AUTHORITY for the Production promotion gate. routes/pipeline.ts counts THESE ROWS inside the
// same transaction as the stage write; it never reads `pipelineItems.reviewer_count`. Those four
// columns above (`reviewed` / `reviewer_count` / `reviewed_by` / `reviewed_at`) survive as DISPLAY
// CACHES only, so cache drift is a rendering bug and can never become an authorization bypass.
//
// Before 0062 the gate compared against `body.reviewerCount`, a client-supplied literal (the
// frontend hard-coded `reviewerCount: 2`), so one click by one admin satisfied "2 reviewers
// required" — and, because nothing could ever write a 3, setting the policy to 3 deadlocked
// promotion permanently with a fully green test suite.
//
// Shaped after `votes` + host/vote-service.ts castVote, which solves the identical
// one-action-per-user-per-target problem: same UNIQUE natural key, same onConflictDoNothing inside
// a transaction, same self-action guard before the transaction. The UNIQUE constraint IS the
// distinct-reviewer guarantee — a DATABASE constraint, so one admin clicking twice cannot
// increment the count even under concurrency.
//
// `reviewer_id` has NO onDelete on purpose (see the 0062 header + 0050's tombstone rationale): an
// approval is authorship and must survive the reviewer being offboarded. CASCADE would silently
// retro-un-approve every card an ex-reviewer had approved.
//
// DELIBERATELY OUTSIDE RLS, mirroring its parent `pipelineItems` (0028_rls.sql:24) — a
// platform-global super_admin surface with no tenant column and no tenant it could belong to.
export const pipelineReviews = pgTable(
  'pipeline_reviews',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    pipeline_item_id: uuid('pipeline_item_id')
      .notNull()
      .references(() => pipelineItems.id, { onDelete: 'cascade' }),
    reviewer_id: uuid('reviewer_id')
      .notNull()
      .references(() => users.id),
    // How the review was recorded ('app' = a click in the pipeline UI). Exists so a future non-UI
    // approval path is distinguishable from a human click without a schema change.
    source: text('source').notNull().default('app'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('pipeline_reviews_item_reviewer_uq').on(t.pipeline_item_id, t.reviewer_id),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    actor_id: uuid('actor_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    // 0083. Deliberately NO `.references(() => tenants.id)`: an audit row must outlive the tenant
    // it describes, and an FK would either cascade the trail away on offboarding or block the
    // offboarding. Nullable because platform actions genuinely have no tenant.
    tenant_id: uuid('tenant_id'),
    action: text('action').notNull(),
    category: text('category').notNull().default('system'),
    target_type: text('target_type').notNull().default(''),
    target_id: text('target_id'),
    result: text('result'),
    result_tone: text('result_tone').$type<'ok' | 'warn' | 'error'>(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('audit_log_created_at_idx').on(t.created_at),
    index('audit_log_category_idx').on(t.category),
    index('audit_log_actor_id_idx').on(t.actor_id),
  ],
);

// ---- Phase 2-F: compliance export ----
// Durable record of each nightly audit-log export + the day-claim concurrency guard.
// UNIQUE(export_date) lets a run claim its day via INSERT … ON CONFLICT DO NOTHING.
export const auditExportStatusEnum = pgEnum('audit_export_status', [
  'running',
  'success',
  'error',
]);
export const auditExportTriggerEnum = pgEnum('audit_export_trigger', [
  'scheduler',
  'manual',
]);

export const auditExports = pgTable(
  'audit_exports',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    export_date: date('export_date').notNull().unique(),
    status: auditExportStatusEnum('status').notNull().default('running'),
    row_count: integer('row_count').notNull().default(0),
    object_key: text('object_key'),
    bucket: text('bucket'),
    sha256: text('sha256'),
    bytes: integer('bytes').notNull().default(0),
    error: text('error'),
    triggered_by: auditExportTriggerEnum('triggered_by').notNull().default('scheduler'),
    actor_id: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    started_at: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finished_at: timestamp('finished_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('audit_exports_export_date_idx').on(t.export_date)],
);

export type Policy = typeof policies.$inferSelect;
export type NewPolicy = typeof policies.$inferInsert;
export type PolicyChange = typeof policyChanges.$inferSelect;
export type NewPolicyChange = typeof policyChanges.$inferInsert;
export type PipelineItem = typeof pipelineItems.$inferSelect;
export type NewPipelineItem = typeof pipelineItems.$inferInsert;
export type PipelineReview = typeof pipelineReviews.$inferSelect;
export type NewPipelineReview = typeof pipelineReviews.$inferInsert;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
export type AuditExport = typeof auditExports.$inferSelect;
export type NewAuditExport = typeof auditExports.$inferInsert;

// ---- AI substrate (Retrofit task — SPEC §5A / §4) ----
// The chat is the primary authoring surface: a TS-native, provider-agnostic agent
// drives the Build canvas. This session is STUB-FIRST — the tables + agent loop +
// MCP server + two-token auth are real, but the provider is a deterministic stub
// (real adapters = Session 7; i18n wiring of content_translations = the §5B session).
//   tenant_llm_settings — per-tenant provider/model/BYO-key (selected at runtime S7).
//   agent_sessions      — Keycloak→agent two-token model (refresh-hash + replay chain).
//   mcp_prompts(+vers)  — DB-backed MCP prompts; the agent's system prompt lives here.
//   (mcp_tools(+vers) was dropped in 0052 — never had an executor; customer-authored
//    extensions are building_blocks + block_versions, which do.)
//   chat_sessions/_messages — one flow-bound thread + its Anthropic-shape transcript.
//   flow_snapshots      — every AI/manual graph mutation → undo + auditable diff.
//   content_translations— i18n side-table (created, UNWIRED this session).

export const llmProviderEnum = pgEnum('llm_provider', [
  'anthropic',
  'openai',
  'openai_compatible',
]);
export const chatRoleEnum = pgEnum('chat_role', ['user', 'assistant', 'tool']);
export const snapshotSourceEnum = pgEnum('snapshot_source', ['manual', 'ai']);

export const tenantLlmSettings = pgTable('tenant_llm_settings', {
  // The owning workspace, and this table's PRIMARY KEY — one settings row per workspace.
  // `uuid` since migration 0084 (was `text` from 0008/0028); RLS policy
  // `tenant_llm_settings_tenant` is `tenant_id = app_current_tenant_uuid()`.
  tenant_id: uuid('tenant_id').primaryKey(),
  provider: llmProviderEnum('provider').notNull().default('anthropic'),
  model: text('model').notNull().default(''),
  base_url: text('base_url'),
  // Sampling temperature (0–2). NULL = the provider/adapter default. Merged into the request
  // body by ai/llm/select.ts. First-class so the tenant-admin UI + backfill are typed.
  temperature: real('temperature'),
  params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
  api_key_encrypted: text('api_key_encrypted'),
  /**
   * Migration 0091. WHOSE credential pays the provider — DECLARED on the row.
   *
   * ⛔ THIS EXISTS BECAUSE `api_key_encrypted != null` WAS BEING USED AS THE ANSWER, AND IT IS A
   * DIFFERENT QUESTION. `ai/llm/select.ts` computed `tenantKey ? 'tenant_byo' : 'platform_managed'`,
   * and `host/metering-emit.ts:246` turns that into the billing `byo` flag — so key PRESENCE was
   * deciding whether the customer is charged a BYO markup. `host/budget-service.ts` stores the
   * PLATFORM's own OpenRouter welcome-budget key in this very column, so that cohort was billed a
   * markup on money the platform had already spent for them.
   *
   * ⚠️ NOT the same axis as `provider`/`base_url`, which name the VENDOR. A tenant on
   * `openai_compatible` + OpenRouter can be any of the four states below.
   */
  credential_source: text('credential_source')
    .$type<'tenant_byo' | 'platform_managed' | 'trial_managed' | 'local'>()
    .notNull()
    .default('platform_managed'),
  updated_at: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Phase D: tenant scope (RLS). Derived from the user's tenant at session mint.
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    // Only the sha256 hash of the refresh token is stored (raw returned once).
    refresh_token_hash: text('refresh_token_hash').notNull().unique(),
    // Set to the successor on rotation; a replay of a consumed token revokes the
    // whole forward chain (replay protection — mirror fr).
    replaced_by: uuid('replaced_by'),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('agent_sessions_user_id_idx').on(t.user_id)],
);

// An MCP prompt argument (the prompts/get argument schema entry).
export interface McpPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export const mcpPrompts = pgTable(
  'mcp_prompts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    name: text('name').notNull(),
    locale: text('locale').notNull().default('en'),
    // NULL = a GLOBAL prompt, visible to every workspace (RLS `mcp_prompts_read` is
    // `tenant_id IS NULL OR tenant_id = app_current_tenant_uuid()`). Nullable ON PURPOSE:
    // as of 0084 every shipped prompt is global, so a NOT NULL here would hide all of
    // them from every tenant. `uuid` since 0084 (was `text` from 0008).
    tenant_id: uuid('tenant_id'),
    template: text('template').notNull(),
    arguments: jsonb('arguments')
      .$type<McpPromptArgument[]>()
      .notNull()
      .default([]),
    current_version: integer('current_version').notNull().default(1),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  // Uniqueness is enforced by an expression index in the migration:
  // (name, locale, coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)) —
  // drizzle can't express coalesce here. 0084 rebuilt it against the zero-uuid sentinel
  // this repo already uses in 0018/0019/0023/0037/0043; before that it coalesced to ''.
  // The sentinel is load-bearing: NULL <> NULL, so without it two GLOBAL prompts could
  // share a (name, locale).
  (t) => [index('mcp_prompts_name_locale_idx').on(t.name, t.locale)],
);

export const mcpPromptVersions = pgTable(
  'mcp_prompt_versions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    prompt_id: uuid('prompt_id')
      .notNull()
      .references(() => mcpPrompts.id, { onDelete: 'cascade' }),
    version_number: integer('version_number').notNull(),
    template: text('template').notNull(),
    arguments: jsonb('arguments')
      .$type<McpPromptArgument[]>()
      .notNull()
      .default([]),
    created_by: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('mcp_prompt_versions_prompt_id_idx').on(t.prompt_id)],
);

export const chatSessions = pgTable(
  'chat_sessions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    flow_id: uuid('flow_id').references(() => flows.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Phase D: tenant scope (RLS). The flow's tenant (or the user's); defaults to the request GUC.
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    title: text('title').notNull().default(''),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('chat_sessions_flow_id_idx').on(t.flow_id),
    index('chat_sessions_user_id_idx').on(t.user_id),
    // 0067 — one copilot thread per (user, flow). `ai/agent.ts` ensureChatSession's docstring
    // has always said "(user, flow)" while its LOOKUP filtered on flow_id alone, so the first
    // person to chat about a flow owned the only thread it would ever have and a second reader
    // of a published flow was handed their transcript. This is that sentence in a place the code
    // cannot silently disagree with, and it is the arbiter for ensureChatSession's ON CONFLICT.
    // ⛔ NOT `nullsNotDistinct`: block-authoring / fix-loop sessions have flow_id NULL and open
    // one row per sitting — collapsing them into a single thread per user is a data-loss bug.
    uniqueIndex('chat_sessions_user_flow_key').on(t.user_id, t.flow_id),
  ],
);

// One message in a chat transcript. `content` is the Anthropic-shape content-block
// array (text + tool_use / tool_result). Role 'tool' carries a tool_result block.
export interface ChatContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string; // tool_use id
  name?: string; // tool name
  input?: unknown; // tool_use input
  tool_use_id?: string; // tool_result → the tool_use it answers
  content?: unknown; // tool_result payload
  is_error?: boolean;
}

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    session_id: uuid('session_id')
      .notNull()
      .references(() => chatSessions.id, { onDelete: 'cascade' }),
    role: chatRoleEnum('role').notNull(),
    content: jsonb('content')
      .$type<{ blocks: ChatContentBlock[]; replay?: string }>()
      .notNull()
      .default({ blocks: [] }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('chat_messages_session_id_created_at_idx').on(
      t.session_id,
      t.created_at,
    ),
  ],
);

// ---- Cross-replica rendezvous for frontend (edit) tool results (migration 0070) ----
// The copilot dispatches a frontend tool by holding an in-memory promise on ONE pod and awaiting the
// browser's POST — which arrives on a NEW connection and therefore may land on any of the 2-4
// replicas. When it lands on the wrong one, this row IS the handoff: the receiving pod writes it and
// NOTIFYs `cp_agent_tool_result` with the key only (the payload can be a whole block draft, and
// pg_notify caps at 8000 bytes), and the owning pod claims it with `DELETE … RETURNING`, which is
// atomic and therefore exactly-once. The SAME-POD path never touches this table.
// Owned entirely by ai/tool-rendezvous.ts. See migrations/0070 for the full rationale.
export const agentToolResults = pgTable(
  'agent_tool_results',
  {
    turn_id: uuid('turn_id').notNull(),
    // TEXT, not uuid: the provider's tool_use id (`toolu_…` / `call_…`), not ours.
    call_id: text('call_id').notNull(),
    // In the CLAIM predicate, not merely stored: it is what preserves resolveFrontendTool's
    // deliberate "unknown key and wrong owner are indistinguishable" property across replicas.
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    payload: jsonb('payload').$type<{ ok: boolean; output?: unknown; error?: string }>().notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    // Written explicitly by the producer. The claim ignores expired rows, so a result can never be
    // delivered into a later turn; the reaper on the write path uses it as its predicate.
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // user_id is IN the key, matching migration 0070. Without it a token holder who learned someone
    // else's (turn_id, call_id) reports first, takes the slot, and the owner's genuine report is
    // silently dropped by ON CONFLICT DO NOTHING — an undetectable 30s denial. Keep the three in
    // step with 0070's PRIMARY KEY and the insert's conflict target, or idempotence quietly changes.
    primaryKey({ columns: [t.turn_id, t.call_id, t.user_id] }),
    index('agent_tool_results_expires_idx').on(t.expires_at),
  ],
);

export type AgentToolResult = typeof agentToolResults.$inferSelect;
export type NewAgentToolResult = typeof agentToolResults.$inferInsert;

export const flowSnapshots = pgTable(
  'flow_snapshots',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    flow_id: uuid('flow_id')
      .notNull()
      .references(() => flows.id, { onDelete: 'cascade' }),
    // Phase D: tenant scope (RLS). Derived from the flow at snapshot time.
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    graph: jsonb('graph').$type<FlowGraph>().notNull(),
    source: snapshotSourceEnum('source').notNull().default('manual'),
    // ⛔ `summary` IS THE ENGLISH PROSE AND IT STAYS, BYTE FOR BYTE (0071). It is what an MCP/LLM
    // client reads back through `EditResult`, and it is the permanent fallback for every row
    // written before 0071 — those have `summary_code IS NULL` forever, since there is no backfill.
    summary: text('summary').notNull().default(''),
    // 0071: which of the nine templates wrote the sentence, so the BROWSER can render it in the
    // reader's language (frontend/src/lib/i18n/flow-summary-label.ts). NULL for a pre-0071 row and
    // for a manual checkpoint whose text the USER typed — that text is rendered verbatim.
    summary_code: text('summary_code'),
    // The machine fields that sentence interpolates. `Record<string, unknown>` rather than the
    // `FlowSummaryParams` alias from ../ai/flow-edit-service on purpose: that module imports
    // ./client, which imports this file, so naming the type here would close an import cycle. Same
    // call `notifications.data` makes for `BudgetAlertData`.
    summary_params: jsonb('summary_params').$type<Record<string, unknown>>(),
    created_by: uuid('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('flow_snapshots_flow_id_created_at_idx').on(t.flow_id, t.created_at)],
);

export const contentTranslations = pgTable(
  'content_translations',
  {
    entity_type: text('entity_type').notNull(),
    entity_id: text('entity_id').notNull(),
    locale: text('locale').notNull(),
    field: text('field').notNull(),
    value: text('value').notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('content_translations_pk').on(
      t.entity_type,
      t.entity_id,
      t.locale,
      t.field,
    ),
  ],
);

// Phase 2-G: the translation queue. One row per translatable cell × target locale;
// the drainer (host/translation-scheduler.ts) translates each via the metered broker
// and UPSERTs the result into content_translations. UNIQUE(entity_type,entity_id,
// field,target_locale) + source_hash give idempotent, edit-aware enqueue. See
// migrations/0017_translation_jobs.sql.
export const translationJobs = pgTable(
  'translation_jobs',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    entity_type: text('entity_type').notNull(),
    entity_id: text('entity_id').notNull(),
    field: text('field').notNull(),
    target_locale: text('target_locale').notNull(),
    source_text: text('source_text').notNull(),
    source_hash: text('source_hash').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    requested_by: uuid('requested_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('translation_jobs_cell').on(
      t.entity_type,
      t.entity_id,
      t.field,
      t.target_locale,
    ),
    index('translation_jobs_status_idx').on(t.status),
  ],
);

export type TenantLlmSettings = typeof tenantLlmSettings.$inferSelect;
export type NewTenantLlmSettings = typeof tenantLlmSettings.$inferInsert;
export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;
export type McpPrompt = typeof mcpPrompts.$inferSelect;
export type NewMcpPrompt = typeof mcpPrompts.$inferInsert;
export type ChatSession = typeof chatSessions.$inferSelect;
export type NewChatSession = typeof chatSessions.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
export type FlowSnapshot = typeof flowSnapshots.$inferSelect;
export type NewFlowSnapshot = typeof flowSnapshots.$inferInsert;
export type TranslationJob = typeof translationJobs.$inferSelect;
export type NewTranslationJob = typeof translationJobs.$inferInsert;

// ---- Datasets / test-data subsystem (Phase 2.0) ----
// Developer-supplied test data (CSV / Excel / SQL-paste / text / JSON) so blocks +
// the agent can run over realistic inputs instead of the 5 baked mock-data kinds.
// `datasets` holds the typed schema + metadata; `dataset_rows` holds one JSONB row
// object per `idx` (house "store as JSONB" pattern; separated so a preview/list never
// drags the full payload). Phase 3.6: tenant-scoped — shared within an org (IT
// provisions, every member browses); `owner_id` is audit-only. `sandbox_id` NULL =
// tenant-shared, set = scoped to that sandbox. Soft-deleted via status='error'
// is NOT used — deletes cascade dataset_rows; status tracks the parse lifecycle.

export const datasetSourceTypeEnum = pgEnum('dataset_source_type', [
  'csv',
  'xlsx',
  'sql',
  'text',
  'json',
  // Phase 2-A live connectors (read-only): a connector materializes one of these
  // into dataset_rows on refresh; the runner still only ever sees cached rows.
  'postgres',
  'storage',
  'http',
]);
export const datasetStatusEnum = pgEnum('dataset_status', [
  'ready',
  'parsing',
  'error',
  // Phase 2-A: a connector is mid-refresh (host fetching the live source).
  'syncing',
]);

export const datasets = pgTable(
  'datasets',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    owner_id: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    // Phase 3.6: the ownership/visibility axis. Test data is shared within an org, so
    // every read scopes by tenant_id and slugs are unique within it. owner_id above is
    // kept only as audit (who uploaded). `uuid` since migration 0084 (was `text`, which
    // is why the comment here used to say "holds the tenant uuid as text"). Scoped by
    // value with NO foreign key to `tenants`, matching the `challenges.tenant_id` house
    // pattern — adding one decides what a tenant deletion does to datasets, which is a
    // separate decision. RLS policy `datasets_tenant` is
    // `tenant_id = app_current_tenant_uuid()`.
    tenant_id: uuid('tenant_id').notNull(),
    // NULL = shared across the owner's sandboxes; set = scoped to one sandbox.
    sandbox_id: uuid('sandbox_id').references(() => sandboxes.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    source_type: datasetSourceTypeEnum('source_type').notNull(),
    columns: jsonb('columns').$type<DatasetColumn[]>().notNull().default([]),
    row_count: integer('row_count').notNull().default(0),
    size_bytes: integer('size_bytes').notNull().default(0),
    status: datasetStatusEnum('status').notNull().default('ready'),
    error: text('error'),
    // ---- Phase 2-A live connector fields (NULL for hand-uploaded datasets) ----
    // Secret connection config (postgres url+query / storage creds / http headers),
    // AES-256-GCM via secret-box; decrypted only on the host at refresh time.
    connection_config_encrypted: text('connection_config_encrypted'),
    // Non-secret connector metadata (host, bucket, query preview) — safe to return;
    // the egress host is derived from here. Shape = ConnectorMeta.
    connection_meta: jsonb('connection_meta').$type<ConnectorMeta>(),
    // How the connector is refreshed: 'webhook' | 'pg_notify' | 'none'.
    event_source: text('event_source').$type<ConnectorEventSource>(),
    // Per-connector secret that authenticates the event ingress (hashed-compare).
    event_secret_encrypted: text('event_secret_encrypted'),
    last_synced_at: timestamp('last_synced_at', { withTimezone: true }),
    // ⛔ ENGLISH PROSE, PERSISTED — and NOT deprecated. `"<code>: <err.message>"`, written by
    // datasets/connector-refresh.ts. It is the correct output for the MCP reader
    // (ai/mcp/tools.ts `describe_data`), the fallback for a code whose catalog entry needs a field
    // `sync_error_detail` does not carry, and the ONLY thing every pre-0074 row has. See 0074.
    sync_error: text('sync_error'),
    // The wire code behind `sync_error`, so the BROWSER writes the sentence
    // (frontend/src/lib/api/error-message.ts `syncErrorText`). Plain text, not an enum: HttpError
    // codes are an open string space and a code must be storable one deploy before the browser
    // knows the word for it. NULL = pre-0074 row → render `sync_error` raw.
    sync_error_code: text('sync_error_code'),
    // Machine tokens for that sentence — `{ host, reason }`. Unvalidated by the DB on purpose; the
    // reader treats every field as possibly absent. See 0074.
    sync_error_detail: jsonb('sync_error_detail').$type<DatasetSyncErrorDetail>(),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('datasets_tenant_slug_uq').on(t.tenant_id, t.slug),
    index('datasets_owner_id_idx').on(t.owner_id),
    index('datasets_tenant_id_idx').on(t.tenant_id),
    index('datasets_sandbox_id_idx').on(t.sandbox_id),
  ],
);

export const datasetRows = pgTable(
  'dataset_rows',
  {
    dataset_id: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    idx: integer('idx').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [unique('dataset_rows_pk').on(t.dataset_id, t.idx)],
);

export type Dataset = typeof datasets.$inferSelect;
export type NewDataset = typeof datasets.$inferInsert;
export type DatasetRow = typeof datasetRows.$inferSelect;
export type NewDatasetRow = typeof datasetRows.$inferInsert;

// ---- Block tests (Phase 2-B) ----
// Runnable, dataset-backed test cases that gate publish. `block_tests` is the
// suite (block-scoped, persists across versions); `block_test_results` holds the
// last result per (version, test) so the publish gate can check the specific
// version's source. `block_versions.tests_passing` is the cached rollup (true
// only when every enabled test has a `pass` result for that version).

export const assertModeEnum = pgEnum('block_assert_mode', ['exact', 'subset']);
export const blockTestStatusEnum = pgEnum('block_test_status', [
  'pass',
  'fail',
  'error',
]);

export const blockTests = pgTable(
  'block_tests',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    block_id: uuid('block_id')
      .notNull()
      .references(() => buildingBlocks.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    // Node config: values for the block's declared inputs (dataset-typed = slug).
    inputs: jsonb('inputs').$type<Record<string, unknown>>().notNull().default({}),
    // Extra ctx.dataset(slug) fixtures not wired through a dataset-typed input.
    datasets: text('datasets').array().notNull().default([]),
    // Expected outputs object (NULL/ignored when expect_error).
    expected: jsonb('expected').$type<Record<string, unknown>>(),
    assert_mode: assertModeEnum('assert_mode').notNull().default('subset'),
    expect_error: boolean('expect_error').notNull().default(false),
    expected_error_kind: text('expected_error_kind'),
    enabled: boolean('enabled').notNull().default(true),
    created_by: uuid('created_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('block_tests_block_name_uq').on(t.block_id, t.name),
    index('block_tests_block_id_idx').on(t.block_id),
  ],
);

export const blockTestResults = pgTable(
  'block_test_results',
  {
    version_id: uuid('version_id')
      .notNull()
      .references(() => blockVersions.id, { onDelete: 'cascade' }),
    test_id: uuid('test_id')
      .notNull()
      .references(() => blockTests.id, { onDelete: 'cascade' }),
    status: blockTestStatusEnum('status').notNull(),
    actual: jsonb('actual').$type<Record<string, unknown>>(),
    /** ⛔ ENGLISH PROSE, AND NOT DEPRECATED — see `BlockErrorRule` in db/trace-types.ts for the
     *  three readers that need it. Every row written before 0072 has this and nothing else. */
    error: text('error'),
    /** 0072. The product rule behind `error`, so the BROWSER can write the sentence
     *  (frontend/src/lib/i18n/block-test-error-label.ts). NULL = written before 0072, or the text
     *  is the block AUTHOR'S own and must be rendered raw. */
    error_rule: text('error_rule').$type<BlockErrorRule>(),
    /** 0072. Machine tokens for `error_rule`'s sentence. Deliberately unvalidated by the database:
     *  the shape belongs to the producer (`BlockErrorDetail`), and the reader treats every field as
     *  possibly absent. */
    error_detail: jsonb('error_detail').$type<BlockErrorDetail>(),
    duration_ms: integer('duration_ms').notNull().default(0),
    run_at: timestamp('run_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique('block_test_results_pk').on(t.version_id, t.test_id)],
);

export type BlockTest = typeof blockTests.$inferSelect;
export type NewBlockTest = typeof blockTests.$inferInsert;
export type BlockTestResult = typeof blockTestResults.$inferSelect;
export type NewBlockTestResult = typeof blockTestResults.$inferInsert;

// ---- Block templates (starter-scaffold catalog) ----
// A seeded, read-only catalog of professional STARTER blocks per category (logic / ui / ai /
// data). Picking one in the block editor pre-fills a NEW block's descriptor + source skeleton +
// docs (the editor authors new blocks; reuse of existing blocks is stimulated elsewhere). LOGIC
// templates additionally carry a PKO/PDDL-inspired formal structure (preconditions /
// postconditions / steps) so reusable logic is captured in a standard, vertical-taggable shape —
// fully self-contained (NO dependency on the procedure_management service; CP ships on-prem).
// Authored as native JSON (src/templates/seed/) and loaded via seed-templates.ts. Dual ownership
// mirrors building_blocks (0037): tenant_id NULL = shipped global; set = tenant-authored (reserved
// for a later "save as template"). Natural-key uniqueness is a coalesce() expression index in the
// migration (0043) so the JSON seed upserts idempotently.

export interface TemplateStep {
  label: string;
  detail: string;
}

export const blockTemplates = pgTable(
  'block_templates',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    category: blockCategoryEnum('category').notNull(),
    // NULL ⇒ generic (cross-vertical); set ⇒ an industry/vertical overlay (e.g. 'insurance').
    domain: text('domain'),
    name: text('name').notNull(),
    label: text('label').notNull(),
    description: text('description').notNull().default(''),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    descriptor: jsonb('descriptor').$type<BlockDescriptor>().notNull(),
    // Branded like `block_versions.source_ts`. A template is not executed as a template — it is
    // COPIED into a draft, which is gated on its own — but it is still a place a `source_ts` is
    // saved, and "banned at save time" is a claim about saving.
    source_ts: text('source_ts').$type<ScannedSource>().notNull().default(EMPTY_SCANNED_SOURCE),
    docs_md: text('docs_md').notNull().default(''),
    // PKO/PDDL-inspired formal structure (most meaningful for logic templates).
    preconditions: jsonb('preconditions').$type<string[]>().notNull().default([]),
    postconditions: jsonb('postconditions').$type<string[]>().notNull().default([]),
    steps: jsonb('steps').$type<TemplateStep[]>().notNull().default([]),
    // Dual ownership (mirrors building_blocks): NULL = shipped global; set = tenant-authored.
    tenant_id: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    hidden: boolean('hidden').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('block_templates_cat_domain_idx').on(t.category, t.domain)],
);

export type BlockTemplate = typeof blockTemplates.$inferSelect;
export type NewBlockTemplate = typeof blockTemplates.$inferInsert;

// ---- Flow templates (0108) ----
// Whole flows a reader can start from on /build. tenant_id NULL = platform starter (seeded from
// src/templates/flow-seed/ by seed_key, or saved by a super_admin); set = an organisation template.
// RLS mirrors block_templates: read global + own tenant, write own tenant only. `graph` is copied
// into a new draft on use (fresh ids, blocks re-bound by slug) — see flow-templates/service.ts.
// The partial unique index on seed_key (platform rows only) lives in the migration.
export const flowTemplates = pgTable(
  'flow_templates',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenant_id: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
    seed_key: text('seed_key'),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').notNull().default(''),
    graph: jsonb('graph').$type<FlowGraph>().notNull(),
    block_slugs: text('block_slugs').array().notNull().default(sql`'{}'::text[]`),
    source_flow_id: uuid('source_flow_id'),
    source_solution_id: uuid('source_solution_id'),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    archived_at: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('flow_templates_tenant_idx').on(t.tenant_id)],
);

export type FlowTemplate = typeof flowTemplates.$inferSelect;
export type NewFlowTemplate = typeof flowTemplates.$inferInsert;

// ---- Industry × department ontology (Phase 3.2 — Pillar B) ----
// A lightweight, declarative semantic map of company data objects — entities with
// typed attributes + relations — authored as native JSON (src/ontology/seed/) and
// loaded here. NO reasoner. The matrix engine (ontology-service.ts) composes the
// effective ontology for a (industry, department) from three layers:
//   generic base(dept) ⊕ industryOverlay(industry) ⊕ specialization(industry, dept).
// `scope` discriminates which layer a row belongs to; `tenant_id` NULL = the shipped
// global ontology (per-tenant overrides reuse these tables with tenant_id set — 3.5).
// Natural-key uniqueness is a coalesce() expression index in the migration (drizzle
// can't express it), so the JSON seed upserts idempotently.

export const ontologyScopeEnum = pgEnum('ontology_scope', [
  'generic',
  'industry',
  'industry_dept',
]);

export const ontologyEntities = pgTable(
  'ontology_entities',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    scope: ontologyScopeEnum('scope').notNull(),
    // NULL for generic-scope rows; set for industry / industry_dept rows.
    industry: text('industry'),
    // NULL for industry-overlay rows; set for generic + industry_dept rows.
    department: text('department'),
    name: text('name').notNull(),
    label: text('label').notNull(),
    synonyms: jsonb('synonyms').$type<string[]>().notNull().default([]),
    description: text('description'),
    tenant_id: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'cascade',
    }),
    // Phase 3.7: only meaningful on a tenant row — when true the row is a TOMBSTONE that
    // hides the global entity of the same natural key from this tenant's compiled graph.
    hidden: boolean('hidden').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('ontology_entities_scope_idx').on(t.scope, t.industry, t.department)],
);

export const ontologyAttributes = pgTable(
  'ontology_attributes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    entity_id: uuid('entity_id')
      .notNull()
      .references(() => ontologyEntities.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(),
    synonyms: jsonb('synonyms').$type<string[]>().notNull().default([]),
    pii: boolean('pii').notNull().default(false),
    description: text('description'),
  },
  (t) => [
    unique('ontology_attributes_entity_name_uq').on(t.entity_id, t.name),
    index('ontology_attributes_entity_id_idx').on(t.entity_id),
  ],
);

export const ontologyRelations = pgTable(
  'ontology_relations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    from_entity: uuid('from_entity')
      .notNull()
      .references(() => ontologyEntities.id, { onDelete: 'cascade' }),
    to_entity: uuid('to_entity')
      .notNull()
      .references(() => ontologyEntities.id, { onDelete: 'cascade' }),
    predicate: text('predicate').notNull(),
    label: text('label').notNull().default(''),
    cardinality: text('cardinality').notNull().default(''),
    // NULL = shipped global edge; set = a tenant's override/extension (3.5). Edge
    // uniqueness coalesces this in a migration expression index (drizzle can't express
    // it), so a tenant edge can coexist with the global one of the same (from,to,pred).
    tenant_id: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'cascade',
    }),
  },
  (t) => [
    index('ontology_relations_from_idx').on(t.from_entity),
    index('ontology_relations_to_idx').on(t.to_entity),
    index('ontology_relations_tenant_id_idx').on(t.tenant_id),
  ],
);

export type OntologyEntity = typeof ontologyEntities.$inferSelect;
export type NewOntologyEntity = typeof ontologyEntities.$inferInsert;
export type OntologyAttribute = typeof ontologyAttributes.$inferSelect;
export type NewOntologyAttribute = typeof ontologyAttributes.$inferInsert;
export type OntologyRelation = typeof ontologyRelations.$inferSelect;
export type NewOntologyRelation = typeof ontologyRelations.$inferInsert;

// ---- Dataset → ontology mapping bridge (Phase 3.3 — Pillar A ↔ B) ----
// One row per (dataset, ontology entity): a column→attribute map binding a dataset's
// columns to ontology concepts, so the agent (3.4) reasons about MEANING + relations,
// not just types. Proposals are source='auto'/confirmed=false (heuristic or LLM); a
// human confirm flips to source='human'/confirmed=true. industry/department denormalize
// the compiled cell the mapping was authored against. tenant_id NULL = global (per-
// tenant overrides reuse this table — 3.5). Natural-key uniqueness is a coalesce()
// expression index in the migration so upserts are idempotent. See 0019_dataset_mappings.sql.

export const mappingSourceEnum = pgEnum('mapping_source', ['auto', 'human']);

export const datasetMappings = pgTable(
  'dataset_mappings',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    dataset_id: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    entity_id: uuid('entity_id')
      .notNull()
      .references(() => ontologyEntities.id, { onDelete: 'cascade' }),
    industry: text('industry').notNull(),
    department: text('department').notNull(),
    // { datasetColumn: attributeName }
    column_map: jsonb('column_map').$type<Record<string, string>>().notNull().default({}),
    confidence: real('confidence').notNull().default(0),
    source: mappingSourceEnum('source').notNull().default('auto'),
    confirmed: boolean('confirmed').notNull().default(false),
    tenant_id: uuid('tenant_id').references(() => tenants.id, {
      onDelete: 'cascade',
    }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('dataset_mappings_dataset_id_idx').on(t.dataset_id),
    index('dataset_mappings_entity_id_idx').on(t.entity_id),
  ],
);

export type DatasetMapping = typeof datasetMappings.$inferSelect;
export type NewDatasetMapping = typeof datasetMappings.$inferInsert;

// ---- Ontology entity → test data binding (ontology-data-blocks Phase 1) ----
// Pins a tenant dataset as the canonical TEST DATA for an ontology entity (one PRIMARY per
// entity per tenant). Reuses datasets/dataset_rows + the 3.3 dataset_mappings.column_map
// projection (mapping_id, nullable). A data-type block (Phase 3) is derived from the entity +
// its primary sample. Tenant-scoped (RLS 4a — migration 0036). Resolve by entityKey natural
// key (sample-service), NOT raw uuid — compiled entity ids churn on tenant override / DB reset.

export const ontologyEntitySamples = pgTable(
  'ontology_entity_samples',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    entity_id: uuid('entity_id')
      .notNull()
      .references(() => ontologyEntities.id, { onDelete: 'cascade' }),
    dataset_id: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    // The 3.3 column→attribute projection to apply before validation/derivation. NULL = verbatim.
    mapping_id: uuid('mapping_id').references(() => datasetMappings.id, {
      onDelete: 'set null',
    }),
    is_primary: boolean('is_primary').notNull().default(false),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('ontology_entity_samples_entity_dataset_tenant_uq').on(
      t.entity_id,
      t.dataset_id,
      t.tenant_id,
    ),
    index('ontology_entity_samples_entity_idx').on(t.entity_id, t.tenant_id),
    index('ontology_entity_samples_dataset_idx').on(t.dataset_id),
  ],
);

export type OntologyEntitySample = typeof ontologyEntitySamples.$inferSelect;
export type NewOntologyEntitySample = typeof ontologyEntitySamples.$inferInsert;

// ---- Solution-to-delivery (Phase 5 / 5A) ----
// A tenant_admin "Forward to delivery" pushes a CP solution into the customer's own backlog
// (Jira / Azure DevOps — the productized primary) or, for internal testing, an fr draft project
// request. 5A is the scaffolding: the per-tenant connector config + the per-attempt delivery
// ledger. Both tenant-scoped (RLS, migration 0032). Dispatch (the adapters + POST /forward) is
// 5B/5C/5D. See SPEC-PHASE5-solution-to-delivery.md Parts 3 / 4.1 / 6.

export const deliveryTargetKindEnum = pgEnum('delivery_target_kind', [
  'jira',
  'azure_devops',
  'fr',
]);
export const deliveryStatusEnum = pgEnum('delivery_status', [
  'pending',
  'sent',
  'created',
  'draft_created',
  'approved',
  'promoted',
  'rejected',
  'failed',
]);

// A tenant's configured external backlog connector. Credentials (Jira {email,apiToken} /
// ADO {pat} / fr {licenseToken}) live encrypted in `credentials_encrypted` (secret-box, like
// tenant_llm_settings.api_key_encrypted) — write-only, never returned by a read endpoint.
export const deliveryTargets = pgTable(
  'delivery_targets',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    // Phase D: tenant scope (RLS). Defaults to the request GUC; FK hard-scopes to a real tenant.
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    kind: deliveryTargetKindEnum('kind').notNull(),
    name: text('name').notNull(),
    base_url: text('base_url'),
    project_key: text('project_key'),
    default_item_type: text('default_item_type'),
    config: jsonb('config').$type<DeliveryTargetConfig>().notNull().default({}),
    // secret-box AES-256-GCM blob; write-only — stripped from every read response.
    credentials_encrypted: text('credentials_encrypted'),
    enabled: boolean('enabled').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('delivery_targets_tenant_name_uq').on(t.tenant_id, t.name),
    index('delivery_targets_tenant_id_idx').on(t.tenant_id),
  ],
);

// One row per "Forward to delivery" attempt (both targets). 5A ships the table (zero rows);
// 5B's dispatch writes it. The canonical payload (Part 3) is persisted as JSONB.
export const solutionDeliveries = pgTable(
  'solution_deliveries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    solution_id: uuid('solution_id')
      .notNull()
      .references(() => solutions.id, { onDelete: 'cascade' }),
    // null allowed (ad-hoc fr default); SET NULL keeps history if the connector config is removed.
    target_id: uuid('target_id').references(() => deliveryTargets.id, {
      onDelete: 'set null',
    }),
    target_kind: deliveryTargetKindEnum('target_kind').notNull(),
    initiated_by: uuid('initiated_by')
      .notNull()
      .references(() => users.id),
    status: deliveryStatusEnum('status').notNull().default('pending'),
    external_ref: text('external_ref'),
    external_url: text('external_url'),
    fr_project_id: text('fr_project_id'),
    payload: jsonb('payload').$type<DeliveryPayload>().notNull(),
    response: jsonb('response').$type<Record<string, unknown>>(),
    error: text('error'),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('solution_deliveries_solution_id_idx').on(t.solution_id),
    index('solution_deliveries_tenant_id_idx').on(t.tenant_id),
  ],
);

export type DeliveryTarget = typeof deliveryTargets.$inferSelect;
export type NewDeliveryTarget = typeof deliveryTargets.$inferInsert;
export type SolutionDelivery = typeof solutionDeliveries.$inferSelect;
export type NewSolutionDelivery = typeof solutionDeliveries.$inferInsert;

// ---- Tenant LLM welcome budget + in-app notifications (migration 0044) ----

/**
 * The PLATFORM's own inference-router credential (0100): one row, id = 1. Held by the licences
 * service tenant `INFERENCE_PLATFORM_TENANT_ID` (svc-commonpractice), never the nil `default-anon`
 * tenant inference-router drops cost events for. Written only by services/tenant-inference.ts.
 */
export const platformInferenceState = pgTable('platform_inference_state', {
  id: smallint('id').primaryKey().default(1),
  holder_tenant_id: uuid('holder_tenant_id'),
  token_encrypted: text('token_encrypted'),
  licence_id: uuid('licence_id'),
  provisioned_at: timestamp('provisioned_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  next_attempt_at: timestamp('next_attempt_at', { withTimezone: true }),
  last_error: text('last_error'),
  revoke_pending: uuid('revoke_pending').array().notNull().default(sql`'{}'::uuid[]`),
  op_id: uuid('op_id'),
  op_until: timestamp('op_until', { withTimezone: true }),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * A super-admin-granted starting LLM budget for a tenant.
 *
 * The dollar cap does NOT live here — it lives on an OpenRouter *provisioned API key*
 * (`POST /api/v1/keys` with `limit` and `limit_reset: null`), so OpenRouter enforces it at the
 * source and a runaway tenant cannot overspend the grant even if CP is down. This row is CP's
 * record of that key plus a mirror of OpenRouter's own usage counters, refreshed by the budget
 * scheduler. OpenRouter's numbers are authoritative: `usage_events.cost_usd` is priced from a flat
 * per-token rate (host/llm-broker.ts) and cannot match real per-model spend.
 */
export const tenantLlmBudgets = pgTable(
  'tenant_llm_budgets',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    provider: text('provider').notNull().default('openrouter'),
    /** OpenRouter's key `hash` — the handle for GET/PATCH/DELETE /api/v1/keys/{hash}. */
    or_key_hash: text('or_key_hash'),
    /** The key itself, secret-box encrypted. OpenRouter returns it exactly once, on create. */
    or_key_encrypted: text('or_key_encrypted'),
    limit_usd: numeric('limit_usd', { precision: 12, scale: 2 }).notNull(),
    usage_usd: numeric('usage_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    limit_remaining_usd: numeric('limit_remaining_usd', { precision: 12, scale: 6 }),
    /** active = live · exhausted = OpenRouter refusing · replaced = tenant brought their own key. */
    status: text('status').notNull().default('active'),
    /** Highest percentage already alerted on (0 | 75 | 90 | 100) — monotonic, alert-once. */
    alerted_threshold: smallint('alerted_threshold').notNull().default(0),
    last_synced_at: timestamp('last_synced_at', { withTimezone: true }),
    created_by: uuid('created_by'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('tenant_llm_budgets_tenant_id_idx').on(t.tenant_id)],
);

/** In-app notification. `user_id` NULL = addressed to the whole tenant. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    user_id: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    severity: text('severity').notNull().default('info'),
    /** ⚠️ ENGLISH PROSE, and NOT dead (0066). The browser composes the sentence itself from
     *  `kind` + `data`; these two are what it renders when `data` is absent — which is the case
     *  for every row written before 0066, permanently, and for any row an old pod writes during a
     *  roll. See migrations/0066_notifications_data.sql and frontend/src/lib/i18n/notification-label.ts. */
    title: text('title').notNull(),
    body: text('body'),
    href: text('href'),
    /** Machine fields the reader's browser turns into words (0066). Deliberately untyped at the
     *  column level: `notifications` is generic across alert kinds, so the SHAPE belongs to the
     *  producer — `budget-service.ts` exports `BudgetAlertData` for the one kind that exists. */
    data: jsonb('data').$type<Record<string, unknown>>(),
    read_at: timestamp('read_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('notifications_tenant_created_idx').on(t.tenant_id, t.created_at)],
);

/**
 * Per-reader read receipts (migration 0068). Read is a fact about a (notification, reader) PAIR,
 * not about the row: a tenant-wide notification (`notifications.user_id IS NULL`) — which is the
 * only shape CP's one production writer emits — is read by several people independently, and
 * `notifications.read_at` could not record that. Presence of a row here means that user has
 * dismissed that notification.
 *
 * Written only by host/notification-service.ts, which binds `user_id` to the authenticated caller,
 * never to a request parameter. The composite PK is the idempotence: the optimistic panel and the
 * 60s poll can race to the same key and the loser is a no-op, not a double count.
 */
export const notificationReads = pgTable(
  'notification_reads',
  {
    notification_id: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Denormalised from the parent so tests/rls-coverage.test.ts — which enumerates only tables
     *  carrying a `tenant_id` — can see this table at all. See the 0068 header. */
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    read_at: timestamp('read_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.notification_id, t.user_id] })],
);

/** Leader election for the boot schedulers (0051). One row per logical tick; claiming it is a
 *  single atomic statement, so exactly one pod wins each tick no matter how pgbouncer shuffles
 *  connections. Replaces a session-level advisory lock that could not work through the TRANSACTION
 *  pooler the owner pool actually points at — see 0051 for the full mechanism. */
export const schedulerTicks = pgTable('scheduler_ticks', {
  key: text('key').primaryKey(),
  last_run_at: timestamp('last_run_at', { withTimezone: true }).defaultNow().notNull(),
  claimed_by: text('claimed_by'),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type SchedulerTick = typeof schedulerTicks.$inferSelect;

export type TenantLlmBudget = typeof tenantLlmBudgets.$inferSelect;
export type NewTenantLlmBudget = typeof tenantLlmBudgets.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationRead = typeof notificationReads.$inferSelect;
export type NewNotificationRead = typeof notificationReads.$inferInsert;

/**
 * One central licence per MEMBER per app (migration 0089), replacing the single tenant-level token
 * on `tenants.license_token_encrypted`.
 *
 * ⛔ WHY THIS EXISTS. The tenant-level token made three things impossible at once: a seat could not
 * be COUNTED (licences-service `human_subjects` reads 1 for a tenant of fifty), a seat could not be
 * RELEASED (offboarding touches no licence), and spend could not be ATTRIBUTED — all six
 * `billing_cost_daily` rows this service has ever produced carry the nil licence id and
 * `attribution_status='unlicensed'`, with ONE `users.id` repeated across two different tenants in
 * the `subject_id` field where billing expects a Licences Subject UUID.
 *
 * ⚠️ This is the OPERATIONAL binding, NOT the billing archive. `user_id` cascades, so a hard
 * `removeLocalUser` takes these rows with it. That is safe only because the authoritative record
 * lives elsewhere: the licences service stamps `revoked_at` on first transition, and billing FREEZES
 * the resolved seat count into `billing_invoices.snapshot` at period close. Do not start reading
 * this table as the history of who was licensed when.
 */
export const memberEntitlements = pgTable(
  'member_entitlements',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' })
      .default(tenantGucDefault),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * TEXT and not a FK: the app registry lives in the licences service and its UUID is resolved at
     * runtime by `services/licenses-admin.ts` `resolveAppAndPlan`. `config.license.appKey` is the
     * value `middleware/license-gate.ts` asserts the introspected `app.key` against.
     */
    app_key: text('app_key').notNull().default('commonpractice'),

    /** NULL while `pending` — the row is written BEFORE the remote call, so a crash between the two
     *  leaves a retryable record instead of an invisible gap. */
    license_id: uuid('license_id'),
    /**
     * ⭐ The licences-service Subject UUID, returned by `POST /licenses/user/{keycloak_sub}` and,
     * before this change, DISCARDED — `licenses-admin.ts` `createLicense` returned `{licenseId}`
     * only. Emit THIS as a cost event's `subject_id`. Sending `users.id` there is precisely why
     * 100% of this service's central spend landed as `unlicensed`.
     */
    license_subject_id: uuid('license_subject_id'),
    /** Sealed with `host/secret-box.ts` `encryptSecret`. The licences API returns a minted token
     *  exactly once, so this is the only copy. */
    token_encrypted: text('token_encrypted'),

    /**
     * `pending` → row exists, remote licence unconfirmed; the gate DENIES.
     * `active` → licence + token present; the only state the gate admits.
     * `revoking` → offboarding started. Access is ALREADY denied, but the seat stays BILLABLE until
     *   the central revoke is acknowledged. That is a revenue fact, not a nicety.
     * `revoked` → acknowledged. Retained as history and excluded from the live unique index.
     * `error` → the saga failed in a way retry did not clear; `last_error` says how.
     */
    status: text('status')
      .$type<'pending' | 'active' | 'revoking' | 'revoked' | 'error'>()
      .notNull()
      .default('pending'),

    provisioned_at: timestamp('provisioned_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    /** Saga bookkeeping for the reconciler in `host/onboarding-integrity.ts`. */
    attempts: integer('attempts').notNull().default(0),
    last_error: text('last_error'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /**
     * PARTIAL on purpose — keep in step with 0089's `member_entitlements_live_uq`. A plain unique
     * over the triple would make re-hiring impossible: a returning member needs a SECOND
     * entitlement while the first stays put as evidence they held a seat in an earlier billing
     * period. Excluding `revoked` preserves the at-most-one-ACTIVE guarantee the gate depends on
     * and lets history accumulate underneath it.
     */
    uniqueIndex('member_entitlements_live_uq')
      .on(t.tenant_id, t.user_id, t.app_key)
      .where(sql`${t.status} <> 'revoked'`),
    index('member_entitlements_status_idx').on(t.tenant_id, t.status),
    index('member_entitlements_license_idx')
      .on(t.license_id)
      .where(sql`${t.license_id} IS NOT NULL`),
  ],
);

export type MemberEntitlement = typeof memberEntitlements.$inferSelect;
export type NewMemberEntitlement = typeof memberEntitlements.$inferInsert;

/**
 * Transactional outbox for the `billing:costs` stream (migration 0090). Written in the SAME
 * transaction as the `usage_events` ledger row (host/llm-broker.ts `settleSpend`) and delivered by
 * host/metering-outbox-drainer.ts. A `pending` row older than the drain interval is undelivered spend.
 */
export const meteringOutbox = pgTable(
  'metering_outbox',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tenant_id: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** One event per ledger row; also the billing `event_key`. */
    usage_event_id: uuid('usage_event_id')
      .notNull()
      .unique()
      .references(() => usageEvents.id, { onDelete: 'cascade' }),
    /** The flat string→string field map billing's cost_flusher parses, frozen at settle time. */
    fields: jsonb('fields').$type<Record<string, string>>().notNull(),
    status: text('status').$type<'pending' | 'sent'>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    last_error: text('last_error'),
    next_attempt_at: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    sent_at: timestamp('sent_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('metering_outbox_due_idx').on(t.next_attempt_at).where(sql`${t.status} = 'pending'`),
  ],
);

export type MeteringOutboxRow = typeof meteringOutbox.$inferSelect;
