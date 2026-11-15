// src/utils/http.ts — JSON response helpers + a typed HttpError, plus a `route`
// wrapper that maps known errors (zod, HttpError, UnauthorizedError) to status
// codes. server.ts still applies CORS + a final 500 catch around every handler.
import { ZodError } from 'zod';
import { UnauthorizedError } from '../types';
import { currentRequestContext } from '../host/request-context';
import { log } from '../host/logger';

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    /** Extra fields merged into the JSON body (e.g. lint `findings`, a test `summary`). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

/**
 * ⚠️ `details` here is NOT for the localization seam below — `writeErrorText` never consults the
 * 400/409/422 catalog on a 404 or a 403 (404 falls through to the caller's own localized fallback;
 * 403 has its own exhaustive `FORBIDDEN_MESSAGES` map keyed on code alone). It exists so that ONE
 * CODE HAS ONE SHAPE at every throw: `dataset_not_found` is a 400 in routes/challenges.ts and a 404
 * in three other modules, and a helper that cannot carry `{ slug }` forces the two to diverge.
 *
 * `/api/connectors/test` also forwards `HttpError.details` verbatim as `params` for whatever it
 * catches, including a 403 `foreign_bucket` — without this parameter that forwarding was reading a
 * field nothing could ever set.
 */
export const notFound = (
  code: string,
  message?: string,
  details?: Record<string, unknown>,
) => new HttpError(404, code, message, details);
export const forbidden = (
  code: string,
  message?: string,
  details?: Record<string, unknown>,
) => new HttpError(403, code, message, details);
/** 402 — the caller is authenticated (Gate 1) but holds no valid license (Gate 2, Spec Part 9). */
export const paymentRequired = (code: string, message?: string) =>
  new HttpError(402, code, message);
/**
 * 503 — an AUTHORIZATION decision could not be made because the state it depends on was
 * unreachable, and the gate therefore denied (fail-closed).
 *
 * ⚠️ NOT a general "something broke" helper — that is a bare 500 out of `route()`. This code says
 * something narrower and operationally useful: the request was refused *without a verdict*, so it
 * is a DEPENDENCY outage rather than a client mistake, it is retryable, and a spike in it is an
 * alertable platform condition rather than a wave of legitimate per-caller denials. `route()`
 * already `console.error`s every `status >= 500`, so a throw through this helper leaves a pod-log
 * trace on its own; a 403 would not.
 *
 * First (and so far only) caller: `middleware/tenant-status-gate.ts`, whose whole argument for
 * failing closed rests on this being DISTINGUISHABLE from the 403 the same gate emits when it does
 * have a verdict. Keep it that way — reusing this code for an ordinary handler failure would make
 * the distinction unreadable.
 *
 * ⚠️ THE SPA HALF OF THIS STATUS IS UNRATCHETED, AND THAT IS A KNOWN GAP, NOT AN OVERSIGHT TO
 * REDISCOVER. `frontend/src/lib/api/error-message.backend-contract.test.ts` scrapes `forbidden(`,
 * `paymentRequired(`, `badRequest(`, `unprocessable(` and `conflict(` out of `backend/src` and reds
 * unless every code it finds has localized copy. It scrapes NEITHER `serviceUnavailable(` NOR
 * `new HttpError(503,`. The SPA's `SERVICE_UNAVAILABLE_MESSAGES` map is keyed `Record<string, …>`
 * rather than a union, so there is no compile-time half either. A SECOND code added through this
 * helper therefore ships with no copy in any of the 8 locales and the whole suite stays green —
 * exactly the hole that the 402 comment in middleware/license-gate.ts describes for Gate 2's codes
 * before its contract test existed. Add the code to the SPA map in the same change, by hand, until
 * that scrape learns this helper.
 */
