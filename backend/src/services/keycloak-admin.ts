// src/services/keycloak-admin.ts — Keycloak admin-API client for CP's user realm
// (KEYCLOAK_USER_REALM; prod `commonpractice`).
//
// CP's writes are deliberately narrow: create an identity
// for someone CP invites, send them the action email, end sessions, disable, and manage its
// tenants' Identity Providers. CP NEVER writes realm roles or the `tenant_id` user attribute —
// tenancy and roles live in CP's own `users` table (services/cp-identity.ts). Role reads remain
// (`getRealmRolesForUsers`) only for the one-off membership backfill.
//
// Auth: client_credentials for a confidential service-account client in the user realm
// (`KEYCLOAK_USER_REALM_ADMIN_CLIENT_ID` / `KEYCLOAK_USER_REALM_ADMIN_CLIENT_SECRET`). Realm-per-app
// P7 retired the former `portal`-realm admin SA (KEYCLOAK_ADMIN_CLIENT_ID/SECRET) — no fallback.
//
// Two patterns carried from specra, deliberately:
//   1. Every partial user mutation is GET-merge-PUT — Keycloak's `PUT /users/{id}`
//      rejects a body missing `email`, so we never send a partial representation.
//   2. READS are non-fatal (degrade to defaults / null); identity WRITES are fatal
//      (throw → 502 at the call site). Onboarding must fail loud.
import { config } from '../config';
import { log } from '../host/logger';

/** Thrown by identity-write failures (create/email/disable/IdP). Callers map to 502. */
export class KeycloakAdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'KeycloakAdminError';
  }
}

/** Thrown specifically when a realm user already exists (409). */
export class DuplicateUserError extends KeycloakAdminError {
  constructor(message = 'Realm user already exists') {
    super(409, message);
    this.name = 'DuplicateUserError';
  }
}

/** Thrown specifically when an Identity Provider alias already exists (409). Phase 4 / E.1. */
export class DuplicateIdpError extends KeycloakAdminError {
  constructor(message = 'Identity provider already exists') {
    super(409, message);
    this.name = 'DuplicateIdpError';
  }
}

export interface KeycloakAdminOptions {
  baseUrl?: string;
  /** Realm to administer (CP's USER realm — KEYCLOAK_USER_REALM, default KEYCLOAK_REALM). */
  targetRealm?: string;
  /** Realm the admin client authenticates in. Defaults to `targetRealm` (KEYCLOAK_USER_REALM). */
  tokenRealm?: string;
  clientId?: string;
  clientSecret?: string;
  /** Injectable for tests (no live Keycloak). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms). Defaults to Date.now — only used for the token cache. */
  now?: () => number;
}

export interface RealmUserInput {
  username: string;
  email: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  emailVerified?: boolean;
  attributes?: Record<string, string | string[]>;
}

interface CachedToken {
  token: string;
  /** epoch ms after which the cached token must be refreshed. */
  expiresAt: number;
}

/** How long an admin token is cached, mirroring specra's 60s window. */
const TOKEN_TTL_MS = 60_000;

export class KeycloakAdminService {
  private readonly baseUrl: string;
  private readonly targetRealm: string;
  private readonly tokenRealm: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached?: CachedToken;

