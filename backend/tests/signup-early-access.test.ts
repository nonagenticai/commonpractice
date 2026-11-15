// tests/signup-early-access.test.ts — early-access self-registration (George 2026-10-14).
//
// Drives the LIVE onboarding routes against postgres with identity injected via
// __setAuthOverridesForTests, Keycloak admin + licences replaced by fakes, and BOTH outbound HTTP
// clients (Telegram, Turnstile siteverify) replaced by recording fakes — no test reaches Telegram or
// Cloudflare. Covers:
//   • POST /api/signup-approvals/intake — SA auth refusals (no token, wrong azp, missing role,
//     super_admin), the stored row (company/source, no sub), de-dupe.
//   • Telegram — the new-signup payload + keyboard, insert-only (no message on de-dupe), disabled
//     when unconfigured, bounded retry, never failing the intake, decision follow-ups.
//   • Turnstile on/off on notify-self and intake.
//   • approve defaults — tenantName from company / domain / name, auto-suffix on a taken name with
//     the CP slug == the licences name, the bound, and super_admin create staying a 409.
//   • no setWebhook / getUpdates / deleteWebhook anywhere in backend/src.
//   • POST /api/signup-approvals/invite — the super_admin's pre-approved early-access invite.
import { test, expect, beforeEach, afterAll, describe } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { db, tenants, users, signupApprovals, auditLog, queryClient, schedulerTicks } from '../src/db/client';
import { Router } from '../src/utils/router';
import { registerOnboardingRoutes } from '../src/routes/onboarding';
import { registerAdminRoutes } from '../src/routes/admin';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { __setKeycloakAdminForTests, type KeycloakAdminClient } from '../src/services/keycloak-admin';
import {
  __setLicensesAdminForTests,
  LicencesNameConflictError,
  type LicensesAdminClient,
  type LicencesPlan,
} from '../src/services/licenses-admin';
import {
  __drainSignupTelegramForTests,
  __setTelegramFetchForTests,
  __setTelegramSleepForTests,
  decisionPayload,
  logSignupTelegramStatus,
  newSignupPayload,
  NEW_SIGNUP_HEADLINE,
} from '../src/services/signup-telegram';
import { runSignupDigestOnce } from '../src/host/signup-digest-scheduler';
import { singleLine } from '../src/utils/untrusted-text';
import { __setTurnstileFetchForTests } from '../src/services/turnstile';
import {
  defaultTenantNameFrom,
  organisationLabel,
  PUBLIC_EMAIL_DOMAINS,
} from '../src/services/onboarding-service';
import { config } from '../src/config';
import { __setInferenceLicencesForTests, __setInferenceFetchForTests } from '../src/services/tenant-inference';
import { UnauthorizedError, type User } from '../src/types';

// Own id range (marker `5e9a`), slug prefix `sxq-`, email marker `sxq` so cleanup touches nothing else.
const SADMIN_ID = '00000000-0000-4000-8000-00005e9a0001';
const SA_SUB = '00000000-0000-4000-8000-00005e9a0002';
const LIC_ID = '00000000-0000-4000-8000-00005e9a0b01';
const SUBJ_ID = '11111111-1111-4111-8111-00005e9a0b01';

const superAdmin: User = { id: SADMIN_ID, email: 'sxq-admin@t.test', name: 'SXQ Admin', roles: ['super_admin'] };
const intakeSa: User = { id: SA_SUB, email: '', name: '', roles: ['cp-signup-intake'], azp: 'cp-signup-intake', aud: ['cp-signup-intake'], issuer: config.keycloak.issuer };

const router = new Router();
registerOnboardingRoutes(router);
registerAdminRoutes(router);

