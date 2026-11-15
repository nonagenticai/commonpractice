// tests/signup-early-access-v2.test.ts — early-access v2 (George 2026-10-19), the CommonPractice side.
//
// Drives the LIVE onboarding routes against postgres with identity injected via
// __setAuthOverridesForTests, Keycloak admin + licences replaced by fakes, and every outbound HTTP
// client (Telegram, book-fulfillment + its token endpoint) replaced by recording fakes. Covers:
//   • 0121 `signup_approvals.locale`: intake normalisation (lenient), the DB CHECK, the invite form
//     (strict), the reused-pending override.
//   • POST /api/signup-approvals/:id/telegram-decision (C3): the decider guard (azp, aud, role,
//     super_admin refused, intake SA refused, env overrides), strict body, 404, approve/reject with
//     defaults, audit actor `telegram:<id>`, idempotent `already_decided`, 502 `failed`, the
//     checkpoint resume (never a second workspace).
//   • Licence at approval: member_seat → member_licence → invite_email, the email ONLY after the
//     licence; a licence failure defers the email and the tick sends it; an email failure is retried
//     by the tick; the held requester is dropped once sent; an EXISTING identity is never seated early.
//   • The approval email (C4/C5): `locale` / `signup_app` / `signup_book_url` set before the send,
//     the book link cleared after it, a book-link failure never blocking the email.
//   • /invite/accept for a requester seated at approval is instant: no licence call at all.
//   • KeycloakAdminService.updateUserAttributes is a read-modify-write that keeps other attributes.
import { test, expect, beforeEach, afterAll, describe } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { db, tenants, users, signupApprovals, auditLog, queryClient, runAsSystem } from '../src/db/client';
import { tenantInvites } from '../src/db/schema';
import { withTenantDbAsRuntimeRoleForTests } from '../src/db/client';
import { Router } from '../src/utils/router';
import { registerOnboardingRoutes, __setApprovalClaimTimingForTests, recordApproveEffect } from '../src/routes/onboarding';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import {
  __setKeycloakAdminForTests,
  DuplicateUserError,
  KeycloakAdminError,
  KeycloakAdminService,
  type KeycloakAdminClient,
  type RealmUser,
} from '../src/services/keycloak-admin';
import { __setLicensesAdminForTests, type LicensesAdminClient, type LicencesPlan } from '../src/services/licenses-admin';
import {
  __drainSignupTelegramForTests,
  __setTelegramFetchForTests,
  __setTelegramSleepForTests,
} from '../src/services/signup-telegram';
import { __setBookLinksFetchForTests } from '../src/services/book-links';
import { __setInferenceLicencesForTests, __setInferenceFetchForTests } from '../src/services/tenant-inference';
import {
  claimStep,
  readProvisioning,
  reconcileProvisioning,
  releaseClaim,
  retryProvisioningStep,
} from '../src/services/tenant-provisioning';
import { newSignupPayload } from '../src/services/signup-telegram';
import { acceptInvite } from '../src/services/invite-service';
import { normaliseSignupLocale } from '../src/utils/signup-locale';
import { renderMetrics } from '../src/host/metrics';
import {
  SIGNUP_WORKSPACE_TABLE_RULES,
  signupWorkspaceBlockers,
  offboardRejectedSignupWorkspace,
  type OffboardTenantResult,
} from '../src/services/offboarding';
import {
  REJECT_REPAIR_MAX_ATTEMPTS,
  __setRejectedSignupOffboardForTests,
  __setRejectRepairFoundedLookupForTests,
  __setRejectRepairWriteFaultForTests,
} from '../src/services/signup-reject-repair';
import { engineTenantIds, tickTenantCycles } from '../src/host/cycle-service';
import { sweepIdleSandboxes } from '../src/host/sandbox-service';
import { reconcileStaleRuns } from '../src/host/run-controller';
import { runAuditExportTick } from '../src/host/audit-export-scheduler';
import { processPendingBatch } from '../src/host/translation-service';
import { __runOnboardingIntegrityTickForTests } from '../src/host/onboarding-integrity';
import { runSignupDigestOnce } from '../src/host/signup-digest-scheduler';
import { drainMeteringOutbox } from '../src/host/metering-outbox-drainer';
import { previousUtcDay, reconcileMeteringDay } from '../src/host/metering-reconcile';
import { LicensesAdminError } from '../src/services/licenses-admin';
import { config } from '../src/config';
import { UnauthorizedError, type User } from '../src/types';

// Own id range (marker `ea2`), slug prefix `eav-`, email domain `eav-co.test`.
const SADMIN_ID = '00000000-0000-4000-8000-0000ea200001';
const DECIDER_SUB = '00000000-0000-4000-8000-0000ea200002';
const LIC_ID = '00000000-0000-4000-8000-0000ea200b01';
const SUBJ_ID = '11111111-1111-4111-8111-0000ea200b01';
const MINTED_PREFIX = '00000000-0000-4000-8000-0000ea2c';

const superAdmin: User = { id: SADMIN_ID, email: 'eav-admin@t.test', name: 'EAV Admin', roles: ['super_admin'] };
const decider: User = {
  id: DECIDER_SUB,
  email: '',
  name: '',
  roles: ['cp-signup-decide'],
  azp: 'chat-bridge-signup-decider',
  aud: ['chat-bridge-signup-decider'],
  issuer: config.keycloak.issuer,
};
const intakeSa: User = {
  id: '00000000-0000-4000-8000-0000ea200003',
  email: '',
  name: '',
  roles: ['cp-signup-intake'],
  azp: 'cp-signup-intake',
  aud: ['cp-signup-intake'],
  issuer: config.keycloak.issuer,
};

const router = new Router();
registerOnboardingRoutes(router);
let currentUser: User | null = null;

async function call(method: string, path: string, body?: unknown) {
  const m = router.match(method, path.split('?')[0]!);
  if (!m) throw new Error(`no route for ${method} ${path}`);
  return m.handler(
    new Request(`http://t${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ...m.params,
  );
}

// ---- Telegram fake ----
let telegramSent: Array<Record<string, unknown>> = [];
const TG_ENV = {
  TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN-eav',
  TELEGRAM_SIGNUP_CHAT_ID: '-1003934173351',
  TELEGRAM_SIGNUP_THREAD_ID: '4243',
  CP_PUBLIC_URL: 'https://cp.example.test',
};
const BOOK_ENV = {
  BOOK_FULFILLMENT_URL: 'http://book-fulfillment.test',
  BOOK_LINKS_TOKEN_URL: 'http://kc.test/realms/portal/protocol/openid-connect/token',
  BOOK_LINKS_CLIENT_SECRET: 'eav-book-secret',
};
const ENV_KEYS = [
  ...Object.keys(TG_ENV),
  ...Object.keys(BOOK_ENV),
  'BOOK_LINKS_CLIENT_ID',
  'BOOK_LINKS_SECRET_FILE',
  'CP_SIGNUP_DECIDER_AZP',
  'CP_SIGNUP_DECIDER_ROLE',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
function resetEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

// ---- book-fulfillment fake (token endpoint + mint) ----
let bookCalls: Array<{ url: string; body: string; auth: string | null }> = [];
let bookAnswer: () => Response = () =>
  Response.json({ url: 'https://books.example.test/d/eav-tok', lang: 'de', expiresAt: '2026-11-01T00:00:00Z' });
function installBookFake() {
  bookCalls = [];
  __setBookLinksFetchForTests(async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    bookCalls.push({ url, body: String(init?.body ?? ''), auth: headers.authorization ?? null });
    if (url.endsWith('/token')) return Response.json({ access_token: 'eav-book-sa', expires_in: 300 });
    return bookAnswer();
  });
}

// ---- Keycloak admin fake ----
// A STATEFUL realm: users with `enabled`, credentials, IdP links and attributes, read-modify-write
// semantics, and the portal user profile's unmanaged-attributes-DISABLED behaviour (an undeclared
// attribute is dropped on write, silently). Before this, a lookup never found the identity a create
// had just minted, which is how "a reject's disabled identity blocks the re-signup" went untested.
// `kcExisting` (an identity the test names, outside the store) still answers first, with a password.
type KcCall =
  | { kind: 'attrs'; sub: string; patch: Record<string, string | null> }
  | { kind: 'email'; sub: string; actions: string[]; opts: Record<string, unknown> }
  | { kind: 'create'; email: string }
  | { kind: 'disable'; sub: string }
  | { kind: 'state'; sub: string; enabled?: boolean; attributes?: Record<string, string | null> }
  | { kind: 'delete'; sub: string };
let kcCalls: KcCall[] = [];
let kcEmailFails = false;
let kcExisting: RealmUser | null = null;
type KcUser = { rep: RealmUser; creds: { type: string }[] | null; links: { identityProvider: string }[] };
const kcStore = new Map<string, KcUser>();
/** The attributes the realm's user profile DECLARES (gitops early-access-v2 + the realm's own). */
let kcDeclared = new Set(['locale', 'signup_app', 'signup_book_url']);
function kcUser(sub: string): KcUser {
  const u = kcStore.get(sub);
  if (!u) throw new KeycloakAdminError(404, `no realm user ${sub}`);
  return u;
}
/** Keycloak's PUT: the attribute map given replaces the stored one, minus what the profile drops. */
function kcWrite(u: KcUser, rep: RealmUser) {
  const attributes: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(rep.attributes ?? {})) if (kcDeclared.has(k)) attributes[k] = v;
  u.rep = structuredClone({ ...rep, attributes });
}
function kcRmw(sub: string, patch: Record<string, string | null>, enabled?: boolean) {
  const u = kcUser(sub);
  const current = structuredClone(u.rep);
  const attributes = { ...(current.attributes ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete attributes[k];
    else attributes[k] = [v];
  }
  kcWrite(u, { ...current, attributes, ...(enabled === undefined ? {} : { enabled }) });
}
/** The person set a password through the action link. */
function kcSetPassword(sub: string) {
  kcUser(sub).creds = [{ type: 'password' }];
}
/** An identity already in the realm (a re-signup's earlier account, somebody's fr login, …). */
function kcSeed(rep: RealmUser, creds: { type: string }[] | null = [{ type: 'password' }]) {
  kcStore.set(rep.id, { rep: structuredClone(rep), creds, links: [] });
}
function makeKc(): KeycloakAdminClient {
  let n = 0;
  const byName = (value: string) =>
    [...kcStore.values()].find(
      (u) => u.rep.username?.toLowerCase() === value.toLowerCase() || u.rep.email?.toLowerCase() === value.toLowerCase(),
    );
  return {
    async createRealmUser(input) {
      if (byName(input.username)) throw new DuplicateUserError(`user '${input.email}' already exists`);
      n++;
      kcCalls.push({ kind: 'create', email: input.email });
      const id = `${MINTED_PREFIX}${String(n).padStart(4, '0')}`;
      kcStore.set(id, {
        rep: {
          id,
          username: input.username,
          email: input.email,
          enabled: input.enabled ?? true,
          emailVerified: input.emailVerified ?? false,
          attributes: {},
          requiredActions: [],
        },
        creds: [],
        links: [],
      });
      return id;
    },
    async logoutUser() {},
    async executeActionsEmail(sub, actions, opts) {
      if (kcEmailGate) {
        const g = kcEmailGate;
        kcEmailGate = null;
        await g.hold();
      }
      if (kcEmailFails) throw new Error('smtp down');
      // Keycloak refuses to mail a disabled user (400 "User is disabled").
      if (kcStore.get(sub)?.rep.enabled === false) throw new KeycloakAdminError(400, 'User is disabled');
      kcCalls.push({ kind: 'email', sub, actions: actions ?? [], opts: (opts ?? {}) as Record<string, unknown> });
    },
    async updateUserAttributes(sub, patch) {
      kcCalls.push({ kind: 'attrs', sub, patch });
      if (kcStore.has(sub)) kcRmw(sub, patch);
    },
    async deleteRealmUser(sub) {
      kcCalls.push({ kind: 'delete', sub });
      kcStore.delete(sub);
    },
    async disableUser(sub) {
      kcCalls.push({ kind: 'disable', sub });
      kcRmw(sub, {}, false);
    },
    async getRealmUser(sub) {
      if (kcExisting?.id === sub) return kcExisting;
      const u = kcStore.get(sub);
      return u ? structuredClone(u.rep) : null;
    },
    async setUserState(sub, state) {
      kcCalls.push({ kind: 'state', sub, ...state });
      kcRmw(sub, state.attributes ?? {}, state.enabled);
      return structuredClone(kcUser(sub).rep);
    },
    async listRealmUsers() {
      return [...kcStore.values()].map((u) => structuredClone(u.rep));
    },
    async findRealmUserByUsernameOrEmail(username, email) {
      if (kcExisting) return kcExisting;
      const hit = byName(username) ?? (email ? byName(email) : undefined);
      return hit ? structuredClone(hit.rep) : null;
    },
    async backfillUserEmail() {},
    async getRealmRolesForUsers(ids) {
      return new Map(ids.map((i) => [i, []]));
    },
    async getUserCredentials(sub) {
      const u = kcStore.get(sub);
      return u ? (u.creds ? structuredClone(u.creds) : null) : [{ type: 'password' }];
    },
    async getFederatedIdentities(sub) {
      return structuredClone(kcStore.get(sub)?.links ?? []);
    },
    async createIdentityProvider() {},
    async getIdentityProvider() {
      return null;
    },
    async updateIdentityProvider() {},
    async deleteIdentityProvider() {},
    async createIdpMapper() {},
    async listIdpMappers() {
      return [];
    },
    async deleteIdpMapper() {},
  };
}

// ---- gates: hold the approve run at a known point (licences_tenant inside createTenant = BEFORE
// the seat; the member mint = AFTER the seat, before the email) while a test moves the claim ----
function makeGate() {
  let release!: () => void;
  let reached!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  const releasedP = new Promise<void>((r) => (release = r));
  return {
    reached: reachedP,
    release,
    async hold() {
      reached();
      await releasedP;
    },
  };
}
type Gate = ReturnType<typeof makeGate>;
let registerGate: Gate | null = null;
let memberGate: Gate | null = null;
/** Holds the FIRST licence revoke (the offboard's tenant-licence revoke) — a cleanup in flight. */
let revokeGate: Gate | null = null;
let revokeCalls = 0;
/** Holds the next Keycloak action email (an existing-mode invite's delivery). */
let kcEmailGate: Gate | null = null;

// ---- licences fake: `failMember` refuses the MEMBER mint (subject = a minted sub) only;
// `failRevoke` refuses every revoke (the tenant-licence revoke is the offboard's first, FATAL one) ----
let failMember = false;
let failRevoke = false;
let revokeRefusals = 0;
let licenceCalls = 0;
function makeLicences(): LicensesAdminClient {
  const names = new Map<string, string>();
  const plan = (code: string): LicencesPlan => ({
    id: '00000000-0000-4000-8000-0000ea200e01',
    code,
    name: code,
    description: null,
    durationDays: null,
    rateLimitRpm: null,
    rateLimitBurst: null,
    quotaMonthly: null,
    tokenBudgetMonthly: null,
    revoked: false,
    createdAt: null,
  });
  return {
    async getTenant(nameOrId) {
      const id = names.get(nameOrId);
      return id ? { id, name: nameOrId } : null;
    },
    async ensureTenantRegistered(tenantId, name) {
      const g = registerGate;
      registerGate = null;
      if (g) await g.hold();
      licenceCalls++;
      names.set(name, tenantId);
    },
    async renameTenant() {},
    async archiveTenant() {},
    async setTenantByoMode() {},
    async listPlans() {
      return [plan('byo'), plan('standard'), plan('local-llm')];
    },
    async createLicense(subject) {
      if (memberGate && subject.startsWith(MINTED_PREFIX)) {
        const g = memberGate;
        memberGate = null;
        await g.hold();
      }
      licenceCalls++;
      if (failMember && subject.startsWith(MINTED_PREFIX)) throw new Error('licences down (member mint)');
      return { licenseId: LIC_ID, subjectId: SUBJ_ID };
    },
    async createToken() {
      licenceCalls++;
      return { token: 'eav-token' };
    },
    async revokeByToken() {
      revokeCalls++;
      if (revokeGate) {
        const g = revokeGate;
        revokeGate = null;
        await g.hold();
      }
      if (failRevoke) {
        revokeRefusals++;
        throw new LicensesAdminError(503, 'licences down (revoke)');
      }
    },
    async revokeByLicenseId() {
      revokeCalls++;
      if (revokeGate) {
        const g = revokeGate;
        revokeGate = null;
        await g.hold();
      }
      if (failRevoke) {
        revokeRefusals++;
        throw new LicensesAdminError(503, 'licences down (revoke)');
      }
    },
  };
}

type LicenceCfg = { adminBaseUrl: string; issuanceEnabled: boolean; sa: { tokenUrl: string }; planCode: string };
const lic = config.license as unknown as LicenceCfg;
const wasLic = { base: lic.adminBaseUrl, token: lic.sa.tokenUrl, issuance: lic.issuanceEnabled, plan: lic.planCode };
const llmCfg = config.llm as { openaiBaseUrl: string };
const wasIr = llmCfg.openaiBaseUrl;
function centralOn() {
  lic.adminBaseUrl = 'http://licenses.test';
  lic.sa.tokenUrl = 'http://kc.test/token';
  lic.issuanceEnabled = true;
  lic.planCode = 'byo';
  llmCfg.openaiBaseUrl = 'http://inference-router.test/api';
  const fake = makeLicences();
  __setLicensesAdminForTests(fake);
  __setInferenceLicencesForTests(fake);
  __setInferenceFetchForTests(async (_url, init) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    return new Response('{}', { status: h.authorization === 'Bearer eav-token' ? 200 : 401 });
  });
}
function centralOff() {
  lic.adminBaseUrl = wasLic.base;
  lic.sa.tokenUrl = wasLic.token;
  lic.issuanceEnabled = wasLic.issuance;
  lic.planCode = wasLic.plan;
  llmCfg.openaiBaseUrl = wasIr;
  __setLicensesAdminForTests(undefined);
  __setInferenceLicencesForTests(undefined);
  __setInferenceFetchForTests(undefined);
}

const CLEANUP_SQL = `
  DELETE FROM votes WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'eav-%');
  DELETE FROM weekly_winners WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'eav-%');
  DELETE FROM solutions WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'eav-%');
  DELETE FROM challenges WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'eav-%');
  DELETE FROM signup_approvals WHERE lower(email) LIKE '%eav-co.test';
  DELETE FROM audit_log WHERE lower(target_id) LIKE '%eav-co.test';
  DELETE FROM audit_log WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'eav-%');
  DELETE FROM tenants WHERE slug LIKE 'eav-%';
  DELETE FROM users WHERE id::text LIKE '${MINTED_PREFIX}%' OR lower(email) LIKE '%eav-co.test';
