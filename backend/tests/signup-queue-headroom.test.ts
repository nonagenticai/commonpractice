// tests/signup-queue-headroom.test.ts — the anonymous self-signup queue cannot be used to lock a
// paying customer out.
//
// ⛔ THE DEFECT THIS PINS, AND WHY THE OLD SHAPE COULD NOT BE TESTED INTO SAFETY. `notifySelf`
// refused on ONE number — a hardcoded 500 pending rows — and that refusal hit every caller equally.
// The rate limiter in front of it (middleware/rate-limit.ts) is per-IP AND per-pod by its own
// documented design, so 2-4 replicas make the fleet ceiling 20-40/min on the tight anonymous bucket:
// a distributed sprayer does not have to beat the limiter, only outlast it. Once the table held 500
// junk rows the NEXT genuine signup — a domain-matched employee of a customer, arriving through the
// login bootstrap — got the identical 503. The attacker paid nothing for that outage; the customer
// paid all of it. Splitting the ceiling is the repair, and the test that matters is not "does it
// refuse" (a cap that refuses everything passes that) but the one named IN FULL below: OVER the
// anonymous sub-quota, a matched or authenticated signup is still ACCEPTED.
//
// ⚠️ EVERY ROUTE-LEVEL CASE HERE IS WRITTEN RELATIVE TO THE QUEUE'S CURRENT COUNTS, NEVER TO AN
// ABSOLUTE. `signup_approvals` is a shared table on a shared dev database: rows from other lanes,
// from a previous run, or from a real environment are all counted by the SQL under test. A case
// that assumed an empty table would pass or fail on somebody else's fixtures, and — worse — a case
// that DELETED the table to make its assumption true would destroy them. So each case measures the
// baseline first and sets the ceilings around it, which is both safe on any database and a stricter
// statement: the refusal is proved to depend on the count the route actually reads.
import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, tenants, users, signupApprovals, emailDomainTenants } from '../src/db/client';
import { Router } from '../src/utils/router';
import { registerOnboardingRoutes } from '../src/routes/onboarding';
import { __setAuthOverridesForTests } from '../src/middleware/auth';
import { __setKeycloakAdminForTests } from '../src/services/keycloak-admin';
import {
  signupQueueLimits,
  signupQueueVerdict,
  SIGNUP_QUEUE_REFUSED_COUNTER,
  SIGNUP_QUEUE_REFUSAL_REASONS,
} from '../src/services/onboarding-service';
import { PRESEEDED_LABELLED_COUNTERS, renderMetrics } from '../src/host/metrics';
import type { User } from '../src/types';

// ---------------------------------------------------------------------------------------------
// Part 1 — the decision itself, with no database and no HTTP in the way.
// ---------------------------------------------------------------------------------------------

const LIMITS = { maxPending: 100, maxAnonymousPending: 80 };

test('signupQueueLimits: unset env reproduces the old hardcoded 500 EXACTLY', () => {
  // ⛔ THE NO-BEHAVIOUR-CHANGE HALF, AND IT IS THE ONE MOST LIKELY TO ROT. The number this replaces
  // was `const MAX_PENDING_APPROVALS = 500` in routes/onboarding.ts. Making it configurable is only
  // safe if an unconfigured deployment — which is every deployment today, since nothing sets these
  // vars — keeps refusing at exactly the same point. An empty env is passed EXPLICITLY rather than
  // relying on `process.env` being clean: another test file in the same `bun test` process can have
  // set either variable, and this assertion must not depend on file order.
  expect(signupQueueLimits({})).toEqual({ maxPending: 500, maxAnonymousPending: 400 });
});