let currentUser: User | null = null;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const m = router.match(method, path.split('?')[0]!);
  if (!m) throw new Error(`no route for ${method} ${path}`);
  return m.handler(
    new Request(`http://t${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    ...m.params,
  );
}

// ---- outbound HTTP fakes ----
interface Sent {
  url: string;
  body: Record<string, unknown>;
}
let telegramSent: Sent[] = [];
let telegramResponses: Array<() => Response> = [];
let turnstileCalls: URLSearchParams[] = [];
let turnstileAnswer: () => Response = () => Response.json({ success: true });

function installFakes() {
  telegramSent = [];
  telegramResponses = [];
  turnstileCalls = [];
  turnstileAnswer = () => Response.json({ success: true });
  __setTelegramFetchForTests(async (url, init) => {
    telegramSent.push({ url, body: JSON.parse(String(init?.body)) });
    const next = telegramResponses.shift();
    return next ? next() : Response.json({ ok: true, result: { message_id: 1 } });
  });
  __setTelegramSleepForTests(async () => {});
  __setTurnstileFetchForTests(async (_url, init) => {
    turnstileCalls.push(new URLSearchParams(String(init?.body)));
    return turnstileAnswer();
  });
}

const TG_ENV = {
  TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN-sxq',
  TELEGRAM_SIGNUP_CHAT_ID: '-1003934173351',
  TELEGRAM_SIGNUP_THREAD_ID: '4242',
  CP_PUBLIC_URL: 'https://cp.example.test',
};
const ENV_KEYS = [...Object.keys(TG_ENV), 'TURNSTILE_SECRET', 'TURNSTILE_REQUIRED', 'SIGNUP_DIGEST_INTERVAL_HOURS'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
function telegramOn() {
  Object.assign(process.env, TG_ENV);
}
function resetEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

// ---- Keycloak admin fake (approve of an anonymous row → invite → a bare realm identity) ----
// Records the early-access email calls IN ORDER (attribute writes and the action email), so a test
// can prove the attributes are set before the send and the book link is cleared after it.
type KcCall =
  | { kind: 'attrs'; sub: string; patch: Record<string, string | null> }
  | { kind: 'email'; sub: string; actions: string[]; opts: Record<string, unknown> };
let kcCalls: KcCall[] = [];
let kcEmailFails = false;
function makeKc(): KeycloakAdminClient {
  let n = 0;
  kcCalls = [];
  kcEmailFails = false;
  return {
    async createRealmUser() {
      n++;
      return `00000000-0000-4000-8000-00005e9ac${String(n).padStart(3, '0')}`;
    },
    async logoutUser() {},
    async executeActionsEmail(sub, actions, opts) {
      if (kcEmailFails) throw new Error('smtp down');
      kcCalls.push({ kind: 'email', sub, actions: actions ?? [], opts: (opts ?? {}) as Record<string, unknown> });
    },
    async updateUserAttributes(sub, patch) {
      kcCalls.push({ kind: 'attrs', sub, patch });
    },
    async deleteRealmUser() {},
    async listRealmUsers() {
      return [];
    },
    async findRealmUserByUsernameOrEmail() {
      return null;
    },
    async backfillUserEmail() {},
    async getRealmRolesForUsers(ids) {
      return new Map(ids.map((i) => [i, []]));
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

// ---- licences fake: owner-scoped names, `taken` = names CP already holds elsewhere ----
function makeLicences(taken: string[] = []) {
  const takenSet = new Set(taken);
  const names = new Map<string, string>();
  const calls = {
    attempted: [] as string[],
    registered: [] as Array<{ tenantId: string; name: string }>,
    byo: [] as Array<{ tenantId: string; mode: string }>,
  };
  const holderOf = (name: string) => (takenSet.has(name) ? 'someone-else' : names.get(name));
  const plan = (code: string): LicencesPlan => ({
    id: '00000000-0000-4000-8000-00005e9a0e01',
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
  const client: LicensesAdminClient = {
    async getTenant(nameOrId) {
      const id = holderOf(nameOrId);
      return id ? { id, name: nameOrId } : null;
    },
    async ensureTenantRegistered(tenantId, name) {
      calls.attempted.push(name);
      const holder = holderOf(name);
      if (holder && holder !== tenantId) throw new LicencesNameConflictError(name);
      if (!holder) calls.registered.push({ tenantId, name });
      names.set(name, tenantId);
    },
    async renameTenant(tenantId, name) {
      for (const [k, v] of names) if (v === tenantId) names.delete(k);
      names.set(name, tenantId);
    },
    async archiveTenant() {},
    async setTenantByoMode(tenantId, mode) {
      calls.byo.push({ tenantId, mode });
    },
    async listPlans() {
      return [plan('byo'), plan('standard'), plan('local-llm')];
    },
    async createLicense() {
      return { licenseId: LIC_ID, subjectId: SUBJ_ID };
    },
    async createToken() {
      return { token: 'sxq-token' };
    },
    async revokeByToken() {},
    async revokeByLicenseId() {},
  };
  return { client, calls };
}

type LicenceCfg = { adminBaseUrl: string; issuanceEnabled: boolean; sa: { tokenUrl: string }; planCode: string };
const lic = config.license as unknown as LicenceCfg;
const wasLic = { base: lic.adminBaseUrl, token: lic.sa.tokenUrl, issuance: lic.issuanceEnabled, plan: lic.planCode };
const llmCfg = config.llm as { openaiBaseUrl: string };
const wasIr = llmCfg.openaiBaseUrl;
function centralOn(taken: string[] = []) {
  lic.adminBaseUrl = 'http://licenses.test';
  lic.sa.tokenUrl = 'http://kc.test/token';
  lic.issuanceEnabled = true;
  lic.planCode = 'byo';
  llmCfg.openaiBaseUrl = 'http://inference-router.test/api';
  const fake = makeLicences(taken);
  __setLicensesAdminForTests(fake.client);
  // A new workspace defaults to local-llm, which provisions its own inference-router licence: the
  // same licences fake mints it, and an ENFORCING router fake answers the smoke (no network).
  __setInferenceLicencesForTests(fake.client);
  __setInferenceFetchForTests(async (_url, init) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    return new Response('{}', { status: h.authorization === 'Bearer sxq-token' ? 200 : 401 });
  });
  return fake;
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
  DELETE FROM signup_approvals WHERE lower(email) LIKE '%sxq%';
  DELETE FROM audit_log WHERE action = 'signup.invite' AND lower(target_id) LIKE '%sxq%';
  DELETE FROM audit_log WHERE actor_id = '${SADMIN_ID}';
  DELETE FROM audit_log WHERE tenant_id IN (SELECT id FROM tenants WHERE slug LIKE 'sxq-%');
  DELETE FROM tenants WHERE slug LIKE 'sxq-%';
  -- Identities the Keycloak fake minted and the approve path seated (licence at approval).
  DELETE FROM users WHERE id::text LIKE '00000000-0000-4000-8000-00005e9ac%';
`;

beforeEach(async () => {
  resetEnv();
  installFakes();
  currentUser = null;
  __setAuthOverridesForTests({
    validateAuth: async () => {
      if (!currentUser) throw new UnauthorizedError('no auth');
      return currentUser;
    },
  });
  __setKeycloakAdminForTests(makeKc());
  await queryClient.unsafe(CLEANUP_SQL);
}, 30_000);

afterAll(async () => {
  await __drainSignupTelegramForTests();
  resetEnv();
  centralOff();
  __setAuthOverridesForTests(undefined);
  __setKeycloakAdminForTests(undefined);
  __setTelegramFetchForTests(undefined);
  __setTelegramSleepForTests(undefined);
  __setTurnstileFetchForTests(undefined);
  await queryClient.unsafe(CLEANUP_SQL);
}, 30_000);

async function rowFor(email: string) {
  const [r] = await db.select().from(signupApprovals).where(sql`lower(email) = lower(${email})`);
  return r;
}

const intakeBody = (email: string, extra: Record<string, unknown> = {}) => ({
  email,
  name: 'Ann Early',
  company: 'SXQ Acme',
  source: 'web',
  ...extra,
});

// =================================================================================================
describe('intake — server-to-server auth', () => {
  test('no token → 401, nothing recorded', async () => {
    currentUser = null;
    const res = await call('POST', '/api/signup-approvals/intake', intakeBody('a1@sxq-co.test'));
    expect(res.status).toBe(401);
    expect(await rowFor('a1@sxq-co.test')).toBeUndefined();
  });

  test('wrong azp → 403 signup_intake_forbidden, even with the role', async () => {
    currentUser = { ...intakeSa, azp: 'some-other-client' };
    const res = await call('POST', '/api/signup-approvals/intake', intakeBody('a2@sxq-co.test'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('signup_intake_forbidden');
    expect(await rowFor('a2@sxq-co.test')).toBeUndefined();
  });

  test('no azp at all → 403', async () => {
    currentUser = { ...intakeSa, azp: undefined };
    const res = await call('POST', '/api/signup-approvals/intake', intakeBody('a3@sxq-co.test'));
    expect(res.status).toBe(403);
  });

  test('right azp + role but `aud` missing or not naming the azp → 403', async () => {
    currentUser = { ...intakeSa, aud: undefined };
    const res = await call('POST', '/api/signup-approvals/intake', intakeBody('a8@sxq-co.test'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('signup_intake_forbidden');
    currentUser = { ...intakeSa, aud: ['account', 'other-signup-intake'] };
    expect((await call('POST', '/api/signup-approvals/intake', intakeBody('a8@sxq-co.test'))).status).toBe(403);
    expect(await rowFor('a8@sxq-co.test')).toBeUndefined();
  });

  test('right azp but missing role → 403', async () => {
    currentUser = { ...intakeSa, roles: [] };
    const res = await call('POST', '/api/signup-approvals/intake', intakeBody('a4@sxq-co.test'));
    expect(res.status).toBe(403);
    expect(await rowFor('a4@sxq-co.test')).toBeUndefined();
  });

  test('⛔ a super_admin token is refused on the intake path — even carrying the azp and the role', async () => {
    currentUser = { ...superAdmin, azp: 'cp-signup-intake', roles: ['super_admin', 'cp-signup-intake'] };
    const res = await call('POST', '/api/signup-approvals/intake', intakeBody('a5@sxq-co.test'));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('signup_intake_forbidden');
    // …and a plain operator session too.
    currentUser = superAdmin;
    expect((await call('POST', '/api/signup-approvals/intake', intakeBody('a5@sxq-co.test'))).status).toBe(403);
    expect(await rowFor('a5@sxq-co.test')).toBeUndefined();
  });

  test('realm-per-app P0: intake is pinned to CP_SIGNUP_INTAKE_ISSUER (default KEYCLOAK_ISSUER)', async () => {
    const secureApps = 'https://auth.example.test/realms/secure-apps';
    for (const issuer of [secureApps, 'https://auth.example.test/realms/commonpractice', undefined]) {
      currentUser = { ...intakeSa, issuer };
      const res = await call('POST', '/api/signup-approvals/intake', intakeBody('a9@sxq-co.test'));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe('signup_intake_forbidden');
    }
    expect(await rowFor('a9@sxq-co.test')).toBeUndefined();
    process.env.CP_SIGNUP_INTAKE_ISSUER = secureApps;
    try {
      currentUser = intakeSa; // still the KEYCLOAK_ISSUER token → now refused
      expect((await call('POST', '/api/signup-approvals/intake', intakeBody('a9@sxq-co.test'))).status).toBe(403);
      currentUser = { ...intakeSa, issuer: secureApps };
      expect((await call('POST', '/api/signup-approvals/intake', intakeBody('a9@sxq-co.test'))).status).toBe(202);
    } finally {
      delete process.env.CP_SIGNUP_INTAKE_ISSUER;
    }
  });

  test('CP_SIGNUP_INTAKE_AZP / _ROLE are honoured (read live)', async () => {
    process.env.CP_SIGNUP_INTAKE_AZP = 'website-backend,signup-chat';
    try {
      currentUser = { ...intakeSa, azp: 'signup-chat', aud: ['account', 'signup-chat'] };
      expect((await call('POST', '/api/signup-approvals/intake', intakeBody('a6@sxq-co.test', { source: 'chat' }))).status).toBe(202);
      currentUser = intakeSa; // `cp-signup-intake` is no longer listed
      expect((await call('POST', '/api/signup-approvals/intake', intakeBody('a7@sxq-co.test'))).status).toBe(403);
    } finally {
      delete process.env.CP_SIGNUP_INTAKE_AZP;
    }
  });

  test('valid SA → 202 queued; company + source stored, NO sub; a re-submit is 202 already_pending', async () => {
    currentUser = intakeSa;
    const res = await call('POST', '/api/signup-approvals/intake', intakeBody('ok1@sxq-co.test'));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'queued' });
    const row = await rowFor('ok1@sxq-co.test');
    expect(row!.company).toBe('SXQ Acme');
    expect(row!.source).toBe('web');
    expect(row!.name).toBe('Ann Early');
    expect(row!.keycloak_sub).toBeNull(); // the SA's sub is not the requester
    expect(row!.status).toBe('pending');

    const again = await call('POST', '/api/signup-approvals/intake', intakeBody('OK1@sxq-co.test', { source: 'chat' }));
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ status: 'already_pending' });
    const rows = await db.select().from(signupApprovals).where(sql`lower(email) = 'ok1@sxq-co.test'`);
    expect(rows.length).toBe(1);
  });

  test('strict body: unknown source / extra field / missing name → 422, nothing written', async () => {
    currentUser = intakeSa;
    expect((await call('POST', '/api/signup-approvals/intake', intakeBody('b1@sxq-co.test', { source: 'fax' }))).status).toBe(422);
    expect((await call('POST', '/api/signup-approvals/intake', intakeBody('b1@sxq-co.test', { plan: 'pro' }))).status).toBe(422);
    expect((await call('POST', '/api/signup-approvals/intake', { email: 'b1@sxq-co.test', source: 'web' })).status).toBe(422);
    expect(await rowFor('b1@sxq-co.test')).toBeUndefined();
  });

  test('notify-self keeps its anonymous behaviour and is stamped source=app', async () => {
    currentUser = null;
    const res = await call('POST', '/api/signup-approvals/notify-self', { email: 'anon@sxq-co.test', name: 'Anon' });
    expect(res.status).toBe(204);
    const row = await rowFor('anon@sxq-co.test');
    expect(row!.source).toBe('app');
    expect(row!.company).toBeNull();
  });
});

// =================================================================================================
describe('Telegram notification', () => {
  test('a new intake signup sends ONE sendMessage: requester facts as code entities, callback Approve/Reject + Open link', async () => {
    telegramOn();
    currentUser = intakeSa;
    const res = await call(
      'POST',
      '/api/signup-approvals/intake',
      intakeBody('tg1@sxq-co.test', { source: 'chat', locale: 'de-DE', message: 'Hello,\nplease let me in.' }),
    );
    expect(res.status).toBe(202);
    await __drainSignupTelegramForTests();
    expect(telegramSent.length).toBe(1);
    const { url, body } = telegramSent[0]!;
    expect(url).toBe(`https://api.telegram.org/bot${TG_ENV.TELEGRAM_BOT_TOKEN}/sendMessage`);
    expect(body.chat_id).toBe('-1003934173351');
    expect(body.message_thread_id).toBe(4242); // the "CP signups" topic, a number on the wire
    expect(body.parse_mode).toBeUndefined(); // plain text + entities: requester input cannot inject markup
    expect(body.link_preview_options).toEqual({ is_disabled: true });
    const id = (await rowFor('tg1@sxq-co.test'))!.id;
    const text = String(body.text);
    expect(text.startsWith(NEW_SIGNUP_HEADLINE)).toBe(true);
    for (const want of [
      'Name: Ann Early',
      'Email: tg1@sxq-co.test',
      'Company: SXQ Acme',
      'Source: chat',
      'Language: de',
      'Trusted via: website/chat intake (service account)',
      'Message: Hello, please let me in.',
      `Signup id: ${id}`,
    ]) {
      expect(text).toContain(want);
    }
    expect(text).toMatch(/Pending signups: \d+/);
    // Every requester-typed value is exactly one `code` entity (offsets in UTF-16 units).
    const entities = body.entities as Array<{ type: string; offset: number; length: number }>;
    const coded = entities.map((e) => text.slice(e.offset, e.offset + e.length));
    expect(entities.every((e) => e.type === 'code')).toBe(true);
    expect(coded).toEqual(['Ann Early', 'tg1@sxq-co.test', 'SXQ Acme', 'Hello, please let me in.']);
    expect(body.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: 'Approve', callback_data: `ea1:cp:a:${id}` },
          { text: 'Reject', callback_data: `ea1:cp:r:${id}` },
        ],
        [{ text: 'Open in CommonPractice', url: `https://cp.example.test/onboarding?signup=${id}` }],
      ],
    });
    // Contract C1: callback_data ≤ 64 bytes.
    expect(new TextEncoder().encode(`ea1:cp:a:${id}`).length).toBeLessThanOrEqual(64);
  });

  test('insert only: a de-duplicated re-submit sends nothing', async () => {
    telegramOn();
    currentUser = intakeSa;
    await call('POST', '/api/signup-approvals/intake', intakeBody('tg2@sxq-co.test'));
    await call('POST', '/api/signup-approvals/intake', intakeBody('tg2@sxq-co.test'));
    currentUser = null;
    await call('POST', '/api/signup-approvals/notify-self', { email: 'tg2@sxq-co.test' });
    await __drainSignupTelegramForTests();
    expect(telegramSent.length).toBe(1);
  });

  test('⛔ anonymous notify-self WITHOUT Turnstile is queued but NOT announced (trust NULL)', async () => {
    telegramOn();
    currentUser = null;
    expect((await call('POST', '/api/signup-approvals/notify-self', { email: 'tg3@sxq-co.test', name: 'Tia' })).status).toBe(204);
    await __drainSignupTelegramForTests();
    expect(telegramSent.length).toBe(0);
    const row = await rowFor('tg3@sxq-co.test');
    expect(row!.status).toBe('pending');
    expect(row!.trust).toBeNull();
  });

  test('⛔ a signed-in caller whose token does NOT prove the address is untrusted too', async () => {
    telegramOn();
    // Verified email, but a DIFFERENT address than the body's; and an unverified email for the same one.
    for (const [who, email] of [
      [{ email: 'other@sxq-co.test', emailVerified: true }, 'tg4@sxq-co.test'],
      [{ email: 'tg5@sxq-co.test', emailVerified: false }, 'tg5@sxq-co.test'],
    ] as const) {
      currentUser = { id: '00000000-0000-4000-8000-00005e9a0078', name: 'U', roles: [], ...who };
      expect((await call('POST', '/api/signup-approvals/notify-self', { email })).status).toBe(204);
      expect((await rowFor(email))!.trust).toBeNull();
    }
    await __drainSignupTelegramForTests();
    expect(telegramSent.length).toBe(0);
  });

  test('notify-self with a verified-email token IS announced (trust verified_email, source app)', async () => {
    telegramOn();
    currentUser = {
      id: '00000000-0000-4000-8000-00005e9a0079',
      email: 'tg6@sxq-co.test',
      emailVerified: true,
      name: 'Vera',
      roles: [],
    };
    expect((await call('POST', '/api/signup-approvals/notify-self', { email: 'tg6@sxq-co.test', name: 'Vera' })).status).toBe(204);
    await __drainSignupTelegramForTests();
    expect(telegramSent.length).toBe(1);
    const text = String(telegramSent[0]!.body.text);
    expect(text).toContain('Source: app');
    expect(text).toContain('Trusted via: signed-in user with a verified email');
    const row = await rowFor('tg6@sxq-co.test');
    expect(row!.trust).toBe('verified_email');
    expect(row!.keycloak_sub).toBe('00000000-0000-4000-8000-00005e9a0079');
  });

  test('anonymous notify-self that PASSED Turnstile is announced (trust turnstile)', async () => {
    telegramOn();
    process.env.TURNSTILE_SECRET = 'ts-secret';
    currentUser = null;
    expect(
      (await call('POST', '/api/signup-approvals/notify-self', { email: 'tg7@sxq-co.test', turnstileToken: 'ok' })).status,
    ).toBe(204);
    await __drainSignupTelegramForTests();
    expect(turnstileCalls.length).toBe(1);
    expect(telegramSent.length).toBe(1);
    expect(String(telegramSent[0]!.body.text)).toContain('Trusted via: Turnstile challenge passed');
    expect((await rowFor('tg7@sxq-co.test'))!.trust).toBe('turnstile');
  });

  test('a Turnstile token sent while no secret is configured is NOT verification (skipped → untrusted)', async () => {
    telegramOn();
    currentUser = null;
    expect(
      (await call('POST', '/api/signup-approvals/notify-self', { email: 'tg8@sxq-co.test', turnstileToken: 'anything' })).status,
    ).toBe(204);
    await __drainSignupTelegramForTests();
    expect(turnstileCalls.length).toBe(0);
    expect(telegramSent.length).toBe(0);
    expect((await rowFor('tg8@sxq-co.test'))!.trust).toBeNull();
  });

  test('intake rows are stored trust=intake', async () => {
    currentUser = intakeSa;
    await call('POST', '/api/signup-approvals/intake', intakeBody('tg9@sxq-co.test'));
    expect((await rowFor('tg9@sxq-co.test'))!.trust).toBe('intake');
  });

  test('disabled when ANY of token / chat / thread is unset: no call, and the boot line names what is missing', async () => {
    for (const missing of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_SIGNUP_CHAT_ID', 'TELEGRAM_SIGNUP_THREAD_ID'] as const) {
      telegramOn();
      delete process.env[missing];
      currentUser = intakeSa;
      const email = `off-${missing.toLowerCase()}@sxq-co.test`;
      expect((await call('POST', '/api/signup-approvals/intake', intakeBody(email))).status).toBe(202);
      await __drainSignupTelegramForTests();
      expect(telegramSent.length).toBe(0);

      const lines: string[] = [];
      const orig = console.log;
      console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
      try {
        logSignupTelegramStatus();
      } finally {
        console.log = orig;
      }
      const line = lines.find((l) => l.includes('signup_telegram_disabled'));
      expect(line).toBeDefined();
      expect(line).toContain(missing);
      expect(line).not.toContain(TG_ENV.TELEGRAM_BOT_TOKEN);
    }
  });

  test('bounded retry: 5xx twice then ok = 3 calls; a 400 is not retried; the intake answers 202 regardless', async () => {
    telegramOn();
    currentUser = intakeSa;
    telegramResponses = [
      () => new Response('{}', { status: 502 }),
      () => Response.json({ ok: false, parameters: { retry_after: 1 } }, { status: 429 }),
    ];
    expect((await call('POST', '/api/signup-approvals/intake', intakeBody('rt1@sxq-co.test'))).status).toBe(202);
    await __drainSignupTelegramForTests();
    expect(telegramSent.length).toBe(3);

    telegramSent = [];
    telegramResponses = [() => Response.json({ ok: false, description: 'Bad Request: message thread not found' }, { status: 400 })];
    expect((await call('POST', '/api/signup-approvals/intake', intakeBody('rt2@sxq-co.test'))).status).toBe(202);
    await __drainSignupTelegramForTests();
    expect(telegramSent.length).toBe(1);
  });

  test('a Telegram that throws on every attempt never fails or blocks the intake (max 3 attempts)', async () => {
    telegramOn();
    currentUser = intakeSa;
    let calls = 0;
    __setTelegramFetchForTests(async () => {
      calls++;
      throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TG_ENV.TELEGRAM_BOT_TOKEN}/sendMessage`);
    });
    const errs: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void errs.push(a.map(String).join(' '));
    try {
      expect((await call('POST', '/api/signup-approvals/intake', intakeBody('rt3@sxq-co.test'))).status).toBe(202);
      await __drainSignupTelegramForTests();
    } finally {
      console.warn = orig;
    }
    expect(calls).toBe(3);
    const failed = errs.find((l) => l.includes('signup_telegram_send_failed'));
    expect(failed).toBeDefined();
    expect(failed).not.toContain(TG_ENV.TELEGRAM_BOT_TOKEN); // the token is in the URL — redacted
    expect(await rowFor('rt3@sxq-co.test')).toBeDefined();
  });

  test('reject sends a follow-up with the outcome', async () => {
    telegramOn();
    const [a] = await db.insert(signupApprovals).values({ email: 'rej@sxq-co.test', source: 'web' }).returning();
    currentUser = superAdmin;
    expect((await call('POST', `/api/signup-approvals/${a!.id}/reject`, {})).status).toBe(200);
    await __drainSignupTelegramForTests();
    expect(telegramSent.length).toBe(1);
    expect(telegramSent[0]!.body.message_thread_id).toBe(4242);
    const text = String(telegramSent[0]!.body.text);
    expect(text).toContain('signup rejected');
    expect(text).toContain('Email: rej@sxq-co.test'); // George's private topic: who it was
    expect(text).toContain('Decided via: CP onboarding screen');
    expect(telegramSent[0]!.body.reply_markup).toBeUndefined();
  });

  test('⛔ CP never calls setWebhook / deleteWebhook / getUpdates (source grep, comments excluded)', () => {
    const root = join(import.meta.dir, '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const code = readFileSync(p, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n')
            .filter((l) => !l.trim().startsWith('//'))
            .join('\n');
          if (/setWebhook|deleteWebhook|getUpdates|getWebhookInfo/.test(code)) offenders.push(p);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
    // And the one Telegram method CP does call is sendMessage.
    const tg = readFileSync(join(root, 'services', 'signup-telegram.ts'), 'utf8');
    expect(tg).toContain('/sendMessage');
  });
});

// =================================================================================================
describe('Turnstile', () => {
  test('off (no secret, not required): anonymous notify-self unchanged, no siteverify call', async () => {
    currentUser = null;
    expect((await call('POST', '/api/signup-approvals/notify-self', { email: 'ts0@sxq-co.test' })).status).toBe(204);
    expect(turnstileCalls.length).toBe(0);
  });

  test('required + secret: an anonymous submission without a token → 403 turnstile_required, nothing recorded', async () => {
    process.env.TURNSTILE_SECRET = 'ts-secret';
    process.env.TURNSTILE_REQUIRED = 'true';
    currentUser = null;
    const res = await call('POST', '/api/signup-approvals/notify-self', { email: 'ts1@sxq-co.test' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('turnstile_required');
    expect(await rowFor('ts1@sxq-co.test')).toBeUndefined();
  });

  test('required + secret: a token siteverify accepts → 204; the secret, token and remoteip are sent', async () => {
    process.env.TURNSTILE_SECRET = 'ts-secret';
    process.env.TURNSTILE_REQUIRED = 'true';
    currentUser = null;
    const res = await call(
      'POST',
      '/api/signup-approvals/notify-self',
      { email: 'ts2@sxq-co.test', turnstileToken: 'tok-ok' },
      { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
    );
    expect(res.status).toBe(204);
    expect(turnstileCalls.length).toBe(1);
    expect(turnstileCalls[0]!.get('secret')).toBe('ts-secret');
    expect(turnstileCalls[0]!.get('response')).toBe('tok-ok');
    expect(turnstileCalls[0]!.get('remoteip')).toBe('203.0.113.9'); // rightmost, istio-observed
  });

  test('a token siteverify REJECTS → 403 turnstile_failed (also when not required)', async () => {
    process.env.TURNSTILE_SECRET = 'ts-secret';
    turnstileAnswer = () => Response.json({ success: false, 'error-codes': ['invalid-input-response'] });
    currentUser = null;
    const res = await call('POST', '/api/signup-approvals/notify-self', { email: 'ts3@sxq-co.test', turnstileToken: 'bad' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('turnstile_failed');
    expect(await rowFor('ts3@sxq-co.test')).toBeUndefined();
  });

  test('siteverify unreachable → 503 turnstile_unavailable (fail closed)', async () => {
    process.env.TURNSTILE_SECRET = 'ts-secret';
    turnstileAnswer = () => new Response('boom', { status: 500 });
    currentUser = null;
    const res = await call('POST', '/api/signup-approvals/notify-self', { email: 'ts4@sxq-co.test', turnstileToken: 'x' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('turnstile_unavailable');
  });

  test('required WITHOUT a secret → 503 turnstile_unconfigured for anonymous callers', async () => {
    process.env.TURNSTILE_REQUIRED = 'true';
    currentUser = null;
    const res = await call('POST', '/api/signup-approvals/notify-self', { email: 'ts5@sxq-co.test' });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('turnstile_unconfigured');
  });

  test('required does NOT apply to a signed-in SPA caller, nor to the server-to-server intake', async () => {
    process.env.TURNSTILE_SECRET = 'ts-secret';
    process.env.TURNSTILE_REQUIRED = 'true';
    currentUser = { id: '00000000-0000-4000-8000-00005e9a0077', email: 'spa@sxq-co.test', name: 'Spa', roles: [] };
    expect((await call('POST', '/api/signup-approvals/notify-self', { email: 'spa@sxq-co.test' })).status).toBe(204);
    currentUser = intakeSa;
    expect((await call('POST', '/api/signup-approvals/intake', intakeBody('ts6@sxq-co.test'))).status).toBe(202);
    expect(turnstileCalls.length).toBe(0);
  });

  test('intake relays the end user token: verified when present', async () => {
    process.env.TURNSTILE_SECRET = 'ts-secret';
    currentUser = intakeSa;
    expect((await call('POST', '/api/signup-approvals/intake', intakeBody('ts7@sxq-co.test', { turnstileToken: 'good' }))).status).toBe(202);
    expect(turnstileCalls.length).toBe(1);
    turnstileAnswer = () => Response.json({ success: false });
    const res = await call('POST', '/api/signup-approvals/intake', intakeBody('ts8@sxq-co.test', { turnstileToken: 'bad' }));
    expect(res.status).toBe(403);
    expect(await rowFor('ts8@sxq-co.test')).toBeUndefined();
  });
});

// =================================================================================================
describe('default workspace name (pure)', () => {
  const pub = new Set(PUBLIC_EMAIL_DOMAINS);
  test('company first, then the organisation label, never a public mailbox provider', () => {
    expect(defaultTenantNameFrom({ company: 'Globex Ltd', email: 'a@x.test', name: 'A B' }, pub)).toBe('Globex Ltd');
    expect(defaultTenantNameFrom({ email: 'ann@mail.acme.co.uk', name: 'Ann' }, pub)).toBe('acme');
    expect(defaultTenantNameFrom({ email: 'ann@initech.com', name: 'Ann' }, pub)).toBe('initech');
    expect(defaultTenantNameFrom({ email: 'jane@gmail.com', name: 'Jane Doe' }, pub)).toBe('Jane Doe');
    expect(defaultTenantNameFrom({ email: 'jane.doe@outlook.com', name: null }, pub)).toBe('jane.doe');
    // A blank / symbol-only company does not win.
    expect(defaultTenantNameFrom({ company: ' -- ', email: 'x@umbrella.io' }, pub)).toBe('umbrella');
  });
  test('organisationLabel', () => {
    expect(organisationLabel('acme.com')).toBe('acme');
    expect(organisationLabel('eu.corp.acme.com.au')).toBe('acme');
    expect(organisationLabel('localhost')).toBe('localhost');
  });
});

// =================================================================================================
describe('approve defaults (self-signup)', () => {
  async function pending(email: string, extra: Partial<typeof signupApprovals.$inferInsert> = {}) {
    const [a] = await db.insert(signupApprovals).values({ email, source: 'web', ...extra }).returning();
    return a!;
  }
  async function approveNew(id: string, body: Record<string, unknown> = {}) {
    currentUser = superAdmin;
    return call('POST', `/api/signup-approvals/${id}/approve`, { mode: 'new_tenant', ...body });
  }
  type Approved = {
    tenantId: string;
    role: string;
    tenant: { slug: string; licencesName: string | null; name: string };
    invite: { email: string; role: string } | null;
  };

  test('no tenantName / byoMode: named after the company, plan posture applies, first admin = the signup', async () => {
    const fake = centralOn();
    try {
      const a = await pending('boss@sxq-co.test', { company: 'SXQ Initrode', name: 'Bo Boss' });
      const res = await approveNew(a.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Approved;
      expect(body.tenant.name).toBe('SXQ Initrode');
      expect(body.tenant.slug).toBe('sxq-initrode');
      expect(body.tenant.licencesName).toBe('sxq-initrode'); // ONE name, both sides
      expect(fake.calls.registered[0]).toEqual({ tenantId: body.tenantId, name: 'sxq-initrode' });
      expect(body.role).toBe('tenant_admin');
      expect(body.invite?.email).toBe('boss@sxq-co.test');
      expect(body.invite?.role).toBe('tenant_admin');
    } finally {
      centralOff();
    }
  });

  test('⛔ early access: approved with NO plan → local-llm (LICENSE_PLAN_CODE=byo notwithstanding); byo_required → byo', async () => {
    const fake = centralOn(); // sets the deployment default to `byo`, like prod
    try {
      const a = await pending('ea-default@sxq-co.test', { company: 'SXQ Early Default' });
      const res = await approveNew(a.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Approved;
      const [t] = await db
        .select({ plan: tenants.plan_code, enc: tenants.inference_token_encrypted })
        .from(tenants)
        .where(eq(tenants.id, body.tenantId));
      expect(t!.plan).toBe('local-llm');
      expect(t!.enc, 'its own inference-router credential was stored').toBeTruthy();
      expect(fake.calls.byo).toEqual([{ tenantId: body.tenantId, mode: 'local_allowed' }]);

      // An explicit posture the default plan would contradict keeps the deployment default.
      const b = await pending('ea-byo@sxq-co.test', { company: 'SXQ Early Byo' });
      const res2 = await approveNew(b.id, { byoMode: 'byo_required' });
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as Approved;
      const [t2] = await db.select({ plan: tenants.plan_code }).from(tenants).where(eq(tenants.id, body2.tenantId));
      expect(t2!.plan).toBe('byo');
    } finally {
      centralOff();
    }
  });

  test('no company: the email domain (organisation label); a public provider uses the person\'s name', async () => {
    centralOn();
    try {
      const a = await pending('ceo@sxq-globex.test');
      const r1 = (await (await approveNew(a.id)).json()) as Approved;
      expect(r1.tenant.slug).toBe('sxq-globex');
      const b = await pending('sxq.jane@gmail.com', { name: 'SXQ Jane Doe' });
      const r2 = (await (await approveNew(b.id)).json()) as Approved;
      expect(r2.tenant.slug).toBe('sxq-jane-doe');
    } finally {
      centralOff();
    }
  });

  test('licences 409 on the name → auto-suffix -2, -3; CP slug == licences name; final name audited', async () => {
    const fake = centralOn(['sxq-umbrella', 'sxq-umbrella-2']);
    try {
      const a = await pending('u@sxq-co.test', { company: 'SXQ Umbrella' });
      const res = await approveNew(a.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Approved;
      // (the licence mint re-registers idempotently afterwards — under the SAME final name)
      expect([...new Set(fake.calls.attempted)]).toEqual(['sxq-umbrella', 'sxq-umbrella-2', 'sxq-umbrella-3']);
      expect(body.tenant.slug).toBe('sxq-umbrella-3');
      expect(body.tenant.licencesName).toBe('sxq-umbrella-3');
      const [t] = await db.select().from(tenants).where(eq(tenants.id, body.tenantId));
      expect(t!.slug).toBe(t!.licences_name!);
      const [audit] = await db
        .select()
        .from(auditLog)
        .where(sql`${auditLog.action} = 'signup.approve' AND ${auditLog.metadata}->>'approvalId' = ${a.id}`);
      expect((audit!.metadata as Record<string, unknown>).licencesName).toBe('sxq-umbrella-3');
      expect((audit!.metadata as Record<string, unknown>).nameDefaulted).toBe(true);
    } finally {
      centralOff();
    }
  });

  test('a CP slug collision is skipped too, and the licences name follows the CP slug (no split-brain)', async () => {
    const fake = centralOn();
    try {
      await db.insert(tenants).values({ id: '00000000-0000-4000-8000-00005e9a0c01', name: 'old', slug: 'sxq-hooli' });
      const a = await pending('h@sxq-co.test', { company: 'SXQ Hooli' });
      const body = (await (await approveNew(a.id)).json()) as Approved;
      // `sxq-hooli` is never offered to licences (the mint's idempotent re-register repeats -2).
      expect([...new Set(fake.calls.attempted)]).toEqual(['sxq-hooli-2']);
      expect(body.tenant.slug).toBe('sxq-hooli-2');
      expect(body.tenant.licencesName).toBe('sxq-hooli-2');
    } finally {
      centralOff();
    }
  });

  test('the auto-suffix is BOUNDED: every candidate taken → 409, nothing created', async () => {
    const taken = ['sxq-full', ...Array.from({ length: 9 }, (_, i) => `sxq-full-${i + 2}`)];
    const fake = centralOn(taken);
    try {
      const a = await pending('f@sxq-co.test', { company: 'SXQ Full' });
      const res = await approveNew(a.id);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('licences_name_unavailable');
      expect(fake.calls.attempted.length).toBe(10);
      expect((await rowFor('f@sxq-co.test'))!.status).toBe('pending');
    } finally {
      centralOff();
    }
  });

  test('an explicit tenantName is used as typed (still auto-suffixed on this path)', async () => {
    centralOn(['sxq-typed']);
    try {
      const a = await pending('t@sxq-co.test', { company: 'Ignored Co' });
      const body = (await (await approveNew(a.id, { tenantName: 'SXQ Typed' })).json()) as Approved;
      expect(body.tenant.name).toBe('SXQ Typed');
      expect(body.tenant.slug).toBe('sxq-typed-2');
    } finally {
      centralOff();
    }
  });

  test('⛔ super_admin createTenant (POST /api/tenants) does NOT auto-suffix: 409, one attempt', async () => {
    const fake = centralOn(['sxq-manual']);
    try {
      currentUser = superAdmin;
      const res = await call('POST', '/api/tenants', { name: 'SXQ Manual', byoMode: 'byo_required' });
      expect(res.status).toBe(409);
      expect(fake.calls.attempted).toEqual(['sxq-manual']);
      // A CP-side slug collision is a 409 too — never a silently different slug.
      await db.insert(tenants).values({ id: '00000000-0000-4000-8000-00005e9a0c02', name: 'x', slug: 'sxq-cpdup' });
      const res2 = await call('POST', '/api/tenants', { name: 'SXQ CPDup', byoMode: 'byo_required' });
      expect(res2.status).toBe(409);
      expect(fake.calls.attempted).toEqual(['sxq-manual']); // licences never asked for the CP-taken name
    } finally {
      centralOff();
    }
  });

  test('approve sends a decision follow-up: outcome, tenant id, provisioning summary', async () => {
    telegramOn();
    centralOn();
    try {
      const a = await pending('dec@sxq-co.test', { company: 'SXQ Decided' });
      const body = (await (await approveNew(a.id)).json()) as Approved;
      await __drainSignupTelegramForTests();
      expect(telegramSent.length).toBe(1);
      const text = String(telegramSent[0]!.body.text);
      expect(text).toContain('signup approved');
      expect(text).toContain('Email: dec@sxq-co.test');
      expect(text).toContain(`Tenant id: ${body.tenantId}`);
      expect(text).toContain('Workspace: SXQ Decided');
      // Licence at approval: seated now, the set-password email went out after the member licence.
      expect(text).toContain('Requester seated as tenant admin; set-password email sent (keycloak_actions).');
      expect(text).toMatch(/Provisioning: all steps ok\.|Provisioning steps NOT ok:/);
    } finally {
      centralOff();
    }
  });

  test('the queue listing carries the suggested name the dialog prefills', async () => {
    await pending('sg@sxq-co.test', { company: 'SXQ Suggest' });
    currentUser = superAdmin;
    const res = await call('GET', '/api/signup-approvals?status=pending');
    const body = (await res.json()) as { approvals: Array<{ email: string; suggested_tenant_name: string; company: string | null; source: string | null }> };
    const row = body.approvals.find((r) => r.email === 'sg@sxq-co.test')!;
    expect(row.suggested_tenant_name).toBe('SXQ Suggest');
    expect(row.company).toBe('SXQ Suggest');
    expect(row.source).toBe('web');
  });
});

// =================================================================================================
describe('message spoofing — input normalisation', () => {
  test('singleLine strips Cc/Cf/bidi/separators, collapses whitespace, trims', () => {
    expect(singleLine('Ann\nSignup id: forged\r\nApprove')).toBe('Ann Signup id: forged Approve');
    expect(singleLine('  a\t\tb  ')).toBe('a b');
    // RLO / LRI / PDI / zero-width / BOM / soft hyphen are removed outright (Cf)
    expect(singleLine('ev‮il⁦x⁩​﻿­!')).toBe('evilx!');
    // C1 control, line + paragraph separators, NBSP
    expect(singleLine('a\u0085b c d e')).toBe('a b c d e');
    expect(singleLine('‮​ \n')).toBe('');
  });

  test('intake: a name with newlines/bidi is STORED single-line', async () => {
    currentUser = intakeSa;
    const res = await call(
      'POST',
      '/api/signup-approvals/intake',
      intakeBody('sp1@sxq-co.test', { name: 'Ann\n\nVerified: YES‮', company: 'Acme\r\nhttps://evil.example' }),
    );
    expect(res.status).toBe(202);
    const row = await rowFor('sp1@sxq-co.test');
    expect(row!.name).toBe('Ann Verified: YES');
    expect(row!.company).toBe('Acme https://evil.example');
  });

  test('intake/notify-self: a name or company that is empty after stripping → 422, nothing written', async () => {
    currentUser = intakeSa;
    for (const extra of [{ name: '‮​\n ' }, { company: '\t⁦⁩' }]) {
      const res = await call('POST', '/api/signup-approvals/intake', intakeBody('sp2@sxq-co.test', extra));
      expect(res.status).toBe(422);
    }
    expect(await rowFor('sp2@sxq-co.test')).toBeUndefined();
    currentUser = null;
    const res = await call('POST', '/api/signup-approvals/notify-self', { email: 'sp2@sxq-co.test', name: '\n​' });
    expect(res.status).toBe(422);
    expect(await rowFor('sp2@sxq-co.test')).toBeUndefined();
  });

  test('length is enforced AFTER normalisation (160), and the raw input is bounded too', async () => {
    currentUser = intakeSa;
    const ok = await call('POST', '/api/signup-approvals/intake', intakeBody('sp3@sxq-co.test', { name: `${'a'.repeat(160)}\n\n\n` }));
    expect(ok.status).toBe(202);
    const long = await call('POST', '/api/signup-approvals/intake', intakeBody('sp4@sxq-co.test', { name: 'a'.repeat(161) }));
    expect(long.status).toBe(422);
    const huge = await call('POST', '/api/signup-approvals/intake', intakeBody('sp5@sxq-co.test', { name: `a${'​'.repeat(700)}` }));
    expect(huge.status).toBe(422);
  });
});

// =================================================================================================
describe('Telegram messages: requester values are inert code entities (George 2026-10-19)', () => {
  // What a requester might type, including attempts to smuggle a line or a link into the message.
  const PERSONAL = {
    email: 'kees.dpo-probe@sxq-co.test',
    name: 'Kees Probe\nSignup id: forged https://evil.example/approve',
    company: 'Probe BV t.me/evil',
  };
  const id = '00000000-0000-4000-8000-00005e9a0f01';

  function codeSpans(p: Record<string, unknown>): string[] {
    const text = String(p.text);
    return (p.entities as Array<{ type: string; offset: number; length: number }>).map((e) => {
      expect(e.type).toBe('code');
      return text.slice(e.offset, e.offset + e.length);
    });
  }

  function assertInert(p: Record<string, unknown>) {
    expect(p.parse_mode).toBeUndefined();
    expect(p.link_preview_options).toEqual({ is_disabled: true });
    const text = String(p.text);
    const spans = codeSpans(p);
    // Every URL-shaped fragment sits INSIDE a code entity (Telegram would auto-link it otherwise).
    for (const frag of ['https://evil.example/approve', 't.me/evil', 'kees.dpo-probe@sxq-co.test']) {
      if (text.includes(frag)) expect(spans.some((sp) => sp.includes(frag))).toBe(true);
    }
    // A newline in a value cannot forge a line: exactly one real `Signup id:` line.
    expect(text.split('\n').filter((l) => l.startsWith('Signup id:'))).toEqual([`Signup id: ${id}`]);
  }

  test('a new signup: name, email, company, language and a message excerpt — each in a code entity', () => {
    telegramOn();
    const p = newSignupPayload({
      id,
      source: 'web',
      trust: 'intake',
      pendingTotal: 3,
      ...PERSONAL,
      message: `${'x'.repeat(310)} https://evil.example/approve`,
      locale: 'nl',
    });
    assertInert(p);
    const text = String(p.text);
    expect(text.startsWith(NEW_SIGNUP_HEADLINE)).toBe(true);
    expect(text).toContain('Pending signups: 3');
    expect(text).toContain('Language: nl');
    const spans = codeSpans(p);
    expect(spans[0]).toBe('Kees Probe Signup id: forged https://evil.example/approve');
    expect(spans[1]).toBe(PERSONAL.email);
    expect(spans[2]).toBe(PERSONAL.company);
    // The excerpt: ≤300 characters + an ellipsis, so the link at the end never makes it in.
    expect(spans[3]).toBe(`${'x'.repeat(300)}…`);
  });

  test('no language told → "— (en)"; no message → no Message line', () => {
    telegramOn();
    const p = newSignupPayload({ id, source: 'web', trust: 'intake', pendingTotal: 1, email: 'a@sxq-co.test', name: 'A', company: null });
    const text = String(p.text);
    expect(text).toContain('Language: — (en)');
    expect(text).not.toContain('Message:');
    expect(text).toContain('Company: —');
    expect(codeSpans(p)).toEqual(['A', 'a@sxq-co.test']);
  });

  test('the decision follow-ups name the requester and the workspace, inertly', () => {
    telegramOn();
    for (const outcome of ['approved', 'rejected'] as const) {
      const p = decisionPayload({
        id,
        outcome,
        tenantId: id,
        seated: true,
        inviteDelivery: 'deferred',
        email: PERSONAL.email,
        name: PERSONAL.name,
        tenantName: PERSONAL.company,
        tenantSlug: 'probe-bv',
        decidedVia: 'Telegram (user 42)',
      });
      assertInert(p);
      const text = String(p.text);
      expect(text).toContain(`signup ${outcome}`);
      expect(text).toContain('Decided via: Telegram (user 42)');
      expect(codeSpans(p).slice(0, 2)).toEqual(['Kees Probe Signup id: forged https://evil.example/approve', PERSONAL.email]);
      if (outcome === 'approved') {
        expect(text).toContain('Slug: probe-bv');
        expect(text).toContain('the set-password email follows once their licence exists');
      }
    }
  });
});

