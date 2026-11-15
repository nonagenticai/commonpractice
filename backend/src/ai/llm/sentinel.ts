// src/ai/llm/sentinel.ts — no imports beyond config, so the adapter can import it without a cycle.
import { config } from '../../config';

/**
 * The placeholder bearers the OpenAI SDK fleet sends when it has no key. inference-router runs
 * `INTROSPECT_MODE=enforce` (measured 2026-10-13) and refuses every one of them with a 401, so a
 * request carrying one is a request that was always going to fail — and, before enforcement, one
 * nobody could attribute or budget. CP never sends them: `ai/llm/adapters/openai.ts` refuses to.
 */
const SENTINEL_CREDENTIALS = new Set(['empty', 'none', 'internal', 'null', 'undefined']);
export function isSentinelCredential(key: string | null | undefined): boolean {
  return !key || SENTINEL_CREDENTIALS.has(key.trim().toLowerCase());
}


function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * Is `baseUrl` the in-cluster inference-router — the ONE place a placeholder bearer is refused?
 *
 * ⚠️ NOT every host. A tenant's own `custom` / openai_compatible endpoint (a self-hosted vLLM, a
 * gateway) may legitimately accept ANY key, `EMPTY` included, and the tenant may type exactly that;
 * refusing it there would break a working setup (and its Test connection) for no reason. The router
 * is: the deployment's OPENAI_BASE_URL host (that is the router in prod), or any host whose first
 * DNS label is `inference-router` (the in-cluster Service, however it is addressed).
 */
export function isInferenceRouterBase(baseUrl: string | null | undefined): boolean {
  const host = hostOf(baseUrl);
  if (!host) return false;
  const routerHost = hostOf(config.llm.openaiBaseUrl || null);
  if (routerHost && host === routerHost) return true;
  return /^[a-z]+:\/\/inference-router(\.|:|$)/.test(host);
}
