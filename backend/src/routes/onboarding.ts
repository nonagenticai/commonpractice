// src/routes/onboarding.ts — controlled onboarding (super_admin half).
//
//   • notify-self  — open, idempotent: a prospective user records intent. Short-circuits when the
//                    caller already has a CP home tenant. No Keycloak call. Optional Turnstile.
//   • intake       — server-to-server early-access intake (nonagentic.ai website backend, signup
//                    chat): a dedicated Keycloak SA token (middleware/signup-intake-auth.ts) submits
//                    `{email, name, company?, source}`. Same queue, same admission rules.
//   A NEW pending row (not a de-duplicated re-submit) from a TRUSTED source (intake, a verified-email
//   notify-self, or a notify-self that passed Turnstile) is announced in Telegram
//   (services/signup-telegram.ts), and so is every approve/reject decision. Untrusted rows are
//   queued as before and summarised by the periodic digest (host/signup-digest-scheduler.ts).
//   • queue        — list / stats / get the pending approvals (super_admin).
//   • approve      — super_admin, two modes: `new_tenant` creates a workspace (tenant-service) and
//                    seats the requester as its tenant_admin; `existing` seats them in a workspace
//                    with a level. Membership is CP-owned (`users.tenant_id` / `tenant_role`) — no
//                    Keycloak attribute or role is written. A request with no known identity (an
//                    anonymous notify-self) is turned into an invite instead.
//   • invite (EA)  — super_admin: POST /api/signup-approvals/invite records a pre-approved signup
//                    (`source: 'invite'`) and approves it into a new workspace in one step.
//   • reject       — super_admin: mark the approval rejected. No Keycloak call.
//   • telegram-decision — chat-bridge (service account, middleware/signup-decider-auth.ts) relays
//                    George's Approve/Reject tap from Telegram; runs the SAME approve (with defaults)
//                    / reject as the super_admin routes. Idempotent: a decided row → `already_decided`.
//   • invite       — super_admin: invite a person into an EXISTING workspace (invite-service).
//   • email-domain — super_admin: corporate-domain → tenant routing + the free-mail blocklist that
//                    feeds the approval queue's auto-match.
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  db,
  withTenantTransaction,
  tenants,
  users,
  signupApprovals,
  emailDomainTenants,
  freeEmailProviders,
} from '../db/client';
import { requireSuperAdmin, requireTenantExists } from '../middleware/admin-guards';
import { validateAuth } from '../middleware/auth';
import { requireSignupIntakeCaller } from '../middleware/signup-intake-auth';
import { requireSignupDeciderCaller } from '../middleware/signup-decider-auth';
import { enforceTurnstile } from '../services/turnstile';
import { notifyNewSignup, notifySignupDecision, type SignupTrust } from '../services/signup-telegram';
import { signupTelegramConfig } from '../config';
import { auditActorId, recordAudit } from '../host/audit-service';
import { keycloakAdmin, type RealmUser } from '../services/keycloak-admin';
import {
  jsonResponse,
  readJson,
  route,
  notFound,
  badRequest,
  conflict,
  unprocessable,
  HttpError,
} from '../utils/http';
import {
  defaultTenantName,
  defaultTenantNameFrom,
  loadPublicEmailDomains,
  matchTenantByEmail,
  signupQueueLimits,
  signupQueueVerdict,
  SIGNUP_QUEUE_REFUSED_COUNTER,
} from '../services/onboarding-service';
import { log } from '../host/logger';
import { incLabelledCounter } from '../host/metrics';
import {
  assertAdoptableIdentity,
  upsertLocalUserTx,
  tenantScopedRoleSchema as onboardRoleSchema,
} from '../services/provisioning';
import { ensureTenantLicense, ensureMemberEntitlement } from '../services/license-provisioning';
import { assertSeatAvailable, claimSeat, revokePendingInvitesInTx } from '../services/seat-limit';
import { createInvite, type CreatedInvite } from '../services/invite-service';
import { createTenant } from '../services/tenant-service';
import { signupWorkspaceBlockers } from '../services/offboarding';
import {
  initialRejectRepair,
  repairRejectedSignup,
  rejectRepairLeavesLiveAccess,
  resolveRejectRepairManually,
  type RejectRepairActor,
  type RejectRepairOutcome,
} from '../services/signup-reject-repair';
import {
  tenantFoundedByApproval,
  readProvisioning,
  recordSignupAdminSeated,
  runSignupAdminSteps,
  toView,
  type ProvisioningView,
} from '../services/tenant-provisioning';
import { tenantInvites, type SignupApproveEffect } from '../db/schema';
import { normaliseSignupLocale, SIGNUP_LOCALES } from '../utils/signup-locale';
import { newTenantPlanFor } from '../services/plan-posture';
import { sameTenantId, tenantIdSchema } from '../utils/tenant-id';
import { multiLine, multiLineText, singleLineText } from '../utils/untrusted-text';
import type { Router } from '../utils/router';
import type { TenantRole, User } from '../types';

const turnstileTokenSchema = z.string().min(1).max(4096);
const notifySelfSchema = z
  .object({
    email: z.string().email().max(320),
    // Single-line, control/bidi characters stripped (utils/untrusted-text.ts): this value is shown
    // in George's Telegram message, and a newline in it could forge lines of that message.
    name: singleLineText(160).optional(),
    // Additive and optional: only read when Turnstile is configured (services/turnstile.ts).
    turnstileToken: turnstileTokenSchema.optional(),
  })
  .strict();
/** POST /api/signup-approvals/intake — what the website backend / signup chat may send. */
const intakeSchema = z
  .object({
    email: z.string().email().max(320),
    // Normalised like notify-self's `name` (see there); empty-after-stripping is a 422.
    name: singleLineText(160),
    company: singleLineText(160).optional(),
    // Free text from the applicant, read by the super_admin on /onboarding before approving. Line
    // breaks kept, every other control / bidi / zero-width character stripped (utils/untrusted-text).
    // Never logged. A one-line excerpt (≤300 chars, inside a `code` entity) is shown in the
    // Telegram new-signup message (George 2026-10-19, early-access v2).
    message: multiLineText(2000).optional(),
    source: z.enum(['web', 'chat']),
    // 0121 — the requester's language (the website's <html lang>). LENIENT on purpose: an unknown
    // or malformed tag is treated as absent (→ en), never a 422 — a relayed browser language must
    // not be able to lose somebody's signup. `normaliseSignupLocale` maps `de-DE` → `de`.
    locale: z.string().max(35).optional(),
    // The END USER's Turnstile token, relayed by the website backend. Verified when present and
    // TURNSTILE_SECRET is set; never mandatory here (this caller is a server, not a browser).
    turnstileToken: turnstileTokenSchema.optional(),
  })
  .strict();
const byoModeSchema = z.enum(['byo_required', 'local_allowed', 'platform_only']);
/** Self-signup approval: `<name>`, `<name>-2` … `<name>-10` before giving up with a 409. */
const SELF_SIGNUP_NAME_ATTEMPTS = 10;
// No `mode` = `existing` (the target defaults to the approval's assigned / matched tenant).
const approveSchema = z.preprocess(
  (b) => (b && typeof b === 'object' && !('mode' in b) ? { ...b, mode: 'existing' } : b),
  z.discriminatedUnion('mode', [
    z
      .object({
        mode: z.literal('new_tenant'),
        // Optional since early access (George 2026-10-14): omitted → `defaultTenantName` (company,
        // else the email's organisation, else the requester's name).
        tenantName: z.string().trim().min(2).max(120).optional(),
        // Optional: omitted (or `local_allowed`) → the workspace is on NEW_TENANT_PLAN (local-llm),
        // the same default as POST /api/tenants. Another posture → the deployment default plan, as
        // before (`byo` fixes byo_required; a plan that fixes none answers 422 if it is omitted).
        byoMode: byoModeSchema.optional(),
      })
      .strict(),
    z
      .object({
        mode: z.literal('existing'),
        tenantId: tenantIdSchema.optional(),
        role: onboardRoleSchema.optional(),
      })
      .strict(),
  ]),
);
const inviteSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(1).max(160).optional(),
    // Explicit names (the onboarding form sends these); they win over splitting `name`. Keycloak's
    // VERIFY_PROFILE stops an invitee whose identity has no first + last name.
    firstName: z.string().trim().min(1).max(80).optional(),
    lastName: z.string().trim().min(1).max(80).optional(),
    tenantId: tenantIdSchema,
    role: onboardRoleSchema.optional(),
  })
  .strict();
const emailDomainSchema = z
  .object({
    domain: z.string().min(3).max(255),
    tenantId: z.guid(), // not `.uuid()` — zod 4 refuses the demo tenant …0001
    autoAssign: z.boolean().optional(),
  })
  .strict();
const freeProviderSchema = z.object({ domain: z.string().min(3).max(255) }).strict();

/** ⛔ THE CEILING ON THE SELF-SIGNUP QUEUE IS NO LONGER A CONSTANT HERE, AND IT IS NO LONGER ONE
 *  NUMBER. It used to be `const MAX_PENDING_APPROVALS = 500` on this line: not env-driven (raising
 *  it needed a rollout, so the lever was unusable exactly when the queue was full) and single
 *  (past it EVERY caller got the 503, including a domain-matched employee of a paying customer —
 *  which is what made a patient distributed spray a customer-lockout rather than a nuisance).
 *  Both halves live in services/onboarding-service.ts now: `signupQueueLimits` reads
 *  `SIGNUP_QUEUE_MAX_PENDING` (default 500, unchanged) and `SIGNUP_QUEUE_MAX_ANON_PENDING`
 *  (default 80% of it) per request, and `signupQueueVerdict` decides. Read the long note there
 *  before changing either number. */

// ---- self-signup notify (open, idempotent) ----

/** POST /api/signup-approvals/notify-self — record a prospective user's intent. Open (no
 *  super_admin); idempotent. Short-circuits to 204 if the caller already has a live CP home
 *  tenant. De-dupes on a pending row for the email (partial unique index). */