`;

beforeEach(async () => {
  resetEnv();
  telegramSent = [];
  __setTelegramFetchForTests(async (_url, init) => {
    telegramSent.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  __setTelegramSleepForTests(async () => {});
  installBookFake();
  bookAnswer = () =>
    Response.json({ url: 'https://books.example.test/d/eav-tok', lang: 'de', expiresAt: '2026-11-01T00:00:00Z' });
  kcCalls = [];
  kcEmailFails = false;
  kcExisting = null;
  kcStore.clear();
  kcDeclared = new Set(['locale', 'signup_app', 'signup_book_url']);
  failMember = false;
  failRevoke = false;
  revokeRefusals = 0;
  licenceCalls = 0;
  registerGate = null;
  memberGate = null;
  revokeGate = null;
  revokeCalls = 0;
  kcEmailGate = null;
  __setApprovalClaimTimingForTests(undefined);
  currentUser = null;
  __setAuthOverridesForTests({
    validateAuth: async () => {
      if (!currentUser) throw new UnauthorizedError('no auth');
      return currentUser;
    },
  });
  __setKeycloakAdminForTests(makeKc());
  centralOn();
  await queryClient.unsafe(CLEANUP_SQL);
}, 30_000);

afterAll(async () => {
  await __drainSignupTelegramForTests();
  __setApprovalClaimTimingForTests(undefined);
  resetEnv();
  centralOff();
  __setAuthOverridesForTests(undefined);
  __setKeycloakAdminForTests(undefined);
  __setTelegramFetchForTests(undefined);
  __setTelegramSleepForTests(undefined);
  __setBookLinksFetchForTests(undefined);
  await queryClient.unsafe(CLEANUP_SQL);
}, 30_000);

/** The member's licence rows that still count (anything but revoked). */
async function liveEntitlements(userId: string): Promise<number> {
  const rows = (await queryClient.unsafe(
    `SELECT count(*)::int AS n FROM member_entitlements WHERE user_id = '${userId}' AND status = 'active'`,
  )) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}
async function rowFor(email: string) {
  const [r] = await db.select().from(signupApprovals).where(sql`lower(email) = lower(${email})`);
  return r;
}
async function pending(email: string, extra: Partial<typeof signupApprovals.$inferInsert> = {}) {
  const [r] = await db
    .insert(signupApprovals)
    .values({ email, name: 'Eve Early', source: 'web', trust: 'intake', ...extra })
    .returning();
  return r!;
}
function decide(id: string, body: unknown) {
  currentUser = decider;
  return call('POST', `/api/signup-approvals/${id}/telegram-decision`, body);
}

// =================================================================================================
describe('0121 locale', () => {
  test('normaliseSignupLocale: primary subtag of the eight; anything else → null', () => {
    expect(normaliseSignupLocale('de')).toBe('de');
    expect(normaliseSignupLocale('de-DE')).toBe('de');
    expect(normaliseSignupLocale(' NL_be ')).toBe('nl');
    expect(normaliseSignupLocale('he-IL')).toBe('he');
    for (const v of ['it', 'zz', '', 'english', 'deu', 42, null, undefined]) expect(normaliseSignupLocale(v)).toBeNull();
  });

  test('intake: a known locale is stored normalised; an unknown one is ABSENT, never a 422', async () => {
    currentUser = intakeSa;
    const base = { name: 'Lo Cale', company: 'EAV Lo', source: 'web' };
    expect((await call('POST', '/api/signup-approvals/intake', { ...base, email: 'l1@eav-co.test', locale: 'fr-CA' })).status).toBe(202);
    expect((await call('POST', '/api/signup-approvals/intake', { ...base, email: 'l2@eav-co.test', locale: 'it' })).status).toBe(202);
    expect((await call('POST', '/api/signup-approvals/intake', { ...base, email: 'l3@eav-co.test' })).status).toBe(202);
    expect((await rowFor('l1@eav-co.test'))!.locale).toBe('fr');
    expect((await rowFor('l2@eav-co.test'))!.locale).toBeNull();
    expect((await rowFor('l3@eav-co.test'))!.locale).toBeNull();
    // still strict about its SHAPE: a non-string is a 422
    expect((await call('POST', '/api/signup-approvals/intake', { ...base, email: 'l4@eav-co.test', locale: 7 })).status).toBe(422);
  });

  test('the DB CHECK refuses a locale outside the eight from any writer', async () => {
    let msg = 'no error';
    try {
      await queryClient.unsafe(`INSERT INTO signup_approvals (email, locale) VALUES ('l5@eav-co.test', 'it')`);
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toContain('signup_approvals_locale_check');
  });

  test('the super_admin invite: locale is strict (422 outside the list), stored, and overrides a reused pending row', async () => {
    currentUser = superAdmin;
    const bad = await call('POST', '/api/signup-approvals/invite', { email: 'l6@eav-co.test', name: 'Lo Six', locale: 'it' });
    expect(bad.status).toBe(422);
    expect(await rowFor('l6@eav-co.test')).toBeUndefined();

    await pending('l7@eav-co.test', { company: 'EAV Seven', locale: 'fr' });
    currentUser = superAdmin;
    const res = await call('POST', '/api/signup-approvals/invite', { email: 'l7@eav-co.test', name: 'Lo Seven', locale: 'pl' });
    expect(res.status).toBe(200);
    expect((await rowFor('l7@eav-co.test'))!.locale).toBe('pl');
    // …and that is the language the email asks Keycloak for.
    expect(kcCalls.find((c) => c.kind === 'attrs')).toMatchObject({ patch: { locale: 'pl' } });
  });
});

// =================================================================================================
describe('POST /api/signup-approvals/:id/telegram-decision — the decider guard', () => {
  test('no token → 401; nothing decided', async () => {
    const a = await pending('g1@eav-co.test');
    currentUser = null;
    expect((await call('POST', `/api/signup-approvals/${a.id}/telegram-decision`, { action: 'approve', telegramUserId: 1 })).status).toBe(401);
    expect((await rowFor('g1@eav-co.test'))!.status).toBe('pending');
  });

  test('wrong azp / aud not naming the azp / missing role / super_admin / the intake SA → 403 signup_decider_forbidden', async () => {
    const a = await pending('g2@eav-co.test');
    const cases: User[] = [
      { ...decider, azp: 'some-other-client', aud: ['some-other-client'] },
      { ...decider, azp: undefined },
      { ...decider, aud: undefined },
      { ...decider, aud: ['account'] },
      { ...decider, roles: [] },
      { ...decider, roles: ['cp-signup-decide', 'super_admin'] },
      { ...superAdmin },
      intakeSa,
      { ...intakeSa, roles: ['cp-signup-intake', 'cp-signup-decide'] }, // right role, wrong client
    ];
    for (const u of cases) {
      currentUser = u;
      const res = await call('POST', `/api/signup-approvals/${a.id}/telegram-decision`, { action: 'approve', telegramUserId: 1 });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('signup_decider_forbidden');
    }
    expect((await rowFor('g2@eav-co.test'))!.status).toBe('pending');
  });

  test('CP_SIGNUP_DECIDER_AZP / _ROLE are honoured (read live)', async () => {
    const a = await pending('g3@eav-co.test');
    process.env.CP_SIGNUP_DECIDER_AZP = 'other-bridge';
    process.env.CP_SIGNUP_DECIDER_ROLE = 'other-role';
    expect((await decide(a.id, { action: 'reject', telegramUserId: 5 })).status).toBe(403);
    currentUser = { ...decider, azp: 'other-bridge', aud: ['other-bridge'], roles: ['other-role'] };
    const res = await call('POST', `/api/signup-approvals/${a.id}/telegram-decision`, { action: 'reject', telegramUserId: 5 });
    expect(res.status).toBe(200);
  });

  test('realm-per-app P0: the decider is pinned to CP_SIGNUP_DECIDER_ISSUER (default KEYCLOAK_ISSUER)', async () => {
    const a = await pending('g3b@eav-co.test');
    const secureApps = 'https://auth.example.test/realms/secure-apps';
    // Right client/aud/role, but issued by another (trusted) realm → 403, nothing decided.
    for (const issuer of [secureApps, 'https://auth.example.test/realms/commonpractice', undefined]) {
      currentUser = { ...decider, issuer };
      const res = await call('POST', `/api/signup-approvals/${a.id}/telegram-decision`, { action: 'reject', telegramUserId: 5 });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('signup_decider_forbidden');
    }
    expect((await rowFor('g3b@eav-co.test'))!.status).toBe('pending');
    // P1 flips this one client to secure-apps: now ONLY a secure-apps-issued decider token passes.
    process.env.CP_SIGNUP_DECIDER_ISSUER = secureApps;
    try {
      currentUser = { ...decider };
      expect((await call('POST', `/api/signup-approvals/${a.id}/telegram-decision`, { action: 'reject', telegramUserId: 5 })).status).toBe(403);
      currentUser = { ...decider, issuer: secureApps };
      expect((await call('POST', `/api/signup-approvals/${a.id}/telegram-decision`, { action: 'reject', telegramUserId: 5 })).status).toBe(200);
    } finally {
      delete process.env.CP_SIGNUP_DECIDER_ISSUER;
    }
  });

  test('strict body: unknown action / string id / extra field / missing field → 422', async () => {
    const a = await pending('g4@eav-co.test');
    for (const body of [
      { action: 'maybe', telegramUserId: 1 },
      { action: 'approve', telegramUserId: '1' },
      { action: 'approve', telegramUserId: 1, tenantName: 'x' },
      { action: 'approve' },
      { action: 'approve', telegramUserId: 0 },
    ]) {
      expect((await decide(a.id, body)).status).toBe(422);
    }
    expect((await rowFor('g4@eav-co.test'))!.status).toBe('pending');
  });

  test('unknown id → 404 (a well-formed unknown uuid and a malformed id alike)', async () => {
    expect((await decide('00000000-0000-4000-8000-0000ea20ffff', { action: 'approve', telegramUserId: 1 })).status).toBe(404);
    expect((await decide('not-a-uuid', { action: 'reject', telegramUserId: 1 })).status).toBe(404);
  });
});

describe('POST /api/signup-approvals/:id/telegram-decision — decisions', () => {
  test('approve → 200 approved with defaults (new workspace from the company, local-llm); audit actor telegram:<id>; idempotent', async () => {
    process.env = { ...process.env, ...TG_ENV };
    const a = await pending('d1@eav-co.test', { company: 'EAV Decided', locale: 'de' });
    const res = await decide(a.id, { action: 'approve', telegramUserId: 777 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; tenantId: string; summary: string };
    expect(body.status).toBe('approved');
    expect(body.summary.length).toBeLessThanOrEqual(200);
    expect(body.summary).toContain('d1@eav-co.test');
    expect(body.summary).toContain('eav-decided');
    expect(body.summary).toContain('set-password email sent');

    const row = (await rowFor('d1@eav-co.test'))!;
    expect(row.status).toBe('approved');
    expect(row.assigned_tenant_id).toBe(body.tenantId);
    expect(row.decided_by).toBeNull(); // the SA has no users row — System, named in the audit
    const [t] = await db.select().from(tenants).where(eq(tenants.id, body.tenantId));
    expect(t!.slug).toBe('eav-decided');
    expect(t!.plan_code).toBe('local-llm');

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} = 'signup.approve' and ${auditLog.metadata}->>'approvalId' = ${a.id}`);
    expect(audit!.actor_id).toBeNull();
    expect(audit!.metadata).toMatchObject({
      decidedVia: 'telegram',
      actor: 'telegram:777',
      deciderAzp: 'chat-bridge-signup-decider',
      mode: 'new_tenant',
      nameDefaulted: true,
      seatedAtApproval: true,
    });

    // The Telegram follow-up says who decided it.
    await __drainSignupTelegramForTests();
    const followUp = telegramSent.map((p) => String(p.text)).find((t) => t.includes('signup approved'));
    expect(followUp).toContain('Decided via: Telegram (user 777)');

    // A second tap / a redelivery: already_decided, with the same workspace, nothing new created.
    const again = await decide(a.id, { action: 'approve', telegramUserId: 777 });
    expect(again.status).toBe(200);
    const againBody = (await again.json()) as { status: string; tenantId?: string; summary: string };
    expect(againBody.status).toBe('already_decided');
    expect(againBody.tenantId).toBe(body.tenantId);
    const reject = (await (await decide(a.id, { action: 'reject', telegramUserId: 777 })).json()) as { status: string };
    expect(reject.status).toBe('already_decided');
    expect((await db.select().from(tenants).where(sql`slug LIKE 'eav-decided%'`)).length).toBe(1);
  });

  test('reject → 200 rejected; audit actor telegram:<id>; then already_decided', async () => {
    const a = await pending('d2@eav-co.test');
    const res = await decide(a.id, { action: 'reject', telegramUserId: 778 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('rejected');
    const row = (await rowFor('d2@eav-co.test'))!;
    expect(row.status).toBe('rejected');
    expect(row.decided_by).toBeNull();
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} = 'signup.reject' and ${auditLog.metadata}->>'approvalId' = ${a.id}`);
    expect(audit!.actor_id).toBeNull();
    expect(audit!.metadata).toMatchObject({ actor: 'telegram:778', decidedVia: 'telegram' });
    const again = (await (await decide(a.id, { action: 'approve', telegramUserId: 778 })).json()) as {
      status: string;
      tenantId?: string;
    };
    expect(again.status).toBe('already_decided');
    expect(again.tenantId).toBeUndefined();
  });

  test('an approve that cannot be carried out → 502 {status: failed, summary}; the row stays pending', async () => {
    // The address already belongs to a workspace: approve refuses (409) before creating anything.
    const [home] = await db.insert(tenants).values({ name: 'EAV Home', slug: 'eav-home' }).returning();
    await db.insert(users).values({
      id: `${MINTED_PREFIX}9001`,
      keycloak_sub: `${MINTED_PREFIX}9001`,
      email: 'd3@eav-co.test',
      name: 'Taken',
      tenant_id: home!.id,
      tenant_role: 'member',
    });
    const a = await pending('d3@eav-co.test');
    const res = await decide(a.id, { action: 'approve', telegramUserId: 779 });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { status: string; summary: string };
    expect(body.status).toBe('failed');
    expect(body.summary).toContain('user_belongs_to_another_workspace');
    expect(body.summary.length).toBeLessThanOrEqual(200);
    expect((await rowFor('d3@eav-co.test'))!.status).toBe('pending');
  });

  test('a row an earlier attempt already checkpointed a workspace on is finished INTO it — never a second workspace', async () => {
    const [ws] = await db.insert(tenants).values({ name: 'EAV Checkpoint', slug: 'eav-checkpoint' }).returning();
    const a = await pending('d4@eav-co.test', { assigned_tenant_id: ws!.id, requested_role: 'tenant_admin', company: 'EAV Other' });
    const res = await decide(a.id, { action: 'approve', telegramUserId: 780 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; tenantId: string };
    expect(body.status).toBe('approved');
    expect(body.tenantId).toBe(ws!.id);
    expect(await db.select().from(tenants).where(eq(tenants.slug, 'eav-other'))).toHaveLength(0);
  });
});

// =================================================================================================
describe('licence at approval — member_seat → member_licence → invite_email', () => {
  async function approveViaScreen(id: string) {
    currentUser = superAdmin;
    return call('POST', `/api/signup-approvals/${id}/approve`, { mode: 'new_tenant' });
  }

  test('a licence that fails DEFERS the email; the tick mints it and sends the email in the same sweep', async () => {
    process.env = { ...process.env, ...TG_ENV };
    failMember = true;
    const a = await pending('s1@eav-co.test', { company: 'EAV Deferred' });
    const res = await approveViaScreen(a.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tenantId: string;
      seatedAtApproval: boolean;
      invite: { emailDelivery: string; inviteUrl: string };
      provisioning: { steps: Record<string, { status: string; code: string | null }> };
    };
    expect(body.seatedAtApproval).toBe(true);
    expect(body.invite.emailDelivery).toBe('deferred');
    expect(body.invite.inviteUrl).toContain('/invite/accept?token=');
    expect(body.provisioning.steps.member_seat!.status).toBe('ok');
    expect(body.provisioning.steps.member_licence!.status).toBe('pending');
    expect(body.provisioning.steps.invite_email).toMatchObject({ status: 'pending', code: 'waiting_for_member_licence' });
    // ⛔ No email while the licence is missing.
    expect(kcCalls.filter((c) => c.kind === 'email')).toHaveLength(0);
    // Seated already: the person IS the workspace's tenant_admin.
    const [u] = await db.select().from(users).where(sql`lower(email) = 's1@eav-co.test'`);
    expect(u!.tenant_id).toBe(body.tenantId);
    expect(u!.tenant_role).toBe('tenant_admin');
    // The held requester (PII) is on the row until the email lands.
    expect((await readProvisioning(body.tenantId))!.signupAdmin?.email).toBe('s1@eav-co.test');
    await __drainSignupTelegramForTests();
    expect(telegramSent.map((p) => String(p.text)).join('\n')).toContain('the set-password email follows once their licence exists');

    // The licences service recovers; the tick's due time arrives.
    failMember = false;
    await queryClient.unsafe(
      `UPDATE tenants SET provisioning = jsonb_set(provisioning, '{steps,member_licence,nextAttemptAt}', to_jsonb(now() - interval '1 minute'))
        WHERE id = '${body.tenantId}'`,
    );
    await reconcileProvisioning();
    const rec = (await readProvisioning(body.tenantId))!;
    expect(rec.steps.member_licence!.status).toBe('ok');
    expect(rec.steps.invite_email!.status).toBe('ok');
    expect(rec.signupAdmin).toBeUndefined(); // dropped once the email landed
    const emails = kcCalls.filter((c) => c.kind === 'email');
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({ sub: u!.id, actions: ['UPDATE_PASSWORD', 'VERIFY_EMAIL'] });
    // The person is seated already: the link lands on the APP ROOT, with no per-send token to rotate.
    expect((emails[0] as { opts: Record<string, unknown> }).opts.redirectUri).toBe('https://cp.example.test/');
    expect((emails[0] as { opts: Record<string, unknown> }).opts.clientId).toBe('commonpractice-frontend');
  });

  test('an email that fails is `pending` and the tick sends it again', async () => {
    kcEmailFails = true;
    const a = await pending('s2@eav-co.test', { company: 'EAV Mailfail' });
    const body = (await (await approveViaScreen(a.id)).json()) as { tenantId: string; invite: { emailDelivery: string } };
    expect(body.invite.emailDelivery).toBe('deferred');
    let rec = (await readProvisioning(body.tenantId))!;
    expect(rec.steps.member_licence!.status).toBe('ok');
    expect(rec.steps.invite_email).toMatchObject({ status: 'pending', code: 'invite_email_failed', attempts: 1 });
    expect(rec.steps.invite_email!.nextAttemptAt).not.toBeNull();

    kcEmailFails = false;
    await queryClient.unsafe(
      `UPDATE tenants SET provisioning = jsonb_set(provisioning, '{steps,invite_email,nextAttemptAt}', to_jsonb(now() - interval '1 minute'))
        WHERE id = '${body.tenantId}'`,
    );
    await reconcileProvisioning();
    rec = (await readProvisioning(body.tenantId))!;
    expect(rec.steps.invite_email!.status).toBe('ok');
    expect(kcCalls.filter((c) => c.kind === 'email')).toHaveLength(1);
  });

  test('⛔ an identity that ALREADY existed is never seated early — the ordinary invite (pending, no users row)', async () => {
    kcExisting = { id: `${MINTED_PREFIX}8001`, email: 's3@eav-co.test', emailVerified: true, requiredActions: [] };
    const a = await pending('s3@eav-co.test', { company: 'EAV Existing' });
    const body = (await (await approveViaScreen(a.id)).json()) as {
      tenantId: string;
      seatedAtApproval: boolean;
      invite: { emailDelivery: string; id: string };
    };
    expect(body.seatedAtApproval).toBe(false);
    // can sign in already → CP's own mail (no SMTP in tests: `failed`), never Keycloak's, never deferred
    expect(['sent', 'failed']).toContain(body.invite.emailDelivery);
    expect(kcCalls.filter((c) => c.kind === 'email' || c.kind === 'attrs')).toHaveLength(0);
    expect(await db.select().from(users).where(sql`lower(email) = 's3@eav-co.test'`)).toHaveLength(0);
    const [inv] = await db.select().from(tenantInvites).where(eq(tenantInvites.id, body.invite.id));
    expect(inv!.status).toBe('pending');
    const rec = (await readProvisioning(body.tenantId))!;
    expect(rec.steps.member_seat).toBeUndefined();
    expect(rec.signupAdmin).toBeUndefined();
  });

  test('/invite/accept for a requester seated at approval is INSTANT: idempotent consume, zero licence calls', async () => {
    const a = await pending('s4@eav-co.test', { company: 'EAV Instant' });
    const body = (await (await approveViaScreen(a.id)).json()) as {
      tenantId: string;
      invite: { emailDelivery: string; inviteUrl: string };
    };
    expect(body.invite.emailDelivery).toBe('keycloak_actions');
    const token = new URL(body.invite.inviteUrl).searchParams.get('token')!;
    const [u] = await db.select().from(users).where(sql`lower(email) = 's4@eav-co.test'`);
    const before = licenceCalls;
    // The person after the set-password link (VERIFY_EMAIL done → a verified token).
    const out = await acceptInvite(
      { id: u!.id, email: 's4@eav-co.test', name: 'Eve Early', roles: [], emailVerified: true },
      { token },
    );
    expect(out).toEqual({ tenantId: body.tenantId, role: 'tenant_admin' });
    expect(licenceCalls).toBe(before);
    // Again (Back button, a second click): same answer.
    expect(await acceptInvite({ id: u!.id, email: 's4@eav-co.test', name: 'Eve Early', roles: [], emailVerified: true }, { token })).toEqual(out);
  });

  test('the super_admin web approve still answers the same shape (approval, tenantId, role, invite, seated, tenant, provisioning)', async () => {
    const a = await pending('s5@eav-co.test', { company: 'EAV Shape' });
    const res = await approveViaScreen(a.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    for (const k of ['approval', 'tenantId', 'role', 'invite', 'seated', 'tenant', 'provisioning']) expect(body).toHaveProperty(k);
    expect((body.approval as { status: string }).status).toBe('approved');
  });
});

// =================================================================================================
describe('the approval email — attributes, book link (C4/C5)', () => {
  async function approve(email: string, extra: Partial<typeof signupApprovals.$inferInsert> = {}) {
    const a = await pending(email, extra);
    currentUser = superAdmin;
    const res = await call('POST', `/api/signup-approvals/${a.id}/approve`, { mode: 'new_tenant' });
    expect(res.status).toBe(200);
    return (await res.json()) as { invite: { emailDelivery: string } };
  }

  test('configured: book link minted for (email, lang) with the SA token; set BEFORE the email, cleared AFTER it', async () => {
    Object.assign(process.env, BOOK_ENV);
    const body = await approve('b1@eav-co.test', { company: 'EAV Book', locale: 'de' });
    expect(body.invite.emailDelivery).toBe('keycloak_actions');
    // token (client credentials, client commonpractice-book-links) then the mint
    expect(bookCalls.map((c) => c.url)).toEqual([
      BOOK_ENV.BOOK_LINKS_TOKEN_URL,
      'http://book-fulfillment.test/internal/download-links',
    ]);
    const form = new URLSearchParams(bookCalls[0]!.body);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('commonpractice-book-links');
    expect(form.get('client_secret')).toBe('eav-book-secret');
    expect(bookCalls[1]!.auth).toBe('Bearer eav-book-sa');
    expect(JSON.parse(bookCalls[1]!.body)).toEqual({ email: 'b1@eav-co.test', lang: 'de' });

    const seq = kcCalls.filter((c) => c.kind !== 'create');
    expect(seq.map((c) => c.kind)).toEqual(['attrs', 'email', 'attrs']);
    expect(seq[0]).toMatchObject({
      patch: { locale: 'de', signup_app: 'commonpractice', signup_book_url: 'https://books.example.test/d/eav-tok' },
    });
    expect(seq[2]).toMatchObject({ patch: { signup_book_url: null } });
  });

  test('book-fulfillment failing (5xx) never blocks the email: sent without the link, counted', async () => {
    Object.assign(process.env, BOOK_ENV);
    bookAnswer = () => new Response('boom', { status: 503 });
    const failedBefore = counterValue('failed');
    const body = await approve('b2@eav-co.test', { company: 'EAV Nobook' });
    expect(body.invite.emailDelivery).toBe('keycloak_actions');
    const seq = kcCalls.filter((c) => c.kind !== 'create');
    expect(seq.map((c) => c.kind)).toEqual(['attrs', 'email']); // nothing to clear
    expect(seq[0]).toMatchObject({ patch: { locale: 'en', signup_app: 'commonpractice', signup_book_url: null } });
    expect(counterValue('failed')).toBe(failedBefore + 1);
  });

  test('unconfigured (no BOOK_FULFILLMENT_URL): no call at all, the email goes out, `disabled` counted', async () => {
    const before = counterValue('disabled');
    const body = await approve('b3@eav-co.test', { company: 'EAV Unconf' });
    expect(body.invite.emailDelivery).toBe('keycloak_actions');
    expect(bookCalls).toHaveLength(0);
    expect(counterValue('disabled')).toBe(before + 1);
  });

  test('BOOK_LINKS_SECRET_FILE is read when no inline secret is set', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/eav-book-secret-${process.pid}`;
    await Bun.write(path, 'from-file-secret\n');
    process.env.BOOK_FULFILLMENT_URL = BOOK_ENV.BOOK_FULFILLMENT_URL;
    process.env.BOOK_LINKS_TOKEN_URL = BOOK_ENV.BOOK_LINKS_TOKEN_URL;
    process.env.BOOK_LINKS_SECRET_FILE = path;
    await approve('b4@eav-co.test', { company: 'EAV Secretfile' });
    expect(new URLSearchParams(bookCalls[0]!.body).get('client_secret')).toBe('from-file-secret');
  });

  function counterValue(outcome: string): number {
    const m = renderMetrics().match(new RegExp(`signup_book_link_total\\{outcome="${outcome}"\\} (\\d+)`));
    return m ? Number(m[1]) : -1;
  }
});

