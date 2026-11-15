// tests/metering-emit.test.ts — the OPTIONAL shared `billing:costs` emit (additive to
// CP's local usage_events ledger). Covers: the exact wire field shape billing parses,
// emit-ON writes an XADD, emit-OFF is a no-op, a Redis failure is swallowed, and a
// Redis failure during a real brokered stream leaves the local ledger intact.
import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, users, usageCounters, withTenantDb } from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import {
  buildCostEventFields,
  emitCostEvent,
  __setMeteringOverridesForTests,
  COST_SOURCE,
  SERVICE_KEY,
  EMIT_SUCCESS_COUNTER,
  EMIT_DROPPED_COUNTER,
  EMIT_DROP_REASONS,
  type RedisSender,
  type CostEmitInput,
  type EmitDropReason,
} from '../src/host/metering-emit';
import { renderMetrics } from '../src/host/metrics';
import {
  brokerChatStream,
  __setBrokerDepsForTests,
  type ChatStreamChunk,
} from '../src/host/llm-broker';
import { drainMeteringOutbox } from '../src/host/metering-outbox-drainer';
import type { LlmProvider } from '../src/ai/llm/provider';

const SAMPLE: CostEmitInput = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  subjectId: '22222222-2222-2222-2222-222222222222',
  provider: 'openai',
  model: 'gpt-4o-mini',
  inputTokens: 120,
  outputTokens: 34,
  costUsd: 0.0012345,
  latencyMs: 818,
  correlationId: '33333333-3333-3333-3333-333333333333',
  stage: 'agent-chat',
};

/** A recording fake sender that captures every (command, args) it is handed. */
function recorder(): { sender: RedisSender; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  return {
    calls,
    sender: async (command, args) => {
      calls.push({ command, args });
      return 'fake-id';
    },
  };
}

/** Parse the flat [k1,v1,k2,v2,...] tail of an XADD args array back into a dict. */
function fieldsFromXadd(args: string[]): Record<string, string> {
  // args = [stream, 'MAXLEN', '~', '100000', '*', k1, v1, k2, v2, ...]
  const out: Record<string, string> = {};
  for (let i = 5; i < args.length; i += 2) out[args[i]!] = args[i + 1]!;
  return out;
}

// ---- counter readers ----
//
// ⛔ DELTAS, NEVER ABSOLUTES. host/metrics.ts is a process-global registry and `bun test` shares the
// module graph across every file in a run, so any absolute assertion here would pass or fail on FILE
// ORDER — the exact dependency tests/metrics-counter-preseed.test.ts documents at length. Reading
// before and after one call makes each assertion decided solely by that call.

/** Value of the unlabelled `commonpractice_<name>` series, or `undefined` if absent. */
function counter(name: string): number | undefined {
  const m = new RegExp(String.raw`^commonpractice_${name} (\d+)$`, 'm').exec(renderMetrics());
  return m ? Number(m[1]) : undefined;
}

/** Value of `commonpractice_<name>{reason="<reason>"}`, or `undefined` if that series is absent. */
function dropped(reason: string): number | undefined {
  const m = new RegExp(
    String.raw`^commonpractice_${EMIT_DROPPED_COUNTER}\{reason="${reason}"\} (\d+)$`,
    'm',
  ).exec(renderMetrics());
  return m ? Number(m[1]) : undefined;
}

/** Run `fn`, return how much `dropped(reason)` moved. */
async function dropDelta(reason: EmitDropReason, fn: () => Promise<void>): Promise<number> {
  const before = dropped(reason);
  await fn();
  return (dropped(reason) ?? NaN) - (before ?? NaN);
}

afterEach(() => __setMeteringOverridesForTests(undefined));