const notifySelf = route(async (req) => {
  // Optional auth: a caller who already has a CP home tenant is a no-op. An anonymous /
  // workspace-less caller falls through to record intent.
  //
  // ⚠️ THE OUTCOME OF THIS TRY IS NOW READ TWICE, so the caller's SUB is captured rather than
  // discarded. A caller whose token `validateAuth` ACCEPTED but who carries no `tenant_id` — an SSO
  // first login, or a realm user the seat cap turned away — used to be indistinguishable from a
  // caller with no token at all from here down. They are not the same person, and the anonymous
  // sub-quota below is exactly where the difference has to be visible: the first one is a real
  // human at a real IdP, the second is whoever posted the request.
  //
  // ⛔ THE SUB, NOT A BOOLEAN, AND THAT IS THE FIX FOR A DEFECT A BOOLEAN CAUSED. The first cut
  // captured `authenticated: boolean`, admitted such a caller as IDENTIFIED, and then wrote a row
  // with `keycloak_sub` NULL — so the row landed IN the anonymous population it had just been
  // admitted OUTSIDE of. Since that path is the ONLY one the SPA uses (`authFetch` → bearer token),
  // a few hundred unmatched SSO first-logins would have filled the reserve themselves, fired the
  // abuse arm with zero abuse, and then refused the genuine anonymous prospects the reserve exists
  // for. Admission and COUNTING have to use the same fact about the row, so the fact is stored.
  // `user-service.ts:recordSignupStrand` queues this exact population this exact way
  // (`keycloak_sub: user.id`); approve seats a row with a known sub directly and turns a row
  // without one into an invite.
  let caller: User | null = null;
  try {
    const user = await validateAuth(req);
    if (await hasCpHomeTenant(user.id)) return new Response(null, { status: 204 });
    caller = user;
  } catch (err) {
    // This catch exists to tolerate an ANONYMOUS caller (no/invalid token → UnauthorizedError),
    // NOT to swallow a decision about an authenticated one. Since WS-2 `validateAuth` also carries
    // Gate 2, and its only HttpError is a `license_*` 402/403 — a caller who IS authenticated but
    // whose tenant is unlicensed. Swallowing that would silently turn today's 402 into "record a
    // signup intent", which is both a behaviour change and a wrong answer.
    if (err instanceof HttpError) throw err;
    /* anonymous — proceed */
  }
  const body = notifySelfSchema.parse(await readJson(req));
  // Turnstile: verified whenever a token is sent and a secret is configured; MANDATORY only for an
  // anonymous caller (a browser form, no CP identity) when TURNSTILE_REQUIRED=true. A signed-in SPA
  // user is never asked for one — that is what keeps this route's behaviour for the app unchanged.
  const turnstile = await enforceTurnstile({
    token: body.turnstileToken,
    requireToken: caller === null,
    remoteIp: lastForwardedFor(req),
  });

  // ⛔ THE SUB IS STORED ONLY WHEN THE TOKEN PROVES THE ADDRESS IN THE BODY. `email` comes from the
  // request body; the sub comes from the token. Pairing them unchecked let ANY portal account queue
  // `{sub: me, email: victim@customer}` — the domain match then routed the row to the victim's
  // tenant, and approve seated the ATTACKER's sub there (possibly as tenant_admin). So the pair is
  // only a fact when the token itself carries `email_verified: true` for that exact address. Any
  // other authenticated caller is recorded exactly like an anonymous one (sub NULL): approve then
  // goes the INVITE path, whose acceptance is what proves the address belongs to someone.
  // Admission and counting below both read `storedSub`, so the row lands in the population it was
  // admitted as (see the note above on why those two must agree).
  const storedSub = callerProvesEmail(caller, body.email) ? caller!.id : null;
  // ⛔ TRUST DECIDES WHETHER GEORGE'S PHONE BUZZES. This route is open: anyone can post any address,
  // rate-limited only per IP, and Turnstile is off until a widget exists. So a row is announced in
  // Telegram only when something vouches for it — a token that proves the address, or a Turnstile
  // challenge that actually ran and passed (`'verified'`, never `'skipped'`). A signed-in caller
  // whose token does NOT prove the address is no better than anonymous here. Untrusted rows are
  // queued exactly as before and reach Telegram only as counts in the periodic digest.
  const trust: SignupTrust | null =
    storedSub !== null ? 'verified_email' : turnstile === 'verified' ? 'turnstile' : null;
  await admitAndRecord({
    email: body.email,
    name: body.name ?? null,
    company: null,
    source: 'app',
    storedSub,
    authenticated: caller !== null,
    trust,
  });
  return new Response(null, { status: 204 });
});

/**
 * POST /api/signup-approvals/intake — SERVER-TO-SERVER early-access intake.
 *
 * ⚠️ A SEPARATE ROUTE, NOT A MODE OF notify-self, AND THAT IS DELIBERATE. notify-self treats a bad
 * or missing token as "anonymous, carry on" (its whole point is that anyone may queue intent). A
 * service caller whose token is wrong must get a hard 401/403 instead — folding it into notify-self
 * would turn a mis-issued intake token into a silent anonymous signup that loses `company`/`source`
 * and lands in the anonymous reserve. Its own route also gives it its own access-log template and
 * keeps notify-self byte-for-byte as the app uses it.
 *
 * The row is recorded exactly like an anonymous one (`keycloak_sub` NULL — the SA's sub is not the
 * requester's), so approve INVITES the address and acceptance proves ownership.
 * 202 `{status: 'queued' | 'already_pending'}`; queue refusals are the same 503s as notify-self.
 */
const intakeSignup = route(async (req) => {
  const caller = await requireSignupIntakeCaller(req);
  const body = intakeSchema.parse(await readJson(req));
  await enforceTurnstile({ token: body.turnstileToken, requireToken: false });
  const { inserted } = await admitAndRecord({
    email: body.email,
    name: body.name,
    company: body.company ?? null,
    message: body.message ?? null,
    locale: normaliseSignupLocale(body.locale),
    source: body.source,
    storedSub: null,
    authenticated: true,
    intakeClient: caller.azp,
    // The service account is the trust anchor: the website/chat backend authenticated with its own
    // Keycloak client, whatever the relayed Turnstile token said (it was verified above if sent).
    trust: 'intake',
  });
  return jsonResponse({ status: inserted ? 'queued' : 'already_pending' }, 202);
});