  constructor(opts: KeycloakAdminOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? config.keycloak.url).replace(/\/+$/, '');
    // The admin client both administers AND authenticates in KEYCLOAK_USER_REALM, with that realm's
    // own SA (KEYCLOAK_USER_REALM_ADMIN_CLIENT_ID/SECRET). The portal-realm credential is retired (P7).
    const kc = config.keycloak;
    this.targetRealm = opts.targetRealm ?? kc.userRealm;
    this.tokenRealm = opts.tokenRealm ?? this.targetRealm;
    this.clientId = opts.clientId ?? kc.userRealmAdminClientId;
    this.clientSecret = opts.clientSecret ?? kc.userRealmAdminClientSecret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /**
   * The ONE fetch seam every Keycloak call goes through. Two things the raw `fetchImpl` did not do:
   *
   *  1. TIMEOUT. Nothing bounded a Keycloak call, so an unresponsive Keycloak (or a slow SMTP relay
   *     inside `execute-actions-email`) held the HTTP request open until some upstream proxy gave
   *     up — surfacing to the user as a gateway 502/504 with no trace in our logs.
   *  2. TRANSPORT ERRORS. A DNS failure / connection refused / TLS error threw a raw `TypeError`
   *     that was neither HttpError nor KeycloakAdminError, so `provisionRealmUser` re-threw it and
   *     it became a generic 500 — contradicting the documented "Keycloak failure ⇒ 502" contract.
   *     Mapping it to KeycloakAdminError(503) restores that contract.
   */
  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(config.keycloak.adminTimeoutMs),
      });
    } catch (err) {
      const reason =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? `timed out after ${config.keycloak.adminTimeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);
      throw new KeycloakAdminError(503, `keycloak transport error: ${reason}`);
    }
  }

  // ---- token (client_credentials in the target realm, 60s cache) ----

  async getAdminToken(): Promise<string> {
    const nowMs = this.now();
    if (this.cached && this.cached.expiresAt > nowMs) {
      return this.cached.token;
    }
    // Fail BEFORE the network call when there is no credential to send. `.env.example` points dev
    // at LIVE production Keycloak; an empty-credential grant from every dev box once kept
    // KeycloakAuthFailuresPersistent lit for three days (2026-08-18). 503: from the caller's side an
    // unconfigured admin client IS an unavailable dependency, and the message names the env vars.
    if (!this.clientId || !this.clientSecret) {
      throw new KeycloakAdminError(
        503,
        'keycloak admin client not configured (KEYCLOAK_USER_REALM_ADMIN_CLIENT_ID / KEYCLOAK_USER_REALM_ADMIN_CLIENT_SECRET unset) — refusing to send an empty credential',
      );
    }
    const url = `${this.baseUrl}/realms/${this.tokenRealm}/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });
    const res = await this.send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new KeycloakAdminError(
        res.status,
        `admin token request failed: HTTP ${res.status}`,
      );
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) {
      throw new KeycloakAdminError(502, 'admin token response missing access_token');
    }
    this.cached = { token: json.access_token, expiresAt: nowMs + TOKEN_TTL_MS };
    return json.access_token;
  }

  /** Build an admin-API URL under the TARGET realm. */
  private adminUrl(path: string): string {
    return `${this.baseUrl}/admin/realms/${this.targetRealm}/${path}`;
  }

  private async authed(
    method: string,
    path: string,
    jsonBody?: unknown,
  ): Promise<Response> {
    const token = await this.getAdminToken();
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(jsonBody !== undefined ? { 'content-type': 'application/json' } : {}),
      },
    };
    if (jsonBody !== undefined) init.body = JSON.stringify(jsonBody);
    return this.send(this.adminUrl(path), init);
  }

  // ---- reads (NON-FATAL: degrade gracefully) ----

  /** Page the realm's users at 100/page. Returns [] (never throws) on failure so a
   *  caller falls back to defaults — reads are non-fatal.
   *
   *  NOTE: this is a whole-realm scan and it swallows a mid-scan failure by returning a PARTIAL
   *  list. Never use it to decide that a user does not exist — use
   *  `findRealmUserByUsernameOrEmail`, which asks Keycloak an exact question and reports failure
   *  as failure. (Resolving a duplicate through this method is what made the onboarding approve
   *  return a permanent 502: a realm user existed under the username but carried no email, so an
   *  email-only match over this list found nothing.) */
  async listRealmUsers(): Promise<RealmUser[]> {
    const out: RealmUser[] = [];
    try {
      for (let first = 0; ; first += 100) {
        const res = await this.authed('GET', `users?first=${first}&max=100`);
        if (!res.ok) break;
        const page = (await res.json()) as RealmUser[];
        out.push(...page);
        if (page.length < 100) break;
      }
    } catch {
      return out;
    }
    return out;
  }

  /**
   * Resolve an existing realm user by USERNAME or EMAIL, using Keycloak's exact-match queries.
   *
   * Keycloak treats username and email as separate unique-ish fields: `POST /users` 409s on a
   * username collision even when the existing account has no email at all. Matching only on email
   * therefore cannot resolve every duplicate — and a realm genuinely does contain email-less
   * accounts (portal-seeded / brokered users). This asks both questions, username first, since that
   * is the field `createRealmUser` collides on.
   *
   * FATAL on transport/HTTP failure (throws KeycloakAdminError) — unlike `listRealmUsers`, "I could
   * not ask" must never be indistinguishable from "there is no such user", because the caller uses
   * the answer to decide whether to fail the whole onboarding.
   */
  async findRealmUserByUsernameOrEmail(
    username: string,
    email?: string,
  ): Promise<RealmUser | null> {
    // Both fields are queried even when the two values are IDENTICAL — which is the normal case,
    // since CP creates users with `username === email`. De-duplicating on the value would skip the
    // email query entirely and reintroduce the original bug in mirror image: a realm user with a
    // legacy `username` but the right `email` would go unresolved and 502 the onboarding.
    const wanted = [
      { field: 'username', value: username },
      ...(email ? [{ field: 'email', value: email }] : []),
    ];
    for (const { field, value } of wanted) {
      const res = await this.authed(
        'GET',
        `users?${field}=${encodeURIComponent(value)}&exact=true&max=2`,
      );
      if (!res.ok) {
        throw new KeycloakAdminError(res.status, `lookup by ${field} failed: HTTP ${res.status}`);
      }
      const hits = (await res.json()) as RealmUser[];
      // Keycloak's `exact=true` is still case-insensitive on these fields; re-check explicitly so a
      // near-miss can never bind an onboarding to the wrong account.
      const match = hits.find(
        (u) =>
          (field === 'username' ? u.username : u.email)?.toLowerCase() === value.toLowerCase(),
      );
      if (match) return match;
    }
    return null;
  }

  /**
   * Set a user's email if it is missing (GET-merge-PUT).
   * Reusing an email-less account without this leaves the realm unable to answer "who is
   * <address>?" — which is precisely the state that produced the unresolvable-duplicate 502.
   * Non-fatal: the identity is usable without it, so a failure is logged, not thrown.
   */
  async backfillUserEmail(userId: string, email: string): Promise<void> {
    try {
      const res = await this.authed('GET', `users/${userId}`);
      if (!res.ok) return;
      const current = (await res.json()) as RealmUser;
      if (current.email) return;
      const put = await this.authed('PUT', `users/${userId}`, { ...current, email });
      if (!put.ok) {
        log.error('backfill_email_failed', { component: 'keycloak-admin', userId, status: put.status });
      }
    } catch (err) {
      log.error('backfill_email_failed', { component: 'keycloak-admin', userId, err });
    }
  }

  /**
   * Fill an EMPTY first/last name (GET-merge-PUT). PROFILE DATA ONLY — the merge sends back the
   * representation Keycloak just returned, with nothing but `firstName`/`lastName` changed, so no
   * attribute (and certainly no `tenant_id`) is written or dropped.
   *
   * Why it exists: the portal realm's user profile REQUIRES both names, so an identity without them
   * is sent through Keycloak's VERIFY_PROFILE form on first sign-in — an extra screen between a
   * brand-new invitee and the workspace they were invited to. An invite that knows the names fills
   * them here. A name someone already set is never overwritten.
   *
   * Non-fatal, like `backfillUserEmail`: the identity can sign in without it (the form just asks).
   */
  async backfillUserNames(userId: string, firstName?: string, lastName?: string): Promise<void> {
    try {
      const res = await this.authed('GET', `users/${userId}`);
      if (!res.ok) {
        // ⚠️ Not silent: an unreadable identity leaves its names empty and its owner on Keycloak's
        // VERIFY_PROFILE form — a 403 here means the SA lost `view-users`/`manage-users`.
        log.warn('backfill_names_failed', { component: 'keycloak-admin', userId, step: 'read', status: res.status });
        return;
      }
      const current = (await res.json()) as RealmUser;
      const patch: { firstName?: string; lastName?: string } = {};
      if (!current.firstName?.trim() && firstName?.trim()) patch.firstName = firstName.trim();
      if (!current.lastName?.trim() && lastName?.trim()) patch.lastName = lastName.trim();
      if (!patch.firstName && !patch.lastName) return;
      const put = await this.authed('PUT', `users/${userId}`, { ...current, ...patch });
      if (!put.ok) {
        log.error('backfill_names_failed', { component: 'keycloak-admin', userId, status: put.status });
      }
    } catch (err) {
      log.error('backfill_names_failed', { component: 'keycloak-admin', userId, err });
    }
  }

  /**
   * `GET users/{id}/credentials` → the credential TYPES the user holds (`password`, `otp`, …), or
   * `null` when Keycloak would not say. NON-FATAL. Never the secret data — only `type` is kept.
   *
   * ⚠️ `null` IS "UNKNOWN", NOT "NONE". The SA holds `view-users`; whether that admits reading
   * credentials depends on the Keycloak version's admin-permission model, so a 403 is an expected
   * answer here, and the invite predicate then degrades to required actions + IdP links
   * (`provisioning.ts identityLoginState`). Reading a 403 as "no password" would mail a
   * set-password link to every existing fr user.
   */
  async getUserCredentials(userId: string): Promise<{ type: string }[] | null> {
    try {
      const res = await this.authed('GET', `users/${userId}/credentials`);
      if (!res.ok) {
        if (res.status !== 403) {
          log.warn('keycloak_credentials_read_failed', { component: 'keycloak-admin', userId, status: res.status });
        }
        return null;
      }
      const creds = (await res.json()) as { type?: string }[];
      return Array.isArray(creds) ? creds.map((c) => ({ type: String(c.type ?? '') })) : null;
    } catch {
      return null;
    }
  }

  /** `GET users/{id}/federated-identity` → the IdP links (`identityProvider` aliases), or `null` when
   *  unknown. NON-FATAL; `view-users` covers it. */
  async getFederatedIdentities(userId: string): Promise<{ identityProvider: string }[] | null> {
    try {
      const res = await this.authed('GET', `users/${userId}/federated-identity`);
      if (!res.ok) return null;
      const links = (await res.json()) as { identityProvider?: string }[];
      return Array.isArray(links)
        ? links.map((l) => ({ identityProvider: String(l.identityProvider ?? '') }))
        : null;
    } catch {
      return null;
    }
  }

  private async getUserRep(userId: string): Promise<RealmUser> {
    const res = await this.authed('GET', `users/${userId}`);
    if (!res.ok) {
      throw new KeycloakAdminError(res.status, `get user ${userId} failed: HTTP ${res.status}`);
    }
    return (await res.json()) as RealmUser;
  }

  // ---- writes (FATAL: throw on failure) ----

  /**
   * Set (string) or remove (null) user attributes — READ-MODIFY-WRITE of the whole representation.
   *
   * ⛔ NEVER a PUT of `{attributes: {…}}` alone. Keycloak's user PUT replaces the attribute map it is
   * given, so a partial body would wipe every attribute this call did not name — `tenant_id` and
   * fr's attributes included (the realm is shared). So the current representation is read, only the
   * named keys are changed, and the whole thing is written back. Used by the early-access approval
   * email (`locale`, `signup_app`, `signup_book_url`, services/signup-email.ts). Fatal on failure.
   */
  async updateUserAttributes(userId: string, patch: Record<string, string | null>): Promise<void> {
    const current = await this.getUserRep(userId);
    const attributes: Record<string, string[]> = { ...(current.attributes ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete attributes[k];
      else attributes[k] = [v];
    }
    const res = await this.authed('PUT', `users/${userId}`, { ...current, attributes });
    if (!res.ok) {
      throw new KeycloakAdminError(res.status, `update attributes of user ${userId} failed: HTTP ${res.status}`);
    }
  }

  /** Create a realm user; returns the new `sub` from the Location header. 409 → DuplicateUserError. */
  async createRealmUser(input: RealmUserInput): Promise<string> {
    const rep = {
      username: input.username,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      enabled: input.enabled ?? true,
      emailVerified: input.emailVerified ?? false,
      attributes: normalizeAttributes(input.attributes),
    };
    const res = await this.authed('POST', 'users', rep);
    if (res.status === 409) {
      throw new DuplicateUserError(`user '${input.email}' already exists`);
    }
    if (res.status !== 201) {
      throw new KeycloakAdminError(res.status, `create user failed: HTTP ${res.status}`);
    }
    const location = res.headers.get('location') ?? res.headers.get('Location');
    const id = location?.split('/').pop();
    if (!id) {
      throw new KeycloakAdminError(502, 'create user succeeded but no id in Location header');
    }
    return id;
  }

  /**
   * End every Keycloak SESSION this user holds (`POST users/{id}/logout`). Fatal on failure.
   *
   * CP's own `revokeSessionsFor` only tombstones rows in `agent_sessions`; this ends the realm
   * sessions (and so the refresh chain) as well.
   *
   * 404-TOLERANT for the same reason `deleteRealmUser` is: CP holds `users` rows with no realm
   * identity behind them by design (the showcase seed), and "this realm has no such user" is a
   * definitive answer meaning there is no session to end — not a failure to retry.
   */
  async logoutUser(userId: string): Promise<void> {
    const res = await this.authed('POST', `users/${userId}/logout`);
    if (res.status === 404) return;
    if (res.status !== 204 && !res.ok) {
      throw new KeycloakAdminError(res.status, `logout user failed: HTTP ${res.status}`);
    }
  }

  /** The full representation of one user (attributes included), or `null` on a 404. Fatal otherwise. */
  async getRealmUser(userId: string): Promise<RealmUser | null> {
    const res = await this.authed('GET', `users/${userId}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new KeycloakAdminError(res.status, `get user ${userId} failed: HTTP ${res.status}`);
    return (await res.json()) as RealmUser;
  }

  /**
   * Set `enabled` and/or set-remove attributes in ONE read-modify-write PUT (same rule as
   * `updateUserAttributes`: the whole representation is written back, so no other attribute or field
   * is lost), then READ BACK and return what Keycloak stored. The read-back is the point: the portal
   * realm's user profile DROPS an undeclared attribute on write without an error, so only the stored
   * representation says whether a marker actually landed. Fatal on failure.
   */
  async setUserState(
    userId: string,
    state: { enabled?: boolean; attributes?: Record<string, string | null> },
  ): Promise<RealmUser> {
    const current = await this.getUserRep(userId);
    const attributes: Record<string, string[]> = { ...(current.attributes ?? {}) };
    for (const [k, v] of Object.entries(state.attributes ?? {})) {
      if (v === null) delete attributes[k];
      else attributes[k] = [v];
    }
    const body = { ...current, attributes, ...(state.enabled === undefined ? {} : { enabled: state.enabled }) };
    const res = await this.authed('PUT', `users/${userId}`, body);
    if (!res.ok) {
      throw new KeycloakAdminError(res.status, `update state of user ${userId} failed: HTTP ${res.status}`);
    }
    return this.getUserRep(userId);
  }

  /** Disable a user (GET-merge-PUT enabled:false). Fatal on failure. */
  async disableUser(userId: string): Promise<void> {
    const rep = await this.getUserRep(userId);
    const res = await this.authed('PUT', `users/${userId}`, { ...rep, enabled: false });
    if (!res.ok) {
      throw new KeycloakAdminError(res.status, `disable user failed: HTTP ${res.status}`);
    }
  }

  /**
   * Batched realm-role READ for a set of users — used only by the one-off membership backfill
   * (scripts/backfill-cp-membership.ts). KC has no multi-user role endpoint, so this fans out one role-mappings GET per user.
   *
   * NON-FATAL per user, but a failed user maps to `null`, NOT `[]`. That distinction matters:
   * with `[]` a Keycloak outage was indistinguishable from "this user holds no roles", which
   *   • made the budget alerts' own outage fallback DEAD CODE — a tenant hitting 100 % of its
   *     welcome budget got no email at all, logged misleadingly as "no tenant_admin to email"; and
   *   • made the last-admin guard silently UNDER-count admins, so it could allow the demotion of a
   *     tenant's final administrator.
   * Callers decide what an unknown means for them; `rolesOrEmpty` below is the read-only shorthand.
   *
   * ⛔ A **404 is not an unknown** — it is a definitive "this realm has no such user", so it maps to
   * `[]`. Conflating the two is what broke offboarding in prod: `null` means "ask again later", and
   * a user Keycloak does not have will 404 FOREVER, so every caller that fails closed on `null`
   * failed closed permanently. CP holds `users` rows with no Keycloak identity by design — the
   * showcase seed (`db/seed-tenant-showcase.ts`) inserts members with DB-generated ids and never
   * provisions a realm identity — and 21 of prod's 24 live rows are of exactly that shape. Result:
   * `tenantUserIds`'s last-admin guard raised `502 keycloak_role_lookup_failed` for essentially
   * EVERY tenant, so `DELETE /api/tenants/:id/users/:userId` (offboard) and the demote half of
   * `PATCH …/users/:userId` could not succeed at all. Prod has zero tombstones, which is the
   * corroborating evidence: the route has never once completed against a real tenant.
   *
   * A user who does not exist cannot hold a role, so `[]` is not a degradation here — it is the
   * correct answer, and it keeps the outage signal intact for the cases that really are unknown
   * (5xx, transport failure, an auth failure against the admin API).
   */
  async getRealmRolesForUsers(userIds: string[]): Promise<Map<string, string[] | null>> {
    const out = new Map<string, string[] | null>();
    await Promise.all(
      userIds.map(async (userId) => {
        try {
          const res = await this.authed('GET', `users/${userId}/role-mappings/realm`);
          if (!res.ok) {
            // 404 = definitively no such user → no roles. Anything else = could not ask.
            out.set(userId, res.status === 404 ? [] : null);
            return;
          }
          const roles = (await res.json()) as RealmRole[];
          out.set(userId, roles.map((r) => r.name).filter(Boolean));
        } catch {
          out.set(userId, null);
        }
      }),
    );
    return out;
  }

  /**
   * Send Keycloak's action email (UPDATE_PASSWORD by default). No plaintext password is ever
   * emailed. `redirectUri` + `clientId` send the user back into CP after the actions complete;
   * `lifespanSeconds` bounds the link. Fatal on failure.
   */
  async executeActionsEmail(
    userId: string,
    actions: string[] = ['UPDATE_PASSWORD'],
    opts: ExecuteActionsEmailOptions = {},
  ): Promise<void> {
    const qs = new URLSearchParams();
    if (opts.redirectUri) qs.set('redirect_uri', opts.redirectUri);
    if (opts.clientId) qs.set('client_id', opts.clientId);
    if (opts.lifespanSeconds !== undefined) qs.set('lifespan', String(opts.lifespanSeconds));
    const query = qs.size > 0 ? `?${qs.toString()}` : '';
    const res = await this.authed('PUT', `users/${userId}/execute-actions-email${query}`, actions);
    if (!res.ok) {
      throw new KeycloakAdminError(res.status, `execute-actions-email failed: HTTP ${res.status}`);
    }
  }

  /**
   * Delete a realm user. 404-TOLERANT — already gone counts as success.
   *
   * ⛔ ONLY to roll back an identity CP created earlier in the SAME call. The realm is shared with
   * fr: removing someone from a CP workspace must never delete their Keycloak user.
   */
  async deleteRealmUser(userId: string): Promise<void> {
    const res = await this.authed('DELETE', `users/${userId}`);
    if (res.status === 404) return;
    if (!res.ok) {
      throw new KeycloakAdminError(res.status, `delete user failed: HTTP ${res.status}`);
    }
  }

  // ---- Identity Providers + IdP mappers (Phase 4 / E.1 — per-tenant Entra OIDC) ----
  // CP brokers each tenant's Entra ID as a Keycloak IdP on the TARGET (`portal`) realm.
  // Writes are FATAL (→ 502 at the call site); the alias read is non-fatal (→ null). The
  // alias is always `entra-<slug>` (sso-service derives it) and is unique in `identity_providers`;
  // CP binds a brokered first login to a tenant by that alias (services/cp-identity.ts).

  /** Create an Identity Provider instance. 409 → DuplicateIdpError; other non-201 → fatal. */
  async createIdentityProvider(rep: IdpRepresentation): Promise<void> {
    const res = await this.authed('POST', 'identity-provider/instances', rep);
    if (res.status === 409) {
      throw new DuplicateIdpError(`identity provider '${rep.alias}' already exists`);
    }
    if (res.status !== 201 && !res.ok) {
      throw new KeycloakAdminError(res.status, `create IdP failed: HTTP ${res.status}`);
    }
  }

  /** Read an IdP instance by alias. Returns null (never throws) if absent/unreachable. */
  async getIdentityProvider(alias: string): Promise<IdpRepresentation | null> {
    try {
      const res = await this.authed(
        'GET',
        `identity-provider/instances/${encodeURIComponent(alias)}`,
      );
      if (!res.ok) return null;
      return (await res.json()) as IdpRepresentation;
    } catch {
      return null;
    }
  }

  /** Update an IdP instance (full representation — KC's PUT replaces). Fatal on failure. */
  async updateIdentityProvider(alias: string, rep: IdpRepresentation): Promise<void> {
    const res = await this.authed(
      'PUT',
      `identity-provider/instances/${encodeURIComponent(alias)}`,
      rep,
    );
    if (res.status !== 204 && !res.ok) {
      throw new KeycloakAdminError(res.status, `update IdP failed: HTTP ${res.status}`);
    }
  }

  /** Delete an IdP instance. 404-TOLERANT — already gone counts as success. */
  async deleteIdentityProvider(alias: string): Promise<void> {
    const res = await this.authed(
      'DELETE',
      `identity-provider/instances/${encodeURIComponent(alias)}`,
    );
    if (res.status === 404) return;
    if (res.status !== 204 && !res.ok) {
      throw new KeycloakAdminError(res.status, `delete IdP failed: HTTP ${res.status}`);
    }
  }

  /** Author an IdP mapper (e.g. an attribute importer). Fatal on failure. */
  async createIdpMapper(alias: string, mapper: IdpMapperRepresentation): Promise<void> {
    const res = await this.authed(
      'POST',
      `identity-provider/instances/${encodeURIComponent(alias)}/mappers`,
      mapper,
    );
    if (res.status !== 201 && !res.ok) {
      throw new KeycloakAdminError(res.status, `create IdP mapper failed: HTTP ${res.status}`);
    }
  }

  /** List an IdP's mappers. Returns [] (never throws) on failure — reads are non-fatal. */
  async listIdpMappers(alias: string): Promise<IdpMapperRepresentation[]> {
    try {
      const res = await this.authed(
        'GET',
        `identity-provider/instances/${encodeURIComponent(alias)}/mappers`,
      );
      if (!res.ok) return [];
      return (await res.json()) as IdpMapperRepresentation[];
    } catch {
      return [];
    }
  }

  /** Delete one IdP mapper by id. 404-TOLERANT. Fatal otherwise. */
  async deleteIdpMapper(alias: string, mapperId: string): Promise<void> {
    const res = await this.authed(
      'DELETE',
      `identity-provider/instances/${encodeURIComponent(alias)}/mappers/${mapperId}`,
    );
    if (res.status === 404) return;
    if (res.status !== 204 && !res.ok) {
      throw new KeycloakAdminError(res.status, `delete IdP mapper failed: HTTP ${res.status}`);
    }
  }
}

export interface RealmUser {
  id: string;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  emailVerified?: boolean;
  attributes?: Record<string, string[]>;
  /** Pending required actions (`UPDATE_PASSWORD`, `VERIFY_EMAIL`, …) — in the search results too. */
  requiredActions?: string[];
}

export interface ExecuteActionsEmailOptions {
  /** Where Keycloak sends the user after the actions (`redirect_uri`). Requires `clientId`. */
  redirectUri?: string;
  /** The client whose redirect URIs validate `redirectUri` (`client_id`). */
  clientId?: string;
  /** Link validity in seconds (`lifespan`). */
  lifespanSeconds?: number;
}

export interface RealmRole {
  id: string;
  name: string;
  composite?: boolean;
  clientRole?: boolean;
  containerId?: string;
}

/** Keycloak Identity Provider representation (the subset CP authors). All `config` values are
 *  strings — Keycloak stores IdP config as `Record<string,string>` (so booleans are 'true'/'false'). */
export interface IdpRepresentation {
  alias: string;
  displayName?: string;
  providerId: string; // 'oidc' for Entra
  enabled?: boolean;
  trustEmail?: boolean;
  linkOnly?: boolean;
  storeToken?: boolean;
  firstBrokerLoginFlowAlias?: string;
  config: Record<string, string>;
}

/** Keycloak IdP mapper representation. `identityProviderMapper` selects the mapper type
 *  (e.g. 'oidc-user-attribute-idp-mapper'). */
export interface IdpMapperRepresentation {
  id?: string;
  name: string;
  identityProviderAlias: string;
  identityProviderMapper: string;
  config: Record<string, string>;
}

/** Keycloak stores user attributes as `Record<string, string[]>`. Normalize scalars. */
function normalizeAttributes(
  attrs?: Record<string, string | string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!attrs) return out;
  for (const [k, v] of Object.entries(attrs)) {
    out[k] = Array.isArray(v) ? v : [v];
  }
  return out;
}

/**
 * The minimal admin-client surface the onboarding routes depend on. Both the real
 * `KeycloakAdminService` and the test fake satisfy it, so routes program against the
 * interface and tests inject a fake (no live Keycloak) via `__setKeycloakAdminForTests`.
 */
export interface KeycloakAdminClient {
  createRealmUser(input: RealmUserInput): Promise<string>;
  logoutUser(userId: string): Promise<void>;
  executeActionsEmail(
    userId: string,
    actions?: string[],
    opts?: ExecuteActionsEmailOptions,
  ): Promise<void>;
  /** Read-modify-write of user attributes (null removes one). OPTIONAL like the login-state reads:
   *  an absent method means the attributes are not written and the email goes out without them. */
  updateUserAttributes?(userId: string, patch: Record<string, string | null>): Promise<void>;
  /** Rollback of an identity CP created in the same call ONLY — see the class method. */
  deleteRealmUser(userId: string): Promise<void>;
  /** Disable (never delete) — a REJECTED signup's minted identity (services/offboarding.ts
   *  `offboardRejectedSignupWorkspace`). OPTIONAL for the fakes' sake; absent → recorded `unsupported`. */
  disableUser?(userId: string): Promise<void>;
  /** Full representation (attributes included) of one user; null on 404. OPTIONAL for the fakes. */
  getRealmUser?(userId: string): Promise<RealmUser | null>;
  /** One read-modify-write of `enabled` + attributes, returning the STORED representation (read
   *  back). The reject marker (`provisioning.ts` CP_REJECT_MARKER) is written and cleared with it. */
  setUserState?(
    userId: string,
    state: { enabled?: boolean; attributes?: Record<string, string | null> },
  ): Promise<RealmUser>;
  listRealmUsers(): Promise<RealmUser[]>;
  findRealmUserByUsernameOrEmail(username: string, email?: string): Promise<RealmUser | null>;
  backfillUserEmail(userId: string, email: string): Promise<void>;
  /** Fill EMPTY first/last names only (profile data, never attributes). OPTIONAL for the same reason
   *  as the login-state reads below; an absent method means the names are simply not backfilled. */
  backfillUserNames?(userId: string, firstName?: string, lastName?: string): Promise<void>;
  getRealmRolesForUsers(userIds: string[]): Promise<Map<string, string[] | null>>;
  /**
   * Login-state reads for the invite predicate. OPTIONAL in the type for the reason
   * licenses-admin.ts gives (a dozen test fakes are object literals) — and here an absent method is
   * SAFE to treat as `null` ("unknown"): the predicate then falls back to required actions, i.e. the
   * pre-A2 behaviour for an existing identity. `KeycloakAdminService` implements both.
   */
  getUserCredentials?(userId: string): Promise<{ type: string }[] | null>;
  getFederatedIdentities?(userId: string): Promise<{ identityProvider: string }[] | null>;
  // ---- Identity Providers (Phase 4 / E.1) ----
  createIdentityProvider(rep: IdpRepresentation): Promise<void>;
  getIdentityProvider(alias: string): Promise<IdpRepresentation | null>;
  updateIdentityProvider(alias: string, rep: IdpRepresentation): Promise<void>;
  deleteIdentityProvider(alias: string): Promise<void>;
  createIdpMapper(alias: string, mapper: IdpMapperRepresentation): Promise<void>;
  listIdpMappers(alias: string): Promise<IdpMapperRepresentation[]>;
  deleteIdpMapper(alias: string, mapperId: string): Promise<void>;
}

/** Lazily-constructed default singleton (uses config creds). */
let _instance: KeycloakAdminClient | undefined;
let _testOverride: KeycloakAdminClient | undefined;
export function keycloakAdmin(): KeycloakAdminClient {
  if (_testOverride) return _testOverride;
  if (!_instance) _instance = new KeycloakAdminService();
  return _instance;
}

/** Inject a fake admin client in tests (paired with `(undefined)` teardown). Mirrors the
 *  auth seam's `__setAuthOverridesForTests` — no process-wide module mocks. */
export function __setKeycloakAdminForTests(fake: KeycloakAdminClient | undefined): void {
  _testOverride = fake;
}
