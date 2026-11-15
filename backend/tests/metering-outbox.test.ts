// tests/metering-outbox.test.ts — migration 0090: every brokered LLM call writes an ATTRIBUTED ledger
// row and, in the SAME transaction, one outbox row that the drainer delivers to billing:costs.
//
// What each case pins, and why it is its own case:
//   • attribution — license_id / subject_id (the licences-service Subject) / actor_id (Keycloak sub)
//     come from the member's entitlement, NOT from CP's users.id. That substitution is what made 100%
//     of CP's central spend `unlicensed`.
//   • platform work — no person acted, so actor_id is empty and usage_extra says origin=system.
//   • atomicity — a ledger row whose cost event could not be enqueued must NOT commit.
//   • drainer — a failed send stays pending with backoff; a sent row is never re-sent.
//   • disabled — nothing is enqueued (an outbox nobody drains would grow forever).
import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, users, tenants, usageCounters, memberEntitlements, withTenantDb } from '../src/db/client';
import { brokerChatCall, __setBrokerDepsForTests } from '../src/host/llm-broker';
import { __setMeteringOverridesForTests, type RedisSender } from '../src/host/metering-emit';
import { drainMeteringOutbox, outboxBackoffMs } from '../src/host/metering-outbox-drainer';
import type { LlmProvider } from '../src/ai/llm/provider';

const TENANT = '00000000-0000-4000-8000-0000000ab001';
const USER = '00000000-0000-4000-8000-0000000ab002';
const SUB = '00000000-0000-4000-8000-0000000ab0c5'; // Keycloak sub — deliberately NOT equal to USER
const LIC = '00000000-0000-4000-8000-0000000ab11c';
const SUBJ = '11111111-1111-4111-8111-0000000ab5b1'; // licences-service Subject UUID

function recorder(opts: { fail?: boolean } = {}) {
  const calls: Record<string, string>[] = [];
  const sender: RedisSender = async (_cmd, args) => {
    if (opts.fail) throw new Error('redis down');
    const f: Record<string, string> = {};
    for (let i = 5; i < args.length; i += 2) f[args[i]!] = args[i + 1]!;
    calls.push(f);
    return 'id';
  };
  return { sender, calls };
}

const chat: LlmProvider = { chat: async () => ({ text: 'ok', usage: { tokensIn: 7, tokensOut: 3 } }) };