test('buildCostEventFields emits the exact billing wire shape (field names + types)', () => {
  // `tenantId` is narrowed to a non-null string at the type level now that the nil sentinel is gone
  // — the refusal happens in emitCostEvent, upstream of this pure builder.
  const f = buildCostEventFields({ ...SAMPLE, tenantId: SAMPLE.tenantId! });
  expect(f).toMatchObject({
    tenant_id: '11111111-1111-1111-1111-111111111111',
    license_id: '',
    subject_id: '22222222-2222-2222-2222-222222222222',
    correlation_id: '33333333-3333-3333-3333-333333333333',
    stage: 'agent-chat',
    app_id: '',
    service_key: SERVICE_KEY,
    cost_source: COST_SOURCE,
    provider: 'openai',
    model: 'gpt-4o-mini',
    served_model: 'gpt-4o-mini',
    input_tokens: '120',
    output_tokens: '34',
    cache_creation_input_tokens: '0',
    cache_read_input_tokens: '0',
    cost_usd: '0.00123450',
    latency_ms: '818',
    provider_request_id: '',
    usage_extra: '{}',
  });
  // timestamp is dynamic but must be ISO-8601.
  expect(new Date(f.timestamp!).toISOString()).toBe(f.timestamp!);
  // service_key/cost_source are CP's registered values.
  expect(f.cost_source).toBe('commonpractice');
});

// ---- provider_request_id: the vendor's join key for a disputed invoice ----
//
// ⛔ THE FIELD ABOVE READS `provider_request_id: ''` FOR `SAMPLE`, AND THAT ASSERTION IS STILL
// CORRECT — `SAMPLE` carries no id, so '' is the honest wire value. It is also exactly what the
// defect looked like: this field was a HARD-CODED `''` in `buildCostEventFields` from the day the
// emitter shipped, so the test above passed for years while the column was empty on 100% of rows and
// billing's vendor reconciliation had no key to join on. A constant and a correctly-empty value are
// indistinguishable from one case; the pair below is what separates them.

test('buildCostEventFields carries the provider request id when the adapter captured one', () => {
  const f = buildCostEventFields({
    ...SAMPLE,
    tenantId: SAMPLE.tenantId!,
    providerRequestId: 'gen-openrouter-42',
  });
  // ⚠️ MUTATION TARGET: restore `provider_request_id: ''` and this is the only assertion in the
  // suite that reds. Every schema check, every field-count check and the wire-shape test above all
  // stay green against a permanently empty column — which is why the defect survived this long.
  expect(f.provider_request_id).toBe('gen-openrouter-42');
});

test('⛔ an absent or blank id sends EMPTY — never a fabricated one', () => {
  // The whole value of this field is that WE DID NOT CHOOSE IT. A generated uuid would be
  // well-formed, pass every check, and be useless in the one conversation the field exists for
  // ("your invoice says X, our ledger says Y — which call was it?"). Billing parses '' as "not
  // reported" and counts it, exactly like the absent `license_id` one field along.
  //
  // ⚠️ `||`, NOT `??` — a blank string is as unusable to a reconciliation lookup as an absent one.
  // With `??` the `''` below would survive as a "value", which reads on the far end as an id that
  // failed to resolve rather than as an id that was never offered.
  for (const providerRequestId of [undefined, null, ''] as const) {
    const f = buildCostEventFields({ ...SAMPLE, tenantId: SAMPLE.tenantId!, providerRequestId });
    expect(f.provider_request_id).toBe('');
  }
});

// ---- the nil-tenant sentinel is REFUSED, not laundered ----
//
// This replaces a test that asserted the OPPOSITE — "fails SAFE to the nil tenant sentinel when no
// tenant resolves", pinning `tenant_id: '00000000-0000-0000-0000-000000000000'`. That behaviour was
// superseded on 2026-08-26 when w2v_common removed the same sentinel under the ruling that a
// tenant_id may never hold one; billing now DEAD-LETTERS such an event as `nil_tenant_id`. So the
// old test pinned an emit that is discarded at the far end while reading, from here, as a success.

test('a tenantless input does NOT emit — the sender is never called', async () => {
  const r = recorder();
  __setMeteringOverridesForTests({ enabled: true, sender: r.sender });

  await emitCostEvent({ ...SAMPLE, tenantId: null });
  await emitCostEvent({ ...SAMPLE, tenantId: '' });

  expect(r.calls).toHaveLength(0);
});

test('a tenantless input counts reason="no_tenant" — once per call', async () => {
  const r = recorder();
  __setMeteringOverridesForTests({ enabled: true, sender: r.sender });

  // ⚠️ TWO calls, expecting exactly 2. A `toBeGreaterThan(0)` here would survive a counter that
  // fires on every code path, and `>= 1` would survive one that fires once and latches. The
  // increment has to be per-drop for `sum(increase(…))` to mean anything.
  const delta = await dropDelta('no_tenant', async () => {
    await emitCostEvent({ ...SAMPLE, tenantId: null });
    await emitCostEvent({ ...SAMPLE, tenantId: '' });
  });

  expect(delta).toBe(2);
});

