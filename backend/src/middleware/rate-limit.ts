// rate-limit.ts — the first HTTP rate limiting this service has ever had.
//
// ⛔ MEASURED ZERO BEFORE THIS. No limiter dependency, no middleware, no `limit_req` at any
// ingress, and no 429 emitted anywhere in `backend/src`. `routes/onboarding.ts` states the
// consequence in its own source: "This route is anonymous by design, and there is no rate limiter
// in front of it." An unauthenticated POST that writes rows and can send mail, with no ceiling, is
// the highest-consequence gap on the production-readiness list — it costs money and availability
// before it costs anything else.
//
// ⚠️ PER-POD, AND THAT IS A DELIBERATE CHOICE, NOT AN OVERSIGHT. The counters live in this
// process's memory, so with N replicas the effective fleet ceiling is N x the configured limit
// (today N=2, HPA max 4). The alternative — a shared counter in billing-redis, which the
// NetworkPolicy already permits — buys exactness at the cost of putting a network round trip and a
// new hard dependency in front of EVERY request, including /health. A limiter that fails closed
// when redis blips would convert a cache outage into a total outage; a limiter that fails open
// under load is not a limiter. In-process is the shape that cannot make the service less
// available than it already is, and 2-4x a deliberately conservative number is still a ceiling
// where there was none. If a precise global limit is ever genuinely needed, it belongs at the
// ingress (Envoy `local_ratelimit`), not here.
//
// ⚠️ FIXED WINDOW, NOT A TOKEN BUCKET. A burst of `limit` requests at the end of one window plus
// `limit` at the start of the next allows 2x `limit` across a window boundary. That is the known
// and accepted imprecision of a fixed window; it is bounded, cheap, and needs one integer per key
// rather than a timestamp array. The numbers below are set with that 2x in mind.
import { HttpError } from '../utils/http';
import { incCounter } from '../host/metrics';
import { log } from '../host/logger';

