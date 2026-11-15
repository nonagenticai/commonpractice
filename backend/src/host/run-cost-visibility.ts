// src/host/run-cost-visibility.ts — who receives LLM spend over the wire.
//
// Spend (LLM calls, tokens, USD) is an administrator's number. The frontend already hides it from
// members (`canSeeSessionCost` → tenant_admin+), but hiding a figure the browser was SENT is not a
// gate: the run-trace SSE stream, GET /api/runs/:id, block simulate and the assistant's chat stream
// all carried it to every caller, readable in the network tab. The server strips it here for anyone
// below tenant_admin, using the same rule as every other tenant-admin gate (`hasTenantAdmin`:
// tenant_admin or super_admin).
//
// ⚠️ ONLY THE WIRE. The persisted `flow_runs.trace`, the cost columns and the usage ledgers are
// untouched — metering, /it-dash and /usage read them, and they are the record of what was spent.
import type { TraceEvent } from '../db/trace-types';
import { hasTenantAdmin, isDeveloper } from '../middleware/admin-guards';
import type { User } from '../types';

export function canSeeRunCost(user: Pick<User, 'roles'>): boolean {
  return hasTenantAdmin(user as User);
}

/** Same rule for callers that carry only a role list (agent tokens, MCP contexts). */
export function canSeeRunCostRoles(roles: readonly string[]): boolean {
  return canSeeRunCost({ roles: [...roles] });
}

/** The event without its cost fields: `node_success.cost` and `run_complete.totals` are omitted. */
export function redactTraceCost(ev: TraceEvent): TraceEvent {
  if (ev.type === 'node_success') {
    const { cost: _cost, ...rest } = ev;
    return rest as TraceEvent;
  }
  if (ev.type === 'run_complete') {
    const { totals: _totals, ...rest } = ev;
    return rest as TraceEvent;
  }
  return ev;
}

// ---- host failure text: developer+ on the wire ----
//
// A `node_error` the HOST reports in its own words carries NO product `rule` (rules are minted only
// by the runner's factories and the LLM broker). Two kinds of it reach a member:
//   • `internal` — a run pod that never became Ready, a lost run lease, a runner crash:
//     "run pod cp-run-… not Running: error: timed out waiting for the condition on pods/…".
//   • `timeout`  — the host idle watchdog: "the runner sent nothing for 120000ms (host idle
//     watchdog) — the run was stopped and its pod destroyed". (Every runner-side timeout —
//     `node_timeout`, `run_wall_clock_exceeded` — is ruled, so an unruled timeout is the host's.)
// A member can act on none of that text, so below developer the wire carries a fixed sentence and
// no detail; the browser shows its own localised message. A developer / tenant_admin / super_admin
// keeps the raw text for diagnosis.
//
// ⛔ A RULED `internal` ERROR IS NOT A HOST FAILURE and keeps its rule for everyone:
// `block_no_default_export`, `block_no_run_function`, `block_no_descriptor`, `node_no_source`,
// `llm_host_closed` are deterministic product sentences the browser localises from the rule plus
// `detail.blockVersion`. Retrying will not fix them, so they must not read "try again later". For a
// member only the English `message` is replaced and `detail` is cut down to `blockVersion` — the
// one token those sentences use.
// ⚠️ Same scope as the cost rule above: only the wire. `flow_runs.trace` keeps the raw text.

/** The fixed English text a member receives in place of an unruled internal error. */
export const INTERNAL_ERROR_REDACTED = 'The test environment could not run the test.';
/** …and in place of the host idle watchdog's text. */
export const TIMEOUT_ERROR_REDACTED = 'The test stopped responding and was ended.';

export function canSeeInternalErrors(user: Pick<User, 'roles'>): boolean {
  return isDeveloper(user as User);
}

/** The event with the host's own failure text replaced; every other event unchanged. */
export function redactInternalError(ev: TraceEvent): TraceEvent {
  if (ev.type !== 'node_error') return ev;
  if (ev.kind === 'internal' && ev.rule) {
    const { detail, ...rest } = ev;
    const blockVersion = detail?.blockVersion;
    return {
      ...rest,
      error: INTERNAL_ERROR_REDACTED,
      ...(blockVersion === undefined ? {} : { detail: { blockVersion } }),
    };
  }
  if (ev.rule || (ev.kind !== 'internal' && ev.kind !== 'timeout')) return ev;
  const { detail: _detail, ...rest } = ev;
  return { ...rest, error: ev.kind === 'timeout' ? TIMEOUT_ERROR_REDACTED : INTERNAL_ERROR_REDACTED };
}

/** The event as `user` may receive it: cost below tenant_admin, host failure text below developer. */
export function traceEventFor(user: Pick<User, 'roles'>, ev: TraceEvent): TraceEvent {
  const costed = canSeeRunCost(user) ? ev : redactTraceCost(ev);
  return canSeeInternalErrors(user) ? costed : redactInternalError(costed);
}

const RUN_COST_COLUMNS = ['total_cost_usd', 'tokens_in', 'tokens_out', 'llm_calls'] as const;

/** A `flow_runs` row as `user` may receive it: cost columns dropped, trace events redacted. */
export function runRowFor<T extends { trace?: unknown }>(user: Pick<User, 'roles'>, row: T): T {
  if (canSeeRunCost(user)) return row; // tenant_admin+ is also developer+: nothing to redact
  const out: Record<string, unknown> = { ...row };
  for (const c of RUN_COST_COLUMNS) delete out[c];
  if (Array.isArray(row.trace)) out.trace = (row.trace as TraceEvent[]).map((ev) => traceEventFor(user, ev));
  return out as T;
}

/** A block-simulate outcome as a caller with `roles` may receive it: `cost` omitted below tenant_admin. */
export function simulateOutcomeFor<T extends { cost?: unknown }>(roles: readonly string[], outcome: T): T {
  if (canSeeRunCostRoles(roles)) return outcome;
  const { cost: _cost, ...rest } = outcome;
  return rest as T;
}
