// tests/byo-posture.test.ts — the posture cache's semantics for an UNKNOWN posture (no DB).
import { test, expect, afterEach } from 'bun:test';
import { config } from '../src/config';
import { tenantByoMode, __setByoPostureForTests } from '../src/services/byo-posture';

const TENANT = '0e5d0000-0000-4000-8000-0000000b0001';
const cfg = config.license as { issuanceEnabled: boolean };
const ISSUANCE = cfg.issuanceEnabled;

afterEach(() => {
  cfg.issuanceEnabled = ISSUANCE;
  __setByoPostureForTests(undefined);
});

test('issuance OFF → not enforced (null), and the licences service is never asked', async () => {
  cfg.issuanceEnabled = false;
  let asked = 0;
  __setByoPostureForTests({ resolver: async () => (asked++, 'byo_required') });
  expect(await tenantByoMode(TENANT)).toBeNull();
  expect(asked).toBe(0);
});

test('a fresh value is cached for the TTL, then re-read', async () => {
  cfg.issuanceEnabled = true;
  let t = 0;
  let asked = 0;
  __setByoPostureForTests({ resolver: async () => (asked++, 'local_allowed'), now: () => t });
  await tenantByoMode(TENANT);
  t = 59_000;
  await tenantByoMode(TENANT);
  expect(asked).toBe(1);
  t = 61_000;
  await tenantByoMode(TENANT);
  expect(asked).toBe(2);
});

test('a FAILED re-read keeps the LAST KNOWN posture — stale beats fabricated', async () => {
  cfg.issuanceEnabled = true;
  let t = 0;
  let fail = false;
  __setByoPostureForTests({
    resolver: async () => {
      if (fail) throw new Error('licenses down');
      return 'local_allowed';
    },
    now: () => t,
  });
  expect(await tenantByoMode(TENANT)).toBe('local_allowed');
  fail = true;
  t = 120_000;
  expect(await tenantByoMode(TENANT)).toBe('local_allowed');
});

test('a failed read with NOTHING known fails CLOSED to byo_required', async () => {
  cfg.issuanceEnabled = true;
  __setByoPostureForTests({
    resolver: async () => {
      throw new Error('licenses down');
    },
  });
  expect(await tenantByoMode(TENANT)).toBe('byo_required');
});