test('signupQueueLimits: both ceilings are env-driven, and the sub-quota defaults to a share of the total', () => {
  expect(signupQueueLimits({ SIGNUP_QUEUE_MAX_PENDING: '50' })).toEqual({
    maxPending: 50,
    maxAnonymousPending: 40, // 80% of 50 — derived, so raising the total raises the reserve with it
  });
  expect(
    signupQueueLimits({ SIGNUP_QUEUE_MAX_PENDING: '50', SIGNUP_QUEUE_MAX_ANON_PENDING: '10' }),
  ).toEqual({ maxPending: 50, maxAnonymousPending: 10 });

  // Garbage falls back rather than throwing or yielding NaN — a NaN ceiling compares false against
  // every count, i.e. an unlimited queue, which is the failure this whole file exists to prevent.
  expect(signupQueueLimits({ SIGNUP_QUEUE_MAX_PENDING: 'five hundred' }).maxPending).toBe(500);
});

test('signupQueueLimits: a FRACTION is refused, not truncated — 0.8 must never mean "refuse all anonymous"', () => {
  // ⛔ THE HIGHEST-CONSEQUENCE PARSE IN THIS FILE, AND `parseInt` GOT IT WRONG BY DEFAULT.
  // `Number.parseInt('0.8', 10)` is 0, and 0 is the emergency lever that refuses EVERY anonymous
  // signup. The typo is not hypothetical: the derived default is literally
  // `ANONYMOUS_PENDING_SHARE = 0.8` in the same file, so an operator reading it and setting the knob
  // to `0.8` is the expected mistake — and `parseInt` would have answered it with a silent total
  // outage of the public signup surface. It falls back to the documented default instead.
  expect(signupQueueLimits({ SIGNUP_QUEUE_MAX_ANON_PENDING: '0.8' }).maxAnonymousPending).toBe(400);
  // Same defect wearing other clothes — a prefix that parses is still not the value that was meant.
  expect(signupQueueLimits({ SIGNUP_QUEUE_MAX_ANON_PENDING: '80%' }).maxAnonymousPending).toBe(400);
  expect(signupQueueLimits({ SIGNUP_QUEUE_MAX_PENDING: '1e3' }).maxPending).toBe(500);
  expect(signupQueueLimits({ SIGNUP_QUEUE_MAX_PENDING: '5.9' }).maxPending).toBe(500);
  // A real integer still works, including with the whitespace a k8s ConfigMap can carry.
  expect(signupQueueLimits({ SIGNUP_QUEUE_MAX_PENDING: ' 250 ' }).maxPending).toBe(250);
  // And an explicit 0 is still the lever, not a casualty of the stricter parse.
  expect(signupQueueLimits({ SIGNUP_QUEUE_MAX_ANON_PENDING: '0' }).maxAnonymousPending).toBe(0);
});

test('signupQueueLimits: 0 anonymous is a usable emergency lever; 0 total is not, and neither is an unreachable sub-quota', () => {
  // 0 must SURVIVE the clamp: "refuse all anonymous intake, keep serving matched and authenticated
  // signups" is the lever an operator reaches for mid-incident, and a `Math.max(1, …)` here would
  // silently turn it into 1.
  expect(signupQueueLimits({ SIGNUP_QUEUE_MAX_ANON_PENDING: '0' }).maxAnonymousPending).toBe(0);
  // A 0 TOTAL would be a total outage of the signup surface configured by a typo.
  expect(signupQueueLimits({ SIGNUP_QUEUE_MAX_PENDING: '0' }).maxPending).toBe(1);
  // A sub-quota above the total can never be reached — a knob that silently does nothing.
  expect(
    signupQueueLimits({ SIGNUP_QUEUE_MAX_PENDING: '10', SIGNUP_QUEUE_MAX_ANON_PENDING: '999' })
      .maxAnonymousPending,
  ).toBe(10);
});

test('signupQueueVerdict: under both ceilings, everyone is admitted', () => {
  expect(signupQueueVerdict({ pending: 10, anonymousPending: 10 }, false, LIMITS)).toEqual({
    admit: true,
  });
  expect(signupQueueVerdict({ pending: 10, anonymousPending: 10 }, true, LIMITS)).toEqual({
    admit: true,
  });
});