// =================================================================================================
describe('review fixes — one email, resume, one decider, domain match', () => {
  async function approveViaScreen(id: string) {
    currentUser = superAdmin;
    return call('POST', `/api/signup-approvals/${id}/approve`, { mode: 'new_tenant' });
  }
  const emails = () => kcCalls.filter((c) => c.kind === 'email') as Array<Extract<KcCall, { kind: 'email' }>>;

  test('⛔ a step somebody else holds is NOT run by the tick: one email only, and a resend keeps the earlier link working', async () => {
    process.env = { ...process.env, ...TG_ENV };
    failMember = true;
    const a = await pending('r1@eav-co.test', { company: 'EAV Oneemail' });
    const body = (await (await approveViaScreen(a.id)).json()) as { tenantId: string; invite: { inviteUrl: string } };
    failMember = false;
    // The licence lands (tick) → the email is woken, but a Retry holds the email step's claim.
    await queryClient.unsafe(
      `UPDATE tenants SET provisioning = jsonb_set(provisioning, '{steps,member_licence,nextAttemptAt}', to_jsonb(now() - interval '1 minute'))
        WHERE id = '${body.tenantId}'`,
    );
    expect(await claimStep(body.tenantId, 'invite_email')).not.toBeNull();
    await reconcileProvisioning();
    expect((await readProvisioning(body.tenantId))!.steps.member_licence!.status).toBe('ok');
    expect(emails()).toHaveLength(0); // claimed by someone else: the tick left it alone
    await releaseClaim(body.tenantId, 'invite_email');
    await Promise.all([reconcileProvisioning(), reconcileProvisioning()]);
    expect(emails()).toHaveLength(1); // two sweeps at once, one send

    expect(emails()[0]!.opts.redirectUri).toBe('https://cp.example.test/');
    // A Retry of the LANDED step sends nothing more (the held requester was dropped with the send).
    await retryProvisioningStep(body.tenantId, 'invite_email', { actorId: SADMIN_ID });
    expect(emails()).toHaveLength(1);
    // No token was rotated anywhere: the accept link handed out at approve still resolves.
    const token = new URL(body.invite.inviteUrl).searchParams.get('token')!;
    const [u] = await db.select().from(users).where(sql`lower(email) = 'r1@eav-co.test'`);
    expect(
      await acceptInvite({ id: u!.id, email: 'r1@eav-co.test', name: 'E', roles: [], emailVerified: true }, { token }),
    ).toEqual({ tenantId: body.tenantId, role: 'tenant_admin' });
  });

  test('approve and the tick racing: exactly one email', async () => {
    const a = await pending('r2@eav-co.test', { company: 'EAV Race' });
    await Promise.all([approveViaScreen(a.id), reconcileProvisioning(), reconcileProvisioning()]);
    await reconcileProvisioning();
    expect(emails()).toHaveLength(1);
  });

  test('a FAILED approve (Keycloak down after the workspace was founded) is RESUMED: same workspace, seated, licensed, emailed', async () => {
    const a = await pending('r3@eav-co.test', { company: 'EAV Resume' });
    const kc = makeKc();
    const create = kc.createRealmUser.bind(kc);
    let failOnce = true;
    kc.createRealmUser = async (input) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('keycloak down');
      }
      return create(input);
    };
    __setKeycloakAdminForTests(kc);
    const first = await decide(a.id, { action: 'approve', telegramUserId: 901 });
    expect(first.status).toBe(502);
    const row = (await rowFor('r3@eav-co.test'))!;
    expect(row.status).toBe('pending');
    expect(row.assigned_tenant_id).not.toBeNull();
    expect(row.approving_until).toBeNull(); // the claim is released on failure

    const again = await decide(a.id, { action: 'approve', telegramUserId: 901 });
    expect(again.status).toBe(200);
    const body = (await again.json()) as { status: string; tenantId: string };
    expect(body.status).toBe('approved');
    expect(body.tenantId).toBe(row.assigned_tenant_id!);
    expect(await db.select().from(tenants).where(sql`slug LIKE 'eav-resume%'`)).toHaveLength(1);
    const [u] = await db.select().from(users).where(sql`lower(email) = 'r3@eav-co.test'`);
    expect(u!.tenant_id).toBe(body.tenantId);
    const rec = (await readProvisioning(body.tenantId))!;
    expect(rec.steps.member_licence!.status).toBe('ok');
    expect(rec.steps.invite_email!.status).toBe('ok');
    expect(emails()).toHaveLength(1);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(sql`${auditLog.action} = 'signup.approve' and ${auditLog.metadata}->>'approvalId' = ${a.id}`);
    expect(audit!.metadata).toMatchObject({ resumed: true, seatedAtApproval: true });
  });

  test('a resumed approval whose requester is ALREADY seated is a success (not already_member), and the email still follows', async () => {
    const a = await pending('r4@eav-co.test', { company: 'EAV Seated' });
    // First attempt: founded + seated + recorded, then (simulated) died before deciding the row.
    const first = (await (await approveViaScreen(a.id)).json()) as { tenantId: string };
    await queryClient.unsafe(
      `UPDATE signup_approvals SET status = 'pending', decided_at = NULL WHERE id = '${a.id}';
       UPDATE tenants SET provisioning = (provisioning #- '{steps,invite_email}'::text[]) - 'signupAdmin'::text WHERE id = '${first.tenantId}';`,
    );
    kcCalls = [];
    const res = await decide(a.id, { action: 'approve', telegramUserId: 902 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; tenantId: string };
    expect(body).toMatchObject({ status: 'approved', tenantId: first.tenantId });
    // Recorded again from the accepted invite, and the email went out.
    expect(emails()).toHaveLength(1);
    expect((await readProvisioning(first.tenantId))!.steps.invite_email!.status).toBe('ok');
  });

  test('⛔ under the production runtime role (cp_app, RLS enforced): a resumed already-seated requester still gets the email', async () => {
    // The invite lookup in `ensureSignupAdminHeld` reads RLS-scoped `tenant_invites`. Driven as owner
    // (every other test here) RLS is bypassed and a plain-`db` read passes; under cp_app with the
    // operator's own tenant in the GUC it saw NOTHING — success reported, email never sent.
    const [operatorHome] = await db.insert(tenants).values({ name: 'EAV Operator', slug: 'eav-operator' }).returning();
    const a = await pending('r7@eav-co.test', { company: 'EAV Rls' });
    const first = (await (await approveViaScreen(a.id)).json()) as { tenantId: string };
    await queryClient.unsafe(
      `UPDATE signup_approvals SET status = 'pending', decided_at = NULL WHERE id = '${a.id}';
       UPDATE tenants SET provisioning = (provisioning #- '{steps,invite_email}'::text[]) - 'signupAdmin'::text WHERE id = '${first.tenantId}';`,
    );
    kcCalls = [];
    const res = await withTenantDbAsRuntimeRoleForTests(operatorHome!.id, () =>
      decide(a.id, { action: 'approve', telegramUserId: 905 }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('approved');
    expect(emails()).toHaveLength(1);
    expect((await readProvisioning(first.tenantId))!.steps.invite_email!.status).toBe('ok');
  });

  test('⛔ an approve that died AFTER the workspace row existed (before any checkpoint) is resumed, never doubled', async () => {
    const a = await pending('r8@eav-co.test', { company: 'EAV Diedearly' });
    const first = (await (await approveViaScreen(a.id)).json()) as { tenantId: string };
    // Simulate death right after createTenant: no checkpoint, no seat, still pending.
    await queryClient.unsafe(
      `UPDATE signup_approvals SET status = 'pending', decided_at = NULL, assigned_tenant_id = NULL WHERE id = '${a.id}';
       DELETE FROM tenant_invites WHERE tenant_id = '${first.tenantId}';
       DELETE FROM users WHERE lower(email) = 'r8@eav-co.test';
       UPDATE tenants SET provisioning = (provisioning #- '{steps,invite_email}'::text[] #- '{steps,member_licence}'::text[] #- '{steps,member_seat}'::text[]) - 'signupAdmin'::text WHERE id = '${first.tenantId}';`,
    );
    kcCalls = [];
    const res = await decide(a.id, { action: 'approve', telegramUserId: 906 });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tenantId: string }).tenantId).toBe(first.tenantId);
    expect(await db.select().from(tenants).where(sql`slug LIKE 'eav-diedearly%'`)).toHaveLength(1);
    expect(emails()).toHaveLength(1);
  });

  test('the claim is token-scoped: a finished approve releases only its own claim; a taken-over claim decides nothing', async () => {
    const a = await pending('r9@eav-co.test', { company: 'EAV Token' });
    // Somebody else holds a LIVE claim with their own token: approve → 409, and their claim survives.
    const other = '00000000-0000-4000-8000-0000ea20c1a1';
    await queryClient.unsafe(
      `UPDATE signup_approvals SET approving_until = now() + interval '1 minute', approving_claim = '${other}' WHERE id = '${a.id}'`,
    );
    expect((await approveViaScreen(a.id)).status).toBe(409);
    const held = (await rowFor('r9@eav-co.test'))!;
    expect(held.approving_claim).toBe(other);
    expect(held.approving_until).not.toBeNull();
    // Their claim lapses; we take over and finish; the row ends with no claim.
    await queryClient.unsafe(`UPDATE signup_approvals SET approving_until = now() - interval '1 second' WHERE id = '${a.id}'`);
    expect((await approveViaScreen(a.id)).status).toBe(200);
    const done = (await rowFor('r9@eav-co.test'))!;
    expect(done.status).toBe('approved');
    expect(done.approving_claim).toBeNull();
  });

  test('⛔ one decider at a time across replicas: a live approve claim → screen 409, Telegram already_decided, reject 409', async () => {
    const a = await pending('r5@eav-co.test', { company: 'EAV Claimed' });
    await queryClient.unsafe(`UPDATE signup_approvals SET approving_until = now() + interval '1 minute' WHERE id = '${a.id}'`);
    const screen = await approveViaScreen(a.id);
    expect(screen.status).toBe(409);
    expect(((await screen.json()) as { error: string }).error).toBe('approval_in_progress');
    const tg = (await (await decide(a.id, { action: 'approve', telegramUserId: 903 })).json()) as { status: string; outcome: string };
    expect(tg).toMatchObject({ status: 'already_decided', outcome: 'in_progress' });
    currentUser = superAdmin;
    expect((await call('POST', `/api/signup-approvals/${a.id}/reject`, {})).status).toBe(409);
    expect(await db.select().from(tenants).where(sql`slug LIKE 'eav-claimed%'`)).toHaveLength(0);
    // An EXPIRED claim (a crashed approver) is taken over.
    await queryClient.unsafe(`UPDATE signup_approvals SET approving_until = now() - interval '1 second' WHERE id = '${a.id}'`);
    expect((await approveViaScreen(a.id)).status).toBe(200);
  });

  test('screen + Telegram approving the same row at once: ONE workspace, one approval', async () => {
    const a = await pending('r6@eav-co.test', { company: 'EAV Twice' });
    const [x, y] = await Promise.all([approveViaScreen(a.id), decide(a.id, { action: 'approve', telegramUserId: 904 })]);
    // The screen either wins (200) or is told someone is on it (409) / it is decided (400); Telegram
    // answers 200 approved or already_decided.
    expect([200, 400, 409]).toContain(x.status);
    expect(y.status).toBe(200);
    const tg = (await y.json()) as { status: string };
    expect(x.status === 200 ? ['already_decided'] : ['approved']).toContain(tg.status);
    expect(await db.select().from(tenants).where(sql`slug LIKE 'eav-twice%'`)).toHaveLength(1);
    expect((await rowFor('r6@eav-co.test'))!.status).toBe('approved');
  });

  test('a domain-matched signup names the matched workspace in Telegram (one-tap still founds a new one)', async () => {
    const p = newSignupPayload(
      { id: '00000000-0000-4000-8000-0000ea20f001', source: 'web', trust: 'intake', pendingTotal: 1, email: 'm@acme.test', name: 'M', company: null, matchedWorkspace: 'Acme Corp' },
      { botToken: 't', chatId: '-1', threadId: '1', apiBase: 'x', enabled: true },
    );
    const text = String(p.text);
    expect(text).toContain('Matches workspace: Acme Corp');
    expect(text).toContain('Approve here still creates a NEW workspace');
    const spans = (p.entities as Array<{ offset: number; length: number }>).map((e) => text.slice(e.offset, e.offset + e.length));
    expect(spans).toContain('Acme Corp');

    // End to end: an intake for a mapped domain carries the workspace name.
    process.env = { ...process.env, ...TG_ENV };
    const [ws] = await db.insert(tenants).values({ name: 'EAV Mapped Co', slug: 'eav-mapped' }).returning();
    await queryClient.unsafe(`INSERT INTO email_domain_tenants (domain, tenant_id) VALUES ('mapped.eav-co.test', '${ws!.id}') ON CONFLICT (domain) DO UPDATE SET tenant_id = EXCLUDED.tenant_id`);
    try {
      currentUser = intakeSa;
      const res = await call('POST', '/api/signup-approvals/intake', { email: 'x@mapped.eav-co.test', name: 'Map Ped', source: 'web' });
      expect(res.status).toBe(202);
      await __drainSignupTelegramForTests();
      expect(telegramSent.map((b) => String(b.text)).join('\n')).toContain('Matches workspace: EAV Mapped Co');
    } finally {
      await queryClient.unsafe(`DELETE FROM email_domain_tenants WHERE domain = 'mapped.eav-co.test'`);
    }
  });
});

