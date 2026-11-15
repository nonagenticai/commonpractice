// tests/rendezvous-owner.ts — A SECOND PROCESS THAT STANDS IN FOR THE REPLICA HOLDING THE TURN.
//
// ⛔ WHY THIS IS A SUBPROCESS AND NOT A FUNCTION CALL. The defect it proves is that the
// frontend-tool rendezvous used to live in a module-level `Map`, i.e. in ONE pod's heap. A
// module-level `Map` can only be a DIFFERENT Map in a different process, exactly as a module-level
// `const` can only be re-evaluated in a fresh one (the argument tests/config-flag-probe.ts and
// tests/seed-first-boot-order.test.ts already make). Every existing test in this repo — including
// tests/agent-loop.test.ts, which drives the whole loop end to end — calls `resolveFrontendTool`
// IN-PROCESS, so all of them shared the one Map and none of them could ever have seen this. That is
// precisely why it shipped, and it is why the harness has to be two processes against one database.
//
// This script:
//   1. optionally starts the pod's LISTEN supervisor (mode `listen`) or deliberately does NOT
//      (mode `poll`, which proves the poll floor delivers with the NOTIFY doorbell absent),
//   2. registers a REAL waiter with the REAL `waitForFrontendTool` — the same call the agent loop
//      makes — and announces READY,
//   3. prints what the waiter actually resolved with (RESULT1),
//   4. registers a SECOND waiter on the SAME key and prints what THAT one resolved with (RESULT2).
//      A correct implementation must leave nothing behind for it to find: a duplicate report is
//      queued but must never be delivered twice, so RESULT2 is expected to be the timeout.
//
// ⚠️ EVERY LINE IT PRINTS IS A POSITIVE OBSERVATION, ON PURPOSE. A two-process test that asserts
// "no error occurred" passes when the child never registered at all and merely timed out into the
// wrong branch. The parent asserts the payload's unique marker came back, so the only way to pass
// is for the real result to have travelled from the other process.
import {
  waitForFrontendTool,
  __pendingToolCountForTests,
} from '../src/ai/tool-rendezvous';
import { startConnectorListener, stopConnectorListener } from '../src/datasets/connector-listener';
import { closeConnection } from '../src/db/client';

const [turnId, callId, userId, tenantId, mode, timeoutRaw, dupTimeoutRaw] = process.argv.slice(2);
const timeoutMs = Number(timeoutRaw ?? '15000');
const dupTimeoutMs = Number(dupTimeoutRaw ?? '4000');

if (!turnId || !callId || !userId || !tenantId) {
  console.error('usage: rendezvous-owner.ts <turnId> <callId> <userId> <tenantId> <listen|poll>');
  process.exit(2);
}

if (mode === 'listen') {
  // The doorbell. `startConnectorListener` owns the pod's ONE pinned LISTEN session and now
  // registers the tool-result channel alongside the connector ones, in a single statement.
  const live = await startConnectorListener();
  if (!live) {
    console.log('LISTEN_FAILED');
  }
}

const first = waitForFrontendTool(turnId, callId, userId, tenantId, timeoutMs);
// Announced only AFTER the waiter exists, so the parent's report cannot race the registration —
// the same ordering the agent loop uses (register, then emit the SSE frame).
console.log(`READY ${__pendingToolCountForTests()}`);

const r1 = await first;
console.log(`RESULT1 ${JSON.stringify(r1)}`);

// The duplicate check. If the parent reported twice, or if a claim were not atomic, a second row (or
// the same row) would still be sitting there for this waiter to pick up.
const r2 = await waitForFrontendTool(turnId, callId, userId, tenantId, dupTimeoutMs);
console.log(`RESULT2 ${JSON.stringify(r2)}`);
console.log(`PENDING ${__pendingToolCountForTests()}`);

stopConnectorListener();
await closeConnection();
process.exit(0);
