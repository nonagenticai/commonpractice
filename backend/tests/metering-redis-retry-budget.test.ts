// tests/metering-redis-retry-budget.test.ts — the cost-event Redis client must
// survive losing its transport, not give up after ten tries.
//
// ── WHY ──────────────────────────────────────────────────────────────────
// `RedisClient` DOES auto-reconnect (`autoReconnect` defaults true). What it
// does not do is keep trying: `maxRetries` defaults to **10**, and a transport
// outage longer than that budget exhausts it — after which the client is dead
// for the life of the process.
//
// fr#947 (2026-09-04) is the proof it happens: an Istio ambient ztunnel pod was
// recreated under a running pod, and 39s later BOTH of that service's Redis
// clients — two disjoint clusters — died in the same second and never came
// back. It served 503 for ~1h45m until a human restarted it. ztunnel rolls are
// routine (node reboots, Istio upgrades, DaemonSet changes).
//
// MEASURED there — redis in docker, identical 45s outage, options the only
// variable:
//
//   defaults   connects=0  ping ok=13   err=107  finalConnected=false
//   hardened   connects=1  ping ok=120  err=0    finalConnected=true
//
// ⚠️ CP fails more QUIETLY than fr did. This module swallows every Redis error
// by design and is default-off, so an exhausted client does not announce itself
// with 503s — CP's spend silently stops appearing in billing's fleet rollup
// while the local `usage_events` ledger stays correct. That asymmetry is what
// makes it easy to miss, and why it is worth pinning.
//
// ⚠️ A SOURCE pin, deliberately. The client is memoized behind `defaultSender`,
// and every other test in this suite injects a fake sender via
// `__setMeteringOverridesForTests` — so no test ever reaches the real
// constructor, and a runtime assertion here would need a live Redis. Pinning
// the construction site still fails if someone drops the options.

import { test, expect, describe } from 'bun:test';

const SOURCE_URL = new URL('../src/host/metering-emit.ts', import.meta.url);

describe('the cost-event Redis client keeps retrying', () => {
  test('the constructor is given an options object, not just a URL', async () => {
    const src = await Bun.file(SOURCE_URL).text();

    const args = src.match(/new RedisClient\(([^)]*)\)/)?.[1];
    expect(args).toBeDefined();
    // Two arguments: the URL AND the options. A one-arg construction is the
    // defect — it silently accepts Bun's maxRetries default of 10.
    expect(args).toContain(',');
    expect(args).toContain('REDIS_CONNECTION_OPTIONS');
  });

  test('the retry budget is not a handful', async () => {
    const src = await Bun.file(SOURCE_URL).text();

    const digits = src.match(/maxRetries:\s*([0-9_]+)/)?.[1];
    expect(digits).toBeDefined();
    const budget = Number((digits ?? '0').replace(/_/g, ''));
    // The exact number does not matter; that it outlasts a mesh roll does.
    // Bun's default is 10.
    expect(budget).toBeGreaterThan(1_000_000);
  });

  test('the URL is still the first argument', async () => {
    // Negative control. "Options but no URL" would silently point the client at
    // Bun's localhost default and emit nothing, while still passing the checks
    // above — a green test on a broken emitter.
    const src = await Bun.file(SOURCE_URL).text();

    const args = src.match(/new RedisClient\(([^)]*)\)/)?.[1];
    expect(args).toBeDefined();
    const firstArg = (args ?? '').split(',')[0] ?? '';
    expect(firstArg.trim()).toContain('config.metering.redisUrl');
  });
});