// =================================================================================================
describe('the approve claim — heartbeat, ceiling, abort before irreversible steps', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const OTHER = '00000000-0000-4000-8000-0000ea20c1b2';
  function approveViaScreen(id: string) {
    currentUser = superAdmin;
    return call('POST', `/api/signup-approvals/${id}/approve`, { mode: 'new_tenant' });
  }
  const emails = () => kcCalls.filter((c) => c.kind === 'email');
  const creates = () => kcCalls.filter((c) => c.kind === 'create');
  async function userFor(email: string) {
    const [u] = await db.select().from(users).where(sql`lower(email) = lower(${email})`);
    return u;
  }
  async function errorOf(res: Response) {
    return ((await res.json()) as { error: string }).error;
  }

  test('the heartbeat renews the claim while the run is alive, and the claim is released at the end', async () => {
    __setApprovalClaimTimingForTests({ heartbeatMs: 20 });
    const a = await pending('h1@eav-co.test', { company: 'EAV Beat' });
    registerGate = makeGate();
    const g = registerGate;
    const run = approveViaScreen(a.id);
    await g.reached;
    const before = (await rowFor('h1@eav-co.test'))!.approving_until!;
    await sleep(120);
    const after = (await rowFor('h1@eav-co.test'))!.approving_until!;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
    g.release();
    expect((await run).status).toBe(200);
    const done = (await rowFor('h1@eav-co.test'))!;
    expect(done.status).toBe('approved');
    expect(done.approving_claim).toBeNull();
    expect(emails()).toHaveLength(1);
  });

  test('⛔ a heartbeat that finds the claim gone ABORTS the run before the seat: no identity, no seat, no email', async () => {
    __setApprovalClaimTimingForTests({ heartbeatMs: 20 });
    const a = await pending('h2@eav-co.test', { company: 'EAV Stolen' });
    registerGate = makeGate();
    const g = registerGate;
    const run = approveViaScreen(a.id);
    await g.reached;
    const ours = (await rowFor('h2@eav-co.test'))!.approving_claim!;
    // Taken over while the run is inside createTenant…
    await queryClient.unsafe(`UPDATE signup_approvals SET approving_claim = '${OTHER}' WHERE id = '${a.id}'`);
    await sleep(100); // …a heartbeat sees it
    // …and even with OUR token put back, the run stays aborted: it was the heartbeat that decided.
    await queryClient.unsafe(`UPDATE signup_approvals SET approving_claim = '${ours}' WHERE id = '${a.id}'`);
    g.release();
    const res = await run;
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('approval_claim_lost');
    expect(creates()).toHaveLength(0);
    expect(await userFor('h2@eav-co.test')).toBeUndefined();
    expect(emails()).toHaveLength(0);
    const row = (await rowFor('h2@eav-co.test'))!;
    expect(row.status).toBe('pending');
    expect(row.approving_claim).toBeNull(); // our token → released
  });

  test('⛔ a claim lost AFTER the seat aborts before the email; the next approve resumes and emails exactly once', async () => {
    __setApprovalClaimTimingForTests({ heartbeatMs: 20 });
    const a = await pending('h3@eav-co.test', { company: 'EAV Midway' });
    memberGate = makeGate();
    const g = memberGate;
    const run = approveViaScreen(a.id);
    await g.reached;
    await queryClient.unsafe(`UPDATE signup_approvals SET approving_claim = '${OTHER}' WHERE id = '${a.id}'`);
    await sleep(100);
    g.release();
    const res = await run;
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('approval_claim_lost');
    const u = (await userFor('h3@eav-co.test'))!;
    expect(u.tenant_id).not.toBeNull(); // the seat happened under a live claim
    const rec = (await readProvisioning(u.tenant_id!))!;
    expect(rec.steps.member_licence!.status).toBe('ok');
    expect(rec.steps.invite_email!.status).not.toBe('ok');
    expect(emails()).toHaveLength(0);
    expect((await rowFor('h3@eav-co.test'))!.approving_claim).toBe(OTHER); // theirs, untouched

    // Their claim lapses; the next approve resumes INTO the same workspace and sends ONE email.
    __setApprovalClaimTimingForTests(undefined);
    await queryClient.unsafe(`UPDATE signup_approvals SET approving_until = now() - interval '1 second' WHERE id = '${a.id}'`);
    const again = await approveViaScreen(a.id);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { tenantId: string }).tenantId).toBe(u.tenant_id!);
    expect(await db.select().from(tenants).where(sql`slug LIKE 'eav-midway%'`)).toHaveLength(1);
    await reconcileProvisioning();
    expect(emails()).toHaveLength(1);
    expect((await rowFor('h3@eav-co.test'))!.status).toBe('approved');
  });

  test('⛔ the ceiling ABORTS the run (Telegram gets a clear 502); the next approve resumes and completes exactly once', async () => {
    process.env = { ...process.env, ...TG_ENV };
    __setApprovalClaimTimingForTests({ heartbeatMs: 20, ceilingMs: 60 });
    const a = await pending('h4@eav-co.test', { company: 'EAV Ceiling' });
    registerGate = makeGate();
    const g = registerGate;
    const run = decide(a.id, { action: 'approve', telegramUserId: 950 });
    await g.reached;
    await sleep(150); // past the ceiling: the heartbeat stops renewing and aborts
    g.release();
    const res = await run;
    expect(res.status).toBe(502);
    const body = (await res.json()) as { status: string; code: string; summary: string };
    expect(body).toMatchObject({ status: 'failed', code: 'approval_claim_lost' });
    expect(body.summary).toContain('ceiling_reached');
    expect(creates()).toHaveLength(0);
    expect(await userFor('h4@eav-co.test')).toBeUndefined();
    expect(emails()).toHaveLength(0);
    const row = (await rowFor('h4@eav-co.test'))!;
    expect(row.status).toBe('pending');
    expect(row.approving_claim).toBeNull(); // released at once: no 5-min wait to resume

    __setApprovalClaimTimingForTests(undefined);
    const again = await decide(a.id, { action: 'approve', telegramUserId: 950 });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe('approved');
    expect(await db.select().from(tenants).where(sql`slug LIKE 'eav-ceiling%'`)).toHaveLength(1);
    await reconcileProvisioning();
    expect(creates()).toHaveLength(1);
    expect(emails()).toHaveLength(1);
    expect((await userFor('h4@eav-co.test'))!.tenant_id).not.toBeNull();
  });

  test('⛔ reject refuses while the claim is live, lands only after it lapses — and then the old run seats nobody and sends nothing', async () => {
    // The heartbeat "stopped" (as at the ceiling): no renewal while the run is held.
    __setApprovalClaimTimingForTests({ heartbeatMs: 10 * 60_000 });
    const a = await pending('h5@eav-co.test', { company: 'EAV Lapsed' });
    registerGate = makeGate();
    const g = registerGate;
    const run = approveViaScreen(a.id);
    await g.reached;
    currentUser = superAdmin;
    expect((await call('POST', `/api/signup-approvals/${a.id}/reject`, {})).status).toBe(409); // live claim
    await queryClient.unsafe(`UPDATE signup_approvals SET approving_until = now() - interval '1 second' WHERE id = '${a.id}'`);
    currentUser = superAdmin;
    expect((await call('POST', `/api/signup-approvals/${a.id}/reject`, {})).status).toBe(200);
    g.release();
    const res = await run;
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('approval_claim_lost');
    expect(creates()).toHaveLength(0);
    expect(await userFor('h5@eav-co.test')).toBeUndefined();
    expect(emails()).toHaveLength(0);
    expect((await rowFor('h5@eav-co.test'))!.status).toBe('rejected');
  });

  test('⛔ reject after a lapse that follows the seat: the workspace is offboarded, the in-flight licence revoked, no email', async () => {
    __setApprovalClaimTimingForTests({ heartbeatMs: 10 * 60_000 });
    const a = await pending('h6@eav-co.test', { company: 'EAV Lateject' });
    memberGate = makeGate();
    const g = memberGate;
    const run = approveViaScreen(a.id);
    await g.reached;
    const u = (await userFor('h6@eav-co.test'))!;
    const tenantId = u.tenant_id!;
    await queryClient.unsafe(`UPDATE signup_approvals SET approving_until = now() - interval '1 second' WHERE id = '${a.id}'`);
    currentUser = superAdmin;
    expect((await call('POST', `/api/signup-approvals/${a.id}/reject`, {})).status).toBe(200);
    g.release(); // the member mint that was in flight lands AFTER the offboard…
    const res = await run;
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('approval_claim_lost');
    expect(emails()).toHaveLength(0);
    // …and is revoked by the run itself: a rejected signup keeps no live licence.
    const rec = (await readProvisioning(tenantId))!;
    expect(rec.steps.member_licence).toMatchObject({ status: 'failed', code: 'signup_rejected', nextAttemptAt: null });
    expect(rec.signupAdmin).toBeUndefined();
    expect(await liveEntitlements(u.id)).toBe(0);
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t!.offboarded_at).not.toBeNull();
    await reconcileProvisioning();
    expect(emails()).toHaveLength(0);
    expect((await rowFor('h6@eav-co.test'))!.status).toBe('rejected');
  });
});

