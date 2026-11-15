// src/routes/metrics.ts — GET /metrics (Prometheus text exposition).
//
// Auth/license-exempt: the handler calls no auth guard at all, so neither Gate 1 nor the
// guard-derived Gate 2 ever runs (see middleware/license-gate.ts). Scraped by the cluster
// Prometheus via the Service scrape annotations.
//
// WHY THIS IS A FILE AND NOT SIX LINES INLINE IN server.ts, WHERE IT LIVED UNTIL NOW. server.ts is
// the entrypoint: importing it calls `Bun.serve`, runs migrations and arms every scheduler, so no
// test can reach a route defined there. That was survivable while the handler was
// `new Response(renderMetrics())` — a pure function tests could call directly. It stopped being
// survivable the moment the body depended on a DB read that has to keep working when the DB does
// NOT: "a failed freshness read still returns 200 with the rest of the body intact" is a claim
// about the HANDLER, and inline in server.ts it would have been untestable and therefore unproven.
import { renderMetrics } from '../host/metrics';
import { readOnboardingCensus } from '../host/onboarding-integrity';
import { getSchedulerFreshness } from '../host/scheduler-freshness';
import type { Router } from '../utils/router';

export function registerMetricsRoutes(router: Router): void {
  router.add('GET', '/metrics', async () => {
    // Cached (TTL, see scheduler-freshness.ts) and non-throwing BY CONTRACT: `undefined` on a
    // failed/never-yet-successful read, which renders the gauge away and leaves every other series
    // untouched. There is deliberately no try/catch here — a `catch` would imply this call can
    // reject, and hide it if the contract ever regressed. The test suite asserts the contract at
    // its source instead.
    const freshness = await getSchedulerFreshness();
    // Same contract, same reason, same absence of a try/catch: `readOnboardingCensus` is TTL-cached
    // and non-throwing, resolving `undefined` on a failed or never-yet-successful read. Two reads
    // are sequential rather than `Promise.all`-ed on purpose — both are cache hits in the steady
    // state, and serialising them keeps a scrape from opening two DB connections at once on the
    // one tick per minute where both caches happen to expire together.
    const onboarding = await readOnboardingCensus();
    return new Response(renderMetrics(freshness, onboarding), {
      status: 200,
      headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
    });
  });
}
