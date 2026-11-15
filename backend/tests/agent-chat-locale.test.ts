// tests/agent-chat-locale.test.ts — the copilot speaks the UI's language, through the real route.
//
// Prod, 2026-10-16, after #465 (tenant 01a1432b, Dutch UI): the flow-context built for `nl` was
// correct (dumped in-pod: "Claimformulier lezen", "Velden extraheren"…), yet every answer said
// "Read claim form". The chat request is a raw SSE `fetch` that sent no `locale`, so the route fell
// back to the BROWSER's Accept-Language — English — and built the context in `en`. #465's tests
// called `runAgentChat` with `locale: 'nl'` directly and could never see that.
//
// This drives POST /api/agent/chat with the body the browser sends (`locale: 'nl'`) and an English
// Accept-Language, and checks the system prompt names each block exactly as `GET /api/blocks`
// (the canvas's own source, via the block-catalog store) names it for nl.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import {
  db,
  users,
  flows,
  flowSnapshots,
  chatSessions,
  agentSessions,
  usageCounters,
  usageEvents,
  auditLog,
  buildingBlocks,
  withTenantDb,
} from '../src/db/client';
import { DEMO_TENANT_ID } from '../src/config';
import type { FlowGraph } from '../src/db/flow-types';
import { Router } from '../src/utils/router';
import { registerAgentRoutes } from '../src/routes/agent';
import { registerBlockRoutes } from '../src/routes/blocks';
import { issueAgentSession } from '../src/services/agent-session';
import { __setBrokerDepsForTests } from '../src/host/llm-broker';
import type { LlmProvider, LlmRequest } from '../src/ai/llm/provider';

const USER_ID = '00000000-0000-0000-0000-0000000f1c01';
let flowId = '';
const seen: LlmRequest[] = [];
const provider = {
  chat: async (req: LlmRequest) => {
    seen.push(req);
    return { text: 'ok', usage: { tokensIn: 10, tokensOut: 2 } };
  },
} as LlmProvider;

const router = new Router();
registerAgentRoutes(router);
registerBlockRoutes(router);

async function cleanup() {
  const fids = (await db.select({ id: flows.id }).from(flows).where(eq(flows.owner_id, USER_ID))).map((f) => f.id);
  if (fids.length) await db.delete(flowSnapshots).where(inArray(flowSnapshots.flow_id, fids));
  await db.delete(chatSessions).where(eq(chatSessions.user_id, USER_ID));
  await db.delete(agentSessions).where(eq(agentSessions.user_id, USER_ID));
  await db.delete(usageEvents).where(eq(usageEvents.user_id, USER_ID));
  await db.delete(usageCounters).where(eq(usageCounters.user_id, USER_ID));
  await db.delete(auditLog).where(eq(auditLog.actor_id, USER_ID));
  if (fids.length) await db.delete(flows).where(inArray(flows.id, fids));
  await db.delete(users).where(eq(users.id, USER_ID));
}

beforeAll(async () => {
  await cleanup();
  await db
    .insert(users)
    .values({ id: USER_ID, tenant_id: DEMO_TENANT_ID, email: 'chat-locale@test', name: 'Chat Locale' })
    .onConflictDoNothing({ target: users.id });
  const rows = await db
    .select({ id: buildingBlocks.id, slug: buildingBlocks.slug, ver: buildingBlocks.current_version_id })
    .from(buildingBlocks)
    .where(inArray(buildingBlocks.slug, ['read-claim-form', 'extract-fields']));
  const by = new Map(rows.map((r) => [r.slug, r]));
  const read = by.get('read-claim-form')!;
  const ext = by.get('extract-fields')!;
  // Saved in English, as a template applied by an English-speaking session would be.
  const graph = {
    nodes: [
      { id: 'n_read', blockId: read.id, blockVersionId: read.ver ?? '', slug: 'read-claim-form', label: 'Read claim form', category: 'data', config: {}, position: { x: 0, y: 0 } },
      { id: 'n_ext', blockId: ext.id, blockVersionId: ext.ver ?? '', slug: 'extract-fields', label: 'Extract fields', category: 'ai', config: { fields: ['claim_id', 'policy_no'] }, position: { x: 240, y: 0 } },
    ],
    edges: [{ id: 'e1', source: 'n_read', sourceHandle: 'text', target: 'n_ext', targetHandle: 'document' }],
  } as FlowGraph;
  const [flow] = await db
    .insert(flows)
    .values({ tenant_id: DEMO_TENANT_ID, name: 'Samenvatting schadeformulier', owner_id: USER_ID, graph })
    .returning();
  flowId = flow!.id;
  __setBrokerDepsForTests({ chatProvider: provider, limits: () => ({ dailyLlmCap: 100, weeklySpendUsd: 100 }) });
}, 30_000);

afterAll(async () => {
  __setBrokerDepsForTests(undefined);
  await cleanup();
}, 30_000);

/** The names the canvas shows: GET /api/blocks for nl (what block-catalog.svelte.ts loads). */
async function canvasNames(locale: string): Promise<Map<string, string>> {
  const matched = router.match('GET', '/api/blocks')!;
  const res = await withTenantDb(DEMO_TENANT_ID, () =>
    matched.handler(new Request('http://localhost/api/blocks', { headers: { 'accept-language': locale } }), ...matched.params),
  );
  const body = (await res.json()) as { items: Array<{ slug: string; name: string }> };
  return new Map(body.items.map((i) => [i.slug, i.name]));
}

async function systemPromptFor(body: Record<string, unknown>, acceptLanguage: string): Promise<string> {
  seen.length = 0;
  const session = await withTenantDb(DEMO_TENANT_ID, () => issueAgentSession(USER_ID, ['member'], DEMO_TENANT_ID));
  const matched = router.match('POST', '/api/agent/chat')!;
  const res = await matched.handler(
    new Request('http://localhost/api/agent/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept-language': acceptLanguage,
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify(body),
    }),
    ...matched.params,
  );
  await new Response(res.body).text(); // run the turn to its end
  expect(seen.length).toBeGreaterThan(0);
  return seen[0]!.messages[0]!.content;
}

test('⛔ body locale nl on an English browser: the context uses the canvas\'s Dutch block names', async () => {
  const nl = await canvasNames('nl');
  const en = await canvasNames('en');
  // Non-vacuity: the canvas source really differs by locale for these blocks.
  expect(nl.get('read-claim-form')).toBeTruthy();
  expect(nl.get('read-claim-form')).not.toBe(en.get('read-claim-form'));

  const sys = await systemPromptFor({ message: 'Wat doet deze flow?', flowId, locale: 'nl' }, 'en-US,en;q=0.9');
  expect(sys).toContain(`"${nl.get('read-claim-form')}"`);
  expect(sys).toContain(`"${nl.get('extract-fields')}"`);
  expect(sys).not.toContain(`"${en.get('read-claim-form')}"`);
  // Field keys appear only bracketed, after words a reader can read.
  expect(sys).toContain('Claim ID, Policy no [claim_id, policy_no]');
  expect(sys).not.toContain('["claim_id"');
}, 30_000);