// =================================================================================================
describe('an approve that aborted after the seat — decision gate, reject offboards (review fixes 2)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const OTHER = '00000000-0000-4000-8000-0000ea20c1b3';
  function approveViaScreen(id: string) {
    currentUser = superAdmin;
    return call('POST', `/api/signup-approvals/${id}/approve`, { mode: 'new_tenant' });
  }
  function reject(id: string) {
    currentUser = superAdmin;
    return call('POST', `/api/signup-approvals/${id}/reject`, {});
  }
  const emails = () => kcCalls.filter((c) => c.kind === 'email');
  async function userFor(email: string) {
    const [u] = await db.select().from(users).where(sql`lower(email) = lower(${email})`);
    return u;
  }
  async function errorOf(res: Response) {
    return ((await res.json()) as { error: string }).error;
  }
  async function makeDue(tenantId: string) {
    await queryClient.unsafe(
      `UPDATE tenants SET provisioning = jsonb_set(jsonb_set(provisioning,
          '{steps,member_licence,nextAttemptAt}', to_jsonb(now() - interval '1 minute')),
          '{steps,invite_email,nextAttemptAt}', to_jsonb(now() - interval '1 minute'))
        WHERE id = '${tenantId}'`,
    );
  }
  /** Approve until the member mint, take the claim over there so the run aborts after the seat, then
   *  let the takeover lapse: the row is `pending` with NO live claim. `failMint` → the member licence
   *  is left pending too (licences down at that moment). */
  async function abortAfterSeat(email: string, company: string, failMint: boolean) {
    __setApprovalClaimTimingForTests({ heartbeatMs: 20 });
    const a = await pending(email, { company });
    failMember = failMint;
    memberGate = makeGate();
    const g = memberGate;
    const run = approveViaScreen(a.id);
    await g.reached;
    await queryClient.unsafe(`UPDATE signup_approvals SET approving_claim = '${OTHER}' WHERE id = '${a.id}'`);
    await sleep(100);
    g.release();
    const res = await run;
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('approval_claim_lost');
    failMember = false;
    __setApprovalClaimTimingForTests(undefined);
    await queryClient.unsafe(
      `UPDATE signup_approvals SET approving_claim = NULL, approving_until = now() - interval '1 second' WHERE id = '${a.id}'`,
    );
    const u = (await userFor(email))!;
    expect(u.tenant_id).not.toBeNull();
    return { approval: a, user: u, tenantId: u.tenant_id! };
  }

  test('⛔ pending WITHOUT a claim: the tick neither licenses nor emails (deferred, no attempt counted); a later approve completes exactly once', async () => {
    const { approval, user, tenantId } = await abortAfterSeat('g1@eav-co.test', 'EAV Gate', true);
    const before = (await readProvisioning(tenantId))!;
    expect(before.steps.member_licence!.status).toBe('pending');
    const attempts = before.steps.member_licence!.attempts;
    await makeDue(tenantId);
    const calls = licenceCalls;
    await reconcileProvisioning();
    await reconcileProvisioning();
    const rec = (await readProvisioning(tenantId))!;
    expect(rec.steps.member_licence).toMatchObject({ status: 'pending', code: 'waiting_for_approval', attempts });
    expect(rec.steps.invite_email).toMatchObject({ status: 'pending', code: 'waiting_for_approval' });
    expect(Date.parse(rec.steps.member_licence!.nextAttemptAt!)).toBeGreaterThan(Date.now());
    expect(licenceCalls).toBe(calls); // not one licences call
    expect(await liveEntitlements(user.id)).toBe(0);
    expect(emails()).toHaveLength(0);
    expect(rec.signupAdmin?.email).toBe('g1@eav-co.test');
    // A super_admin's Retry is held to the same gate.
    await retryProvisioningStep(tenantId, 'invite_email', { actorId: SADMIN_ID });
    expect(emails()).toHaveLength(0);

    // Approved later: resumes into the SAME workspace, licenses and emails once…
    const again = await approveViaScreen(approval.id);
    expect(again.status).toBe(200);
    expect(((await again.json()) as { tenantId: string }).tenantId).toBe(tenantId);
    expect(emails()).toHaveLength(1);
    expect((await rowFor('g1@eav-co.test'))!.status).toBe('approved');
    // …and the tick, even with both steps forced due, does nothing more.
    await makeDue(tenantId);
    await reconcileProvisioning();
    expect(emails()).toHaveLength(1);
    expect(await liveEntitlements(user.id)).toBe(1);
  });

  test('⛔ reject after a post-seat abort: workspace offboarded, licence revoked, credential-less identity DELETED, no email, PII cleared — and the same email signs up again with a fresh identity', async () => {
    process.env = { ...process.env, ...TG_ENV };
    const { approval, user, tenantId } = await abortAfterSeat('g2@eav-co.test', 'EAV Undo', false);
    expect(await liveEntitlements(user.id)).toBe(1); // the run licensed before it lost the claim
    const res = await reject(approval.id);
    expect(res.status).toBe(200);
    expect((await rowFor('g2@eav-co.test'))!.status).toBe('rejected');
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t!.offboarded_at).not.toBeNull();
    expect(t!.status).toBe('suspended');
    expect((await userFor('g2@eav-co.test'))!.deleted_at).not.toBeNull(); // the seat is gone
    expect(await liveEntitlements(user.id)).toBe(0); // the member licence is revoked
    const rec = (await readProvisioning(tenantId))!;
    expect(rec.signupAdmin).toBeUndefined(); // PII cleared
    expect(JSON.stringify(rec)).not.toContain('g2@eav-co.test');
    // CP minted it and nobody ever set a credential: nothing to preserve → deleted, never disabled.
    expect(kcCalls.filter((c) => c.kind === 'delete')).toEqual([{ kind: 'delete', sub: user.id }]);
    expect(kcCalls.filter((c) => c.kind === 'disable' || c.kind === 'state')).toHaveLength(0);
    expect(kcStore.has(user.id)).toBe(false);
    // Recorded: the reject names what it did; the offboard has its own row.
    const audits = await db.select().from(auditLog).where(eq(auditLog.tenant_id, tenantId));
    const rej = audits.find((r) => r.action === 'signup.reject')!;
    expect(rej.metadata).toMatchObject({
      foundedTenantId: tenantId,
      workspaceOffboarded: true,
      offboardError: null,
      keycloakIdentity: 'deleted',
    });
    expect(audits.find((r) => r.action === 'tenant.offboard')?.metadata).toMatchObject({ reason: `signup_rejected:${approval.id}` });
    // No email, ever — not from the tick, not from a Retry (offboarded = read-only).
    await reconcileProvisioning();
    expect(emails()).toHaveLength(0);
    await expect(retryProvisioningStep(tenantId, 'invite_email', { actorId: SADMIN_ID })).rejects.toMatchObject({
      code: 'tenant_offboarded',
    });
    // Rejecting again is the offboard's idempotent repair, not a second decision: 200, nothing re-done.
    expect((await reject(approval.id)).status).toBe(200);
    expect(kcCalls.filter((c) => c.kind === 'delete')).toHaveLength(1);
    expect((await rowFor('g2@eav-co.test'))!.status).toBe('rejected');

    // Re-submission of the same address is admitted (no "already belongs to a workspace")…
    currentUser = intakeSa;
    const again = await call('POST', '/api/signup-approvals/intake', {
      name: 'Eve Again',
      email: 'g2@eav-co.test',
      company: 'EAV Undo Two',
      source: 'web',
    });
    expect(again.status).toBe(202);
    expect(((await again.json()) as { status: string }).status).toBe('queued');
    const [fresh] = await db
      .select()
      .from(signupApprovals)
      .where(sql`lower(email) = 'g2@eav-co.test' and status = 'pending'`);
    // …and can be approved into a NEW workspace, on a FRESH identity, seated + licensed + emailed.
    const ok = await approveViaScreen(fresh!.id);
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { tenantId: string; seatedAtApproval: boolean; invite: { emailDelivery: string } };
    expect(okBody.tenantId).not.toBe(tenantId);
    expect(okBody.seatedAtApproval).toBe(true);
    expect(okBody.invite.emailDelivery).toBe('keycloak_actions');
    const seatedNow = (await db
      .select()
      .from(users)
      .where(sql`lower(email) = 'g2@eav-co.test' AND deleted_at IS NULL`))[0]!;
    expect(seatedNow.id).not.toBe(user.id);
    expect(seatedNow.tenant_id).toBe(okBody.tenantId);
    expect(kcStore.get(seatedNow.id)?.rep.enabled).toBe(true);
    expect(emails()).toEqual([expect.objectContaining({ sub: seatedNow.id, actions: ['UPDATE_PASSWORD', 'VERIFY_EMAIL'] })]);
    expect(await liveEntitlements(seatedNow.id)).toBe(1);
  });

  /** Intake the same address again (after its earlier signup was rejected) and return the new row. */
  async function resubmit(email: string, company: string) {
    currentUser = intakeSa;
    const res = await call('POST', '/api/signup-approvals/intake', { name: 'Eve Again', email, company, source: 'web' });
    expect(res.status).toBe(202);
    const [row] = await db
      .select()
      .from(signupApprovals)
      .where(sql`lower(email) = lower(${email}) and status = 'pending'`);
    return row!;
  }

  test('⛔ reject after the person SET A PASSWORD: identity disabled + marked (other attributes kept); the re-signup re-enables it and the ordinary invite works', async () => {
    const { approval, user, tenantId } = await abortAfterSeat('g6@eav-co.test', 'EAV Pw', false);
    kcSetPassword(user.id);
    kcRmw(user.id, { locale: 'nl', signup_app: 'commonpractice' });
    const res = await reject(approval.id);
    expect(res.status).toBe(200);
    const stored = kcStore.get(user.id)!.rep;
    expect(stored.enabled).toBe(false);
    expect(stored.attributes).toEqual({ locale: ['nl'], signup_app: [`cp_rejected:${approval.id}`] });
    expect(kcCalls.filter((c) => c.kind === 'delete')).toHaveLength(0);
    const audits = await db.select().from(auditLog).where(eq(auditLog.tenant_id, tenantId));
    expect(audits.find((r) => r.action === 'signup.reject')!.metadata).toMatchObject({ keycloakIdentity: 'disabled' });

    // Re-signup → approve: the marked identity is re-enabled, the marker cleared, and — it holds a
    // password — it takes the ORDINARY invite (not seated early, CP's own mail, never Keycloak's).
    const again = await resubmit('g6@eav-co.test', 'EAV Pw Two');
    const ok = await approveViaScreen(again.id);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { tenantId: string; seatedAtApproval: boolean; invite: { id: string; emailDelivery: string; inviteUrl: string } };
    expect(body.tenantId).not.toBe(tenantId);
    expect(body.seatedAtApproval).toBe(false);
    expect(['sent', 'failed']).toContain(body.invite.emailDelivery);
    expect(kcCalls.filter((c) => c.kind === 'create')).toHaveLength(1); // only the first signup's mint
    const after = kcStore.get(user.id)!.rep;
    expect(after.enabled).toBe(true);
    expect(after.attributes).toEqual({ locale: ['nl'] });
    const [inv] = await db.select().from(tenantInvites).where(eq(tenantInvites.id, body.invite.id));
    expect(inv).toMatchObject({ status: 'pending', keycloak_sub: null });
    // The person signs in with their password and accepts: the old tombstone is restored into the new workspace.
    const token = new URL(body.invite.inviteUrl).searchParams.get('token')!;
    const out = await acceptInvite(
      { id: user.id, email: 'g6@eav-co.test', name: 'Eve Again', roles: [], emailVerified: true },
      { token },
    );
    expect(out).toEqual({ tenantId: body.tenantId, role: 'tenant_admin' });
    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u).toMatchObject({ tenant_id: body.tenantId, deleted_at: null });
  });

  test('a reject-marked identity with NO credential takes the minted path on re-signup: re-enabled, seated, licensed, set-password email', async () => {
    const { approval, user } = await abortAfterSeat('g7@eav-co.test', 'EAV Unknown', false);
    // The SA could not read credentials at reject time (403 → unknown): never deleted on a guess.
    kcStore.get(user.id)!.creds = null;
    expect((await reject(approval.id)).status).toBe(200);
    expect(kcStore.get(user.id)!.rep).toMatchObject({ enabled: false, attributes: { signup_app: [`cp_rejected:${approval.id}`] } });
    // Readable again at the re-signup, and positively empty.
    kcStore.get(user.id)!.creds = [];
    const again = await resubmit('g7@eav-co.test', 'EAV Unknown Two');
    const ok = await approveViaScreen(again.id);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { tenantId: string; seatedAtApproval: boolean; invite: { emailDelivery: string } };
    expect(body.seatedAtApproval).toBe(true);
    expect(body.invite.emailDelivery).toBe('keycloak_actions');
    expect(kcStore.get(user.id)!.rep.enabled).toBe(true);
    expect(kcStore.get(user.id)!.rep.attributes?.signup_app).toEqual(['commonpractice']); // the email's own value
    const [u] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u).toMatchObject({ tenant_id: body.tenantId, deleted_at: null, tenant_role: 'tenant_admin' });
    expect(await liveEntitlements(user.id)).toBe(1);
    expect(emails()).toEqual([expect.objectContaining({ sub: user.id, actions: ['UPDATE_PASSWORD', 'VERIFY_EMAIL'] })]);
    const [inv] = await db.select().from(tenantInvites).where(sql`tenant_id = ${body.tenantId}`);
    expect(inv).toMatchObject({ status: 'accepted', keycloak_sub: user.id });
  });

  test('⛔ an identity disabled by SOMEBODY ELSE (no CP marker) is never re-enabled: approve 409 identity_disabled (screen), failed + code (Telegram)', async () => {
    kcSeed({
      id: '00000000-0000-4000-8000-0000ea20f001',
      username: 'g8@eav-co.test',
      email: 'g8@eav-co.test',
      enabled: false,
      emailVerified: true,
      attributes: { locale: ['de'] },
      requiredActions: [],
    });
    const a = await pending('g8@eav-co.test', { company: 'EAV Foreign' });
    const res = await approveViaScreen(a.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('identity_disabled');
    expect(kcStore.get('00000000-0000-4000-8000-0000ea20f001')!.rep).toMatchObject({ enabled: false, attributes: { locale: ['de'] } });
    expect(kcCalls.filter((c) => c.kind === 'state' || c.kind === 'create' || c.kind === 'email')).toHaveLength(0);
    expect((await rowFor('g8@eav-co.test'))!.status).toBe('pending');
    const tg = await decide(a.id, { action: 'approve', telegramUserId: 42 });
    const tgBody = (await tg.json()) as { status: string; summary: string };
    expect(tgBody.status).toBe('failed');
    expect(tgBody.summary).toContain('identity_disabled');
    expect(kcStore.get('00000000-0000-4000-8000-0000ea20f001')!.rep.enabled).toBe(false);
  });

  test('a user profile that DROPS the marker is recorded as disabled_unmarked (the re-signup then 409s instead of a dead invite)', async () => {
    const { approval, user, tenantId } = await abortAfterSeat('g9@eav-co.test', 'EAV Dropped', false);
    kcSetPassword(user.id);
    kcDeclared = new Set(['locale']);
    expect((await reject(approval.id)).status).toBe(200);
    expect(kcStore.get(user.id)!.rep).toMatchObject({ enabled: false, attributes: {} });
    const audits = await db.select().from(auditLog).where(eq(auditLog.tenant_id, tenantId));
    expect(audits.find((r) => r.action === 'signup.reject')!.metadata).toMatchObject({ keycloakIdentity: 'disabled_unmarked' });
    const again = await resubmit('g9@eav-co.test', 'EAV Dropped Two');
    const res = await approveViaScreen(again.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('identity_disabled');
  });

  test('⛔ reject is REFUSED (409) when the founded workspace has another member — nothing decided, nothing offboarded', async () => {
    const { approval, tenantId } = await abortAfterSeat('g3@eav-co.test', 'EAV Busy', false);
    await db.insert(users).values({
      id: '00000000-0000-4000-8000-0000ea20d001',
      email: 'g3-colleague@eav-co.test',
      name: 'Col League',
      tenant_id: tenantId,
      tenant_role: 'member',
    } as typeof users.$inferInsert);
    const res = await reject(approval.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; blockers: string[] };
    expect(body.error).toBe('signup_workspace_in_use');
    expect(body.blockers).toContain('other_members:1');
    expect((await rowFor('g3@eav-co.test'))!.status).toBe('pending');
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t!.offboarded_at).toBeNull();
    expect((await userFor('g3@eav-co.test'))!.deleted_at).toBeNull();
    expect(kcCalls.filter((c) => c.kind === 'disable')).toHaveLength(0);
  });

  test('⛔ reject is REFUSED (409) when the founded workspace holds user data', async () => {
    const { approval, tenantId } = await abortAfterSeat('g4@eav-co.test', 'EAV Data', false);
    // A flow the requester built (owned by the seated requester): user data.
    const owner = (await userFor('g4@eav-co.test'))!.id;
    await queryClient.unsafe(
      `INSERT INTO flows (name, owner_id, graph, tenant_id) VALUES ('eav flow', '${owner}', '{}'::jsonb, '${tenantId}')`,
    );
    const res = await reject(approval.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; blockers: string[] };
    expect(body.error).toBe('signup_workspace_in_use');
    expect(body.blockers).toEqual(['data:flows']);
    expect((await rowFor('g4@eav-co.test'))!.status).toBe('pending');
    await queryClient.unsafe(`DELETE FROM flows WHERE tenant_id = '${tenantId}'`);
  });

  test('⛔ the claim is re-confirmed before createTenant: a run that lost it founds NOTHING', async () => {
    __setApprovalClaimTimingForTests({ ceilingMs: 0 });
    const a = await pending('g5@eav-co.test', { company: 'EAV Nofound' });
    const res = await approveViaScreen(a.id);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe('approval_claim_lost');
    expect(await db.select().from(tenants).where(sql`slug LIKE 'eav-nofound%'`)).toHaveLength(0);
    expect(licenceCalls).toBe(0);
    expect((await rowFor('g5@eav-co.test'))!.status).toBe('pending');
  });

  // ---- D1: "user data" = what a PERSON made, not which table a row is in ----

  const DAY = 24 * 60 * 60_000;
  /**
   * EVERY background job the backend runs (server.ts boot: each start* scheduler), each body exactly
   * as its scheduler runs it once it wins `claimTick` — unclaimed here, so a claim another test file
   * stamped can never turn one into a silent no-op:
   *   cycle tick · sandbox idle sweep · run-lease reconciler · audit export · translation drain ·
   *   onboarding-integrity (registration, licence repair, re-home, pending revokes, seat repair, stuck
   *   seats, strand census, invite expiry, platform inference, provisioning steps) · signup digest ·
   *   metering outbox drainer · metering reconciler.
   * The CALENDAR-driven one — the cycle tick, the job that wrote the regression's row — runs as of
   * `now` (now, +1d, +2d): its per-tenant body for this workspace (`tickTenantCycles`, what
   * `tickCycles` runs for every `engineTenantIds` tenant; asserted below that it IS one), so the
   * shared test DB's other tenants are not moved into the future. The rest are lease / idle / queue
   * driven, not calendar driven, and run at the real clock (a fresh workspace has no sandbox, run,
   * queued translation or outbox row for a shifted clock to change).
   * Not driven: the connector LISTEN session + its opt-in boot reconcile (they react to storage
   * connectors on datasets, which a fresh workspace cannot have), the tool-rendezvous ticker and SSE
   * heartbeats (in-memory / request-scoped, no tenant rows).
   */
  async function runEveryBackgroundTick(tenantId: string, now: Date) {
    const ran: string[] = [];
    expect(await engineTenantIds(db)).toContain(tenantId);
    await runAsSystem('scheduler-tick', () => tickTenantCycles(now, tenantId));
    ran.push('cycle');
    await runAsSystem('scheduler-tick', () => sweepIdleSandboxes(db, new Date()));
    ran.push('sandbox_sweep');
    await runAsSystem('scheduler-tick', () => reconcileStaleRuns(new Date()));
    ran.push('run_lease_reconciler');
    const exportStart = new Date();
    await runAuditExportTick(new Date(), { uploader: async () => {} });
    // Exports are platform-wide (no tenant_id); drop ours so audit-export.test.ts sees its own world.
    await queryClient.unsafe(`DELETE FROM audit_exports WHERE created_at >= '${exportStart.toISOString()}'`);
    ran.push('audit_export');
    await runAsSystem('scheduler-tick', () => processPendingBatch(new Date(), db, 50, async (text) => text));
    ran.push('translation');
    await runAsSystem('scheduler-tick', () => __runOnboardingIntegrityTickForTests());
    ran.push('onboarding_integrity');
    await runSignupDigestOnce();
    ran.push('signup_digest');
    await runAsSystem('scheduler-tick', () => drainMeteringOutbox());
    ran.push('metering_outbox');
    // Measures only (writes nothing); refuses loudly when billing is unconfigured, which is fine here.
    await reconcileMeteringDay(previousUtcDay(new Date())).catch(() => null);
    ran.push('metering_reconcile');
    return ran;
  }
  async function ageTwoDays(tenantId: string) {
    const start = Date.now();
    for (const d of [0, 1, 2]) {
      expect(await runEveryBackgroundTick(tenantId, new Date(start + d * DAY + 60_000))).toHaveLength(9);
    }
  }
  async function cyclesOf(tenantId: string) {
    return (await queryClient.unsafe(`SELECT count(*)::int AS n FROM marketplace_cycles WHERE tenant_id = '${tenantId}'`)) as unknown as {
      n: number;
    }[];
  }

  test('the table rules cover the live catalogue EXACTLY: every tenant_id table has an explicit decision', async () => {
    const rows = (await queryClient.unsafe(`
      SELECT c.table_name AS name FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
       WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' ORDER BY 1`)) as unknown as { name: string }[];
    expect(Object.keys(SIGNUP_WORKSPACE_TABLE_RULES).sort()).toEqual(rows.map((r) => r.name));
    // …and every `authored` column really exists on its table.
    for (const [table, rule] of Object.entries(SIGNUP_WORKSPACE_TABLE_RULES)) {
      if (rule.kind !== 'authored') continue;
      const [hit] = (await queryClient.unsafe(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${rule.column}'`,
      )) as unknown as { n: number }[];
      expect({ table, column: rule.column, present: hit!.n }).toEqual({ table, column: rule.column, present: 1 });
    }
  });

  test('⛔ D1: two days of EVERY background tick on the aborted workspace (cycle rows included) — the reject still succeeds', async () => {
    process.env = { ...process.env, ...TG_ENV };
    const { approval, user, tenantId } = await abortAfterSeat('g10@eav-co.test', 'EAV Ticks', false);
    await ageTwoDays(tenantId);
    // The regression's precondition really happened: the cycle tick wrote into the workspace.
    expect((await cyclesOf(tenantId))[0]!.n).toBeGreaterThan(0);
    expect(await signupWorkspaceBlockers(tenantId, 'g10@eav-co.test')).toEqual([]);
    const res = await reject(approval.id);
    expect(res.status).toBe(200);
    expect((await rowFor('g10@eav-co.test'))!.status).toBe('rejected');
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t!.offboarded_at).not.toBeNull();
    expect(await liveEntitlements(user.id)).toBe(0);
    expect(kcStore.has(user.id)).toBe(false);
  });

  test('⛔ D1: after the same two days, ONE thing the requester made (a challenge in the tick\'s cycle) still blocks the reject', async () => {
    const { approval, user, tenantId } = await abortAfterSeat('g11@eav-co.test', 'EAV Ticks Made', false);
    await ageTwoDays(tenantId);
    await queryClient.unsafe(
      `INSERT INTO challenges (title, work_area, submitter_id, tenant_id) VALUES ('eav idea', 'ops', '${user.id}', '${tenantId}')`,
    );
    const res = await reject(approval.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; blockers: string[] };
    expect(body.error).toBe('signup_workspace_in_use');
    expect(body.blockers).toEqual(['data:challenges']);
    expect((await rowFor('g11@eav-co.test'))!.status).toBe('pending');
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t!.offboarded_at).toBeNull();
    expect(await liveEntitlements(user.id)).toBe(1);
  });

  // ---- D2: a reject whose offboard failed at the fatal licence revoke is finished by rejecting again ----

  test('⛔ D2: the tenant-licence revoke FAILS (licences down) → 502, rejected, half-offboarded; rejecting again finishes licence, seat and identity', async () => {
    const { approval, user, tenantId } = await abortAfterSeat('g12@eav-co.test', 'EAV Revoke', false);
    expect(await liveEntitlements(user.id)).toBe(1);
    failRevoke = true;
    const first = await reject(approval.id);
    expect(first.status).toBe(502);
    expect(revokeRefusals).toBeGreaterThan(0); // the fault was really hit at the call
    expect((await rowFor('g12@eav-co.test'))!.status).toBe('rejected');
    // Half-way: offboarded_at committed, but the licence, the seat and the minted identity are not done.
    const [half] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(half!.offboarded_at).not.toBeNull();
    expect(half!.license_token_encrypted).not.toBeNull();
    expect(await liveEntitlements(user.id)).toBe(1);
    expect(kcStore.get(user.id)?.rep.enabled).toBe(true);

    // Still down: the repair 502s again and changes nothing.
    const stillDown = await reject(approval.id);
    expect(stillDown.status).toBe(502);
    expect(kcStore.has(user.id)).toBe(true);

    failRevoke = false;
    const second = await reject(approval.id);
    expect(second.status).toBe(200);
    const [done] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(done!.license_token_encrypted).toBeNull(); // the tenant licence is revoked
    expect(done!.offboarded_at!.getTime()).toBe(half!.offboarded_at!.getTime()); // original instant kept
    expect(await liveEntitlements(user.id)).toBe(0); // the seat is released
    expect(kcStore.has(user.id)).toBe(false); // the credential-less minted identity is gone
    const repairs = (await db.select().from(auditLog).where(eq(auditLog.tenant_id, tenantId))).filter(
      (r) => r.action === 'signup.reject_repair',
    );
    expect(repairs.map((r) => (r.metadata as { keycloakIdentity: string | null }).keycloakIdentity)).toContain('deleted');
    expect(emails()).toHaveLength(0);

    // Idempotent: once more is a no-op success (the identity is already gone, nothing re-deleted).
    const deletes = kcCalls.filter((c) => c.kind === 'delete').length;
    expect((await reject(approval.id)).status).toBe(200);
    expect(kcCalls.filter((c) => c.kind === 'delete').length).toBe(deletes);
    // A signup that was rejected WITHOUT a founded workspace still answers 400 on a second reject.
    const plain = await pending('g12b@eav-co.test');
    expect((await reject(plain.id)).status).toBe(200);
    expect((await reject(plain.id)).status).toBe(400);
  });

  test('⛔ D2: the repair re-checks the blockers — a workspace a super_admin brought back into use is NOT offboarded further', async () => {
    const { approval, user, tenantId } = await abortAfterSeat('g13@eav-co.test', 'EAV Reused', false);
    failRevoke = true;
    expect((await reject(approval.id)).status).toBe(502);
    failRevoke = false;
    await db.insert(users).values({
      id: '00000000-0000-4000-8000-0000ea20d013',
      email: 'g13-colleague@eav-co.test',
      name: 'Re Used',
      tenant_id: tenantId,
      tenant_role: 'member',
    } as typeof users.$inferInsert);
    const res = await reject(approval.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; blockers: string[] };
    expect(body.error).toBe('signup_workspace_in_use');
    expect(body.blockers).toContain('other_members:1');
    expect(await liveEntitlements(user.id)).toBe(1); // nothing further done
    expect(kcStore.has(user.id)).toBe(true);
  });

  // ---- review fixes 3: the cleanup is on the ROW, the tick finishes it, the screen lists it ----

  async function repairOf(email: string) {
    return (await rowFor(email))!.reject_repair!;
  }
  async function makeRepairDue(id: string) {
    await queryClient.unsafe(
      `UPDATE signup_approvals SET reject_repair = reject_repair || jsonb_build_object('nextAttemptAt', to_jsonb(now() - interval '1 minute')) WHERE id = '${id}'`,
    );
  }
  const tick = () => runAsSystem('scheduler-tick', () => __runOnboardingIntegrityTickForTests());
  async function needsRepairList() {
    currentUser = superAdmin;
    const res = await call('GET', '/api/signup-approvals?status=needs_repair');
    expect(res.status).toBe(200);
    return ((await res.json()) as { approvals: Array<{ id: string; reject_repair: { state: string } }> }).approvals;
  }

  test('⛔ R1: an injected tenant-licence revoke failure is finished by the TICK — no second reject needed; the screen lists it meanwhile', async () => {
    const { approval, user, tenantId } = await abortAfterSeat('r1@eav-co.test', 'EAV Tickfix', false);
    failRevoke = true;
    expect((await reject(approval.id)).status).toBe(502);
    expect(revokeRefusals).toBeGreaterThan(0);
    let rr = await repairOf('r1@eav-co.test');
    expect(rr).toMatchObject({ state: 'pending', tenantId, attempts: 1 });
    expect(rr.lastError).toContain('licences down');
    expect(rr.claimedUntil ?? null).toBeNull(); // the lease is released after the run
    expect((await needsRepairList()).map((a) => a.id)).toContain(approval.id);

    // A tick while licences is STILL down: retried (attempts 2), still pending, nothing destroyed.
    await makeRepairDue(approval.id);
    await tick();
    rr = await repairOf('r1@eav-co.test');
    expect(rr).toMatchObject({ state: 'pending', attempts: 2 });
    expect(Date.parse(rr.nextAttemptAt!)).toBeGreaterThan(Date.now()); // backed off
    expect(await liveEntitlements(user.id)).toBe(1);
    // Not due → the tick leaves it alone.
    const refusals = revokeRefusals;
    await tick();
    expect(revokeRefusals).toBe(refusals);

    // Licences back; the tick finishes it on its own: licence, seat, identity.
    failRevoke = false;
    await makeRepairDue(approval.id);
    await tick();
    rr = await repairOf('r1@eav-co.test');
    expect(rr).toMatchObject({ state: 'done', attempts: 3, lastError: null, keycloakIdentity: 'deleted' });
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t!.license_token_encrypted).toBeNull();
    expect(await liveEntitlements(user.id)).toBe(0);
    expect(kcStore.has(user.id)).toBe(false);
    expect((await needsRepairList()).map((a) => a.id)).not.toContain(approval.id);
    const repairs = (await db.select().from(auditLog).where(eq(auditLog.tenant_id, tenantId))).filter(
      (r) => r.action === 'signup.reject_repair',
    );
    expect(repairs.find((r) => r.result === 'offboarded')?.metadata).toMatchObject({
      via: 'onboarding-integrity',
      keycloakIdentity: 'deleted',
    });
    expect(emails()).toHaveLength(0);
    // Done stays done: another tick, and a Retry, do nothing.
    const calls = revokeCalls;
    await tick();
    expect((await reject(approval.id)).status).toBe(200);
    expect(revokeCalls).toBe(calls);
  });

  test('⛔ R1: the tick re-checks the blockers — a workspace in use goes BLOCKED (audited, listed, nothing destroyed); Retry answers 409', async () => {
    const { approval, user, tenantId } = await abortAfterSeat('r2@eav-co.test', 'EAV Tickblock', false);
    failRevoke = true;
    expect((await reject(approval.id)).status).toBe(502);
    failRevoke = false;
    await db.insert(users).values({
      id: '00000000-0000-4000-8000-0000ea20d021',
      email: 'r2-colleague@eav-co.test',
      name: 'Back In',
      tenant_id: tenantId,
      tenant_role: 'member',
    } as typeof users.$inferInsert);
    await makeRepairDue(approval.id);
    await tick();
    const rr = await repairOf('r2@eav-co.test');
    expect(rr.state).toBe('blocked');
    expect(rr.blockers).toContain('other_members:1');
    expect(await liveEntitlements(user.id)).toBe(1); // nothing further done
    expect(kcStore.has(user.id)).toBe(true);
    const listed = (await needsRepairList()).find((a) => a.id === approval.id);
    expect(listed?.reject_repair.state).toBe('blocked');
    const blocked = (await db.select().from(auditLog).where(eq(auditLog.tenant_id, tenantId))).filter(
      (r) => r.action === 'signup.reject_repair' && (r.result ?? '').startsWith('blocked'),
    );
    expect(blocked).toHaveLength(1);
    // The tick does not retry a blocked row (no audit spam)…
    await makeRepairDue(approval.id);
    await tick();
    expect(
      (await db.select().from(auditLog).where(eq(auditLog.tenant_id, tenantId))).filter(
        (r) => r.action === 'signup.reject_repair' && (r.result ?? '').startsWith('blocked'),
      ),
    ).toHaveLength(1);
    // …a super_admin's Retry re-checks it: still in use → 409 with the blockers.
    const res = await reject(approval.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { blockers: string[] }).blockers).toContain('other_members:1');
    // The colleague leaves; Retry now finishes it.
    await queryClient.unsafe(`UPDATE users SET deleted_at = now() WHERE id = '00000000-0000-4000-8000-0000ea20d021'`);
    expect((await reject(approval.id)).status).toBe(200);
    expect((await repairOf('r2@eav-co.test')).state).toBe('done');
    expect(await liveEntitlements(user.id)).toBe(0);
  });

  test('⛔ R2: licence_busy / a cleanup already in flight is SUCCESS — Telegram answers rejected (never "Could not reject"), concurrent Retries run it once', async () => {
    process.env = { ...process.env, ...TG_ENV };
    const { approval, user, tenantId } = await abortAfterSeat('r3@eav-co.test', 'EAV Busy Lic', false);
    // Another licence operation holds the tenant's lease (e.g. a concurrent cleanup's revoke).
    await queryClient.unsafe(
      `UPDATE tenants SET licence_op_id = '00000000-0000-4000-8000-0000ea20e0b1', licence_op_until = now() + interval '5 minutes' WHERE id = '${tenantId}'`,
    );
    const res = await decide(approval.id, { action: 'reject', telegramUserId: 951 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; cleanup: string; summary: string };
    expect(body.status).toBe('rejected');
    expect(body.cleanup).toBe('in_progress');
    expect(body.summary).toContain('under way');
    expect((await repairOf('r3@eav-co.test')).state).toBe('pending'); // the tick confirms it
    // The screen's Retry while still busy: 200 too.
    expect((await reject(approval.id)).status).toBe(200);
    // Lease released; the tick finishes it.
    await queryClient.unsafe(`UPDATE tenants SET licence_op_id = NULL, licence_op_until = NULL WHERE id = '${tenantId}'`);
    await makeRepairDue(approval.id);
    await tick();
    expect((await repairOf('r3@eav-co.test')).state).toBe('done');
    expect(await liveEntitlements(user.id)).toBe(0);

    // A second signup: its cleanup is IN FLIGHT (held inside the tenant-licence revoke) when another
    // decider arrives — it gets "in progress", not a second run and not a 502.
    const second = await abortAfterSeat('r4@eav-co.test', 'EAV Inflight', false);
    failRevoke = true;
    expect((await reject(second.approval.id)).status).toBe(502);
    failRevoke = false;
    revokeGate = makeGate();
    const g = revokeGate;
    revokeCalls = 0;
    const first = reject(second.approval.id); // Retry #1 — runs, held in the revoke
    await g.reached;
    const tg = await decide(second.approval.id, { action: 'reject', telegramUserId: 951 });
    expect(tg.status).toBe(200);
    expect(((await tg.json()) as { status: string; summary: string })).toMatchObject({ status: 'already_decided' });
    const retry2 = await reject(second.approval.id); // Retry #2 — the lease is held
    expect(retry2.status).toBe(200);
    g.release();
    expect((await first).status).toBe(200);
    expect(revokeCalls).toBeGreaterThan(0);
    const callsAfter = revokeCalls;
    expect((await repairOf('r4@eav-co.test')).state).toBe('done');
    await tick();
    expect(revokeCalls).toBe(callsAfter); // done — nobody runs it again
    expect(await liveEntitlements(second.user.id)).toBe(0);
  });

  test('⛔ R3: two workspaces founded by ONE approval — the cleanup targets the NEWEST, never the old offboarded one', async () => {
    const { approval, user, tenantId } = await abortAfterSeat('r5@eav-co.test', 'EAV Newest', false);
    // An EARLIER founding of the same approval, already offboarded long ago.
    const OLD = '00000000-0000-4000-8000-0000ea20f0a1';
    await queryClient.unsafe(
      `INSERT INTO tenants (id, name, slug, status, provisioning, created_at, offboarded_at)
       VALUES ('${OLD}', 'EAV Older', 'eav-older-r5', 'suspended',
               jsonb_build_object('signupApprovalId', '${approval.id}'),
               now() - interval '3 days', now() - interval '2 days')`,
    );
    failRevoke = true;
    expect((await reject(approval.id)).status).toBe(502);
    failRevoke = false;
    expect((await repairOf('r5@eav-co.test')).tenantId).toBe(tenantId);
    expect((await reject(approval.id)).status).toBe(200);
    const rr = await repairOf('r5@eav-co.test');
    expect(rr).toMatchObject({ state: 'done', tenantId });
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t!.license_token_encrypted).toBeNull();
    expect(await liveEntitlements(user.id)).toBe(0);
    expect(kcStore.has(user.id)).toBe(false);
  });

  test('⛔ R5: an admin\'s own LLM key (tenant_llm_settings) is user data — it BLOCKS the reject', async () => {
    const { approval, tenantId } = await abortAfterSeat('r6@eav-co.test', 'EAV Byo Key', false);
    expect(SIGNUP_WORKSPACE_TABLE_RULES.tenant_llm_settings!.kind).toBe('content');
    await queryClient.unsafe(
      `INSERT INTO tenant_llm_settings (tenant_id, provider, model, api_key_encrypted, credential_source)
       VALUES ('${tenantId}', 'anthropic', 'claude', 'v1:eav-ciphertext', 'tenant_byo')`,
    );
    const res = await reject(approval.id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { blockers: string[] }).blockers).toEqual(['data:tenant_llm_settings']);
    expect((await rowFor('r6@eav-co.test'))!.status).toBe('pending');
    await queryClient.unsafe(`DELETE FROM tenant_llm_settings WHERE tenant_id = '${tenantId}'`);
  });

  // ---- review fixes 4: `done` = verified gone; the done write is guarded; bounded retries ----

  test('⛔ F1: EVERY partial offboard failure keeps the row PENDING (tenant already offboarded) — the next run finishes it', async () => {
    const inject: Array<[string, (o: OffboardTenantResult) => void, string]> = [
      ['seat', (o) => o.seatFailures.push({ userId: 'u', email: 'f1-seat@eav-co.test', message: 'seat refused' }), 'seat refused'],
      ['inference', (o) => (o.inferenceRevokeError = 'inference refused'), 'inference refused'],
      ['archive', (o) => (o.archiveFailure = 'archive refused'), 'archive refused'],
      ['archive-uncertain', (o) => ((o.archiveSkipped = 'owner_lookup_failed: x'), (o.archiveSkipUncertain = true)), 'owner_lookup_failed'],
      ['residual', (o) => o.residualLicenceFailures.push({ licenseId: 'l-1', appKey: 'workers', message: 'bundle refused' }), 'bundle refused'],
      ['idp', (o) => o.idpDisableFailures.push({ alias: 'eav-idp', message: 'idp refused' }), 'idp refused'],
    ];
    for (const [name, mutate, marker] of inject) {
      const email = `f1-${name}@eav-co.test`;
      const { approval, user, tenantId } = await abortAfterSeat(email, `EAV F1 ${name}`, false);
      __setRejectedSignupOffboardForTests(async (...args) => {
        const out = await offboardRejectedSignupWorkspace(...args);
        mutate(out.offboard);
        return out;
      });
      try {
        const res = await reject(approval.id);
        expect(res.status).toBe(502);
      } finally {
        __setRejectedSignupOffboardForTests(undefined);
      }
      const rr = await repairOf(email);
      expect(rr.state).toBe('pending');
      expect(rr.lastError).toContain(marker);
      const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
      expect(t!.offboarded_at).not.toBeNull(); // offboarded — nothing would ever re-adopt it
      expect((await needsRepairList()).map((a) => a.id)).toContain(approval.id);
      // The next run (nothing injected) re-runs the residual steps and finishes it.
      await makeRepairDue(approval.id);
      await tick();
      expect((await repairOf(email)).state).toBe('done');
      expect(await liveEntitlements(user.id)).toBe(0);
    }
  }, 60_000);

  test('⛔ F1: a REAL inference-licence revoke failure — the re-run on the offboarded tenant revokes exactly it', async () => {
    const { approval, tenantId } = await abortAfterSeat('f2@eav-co.test', 'EAV F1 Infer', false);
    const INF = '00000000-0000-4000-8000-0000ea20f1f1';
    await queryClient.unsafe(`UPDATE tenants SET inference_licence_id = '${INF}' WHERE id = '${tenantId}'`);
    const revoked: string[] = [];
    let inferenceDown = true;
    __setInferenceLicencesForTests({
      ...makeLicences(),
      async revokeByLicenseId(id: string) {
        if (inferenceDown) throw new LicensesAdminError(503, 'inference licences down');
        revoked.push(id);
      },
    } as LicensesAdminClient);
    expect((await reject(approval.id)).status).toBe(502);
    let rr = await repairOf('f2@eav-co.test');
    expect(rr.state).toBe('pending');
    expect(rr.lastError).toContain('inference licence: ');
    let [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t!.offboarded_at).not.toBeNull();
    expect(t!.inference_licence_id).toBe(INF); // still live upstream
    inferenceDown = false;
    await makeRepairDue(approval.id);
    await tick();
    rr = await repairOf('f2@eav-co.test');
    expect(rr).toMatchObject({ state: 'done', attempts: 2, lastError: null });
    expect(revoked).toEqual([INF]);
    [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t!.inference_licence_id).toBeNull();
  });

  test('⛔ F2: an approve effect recorded DURING a held repair run — the run does NOT write done; the next run revokes it', async () => {
    const { approval, tenantId } = await abortAfterSeat('f3@eav-co.test', 'EAV F2 Race', false);
    failRevoke = true;
    expect((await reject(approval.id)).status).toBe(502);
    failRevoke = false;
    // A customer workspace with a person the aborting approve seats there mid-run.
    const CUST = '00000000-0000-4000-8000-0000ea20f2c1';
    const SEAT = '00000000-0000-4000-8000-0000ea20f2c2';
    await queryClient.unsafe(
      `INSERT INTO tenants (id, name, slug, status) VALUES ('${CUST}', 'EAV F2 Customer', 'eav-f2-customer', 'active')`,
    );
    await db.insert(users).values({
      id: SEAT,
      email: 'f3-seat@eav-co.test',
      name: 'Seated',
      tenant_id: CUST,
      tenant_role: 'member',
    } as typeof users.$inferInsert);
    revokeGate = makeGate();
    const g = revokeGate;
    const run = reject(approval.id); // Retry — holds the lease, parked in the tenant-licence revoke
    await g.reached;
    await recordApproveEffect(approval.id, { tenantId: CUST, seatedUserId: SEAT });
    expect((await repairOf('f3@eav-co.test')).state).toBe('pending'); // a held row is left alone
    g.release();
    expect((await run).status).toBe(200); // in progress, not a failure
    let rr = await repairOf('f3@eav-co.test');
    expect(rr.state).toBe('pending'); // NOT done: the new seat was never revoked by that run
    expect(rr.claimedUntil ?? null).toBeNull();
    expect(Date.parse(rr.nextAttemptAt!)).toBeLessThanOrEqual(Date.now());
    let [seat] = await db.select().from(users).where(eq(users.id, SEAT));
    expect(seat!.deleted_at).toBeNull();
    await tick();
    rr = await repairOf('f3@eav-co.test');
    expect(rr.state).toBe('done');
    [seat] = await db.select().from(users).where(eq(users.id, SEAT));
    expect(seat!.deleted_at).not.toBeNull();
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t!.offboarded_at).not.toBeNull();
  });

  test('⛔ F3b: a runner whose lease was taken over can never overwrite the new runner\'s result', async () => {
    const { approval } = await abortAfterSeat('f4@eav-co.test', 'EAV F3 Lease', false);
    failRevoke = true;
    expect((await reject(approval.id)).status).toBe(502);
    failRevoke = false;
    // Runner A parks BEFORE the offboard (outside any licence lease) and, when it wakes, fails.
    const g = makeGate();
    let calls = 0;
    __setRejectedSignupOffboardForTests(async (...args) => {
      if (++calls === 1) {
        await g.hold();
        throw new Error('runner A: licences down');
      }
      return offboardRejectedSignupWorkspace(...args);
    });
    try {
      const stale = reject(approval.id); // runner A
      await g.reached;
      // A's lease lapses; runner B takes it over and finishes.
      await queryClient.unsafe(
        `UPDATE signup_approvals SET reject_repair = reject_repair || jsonb_build_object('claimedUntil', to_jsonb(now() - interval '1 second')) WHERE id = '${approval.id}'`,
      );
      expect((await reject(approval.id)).status).toBe(200);
      expect((await repairOf('f4@eav-co.test')).state).toBe('done');
      g.release();
      expect((await stale).status).toBe(200); // lease lost → in progress, never a 502
    } finally {
      __setRejectedSignupOffboardForTests(undefined);
    }
    // A's `pending` + error write did not land on B's `done`.
    expect(await repairOf('f4@eav-co.test')).toMatchObject({ state: 'done', lastError: null });
  });

  test('⛔ F3a: bounded — after REJECT_REPAIR_MAX_ATTEMPTS the row goes FAILED (audited, listed, not retried by the tick); Retry resets it', async () => {
    process.env = { ...process.env, ...TG_ENV };
    const { approval, user, tenantId } = await abortAfterSeat('f5@eav-co.test', 'EAV F3 Cap', false);
    failRevoke = true;
    expect((await reject(approval.id)).status).toBe(502);
    await queryClient.unsafe(
      `UPDATE signup_approvals SET reject_repair = reject_repair || jsonb_build_object('attempts', ${REJECT_REPAIR_MAX_ATTEMPTS - 1}) WHERE id = '${approval.id}'`,
    );
    await makeRepairDue(approval.id);
    await tick();
    let rr = await repairOf('f5@eav-co.test');
    expect(rr).toMatchObject({ state: 'failed', attempts: REJECT_REPAIR_MAX_ATTEMPTS, nextAttemptAt: null });
    expect(rr.lastError).toContain('licences down');
    const listed = (await needsRepairList()).find((a) => a.id === approval.id);
    expect(listed?.reject_repair.state).toBe('failed');
    const gaveUp = (await db.select().from(auditLog).where(eq(auditLog.tenant_id, tenantId))).filter(
      (r) => r.action === 'signup.reject_repair' && (r.result ?? '').startsWith('gave up'),
    );
    expect(gaveUp).toHaveLength(1);
    // The tick leaves a failed row alone, even when "due".
    await makeRepairDue(approval.id);
    const refusals = revokeRefusals;
    await tick();
    expect(revokeRefusals).toBe(refusals);
    // Telegram on the decided row names the state.
    const tg = await decide(approval.id, { action: 'reject', telegramUserId: 951 });
    expect(((await tg.json()) as { summary: string }).summary).toContain('failed');
    // A Retry while licences is still down: 502, and the count restarted (1, not 11).
    let res = await reject(approval.id);
    expect(res.status).toBe(502);
    expect((await repairOf('f5@eav-co.test'))).toMatchObject({ state: 'pending', attempts: 1 });
    // …and once licences is back, Retry finishes it.
    failRevoke = false;
    res = await reject(approval.id);
    expect(res.status).toBe(200);
    rr = await repairOf('f5@eav-co.test');
    expect(rr).toMatchObject({ state: 'done', attempts: 2 });
    expect(await liveEntitlements(user.id)).toBe(0);
  });

  test('⛔ F3a: a NEW approve effect on a FAILED row makes it due again with the count restarted', async () => {
    const a = await pending('f7@eav-co.test');
    await queryClient.unsafe(
      `UPDATE signup_approvals SET status = 'rejected', decided_at = now(),
         reject_repair = jsonb_build_object('state', 'failed', 'tenantId', NULL, 'attempts', ${REJECT_REPAIR_MAX_ATTEMPTS},
           'lastAttemptAt', NULL, 'nextAttemptAt', NULL, 'lastError', 'x')
       WHERE id = '${a.id}'`,
    );
    await recordApproveEffect(a.id, { tenantId: '00000000-0000-4000-8000-0000ea20f7c1', inviteId: '00000000-0000-4000-8000-0000ea20f7c2' });
    const rr = await repairOf('f7@eav-co.test');
    expect(rr).toMatchObject({ state: 'pending', attempts: 0, lastError: 'x' });
    expect(Date.parse(rr.nextAttemptAt!)).toBeLessThanOrEqual(Date.now());
  });

  // ---- gap 1: a permanent failure is closed by a super_admin (resolved_manually) ----

  async function rejectedWithRepair(email: string, rr: Record<string, unknown>) {
    const a = await pending(email);
    await queryClient.unsafe(
      `UPDATE signup_approvals SET status = 'rejected', decided_at = now(), reject_repair = $1::jsonb WHERE id = '${a.id}'`,
      [JSON.stringify({ tenantId: null, attempts: 0, lastAttemptAt: null, nextAttemptAt: null, lastError: null, ...rr })],
    );
    return a;
  }
  function resolve(id: string, body: unknown, as: User = superAdmin) {
    currentUser = as;
    return call('POST', `/api/signup-approvals/${id}/resolve-repair`, body);
  }

  test('⛔ G1: Resolve manually — super_admin only, note required, only failed/blocked; the row leaves the list, terminal, audited with the error snapshot', async () => {
    const err = 'central archive not attempted: owner_unknown: the registry returned no owner_key';
    const a = await rejectedWithRepair('g1r@eav-co.test', {
      state: 'failed',
      attempts: REJECT_REPAIR_MAX_ATTEMPTS,
      lastError: err,
      lastErrorCodes: ['owner_unknown'],
    });
    const p = await rejectedWithRepair('g1p@eav-co.test', { state: 'pending', lastError: 'x' });
    // auth: a non-super_admin is refused, nothing written
    for (const u of [decider, intakeSa, { ...superAdmin, roles: ['tenant_admin'] }]) {
      expect((await resolve(a.id, { note: 'n' }, u)).status).toBe(403);
    }
    expect((await repairOf('g1r@eav-co.test')).state).toBe('failed');
    // the note is required (blank after stripping counts as missing)
    expect((await resolve(a.id, {})).status).toBe(422);
    expect((await resolve(a.id, { note: '  ​ ' })).status).toBe(422);
    // a pending row (the tick still owns it) is not resolvable
    const pr = await resolve(p.id, { note: 'n' });
    expect(pr.status).toBe(409);
    expect(((await pr.json()) as { error: string }).error).toBe('reject_repair_not_resolvable');
    // a run holding the lease → in progress
    await queryClient.unsafe(
      `UPDATE signup_approvals SET reject_repair = reject_repair || jsonb_build_object('claimedUntil', to_jsonb(now() + interval '1 minute')) WHERE id = '${a.id}'`,
    );
    const held = await resolve(a.id, { note: 'n' });
    expect(held.status).toBe(409);
    expect(((await held.json()) as { error: string }).error).toBe('reject_repair_in_progress');
    await queryClient.unsafe(
      `UPDATE signup_approvals SET reject_repair = reject_repair || jsonb_build_object('claimedUntil', NULL) WHERE id = '${a.id}'`,
    );
    expect((await needsRepairList()).map((r) => r.id)).toContain(a.id);

    const ok = await resolve(a.id, { note: 'Registry has no owner for this tenant; archived by hand.' });
    expect(ok.status).toBe(200);
    const rr = await repairOf('g1r@eav-co.test');
    expect(rr.state).toBe('resolved_manually');
    expect(rr.resolution).toMatchObject({
      note: 'Registry has no owner for this tenant; archived by hand.',
      actorSub: SADMIN_ID,
      priorState: 'failed',
      attempts: REJECT_REPAIR_MAX_ATTEMPTS,
      lastError: err,
      lastErrorCodes: ['owner_unknown'],
    });
    expect((await needsRepairList()).map((r) => r.id)).not.toContain(a.id);
    const audits = (await db.select().from(auditLog).where(eq(auditLog.action, 'signup.reject_repair_resolved'))).filter(
      (r) => (r.metadata as { approvalId?: string } | null)?.approvalId === a.id,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      note: 'Registry has no owner for this tenant; archived by hand.',
      lastError: err,
      lastErrorCodes: ['owner_unknown'],
      priorState: 'failed',
      actorSub: SADMIN_ID,
    });
    // terminal: a second resolve is refused, Retry is a no-op, the tick never runs it
    expect((await resolve(a.id, { note: 'again' })).status).toBe(409);
    currentUser = superAdmin;
    expect((await call('POST', `/api/signup-approvals/${a.id}/reject`, {})).status).toBe(200);
    await makeRepairDue(a.id);
    await tick();
    expect((await repairOf('g1r@eav-co.test')).state).toBe('resolved_manually');
    // a registry-only failure leaves nothing live: no acknowledgement needed, audited as plain resolved
    expect(audits[0]!.result).toBe('resolved manually');
    expect(audits[0]!.metadata).toMatchObject({ leavesLiveAccess: false, requesterEmail: 'g1r@eav-co.test' });
    expect(rr.resolution).toMatchObject({ leavesLiveAccess: false });
    // a blocked row is resolvable too (acknowledged: it leaves access live — see D1 below)
    const b = await rejectedWithRepair('g1b@eav-co.test', { state: 'blocked', blockers: ['other_members:1'] });
    expect((await resolve(b.id, { note: 'kept: the customer uses it', acknowledgeLiveAccess: true })).status).toBe(200);
    expect((await repairOf('g1b@eav-co.test')).resolution).toMatchObject({ priorState: 'blocked', blockers: ['other_members:1'] });
  });

  test('⛔ D1: resolving a BLOCKED cleanup leaves the requester LIVE — 422 without acknowledgeLiveAccess, 200 with it; audited as access left live; the workspace untouched', async () => {
    const { approval, user, tenantId } = await abortAfterSeat('d1b@eav-co.test', 'EAV D1 Blocked', false);
    failRevoke = true;
    expect((await reject(approval.id)).status).toBe(502);
    failRevoke = false;
    await db.insert(users).values({
      id: '00000000-0000-4000-8000-0000ea20d1b1',
      email: 'd1b-colleague@eav-co.test',
      name: 'Stays',
      tenant_id: tenantId,
      tenant_role: 'member',
    } as typeof users.$inferInsert);
    await makeRepairDue(approval.id);
    await tick();
    expect((await repairOf('d1b@eav-co.test')).state).toBe('blocked');
    const [wsBefore] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    // the queue tells the screen up front
    const listed = (await needsRepairList()).find((a) => a.id === approval.id) as { reject_repair_leaves_live_access?: boolean };
    expect(listed?.reject_repair_leaves_live_access).toBe(true);
    // no ack (absent, or false) → 422, nothing written
    for (const body of [{ note: 'kept' }, { note: 'kept', acknowledgeLiveAccess: false }]) {
      const r = await resolve(approval.id, body);
      expect(r.status).toBe(422);
      expect(((await r.json()) as { error: string }).error).toBe('reject_repair_live_access_unacknowledged');
    }
    expect((await repairOf('d1b@eav-co.test')).state).toBe('blocked');
    // acknowledged → resolved, audited with the live-access metadata
    const ok = await resolve(approval.id, { note: 'Customer keeps it; colleague uses the workspace.', acknowledgeLiveAccess: true });
    expect(ok.status).toBe(200);
    const rr = await repairOf('d1b@eav-co.test');
    expect(rr.state).toBe('resolved_manually');
    expect(rr.resolution).toMatchObject({ priorState: 'blocked', leavesLiveAccess: true });
    const audits = (await db.select().from(auditLog).where(eq(auditLog.action, 'signup.reject_repair_resolved'))).filter(
      (r) => (r.metadata as { approvalId?: string } | null)?.approvalId === approval.id,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.result).toBe('resolved — access left live');
    expect(audits[0]!.metadata).toMatchObject({ leavesLiveAccess: true, tenantId, requesterEmail: 'd1b@eav-co.test' });
    // the resolve touched nothing: the workspace row is as it was, the requester's seat + licence and
    // the identity stay live
    const [wsAfter] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(wsAfter).toEqual(wsBefore!);
    expect(await liveEntitlements(user.id)).toBe(1);
    expect(kcStore.has(user.id)).toBe(true);
  });

  test('⛔ D1: a FAILED cleanup on identity_failed leaves the login live — needs the acknowledgement; a failed row with no codes is treated as live too', async () => {
    const a = await rejectedWithRepair('d1f@eav-co.test', {
      state: 'failed',
      attempts: REJECT_REPAIR_MAX_ATTEMPTS,
      lastError: 'identity: keycloak refused',
      lastErrorCodes: ['owner_unknown', 'identity_failed'],
    });
    const listed = (await needsRepairList()).find((r) => r.id === a.id) as { reject_repair_leaves_live_access?: boolean };
    expect(listed?.reject_repair_leaves_live_access).toBe(true);
    const r = await resolve(a.id, { note: 'n' });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toBe('reject_repair_live_access_unacknowledged');
    expect((await repairOf('d1f@eav-co.test')).state).toBe('failed');
    expect((await resolve(a.id, { note: 'Retired the user in Keycloak by hand.', acknowledgeLiveAccess: true })).status).toBe(200);
    const audit = (await db.select().from(auditLog).where(eq(auditLog.action, 'signup.reject_repair_resolved'))).find(
      (x) => (x.metadata as { approvalId?: string } | null)?.approvalId === a.id,
    );
    expect(audit?.result).toBe('resolved — access left live');
    expect(audit?.metadata).toMatchObject({ leavesLiveAccess: true, requesterEmail: 'd1f@eav-co.test', lastErrorCodes: ['owner_unknown', 'identity_failed'] });
    const legacy = await rejectedWithRepair('d1l@eav-co.test', { state: 'failed', attempts: REJECT_REPAIR_MAX_ATTEMPTS, lastError: 'x' });
    expect((await resolve(legacy.id, { note: 'n' })).status).toBe(422);
  });

  test('⛔ D2: a Retry of a BLOCKED row is not an attempt — the count stays where it was, however often it is retried', async () => {
    const { approval, tenantId } = await abortAfterSeat('d2@eav-co.test', 'EAV D2 Blocked', false);
    failRevoke = true;
    expect((await reject(approval.id)).status).toBe(502);
    failRevoke = false;
    const before = (await repairOf('d2@eav-co.test')).attempts;
    expect(before).toBe(1);
    await db.insert(users).values({
      id: '00000000-0000-4000-8000-0000ea20d2b1',
      email: 'd2-colleague@eav-co.test',
      name: 'Stays',
      tenant_id: tenantId,
      tenant_role: 'member',
    } as typeof users.$inferInsert);
    await makeRepairDue(approval.id);
    await tick();
    expect(await repairOf('d2@eav-co.test')).toMatchObject({ state: 'blocked', attempts: before });
    for (let i = 0; i < REJECT_REPAIR_MAX_ATTEMPTS; i++) expect((await reject(approval.id)).status).toBe(409);
    expect(await repairOf('d2@eav-co.test')).toMatchObject({ state: 'blocked', attempts: before });
    // the colleague leaves, licences is down: the first real error is counted ONCE, not straight to failed
    await queryClient.unsafe(`UPDATE users SET deleted_at = now() WHERE id = '00000000-0000-4000-8000-0000ea20d2b1'`);
    failRevoke = true;
    expect((await reject(approval.id)).status).toBe(502);
    expect(await repairOf('d2@eav-co.test')).toMatchObject({ state: 'pending', attempts: before + 1 });
    failRevoke = false;
  });

  // ---- gap 2: a throw OUTSIDE the per-step try blocks is bounded too ----

  test('⛔ G2: a throw in the founded-workspace lookup counts an attempt, backs off, and reaches FAILED at the cap', async () => {
    const a = await rejectedWithRepair('g2@eav-co.test', { state: 'pending', nextAttemptAt: new Date(0).toISOString() });
    let lookups = 0;
    __setRejectRepairFoundedLookupForTests(async () => {
      lookups++;
      throw new Error('lookup exploded');
    });
    try {
      await tick();
      expect(lookups).toBe(1);
      let rr = await repairOf('g2@eav-co.test');
      expect(rr).toMatchObject({ state: 'pending', attempts: 1, lastErrorCodes: ['internal'] });
      expect(rr.lastError).toContain('lookup exploded');
      expect(rr.claimedUntil ?? null).toBeNull();
      expect(Date.parse(rr.nextAttemptAt!)).toBeGreaterThan(Date.now() + 4 * 60_000);
      // not due → the next tick leaves it alone
      await tick();
      expect(lookups).toBe(1);
      // …and at the cap it goes failed (audited as gave up), the tick stops
      await queryClient.unsafe(
        `UPDATE signup_approvals SET reject_repair = reject_repair || jsonb_build_object('attempts', ${REJECT_REPAIR_MAX_ATTEMPTS - 1}) WHERE id = '${a.id}'`,
      );
      await makeRepairDue(a.id);
      await tick();
      rr = await repairOf('g2@eav-co.test');
      expect(rr).toMatchObject({ state: 'failed', attempts: REJECT_REPAIR_MAX_ATTEMPTS, nextAttemptAt: null, lastErrorCodes: ['internal'] });
      await makeRepairDue(a.id);
      await tick();
      expect(lookups).toBe(2);
    } finally {
      __setRejectRepairFoundedLookupForTests(undefined);
    }
  });

  test('⛔ G2: a run that cannot even record its error (DB down) leaves the lease — and the claim-time nextAttemptAt stops a hot loop', async () => {
    const a = await rejectedWithRepair('g3@eav-co.test', { state: 'pending', attempts: 2, nextAttemptAt: new Date(0).toISOString() });
    let lookups = 0;
    __setRejectRepairFoundedLookupForTests(async () => {
      lookups++;
      throw new Error('lookup exploded');
    });
    __setRejectRepairWriteFaultForTests(() => {
      throw new Error('db down');
    });
    try {
      await tick();
      expect(lookups).toBe(1);
      let rr = await repairOf('g3@eav-co.test');
      // the claim counted the attempt and scheduled the next at attempt 3's backoff (20 min)
      expect(rr).toMatchObject({ state: 'pending', attempts: 3 });
      expect(Date.parse(rr.claimedUntil!)).toBeGreaterThan(Date.now()); // nothing released
      expect(Date.parse(rr.nextAttemptAt!)).toBeGreaterThan(Date.now() + 19 * 60_000);
      // the lease lapses: still not due, so the tick does NOT take it again
      await queryClient.unsafe(
        `UPDATE signup_approvals SET reject_repair = reject_repair || jsonb_build_object('claimedUntil', to_jsonb(now() - interval '1 second')) WHERE id = '${a.id}'`,
      );
      await tick();
      await tick();
      expect(lookups).toBe(1);
      // once due again (DB back), the run records it and the count keeps climbing
      __setRejectRepairWriteFaultForTests(undefined);
      await makeRepairDue(a.id);
      await tick();
      expect(lookups).toBe(2);
      rr = await repairOf('g3@eav-co.test');
      expect(rr).toMatchObject({ state: 'pending', attempts: 4, lastErrorCodes: ['internal'] });
      expect(rr.claimedUntil ?? null).toBeNull();
    } finally {
      __setRejectRepairFoundedLookupForTests(undefined);
      __setRejectRepairWriteFaultForTests(undefined);
    }
  });

  test('⛔ F3d: the Telegram done note names a FOUNDED workspace as offboarded', async () => {
    process.env = { ...process.env, ...TG_ENV };
    const { approval } = await abortAfterSeat('f6@eav-co.test', 'EAV F3 Note', false);
    const tg = await decide(approval.id, { action: 'reject', telegramUserId: 951 });
    const body = (await tg.json()) as { status: string; cleanup: string; summary: string };
    expect(body).toMatchObject({ status: 'rejected', cleanup: 'done' });
    expect(body.summary).toContain('the workspace its aborted approve founded is offboarded');
    expect(body.summary).not.toContain('seat');
  });
});