export const serviceUnavailable = (
  code: string,
  message?: string,
  details?: Record<string, unknown>,
) => new HttpError(503, code, message, details);
/**
 * ⛔ `details` IS THE LOCALIZATION SEAM, not a debugging convenience.
 *
 * `frontend/src/lib/api/error-message.ts`'s `writeErrorText` renders the ENGLISH `message` verbatim
 * for any 400/409/422 code it has no catalog entry for — measured on `8d36692`: 91 of the 102 codes
 * these three helpers emit. A Dutch tenant reads "CSV must have a header row with column names".
 *
 * Localizing a refusal therefore needs two things on the wire that the sentence currently hides:
 *   · `reason` — a stable snake_case discriminator, for the codes that carry SEVERAL sentences
 *     behind one code (`bad_config` has 8, `bucket_convention` 4, `dataset_too_large` 3). It is a
 *     `details` field and NOT a new wire `code` on purpose: `code` is already keyed on by tests and
 *     by `connection-test-label.ts`, so renaming it is a behaviour change while adding `reason` is
 *     additive and an old bundle simply ignores it.
 *   · the interpolated VALUES as named fields (`field`, `limitMb`, `name`, …) — so a catalog can
 *     rebuild the sentence in any language instead of a regex re-parsing it out of the English one.
 *
 * `conflict` and `badRequest` had no way to carry either; only `unprocessable` did. `route()` below
 * already merges `details` into the JSON body, so this is purely the missing parameter.
 *
 * The English `message` stays exactly as it was: it is the fallback a rolling deploy depends on
 * (a new bundle really is answered by an old pod for the length of the roll) and the only carrier
 * for a code no catalog knows.
 */
export const conflict = (
  code: string,
  message?: string,
  details?: Record<string, unknown>,
) => new HttpError(409, code, message, details);
export const badRequest = (
  code: string,
  message?: string,
  details?: Record<string, unknown>,
) => new HttpError(400, code, message, details);
export const unprocessable = (
  code: string,
  message?: string,
  details?: Record<string, unknown>,
) => new HttpError(422, code, message, details);

/** 429 — the caller is being rate limited. `details.retryAfterSec` drives the `Retry-After` header. */
export const tooManyRequests = (
  code: string,
  message?: string,
  details?: Record<string, unknown>,
) => new HttpError(429, code, message, details);

/** 413 — the request body exceeded the cap before it was parsed. */
export const payloadTooLarge = (
  code: string,
  message?: string,
  details?: Record<string, unknown>,
) => new HttpError(413, code, message, details);

/**
 * ⛔ THE CAP THAT DID NOT EXIST. `readJson` was a bare `await req.json()` and `readJsonOptional` a
 * bare `await req.text()` — both read an unbounded body into memory inside a container limited to
 * 1Gi, on routes reachable (per the limiter's own notes) without authentication. Any client could
 * post until the pod was OOMKilled.
 *
 * ⚠️ 1 MiB IS ~150x THE LARGEST REAL PAYLOAD, MEASURED, NOT GUESSED. Against production today the
 * largest JSON this service actually stores is `chat_messages.content` at 6,963 bytes; `flows.graph`
 * and `solutions.published_graph` top out at 1,708. A cap chosen by intuition is how a hardening
 * change becomes an outage, so it is chosen against the real distribution with three orders of
 * magnitude of headroom.
 *
 * ⚠️ DATASET UPLOADS ARE NOT AFFECTED. They never went through `readJson` — `datasets.ts` has its
 * own `readBoundedBody` with its own (much larger) limit, which is where a multi-megabyte CSV
 * belongs. Raising this constant to accommodate an upload would be the wrong fix.
 */
const DEFAULT_MAX_BODY_BYTES = (() => {
  const n = Number(process.env.MAX_REQUEST_BODY_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1_048_576;
})();

/**
 * Read the body as text, refusing anything over `maxBytes`.
 *
 * ⚠️ TWO CHECKS, NOT ONE. `content-length` is a client-supplied claim: it can be absent entirely
 * (a chunked body), or it can lie. Trusting it alone means a chunked request bypasses the cap
 * completely, which is the exact shape of body-limit bug that gets written most often. So the
 * header is used only as an EARLY refusal (it lets us reject without reading a byte), and the
 * streaming accumulator below is the one that actually enforces the limit.
 */
async function readBoundedText(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw payloadTooLarge('request_body_too_large', 'Request body is too large.', {
      limitBytes: maxBytes,
    });
  }
  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // Stop the client from streaming the rest at us; without this the socket keeps feeding a
      // request we have already refused.
      await reader.cancel();
      throw payloadTooLarge('request_body_too_large', 'Request body is too large.', {
        limitBytes: maxBytes,
      });
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** Parse + validate a JSON body with a zod schema (throws ZodError → 422). */
export async function readJson(req: Request): Promise<unknown> {
  const text = await readBoundedText(req, DEFAULT_MAX_BODY_BYTES);
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('invalid_json', 'Request body is not valid JSON');
  }
}