// =================================================================================================
describe('unverified-signup digest', () => {
  const DIGEST_KEY = 'signup_digest';
  async function isolate() {
    // Other suites' leftover untrusted rows must not count as "new" here.
    await db.execute(sql`UPDATE signup_approvals SET digested_at = now()
                          WHERE status = 'pending' AND trust IS NULL AND digested_at IS NULL`);
    await db.delete(schedulerTicks).where(eq(schedulerTicks.key, DIGEST_KEY));
  }
  async function anon(email: string) {
    currentUser = null;
    expect((await call('POST', '/api/signup-approvals/notify-self', { email })).status).toBe(204);
  }

  test('disabled without Telegram, or with SIGNUP_DIGEST_INTERVAL_HOURS=0', async () => {
    await isolate();
    await anon('dg0@sxq-co.test');
    expect(await runSignupDigestOnce()).toBe('disabled');
    telegramOn();
    process.env.SIGNUP_DIGEST_INTERVAL_HOURS = '0';
    try {
      expect(await runSignupDigestOnce()).toBe('disabled');
    } finally {
      delete process.env.SIGNUP_DIGEST_INTERVAL_HOURS;
    }
    expect(telegramSent.length).toBe(0);
  });

  test('ONE digest with counts and a queue link; then quiet (nothing new, then rate-limited)', async () => {
    await isolate();
    telegramOn();
    try {
      expect(await runSignupDigestOnce()).toBe('nothing_new');
      await anon('dg1@sxq-co.test');
      await anon('dg2@sxq-co.test');
      // A trusted row is not part of the digest.
      currentUser = intakeSa;
      await call('POST', '/api/signup-approvals/intake', intakeBody('dg3@sxq-co.test'));
      await __drainSignupTelegramForTests();
      telegramSent = [];

      expect(await runSignupDigestOnce()).toBe('sent');
      await __drainSignupTelegramForTests();
      expect(telegramSent.length).toBe(1);
      const body = telegramSent[0]!.body;
      const text = String(body.text);
      expect(text).toMatch(/^\d+ unverified CommonPractice signups waiting \(2 new since the last digest\)/);
      expect(Number(text.split(' ')[0])).toBeGreaterThanOrEqual(2);
      expect(text).not.toContain('dg1@sxq-co.test'); // counts only
      expect(body.message_thread_id).toBe(4242);
      expect(body.reply_markup).toEqual({
        inline_keyboard: [[{ text: 'Open signup queue', url: 'https://cp.example.test/onboarding' }]],
      });
      expect((await rowFor('dg1@sxq-co.test'))!.digested_at).not.toBeNull();
      expect((await rowFor('dg3@sxq-co.test'))!.digested_at).toBeNull();

      // Nothing new since → no claim, no message.
      expect(await runSignupDigestOnce()).toBe('nothing_new');
      // Something new, but inside the window → refused by the scheduler_ticks claim.
      await anon('dg4@sxq-co.test');
      expect(await runSignupDigestOnce()).toBe('claimed_elsewhere');
      await __drainSignupTelegramForTests();
      expect(telegramSent.length).toBe(1);
      expect((await rowFor('dg4@sxq-co.test'))!.digested_at).toBeNull(); // kept for the next window

      // Window elapsed → the next digest reports only the new one.
      await db.execute(sql`UPDATE scheduler_ticks SET last_run_at = now() - interval '7 hours' WHERE key = ${DIGEST_KEY}`);
      expect(await runSignupDigestOnce()).toBe('sent');
      await __drainSignupTelegramForTests();
      expect(telegramSent.length).toBe(2);
      expect(String(telegramSent[1]!.body.text)).toContain('(1 new since the last digest)');
    } finally {
      await db.delete(schedulerTicks).where(eq(schedulerTicks.key, DIGEST_KEY));
    }
  });
});

