// request-context.ts — the per-request identity that deep code can read without being handed it.
//
// ⛔ WHY THIS EXISTS. Before it, `requestId` was minted inside `route()` (utils/http.ts) and lived
// only in the error path: a SUCCESSFUL response carried no `x-request-id` at all, and nothing below
// the handler could see one. That is what made 179 `console.*` calls in `backend/src` uncorrelatable
// — a log line emitted three frames deep in a service had no way to say which request it belonged
// to, so a production incident could not be reassembled from stdout even though the lines existed.
//
// The id is now minted ONCE at the top of `Bun.serve`'s fetch, before routing, and every response
// carries it — success included. `route()` reads it from here rather than minting its own, so the
// id in the client's header, the id in the `http` log line, and the id in a logger call three
// frames down are the same string by construction rather than by convention.
//
// ⚠️ AsyncLocalStorage AND NOT a module-level `let`. Bun serves requests concurrently on one
// thread; a module-level mutable would be overwritten by whichever request most recently awaited,
// and would attribute log lines to the WRONG request under exactly the concurrency where log
// correlation matters. ALS propagates across `await` boundaries per logical call chain, which is
// the only structure that survives interleaving.
//
// ⚠️ Reads are ALWAYS optional. Code runs outside a request all the time here — schedulers,
// migrations at boot, the seed, CLI paths — so `current()` returns `undefined` there rather than
// throwing. A logger that crashed the scheduler because it wanted a request id would be a worse
// bug than the one this fixes.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /** Echoed to the client as `x-request-id` on EVERY response, and stamped into every log line. */
  readonly requestId: string;
  /**
   * The route TEMPLATE (low cardinality), e.g. `/api/solutions/:id`. Mutable because the context is
   * created BEFORE `router.match` runs — the id has to exist for the unmatched-404 path too — and
   * is filled in the moment the template is known.
   */
  route?: string;
  readonly method: string;
  /** Resolved by `peekEffectiveTenant`; null for anonymous/platform requests. */
  tenantId: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The context for the request currently on this call chain, or `undefined` outside a request. */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Run `fn` with `ctx` bound to its whole async call chain. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Accept a caller-supplied `x-request-id` so a trace can span the SPA, this service and fr — but
 * bound it. An unbounded header would let a caller push an arbitrary-length string into every log
 * line this request produces (a log-volume amplification), and a newline would let them forge a
 * second JSON log line entirely. 128 chars matches the cap `route()` already applied, and the
 * character class is the one every id we actually emit (a UUID) satisfies.
 */
export function sanitizeInboundRequestId(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return null;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}