test('a refused emit does not move the emitted DENOMINATOR', async () => {
  // The pair only means something together: if a refusal bumped both, the drop rate would read 50%
  // when it is in fact 100%, and the denominator would stop being a count of events on the bus.
  __setMeteringOverridesForTests({ enabled: true, sender: recorder().sender });

  const before = counter(EMIT_SUCCESS_COUNTER);
  await emitCostEvent({ ...SAMPLE, tenantId: null });
  expect(counter(EMIT_SUCCESS_COUNTER)).toBe(before!);
});

test('every declared drop reason is reachable and increments its own series', async () => {
  // ⛔ THE ROSTER IS THE ASSERTION. A reason that no code path can produce is a series that reads 0
  // forever and quietly tells an operator "not this one" — the same false reassurance the nil
  // sentinel gave. Driving all four from the outside proves each label value is real, and the
  // `toEqual` over the whole map names EVERY unreachable reason rather than the first.
  const drive: Record<EmitDropReason, () => Promise<void>> = {
    disabled: async () => {
      __setMeteringOverridesForTests({ enabled: false, sender: recorder().sender });
      await emitCostEvent(SAMPLE);
    },
    no_sender: async () => {
      __setMeteringOverridesForTests({ enabled: true, sender: null });
      await emitCostEvent(SAMPLE);
    },
    no_tenant: async () => {
      __setMeteringOverridesForTests({ enabled: true, sender: recorder().sender });
      await emitCostEvent({ ...SAMPLE, tenantId: null });
    },
    send_failed: async () => {
      __setMeteringOverridesForTests({
        enabled: true,
        sender: async () => {
          throw new Error('redis down');
        },
      });
      await emitCostEvent(SAMPLE);
    },
  };

  const deltas: Record<string, number> = {};
  for (const reason of EMIT_DROP_REASONS) {
    deltas[reason] = await dropDelta(reason, drive[reason]);
  }

  expect(deltas).toEqual(Object.fromEntries(EMIT_DROP_REASONS.map((r) => [r, 1])));
});

test('a drop increments exactly ONE reason, not several', async () => {
  // Negative control for the test above. Four independent per-reason deltas all reading 1 would
  // ALSO be produced by an implementation that bumps every label on every drop, which would make
  // `sum by (reason)` useless for telling the four causes apart — the entire point of the label.
  __setMeteringOverridesForTests({ enabled: true, sender: recorder().sender });

  const before = Object.fromEntries(EMIT_DROP_REASONS.map((r) => [r, dropped(r)]));
  await emitCostEvent({ ...SAMPLE, tenantId: null });
  const after = Object.fromEntries(EMIT_DROP_REASONS.map((r) => [r, dropped(r)]));

  const moved = EMIT_DROP_REASONS.filter((r) => after[r] !== before[r]);
  expect(moved).toEqual(['no_tenant']);
});

test('emit ON → XADDs the cost event to the canonical billing:costs stream', async () => {
  const r = recorder();
  __setMeteringOverridesForTests({ enabled: true, sender: r.sender });
  await emitCostEvent(SAMPLE);
  expect(r.calls).toHaveLength(1);
  const { command, args } = r.calls[0]!;
  expect(command).toBe('XADD');
  // Canonical fleet stream the billing-service consumer reads; `metering:costs` is dead.
  expect(args[0]).toBe('billing:costs');
  expect(args.slice(1, 5)).toEqual(['MAXLEN', '~', '100000', '*']);
  const fields = fieldsFromXadd(args);
  expect(fields.provider).toBe('openai');
  expect(fields.input_tokens).toBe('120');
  expect(fields.correlation_id).toBe('33333333-3333-3333-3333-333333333333');
  expect(fields.cost_source).toBe('commonpractice');
});

test('the emitted DENOMINATOR moves on the success path, and only there', async () => {
  // Without this the drop counters have no denominator: "12 drops" is unreadable unless you know
  // whether the other 12,000 calls succeeded or whether 12 was the entire traffic. This is also the
  // series that answers the question the production measurement could not — CP has 0 rows in
  // `billing_cost_events` ever, and `emitted == 0` vs `emitted > 0` says immediately whether the
  // failure is on this side of Redis or the far side of it.
  const r = recorder();
  __setMeteringOverridesForTests({ enabled: true, sender: r.sender });

  const before = counter(EMIT_SUCCESS_COUNTER);
  await emitCostEvent(SAMPLE);
  await emitCostEvent(SAMPLE);
  const after = counter(EMIT_SUCCESS_COUNTER);

  expect(r.calls).toHaveLength(2);
  expect((after ?? NaN) - (before ?? NaN)).toBe(2);
});