test('signupQueueVerdict: over the ANONYMOUS sub-quota an anonymous signup is refused — and an identified one is NOT', () => {
  const counts = { pending: 90, anonymousPending: 80 }; // under 100 total, AT the 80 reserve line
  expect(signupQueueVerdict(counts, false, LIMITS)).toEqual({
    admit: false,
    reason: 'anonymous_quota',
    observed: 80,
    cap: 80,
  });
  // ⛔ THE WHOLE POINT, IN ONE ASSERTION. Same queue, same instant, same ceilings — the only thing
  // that differs is that this caller is authenticated or domain-matched, and they get in.
  expect(signupQueueVerdict(counts, true, LIMITS)).toEqual({ admit: true });
});

test('signupQueueVerdict: the TOTAL ceiling refuses everybody, identified or not', () => {
  const counts = { pending: 100, anonymousPending: 10 }; // full table, reserve nowhere near
  const refusal = { admit: false, reason: 'queue_full', observed: 100, cap: 100 } as const;
  expect(signupQueueVerdict(counts, false, LIMITS)).toEqual(refusal);
  expect(signupQueueVerdict(counts, true, LIMITS)).toEqual(refusal);
});

test('signupQueueVerdict: when BOTH ceilings are breached the answer is queue_full, not anonymous_quota', () => {
  // ⛔ THE ORDER CASE, AT THE ONLY STATE THAT CAN SEE IT. The case above is titled for order and
  // does not test it: at `anonymousPending: 10` against a cap of 80 the sub-quota arm cannot fire
  // whichever way round the two checks are, so swapping them leaves it green. An adversarial audit
  // proved that by swapping them — 14 pass, 0 fail. Order is observable at exactly one state:
  // `pending >= maxPending` AND `anonymousPending >= maxAnonymousPending` AND NOT identified.
  //
  // Correct: `queue_full` — the table is full, and that is the fact an operator must act on.
  // Swapped: `anonymous_quota` — which metrics.ts's own note calls the inversion that must never
  // happen: a full queue paging as an abuse burst sends the operator hunting a sprayer while every
  // caller, customers included, is being turned away.
  const bothBreached = { pending: 100, anonymousPending: 80 };
  expect(signupQueueVerdict(bothBreached, false, LIMITS)).toEqual({
    admit: false,
    reason: 'queue_full',
    observed: 100,
    cap: 100,
  });
  // The identified caller reaches the same arm — they were never eligible for the sub-quota one,
  // so this half stays green under the swap and is here as the outcome control, not the order one.
  expect(signupQueueVerdict(bothBreached, true, LIMITS)).toEqual({
    admit: false,
    reason: 'queue_full',
    observed: 100,
    cap: 100,
  });
});

test('the refusal reasons cannot drift out of the metrics registry', () => {
  // ⛔ SAME DRIFT TRAP AS `EMIT_DROP_REASONS` (see tests/metrics-counter-preseed.test.ts).
  // host/metrics.ts cannot import onboarding-service (the route imports both, and the registry is
  // deliberately DB-free), so the roster is hand-mirrored — and `incLabelledCounter` SILENTLY
  // IGNORES an unregistered name or value. A rename on either side yields a metric that reads 0
  // forever while every other test stays green, which for an alert is worse than no metric at all:
  // it is a positive claim that the queue is refusing nothing. Asserted in BOTH directions.
  const spec = PRESEEDED_LABELLED_COUNTERS.find((s) => s.name === SIGNUP_QUEUE_REFUSED_COUNTER);
  expect(spec, `no labelled counter named '${SIGNUP_QUEUE_REFUSED_COUNTER}' is registered`).toBeDefined();
  expect(spec!.label).toBe('reason');
  expect([...spec!.values].sort()).toEqual([...SIGNUP_QUEUE_REFUSAL_REASONS].sort());
});