export interface RateLimitRule {
  /** Requests permitted per window, per key. */
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * ⛔ ANONYMOUS WRITE ROUTES GET THEIR OWN, MUCH TIGHTER BUCKET.
 *
 * ⚠️ THIS LIST IS AN OPTIMISATION, NOT THE SAFETY PROPERTY — and that distinction is deliberate,
 * because the first draft of this file listed three plausible-looking templates
 * (`/api/onboarding/signup`, `.../request-access`, `.../verify`) and ALL THREE WERE INVENTED. None
 * exists. A limiter whose tight bucket matches no real route enforces nothing while looking
 * thorough, and nothing would have failed to tell me. The safety property is therefore carried by
 * the UNAUTHENTICATED DEFAULT below, which is tight enough to stand alone: a route missing from
 * this list is still limited, just less specifically. Getting this list wrong degrades precision,
 * never protection.
 *
 * The one real entry is verified against `registerOnboardingRoutes` (routes/onboarding.ts:615) and
 * against the handler itself (`notifySelf`, :100), which calls `validateAuth` inside a try/catch
 * precisely so an anonymous caller falls through and records intent.
 */
const ANONYMOUS_ROUTES: ReadonlySet<string> = new Set([
  '/api/signup-approvals/notify-self',
]);

/**
 * Never rate limited. `/health`, `/health/live` and `/ready` are read by the kubelet — limiting them
 * would let a traffic spike cause the probe to fail and the pod to be killed, converting "busy" into
 * "down", which is precisely backwards. `/metrics` is read by Prometheus on a fixed interval.
 *
 * ⛔ `/health/live` IS EXEMPT FROM THE MOMENT IT EXISTS, BEFORE THE MANIFEST POINTS AT IT
 * (commonpractice#308). It arrives with no `Authorization` header, so without this entry it lands in
 * the 30/min UNAUTHENTICATED bucket below — and that bucket is keyed by source IP, which for
 * everything arriving through the ingress is one address, not one per caller. A burst of anonymous
 * traffic would therefore 429 the LIVENESS probe and kill a pod that is serving perfectly: exactly
 * the failure this endpoint was added to remove, reintroduced one layer earlier. This entry has to
 * land in the same change as the route, not in the gitops repoint that follows it.
 */
const EXEMPT_ROUTES: ReadonlySet<string> = new Set([
  '/health',
  '/health/live',
  '/ready',
  '/metrics',
]);

function ruleFor(route: string, authenticated: boolean): RateLimitRule | null {
  if (EXEMPT_ROUTES.has(route)) return null;
  if (ANONYMOUS_ROUTES.has(route)) {
    return {
      limit: int(process.env.RATE_LIMIT_ANON_MAX, 10),
      windowMs: int(process.env.RATE_LIMIT_ANON_WINDOW_MS, 60_000),
    };
  }
  // ⛔ THE ACTUAL SAFETY NET. Every request arriving with no `Authorization` header lands here,
  // including any anonymous route missing from the set above. 30/min/IP is well above what a human
  // browsing the SPA unauthenticated generates (the login redirect is a handful of requests) and
  // far below what an abuse loop needs. Keep it tight: this is the number that protects the routes
  // I did not know about.
  if (!authenticated) {
    return {
      limit: int(process.env.RATE_LIMIT_UNAUTH_MAX, 30),
      windowMs: int(process.env.RATE_LIMIT_UNAUTH_WINDOW_MS, 60_000),
    };
  }
  return {
    limit: int(process.env.RATE_LIMIT_MAX, 600),
    windowMs: int(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  };
}

function int(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

interface Window {
  count: number;
  resetAtMs: number;
}

const windows = new Map<string, Window>();

/**
 * ⛔ THE MAP MUST BE SWEPT OR IT IS A MEMORY LEAK WITH AN ATTACKER-CONTROLLED KEY. Every distinct
 * client IP mints an entry; without eviction, a spray across many source addresses grows this map
 * without bound inside a 1Gi container — i.e. the limiter itself becomes the denial of service.
 * Swept lazily on write rather than on a timer: a timer would keep the event loop alive and has to
 * be torn down in tests, and there is no work to do when no requests are arriving.
 */
let lastSweepMs = 0;
const SWEEP_INTERVAL_MS = 60_000;

function sweep(nowMs: number): void {
  if (nowMs - lastSweepMs < SWEEP_INTERVAL_MS) return;
  lastSweepMs = nowMs;
  for (const [key, w] of windows) {
    if (w.resetAtMs <= nowMs) windows.delete(key);
  }
}

/**
 * The client identity to count against.
 *
 * ⛔ THE **LAST** `x-forwarded-for` ENTRY, NOT THE FIRST. XFF is a caller-supplied header that a
 * proxy APPENDS to. The leftmost entry is whatever the client claimed, so keying on it lets an
 * attacker rotate a fake address per request and evade the limit entirely — the limiter would look
 * like it worked while enforcing nothing. The rightmost entry is the address the nearest trusted
 * proxy (istio-ingressgateway) actually observed, which the client cannot forge.
 */
function clientKey(req: Request, directIp: string | null, userId: string | null): string {
  if (userId) return `u:${userId}`;

  // ⚠️ PREFER THE CREDENTIAL OVER THE ADDRESS FOR AUTHENTICATED CALLERS. The limiter runs BEFORE
  // the handler, so the resolved user id does not exist yet — but the bearer token does, and it is
  // stable per session. Keying on it stops a NAT'd office or a shared egress IP from putting every
  // one of its users in a single bucket, which is the classic way a limiter starts throttling
  // exactly the paying customers it was meant to protect.
  // The token is HASHED, never used as a key directly: map keys show up in heap dumps and in any
  // future debug dump of this map, and a raw JWT there is a credential leak.
  const auth = req.headers.get('authorization');
  if (auth) return `t:${Bun.hash(auth).toString(36)}`;

  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return `ip:${parts[parts.length - 1]}`;
  }
  return `ip:${directIp ?? 'unknown'}`;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
}

/**
 * Count this request and say whether it may proceed. Pure bookkeeping — it does NOT throw, so the
 * caller decides how a refusal is rendered (and so the tests can assert the arithmetic without
 * catching).
 */
export function checkRateLimit(
  req: Request,
  route: string,
  directIp: string | null,
  userId: string | null,
  nowMs: number = Date.now(),
): RateLimitDecision | null {
  if (process.env.RATE_LIMIT_ENABLED === 'false') return null;

  // ⛔ `userId` ALONE. An `Authorization` HEADER IS NOT EVIDENCE OF ANYTHING.
  // This used to read `userId !== null || req.headers.has('authorization')`, and the sole call site
  // (server.ts) passed `userId: null` — so in practice the tier was chosen by the mere PRESENCE of
  // a header. `Authorization: Bearer anything` bought the 600/min bucket instead of the 30/min one
  // three lines below, which the comment there calls "the number that protects the routes I did not
  // know about". An attacker adding one header got 20x the ceiling; the routes that most needed the
  // tight tier — an anonymous one missing from ANONYMOUS_ROUTES — were exactly the ones it left
  // unprotected. The caller now resolves the identity first (crypto-only token verification against
  // the cached JWKS, no database round trip), so a forged or absent token lands in the strict tier.
  const authenticated = userId !== null;
  const rule = ruleFor(route, authenticated);
  if (!rule) return null;

  sweep(nowMs);

  const key = `${route}|${clientKey(req, directIp, userId)}`;
  const existing = windows.get(key);

  if (!existing || existing.resetAtMs <= nowMs) {
    const w = { count: 1, resetAtMs: nowMs + rule.windowMs };
    windows.set(key, w);
    return { allowed: true, limit: rule.limit, remaining: rule.limit - 1, resetAtMs: w.resetAtMs };
  }

  existing.count += 1;
  const remaining = Math.max(0, rule.limit - existing.count);
  return {
    allowed: existing.count <= rule.limit,
    limit: rule.limit,
    remaining,
    resetAtMs: existing.resetAtMs,
  };
}

/**
 * The refusal. 429 with `Retry-After` in seconds, which is the one header a well-behaved client
 * actually acts on.
 */
export function rateLimitError(decision: RateLimitDecision, nowMs: number = Date.now()): HttpError {
  const retryAfterSec = Math.max(1, Math.ceil((decision.resetAtMs - nowMs) / 1000));
  incCounter('rate_limit_rejected_total');
  log.warn('rate_limited', { limit: decision.limit, retryAfterSec });
  return new HttpError(429, 'rate_limited', 'Too many requests. Please wait and try again.', {
    retryAfterSec,
  });
}

/** Test-only: the window map is process-global, so a test that asserts counts must be able to reset it. */
export function __resetRateLimitForTests(): void {
  windows.clear();
  lastSweepMs = 0;
}
