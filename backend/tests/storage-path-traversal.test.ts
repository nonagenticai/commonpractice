// tests/storage-path-traversal.test.ts — the bucket boundary is a SECURITY boundary.
//
// A storage connector's `bucket`/`key` are concatenated into a storage-service URL. The builder
// ran each segment through `encodeURIComponent`, which looks like escaping and is not:
// `encodeURIComponent` percent-encodes `/` but leaves `.` ALONE, so a `..` segment survives it
// intact and the URL parser normalises it away BEFORE the request is ever sent —
//
//   built:  /api/files/cp-mine/../cp-victim-tenant/secret.csv
//   sent:   /api/files/cp-victim-tenant/secret.csv
//
// — which defeated per-tenant bucket isolation outright: any tenant_admin could read another
// tenant's objects into their own dataset, and with `bucket: '..'` reach any path on the storage
// host. The egress allowlist cannot help: it matches host+port only, never path, and that host is
// legitimately allowlisted.
//
// Pure/DB-free on purpose so it always runs, whatever the local Postgres is doing.
import { test, expect } from 'bun:test';
import { assertNoTraversal, validateConnectorConfig } from '../src/datasets/connectors';
import { HttpError } from '../src/utils/http';

const BASE = { baseUrl: 'http://storage-api.storage.svc.cluster.local:8080', format: 'csv' };

/** The exact primitive the exploit relied on — kept as an executable statement of WHY, so nobody
 *  "simplifies" the guard back to encodeURIComponent. */
test('encodeURIComponent does NOT stop a `..` segment — the premise of the whole guard', () => {
  const key = '../cp-victim-tenant/secret.csv';
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  expect(encoded).toBe(key); // unchanged: dots are not encoded
  const url = `http://h/api/files/${encodeURIComponent('cp-mine')}/${encoded}`;
  expect(new URL(url).pathname).toBe('/api/files/cp-victim-tenant/secret.csv'); // bucket escaped
});

test('a traversing key is refused at config validation, so it can never be persisted', () => {
  expect(() =>
    validateConnectorConfig('storage', { ...BASE, bucket: 'cp-mine', key: '../cp-victim/secret.csv' }),
  ).toThrow(HttpError);
  try {
    validateConnectorConfig('storage', { ...BASE, bucket: 'cp-mine', key: '../cp-victim/secret.csv' });
  } catch (e) {
    expect((e as HttpError).status).toBe(400);
    expect((e as HttpError).code).toBe('bad_config');
    // `bad_config` carries eight different sentences, so the code alone cannot be localized.
    // `reason` + `field` are what let a catalog rebuild this one in any language.
    expect((e as HttpError).details).toMatchObject({ reason: 'dot_segment', field: 'key' });
  }
});

test('a traversing BUCKET is refused too — it reached any path on the storage host', () => {
  expect(() => validateConnectorConfig('storage', { ...BASE, bucket: '..', key: 'admin/secrets' })).toThrow(
    HttpError,
  );
});

test('encoded and double-encoded traversal are refused (%2e%2e and %252e%252e)', () => {
  for (const key of ['%2e%2e/cp-victim/x.csv', '%252e%252e/cp-victim/x.csv']) {
    expect(() => validateConnectorConfig('storage', { ...BASE, bucket: 'cp-mine', key })).toThrow(HttpError);
  }
});

test('backslash, absolute paths and a bare `.` segment are refused', () => {
  expect(() => assertNoTraversal('a\\..\\b', 'key')).toThrow(HttpError);
  expect(() => assertNoTraversal('/etc/passwd', 'key')).toThrow(HttpError);
  expect(() => assertNoTraversal('a/./b', 'key')).toThrow(HttpError);
});

/**
 * Four refusals, ONE wire `code` — which is exactly why the sentence cannot be the carrier. A
 * Dutch tenant gets `bad_config` for all four and the English prose for whichever fired; only a
 * distinct `details.reason` per branch lets a catalog say four different things. Asserting they
 * are DISTINCT (not just present) is what makes this fail if the branches ever share a value.
 */
test('each bad_config branch carries its own `reason` + the interpolated `field`', () => {
  const reasonOf = (value: string, field: string): unknown => {
    try {
      assertNoTraversal(value, field);
    } catch (e) {
      expect((e as HttpError).code).toBe('bad_config');
      expect((e as HttpError).details).toMatchObject({ field });
      return (e as HttpError).details?.reason;
    }
    throw new Error(`assertNoTraversal(${value}) did not throw`);
  };
  expect(reasonOf('%zz/x.csv', 'key')).toBe('percent_escape');
  expect(reasonOf('a\\..\\b', 'key')).toBe('backslash');
  expect(reasonOf('a/./b', 'bucket')).toBe('dot_segment');
  expect(reasonOf('/etc/passwd', 'key')).toBe('absolute');
  // The required-field branch is a fifth sentence behind the same code.
  expect(() => validateConnectorConfig('storage', { ...BASE, bucket: 'cp-mine' })).toThrow(HttpError);
  try {
    validateConnectorConfig('storage', { ...BASE, bucket: 'cp-mine' });
  } catch (e) {
    expect((e as HttpError).details).toMatchObject({ reason: 'required', field: 'key' });
  }
});

test('ORDINARY keys and buckets still work — the guard must not break real connectors', () => {
  const cfg = validateConnectorConfig('storage', {
    ...BASE,
    bucket: 'cp-abc123-claims',
    key: 'exports/2026/q3/claims.csv',
  });
  expect(cfg).toMatchObject({ kind: 'storage', bucket: 'cp-abc123-claims', key: 'exports/2026/q3/claims.csv' });
  // Dots INSIDE a segment are legitimate (a file extension, a dotted folder) and must be allowed.
  expect(() => assertNoTraversal('a.b/c..d/e.csv', 'key')).not.toThrow();
});