// =================================================================================================
describe('rename keeps the slug and the licences name together', () => {
  test('⛔ PATCH name changes the display name only: slug + licences_name stay equal, licences not called', async () => {
    const fake = centralOn();
    let renames = 0;
    fake.client.renameTenant = async () => {
      renames++;
    };
    try {
      currentUser = superAdmin;
      const created = await call('POST', '/api/tenants', { name: 'SXQ Rename Me', byoMode: 'byo_required' });
      expect(created.status).toBe(201);
      const { tenant } = (await created.json()) as { tenant: { id: string } };
      const res = await call('PATCH', `/api/tenants/${tenant.id}`, { name: 'Something Else Entirely' });
      expect(res.status).toBe(200);
      const [row] = await db.select().from(tenants).where(eq(tenants.id, tenant.id));
      expect(row!.name).toBe('Something Else Entirely');
      expect(row!.slug).toBe('sxq-rename-me');
      expect(row!.licences_name).toBe('sxq-rename-me');
      expect(renames).toBe(0);
      const [a] = await db
        .select()
        .from(auditLog)
        .where(sql`${auditLog.target_id} = ${tenant.id} AND ${auditLog.action} = 'tenant.rename'`);
      expect(a?.metadata).toMatchObject({
        before: { name: 'SXQ Rename Me' },
        after: { name: 'Something Else Entirely' },
        slug: 'sxq-rename-me',
        licencesName: 'sxq-rename-me',
      });
    } finally {
      centralOff();
    }
  });
});