test('a THROWING send does not count as emitted — the denominator means "reached the bus"', async () => {
  // ⛔ THE ORDER OF THE INCREMENT IS THE ASSERTION. Bumping the success counter before `await
  // sender(...)` would make a service whose every XADD throws read as 100% emitted, which is
  // precisely the reading that would have hidden this defect for the months CP has been silent.
  __setMeteringOverridesForTests({
    enabled: true,
    sender: async () => {
      throw new Error('redis down');
    },
  });

  const before = counter(EMIT_SUCCESS_COUNTER);
  await emitCostEvent(SAMPLE);
  expect(counter(EMIT_SUCCESS_COUNTER)).toBe(before!);
});

test('emit OFF (flag disabled) → no-op, sender never called', async () => {
  const r = recorder();
  __setMeteringOverridesForTests({ enabled: false, sender: r.sender });
  await emitCostEvent(SAMPLE);
  expect(r.calls).toHaveLength(0);
});

test('emit enabled but no sender (no Redis URL) → no-op', async () => {
  __setMeteringOverridesForTests({ enabled: true, sender: null });
  // Must simply resolve without throwing.
  await emitCostEvent(SAMPLE);
});

test('a Redis failure is swallowed (never throws)', async () => {
  __setMeteringOverridesForTests({
    enabled: true,
    sender: async () => {
      throw new Error('redis down');
    },
  });
  // Resolves cleanly despite the sender throwing.
  await expect(emitCostEvent(SAMPLE)).resolves.toBeUndefined();
});

// ---- integration: a Redis failure must NOT break the brokered call or the ledger ----

const USER_ID = '00000000-0000-0000-0000-0000000b0002';
const meter = <T>(fn: () => Promise<T>) => withTenantDb(DEMO_TENANT_ID, fn);

function fakeStreamChat(): LlmProvider {
  return {
    chat: async () => ({ text: 'whole', usage: { tokensIn: 10, tokensOut: 5 } }),
    async *stream() {
      yield { type: 'text', text: 'Hel' };
      yield { type: 'text', text: 'lo' };
      yield { type: 'done', usage: { tokensIn: 10, tokensOut: 5 }, text: 'Hello' };
    },
  };
}

async function drain(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

async function cleanup() {
  await db.execute(sql`DELETE FROM usage_events WHERE user_id = ${USER_ID}`);
  await db.delete(usageCounters).where(inArray(usageCounters.user_id, [USER_ID]));
  await db.delete(users).where(inArray(users.id, [USER_ID]));
}

// explicit hook timeout — see the long note in license-provisioning.test.ts; bun ignores
// bunfig's [test] timeout for hooks, so a slow one fails as "(unnamed) [5003ms]" with no file/cause.
beforeEach(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
  await db
    .insert(users)
    .values({ id: USER_ID, email: 'metering@test', name: 'Metering' })
    .onConflictDoNothing({ target: users.id });
}, 30_000);
afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  __setMeteringOverridesForTests(undefined);
  await cleanup();
}, 30_000);

