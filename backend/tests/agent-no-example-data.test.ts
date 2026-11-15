// tests/agent-no-example-data.test.ts — W8/F2: example data never reaches the external AI.
//
// Owner decision (2026-10-14): sample data VALUES are not sent to the external LLM. The build
// agent's `describe_data` tool used to answer with a row `sample` (PII-blanked only when governance
// scrubbing was on) and every column's `sample` — a real cell value — unconditionally, and that tool
// result is appended verbatim to the NEXT provider request.
//
// This drives the REAL agent loop (runAgentChat → host.callTool → describe_data) with a scripted
// provider that asks for `describe_data` and then answers, and asserts on the CAPTURED outbound
// request — the bytes a provider would receive — not on the tool's return value. Governance PII
// scrubbing is pinned OFF, the setting under which the old code shipped every value raw.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { db, users, tenants, datasets, datasetRows, chatSessions, usageCounters, auditLog, withTenantDb } from '../src/db/client';
import { runAgentChat, ensureChatSession, type AgentEvent } from '../src/ai/agent';
import { __setBrokerDepsForTests } from '../src/host/llm-broker';
import { buildSnapshot, __setSnapshotOverrideForTests } from '../src/host/policy-store';
import type { LlmProvider, LlmRequest } from '../src/ai/llm/provider';

// Ids owned by THIS FILE ONLY (tests/fixture-id-collisions.test.ts).
const T = '00000000-0000-0000-0000-00000a8f0001';
const USER_ID = '00000000-0000-0000-0000-00000a8f0011';
const DS_ID = '00000000-0000-0000-0000-00000a8f0021';
const SLUG = 'w8-noexample-claims';
// Values that must never leave: a non-PII number, a PII email, and free text in an unflagged column.
const SECRETS = ['48213.77', 'maria.f2secret@x.invalid', 'Lives at Kerkstraat 9'];

async function cleanup() {
  await db.delete(chatSessions).where(eq(chatSessions.user_id, USER_ID));
  await db.delete(usageCounters).where(eq(usageCounters.user_id, USER_ID));
  await db.delete(auditLog).where(eq(auditLog.actor_id, USER_ID));
  await db.delete(datasetRows).where(eq(datasetRows.dataset_id, DS_ID));
  await db.delete(datasets).where(eq(datasets.id, DS_ID));
  await db.delete(users).where(inArray(users.id, [USER_ID]));
  await db.delete(tenants).where(eq(tenants.id, T));
}

beforeAll(async () => {
  await cleanup();
  await db.insert(tenants).values({ id: T, name: 'W8 No Example', slug: 'w8-noexample' });
  await db.insert(users).values({ id: USER_ID, email: 'w8f2@test', name: 'W8 F2', tenant_id: T, tenant_role: 'developer' });
  await db.insert(datasets).values({
    id: DS_ID, owner_id: USER_ID, tenant_id: T, name: 'W8 Example Claims', slug: SLUG, source_type: 'csv', row_count: 1,
    // Column `sample` values are real cells — exactly what used to ride along unconditionally.
    columns: [
      { name: 'claim_amount', type: 'number', sample: 48213.77 },
      { name: 'holder_email', type: 'string', pii: true, sample: 'maria.f2secret@x.invalid' },
      { name: 'adjuster_notes', type: 'string', sample: 'Lives at Kerkstraat 9' },
    ],
  });
  await db.insert(datasetRows).values({
    dataset_id: DS_ID, idx: 0,
    data: { claim_amount: 48213.77, holder_email: 'maria.f2secret@x.invalid', adjuster_notes: 'Lives at Kerkstraat 9' },
  });
}, 30_000);

afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  __setSnapshotOverrideForTests(undefined);
  await cleanup();
}, 30_000);

test('⛔ F2: the provider request after describe_data carries the column names and types — and no value', async () => {
  // Governance scrubbing OFF: the old code shipped every value raw under this setting.
  __setSnapshotOverrideForTests({ ...buildSnapshot([]), piiScrubbing: false });
  const requests: LlmRequest[] = [];
  const provider = {
    chat: async (req: LlmRequest) => {
      // Deep copy: the loop keeps appending to the same array after the call returns.
      requests.push(JSON.parse(JSON.stringify(req)));
      if (requests.length === 1) {
        return { toolCalls: [{ id: 'c1', name: 'describe_data', input: { slug: SLUG } }], usage: { tokensIn: 10, tokensOut: 5 } };
      }
      return { text: 'Use claim_amount.', usage: { tokensIn: 10, tokensOut: 5 } };
    },
  } as LlmProvider;
  __setBrokerDepsForTests({ chatProvider: provider, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });

  const events: AgentEvent[] = [];
  const sessionId = await withTenantDb(T, () => ensureChatSession(USER_ID, null));
  await withTenantDb(T, () =>
    runAgentChat({
      userId: USER_ID,
      roles: ['developer'],
      tenantId: T,
      sessionId,
      flowId: null,
      userMessage: 'Which column holds the amount?',
      emit: (ev) => events.push(ev),
      signal: new AbortController().signal,
    }),
  );

  // The tool really ran and succeeded — otherwise "no value in the request" proves nothing.
  expect(events.some((e) => e.type === 'tool-result' && e.name === 'describe_data' && e.ok)).toBe(true);
  expect(requests).toHaveLength(2);
  const outbound = JSON.stringify(requests[1]!.messages);
  // Positive control: the schema IS there.
  expect(outbound).toContain('claim_amount');
  expect(outbound).toContain('holder_email');
  expect(outbound).toContain('adjuster_notes');
  for (const secret of SECRETS) expect(outbound).not.toContain(secret);
  expect(outbound).not.toContain('48213');
});
