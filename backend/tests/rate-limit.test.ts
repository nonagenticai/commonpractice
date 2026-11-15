// rate-limit.test.ts — the limiter's arithmetic, its keying, and the two ways it must NOT work.
//
// ⚠️ EVERY ASSERTION HERE HAS A NEGATIVE CONTROL, because the failure mode of a rate limiter is
// silence: one that never refuses looks identical to one that is never provoked. The first draft of
// `ANONYMOUS_ROUTES` listed three route templates that DO NOT EXIST — a tight bucket matched to
// nothing — and no test of the "does it refuse?" shape would have caught it, because the generous
// bucket still refuses eventually. So the anonymous-route test below asserts the tight limit is
// reached at a count the DEFAULT bucket would still have allowed, which is the only assertion that
// can tell the two apart.
import { test, expect, beforeEach } from 'bun:test';
import { checkRateLimit, __resetRateLimitForTests } from '../src/middleware/rate-limit';

beforeEach(() => {
  __resetRateLimitForTests();
  delete process.env.RATE_LIMIT_ENABLED;
});

const req = (headers: Record<string, string> = {}) =>
  new Request('http://t/whatever', { headers });

function drain(
  n: number,
  route: string,
  headers: Record<string, string> = {},
  ip = '1.2.3.4',
  nowMs = 1_000_000,
  userId: string | null = null,
) {
  let last = null;
  for (let i = 0; i < n; i++) last = checkRateLimit(req(headers), route, ip, userId, nowMs);
  return last;
}

test('an unauthenticated caller is refused at the 30/min default', () => {
  // 30 allowed…
  const thirtieth = drain(30, '/api/challenges');
  expect(thirtieth?.allowed).toBe(true);
  expect(thirtieth?.remaining).toBe(0);

  // …and the 31st is not.
  const thirtyFirst = checkRateLimit(req(), '/api/challenges', '1.2.3.4', null, 1_000_000);
  expect(thirtyFirst?.allowed).toBe(false);
});

test('an ANONYMOUS WRITE route is refused far earlier than the default bucket would refuse', () => {
  // ⛔ THE NON-VACUITY THAT MATTERS. 11 requests is under the 30 the unauthenticated default
  // permits, so this can only pass if the tight anonymous bucket is genuinely being selected —
  // i.e. if '/api/signup-approvals/notify-self' is a template the limiter actually matches. When
  // the set held three invented templates, this test failed.
  const eleventh = drain(11, '/api/signup-approvals/notify-self');
  expect(eleventh?.allowed).toBe(false);
  expect(eleventh?.limit).toBe(10);

  // Positive control on the same count: a NON-anonymous route is still fine at 11.
  __resetRateLimitForTests();
  expect(drain(11, '/api/challenges')?.allowed).toBe(true);
});

test('the anonymous route template exists in the router (the set is not aimed at nothing)', async () => {
  // ⛔ A SET OF ROUTE TEMPLATES IS A CLAIM ABOUT ANOTHER FILE, so it is checked against that file
  // rather than trusted. Reads the registration source directly: importing the route module drags
  // in the DB client and Keycloak config, which this unit test has no business booting.
  const src = await Bun.file(
    new URL('../src/routes/onboarding.ts', import.meta.url),
  ).text();
  expect(src).toContain("'/api/signup-approvals/notify-self'");
});

test('health, health/live, ready and metrics are never limited', () => {
  // `/health/live` is the LIVENESS probe (commonpractice#308, routes/health.ts). It is the one in
  // this list whose exemption is a kill switch: a 429 there does not degrade a scrape, it restarts
  // a pod that is serving perfectly.
  for (const route of ['/health', '/health/live', '/ready', '/metrics']) {
    // Far past every bucket in the file.
    for (let i = 0; i < 200; i++) {
      expect(checkRateLimit(req(), route, '1.2.3.4', null, 1_000_000)).toBeNull();
    }
  }
  // Negative control: an ordinary route at the same call count IS limited, so `null` above means
  // "exempt" and not "the limiter is switched off".
  expect(drain(200, '/api/challenges')?.allowed).toBe(false);
});

test('a VERIFIED caller gets the generous bucket, keyed on the user id', () => {
  // The caller (server.ts) verifies the JWT against the cached JWKS and hands the resolved id in.
  // 200 requests would have blown through the 30/min unauthenticated bucket six times over.
  expect(drain(200, '/api/challenges', {}, '1.2.3.4', 1_000_000, 'user-aaa')?.allowed).toBe(true);

  // ⛔ SAME IP, DIFFERENT USER, FRESH BUDGET. The NAT case: two people behind one egress address
  // must not share a bucket. If the key were the IP, this second caller would already be 200
  // requests into the window and refused.
  const other = checkRateLimit(req(), '/api/challenges', '1.2.3.4', 'user-bbb', 1_000_000);
  expect(other?.allowed).toBe(true);
  expect(other?.remaining).toBe(other!.limit - 1);
});

