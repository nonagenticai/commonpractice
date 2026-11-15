// src/ai/llm/egress-fetch.ts — the outbound gate for EXTERNAL LLM provider calls.
//
// The commonpractice pod denies public-internet egress by NetworkPolicy (the flow runner shares
// the pod's network namespace, so a blanket 0.0.0.0/0 would be an exfiltration vector). The local
// pgx-vLLM (inference-router) is in-cluster and needs no gate. But when a tenant configures an
// EXTERNAL provider (Anthropic/OpenAI/DeepSeek/Grok/Cohere), that call must pass the SAME governed
// egress the data connectors use: models.external_http ON + the host on data.egress_allowlist +
// the SSRF hard-block (host/egress-guard.ts). This wraps the adapters' fetch with that check for
// external hosts and passes in-cluster hosts straight through (the NetworkPolicy governs those).
import type { FetchImpl } from './adapters/anthropic';
import { assertEgressAllowed, parseTarget } from '../../host/egress-guard';
import { getSnapshot } from '../../host/policy-store';

/** In-cluster / private targets the NetworkPolicy already governs — never sent through the
 *  external egress allowlist (the inference-router is *.svc.cluster.local, externalHttp is off). */
function isInClusterHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  if (h.endsWith('.svc.cluster.local') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  // private / loopback IP literals
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

/** A FetchImpl for the LLM adapters: external hosts pass the governed egress policy first;
 *  in-cluster hosts fetch directly. Throws EgressBlockedError (mapped by the broker to a chat
 *  error) when an external host is not allowlisted / external HTTP is disabled. */
export function governedLlmFetch(): FetchImpl {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const { host } = parseTarget(url);
    if (host && !isInClusterHost(host)) {
      await assertEgressAllowed(url, await getSnapshot());
    }
    return fetch(input as never, init);
  }) as FetchImpl;
}