async function call(correlationId: string, meta: { platformActor?: true } = {}) {
  return withTenantDb(TENANT, () =>
    brokerChatCall(
      USER,
      TENANT,
      { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      { signal: AbortSignal.timeout(10_000) },
      { correlationId, stage: 'agent-chat', ...meta },
    ),
  );
}

const ledger = async (correlationId: string) =>
  (await db.execute(
    sql`SELECT id, license_id, license_subject_id, actor_id FROM usage_events
         WHERE user_id = ${USER} AND correlation_id = ${correlationId}`,
  )) as unknown as { id: string; license_id: string | null; license_subject_id: string | null; actor_id: string | null }[];

const outbox = async () =>
  (await db.execute(
    sql`SELECT o.status, o.attempts, o.next_attempt_at, o.sent_at FROM metering_outbox o
          JOIN usage_events u ON u.id = o.usage_event_id WHERE u.user_id = ${USER}`,
  )) as unknown as { status: string; attempts: number; next_attempt_at: Date; sent_at: Date | null }[];

async function cleanup() {
  await db.execute(sql`DELETE FROM usage_events WHERE user_id = ${USER}`); // cascades the outbox
  await db.delete(usageCounters).where(inArray(usageCounters.user_id, [USER]));
  await db.delete(memberEntitlements).where(eq(memberEntitlements.user_id, USER));
  await db.delete(users).where(eq(users.id, USER));
  await db.delete(tenants).where(eq(tenants.id, TENANT));
}

beforeEach(async () => {
  await cleanup();
  await db.insert(tenants).values({ id: TENANT, name: 'Outbox Co', slug: 'outbox-co-ab0' });
  await db.insert(users).values({ id: USER, keycloak_sub: SUB, email: 'o@outbox.test', name: 'O', tenant_id: TENANT });
  await db.insert(memberEntitlements).values({
    tenant_id: TENANT,
    user_id: USER,
    license_id: LIC,
    license_subject_id: SUBJ,
    token_encrypted: 'sealed',
    status: 'active',
  });
  __setBrokerDepsForTests({ chatProvider: chat, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
}, 30_000);

afterEach(() => __setMeteringOverridesForTests(undefined));
afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  __setMeteringOverridesForTests(undefined);
  await cleanup();
}, 30_000);

test('a member call is attributed to THEIR licence, Subject and Keycloak sub — never users.id', async () => {
  const r = recorder();
  __setMeteringOverridesForTests({ enabled: true, sender: r.sender });

  expect((await call('attr-1')).ok).toBe(true);
  const [row] = await ledger('attr-1');
  expect(row).toBeDefined();
  expect(row!.license_id).toBe(LIC);
  expect(row!.license_subject_id).toBe(SUBJ);
  expect(row!.actor_id).toBe(SUB);

  expect(r.calls).toHaveLength(0); // enqueued, not sent
  await drainMeteringOutbox();
  const f = r.calls.find((c) => c.correlation_id === 'attr-1');
  expect(f).toBeDefined();
  expect(f!.license_id).toBe(LIC);
  expect(f!.subject_id).toBe(SUBJ);
  expect(f!.subject_id).not.toBe(USER);
  expect(f!.actor_id).toBe(SUB);
  expect(f!.event_key).toBe(row!.id);
  expect((await outbox())[0]!.status).toBe('sent');
}, 30_000);

test('a `revoking` seat still attributes — the call was spent on a licence that is still billed', async () => {
  await db.update(memberEntitlements).set({ status: 'revoking' }).where(eq(memberEntitlements.user_id, USER));
  __setMeteringOverridesForTests({ enabled: true, sender: recorder().sender });
  await call('attr-revoking');
  expect((await ledger('attr-revoking'))[0]!.license_id).toBe(LIC);
}, 30_000);

test('platform work names NO actor and says origin=system — the requested_by human did not act', async () => {
  const r = recorder();
  __setMeteringOverridesForTests({ enabled: true, sender: r.sender });
  await call('attr-platform', { platformActor: true });
  expect((await ledger('attr-platform'))[0]!.actor_id).toBeNull();
  await drainMeteringOutbox();
  const f = r.calls.find((c) => c.correlation_id === 'attr-platform')!;
  expect(f.actor_id).toBe('');
  expect(JSON.parse(f.usage_extra!)).toEqual({ origin: 'system' });
}, 30_000);

test('⛔ ATOMIC: if the cost event cannot be enqueued, the ledger row does not commit either', async () => {
  __setMeteringOverridesForTests({ enabled: true, sender: recorder().sender });
  // A constraint that refuses EVERY new outbox row. NOT VALID so it binds only new inserts.
  await db.execute(sql`ALTER TABLE metering_outbox ADD CONSTRAINT tmp_refuse_all CHECK (false) NOT VALID`);
  try {
    await call('atomic-1'); // runMetered swallows the settle failure and returns the paid answer
  } finally {
    await db.execute(sql`ALTER TABLE metering_outbox DROP CONSTRAINT tmp_refuse_all`);
  }
  // Neither half exists: no ledger row without its cost event.
  expect(await ledger('atomic-1')).toHaveLength(0);
  expect(await outbox()).toHaveLength(0);
}, 30_000);

test('drainer: a failed send stays PENDING with backoff; the retry delivers once and never re-sends', async () => {
  __setMeteringOverridesForTests({ enabled: true, sender: recorder().sender });
  await call('drain-1');

  __setMeteringOverridesForTests({ enabled: true, sender: recorder({ fail: true }).sender });
  await drainMeteringOutbox();
  const [pending] = await outbox();
  expect(pending!.status).toBe('pending');
  expect(pending!.attempts).toBe(1);
  expect(new Date(pending!.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + outboxBackoffMs(1) / 2);

  // Make it due again, then deliver.
  await db.execute(sql`UPDATE metering_outbox SET next_attempt_at = now() WHERE usage_event_id IN
                         (SELECT id FROM usage_events WHERE user_id = ${USER})`);
  const ok = recorder();
  __setMeteringOverridesForTests({ enabled: true, sender: ok.sender });
  await drainMeteringOutbox();
  expect(ok.calls.filter((c) => c.correlation_id === 'drain-1')).toHaveLength(1);
  expect((await outbox())[0]!.status).toBe('sent');

  await drainMeteringOutbox();
  expect(ok.calls.filter((c) => c.correlation_id === 'drain-1')).toHaveLength(1);
}, 30_000);

test('emit DISABLED → the ledger row is written and NOTHING is enqueued', async () => {
  __setMeteringOverridesForTests({ enabled: false });
  await call('disabled-1');
  expect(await ledger('disabled-1')).toHaveLength(1);
  expect(await outbox()).toHaveLength(0);
}, 30_000);