// ---------------------------------------------------------------------------------------------
// Part 2 — the same four cases through the LIVE route, which is where the SQL lives.
//
// The pure cases above cannot see the predicate that decides which pending rows are "anonymous",
// and that predicate is the load-bearing half: it is `keycloak_sub IS NULL AND matched_tenant_id
// IS NULL`, and dropping EITHER conjunct silently mis-classifies a whole population.
//
// ⛔ AND AN EARLIER VERSION OF THIS PARAGRAPH CLAIMED THESE CASES DROVE BOTH CONJUNCTS WHEN THEY
// DROVE ONE. No fixture in the file ever wrote a NON-NULL `keycloak_sub`, so deleting
// `keycloak_sub IS NULL` from the query left all 14 cases green — an adversarial audit measured it.
// A comment asserting coverage that does not exist is worse than no comment: the next reader trusts
// it and deletes the conjunct. Both are now driven, each by a case named for the population it
// protects, and each was confirmed to RED under its own mutant.
// ---------------------------------------------------------------------------------------------

const TENANT = '00000000-0000-4000-8000-00000005a001';
const NOBODY_ID = '00000000-0000-4000-8000-00000005a010';
/** The `keycloak_sub` of a pending row queued by `user-service.ts:recordSignupStrand` — a realm
 *  identity with no tenant. It is a bare `text` column with no FK, so no `users` row is needed. */
const STRAND_SUB = '00000000-0000-4000-8000-00000005a0aa';
// A domain that auto-routes (so a signup on it is MATCHED) and one that does not (so it is not).
const MATCHED_DOMAIN = 'matched-sqh.test';
const UNMAPPED_DOMAIN = 'unmapped-sqh.test';
const TEST_DOMAINS = [MATCHED_DOMAIN, UNMAPPED_DOMAIN];

const onboardedUser: User = {
  id: NOBODY_ID, email: `sa@${MATCHED_DOMAIN}`, name: 'SA', roles: ['super_admin'], tenantId: TENANT,
};
/** Authenticated, but NOT yet onboarded — no `tenantId`. An SSO first login is exactly this shape,
 *  and it is the caller the old code could not tell apart from an anonymous one. */
const authedNoTenant: User = {
  id: NOBODY_ID, email: `newcomer@${UNMAPPED_DOMAIN}`, name: 'New', roles: [],
};
/** The same caller, with a token that VERIFIES `email` — notify-self stores (and admits on) the sub
 *  only for an address the token proves; any other authenticated caller is queued as anonymous. */
const authedProving = (email: string): User => ({ ...authedNoTenant, email, emailVerified: true });

const router = new Router();
registerOnboardingRoutes(router);

let currentUser: User | null = null;
function as(u: User | null) {
  currentUser = u;
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
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

/** `{ pending, anonymousPending }` as the ROUTE counts them — same predicate, read independently. */
async function queueCounts(): Promise<{ pending: number; anonymousPending: number }> {
  const rows = (await db.execute(
    sql`SELECT COUNT(*)::int AS pending,
               COUNT(*) FILTER (WHERE keycloak_sub IS NULL AND matched_tenant_id IS NULL)::int AS anon
          FROM signup_approvals WHERE status = 'pending'`,
  )) as unknown as { pending: number; anon: number }[];
  return { pending: rows[0]?.pending ?? 0, anonymousPending: rows[0]?.anon ?? 0 };
}

/** The rendered value of one label value of the refusal counter, for delta assertions. */
function refusedTotal(reason: string): number {
  const m = new RegExp(
    String.raw`^commonpractice_${SIGNUP_QUEUE_REFUSED_COUNTER}\{reason="${reason}"\} (\d+)$`,
    'm',
  ).exec(renderMetrics());
  return m ? Number(m[1]) : Number.NaN; // NaN, not 0: an ABSENT series must not read as "none yet"
}

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: string }).error;
}

async function cleanup() {
  await db.delete(signupApprovals).where(sql`lower(email) LIKE '%-sqh.test'`);
  await db.delete(emailDomainTenants).where(inArray(emailDomainTenants.domain, TEST_DOMAINS));
  await db.delete(users).where(eq(users.id, NOBODY_ID));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
}