/** The rightmost X-Forwarded-For entry — the address istio observed (see middleware/rate-limit.ts). */
function lastForwardedFor(req: Request): string | null {
  const parts = (req.headers.get('x-forwarded-for') ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  return parts.at(-1) ?? null;
}

interface AdmitArgs {
  email: string;
  name: string | null;
  company: string | null;
  /** Applicant's free-text message (intake only). Stored, never logged; excerpted in Telegram. */
  message?: string | null;
  /** 0121 — the requester's language (intake only), already normalised. */
  locale?: string | null;
  source: 'app' | 'web' | 'chat';
  /** The requester's realm sub — only when the token PROVED the address (see notify-self). */
  storedSub: string | null;
  /** For the refusal log line only. */
  authenticated: boolean;
  intakeClient?: string;
  /** The trusted path that admitted it, or null — only a trusted NEW row is announced singly. */
  trust: SignupTrust | null;
}

/**
 * Admission + insert, shared by notify-self and intake. Returns whether a NEW pending row was
 * written (false = a pending row for the address already existed). Announces a new row in Telegram
 * only when `trust` is set; an untrusted row waits for the digest (host/signup-digest-scheduler.ts).
 */
async function admitAndRecord(args: AdmitArgs): Promise<{ inserted: boolean }> {
  const { storedSub } = args;

  // ⚠️ THE DOMAIN MATCH MOVED ABOVE THE CEILING CHECK, AND IT HAD TO. It is what decides whether
  // this signup belongs to a tenant, and the reserve below is defined in terms of exactly that. The
  // old order (count, refuse, then match) could not have told a customer's employee from a sprayer
  // even in principle, because it had thrown the 503 before it knew.
  //
  // ⚠️ AND IT IS NOT FREE — an earlier version of this comment claimed "same number of round trips
  // as before", which is FALSE on the refusal path and was the one measurable thing it asserted. A
  // refused request used to cost ONE query (the count); it now costs THREE, because
  // `matchTenantByEmail` is itself two SELECTs (free-mail blocklist, then the domain map) and runs
  // before the refusal is known. Accepted, not overlooked: all three are indexed point reads, the
  // tight anonymous bucket in middleware/rate-limit.ts stands in front of them, and the alternative
  // — checking the total ceiling here to short-circuit — would put the table ceiling in two places
  // and give it two places to drift. If this ever shows up in a profile, cache the free-mail
  // blocklist rather than duplicating the ceiling.
  const matched = await matchTenantByEmail(args.email);

  // The queue as it stands, in ONE round trip. `anonymous_pending` is the sub-population the reserve
  // is measured against: pending rows carrying NEITHER a realm identity NOR a tenant.
  //
  // ⛔ BOTH CONJUNCTS ARE LIVE, AND NEITHER IS THERE FOR SYMMETRY. Drop `matched_tenant_id IS NULL`
  // and a customer's own matched signups eat the headroom held for them. Drop `keycloak_sub IS NULL`
  // and every row queued by `user-service.ts:recordSignupStrand` — a real writer, one row per
  // stranded SSO user, `matched_tenant_id` NULL by construction — counts as a sprayer, which is the
  // same lockout this change exists to remove, arriving through a different door. This route writes
  // the sub too (see `storedSub` above) precisely so the two conjuncts describe the same population
  // the admission test above does.
  const queueRows = (await db.execute(
    sql`SELECT COUNT(*)::int AS pending,
               COUNT(*) FILTER (
                 WHERE keycloak_sub IS NULL AND matched_tenant_id IS NULL
               )::int AS anonymous_pending
          FROM signup_approvals
         WHERE status = 'pending'`,
  )) as unknown as { pending: number; anonymous_pending: number }[];
  const counts = {
    pending: queueRows[0]?.pending ?? 0,
    anonymousPending: queueRows[0]?.anonymous_pending ?? 0,
  };
  const limits = signupQueueLimits();
  const verdict = signupQueueVerdict(counts, storedSub !== null || matched !== null, limits);
  if (!verdict.admit) {
    // ⛔ TWO CALLS WITH LITERAL MESSAGES, NOT ONE WITH A TERNARY. The message is the aggregation
    // key, so `logging-discipline.test.ts::every log.* message is a constant string` refuses a
    // first argument that is not a string literal — a computed key is exactly the unfilterable
    // free-form text that migration removed, just moved inside the logger. These two refusals are
    // genuinely different events (a full table vs an exhausted anonymous reserve) and must stay
    // separately greppable; collapsing them is what the rule exists to prevent.
    const queueFields = {
      component: 'onboarding',
      pending: counts.pending,
      anonymousPending: counts.anonymousPending,
      cap: verdict.cap,
      authenticated: args.authenticated,
      identified: storedSub !== null,
      source: args.source,
      ...(args.intakeClient ? { intakeClient: args.intakeClient } : {}),
      matched: matched !== null,
    };
    if (verdict.reason === 'queue_full') {
      log.warn('signup_queue_full', {
        ...queueFields,
        reason: 'refusing ALL new self-signups until the queue is worked down',
      });
    } else {
      log.warn('signup_queue_anonymous_full', {
        ...queueFields,
        reason:
          'anonymous reserve exhausted — matched/authenticated signups are still being accepted',
      });
    }
    incLabelledCounter(SIGNUP_QUEUE_REFUSED_COUNTER, verdict.reason);
    // ⛔ THE TWO WIRE CODES ARE WRITTEN OUT AS LITERALS ON PURPOSE — do not collapse this into one
    // `new HttpError(503, verdict.reason === … ? … : …)`. The frontend's
    // `error-message.backend-contract.test.ts` finds every 503 code by SCRAPING this source text for
    // `new HttpError(<503>, '<literal>'`, and it says so about `utils/http.ts:82`, whose code slot is
    // a bare parameter and is therefore invisible to it "by construction, not by luck". A computed
    // code here would take BOTH codes out of that scrape: the anchor case would red, and — worse if
    // someone then deleted the anchor — a 503 could reach a user with no copy and no register entry
    // in any of the eight locales.
    if (verdict.reason === 'anonymous_quota') {
      throw new HttpError(
        503,
        'signup_queue_anonymous_full',
        'Sign-up requests from unrecognised addresses are temporarily closed. Please contact your Common Practice administrator.',
      );
    }
    throw new HttpError(
      503,
      'signup_queue_full',
      'Sign-up requests are temporarily closed. Please contact your Common Practice administrator.',
    );
  }

  // ON CONFLICT DO NOTHING covers the pending-email partial unique index (re-notify is a
  // harmless no-op while a decision is pending; a decided row doesn't block re-signup).
  // `returning` is empty exactly when the conflict fired — which is how a re-submit stays silent.
  const [row] = await db
    .insert(signupApprovals)
    .values({
      keycloak_sub: storedSub,
      email: args.email,
      name: args.name,
      company: args.company,
      message: args.message ?? null,
      locale: args.locale ?? null,
      source: args.source,
      trust: args.trust,
      matched_tenant_id: matched,
    })
    .onConflictDoNothing()
    .returning({ id: signupApprovals.id });
  if (!row) return { inserted: false };

  if (args.trust !== null && signupTelegramConfig().enabled) {
    const pendingTotal = await pendingSignupCount().catch((err) => {
      log.warn('signup_queue_position_failed', { component: 'onboarding', err });
      return null;
    });
    const matchedWorkspace = matched
      ? await db
          .select({ name: tenants.name })
          .from(tenants)
          .where(eq(tenants.id, matched))
          .then((r) => r[0]?.name ?? null)
          .catch(() => null)
      : null;
    // Requester-typed values travel as `code` entities (services/signup-telegram.ts `Message`).
    notifyNewSignup({
      matchedWorkspace,
      id: row.id,
      source: args.source,
      trust: args.trust,
      pendingTotal,
      email: args.email,
      name: args.name,
      company: args.company,
      message: args.message ?? null,
      locale: args.locale ?? null,
    });
  }
  return { inserted: true };
}

/** How many signups are pending right now. */
async function pendingSignupCount(): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT COUNT(*)::int AS total FROM signup_approvals WHERE status = 'pending'`,
  )) as unknown as { total: number }[];
  return rows[0]?.total ?? 0;
}

// ---- queue (super_admin) ----

/** GET /api/signup-approvals?status= — the approval queue (super_admin). */
const listApprovals = route(async (req) => {
  await requireSuperAdmin(req);
  const status = new URL(req.url).searchParams.get('status');
  // `needs_repair`: REJECTED signups whose cleanup has not finished (`reject_repair` pending / blocked / failed,
  // services/signup-reject-repair.ts) — the onboarding screen lists them with a Retry.
  const filter =
    status === 'needs_repair'
      ? and(eq(signupApprovals.status, 'rejected'), sql`${signupApprovals.reject_repair}->>'state' IN ('pending','blocked','failed')`)
      : status
        ? eq(signupApprovals.status, status)
        : sql`true`;
  const rows = await db
    .select()
    .from(signupApprovals)
    .where(filter)
    .orderBy(desc(signupApprovals.created_at));
  // The name approve would default to (`tenantName` omitted) — shown as the dialog's prefill.
  const publicDomains = await loadPublicEmailDomains();
  return jsonResponse({
    approvals: rows.map((r) => ({
      ...r,
      suggested_tenant_name: defaultTenantNameFrom(r, publicDomains),
      // Would a manual resolve of its cleanup leave the requester's access live? (the screen warns
      // and requires a confirmation; the resolve endpoint requires `acknowledgeLiveAccess`).
      reject_repair_leaves_live_access: r.status === 'rejected' && rejectRepairLeavesLiveAccess(r.reject_repair),
    })),
  });
});

/** GET /api/signup-approvals/stats — counts by status (super_admin). */
const approvalStats = route(async (req) => {
  await requireSuperAdmin(req);
  const rows = await db
    .select({ status: signupApprovals.status, count: sql<number>`COUNT(*)::int` })
    .from(signupApprovals)
    .groupBy(signupApprovals.status);
  const stats = { pending: 0, approved: 0, rejected: 0, total: 0 };
  for (const r of rows) {
    if (r.status in stats) (stats as Record<string, number>)[r.status] = r.count;
    stats.total += r.count;
  }
  return jsonResponse({ stats });
});

/** GET /api/signup-approvals/:id — one approval (super_admin). */
const getApproval = route(async (req, id) => {
  await requireSuperAdmin(req);
  const [row] = await db.select().from(signupApprovals).where(eq(signupApprovals.id, id!)).limit(1);
  if (!row) throw notFound('approval_not_found', `No signup approval '${id}'`);
  return jsonResponse({ approval: { ...row, suggested_tenant_name: await defaultTenantName(row) } });
});

/** Does the token vouch for `email`? Verified AND the same address, case-insensitively. */
function callerProvesEmail(user: User | null, email: string): boolean {
  return (
    user !== null &&
    user.emailVerified === true &&
    typeof user.email === 'string' &&
    user.email.trim().toLowerCase() === email.trim().toLowerCase()
  );
}

/** Does this identity already have a live CP home tenant? (DB-authoritative, never the token.) */
async function hasCpHomeTenant(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deleted_at), sql`${users.tenant_id} IS NOT NULL`))
    .limit(1);
  return Boolean(row);
}

// ---- approve / reject (super_admin) ----

/**
 * Refuse an approval that would MOVE an existing CP member instead of admitting a new one, or
 * resurrect a tombstone by re-using its identity. Approve's input is anonymous (notify-self), so a
 * queued colleague's address must never re-home that colleague. A live row homed in `tenantId`
 * already is the resume case and passes. DB-only: CP membership is the authority.
 */
async function assertApprovalAdmitsUser(
  email: string,
  knownSub: string | null,
  tenantId: string | null,
): Promise<void> {
  const byEmail = sql`lower(${users.email}) = lower(${email})`;
  const rows = await db
    .select({ id: users.id, tenantId: users.tenant_id, deletedAt: users.deleted_at })
    .from(users)
    .where(knownSub ? or(eq(users.id, knownSub), byEmail) : byEmail);

  for (const row of rows) {
    if (row.deletedAt) {
      if (row.id === knownSub) {
        throw conflict(
          'user_offboarded',
          'The account this approval names was removed from its workspace. Reject this request and ' +
            'invite the address instead.',
        );
      }
      continue;
    }
    if (row.tenantId && (!tenantId || !sameTenantId(row.tenantId, tenantId))) {
      throw conflict(
        'user_belongs_to_another_workspace',
        'This email already belongs to another workspace. Approving would move that person out of ' +
          'it. Use PATCH /api/admin/users/:userId/tenant to move them deliberately.',
      );
    }
  }
}

/**
 * Does the realm account `sub` own `email` — the realm's account for that address IS `sub`, the
 * address matches case-insensitively, and Keycloak marks it verified? A failure to ASK is a 502,
 * never a "no": approving must not quietly change meaning during a Keycloak outage.
 */
async function realmSubOwnsEmail(sub: string, email: string): Promise<boolean> {
  let hit: RealmUser | null;
  try {
    hit = await keycloakAdmin().findRealmUserByUsernameOrEmail(email, email);
  } catch (err) {
    throw new HttpError(
      502,
      'keycloak_provisioning_failed',
      `Could not look up the realm account for '${email}', so it cannot be established that the ` +
        `requester owns it — refusing rather than guessing: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return (
    hit !== null &&
    hit.id === sub &&
    hit.emailVerified === true &&
    typeof hit.email === 'string' &&
    hit.email.trim().toLowerCase() === email.trim().toLowerCase()
  );
}

/**
 * Seat a KNOWN identity (`sub`) in `tenantId` with `role`: seat claim + membership row in one
 * transaction, then the licences. Used by approve, whose requester authenticated at notify-self.
 *
 * ⛔ SECOND LAYER, NOT A DUPLICATE OF notify-self's CHECK. A queued `keycloak_sub` is only as good as
 * the writer that stored it: rows written before notify-self verified the pair, and rows from
 * `recordSignupStrand`, carry a sub with no proof that it owns `email`. So the realm is asked here,
 * at the moment of seating. When it does not vouch, NOTHING is seated — returns 'not_owner' and the
 * caller invites the address instead (acceptance proves ownership).
 */
async function seatKnownIdentity(args: {
  sub: string;
  email: string;
  name: string | null;
  tenantId: string;
  role: TenantRole;
}): Promise<'seated' | 'not_owner'> {
  if (!(await realmSubOwnsEmail(args.sub, args.email))) {
    log.warn('signup_approve_sub_not_email_owner', {
      component: 'onboarding',
      sub: args.sub,
      tenantId: args.tenantId,
      reason: 'queued sub does not own the approval email in the realm — inviting the address instead',
    });
    return 'not_owner';
  }
  await assertAdoptableIdentity(keycloakAdmin(), args.sub, args.email);
  await claimSeat(args.tenantId, { existingEmail: args.email }, async (tx) => {
    await upsertLocalUserTx(tx, args.sub, args.email, args.name, args.tenantId, args.role);
    // A pending invite for this address would otherwise outlive the seat and, accepted later,
    // re-apply ITS role over whatever the role is by then.
    await revokePendingInvitesInTx(tx, args.tenantId, args.email);
  });
  await ensureTenantLicense(args.tenantId, args.sub);
  await ensureMemberEntitlement(args.tenantId, args.sub, args.sub);
  return 'seated';
}

/**
 * POST /api/signup-approvals/:id/approve
 *   `{mode:'new_tenant', tenantName, byoMode}` — create the workspace, requester = tenant_admin.
 *   `{mode:'existing', tenantId?, role?}`      — seat the requester in an existing workspace.
 *
 * A request carrying the requester's sub is seated directly ONLY when the realm confirms that sub
 * owns the address (verified); otherwise — and for one without a sub (anonymous notify-self) — it
 * becomes an invite to the address: CP cannot vouch that the address belongs to anybody until its
 * owner signs in and accepts.
 *
 * Retry: a new tenant is checkpointed on the approval (`assigned_tenant_id`) before seating, so a
 * failed seating is retried with `{mode:'existing', tenantId}`.
 */
