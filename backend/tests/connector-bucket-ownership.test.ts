// tests/connector-bucket-ownership.test.ts — the storage bucket is a TENANT BOUNDARY.
//
// ⛔ It used to be enforced only inside `autoRegister`, which requires `eventSource === 'webhook'`
// while `eventSource` DEFAULTS to 'none'. So every storage connector created without explicitly
// asking for webhooks took `config.bucket` VERBATIM from client input with no ownership check: a
// tenant_admin in tenant A could simply TYPE tenant B's bucket name and `refreshConnector` (which
// runs synchronously on create) materialised B's object into A's own dataset rows.
//
// No traversal and no encoding trick — the `..` fix in #170 addressed a real but DIFFERENT bug and
// left this front door open.
//
// PROVEN against the live cluster, which is why this is a boundary and not a nicety:
// `storage_service` does not authorise per-tenant on the in-cluster path, and an UNAUTHENTICATED
// GET for a real namespaced object returned 200 with content. CP is the sole enforcement point.
import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { __bucketOwnershipForTests as guard } from '../src/routes/connectors';
import { HttpError } from '../src/utils/http';

const TENANT_A = '00000000-0000-4000-8000-00000000aaaa';
const TENANT_B = '00000000-0000-4000-8000-00000000bbbb';
const tok = (t: string) => createHash('sha256').update(t).digest('hex').slice(0, 12);
const LEGACY = ['cp-datasets'];

test("a FOREIGN tenant's namespaced bucket is refused — the actual live leak", () => {
  const bucketOfB = `cp-${tok(TENANT_B)}-datasets`;
  expect(() => guard(TENANT_A, bucketOfB, LEGACY)).toThrow(HttpError);
  try {
    guard(TENANT_A, bucketOfB, LEGACY);
  } catch (e) {
    expect((e as HttpError).status).toBe(403);
    expect((e as HttpError).code).toBe('foreign_bucket');
  }
});

test("a tenant's OWN namespaced bucket is allowed", () => {
  expect(() => guard(TENANT_A, `cp-${tok(TENANT_A)}-datasets`, LEGACY)).not.toThrow();
});

test('case and whitespace do not smuggle a foreign bucket past the check', () => {
  const b = `  CP-${tok(TENANT_B).toUpperCase()}-DATASETS  `;
  expect(() => guard(TENANT_A, b, LEGACY)).toThrow(HttpError);
});

test('legacy shared buckets stay grandfathered', () => {
  expect(() => guard(TENANT_A, 'cp-datasets', LEGACY)).not.toThrow();
});

test('a non-namespaced bucket is not rejected here — re-keying owns that case', () => {
  // `deriveTenantBucket` re-keys these under the caller's own token when isolation is on; this
  // guard's job is only to refuse a bucket explicitly stamped for SOMEONE ELSE.
  expect(() => guard(TENANT_A, 'my-plain-bucket', LEGACY)).not.toThrow();
});