const ENV_KEYS = ['SIGNUP_QUEUE_MAX_PENDING', 'SIGNUP_QUEUE_MAX_ANON_PENDING'] as const;
function clearLimitEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

beforeEach(async () => {
  clearLimitEnv();
  __setAuthOverridesForTests({
    validateAuth: async () => {
      if (!currentUser) {
        const { UnauthorizedError } = await import('../src/types');
        throw new UnauthorizedError('no auth');
      }
      return currentUser;
    },
  });
  await cleanup();
  await db.insert(tenants).values({ id: TENANT, name: 'SQH', slug: 'sqh' }).onConflictDoNothing({ target: tenants.id });
  await db
    .insert(emailDomainTenants)
    .values({ domain: MATCHED_DOMAIN, tenant_id: TENANT, auto_assign: true })
    .onConflictDoNothing();
  as(null);
}, 30_000);

afterEach(() => {
  clearLimitEnv();
});

afterAll(async () => {
  __setAuthOverridesForTests(undefined);
  __setKeycloakAdminForTests(undefined);
  await cleanup();
}, 30_000);

test('route: UNDER both ceilings an anonymous signup is accepted (the control every refusal below needs)', async () => {
  const before = await queueCounts();
  process.env.SIGNUP_QUEUE_MAX_PENDING = String(before.pending + 10);
  process.env.SIGNUP_QUEUE_MAX_ANON_PENDING = String(before.anonymousPending + 5);

  const res = await call('POST', '/api/signup-approvals/notify-self', {
    email: `under-quota@${UNMAPPED_DOMAIN}`,
  });
  expect(res.status).toBe(204);
  const [row] = await db
    .select()
    .from(signupApprovals)
    .where(sql`lower(email) = ${`under-quota@${UNMAPPED_DOMAIN}`}`);
  expect(row?.status).toBe('pending');
  // Unmapped domain → no tenant → this row is itself part of the anonymous population.
  expect(row?.matched_tenant_id).toBeNull();
});

test('route: a MATCHED pending row does not consume the anonymous reserve', async () => {
  // ⛔ THE PREDICATE, TESTED WHERE IT LIVES. `matched_tenant_id IS NULL` is the conjunct that makes
  // the reserve a reserve; drop it and every row this route writes counts as anonymous (it writes
  // `keycloak_sub` NULL always), so a customer's own matched signups would eat the headroom held
  // for them. The set-up leaves exactly ONE anonymous slot, then fills a slot with a MATCHED row —
  // and the anonymous caller still gets in. Under the broken predicate this case is a 503.
  const before = await queueCounts();
  process.env.SIGNUP_QUEUE_MAX_PENDING = String(before.pending + 50);
  process.env.SIGNUP_QUEUE_MAX_ANON_PENDING = String(before.anonymousPending + 1);

  const matchedRes = await call('POST', '/api/signup-approvals/notify-self', {
    email: `corp-employee@${MATCHED_DOMAIN}`,
  });
  expect(matchedRes.status).toBe(204);
  const after = await queueCounts();
  expect(after.pending).toBe(before.pending + 1);
  expect(after.anonymousPending).toBe(before.anonymousPending); // did NOT rise

  const anonRes = await call('POST', '/api/signup-approvals/notify-self', {
    email: `still-welcome@${UNMAPPED_DOMAIN}`,
  });
  expect(anonRes.status).toBe(204);
});