const approveSignup = route(async (req, id) => {
  const actor = await requireSuperAdmin(req);
  const body = approveSchema.parse(await readJson(req));
  return jsonResponse(await approveApprovalRow(actor, id!, body));
});

type ApproveBody = z.infer<typeof approveSchema>;

/**
 * Who decided, when it was not a super_admin on /onboarding: George's Telegram tap, relayed by
 * chat-bridge's service account (POST /:id/telegram-decision). `actor` is then that service account,
 * which has no CP users row, so `decided_by` and the audit `actor_id` are NULL (System) — those
 * columns are FKs onto users.id — and the audit metadata names the human as `telegram:<id>`.
 */
interface SignupDecider {
  telegramUserId: number;
  /** The service-account client that relayed it (`chat-bridge-signup-decider`). */
  azp: string;
}

function deciderMetadata(decider: SignupDecider | undefined): Record<string, unknown> {
  return decider
    ? { decidedVia: 'telegram', actor: `telegram:${decider.telegramUserId}`, deciderAzp: decider.azp }
    : { decidedVia: 'onboarding' };
}

function decidedViaLabel(decider: SignupDecider | undefined): string {
  return decider ? `Telegram (user ${decider.telegramUserId})` : 'CP onboarding screen';
}

/**
 * The approve path itself, shared by POST /api/signup-approvals/:id/approve, the pre-approved
 * POST /api/signup-approvals/invite and the Telegram decision. The caller has already established
 * `actor` may approve (a super_admin, or the decider service account with `decider` set).
 * Returns the response payload (the route answers it as 200 JSON).
 *
 * ⭐ LICENCE AT APPROVAL (George 2026-10-19, early-access v2). For `new_tenant` with no seatable sub,
 * the invite seats the requester in the same breath as it mints their realm identity
 * (`createInvite({seatIfMinted})`), then — recorded as provisioning steps on the new workspace —
 * mints their member licence (`member_licence`) and only then sends the set-password email
 * (`invite_email`). A licence that fails leaves the email `pending`; the onboarding-integrity tick
 * retries the licence and sends the email after it. The link therefore lands the person in a
 * licensed app at once, with no "setting up" wait on /invite/accept.
 */
async function approveApprovalRow(actor: User, id: string, body: ApproveBody, decider?: SignupDecider) {
  // ⛔ ONE APPROVER AT A TIME, ACROSS REPLICAS. The screen and a Telegram tap (or a redelivered tap)
  // can reach different pods; without this claim both would found a workspace for the same signup.
  // The claim's RETURNING row IS the approval this run works from — never a read taken before it.
  const { approval, token } = await claimApproval(id);
  // HEARTBEAT: createTenant alone can take ~20 min (three 2-min step leases + licence bundles), far
  // past one claim window. The claim is pushed forward every minute while this run is alive, up to
  // a hard ceiling. ⛔ When the claim is LOST (renewal matched no row: lapsed, taken over, or the row
  // was decided) or the ceiling is reached, the run ABORTS before its next irreversible step — see
  // `HeldApprovalClaim`. A run that kept going past a lapse could seat the user and send the
  // set-password email for a row somebody has since rejected.
  const claim = new HeldApprovalClaim(id, token, claimTiming);
  try {
    return await approveClaimed(actor, approval, body, claim, decider);
  } finally {
    claim.stop();
    // Release OUR claim only — a lapsed one may have been taken over by another approver since.
    await db
      .update(signupApprovals)
      .set({ approving_until: null, approving_claim: null })
      .where(and(eq(signupApprovals.id, id), eq(signupApprovals.approving_claim, token)))
      .catch(() => {});
  }
}

interface ApprovalClaimTiming {
  /** One claim window; the heartbeat renews it while the approve runs. */
  claimMs: number;
  heartbeatMs: number;
  /** Renewal stops after this: an approve stuck longer than this is treated as dead, and aborts. */
  ceilingMs: number;
}
const DEFAULT_APPROVAL_CLAIM_TIMING: ApprovalClaimTiming = {
  claimMs: 5 * 60_000,
  heartbeatMs: 60_000,
  ceilingMs: 30 * 60_000,
};
let claimTiming: ApprovalClaimTiming = DEFAULT_APPROVAL_CLAIM_TIMING;

/** Tests only: shrink the claim heartbeat / ceiling (undefined → the defaults). */
export function __setApprovalClaimTimingForTests(t?: Partial<ApprovalClaimTiming>): void {
  claimTiming = { ...DEFAULT_APPROVAL_CLAIM_TIMING, ...(t ?? {}) };
}

/**
 * The approve run's claim on its `signup_approvals` row, kept alive by a heartbeat and CHECKED before
 * every irreversible step (`assertHeld`: the seat / invite, the member licence, the set-password
 * email).
 *
 * The run ABORTS — `assertHeld` throws 409 `approval_claim_lost` — once any of these is true:
 *   • a renewal matched no row: the claim lapsed, another approver took it over, or the row is no
 *     longer `pending` (a reject landed after a lapse);
 *   • the ceiling is reached (the heartbeat stops renewing, so the claim WILL lapse);
 *   • renewals have errored for long enough that the claim may already have lapsed unseen.
 *
 * ⭐ `assertHeld` itself re-confirms AND extends the claim in one token-scoped conditional UPDATE
 * (`approving_until > now()` included), so after it returns the claim is live for a full window:
 * reject refuses while `approving_until` is in the future, hence no reject can land between the
 * check and the step it guards. That is what makes "rejected, yet the old run still emailed"
 * impossible rather than unlikely.
 *
 * An abort leaves the row `pending` and recoverable: everything done so far is recorded (the founded
 * workspace carries its `signupApprovalId`, provisioning steps record their own outcome), and the
 * next approve resumes INTO that workspace.
 */
class HeldApprovalClaim {
  private abortReason: 'claim_lost' | 'ceiling_reached' | 'claim_unconfirmed' | null = null;
  private readonly startedAt = Date.now();
  private lastConfirmedAt = Date.now();
  private readonly beat: ReturnType<typeof setInterval>;

  constructor(
    readonly approvalId: string,
    readonly token: string,
    private readonly timing: ApprovalClaimTiming,
  ) {
    this.beat = setInterval(() => void this.heartbeat(), timing.heartbeatMs);
  }

  get aborted(): boolean {
    return this.abortReason !== null;
  }

  stop(): void {
    clearInterval(this.beat);
  }

  private abort(reason: NonNullable<HeldApprovalClaim['abortReason']>): void {
    if (this.abortReason) return;
    this.abortReason = reason;
    this.stop();
    log.warn('signup_approve_claim_aborted', { component: 'onboarding', approvalId: this.approvalId, reason });
  }

  private pastCeiling(): boolean {
    return Date.now() - this.startedAt >= this.timing.ceilingMs;
  }

  /** Re-confirm + extend: only OUR token, only while still pending and not yet lapsed. */
  private async renew(): Promise<boolean> {
    const rows = await db
      .update(signupApprovals)
      .set({ approving_until: sql`now() + make_interval(secs => ${this.timing.claimMs / 1000})` })
      .where(
        and(
          eq(signupApprovals.id, this.approvalId),
          eq(signupApprovals.approving_claim, this.token),
          eq(signupApprovals.status, 'pending'),
          sql`${signupApprovals.approving_until} > now()`,
        ),
      )
      .returning({ id: signupApprovals.id });
    if (rows.length > 0) this.lastConfirmedAt = Date.now();
    return rows.length > 0;
  }

  private async heartbeat(): Promise<void> {
    if (this.abortReason) return;
    if (this.pastCeiling()) return this.abort('ceiling_reached');
    try {
      if (!(await this.renew())) this.abort('claim_lost');
    } catch (err) {
      log.warn('signup_approve_claim_heartbeat_failed', { component: 'onboarding', approvalId: this.approvalId, err });
      // Unconfirmed for (nearly) a whole window: it may have lapsed and been decided unseen.
      if (Date.now() - this.lastConfirmedAt >= this.timing.claimMs - this.timing.heartbeatMs) {
        this.abort('claim_unconfirmed');
      }
    }
  }

  /**
   * Call BEFORE every irreversible step. Throws 409 `approval_claim_lost` when the run has aborted
   * or the claim cannot be re-confirmed now; otherwise the claim is live for a full window.
   */
  async assertHeld(step: string): Promise<void> {
    if (!this.abortReason) {
      if (this.pastCeiling()) this.abort('ceiling_reached');
      else if (!(await this.renew())) this.abort('claim_lost');
    }
    if (this.abortReason) {
      throw conflict(
        'approval_claim_lost',
        `Approve stopped before '${step}' (${this.abortReason}): this run no longer holds the approval. ` +
          'Nothing further was done; approve again to resume.',
      );
    }
  }
}

/**
 * Take the approve claim on a PENDING row in one conditional UPDATE with a fresh per-claim token, and
 * hand back the row as of the claim. 409 `approval_in_progress` while somebody else holds a live
 * claim; 400 `approval_not_pending` once it is decided; 404 when there is no such row.
 */
async function claimApproval(id: string): Promise<{ approval: SignupApprovalRow; token: string }> {
  const token = crypto.randomUUID();
  const [claimed] = await db
    .update(signupApprovals)
    .set({
      approving_until: sql`now() + make_interval(secs => ${claimTiming.claimMs / 1000})`,
      approving_claim: token,
    })
    .where(
      and(
        eq(signupApprovals.id, id),
        eq(signupApprovals.status, 'pending'),
        sql`(${signupApprovals.approving_until} IS NULL OR ${signupApprovals.approving_until} <= now())`,
      ),
    )
    .returning();
  if (claimed) return { approval: claimed, token };
  const [now] = await db.select({ status: signupApprovals.status }).from(signupApprovals).where(eq(signupApprovals.id, id));
  if (!now) throw notFound('approval_not_found', `No signup approval '${id}'`);
  if (now.status !== 'pending') throw badRequest('approval_not_pending', `Approval is already ${now.status}`);
  throw conflict('approval_in_progress', 'This signup is being approved right now; reload in a moment.');
}

type SignupApprovalRow = typeof signupApprovals.$inferSelect;