test('a throwing emit during brokerChatStream leaves the local ledger intact', async () => {
  __setBrokerDepsForTests({
    chatProvider: fakeStreamChat(),
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  // Emit enabled but the Redis sender throws — the local ledger write must still stand.
  __setMeteringOverridesForTests({
    enabled: true,
    sender: async () => {
      throw new Error('redis down mid-call');
    },
  });

  const chunks = await meter(() =>
    drain(
      brokerChatStream(
        USER_ID,
        DEMO_TENANT_ID,
        { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        { signal: new AbortController().signal },
        { correlationId: 'sess-1', stage: 'agent-chat' },
      ),
    ),
  );
  // The call itself succeeded despite the Redis failure.
  const done = chunks.find((c) => c.type === 'done');
  expect(done).toBeDefined();

  // Local ledger: the usage_events row + usage_counters were written.
  const [evt] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM usage_events WHERE user_id = ${USER_ID}`,
  )) as unknown as { n: number }[];
  expect(evt!.n).toBe(1);
  const [row] = await db.select().from(usageCounters).where(eq(usageCounters.user_id, USER_ID));
  expect(row!.llm_calls).toBe(1);
  expect(Number(row!.spend_usd)).toBeGreaterThan(0);
});

// ---- where the emit's tenant comes from, on the REAL brokered path ----
//
// ⛔ THE PRIORITY IS `ledgerTenantId ?? resolveEmitTenant(...)` (host/llm-broker.ts `settleSpend`),
// and the two tests below are the two arms of it. They exist because the obvious reading of this
// change — "the ledger had a `users` fallback, the emit did not, so the emit was writing the nil
// sentinel" — is WRONG, and shipping on it would have been a fix to a path that emits nothing.
// `requireMeteringTenant()` throws unless an RLS tenant context is present, so the emit ALWAYS had a
// tenant available. What the ledger read-back actually buys is that the two derivations became one.

async function brokerOnce(correlationId: string) {
  __setBrokerDepsForTests({
    chatProvider: fakeStreamChat(),
    limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }),
  });
  const r = recorder();
  __setMeteringOverridesForTests({ enabled: true, sender: r.sender });
  await meter(() =>
    drain(
      brokerChatStream(
        USER_ID,
        null, // no explicit tenant — the case the ledger's COALESCE and resolveEmitTenant both answer
        { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
        { signal: new AbortController().signal },
        { correlationId, stage: 'agent-chat' },
      ),
    ),
  );
  // The broker enqueues; the drainer sends. Keep only THIS call's event.
  await drainMeteringOutbox();
  r.calls.splice(
    0,
    r.calls.length,
    ...r.calls.filter((c) => fieldsFromXadd(c.args).correlation_id === correlationId),
  );
  const [evt] = (await db.execute(
    sql`SELECT tenant_id FROM usage_events WHERE user_id = ${USER_ID}`,
  )) as unknown as { tenant_id: string | null }[];
  return { r, ledgerTenantId: evt?.tenant_id ?? null };
}

test('when the ledger resolved a tenant, the emit carries THAT value — one derivation, not two', async () => {
  // The user carries a tenant, so the ledger INSERT's `COALESCE(NULL, users.tenant_id)` resolves and
  // `RETURNING tenant_id` hands it straight to the emit.
  await db.execute(sql`UPDATE users SET tenant_id = ${DEMO_TENANT_ID} WHERE id = ${USER_ID}`);

  const { r, ledgerTenantId } = await brokerOnce('sess-tenant-present');

  // Positive control BEFORE the equality: `null === null` would satisfy it while proving nothing,
  // and null on both sides is exactly what a refused emit leaves behind.
  expect(ledgerTenantId).toBe(DEMO_TENANT_ID);
  expect(r.calls).toHaveLength(1);
  expect(fieldsFromXadd(r.calls[0]!.args).tenant_id).toBe(ledgerTenantId!);
});

test('when the ledger resolved NOTHING, the RLS context still attributes the emit — it is not refused', async () => {
  // ⚠️ THIS CASE IS REAL, NOT HYPOTHETICAL — this file's own fixture creates the user with NO
  // tenant_id, so `COALESCE(NULL, users.tenant_id)` is NULL and the authoritative `usage_events` row
  // is written UNATTRIBUTED. Preferring the ledger value unconditionally would therefore have made
  // the emitter refuse a call that `requireMeteringTenant` had already proved has a tenant — i.e.
  // this change would have REMOVED attribution instead of adding it, and the `no_tenant` counter
  // would have made that look like a discovery rather than a regression I caused.
  //
  // That is why the priority is `??` and not a straight replacement: monotonic, never worse.
  await db.execute(sql`UPDATE users SET tenant_id = NULL WHERE id = ${USER_ID}`);

  const before = dropped('no_tenant');
  const { r, ledgerTenantId } = await brokerOnce('sess-tenant-absent');

  expect(ledgerTenantId).toBeNull(); // the precondition actually held
  expect(r.calls).toHaveLength(1); // NOT refused
  expect(fieldsFromXadd(r.calls[0]!.args).tenant_id).toBe(DEMO_TENANT_ID);
  // And nothing was counted as a drop, because nothing was dropped.
  expect(dropped('no_tenant')).toBe(before!);
});