test('route: a STRANDED SSO row (keycloak_sub set, no tenant) does not consume the anonymous reserve', async () => {
  // ⛔ THE OTHER CONJUNCT, AND IT IS LIVE IN PRODUCTION — this case exists because its absence let
  // `keycloak_sub IS NULL` be deleted with all 14 cases still green.
  // `user-service.ts:recordSignupStrand` inserts a pending row per stranded SSO user with
  // `keycloak_sub: user.id` and `matched_tenant_id` NULL. Count those as anonymous and every
  // stranded real human is a sprayer: the reserve fills with the very population it exists to
  // protect, and the abuse arm fires with zero abuse.
  //
  // The row is written DIRECTLY rather than through a route, because that is how the other writer
  // writes it — the fixture has to be the production shape, not a shape this route can produce.
  const before = await queueCounts();
  process.env.SIGNUP_QUEUE_MAX_PENDING = String(before.pending + 50);
  process.env.SIGNUP_QUEUE_MAX_ANON_PENDING = String(before.anonymousPending + 1); // ONE slot left

  await db
    .insert(signupApprovals)
    .values({ keycloak_sub: STRAND_SUB, email: `strand@${UNMAPPED_DOMAIN}`, status: 'pending' })
    .onConflictDoNothing();

  // ⚠️ THE 204 IS THE LOAD-BEARING ASSERTION, NOT THE COUNT BELOW IT. `queueCounts()` is this
  // file's OWN copy of the predicate, so it agrees with itself under a mutation of the route's
  // query and can prove nothing about it. Only the route's own answer can.
  const anonRes = await call('POST', '/api/signup-approvals/notify-self', {
    email: `prospect-after-strand@${UNMAPPED_DOMAIN}`,
  });
  expect(anonRes.status).toBe(204);

  const after = await queueCounts();
  expect(after.pending).toBe(before.pending + 2); // the strand row AND the prospect
  expect(after.anonymousPending).toBe(before.anonymousPending + 1); // only the prospect
});

test('route: an AUTHENTICATED signup is written WITH its sub, so admission and counting agree', async () => {
  // ⛔ THE INVARIANT THE WHOLE SPLIT RESTS ON: a caller admitted as IDENTIFIED must not then be
  // COUNTED as anonymous. The first cut of this change broke it — it captured a boolean, admitted
  // the caller, and wrote `keycloak_sub` NULL — and because `authFetch` means every SPA signup takes
  // this path, the reserve would have been filled by the SPA itself. Asserting the stored row is the
  // only way to see that; a 204 looks identical under both.
  const before = await queueCounts();
  process.env.SIGNUP_QUEUE_MAX_PENDING = String(before.pending + 50);
  process.env.SIGNUP_QUEUE_MAX_ANON_PENDING = String(before.anonymousPending + 1); // ONE slot left

  as(authedProving(`sso-strand@${UNMAPPED_DOMAIN}`));
  const res = await call('POST', '/api/signup-approvals/notify-self', {
    email: `sso-strand@${UNMAPPED_DOMAIN}`,
  });
  expect(res.status).toBe(204);
  const [row] = await db
    .select()
    .from(signupApprovals)
    .where(sql`lower(email) = ${`sso-strand@${UNMAPPED_DOMAIN}`}`);
  // The token's sub, on an UNMAPPED domain — so nothing but the sub can keep this row out of the
  // anonymous bucket, which is precisely why it has to be stored.
  expect(row?.keycloak_sub).toBe(NOBODY_ID);
  expect(row?.matched_tenant_id).toBeNull();

  // ⭐ THE CONSEQUENCE, WHICH IS THE PART A USER WOULD HAVE FELT. The single anonymous slot is still
  // free, so a genuine anonymous prospect gets in behind the SSO signup. Before the fix this 204 was
  // a 503: the SSO row had eaten the reserve.
  as(null);
  const prospect = await call('POST', '/api/signup-approvals/notify-self', {
    email: `genuine-prospect@${UNMAPPED_DOMAIN}`,
  });
  expect(prospect.status).toBe(204);

  // …and non-vacuity on the same state: the slot the prospect just took WAS the last one, so the
  // next anonymous caller is refused. Without this the 204 above is equally consistent with a
  // reserve that never refuses anything.
  const next = await call('POST', '/api/signup-approvals/notify-self', {
    email: `one-too-many@${UNMAPPED_DOMAIN}`,
  });
  expect(next.status).toBe(503);
  expect(await errorCode(next)).toBe('signup_queue_anonymous_full');
});