async function approveClaimed(
  actor: User,
  approval: SignupApprovalRow,
  body: ApproveBody,
  claim: HeldApprovalClaim,
  decider: SignupDecider | undefined,
) {
  const id = approval.id;
  const token = claim.token;
  let tenantId: string;
  let role: TenantRole;
  let createdTenant = false;
  let founded: { id: string; name: string; slug: string; licences_name: string | null } | null = null;
  let provisioning: ProvisioningView | null = null;
  let nameDefaulted = false;
  let resumed = false;
  const foundedEarlier = body.mode === 'new_tenant' ? await tenantFoundedByApproval(id) : null;
  if (foundedEarlier) {
    // ⭐ RESUME. An earlier attempt founded this workspace (the marker is written in the tenant row's
    // own INSERT) and then failed or died at any later point. Finish INTO it — seat, licence, email —
    // instead of founding a second one.
    tenantId = foundedEarlier;
    role = 'tenant_admin';
    createdTenant = true;
    resumed = true;
    const [t] = await db
      .select({ id: tenants.id, name: tenants.name, slug: tenants.slug, licences_name: tenants.licences_name })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!t) throw notFound('tenant_not_found', `No tenant '${tenantId}'`);
    founded = t;
    await assertApprovalAdmitsUser(approval.email, approval.keycloak_sub, tenantId);
  } else if (body.mode === 'new_tenant') {
    // Refuse BEFORE creating anything: a requester who already belongs somewhere cannot found a
    // second workspace through the queue.
    await assertApprovalAdmitsUser(approval.email, approval.keycloak_sub, null);
    nameDefaulted = body.tenantName === undefined;
    const tenantName = body.tenantName ?? (await defaultTenantName(approval));
    // ⛔ Before founding the workspace (a tenant row, a licences tenant, a licence): the claim taken
    // above may already have been lost (a slow name lookup, a stalled heartbeat).
    await claim.assertHeld('create_tenant');
    // ⛔ `autoSuffixName` IS FOR THIS PATH ONLY. A self-signup approval must not bounce George back
    // to the queue because some other workspace is already called "acme": it becomes `acme-2`, and
    // the final name is returned, audited and sent to Telegram. POST /api/tenants (a super_admin
    // typing a name) never sets it and still gets the 409.
    const created = await createTenant({
      name: tenantName,
      byoMode: body.byoMode,
      // Early access: a signup approved with no plan gets the platform's local model (usable on
      // day one), like a workspace created in Platform → Tenants (plan-posture.ts NEW_TENANT_PLAN).
      planCode: newTenantPlanFor(body.byoMode),
      actor: { id: actor.id, email: actor.email },
      autoSuffixName: { maxAttempts: SELF_SIGNUP_NAME_ATTEMPTS },
      // The resume marker, born with the row (see `tenantFoundedByApproval`).
      signupApprovalId: id,
    });
    tenantId = created.tenant.id;
    founded = created.tenant;
    provisioning = created.provisioning;
    role = 'tenant_admin';
    createdTenant = true;
  } else {
    const target = body.tenantId ?? approval.assigned_tenant_id ?? approval.matched_tenant_id;
    if (!target) throw badRequest('tenant_required', 'No tenant for this approval; provide tenantId');
    await requireTenantExists(target);
    tenantId = target;
    role = (body.role ?? approval.requested_role ?? 'member') as TenantRole;
    await assertApprovalAdmitsUser(approval.email, approval.keycloak_sub, tenantId);
  }

  // Checkpoint the target before anything that can still fail.
  await db
    .update(signupApprovals)
    .set({ assigned_tenant_id: tenantId, requested_role: role })
    .where(and(eq(signupApprovals.id, id), eq(signupApprovals.approving_claim, token)));

  let invite: CreatedInvite | null = null;
  let seated = false;
  let seatedAtApproval = false;
  // A resumed workspace where the requester already holds the seat: that IS success, not a 409.
  const alreadyMember = resumed ? await liveMemberOf(tenantId, approval.email) : null;
  // ⛔ Before the seat / invite (irreversible: a seat, a realm identity, possibly an email).
  if (!alreadyMember) await claim.assertHeld('member_seat');
  if (alreadyMember) {
    seatedAtApproval = true;
    await ensureSignupAdminHeld(tenantId, alreadyMember, approval, role);
  } else if (approval.keycloak_sub) {
    await assertSeatAvailable(tenantId, approval.email);
    // ⛔ An `existing` approve seats the requester in a CUSTOMER workspace: record the seat it made
    // (never one the person already held) on the row, so a reject after this run aborts revokes
    // exactly that (`recordApproveEffect`). In a `finally`: the seat may land and a later licence
    // call throw.
    const memberBefore = createdTenant ? null : await liveMemberOf(tenantId, approval.email);
    try {
      seated =
        (await seatKnownIdentity({
          sub: approval.keycloak_sub,
          email: approval.email,
          name: approval.name,
          tenantId,
          role,
        })) === 'seated';
    } finally {
      if (!createdTenant && !memberBefore) {
        const now = await liveMemberOf(tenantId, approval.email);
        if (now) await recordApproveEffect(id, { tenantId, seatedUserId: now.id });
      }
    }
  }
  if (!seated && !alreadyMember) {
    invite = await createInvite({
      tenantId,
      email: approval.email,
      role,
      invitedBy: actor.id,
      name: approval.name ?? undefined,
      // Only for the workspace this approval founded: its provisioning record then tracks exactly
      // one requester (`signupAdmin`). An `existing` approval stays a plain invite.
      seatIfMinted: createdTenant,
    });
    // The invite an `existing` approve sent into a customer workspace (see above).
    if (!createdTenant) await recordApproveEffect(id, { tenantId, inviteId: invite.id });
    if (invite.seatedSub) {
      seatedAtApproval = true;
      await recordSignupAdminSeated(tenantId, {
        sub: invite.seatedSub,
        email: approval.email,
        name: approval.name,
        role,
        inviteId: invite.id,
        locale: approval.locale,
      });
    }
  }
  if (seatedAtApproval) {
    // Under each step's claim (tenant-provisioning.ts `runSignupAdminSteps`): the tick can never
    // send the same email in parallel.
    // ⛔ …and the claim is re-confirmed before EACH of them (the member licence, the email).
    const { emailSent } = await runSignupAdminSteps(
      tenantId,
      { source: 'create', actorId: actor.id },
      { beforeStep: (step) => claim.assertHeld(step) },
    );
    if (invite) invite = { ...invite, emailDelivery: emailSent ? 'keycloak_actions' : 'deferred' };
  }
  if (createdTenant) provisioning = toView(await readProvisioning(tenantId));

  // A run whose claim was lost with nothing left to guard (a reject offboarded the workspace, so
  // the steps above had nothing to run) still answers `approval_claim_lost`, not a generic 400.
  await claim.assertHeld('decide');
  // ⛔ CONDITIONAL ON `pending`: whatever slipped past the claim (an expired one), the row is decided
  // exactly once. Zero rows = somebody else decided it meanwhile.
  const [updated] = await db
    .update(signupApprovals)
    .set({
      status: 'approved',
      assigned_tenant_id: tenantId,
      requested_role: role,
      decided_at: new Date(),
      // `decided_by` is a FK onto users.id and a Keycloak-granted super_admin may have no row (nor
      // does the Telegram decider's service account — NULL, see `SignupDecider`).
      decided_by: decider ? null : await auditActorId(actor.id),
    })
    // …and only while THIS run still holds the claim: one that lapsed and was taken over decides
    // nothing.
    .where(
      and(
        eq(signupApprovals.id, id),
        eq(signupApprovals.status, 'pending'),
        eq(signupApprovals.approving_claim, token),
      ),
    )
    .returning();
  if (!updated) throw badRequest('approval_not_pending', 'Approval was decided meanwhile');
  await recordAudit({
    actorId: await auditActorId(actor.id),
    action: 'signup.approve',
    category: 'auth',
    targetType: 'user',
    targetId: seated ? approval.keycloak_sub! : approval.email,
    result: approval.email,
    resultTone: 'ok',
    tenantId,
    metadata: {
      tenantId,
      role,
      approvalId: id,
      mode: body.mode,
      createdTenant,
      resumed,
      // The FINAL names — after any auto-suffix — so "which workspace did this approval found?" is
      // answerable from the audit row alone.
      tenantName: founded?.name ?? null,
      tenantSlug: founded?.slug ?? null,
      licencesName: founded?.licences_name ?? null,
      nameDefaulted,
      seated,
      seatedAtApproval,
      inviteId: invite?.id ?? null,
      inviteDelivery: invite?.emailDelivery ?? null,
      actorSub: actor.id,
      ...deciderMetadata(decider),
    },
  });
  notifySignupDecision({
    id: id,
    outcome: 'approved',
    email: approval.email,
    name: approval.name,
    tenantId,
    tenantName: founded?.name ?? null,
    tenantSlug: founded?.slug ?? null,
    decidedVia: decidedViaLabel(decider),
    seated: seated || seatedAtApproval,
    inviteDelivery: invite?.emailDelivery ?? (alreadyMember ? emailStateOf(provisioning) : null),
    notOk: provisioning ? provisioningNotOk(provisioning) : [],
  });
  return {
    approval: updated,
    tenantId,
    role,
    invite,
    seated,
    seatedAtApproval,
    ...(founded
      ? {
          tenant: { id: founded.id, name: founded.name, slug: founded.slug, licencesName: founded.licences_name },
          provisioning,
        }
      : {}),
  };
}

function emailStateOf(view: ProvisioningView | null): string {
  return view?.steps.invite_email?.status === 'ok' ? 'keycloak_actions' : 'deferred';
}

