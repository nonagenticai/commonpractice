// src/services/turnstile.ts — Cloudflare Turnstile verification for signup submissions.
//
// Policy (config.ts `turnstileConfig`):
//   • A submission that CARRIES a token is verified whenever TURNSTILE_SECRET is set — a token that
//     fails siteverify is refused (403 `turnstile_failed`), never silently ignored.
//   • `TURNSTILE_REQUIRED=true` additionally makes the token MANDATORY for anonymous/browser
//     submissions (`requireToken`). The server-to-server intake is not a browser and does not pass it.
//   • Required but no secret configured → 503 `turnstile_unconfigured` (fail closed: the operator
//     asked for a check that cannot run).
//   • siteverify unreachable / non-2xx → 503 `turnstile_unavailable` (fail closed; retryable).
//
// The fetch is injectable (`__setTurnstileFetchForTests`) so no test ever reaches Cloudflare.
import { turnstileConfig } from '../config';
import { HttpError, forbidden } from '../utils/http';
import { log } from '../host/logger';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchFn | undefined;

/** Test seam: replace the HTTP client (undefined restores the real `fetch`). */
export function __setTurnstileFetchForTests(fn: FetchFn | undefined): void {
  fetchImpl = fn;
}

export interface TurnstileCheck {
  /** The client's `cf-turnstile-response` token, if any. */
  token?: string | null;
  /** True when the token is mandatory for this submission (anonymous browser + TURNSTILE_REQUIRED). */
  requireToken: boolean;
  /** Optional end-user IP, forwarded to siteverify as `remoteip`. */
  remoteIp?: string | null;
}

export type TurnstileOutcome = 'verified' | 'skipped';

/** Verify per the policy above. Returns 'skipped' when nothing was (or could be) asked for. */
export async function enforceTurnstile(check: TurnstileCheck): Promise<TurnstileOutcome> {
  const cfg = turnstileConfig();
  const token = check.token?.trim() || '';
  const mandatory = check.requireToken && cfg.required;

  if (!cfg.secret) {
    if (mandatory) {
      log.error('turnstile_required_without_secret', {
        component: 'turnstile',
        hint: 'TURNSTILE_REQUIRED=true but TURNSTILE_SECRET is unset — every anonymous signup is refused',
      });
      throw new HttpError(
        503,
        'turnstile_unconfigured',
        'Sign-up verification is not available right now. Please try again later.',
      );
    }
    return 'skipped';
  }
  if (!token) {
    if (mandatory) {
      throw forbidden('turnstile_required', 'A verification challenge is required to sign up.');
    }
    return 'skipped';
  }

  const form = new URLSearchParams({ secret: cfg.secret, response: token });
  if (check.remoteIp) form.set('remoteip', check.remoteIp);
  let body: { success?: unknown; 'error-codes'?: unknown };
  try {
    const res = await (fetchImpl ?? fetch)(cfg.verifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`siteverify HTTP ${res.status}`);
    body = (await res.json()) as typeof body;
  } catch (err) {
    log.warn('turnstile_verify_unavailable', { component: 'turnstile', err });
    throw new HttpError(
      503,
      'turnstile_unavailable',
      'Sign-up verification is temporarily unavailable. Please try again shortly.',
    );
  }
  if (body.success !== true) {
    log.info('turnstile_verify_rejected', {
      component: 'turnstile',
      errorCodes: Array.isArray(body['error-codes']) ? body['error-codes'] : [],
    });
    throw forbidden('turnstile_failed', 'The verification challenge was not accepted. Please try again.');
  }
  return 'verified';
}

/** One line at boot: Turnstile on/off/required, and the fail-closed misconfiguration if any. */
export function logTurnstileStatus(): void {
  const cfg = turnstileConfig();
  if (cfg.required && !cfg.secret) {
    log.error('turnstile_required_without_secret', {
      component: 'turnstile',
      hint: 'TURNSTILE_REQUIRED=true but TURNSTILE_SECRET is unset — anonymous signups will be refused (503)',
    });
    return;
  }
  // Two literal-message calls, not a ternary: the message is the aggregation key and
  // logging-discipline.test.ts refuses a computed one.
  if (cfg.secret) {
    log.info('turnstile_enabled', { component: 'turnstile', requiredForAnonymous: cfg.required });
  } else {
    log.info('turnstile_disabled', { component: 'turnstile' });
  }
}