test('route: ANONYMOUS over the sub-quota is refused 503 signup_queue_anonymous_full', async () => {
  const before = await queueCounts();
  process.env.SIGNUP_QUEUE_MAX_PENDING = String(before.pending + 50); // total is NOT the binding one
  process.env.SIGNUP_QUEUE_MAX_ANON_PENDING = String(before.anonymousPending); // reserve exhausted

  const queueFullBefore = refusedTotal('queue_full');
  const anonBefore = refusedTotal('anonymous_quota');

  const res = await call('POST', '/api/signup-approvals/notify-self', {
    email: `sprayer@${UNMAPPED_DOMAIN}`,
  });
  expect(res.status).toBe(503);
  // ⛔ THE CODE, NOT JUST THE STATUS. Both refusals are 503; if this arm reported
  // `signup_queue_full` an operator would read an abuse burst as a full queue and go work a backlog
  // that does not exist, while matched signups were being served normally the whole time.
  expect(await errorCode(res)).toBe('signup_queue_anonymous_full');

  // Nothing was written — a refusal that still inserted would make the ceiling decorative.
  const rows = await db
    .select()
    .from(signupApprovals)
    .where(sql`lower(email) = ${`sprayer@${UNMAPPED_DOMAIN}`}`);
  expect(rows.length).toBe(0);

  // The metric moved on the right label value and ONLY that one.
  expect(refusedTotal('anonymous_quota')).toBe(anonBefore + 1);
  expect(refusedTotal('queue_full')).toBe(queueFullBefore);
});

test('route: over the anonymous sub-quota a MATCHED signup is still ACCEPTED', async () => {
  // ⛔ THIS IS THE LANE. Identical queue and identical ceilings to the case above — the reserve is
  // exhausted — and the difference is only that this address auto-routes to a tenant. Without this
  // assertion the change is indistinguishable from a tighter version of the cap it replaces, which
  // would make the lockout WORSE rather than fixing it.
  const before = await queueCounts();
  process.env.SIGNUP_QUEUE_MAX_PENDING = String(before.pending + 50);
  process.env.SIGNUP_QUEUE_MAX_ANON_PENDING = String(before.anonymousPending);

  const res = await call('POST', '/api/signup-approvals/notify-self', {
    email: `real-customer@${MATCHED_DOMAIN}`,
  });
  expect(res.status).toBe(204);
  const [row] = await db
    .select()
    .from(signupApprovals)
    .where(sql`lower(email) = ${`real-customer@${MATCHED_DOMAIN}`}`);
  expect(row?.matched_tenant_id).toBe(TENANT);
});

test('route: over the anonymous sub-quota an AUTHENTICATED signup with no tenant yet is still ACCEPTED', async () => {
  // The other half of "identified": a caller `validateAuth` accepted whose token carries no
  // `tenant_id` — an SSO first login, or a realm user the seat cap turned away. On an UNMAPPED
  // domain, so the match cannot be what admits them; the only thing that does is the token. This is
  // also the shape the SPA's own login bootstrap sends (`authFetch` → bearer), which is why the
  // anonymous refusal is unreachable from the product.
  const before = await queueCounts();
  process.env.SIGNUP_QUEUE_MAX_PENDING = String(before.pending + 50);
  process.env.SIGNUP_QUEUE_MAX_ANON_PENDING = String(before.anonymousPending);

  as(authedProving(`sso-first-login@${UNMAPPED_DOMAIN}`));
  const res = await call('POST', '/api/signup-approvals/notify-self', {
    email: `sso-first-login@${UNMAPPED_DOMAIN}`,
  });
  expect(res.status).toBe(204);
  const [row] = await db
    .select()
    .from(signupApprovals)
    .where(sql`lower(email) = ${`sso-first-login@${UNMAPPED_DOMAIN}`}`);
  expect(row?.matched_tenant_id).toBeNull(); // admitted by the TOKEN, not by a domain match

  // Negative control on the same state: strip the token and the identical request is refused. This
  // is what separates "the reserve works" from "the ceiling was never reached".
  as(null);
  const anon = await call('POST', '/api/signup-approvals/notify-self', {
    email: `no-token@${UNMAPPED_DOMAIN}`,
  });
  expect(anon.status).toBe(503);
  expect(await errorCode(anon)).toBe('signup_queue_anonymous_full');
});