/** The live CP member of `tenantId` with this address, if any (DB-only). */
async function liveMemberOf(tenantId: string, email: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        sql`lower(${users.email}) = lower(${email})`,
        isNull(users.deleted_at),
        eq(users.tenant_id, tenantId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * A resumed approval whose requester is already seated: make sure the steps that follow the seat
 * (licence, then email) are recorded, so they run now and the tick can finish them. Already held, or
 * the email already landed → nothing to do. Seated without a record (the earlier attempt died between
 * the seat and the record) → record it from the invite that seat accepted.
 */
async function ensureSignupAdminHeld(
  tenantId: string,
  member: { id: string },
  approval: SignupApprovalRow,
  role: TenantRole,
): Promise<void> {
  const rec = await readProvisioning(tenantId);
  if (rec?.signupAdmin || rec?.steps?.invite_email?.status === 'ok') return;
  // ⛔ `tenant_invites` IS RLS-SCOPED: read it under THIS workspace's scope. A plain `db` read runs
  // as `cp_app` with the operator's (or no) tenant GUC in production and sees nothing — the approve
  // would report success and no email would ever be sent.
  const [inv] = await withTenantTransaction(tenantId, (tx) =>
    tx
      .select({ id: tenantInvites.id })
      .from(tenantInvites)
      .where(
        and(
          eq(tenantInvites.tenant_id, tenantId),
          eq(tenantInvites.status, 'accepted'),
          sql`${tenantInvites.accepted_by} = ${member.id}`,
        ),
      )
      .limit(1),
  );
  if (!inv) return; // seated some other way (e.g. accepted an ordinary invite): nothing to send
  await recordSignupAdminSeated(tenantId, {
    sub: member.id,
    email: approval.email,
    name: approval.name,
    role,
    inviteId: inv.id,
    locale: approval.locale,
  });
}

/** POST /api/signup-approvals/invite — the pre-approved early-access invite (super_admin). */
const earlyAccessInviteSchema = z
  .object({
    email: z.string().trim().email().max(320),
    // Normalised like intake's `name` (utils/untrusted-text.ts): it is shown on /onboarding and
    // used for the workspace's default name.
    name: singleLineText(160),
    company: singleLineText(160).optional(),
    // Same rule as approve's `new_tenant` tenantName; omitted → `defaultTenantName` (company, else
    // the email's organisation, else the person's name).
    tenantName: z.string().trim().min(2).max(120).optional(),
    // 0121 — the language of the set-password email (the form's select, default `en`). Strict here:
    // the super_admin picks from the list, so anything else is a client bug → 422.
    locale: z.enum(SIGNUP_LOCALES).optional(),
  })
  .strict();

/**
 * POST /api/signup-approvals/invite — invite a person straight into early access, without them
 * submitting the public form (George 2026-10-19). Records a signup row (`source: 'invite'`) and runs
 * the SAME approve path as POST /:id/approve with `{mode: 'new_tenant'}`: a new workspace on the
 * platform's local model, the requester its tenant_admin, an invite email (Keycloak's set-password
 * email for a new identity) and the Telegram decision notice.
 *
 * A new row carries no `keycloak_sub`, so approve INVITES the address — exactly as for a queued
 * signup: when CP mints the realm identity for it, the person is seated + licensed at approval and
 * the set-password email follows the licence (`approveApprovalRow`, licence at approval); an address
 * that already has a realm identity is seated only when they accept with a VERIFIED matching email
 * (invite-service.ts acceptInvite). A REUSED pending row that already carries a realm-verified sub
 * (authenticated notify-self) is seated by approve, exactly as clicking Approve on it would.
 *
 * A person who already has a PENDING signup is simply approved now (their row is reused, so the
 * queue never holds two rows for one address). No new-signup Telegram notice and no queue ceiling:
 * this is a super_admin action, not an anonymous submission.
 */
const inviteEarlyAccess = route(async (req) => {
  const actor = await requireSuperAdmin(req);
  const body = earlyAccessInviteSchema.parse(await readJson(req));
  // Refuse BEFORE writing anything: an address that already has a live CP home must not leave a
  // stray pending row behind when approve then refuses it (approve re-checks; same 409).
  await assertApprovalAdmitsUser(body.email, null, null);

  // ON CONFLICT DO NOTHING on the pending-email partial unique index (0027), like `admitAndRecord`:
  // an empty `returning` means a pending row for this address already exists.
  const [inserted] = await db
    .insert(signupApprovals)
    .values({
      keycloak_sub: null,
      email: body.email,
      name: body.name,
      company: body.company ?? null,
      locale: body.locale ?? null,
      source: 'invite',
      trust: null,
      status: 'pending',
      requested_role: 'tenant_admin',
    })
    .onConflictDoNothing()
    .returning({ id: signupApprovals.id });
  let id = inserted?.id;
  const reusedPending = !inserted;
  if (!id) {
    const [existing] = await db
      .select({ id: signupApprovals.id })
      .from(signupApprovals)
      .where(
        and(
          eq(signupApprovals.status, 'pending'),
          sql`lower(${signupApprovals.email}) = lower(${body.email})`,
        ),
      )
      .limit(1);
    // Decided between the insert and this read — the address is no longer pending, so there is
    // nothing to approve here; the caller retries (a fresh insert then succeeds).
    if (!existing) throw badRequest('approval_not_pending', 'The pending signup for this address was just decided');
    id = existing.id;
    // The super_admin's language choice wins over whatever the earlier signup carried.
    if (body.locale) {
      await db.update(signupApprovals).set({ locale: body.locale }).where(eq(signupApprovals.id, id));
    }
  }

  await recordAudit({
    actorId: await auditActorId(actor.id),
    action: 'signup.invite',
    category: 'auth',
    targetType: 'user',
    targetId: body.email,
    result: body.email,
    resultTone: 'ok',
    metadata: { approvalId: id, reusedPending, actorSub: actor.id },
  });

  return jsonResponse(await approveApprovalRow(actor, id, { mode: 'new_tenant', tenantName: body.tenantName }));
});

/** Provisioning steps a fresh workspace did not finish (`ok` / `skipped` are finished). */
function provisioningNotOk(
  view: ProvisioningView,
): Array<{ step: string; status: string; code: string | null }> {
  return Object.entries(view.steps)
    .filter(([, rec]) => rec && rec.status !== 'ok' && rec.status !== 'skipped')
    .map(([step, rec]) => ({ step, status: rec!.status, code: rec!.code ?? null }));
}

/**
 * POST /api/signup-approvals/:id/reject — mark rejected (super_admin). When an earlier approve of
 * this signup aborted half-way (`approval_claim_lost`), the reject also undoes what it did
 * (services/signup-reject-repair.ts): the workspace it founded is offboarded and the identity CP
 * minted retired; a seat / invite an `existing` approve made in a customer workspace is revoked.
 * 409 `signup_workspace_in_use` when the founded workspace has other members or data (nothing
 * decided). 502 `signup_reject_offboard_failed` when the cleanup failed — the row IS rejected, its
 * `reject_repair` is `pending`, and the onboarding-integrity tick finishes it.
 *
 * On a row that is ALREADY rejected with its cleanup `pending` / `blocked`, this is the onboarding
 * screen's Retry: the cleanup runs again (the blockers re-checked first). Already `done` → 200, no-op.
 */
const rejectSignup = route(async (req, id) => {
  const actor = await requireSuperAdmin(req);
  const out = await rejectApprovalRow(actor, id!);
  throwIfCleanupNotDone(out);
  return jsonResponse({ approval: out.approval });
});

const resolveRepairSchema = z
  .object({
    note: z.string().max(4000).transform(multiLine).pipe(z.string().min(1).max(1000)),
    /** Required (true) when the resolve leaves the rejected requester's access live — the screen's
     *  confirmation checkbox; the API cannot skip it. */
    acknowledgeLiveAccess: z.boolean().optional(),
  })
  .strict();

/**
 * POST /api/signup-approvals/:id/resolve-repair — close a rejected signup's cleanup that cannot finish
 * on its own (super_admin), with a required note: `failed` (the automatic retries gave up on a cause
 * that is permanent — e.g. the registry has no owner for the tenant) or `blocked` (the workspace is in
 * use and is being kept). Terminal `resolved_manually`; the note, actor and the last error snapshot
 * are kept on the row and audited (`signup.reject_repair_resolved`). 409 when the row is not in a
 * resolvable state or a run holds it right now. ⛔ 422 `reject_repair_live_access_unacknowledged`
 * when the resolve would leave the rejected requester's access live (blocked; failed on a seat /
 * licence / IdP / identity / offboard cause) and the body lacks `acknowledgeLiveAccess: true`.
 */
const resolveRepair = route(async (req, id) => {
  const actor = await requireSuperAdmin(req);
  const { note, acknowledgeLiveAccess } = resolveRepairSchema.parse(await readJson(req));
  const out = await resolveRejectRepairManually(
    id!,
    { actorId: await auditActorId(actor.id), actorSub: actor.id },
    note,
    { acknowledgeLiveAccess },
  );
  if (!out.ok) {
    if (out.reason === 'not_found') throw notFound('approval_not_found', `No signup approval '${id}'`);
    if (out.reason === 'live_access_unacknowledged') {
      throw unprocessable(
        'reject_repair_live_access_unacknowledged',
        'Resolving this cleanup leaves the rejected requester\'s workspace, seat, licence or login live; confirm that explicitly (acknowledgeLiveAccess: true), or offboard the tenant under Platform → Tenants.',
        { state: out.state, leavesLiveAccess: true },
      );
    }
    if (out.reason === 'in_progress') {
      throw conflict('reject_repair_in_progress', 'Its cleanup is running right now; reload in a moment.');
    }
    throw conflict(
      'reject_repair_not_resolvable',
      `Only a rejected signup whose cleanup is failed or blocked can be resolved (it is ${out.state ?? 'not rejected'}).`,
      { state: out.state },
    );
  }
  return jsonResponse({ approval: out.row });
});

interface RejectResult {
  approval: SignupApprovalRow;
  /** False when the row was already rejected (a Retry of its cleanup, or a no-op). */
  decidedHere: boolean;
  /** What the cleanup did; null when there was nothing to undo. */
  repair: RejectRepairOutcome | null;
}

/** The screen's answer for a cleanup that did not finish: blocked → 409, failed → 502. */
function throwIfCleanupNotDone(out: RejectResult): void {
  const r = out.repair;
  if (!r) return;
  if (r.state === 'blocked') {
    throw conflict(
      'signup_workspace_in_use',
      'The workspace this rejected signup founded is in use (other members or data), so the reject will ' +
        'not offboard it. Offboard it deliberately (Platform → Tenants) if that is intended.',
      { tenantId: r.tenantId, blockers: r.blockers },
    );
  }
  if (r.state === 'failed') {
    throw new HttpError(
      502,
      'signup_reject_offboard_failed',
      `${out.decidedHere ? 'Rejected' : 'The signup is rejected'}, but undoing what its approve did failed ` +
        `${r.attempts ?? ''} times and is no longer retried automatically: ${r.error}. Retry it on the onboarding screen.`,
    );
  }
  if (r.state === 'pending') {
    throw new HttpError(
      502,
      'signup_reject_offboard_failed',
      `${out.decidedHere ? 'Rejected' : 'The signup is rejected'}, but undoing what its approve did failed: ${r.error}. ` +
        'It is retried automatically; the onboarding screen lists it until it is done.',
    );
  }
}

function rejectRepairActor(
  actorId: string | null,
  actor: User,
  decider: SignupDecider | undefined,
  via: RejectRepairActor['via'],
): RejectRepairActor {
  return decider
    ? { actorId: null, operator: `telegram:${decider.telegramUserId}`, via, metadata: deciderMetadata(decider) }
    : { actorId, operator: null, via, metadata: { actorSub: actor.id, ...deciderMetadata(undefined) } };
}

/** The reject path, shared by the super_admin route and the Telegram decision. Throws only for what
 *  prevents the DECISION (404 / 400 / 409); a cleanup outcome is returned (`repair`). */
async function rejectApprovalRow(actor: User, id: string, decider?: SignupDecider): Promise<RejectResult> {
  const [approval] = await db
    .select()
    .from(signupApprovals)
    .where(eq(signupApprovals.id, id))
    .limit(1);
  if (!approval) throw notFound('approval_not_found', `No signup approval '${id}'`);
  if (approval.status === 'rejected' && approval.reject_repair) {
    // RETRY (the onboarding screen's, or a repeat): finish the cleanup an earlier reject left
    // `pending` / `blocked` — the same function the tick runs. Already `done` → nothing to do.
    if (approval.reject_repair.state === 'done' || approval.reject_repair.state === 'resolved_manually') {
      return { approval, decidedHere: false, repair: null };
    }
    const repair = await repairRejectedSignup(
      id,
      rejectRepairActor(decider ? null : await auditActorId(actor.id), actor, decider, 'signup.reject_retry'),
      { includeBlocked: true },
    );
    return { approval: (await reloadApproval(id)) ?? approval, decidedHere: false, repair };
  }
  if (approval.status !== 'pending') {
    throw badRequest('approval_not_pending', `Approval is already ${approval.status}`);
  }
  if (approval.approving_until && approval.approving_until.getTime() > Date.now()) {
    throw conflict('approval_in_progress', 'This signup is being approved right now; reload in a moment.');
  }
  // The workspace an earlier (aborted) approve of THIS signup founded, still live — see below.
  const founded = await tenantFoundedByApproval(id);
  // ⛔ A SIGNUP WHOSE APPROVE ABORTED AFTER THE SEAT already FOUNDED a workspace and seated the
  // requester in it (`approval_claim_lost`). Rejecting it must undo that — offboard the workspace —
  // but only while it is still exactly what the approve made. Another member, somebody else's
  // invite, or any user data → refuse (409), BEFORE anything is decided, rather than destroy it.
  if (founded) {
    const blockers = await signupWorkspaceBlockers(founded, approval.email);
    if (blockers.length > 0) {
      throw conflict(
        'signup_workspace_in_use',
        'An earlier approve of this signup founded a workspace that now has other members or data, so ' +
          'rejecting it would destroy them. Offboard that workspace deliberately (Platform → Tenants) first.',
        { tenantId: founded, blockers },
      );
    }
  }
  const actorId = decider ? null : await auditActorId(actor.id);
  const [updated] = await db
    .update(signupApprovals)
    // Same FK as the approve path above — nullable, so a seatless super_admin's rejection is
    // recorded with decided_by NULL instead of 500ing on the FK.
    .set({
      status: 'rejected',
      decided_at: new Date(),
      decided_by: actorId,
      // ⭐ The cleanup is recorded WITH the decision (one statement): whatever happens next — this
      // request dying, licences down — the row says there is something left to undo, and the
      // onboarding-integrity tick finishes it. Computed in SQL so an `approve_effects` an aborting
      // approve recorded a moment ago is never missed.
      reject_repair: sql`CASE WHEN ${founded}::uuid IS NOT NULL
                               OR jsonb_array_length(coalesce(${signupApprovals.approve_effects}, '[]'::jsonb)) > 0
                          THEN ${JSON.stringify(initialRejectRepair(founded))}::jsonb ELSE NULL END`,
    })
    .where(
      and(
        eq(signupApprovals.id, id),
        eq(signupApprovals.status, 'pending'),
        // Never under a live approve claim: the approve may already have founded the workspace.
        // ⛔ Keyed on `approving_until` ALONE — never on `approving_claim` — so ANY live claim refuses,
        // token or not. A reject can only land once the claim has lapsed, and from then on the old run
        // cannot do anything irreversible: `HeldApprovalClaim.assertHeld` re-confirms
        // `approving_until > now()` + `pending` + its token before each step (and its final write is
        // conditional on both), so it aborts with `approval_claim_lost` instead.
        sql`(${signupApprovals.approving_until} IS NULL OR ${signupApprovals.approving_until} <= now())`,
      ),
    )
    .returning();
  if (!updated) {
    const [now] = await db.select({ status: signupApprovals.status }).from(signupApprovals).where(eq(signupApprovals.id, id));
    if (now?.status === 'pending') {
      throw conflict('approval_in_progress', 'This signup is being approved right now; reload in a moment.');
    }
    throw badRequest('approval_not_pending', 'Approval was decided meanwhile');
  }
  // From here the signup is REJECTED: `member_licence` / `invite_email` refuse it for good
  // (tenant-provisioning.ts `signupDecisionGate`), whatever happens to the cleanup below.
  const repair = updated.reject_repair
    ? await repairRejectedSignup(id, rejectRepairActor(actorId, actor, decider, 'signup.reject'), { audit: false })
    : null;
  const tenantId = repair?.tenantId ?? founded;
  await recordAudit({
    actorId,
    action: 'signup.reject',
    category: 'auth',
    targetType: 'user',
    targetId: approval.email,
    result: 'rejected',
    resultTone: 'warn',
    ...(tenantId ? { tenantId } : {}),
    metadata: {
      approvalId: id,
      actorSub: actor.id,
      ...deciderMetadata(decider),
      // What an aborted approve left behind, and what the reject did to it.
      ...(repair
        ? {
            foundedTenantId: tenantId,
            workspaceOffboarded: repair.offboard !== null,
            offboardError: repair.error,
            cleanup: repair.state,
            seatFailures: repair.offboard?.offboard.seatFailures.length ?? null,
            centralArchiveSkipped: repair.offboard?.offboard.archiveSkipped ?? null,
            keycloakIdentity: repair.keycloakIdentity,
            effectsRevoked: repair.effectsRevoked,
          }
        : {}),
    },
  });
  notifySignupDecision({
    id,
    outcome: 'rejected',
    email: approval.email,
    name: approval.name,
    decidedVia: decidedViaLabel(decider),
  });
  return { approval: (repair ? await reloadApproval(id) : null) ?? updated, decidedHere: true, repair };
}

async function reloadApproval(id: string): Promise<SignupApprovalRow | null> {
  const [row] = await db.select().from(signupApprovals).where(eq(signupApprovals.id, id)).limit(1);
  return row ?? null;
}

/**
 * An `existing`-mode approve just created a seat or an invite in a customer workspace: record it on
 * the row, so a reject after this run aborts revokes exactly that (services/signup-reject-repair.ts).
 * ⛔ Unconditional on the claim — the effect exists whether or not this run still holds it — and when
 * a reject already landed (the claim lapsed under the seat), the same statement marks the row's
 * cleanup `pending` so the onboarding-integrity tick undoes it.
 */
export async function recordApproveEffect(id: string, effect: Omit<SignupApproveEffect, 'at'>): Promise<void> {
  const entry = JSON.stringify([{ ...effect, at: new Date().toISOString() }]);
  await db
    .update(signupApprovals)
    .set({
      approve_effects: sql`coalesce(${signupApprovals.approve_effects}, '[]'::jsonb) || ${entry}::jsonb`,
      // A `failed` row (the tick gave up) has a NEW thing to undo: due again, the count restarted.
      // A `pending` row — held by a runner or not — is left as is: the runner's `done` write is
      // conditional on `approve_effects` being unchanged, so it stays `pending` and the next run
      // revokes this one too.
      reject_repair: sql`CASE WHEN ${signupApprovals.status} = 'rejected'
                               AND (${signupApprovals.reject_repair} IS NULL OR ${signupApprovals.reject_repair}->>'state' IN ('done','resolved_manually'))
                          THEN ${JSON.stringify(initialRejectRepair(null))}::jsonb
                          WHEN ${signupApprovals.status} = 'rejected' AND ${signupApprovals.reject_repair}->>'state' = 'failed'
                          THEN ${signupApprovals.reject_repair} || jsonb_build_object('state', 'pending', 'attempts', 0,
                                 'nextAttemptAt', to_jsonb(now()))
                          ELSE ${signupApprovals.reject_repair} END`,
    })
    .where(eq(signupApprovals.id, id));
}

// ---- Telegram decision (chat-bridge service account, early-access v2 C3) ----

const telegramDecisionSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    telegramUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** The reply text shown in Telegram: plain, ≤200 chars. */
function summary(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

function decidedSummary(row: {
  status: string;
  email: string;
  assigned_tenant_id: string | null;
  reject_repair?: SignupApprovalRow['reject_repair'];
}): string {
  const rr = row.status === 'rejected' ? row.reject_repair : null;
  return summary(
    `Already ${row.status}: ${row.email}` +
      (row.status === 'approved' && row.assigned_tenant_id ? ` (tenant ${row.assigned_tenant_id})` : '') +
      '.' +
      (rr && rr.state !== 'done' ? ` Cleanup of its aborted approve: ${rr.state}.` : ''),
  );
}

/** What became of a reject's cleanup, for the Telegram reply ('' when there was none). */
function cleanupNote(r: RejectRepairOutcome | null): string {
  if (!r || r.state === 'none') return '';
  if (r.state === 'done') return ` Cleaned up: ${undoneSummary(r.undid)}.`;
  if (r.state === 'in_progress') return ' Cleaning up what its aborted approve left behind is under way.';
  if (r.state === 'blocked') return ` Its workspace is in use (${r.blockers.join(', ')}) - not offboarded; see the CP onboarding screen.`;
  if (r.state === 'failed') {
    return ` Cleanup gave up after ${r.attempts ?? '?'} attempts (${r.error ?? 'unknown'}); Retry it on the CP onboarding screen.`;
  }
  return ` Cleanup failed (${r.error ?? 'unknown'}); retried automatically.`;
}

/** What a done cleanup undid, named per kind: a FOUNDED workspace, or an existing-mode seat / invite. */
function undoneSummary(u: RejectRepairOutcome['undid']): string {
  const parts: string[] = [];
  if (u?.workspace) parts.push('the workspace its aborted approve founded is offboarded');
  if (u?.seats) parts.push(`the seat${u.seats > 1 ? 's' : ''} its aborted approve made in a customer workspace ${u.seats > 1 ? 'are' : 'is'} revoked`);
  if (u?.invites) parts.push(`the invite${u.invites > 1 ? 's' : ''} its aborted approve sent to a customer workspace ${u.invites > 1 ? 'are' : 'is'} revoked`);
  return parts.length > 0 ? parts.join('; ') : 'what its aborted approve left behind is undone';
}

/**
 * POST /api/signup-approvals/:id/telegram-decision — George's Approve/Reject tap, relayed by
 * chat-bridge (which checked the tapper is an approver) with its service-account token.
 *
 * Body (strict): `{action: 'approve'|'reject', telegramUserId: number}`.
 * Approve = the super_admin approve with DEFAULTS: `{mode: 'new_tenant'}` — the suggested workspace
 * name, the plan's posture (local-llm). Reject = the super_admin reject. Same code path, same audit
 * rows (actor `telegram:<telegramUserId>` via the decider client), same Telegram follow-up.
 *
 * Replies (contract C3): 200 `{status: 'approved'|'rejected'|'already_decided', tenantId?, summary}`;
 * 404 unknown id; 401/403 auth; 502 `{status: 'failed', summary}` when the decision could not be
 * carried out (provisioning failure, an address that already belongs to a workspace, …) — the row
 * then stays pending and can be decided again. Idempotent: a decided row → `already_decided`.
 */
const telegramDecision = route(async (req, id) => {
  const caller = await requireSignupDeciderCaller(req);
  const body = telegramDecisionSchema.parse(await readJson(req));
  if (!z.guid().safeParse(id).success) throw notFound('approval_not_found', `No signup approval '${id}'`);
  const [approval] = await db.select().from(signupApprovals).where(eq(signupApprovals.id, id!)).limit(1);
  if (!approval) throw notFound('approval_not_found', `No signup approval '${id}'`);
  if (approval.status !== 'pending') {
    return jsonResponse({
      status: 'already_decided',
      ...(approval.assigned_tenant_id && approval.status === 'approved' ? { tenantId: approval.assigned_tenant_id } : {}),
      outcome: approval.status,
      summary: decidedSummary(approval),
    });
  }
  // The service account acting. It has no CP users row and no roles CP grants anything for; the
  // approve/reject cores only use it as the (System-attributed) actor.
  const actor: User = { id: caller.subject, email: '', name: 'Telegram decision', roles: [] };
  const decider: SignupDecider = { telegramUserId: body.telegramUserId, azp: caller.azp };
  try {
    if (body.action === 'reject') {
      // ⛔ The reply says what is TRUE NOW, not what this call hoped to do. Between the pending read
      // above and the reject, the screen may have rejected it (this call then only re-runs the — leased,
      // idempotent — cleanup: `already_decided`), and a cleanup that is under way elsewhere or retried
      // by the tick is a rejected signup, never "Could not reject".
      const out = await rejectApprovalRow(actor, id!, decider);
      const note = cleanupNote(out.repair);
      if (!out.decidedHere) {
        return jsonResponse({
          status: 'already_decided',
          outcome: 'rejected',
          ...(out.repair ? { cleanup: out.repair.state } : {}),
          summary: summary(`Already rejected: ${approval.email}.${note}`),
        });
      }
      return jsonResponse({
        status: 'rejected',
        ...(out.repair ? { cleanup: out.repair.state } : {}),
        summary: summary(`Rejected: ${approval.email}.${note}`),
      });
    }
    // Defaults (contract C3): a new workspace with the suggested name. A workspace an earlier
    // attempt of THIS approval founded is resumed by `new_tenant` itself (seat, licence, email —
    // never a second workspace). A target a super_admin checkpointed for an `existing` approve that
    // then failed is finished as that `existing` approve.
    const out = await approveApprovalRow(
      actor,
      id!,
      approval.assigned_tenant_id && (await tenantFoundedByApproval(id!)) === null
        ? { mode: 'existing', tenantId: approval.assigned_tenant_id }
        : { mode: 'new_tenant' },
      decider,
    );
    const ws = out.tenant ? `"${out.tenant.name}" (${out.tenant.slug})` : out.tenantId;
    const mail =
      out.invite?.emailDelivery === 'keycloak_actions' || out.invite?.emailDelivery === 'sent'
        ? 'set-password email sent'
        : out.invite?.emailDelivery === 'deferred'
          ? 'email follows once the licence is ready'
          : out.seated
            ? 'seated directly'
            : 'email FAILED - send the link from CP';
    return jsonResponse({
      status: 'approved',
      tenantId: out.tenantId,
      summary: summary(`Approved: ${approval.email} -> workspace ${ws}; ${mail}.`),
    });
  } catch (err) {
    // Another decider (the screen, a second tap, a redelivery — possibly on another replica) is
    // approving this row right now: answer at once, nothing was done here.
    if (err instanceof HttpError && err.code === 'approval_in_progress') {
      return jsonResponse({
        status: 'already_decided',
        outcome: 'in_progress',
        summary: summary(`A decision for ${approval.email} is already being carried out.`),
      });
    }
    // Lost a race with the other decider (the screen, or a second tap): answer what happened.
    if (err instanceof HttpError && err.code === 'approval_not_pending') {
      const [now] = await db.select().from(signupApprovals).where(eq(signupApprovals.id, id!)).limit(1);
      if (now && now.status !== 'pending') {
        return jsonResponse({
          status: 'already_decided',
          ...(now.assigned_tenant_id && now.status === 'approved' ? { tenantId: now.assigned_tenant_id } : {}),
          outcome: now.status,
          summary: decidedSummary(now),
        });
      }
    }
    const code = err instanceof HttpError ? err.code : 'internal_error';
    const message = err instanceof Error ? err.message : String(err);
    log.warn('signup_telegram_decision_failed', {
      component: 'onboarding',
      approvalId: id,
      action: body.action,
      code,
      err,
    });
    return jsonResponse(
      { status: 'failed', code, summary: summary(`Could not ${body.action}: ${code} - ${message}`) },
      502,
    );
  }
});

// ---- invite (super_admin → existing tenant) ----

/** POST /api/invites — invite a person into an EXISTING workspace (super_admin). The bootstrap
 *  path for a workspace's first tenant_admin. Same semantics as POST /api/tenants/:id/users. */
const inviteUser = route(async (req) => {
  const actor = await requireSuperAdmin(req);
  const body = inviteSchema.parse(await readJson(req));
  const invite = await createInvite({
    tenantId: body.tenantId,
    email: body.email,
    role: body.role ?? 'member',
    invitedBy: actor.id,
    name: body.name,
    firstName: body.firstName,
    lastName: body.lastName,
  });
  return jsonResponse({ invite }, 201);
});

// ---- email-domain routing + free-mail blocklist (super_admin) ----

/** GET /api/email-domains — corporate-domain → tenant routing table. */
const listEmailDomains = route(async (req) => {
  await requireSuperAdmin(req);
  const rows = await db
    .select()
    .from(emailDomainTenants)
    .orderBy(desc(emailDomainTenants.created_at));
  return jsonResponse({ domains: rows });
});

/** POST /api/email-domains — upsert a domain → tenant mapping. */
const upsertEmailDomain = route(async (req) => {
  const actor = await requireSuperAdmin(req);
  const body = emailDomainSchema.parse(await readJson(req));
  const domain = body.domain.trim().toLowerCase().replace(/^@/, '');
  await requireTenantExists(body.tenantId);
  const [row] = await db
    .insert(emailDomainTenants)
    .values({ domain, tenant_id: body.tenantId, auto_assign: body.autoAssign ?? true })
    .onConflictDoUpdate({
      target: emailDomainTenants.domain,
      set: { tenant_id: body.tenantId, auto_assign: body.autoAssign ?? true },
    })
    .returning();
  await recordAudit({
    actorId: actor.id,
    tenantId: body.tenantId,
    action: 'email_domain.upsert',
    category: 'auth',
    targetType: 'email_domain',
    targetId: domain,
    result: body.tenantId,
    resultTone: 'ok',
  });
  return jsonResponse({ domain: row }, 201);
});

/** DELETE /api/email-domains/:domain — remove a domain mapping. */
const deleteEmailDomain = route(async (req, domain) => {
  const actor = await requireSuperAdmin(req);
  const key = decodeURIComponent(domain!).trim().toLowerCase();
  const deleted = await db
    .delete(emailDomainTenants)
    .where(eq(emailDomainTenants.domain, key))
    .returning({ domain: emailDomainTenants.domain, tenantId: emailDomainTenants.tenant_id });
  if (!deleted.length) throw notFound('email_domain_not_found', `No mapping for '${key}'`);
  await recordAudit({
    actorId: actor.id,
    tenantId: deleted[0]!.tenantId,
    action: 'email_domain.delete',
    category: 'auth',
    targetType: 'email_domain',
    targetId: key,
    result: 'removed',
    resultTone: 'warn',
  });
  return jsonResponse({ ok: true });
});

/** GET /api/free-email-providers — the free-mail blocklist. */
const listFreeProviders = route(async (req) => {
  await requireSuperAdmin(req);
  const rows = await db
    .select({ domain: freeEmailProviders.domain })
    .from(freeEmailProviders)
    .orderBy(freeEmailProviders.domain);
  return jsonResponse({ providers: rows.map((r) => r.domain) });
});

/** POST /api/free-email-providers — add a free-mail domain to the blocklist. */
const addFreeProvider = route(async (req) => {
  await requireSuperAdmin(req);
  const body = freeProviderSchema.parse(await readJson(req));
  const domain = body.domain.trim().toLowerCase().replace(/^@/, '');
  await db
    .insert(freeEmailProviders)
    .values({ domain })
    .onConflictDoNothing({ target: freeEmailProviders.domain });
  return jsonResponse({ domain }, 201);
});

/** DELETE /api/free-email-providers/:domain — remove a free-mail domain. */
const deleteFreeProvider = route(async (req, domain) => {
  await requireSuperAdmin(req);
  const key = decodeURIComponent(domain!).trim().toLowerCase();
  await db.delete(freeEmailProviders).where(eq(freeEmailProviders.domain, key));
  return jsonResponse({ ok: true });
});

export function registerOnboardingRoutes(router: Router): void {
  // self-signup notify (open) — declared before the parametric :id route.
  router.add('POST', '/api/signup-approvals/notify-self', notifySelf);
  router.add('POST', '/api/signup-approvals/intake', intakeSignup);
  router.add('GET', '/api/signup-approvals', listApprovals);
  router.add('GET', '/api/signup-approvals/stats', approvalStats);
  // super_admin pre-approved invite — a literal segment, declared before every `:id` route.
  router.add('POST', '/api/signup-approvals/invite', inviteEarlyAccess);
  router.add('GET', '/api/signup-approvals/:id', getApproval);
  router.add('POST', '/api/signup-approvals/:id/approve', approveSignup);
  router.add('POST', '/api/signup-approvals/:id/reject', rejectSignup);
  router.add('POST', '/api/signup-approvals/:id/resolve-repair', resolveRepair);
  router.add('POST', '/api/signup-approvals/:id/telegram-decision', telegramDecision);
  router.add('POST', '/api/invites', inviteUser);
  router.add('GET', '/api/email-domains', listEmailDomains);
  router.add('POST', '/api/email-domains', upsertEmailDomain);
  router.add('DELETE', '/api/email-domains/:domain', deleteEmailDomain);
  router.add('GET', '/api/free-email-providers', listFreeProviders);
  router.add('POST', '/api/free-email-providers', addFreeProvider);
  router.add('DELETE', '/api/free-email-providers/:domain', deleteFreeProvider);
}
