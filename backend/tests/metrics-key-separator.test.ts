import { describe, expect, test } from 'bun:test';

import { recordHttp, renderMetrics } from '../src/host/metrics';

/**
 * The http series key is `${method}\0${route}\0${statusClass}` (src/host/metrics.ts),
 * split back apart on the same NUL when rendering.
 *
 * The separator choice is load-bearing, not cosmetic: a route template is
 * attacker-influenced only in shape, but it legitimately contains `:`, `/`, `-`
 * and `.` (e.g. `/api/blocks/:slug`). NUL is the one byte that cannot appear in
 * a route, so it is the only separator under which distinct (method, route,
 * statusClass) triples are guaranteed not to collide.
 *
 * Changing the separator — or dropping it — silently merges or mis-splits series,
 * which corrupts every Prometheus label derived from it. These tests pin that
 * contract by value, not by shape.
 *
 * ⚠️ The bytes were raw NULs in source until 2026-08-03, which made the whole
 * file invisible to `grep` (it reports nothing and exits 1 on a file containing
 * a NUL). They are now written as explicit `\0` escapes — byte-identical at
 * runtime, greppable in source. Do not "clean up" the escapes.
 */
describe('http metric key separator', () => {
  test('a route containing separator-like characters round-trips intact', () => {
    // `:` and `|` are exactly what a weaker separator would have been, and both
    // occur naturally in route templates.
    recordHttp('GET', '/api/blocks/:slug', 200, 0.01);

    const out = renderMetrics();

    expect(out).toContain('method="GET",route="/api/blocks/:slug",status="2xx"');
  });

  test('distinct triples do not collide into one series', () => {
    // Under a naive `${method}${route}${statusClass}` concatenation these two
    // would produce the same key: "GET" + "/a/b" vs "GET/a" + "/b".
    recordHttp('GET', '/collide/a/b', 200, 0.01);
    recordHttp('GET', '/collide/a', 200, 0.01);

    const out = renderMetrics();

    expect(out).toContain('route="/collide/a/b"');
    expect(out).toContain('route="/collide/a"');
  });

  test('the same triple accumulates into a single series', () => {
    const route = '/api/accumulate';
    recordHttp('POST', route, 201, 0.01);
    recordHttp('POST', route, 201, 0.02);

    const out = renderMetrics();
    const totals = out
      .split('\n')
      .filter(
        (l) =>
          l.includes('_http_requests_total{') &&
          l.includes(`route="${route}"`) &&
          l.includes('method="POST"'),
      );

    // Exactly one series line, carrying both requests — not two series of one.
    expect(totals).toHaveLength(1);
    expect(totals[0]?.trim().endsWith(' 2')).toBe(true);
  });

  test('status classes are separated, not merged', () => {
    const route = '/api/status-split';
    recordHttp('GET', route, 200, 0.01);
    recordHttp('GET', route, 500, 0.01);

    const out = renderMetrics();

    expect(out).toContain(`route="${route}",status="2xx"`);
    expect(out).toContain(`route="${route}",status="5xx"`);
  });

  test('source carries no raw NUL bytes (keeps the file greppable)', async () => {
    const src = await Bun.file(
      new URL('../src/host/metrics.ts', import.meta.url).pathname,
    ).arrayBuffer();

    expect(new Uint8Array(src).includes(0)).toBe(false);
  });
});