// =================================================================================================
describe('R4: an EXISTING-mode approve that aborted at the decision — reject revokes exactly its seat / invite', () => {
  const OTHER = '00000000-0000-4000-8000-0000ea20c1b4';
  async function customerWorkspace(adminEmail: string, company: string) {
    const a = await pending(adminEmail, { company });
    currentUser = superAdmin;
    const res = await call('POST', `/api/signup-approvals/${a.id}/approve`, { mode: 'new_tenant' });
    expect(res.status).toBe(200);
    const tenantId = ((await res.json()) as { tenantId: string }).tenantId;
    const [admin] = await db.select().from(users).where(sql`lower(email) = lower(${adminEmail})`);
    return { tenantId, adminId: admin!.id };
  }
  /** Approve `existing` into `tenantId`, holding the run at `gate`; take the claim over there so the
   *  run aborts at `decide`, then let the takeover lapse (pending, no live claim). */
  async function abortExisting(id: string, tenantId: string, gate: Gate) {
    currentUser = superAdmin;
    const run = call('POST', `/api/signup-approvals/${id}/approve`, { mode: 'existing', tenantId, role: 'member' });
    await gate.reached;
    await queryClient.unsafe(`UPDATE signup_approvals SET approving_claim = '${OTHER}' WHERE id = '${id}'`);
    gate.release();
    const res = await run;
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('approval_claim_lost');
    await queryClient.unsafe(
      `UPDATE signup_approvals SET approving_claim = NULL, approving_until = now() - interval '1 second' WHERE id = '${id}'`,
    );
  }
  function reject(id: string) {
    currentUser = superAdmin;
    return call('POST', `/api/signup-approvals/${id}/reject`, {});
  }

  test('a SEAT the approve made (known identity) is undone — tombstoned + licence revoked; the customer workspace and its admin untouched', async () => {
    const { tenantId, adminId } = await customerWorkspace('e1-admin@eav-co.test', 'EAV Customer One');
    const SUB = `${MINTED_PREFIX}9001`;
    kcSeed({ id: SUB, username: 'e1@eav-co.test', email: 'e1@eav-co.test', enabled: true, emailVerified: true, attributes: {} });
    const a = await pending('e1@eav-co.test', { keycloak_sub: SUB });
    memberGate = makeGate();
    await abortExisting(a.id, tenantId, memberGate);
    const [seat] = await db.select().from(users).where(eq(users.id, SUB));
    expect(seat!.tenant_id).toBe(tenantId);
    expect(seat!.deleted_at).toBeNull();
    expect(await liveEntitlements(SUB)).toBe(1);
    expect((await rowFor('e1@eav-co.test'))!.approve_effects).toEqual([
      expect.objectContaining({ tenantId, seatedUserId: SUB }),
    ]);

    const res = await reject(a.id);
    expect(res.status).toBe(200);
    expect((await rowFor('e1@eav-co.test'))!.reject_repair).toMatchObject({ state: 'done', tenantId: null });
    const [after] = await db.select().from(users).where(eq(users.id, SUB));
    expect(after!.deleted_at).not.toBeNull();
    expect(await liveEntitlements(SUB)).toBe(0);
    // Nothing else in the customer's workspace: not offboarded, its admin still seated + licensed.
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t!.offboarded_at).toBeNull();
    const [admin] = await db.select().from(users).where(eq(users.id, adminId));
    expect(admin!.deleted_at).toBeNull();
    expect(await liveEntitlements(adminId)).toBe(1);
    // The pre-existing identity is the person's: never deleted nor disabled.
    expect(kcStore.get(SUB)?.rep.enabled).toBe(true);
    const audit = (await db.select().from(auditLog).where(eq(auditLog.target_id, 'e1@eav-co.test'))).find(
      (r) => r.action === 'signup.reject',
    )!;
    expect((audit.metadata as { effectsRevoked: string[] }).effectsRevoked).toEqual([`seat:${SUB}`]);
  });

  test('an INVITE the approve sent is revoked and its minted identity retired; another person\'s invite in the workspace stays', async () => {
    const { tenantId, adminId } = await customerWorkspace('e2-admin@eav-co.test', 'EAV Customer Two');
    // Somebody else's pending invite in the same customer workspace.
    currentUser = superAdmin;
    const other = await call('POST', '/api/invites', {
      tenantId,
      email: 'e2-other@eav-co.test',
      firstName: 'Oth',
      lastName: 'Er',
      role: 'member',
    });
    expect(other.status).toBe(201);
    const otherInviteId = ((await other.json()) as { invite: { id: string } }).invite.id;
    const a = await pending('e2@eav-co.test');
    kcEmailGate = makeGate();
    await abortExisting(a.id, tenantId, kcEmailGate);
    const effects = (await rowFor('e2@eav-co.test'))!.approve_effects!;
    expect(effects).toHaveLength(1);
    const inviteId = effects[0]!.inviteId!;
    const invites = async () =>
      (await queryClient.unsafe(
        `SELECT id, status, keycloak_sub FROM tenant_invites WHERE tenant_id = '${tenantId}'`,
      )) as unknown as { id: string; status: string; keycloak_sub: string | null }[];
    const mine = (await invites()).find((i) => i.id === inviteId)!;
    expect(mine.status).toBe('pending');
    expect(mine.keycloak_sub).not.toBeNull(); // CP minted the identity for this invite

    expect((await reject(a.id)).status).toBe(200);
    const now = await invites();
    expect(now.find((i) => i.id === inviteId)!.status).toBe('revoked');
    expect(now.find((i) => i.id === otherInviteId)!.status).toBe('pending');
    expect(kcStore.has(mine.keycloak_sub!)).toBe(false); // credential-less → deleted
    const [admin] = await db.select().from(users).where(eq(users.id, adminId));
    expect(admin!.deleted_at).toBeNull();
    const [t] = await db.select().from(tenants).where(eq(tenants.id, tenantId));
    expect(t!.offboarded_at).toBeNull();
    expect((await rowFor('e2@eav-co.test'))!.reject_repair!.state).toBe('done');
  });

  test('⛔ F3d: the Telegram done note for an existing-mode SEAT says seat — never "workspace"', async () => {
    process.env = { ...process.env, ...TG_ENV };
    const { tenantId } = await customerWorkspace('e4-admin@eav-co.test', 'EAV Customer Four');
    const SUB = `${MINTED_PREFIX}9004`;
    kcSeed({ id: SUB, username: 'e4@eav-co.test', email: 'e4@eav-co.test', enabled: true, emailVerified: true, attributes: {} });
    const a = await pending('e4@eav-co.test', { keycloak_sub: SUB });
    memberGate = makeGate();
    await abortExisting(a.id, tenantId, memberGate);
    const tg = await decide(a.id, { action: 'reject', telegramUserId: 951 });
    const body = (await tg.json()) as { status: string; cleanup: string; summary: string };
    expect(body).toMatchObject({ status: 'rejected', cleanup: 'done' });
    expect(body.summary).toContain('the seat its aborted approve made in a customer workspace is revoked');
    expect(body.summary).not.toContain('workspace its aborted approve founded');
  });

  test('a signup with no aborted approve: reject records no cleanup at all', async () => {
    const a = await pending('e3@eav-co.test');
    expect((await reject(a.id)).status).toBe(200);
    expect((await rowFor('e3@eav-co.test'))!.reject_repair).toBeNull();
    expect((await reject(a.id)).status).toBe(400);
  });
});

