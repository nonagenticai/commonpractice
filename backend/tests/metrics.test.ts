// tests/metrics.test.ts — the hand-rolled Prometheus exposition (host/metrics.ts).
// Pure in-memory module (no DB); asserts the text format + that counters/histograms accumulate.
import { test, expect } from 'bun:test';
import { recordHttp, incCounter, renderMetrics } from '../src/host/metrics';

// ⛔ A ROUTE LABEL NO OTHER FILE CAN HIT. The registry is process-global and bun runs every test
// file in one process, in an order that varies between runs. Any earlier file that drives a real
// GET /api/blocks/:slug through the router bumps that series, so an exact `_count … 2` on it was
// order-dependent (red on main 2026-10-07, green on a rerun of the same sha).
const R = '/__metrics-test/blocks/:slug';
const R_POST = '/__metrics-test/blocks';

test('renders histogram + request counter for a recorded request', () => {
  recordHttp('GET', R, 200, 0.03);
  recordHttp('GET', R, 200, 0.4);
  recordHttp('POST', R_POST, 500, 1.2);

  const out = renderMetrics();

  // Histogram type + cumulative buckets for the 2xx GET series (2 requests).
  expect(out).toContain('# TYPE commonpractice_http_request_duration_seconds histogram');
  expect(out).toContain(
    `commonpractice_http_request_duration_seconds_count{method="GET",route="${R}",status="2xx"} 2`,
  );
  // 0.03 + 0.4 fall under le=0.5 → cumulative 2; le=0.05 → only the 0.03 one → 1.
  expect(out).toContain(
    `commonpractice_http_request_duration_seconds_bucket{method="GET",route="${R}",status="2xx",le="0.5"} 2`,
  );
  expect(out).toContain(
    `commonpractice_http_request_duration_seconds_bucket{method="GET",route="${R}",status="2xx",le="0.05"} 1`,
  );

  // Request counter, with the 5xx POST as its own series (error-rate signal).
  expect(out).toContain(
    `commonpractice_http_requests_total{method="POST",route="${R_POST}",status="5xx"} 1`,
  );
});

test('generic counters render and accumulate', () => {
  incCounter('license_introspect_failures_total');
  incCounter('license_introspect_failures_total');
  const out = renderMetrics();
  expect(out).toContain('# TYPE commonpractice_license_introspect_failures_total counter');
  expect(out).toMatch(/commonpractice_license_introspect_failures_total \d+/);
});