/**
 * Like `readJson` for endpoints whose body is OPTIONAL (all fields default): an EMPTY body is a
 * valid `{}`, but a MALFORMED body still fails with 400. Replaces the `readJson(req).catch(() => ({}))`
 * anti-pattern, which silently swallowed malformed JSON (a stale lint / wrong export date with no error).
 */
export async function readJsonOptional(req: Request): Promise<unknown> {
  const text = (await readBoundedText(req, DEFAULT_MAX_BODY_BYTES)).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('invalid_json', 'Request body is not valid JSON');
  }
}

type Handler = (req: Request, ...params: string[]) => Promise<Response>;

/**
 * True when `err` (or its cause) is a Postgres 22P02 "invalid text representation" — raised when a
 * client-supplied value (a malformed uuid path param like `/api/challenges/not-a-uuid`, or a bad
 * uuid/int/json in a query/body) fails to cast to the column type. Drizzle wraps the driver error,
 * so the pg `code` lives on `.cause`. This is a client error (400), not a server fault (500).
 */
function isInvalidTextRepr(err: unknown): boolean {
  const code = (e: unknown) =>
    typeof e === 'object' && e !== null && 'code' in e
      ? (e as { code?: unknown }).code
      : undefined;
  if (code(err) === '22P02') return true;
  const cause = (err as { cause?: unknown })?.cause;
  return code(cause) === '22P02';
}

/** Wraps a handler so domain errors become proper JSON responses. */
export function route(handler: Handler): Handler {
  return async (req, ...params) => {
    // ⛔ READ FROM THE REQUEST CONTEXT, DO NOT MINT A SECOND ONE. `server.ts` now mints exactly one
    // id per request before routing and binds it for the whole async call chain, so the id the
    // client is handed, the id in the `http` log line, and the id in a `log.*` call three frames
    // deep are the same string BY CONSTRUCTION. Minting here as well (which is what this did) meant
    // any log line emitted outside `route()` carried a different id than the client's — correlation
    // that looks present and silently does not join. The fallback keeps this helper usable from a
    // test that calls a handler directly, with no server around it.
    const requestId = currentRequestContext()?.requestId ?? crypto.randomUUID();
    const errorResponse = (body: Record<string, unknown>, status: number) => {
      const response = jsonResponse({ ...body, requestId }, status);
      response.headers.set('x-request-id', requestId);
      return response;
    };
    try {
      return await handler(req, ...params);
    } catch (err) {
      if (isInvalidTextRepr(err)) {
        return errorResponse(
          { error: 'invalid_input', message: 'A path or query value is not a valid identifier' },
          400,
        );
      }
      if (err instanceof HttpError) {
        // A 5xx here is an UPSTREAM failure (Keycloak / licenses / OpenRouter), not a client
        // mistake — it must leave a trace. Without this, an onboarding 502 was completely
        // invisible in the pod logs and only ever visible as an unreadable browser error.
        if (err.status >= 500) {
          log.error('http_error_5xx', {
            status: err.status,
            code: err.code,
            details: err.details ?? {},
            err,
          });
        }
        return errorResponse(
          {
            error: err.code,
            message: err.message,
            details: err.details ?? {},
            // Backwards-compatible top-level detail fields while clients migrate to `details`.
            ...(err.details ?? {}),
          },
          err.status,
        );
      }
      if (err instanceof ZodError) {
        return errorResponse(
          {
            error: 'validation',
            message: 'Request validation failed.',
            details: { issues: err.issues },
            issues: err.issues,
          },
          422,
        );
      }
      if (err instanceof UnauthorizedError) {
        return errorResponse({ error: 'unauthorized', message: err.message, details: {} }, 401);
      }
      throw err; // unexpected → server.ts 500
    }
  };
}