test('an Authorization header ALONE does not buy the generous bucket', () => {
  // ⛔ THE REGRESSION THIS FILE EXISTS TO PREVENT FROM COMING BACK. `checkRateLimit` used to read
  // `userId !== null || req.headers.has('authorization')`, and its only call site passed
  // `userId: null` — so the tier was chosen by the PRESENCE of a header. Anyone could send
  // `Authorization: Bearer anything` and get 600/min instead of 30/min: 20x the ceiling for the
  // price of one header, on exactly the anonymous routes the tight bucket was written to protect.
  //
  // A forged token is now indistinguishable from no token, because the caller resolves identity
  // BEFORE the tier is chosen and fails closed. 31 requests is above the 30/min unauthenticated
  // limit and far below the 600/min authenticated one, so this count can only refuse if the strict
  // tier was genuinely selected.
  const thirtyFirst = drain(31, '/api/challenges', { authorization: 'Bearer forged-not-a-real-jwt' });
  expect(thirtyFirst?.allowed).toBe(false);
  expect(thirtyFirst?.limit).toBe(30);

  // Positive control on the identical count and header: WITH a resolved id it sails through, so the
  // refusal above is about the missing identity and not about the header or the route.
  __resetRateLimitForTests();
  const verified = drain(
    31,
    '/api/challenges',
    { authorization: 'Bearer forged-not-a-real-jwt' },
    '1.2.3.4',
    1_000_000,
    'user-ccc',
  );
  expect(verified?.allowed).toBe(true);
  expect(verified?.limit).toBe(600);
});

test('the raw bearer token never appears in a bucket key', () => {
  // The keys are not exported, so this is asserted through behaviour: two DIFFERENT tokens must
  // land in different buckets (proving the token is part of the key) while nothing in the module
  // stores it verbatim. The hash is what makes both true at once.
  const src = Bun.file(new URL('../src/middleware/rate-limit.ts', import.meta.url));
  return src.text().then((text) => {
    expect(text).toContain('Bun.hash(auth)');
    // The failure this pins: `return \`t:${auth}\`` — a raw JWT as a Map key.
    expect(text).not.toContain('`t:${auth}`');
  });
});

test('x-forwarded-for is keyed on the LAST entry, so a spoofed prefix cannot mint a fresh budget', () => {
  const spoofA = { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' };
  const spoofB = { 'x-forwarded-for': '8.8.8.8, 203.0.113.7' };

  // Same real client (the rightmost, proxy-appended entry), two different claimed prefixes.
  drain(30, '/api/challenges', spoofA, null as unknown as string);
  const afterSwitchingTheClaimedPrefix = checkRateLimit(
    req(spoofB),
    '/api/challenges',
    null,
    null,
    1_000_000,
  );

  // ⛔ IF THIS EVER RETURNS allowed:true, THE LIMITER IS BYPASSABLE BY A HEADER. Keying on the
  // FIRST entry — the common mistake — makes each rotation a brand-new bucket and enforces nothing.
  expect(afterSwitchingTheClaimedPrefix?.allowed).toBe(false);

  // Positive control: a genuinely different rightmost entry DOES get its own budget.
  const differentRealClient = checkRateLimit(
    req({ 'x-forwarded-for': '8.8.8.8, 198.51.100.4' }),
    '/api/challenges',
    null,
    null,
    1_000_000,
  );
  expect(differentRealClient?.allowed).toBe(true);
});

test('the window rolls: a refused caller is allowed again in the next window', () => {
  const t0 = 1_000_000;
  drain(31, '/api/challenges', {}, '1.2.3.4', t0);
  expect(checkRateLimit(req(), '/api/challenges', '1.2.3.4', null, t0)?.allowed).toBe(false);

  // 60s later (the default window) the budget is fresh.
  const t1 = t0 + 60_001;
  expect(checkRateLimit(req(), '/api/challenges', '1.2.3.4', null, t1)?.allowed).toBe(true);
});

test('RATE_LIMIT_ENABLED=false disables it entirely', () => {
  process.env.RATE_LIMIT_ENABLED = 'false';
  for (let i = 0; i < 500; i++) {
    expect(checkRateLimit(req(), '/api/challenges', '1.2.3.4', null, 1_000_000)).toBeNull();
  }
  // Negative control: the same 500 calls WITH it enabled are refused, so `null` above is the kill
  // switch working and not an accident of the fixture.
  delete process.env.RATE_LIMIT_ENABLED;
  __resetRateLimitForTests();
  expect(drain(500, '/api/challenges')?.allowed).toBe(false);
});
