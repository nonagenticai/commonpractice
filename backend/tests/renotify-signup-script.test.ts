// tests/renotify-signup-script.test.ts — scripts/renotify-signup.ts re-posts the Telegram notice for a
// PENDING signup only, and builds it from the stored row (name, email, company, locale) so the
// re-posted message carries the same Approve/Reject buttons as the original.
import { afterAll, expect, test } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { db, signupApprovals } from '../src/db/client';
import { loadRenotice } from '../scripts/renotify-signup';

const id = (n: string) => `00000000-0000-4000-8000-0000000e${n.padStart(4, '0')}`;
const PENDING = id('0001');
const DECIDED = id('0002');
const UNTRUSTED = id('0003');
const ALL = [PENDING, DECIDED, UNTRUSTED];

afterAll(async () => {
  await db.delete(signupApprovals).where(inArray(signupApprovals.id, ALL));
}, 30_000);

test('pending + trusted → a full notice built from the stored row', async () => {
  await db.delete(signupApprovals).where(inArray(signupApprovals.id, ALL));
  await db.insert(signupApprovals).values([
    { id: PENDING, email: 'renotify-p@example.test', name: 'Renotify P', company: 'Acme', locale: 'nl', source: 'web', trust: 'intake', message: 'hi' },
    { id: DECIDED, email: 'renotify-d@example.test', status: 'rejected', source: 'web', trust: 'intake' },
    { id: UNTRUSTED, email: 'renotify-u@example.test', source: 'web', trust: null },
  ]);
  const n = await loadRenotice(PENDING);
  expect(typeof n).toBe('object');
  if (typeof n === 'string') throw new Error(n);
  expect(n).toMatchObject({
    id: PENDING,
    email: 'renotify-p@example.test',
    name: 'Renotify P',
    company: 'Acme',
    locale: 'nl',
    source: 'web',
    trust: 'intake',
    message: 'hi',
    matchedWorkspace: null,
  });
  expect(n.pendingTotal).toBeGreaterThanOrEqual(1);
});

test('a decided, an untrusted or an unknown signup is refused with a reason', async () => {
  expect(await loadRenotice(DECIDED)).toContain('not pending');
  expect(await loadRenotice(UNTRUSTED)).toContain('no trust tier');
  expect(await loadRenotice(id('0999'))).toContain('not found');
});
