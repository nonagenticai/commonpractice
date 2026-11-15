// logger.ts — one structured line per event, correlated to the request that caused it.
//
// ⛔ THE PROBLEM THIS SOLVES IS NOT "THERE IS NO LOGGING". `server.ts` already emits a well-formed
// JSON line per FAILED request, with `reqId` and `tenant`. The problem is everything else: 179
// `console.*` calls in `backend/src` emit free-form text with no request id, no level field and no
// tenant, so they cannot be filtered, aggregated, or joined to the request that produced them. In
// an incident you can see THAT a request failed and you cannot see WHY, because the three lines
// explaining it are unattributable prose sitting somewhere else in the same stdout stream.
//
// ⚠️ DELIBERATELY NOT pino/winston. Bun's `console.*` already writes to stdout without a transport,
// the cluster ships stdout as-is, and every log line this service emits is consumed by grep or by a
// human — not by an aggregator that needs a specific wire format. A dependency here would buy
// serialization features nothing asks for and add a boot-time import to a hot path. What was
// actually missing is a SHAPE and a correlation id, and both are ~40 lines.
//
// ⚠️ `console.*` UNDERNEATH ON PURPOSE. Bun's console is already line-buffered and
// crash-safe; routing through a stream we manage ourselves would introduce a way to LOSE the last
// lines before a crash, which are the ones worth having.
import { currentRequestContext } from './request-context';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Below this level, nothing is emitted. `LOG_LEVEL` is read from the environment DIRECTLY rather
 * than from `config.ts` because this module is imported by code that runs during config validation
 * — a circular import would make the failure mode "the logger cannot log why the config failed".
 */
function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return ORDER[raw as LogLevel] ?? ORDER.info;
}

/**
 * Values that are safe to put in a log line. `unknown` is accepted and stringified defensively —
 * a logger that throws while formatting an error is a logger that erases the incident.
 */
export type LogFields = Record<string, unknown>;

function safeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return v;
  if (v instanceof Error) {
    // `stack` already contains name + message; carrying all three triples the line for no gain.
    return { name: v.name, message: v.message, stack: v.stack };
  }
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

function emit(lvl: LogLevel, msg: string, fields?: LogFields): void {
  if (ORDER[lvl] < threshold()) return;

  const ctx = currentRequestContext();
  const line: Record<string, unknown> = { lvl, msg };

  // Request identity first so a truncated line still says which request it belonged to.
  if (ctx) {
    line.reqId = ctx.requestId;
    if (ctx.route) line.route = ctx.route;
    if (ctx.tenantId) line.tenant = ctx.tenantId;
  }

  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      // Never let a caller field overwrite the correlation fields — that is the one property the
      // whole module exists to guarantee.
      if (k === 'lvl' || k === 'msg' || k === 'reqId') continue;
      line[k] = safeValue(v);
    }
  }

  let text: string;
  try {
    text = JSON.stringify(line);
  } catch {
    text = JSON.stringify({ lvl, msg, reqId: ctx?.requestId, note: 'fields_unserializable' });
  }

  if (lvl === 'error') console.error(text);
  else if (lvl === 'warn') console.warn(text);
  else console.log(text);
}

export const log = {
  debug: (msg: string, fields?: LogFields) => emit('debug', msg, fields),
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
};