// =================================================================================================
describe('KeycloakAdminService.updateUserAttributes — read-modify-write', () => {
  test('keeps every other attribute and field; sets and removes only the named keys', async () => {
    const seen: Array<{ method: string; url: string; body: unknown }> = [];
    const rep = {
      id: 'u1',
      username: 'x@eav-co.test',
      email: 'x@eav-co.test',
      firstName: 'X',
      enabled: true,
      attributes: { tenant_id: ['t-1'], fr_thing: ['keep'], signup_book_url: ['https://old'] },
    };
    const kc = new KeycloakAdminService({
      baseUrl: 'http://kc.test',
      targetRealm: 'portal',
      clientId: 'cp-admin',
      clientSecret: 's',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (String(url).endsWith('/token')) return Response.json({ access_token: 'adm', expires_in: 60 });
        seen.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (method === 'GET') return Response.json(rep);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    await kc.updateUserAttributes('u1', { locale: 'de', signup_app: 'commonpractice', signup_book_url: null });
    const put = seen.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('http://kc.test/admin/realms/portal/users/u1');
    expect(put.body).toEqual({
      ...rep,
      attributes: { tenant_id: ['t-1'], fr_thing: ['keep'], locale: ['de'], signup_app: ['commonpractice'] },
    });
  });

  test('a refused PUT throws (the caller decides; the email step logs it and still sends)', async () => {
    const kc = new KeycloakAdminService({
      baseUrl: 'http://kc.test',
      targetRealm: 'portal',
      clientId: 'cp-admin',
      clientSecret: 's',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/token')) return Response.json({ access_token: 'adm', expires_in: 60 });
        if ((init?.method ?? 'GET') === 'GET') return Response.json({ id: 'u1', attributes: {} });
        return new Response(null, { status: 403 });
      }) as typeof fetch,
    });
    await expect(kc.updateUserAttributes('u1', { locale: 'de' })).rejects.toThrow('HTTP 403');
  });

  test('setUserState: enabled + attributes in ONE full-representation PUT, then the STORED representation is read back', async () => {
    const seen: Array<{ method: string; body: unknown }> = [];
    let stored: Record<string, unknown> = {
      id: 'u1',
      username: 'x@eav-co.test',
      enabled: true,
      attributes: { tenant_id: ['t-1'], locale: ['nl'] },
    };
    const kc = new KeycloakAdminService({
      baseUrl: 'http://kc.test',
      targetRealm: 'portal',
      clientId: 'cp-admin',
      clientSecret: 's',
      fetchImpl: (async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (String(url).endsWith('/token')) return Response.json({ access_token: 'adm', expires_in: 60 });
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        seen.push({ method, body });
        if (method === 'GET') return Response.json(stored);
        // The realm profile drops the undeclared attribute on write — the read-back must show it.
        const attrs = { ...(body.attributes as Record<string, string[]>) };
        delete attrs.signup_app;
        stored = { ...body, attributes: attrs };
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    const out = await kc.setUserState('u1', { enabled: false, attributes: { signup_app: 'cp_rejected:a1' } });
    const puts = seen.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toEqual({
      id: 'u1',
      username: 'x@eav-co.test',
      enabled: false,
      attributes: { tenant_id: ['t-1'], locale: ['nl'], signup_app: ['cp_rejected:a1'] },
    });
    expect(out).toEqual({ id: 'u1', username: 'x@eav-co.test', enabled: false, attributes: { tenant_id: ['t-1'], locale: ['nl'] } });
    expect(seen.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET']);
  });
});