// =================================================================================================
describe('intake message — the applicant’s free text', () => {
  const MSG = 'Hello,\nwe run 3 clinics.\n\nCan we try it?';

  test('stored on the row, line breaks kept', async () => {
    currentUser = intakeSa;
    const res = await call('POST', '/api/signup-approvals/intake', intakeBody('msg1@sxq-co.test', { message: MSG }));
    expect(res.status).toBe(202);
    expect((await rowFor('msg1@sxq-co.test'))!.message).toBe(MSG);
  });

  test('absent / empty-after-stripping → NULL', async () => {
    currentUser = intakeSa;
    expect((await call('POST', '/api/signup-approvals/intake', intakeBody('msg2@sxq-co.test'))).status).toBe(202);
    expect((await rowFor('msg2@sxq-co.test'))!.message).toBeNull();
    expect((await call('POST', '/api/signup-approvals/intake', intakeBody('msg3@sxq-co.test', { message: ' ​\u0000\n ' }))).status).toBe(202);
    expect((await rowFor('msg3@sxq-co.test'))!.message).toBeNull();
  });

  test('control / bidi / zero-width characters are stripped; CRLF and U+2028 become \\n; tab a space', async () => {
    currentUser = intakeSa;
    const raw = ' Hi\u0000 there\r\nline two‮​\tend\u0007\u0085 ';
    expect((await call('POST', '/api/signup-approvals/intake', intakeBody('msg4@sxq-co.test', { message: raw }))).status).toBe(202);
    expect((await rowFor('msg4@sxq-co.test'))!.message).toBe('Hi there\nline\ntwo end');
  });

  test('a message over 2000 characters is a 422, nothing written', async () => {
    currentUser = intakeSa;
    const long = await call('POST', '/api/signup-approvals/intake', intakeBody('msg5@sxq-co.test', { message: 'a'.repeat(2001) }));
    expect(long.status).toBe(422);
    expect(await rowFor('msg5@sxq-co.test')).toBeUndefined();
  });

  test('exactly 2000 characters is accepted', async () => {
    currentUser = intakeSa;
    const ok = await call('POST', '/api/signup-approvals/intake', intakeBody('msg6@sxq-co.test', { message: 'a'.repeat(2000) }));
    expect(ok.status).toBe(202);
    expect((await rowFor('msg6@sxq-co.test'))!.message!.length).toBe(2000);
  });

  test('the DB CHECK refuses a too-long message from any writer', async () => {
    // ⚠️ try/catch, NOT `expect(...).rejects.toThrow(...)`: under bun 1.3.14 that matcher HANGS the
    // run (CPU-bound, no output) on this PostgresError, whose `detail` carries the 2001-char row.
    let msg = 'no error';
    try {
      await queryClient.unsafe(
        `INSERT INTO signup_approvals (email, message) VALUES ('msg7@sxq-co.test', repeat('a', 2001))`,
      );
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toContain('signup_approvals_message_length_check');
  });

  test('the Telegram notice carries a ONE-LINE excerpt of the message, inside a code entity', async () => {
    telegramOn();
    currentUser = intakeSa;
    const message = 'SXQ-needle\nplease call me on +31 6 1234';
    expect((await call('POST', '/api/signup-approvals/intake', intakeBody('msg8@sxq-co.test', { message }))).status).toBe(202);
    await __drainSignupTelegramForTests();
    expect(telegramSent.length).toBe(1);
    const body = telegramSent[0]!.body;
    const text = String(body.text);
    expect(text).toContain('Message: SXQ-needle please call me on +31 6 1234');
    const spans = (body.entities as Array<{ offset: number; length: number }>).map((e) => text.slice(e.offset, e.offset + e.length));
    expect(spans).toContain('SXQ-needle please call me on +31 6 1234');
  });

  test('the admin list and detail DTOs carry it', async () => {
    currentUser = intakeSa;
    expect((await call('POST', '/api/signup-approvals/intake', intakeBody('msg9@sxq-co.test', { message: MSG }))).status).toBe(202);
    currentUser = superAdmin;
    const list = (await (await call('GET', '/api/signup-approvals?status=pending')).json()) as {
      approvals: Array<{ id: string; email: string; message: string | null }>;
    };
    const row = list.approvals.find((r) => r.email === 'msg9@sxq-co.test')!;
    expect(row.message).toBe(MSG);
    const detail = (await (await call('GET', `/api/signup-approvals/${row.id}`)).json()) as { approval: { message: string | null } };
    expect(detail.approval.message).toBe(MSG);
  });
});

// =================================================================================================
describe('POST /api/signup-approvals/invite — pre-approved early-access invite (super_admin)', () => {
  const HOME_TENANT = '00000000-0000-4000-8000-00005e9a0c11';
  const HOME_USER = '00000000-0000-4000-8000-00005e9a0d11';
  type Invited = {
    approval: { id: string; status: string; source: string | null };
    tenantId: string;
    role: string;
    seated: boolean;
    seatedAtApproval: boolean;
    tenant: { name: string; slug: string };
    invite: { email: string; role: string; emailDelivery: string; inviteUrl: string } | null;
    provisioning: { steps: Record<string, { status: string; code: string | null } | undefined> };
  };
  async function invite(body: Record<string, unknown>) {
    currentUser = superAdmin;
    return call('POST', '/api/signup-approvals/invite', body);
  }
  async function rowsFor(email: string) {
    return db.select().from(signupApprovals).where(sql`lower(email) = lower(${email})`);
  }

  test('the literal `invite` segment is its own route — never captured as an approval :id', () => {
    const post = router.match('POST', '/api/signup-approvals/invite');
    expect(post?.template).toBe('/api/signup-approvals/invite');
    // GET has no `invite` route, so it falls to `:id` — proving the POST match above is not luck.
    expect(router.match('GET', '/api/signup-approvals/invite')?.template).toBe('/api/signup-approvals/:id');
    // and the parametric approve route still matches a real id
    expect(router.match('POST', '/api/signup-approvals/abc/approve')?.template).toBe('/api/signup-approvals/:id/approve');
    // declared BEFORE every :id route (first match wins in utils/router.ts)
    const templates = router.list().map((r) => r.template);
    const at = templates.indexOf('/api/signup-approvals/invite');
    expect(at).toBeGreaterThanOrEqual(0);
    for (const t of templates) {
      if (t.startsWith('/api/signup-approvals/:id')) expect(templates.indexOf(t)).toBeGreaterThan(at);
    }
  });

  test('non-super_admin → 403 (and unauthenticated → 401); nothing recorded', async () => {
    currentUser = { id: '00000000-0000-4000-8000-00005e9a0d12', email: 'm@sxq-co.test', name: 'M', roles: [] };
    const res = await call('POST', '/api/signup-approvals/invite', { email: 'no@sxq-co.test', name: 'No One' });
    expect(res.status).toBe(403);
    currentUser = intakeSa; // the intake service account is not a super_admin either
    expect((await call('POST', '/api/signup-approvals/invite', { email: 'no@sxq-co.test', name: 'No One' })).status).toBe(403);
    currentUser = null;
    expect((await call('POST', '/api/signup-approvals/invite', { email: 'no@sxq-co.test', name: 'No One' })).status).toBe(401);
    expect(await rowsFor('no@sxq-co.test')).toHaveLength(0);
  });

  test('a new address → 200: row source=invite, approved, new workspace (local-llm) + tenant_admin invite; no new-signup Telegram', async () => {
    telegramOn();
    centralOn();
    try {
      const res = await invite({ email: '  Direct@sxq-co.test ', name: 'Di Rect', company: 'SXQ Direct' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Invited;
      expect(body.tenant.name).toBe('SXQ Direct');
      expect(body.tenant.slug).toBe('sxq-direct');
      expect(body.role).toBe('tenant_admin');
      // `seated` keeps its meaning (a KNOWN, verified sub seated directly); the identity CP minted
      // for this invite is seated at approval instead (licence at approval, George 2026-10-19).
      expect(body.seated).toBe(false);
      expect(body.seatedAtApproval).toBe(true);
      expect(body.invite?.email.toLowerCase()).toBe('direct@sxq-co.test');
      expect(body.invite?.role).toBe('tenant_admin');
      expect(body.invite?.emailDelivery).toBe('keycloak_actions'); // a new identity: set-password email

      const rows = await rowsFor('direct@sxq-co.test');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.email).toBe('Direct@sxq-co.test'); // trimmed
      expect(rows[0]!.source).toBe('invite');
      expect(rows[0]!.status).toBe('approved');
      expect(rows[0]!.keycloak_sub).toBeNull();
      expect(rows[0]!.trust).toBeNull();
      expect(rows[0]!.company).toBe('SXQ Direct');
      expect(rows[0]!.assigned_tenant_id).toBe(body.tenantId);

      const [t] = await db.select({ plan: tenants.plan_code }).from(tenants).where(eq(tenants.id, body.tenantId));
      expect(t!.plan).toBe('local-llm');
      // Seated NOW: the CP user (the identity CP minted) is the workspace's tenant_admin already.
      const seatedRows = await db.select().from(users).where(sql`lower(email) = 'direct@sxq-co.test'`);
      expect(seatedRows).toHaveLength(1);
      expect(seatedRows[0]!.tenant_id).toBe(body.tenantId);
      expect(seatedRows[0]!.tenant_role).toBe('tenant_admin');
      // …and the set-password email went out AFTER the member licence, in the default language.
      const prov = body.provisioning.steps;
      expect(prov.member_seat?.status).toBe('ok');
      expect(prov.member_licence?.status).toBe('ok');
      expect(prov.invite_email?.status).toBe('ok');
      expect(kcCalls.map((c) => c.kind)).toEqual(['attrs', 'email']);
      expect(kcCalls[0]).toMatchObject({ kind: 'attrs', patch: { locale: 'en', signup_app: 'commonpractice', signup_book_url: null } });

      const audits = await db
        .select()
        .from(auditLog)
        .where(sql`${auditLog.metadata}->>'approvalId' = ${rows[0]!.id}`);
      const actions = audits.map((a) => a.action).sort();
      expect(actions).toEqual(['signup.approve', 'signup.invite']);
      const inv = audits.find((a) => a.action === 'signup.invite')!;
      expect((inv.metadata as Record<string, unknown>).reusedPending).toBe(false);
      expect(inv.category).toBe('auth');

      await __drainSignupTelegramForTests();
      // exactly the decision follow-up; never the "new signup" announcement
      expect(telegramSent.length).toBe(1);
      const text = String(telegramSent[0]!.body.text);
      expect(text).toContain('signup approved');
      expect(text).not.toContain(NEW_SIGNUP_HEADLINE);
    } finally {
      centralOff();
    }
  });

  test('an existing PENDING intake row for the address is reused (still one row) and approved', async () => {
    centralOn();
    try {
      currentUser = intakeSa;
      expect((await call('POST', '/api/signup-approvals/intake', intakeBody('queued@sxq-co.test', { company: 'SXQ Queued' }))).status).toBe(202);
      const [before] = await rowsFor('queued@sxq-co.test');
      expect(before!.status).toBe('pending');

      const res = await invite({ email: 'QUEUED@sxq-co.test', name: 'Que Ued', company: 'SXQ Other' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Invited;
      const rows = await rowsFor('queued@sxq-co.test');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(before!.id);
      expect(rows[0]!.status).toBe('approved');
      expect(rows[0]!.source).toBe('web'); // how it arrived is kept
      expect(body.approval.id).toBe(before!.id);
      expect(body.tenant.name).toBe('SXQ Queued'); // the queued row's company names the workspace

      const [inv] = await db
        .select()
        .from(auditLog)
        .where(sql`${auditLog.action} = 'signup.invite' AND ${auditLog.metadata}->>'approvalId' = ${before!.id}`);
      expect((inv!.metadata as Record<string, unknown>).reusedPending).toBe(true);
    } finally {
      centralOff();
    }
  });

  test('an explicit tenantName is used', async () => {
    centralOn();
    try {
      const body = (await (await invite({ email: 'named@sxq-co.test', name: 'Na Med', tenantName: 'SXQ Named' })).json()) as Invited;
      expect(body.tenant.name).toBe('SXQ Named');
      expect(body.tenant.slug).toBe('sxq-named');
    } finally {
      centralOff();
    }
  });

  test('an address with a live CP home → the same 409 approve gives; nothing written', async () => {
    const fake = centralOn();
    try {
      await db.insert(tenants).values({ id: HOME_TENANT, name: 'SXQ Home', slug: 'sxq-home' });
      await db.insert(users).values({ id: HOME_USER, email: 'home@sxq-co.test', name: 'Ho Me', tenant_id: HOME_TENANT });
      const res = await invite({ email: 'HOME@sxq-co.test', name: 'Ho Me' });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('user_belongs_to_another_workspace');
      expect(await rowsFor('home@sxq-co.test')).toHaveLength(0);
      expect(fake.calls.attempted).toEqual([]); // no workspace attempted
      const [u] = await db.select().from(users).where(eq(users.id, HOME_USER));
      expect(u!.tenant_id).toBe(HOME_TENANT);
    } finally {
      await db.delete(users).where(eq(users.id, HOME_USER));
      centralOff();
    }
  });

  test('strict body: unknown field / bad email / missing name → 422, nothing written', async () => {
    for (const bad of [
      { email: 'strict@sxq-co.test', name: 'St Rict', role: 'super_admin' },
      { email: 'strict@sxq-co.test', name: 'St Rict', byoMode: 'byo_required' },
      { email: 'not-an-email', name: 'St Rict' },
      { email: 'strict@sxq-co.test' },
      { email: 'strict@sxq-co.test', name: 'St Rict', tenantName: 'x' },
    ]) {
      const res = await invite(bad);
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await rowsFor('strict@sxq-co.test')).toHaveLength(0);
  });
});
