// tests/llm-ctx-egress.test.ts — the RUNNER's `ctx.llm()` egress, which nobody governed.
//
// ⛔ THE DEFECT. `ai/llm/select.ts::buildAdapter` builds every TENANT-resolved chat adapter with
// `fetchImpl: governedLlmFetch()`, so a chat call to an external provider passes
// `models.external_http` + `data.egress_allowlist` + the SSRF hard-block. The two providers in
// `host/llm-broker.ts` that back a BLOCK's `ctx.llm()` did not:
//   * `openaiCompatibleProvider` constructed the SAME `OpenAiProvider` class with NO `fetchImpl`,
//     falling through to bare `fetch`. This is the provider `LLM_MODE=openai_compatible` selects,
//     which is what production runs.
//   * `anthropicProvider` called bare `fetch('https://api.anthropic.com/...')` outright (deleted
//     since: CP holds no Anthropic key, owner rule 2026-10-13).
// So a block's `ctx.llm()` reached whatever `OPENAI_BASE_URL` pointed at with the egress allowlist
// switched off and no record of the decision — the one LLM path a tenant's own code can trigger.
//
// These tests assert the GATE, not the network: `assertEgressAllowed` throws before any socket is
// opened, so an offline runner sees the same result as CI.
import { test, expect, afterEach } from 'bun:test';
import { config } from '../src/config';
import { openaiCompatibleProviderWithKey } from '../src/host/llm-broker';

// The router provider now always carries a router credential (there is no env key).
const openaiCompatibleProvider = openaiCompatibleProviderWithKey('ir-test-token');
import { __setSnapshotOverrideForTests, getSnapshot } from '../src/host/policy-store';
import { __setEgressHooksForTests } from '../src/host/egress-guard';
import type { GovernanceSnapshot } from '../src/host/policy-store';

/**
 * `config.llm` is declared readonly (it is built once from env at import). These tests need to
 * point the provider at a host the egress gate will judge, so they write through a mutable view and
 * restore in `afterEach`. The cast is confined to this one alias — nothing in `src/` gets it.
 */
const llm = config.llm as {
  openaiBaseUrl: string;
};

const origBase = llm.openaiBaseUrl;

afterEach(() => {
  llm.openaiBaseUrl = origBase;
  __setSnapshotOverrideForTests(undefined);
  __setEgressHooksForTests(undefined);
});

async function snapshotWith(over: Partial<GovernanceSnapshot>): Promise<GovernanceSnapshot> {
  __setSnapshotOverrideForTests(undefined);
  return { ...(await getSnapshot()), ...over };
}

const req = { model: 'gpt-4o-mini', prompt: 'hello' } as never;

test('ctx.llm() through openai_compatible is REFUSED when models.external_http is off', async () => {
  llm.openaiBaseUrl = 'https://api.some-external-llm.invalid/v1';
  __setSnapshotOverrideForTests(await snapshotWith({ externalHttp: false, egressAllowlist: [] }));

  // The governed gate throws BEFORE the socket, so this is deterministic offline.
  await expect(openaiCompatibleProvider(req)).rejects.toThrow(/External HTTP is disabled by policy/);
});

test('…and when external_http is ON but the host is not allowlisted', async () => {
  llm.openaiBaseUrl = 'https://api.some-external-llm.invalid/v1';
  __setSnapshotOverrideForTests(await snapshotWith({ externalHttp: true, egressAllowlist: ['api.openai.com'] }));

  await expect(openaiCompatibleProvider(req)).rejects.toThrow(/not on the connector egress allowlist/);
});

test('an ALLOWLISTED external host passes the gate (the refusals above are not blanket)', async () => {
  // ⛔ THE VACUITY GUARD. Without it, "rejects" above is satisfied by the provider being broken for
  // any reason at all — a missing key, a bad URL, a typo in the adapter. Allowlisting the same host
  // (and pinning DNS through the test seam so the SSRF check is offline-deterministic) must get the
  // call PAST the egress gate; it then dies at the socket, which is a DIFFERENT error.
  llm.openaiBaseUrl = 'https://api.some-external-llm.invalid/v1';
  __setEgressHooksForTests({ lookup: async () => ['203.0.113.10'] });
  __setSnapshotOverrideForTests(
    await snapshotWith({ externalHttp: true, egressAllowlist: ['api.some-external-llm.invalid'] }),
  );

  const err = await openaiCompatibleProvider(req).then(() => null, (e: unknown) => e as Error);
  expect(err).not.toBeNull();
  expect(String(err?.message ?? err)).not.toMatch(/disabled by policy|egress allowlist/);
});

test('the in-cluster inference-router is NOT sent through the external allowlist', async () => {
  // Prod's normal path: OPENAI_BASE_URL points at an in-cluster Service. `governedLlmFetch` passes
  // those straight through (the NetworkPolicy governs them), so switching external HTTP off must
  // not break the local model — that would be an outage dressed as a security fix.
  llm.openaiBaseUrl = 'http://inference-router.inference-router.svc.cluster.local:8150/api';
  __setSnapshotOverrideForTests(await snapshotWith({ externalHttp: false, egressAllowlist: [] }));

  // ⛔ THIS TEST USED TO ASSERT A NETWORK ERROR (`expect(err).not.toBeNull()`), which contradicted
  // this file's own header and FAILED IN CI while passing locally: whether an unresolvable host
  // produces an error at all depends on the runner's DNS, and a resolver that answers wildcard
  // NXDOMAIN differently turns the assertion over. The gate's decision is what this test is about,
  // so stub the transport and assert the decision directly — no socket, no DNS, same result
  // offline and in CI.
  const seen: string[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    return new Response(
      JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;

  try {
    await openaiCompatibleProvider(req);
  } finally {
    globalThis.fetch = origFetch;
  }

  // The gate let it through: the transport was actually reached, at the in-cluster host…
  expect(seen.length).toBeGreaterThan(0);
  expect(seen[0]).toContain('inference-router.inference-router.svc.cluster.local');
  // …and NON-VACUITY: the same snapshot really does refuse an external host, so this is the
  // short-circuit doing its job and not an inert gate that permits everything.
  llm.openaiBaseUrl = 'https://api.some-external-llm.invalid/v1';
  await expect(openaiCompatibleProvider(req)).rejects.toThrow(/External HTTP is disabled by policy/);
});