test('route: over the TOTAL ceiling everyone is refused 503 signup_queue_full, as today', async () => {
  // ⚠️ ONE SEEDED ROW FIRST, AND IT IS NOT DECORATION. `signupQueueLimits` clamps `maxPending` to
  // ≥ 1 on purpose (a 0 would be a total signup outage from a typo), so on an EMPTY queue
  // `SIGNUP_QUEUE_MAX_PENDING = String(before.pending)` is "0" → clamped to 1 → nothing is refused
  // and this case passes vacuously in the other direction. It was written that way and failed
  // exactly there. The row is MATCHED so it lands outside the anonymous population, which keeps the
  // reserve provably free below and makes the total ceiling the only thing that can be refusing.
  await db
    .insert(signupApprovals)
    .values({ email: `seed-full@${MATCHED_DOMAIN}`, matched_tenant_id: TENANT })
    .onConflictDoNothing();
  const before = await queueCounts();
  expect(before.pending).toBeGreaterThan(0);
  process.env.SIGNUP_QUEUE_MAX_PENDING = String(before.pending); // table full
  process.env.SIGNUP_QUEUE_MAX_ANON_PENDING = String(before.anonymousPending + 50); // reserve free

  const anonBefore = refusedTotal('anonymous_quota');
  const queueFullBefore = refusedTotal('queue_full');

  as(null);
  const anon = await call('POST', '/api/signup-approvals/notify-self', {
    email: `full-anon@${UNMAPPED_DOMAIN}`,
  });
  expect(anon.status).toBe(503);
  expect(await errorCode(anon)).toBe('signup_queue_full');

  // ⛔ AND THE IDENTIFIED CALLER GETS THE SAME ANSWER. A full table is full for everybody; if the
  // reserve leaked past this ceiling, `signup_queue_full` would stop bounding the table at all.
  as(authedNoTenant);
  const matched = await call('POST', '/api/signup-approvals/notify-self', {
    email: `full-matched@${MATCHED_DOMAIN}`,
  });
  expect(matched.status).toBe(503);
  expect(await errorCode(matched)).toBe('signup_queue_full');

  expect(refusedTotal('queue_full')).toBe(queueFullBefore + 2);
  expect(refusedTotal('anonymous_quota')).toBe(anonBefore);
});

test('route: an ALREADY-ONBOARDED caller is still a 204 no-op, even with both ceilings at zero', async () => {
  // The short-circuit runs before any of this and must stay that way: a logged-in user's page load
  // must never depend on the state of the signup queue.
  process.env.SIGNUP_QUEUE_MAX_PENDING = '0';
  process.env.SIGNUP_QUEUE_MAX_ANON_PENDING = '0';
  // "Onboarded" is CP's own `users` row with a home tenant (CP-owned tenancy) — the token's
  // `tenantId` claim is ignored, so without this row the caller is NOT onboarded.
  await db
    .insert(users)
    .values({ id: NOBODY_ID, email: onboardedUser.email, name: 'SA', tenant_id: TENANT })
    .onConflictDoNothing({ target: users.id });
  as(onboardedUser);
  const res = await call('POST', '/api/signup-approvals/notify-self', {
    email: `already-in@${MATCHED_DOMAIN}`,
  });
  expect(res.status).toBe(204);
  const rows = await db
    .select()
    .from(signupApprovals)
    .where(sql`lower(email) = ${`already-in@${MATCHED_DOMAIN}`}`);
  expect(rows.length).toBe(0);
});
