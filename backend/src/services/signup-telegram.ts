// src/services/signup-telegram.ts — tell George about early-access signups in Telegram.
//
// Bot @nonagenticaibot, chat TELEGRAM_SIGNUP_CHAT_ID, forum topic TELEGRAM_SIGNUP_THREAD_ID (the
// "CP signups" topic — NOT 167, which is reserved for external-probe alarms). Three messages:
//   • a NEW pending signup from a TRUSTED source (insert only — a de-duplicated re-submit sends
//     nothing; trusted = the authenticated intake, a verified-email notify-self, or a notify-self
//     that passed Turnstile — see routes/onboarding.ts `admitAndRecord`). It names the requester
//     (name, email, company, language, a message excerpt) and carries two rows of buttons:
//       1. CALLBACK buttons Approve / Reject (`callback_data` = `ea1:cp:a|r:<signupId>`, contract
//          C1 of early-access v2, docs/runbooks/early-access-signup.md §1). Telegram delivers the
//          tap to chat-bridge — the bot's ONLY update consumer — which checks the tapper is an approver and calls CP's
//          POST /api/signup-approvals/:id/telegram-decision with its own service-account token
//          (middleware/signup-decider-auth.ts). CP never receives Telegram updates itself.
//       2. a URL button "Open in CommonPractice" → the super_admin onboarding screen for that signup.
//   • a follow-up when the signup is approved/rejected: outcome, requester, workspace, who decided,
//     and every provisioning step that did not finish `ok`.
//   • a periodic DIGEST of untrusted signups (anonymous notify-self without Turnstile): counts and a
//     link to the queue, at most one per SIGNUP_DIGEST_INTERVAL_HOURS (host/signup-digest-scheduler.ts).
//     Those signups are still queued; they just cannot make George's phone buzz one by one.
//
// PERSONAL DATA (George 2026-10-19, early-access v2): the new-signup and decision messages DO carry
// the requester's name, email, company and a message excerpt — the topic is George's private chat
// and approving from Telegram needs to know who is asking. The digest still carries counts only
// (its rows are untrusted, i.e. anyone can type anything into them). Every requester-typed value is
// rendered inside a Telegram `code` entity on one line (see `Message`).
//
// ⛔ SEND ONLY. CP never calls setWebhook / deleteWebhook / getUpdates: the bot's webhook belongs to
// chat-bridge, and claiming updates here would silently break that consumer.
// tests/signup-early-access.test.ts greps backend/src for those method names.
//
// ⛔ FIRE-AND-FORGET. `notify*` return immediately; the send runs detached with a bounded retry and
// every failure is logged, never thrown. A Telegram outage must never block or fail a signup or a
// decision. The bot token is never logged (it is part of the API URL, so errors are redacted).
import { signupTelegramConfig } from '../config';
import { log } from '../host/logger';
import { incLabelledCounter } from '../host/metrics';
import { publicAppUrl } from './invite-service';
import { singleLine } from '../utils/untrusted-text';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchFn | undefined;
let sleepImpl: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms);

/** Test seam: replace the HTTP client (undefined restores the real `fetch`). Tests MUST set this —
 *  no test may reach api.telegram.org. */
export function __setTelegramFetchForTests(fn: FetchFn | undefined): void {
  fetchImpl = fn;
}
/** Test seam: make retry backoff instant. */
export function __setTelegramSleepForTests(fn: ((ms: number) => Promise<void>) | undefined): void {
  sleepImpl = fn ?? ((ms) => Bun.sleep(ms));
}

const inflight = new Set<Promise<void>>();
/** Await every detached send started so far (a one-shot script must, before it exits). */
export async function drainSignupTelegram(): Promise<void> {
  while (inflight.size > 0) await Promise.allSettled([...inflight]);
}
/** Test seam: same as `drainSignupTelegram`. */
export const __drainSignupTelegramForTests = drainSignupTelegram;

export const SIGNUP_TELEGRAM_COUNTER = 'signup_telegram_send_total';

/** Attempts per message (first + retries) and the backoff before each retry. */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 4_000];
/** Ceiling on honouring Telegram's `retry_after` (429), so a detached send cannot linger for minutes. */
const MAX_RETRY_AFTER_MS = 30_000;
const SEND_TIMEOUT_MS = 10_000;

/** One line at boot: whether signup notifications are on, and which setting is missing if not. */
export function logSignupTelegramStatus(): void {
  const cfg = signupTelegramConfig();
  if (cfg.enabled) {
    log.info('signup_telegram_enabled', {
      component: 'signup-telegram',
      chatId: cfg.chatId,
      threadId: cfg.threadId,
    });
    return;
  }
  const missing = [
    !cfg.botToken && 'TELEGRAM_BOT_TOKEN',
    !cfg.chatId && 'TELEGRAM_SIGNUP_CHAT_ID',
    !cfg.threadId && 'TELEGRAM_SIGNUP_THREAD_ID',
  ].filter(Boolean);
  log.info('signup_telegram_disabled', { component: 'signup-telegram', missing });
}

/** Why a new pending signup is trusted enough to interrupt George (routes/onboarding.ts). */
export type SignupTrust = 'intake' | 'verified_email' | 'turnstile';

const TRUST_LABEL: Record<SignupTrust, string> = {
  intake: 'website/chat intake (service account)',
  verified_email: 'signed-in user with a verified email',
  turnstile: 'Turnstile challenge passed',
};

/** The C1 callback_data prefix and app key: `ea1:cp:<a|r>:<signupId>` (≤ 64 bytes for a uuid). */
export const SIGNUP_CALLBACK_PREFIX = 'ea1:cp';

/** The callback_data of an inline decision button (contract C1). */
export function signupCallbackData(id: string, action: 'approve' | 'reject'): string {
  return `${SIGNUP_CALLBACK_PREFIX}:${action === 'approve' ? 'a' : 'r'}:${id}`;
}

/** Longest message excerpt shown (the stored message is ≤2000 chars, multi-line). */
export const MESSAGE_EXCERPT_MAX = 300;

export interface NewSignupNotice {
  id: string;
  /** Which trusted path admitted it. Untrusted signups are never sent one by one (see the digest). */
  trust: SignupTrust;
  /** Which form it came through (web / chat / app). */
  source: string | null;
  /** How many signups are pending now (this one included); null when unknown. */
  pendingTotal: number | null;
  /** Requester-typed — rendered inside `code` entities only. */
  email: string;
  name: string | null;
  company: string | null;
  /** The applicant's free text; an excerpt (≤ MESSAGE_EXCERPT_MAX, one line) is shown. */
  message?: string | null;
  /** 0121 — the requester's language, or null (not told → en). */
  locale?: string | null;
  /** The workspace the email DOMAIN routes to (`matched_tenant_id`), by name — George may prefer to
   *  seat them there (Open in CommonPractice). One-tap Approve still founds a new workspace. */
  matchedWorkspace?: string | null;
}

export interface SignupDecisionNotice {
  id: string;
  outcome: 'approved' | 'rejected';
  /** The requester (rendered inside `code` entities). */
  email?: string | null;
  name?: string | null;
  tenantId?: string | null;
  /** The workspace's final name / slug (after any auto-suffix). */
  tenantName?: string | null;
  tenantSlug?: string | null;
  /** Who decided: `Telegram (<user id>)` or `CP onboarding screen`. */
  decidedVia?: string | null;
  /** True when the requester was seated (directly, or at approval with the email after the licence);
   *  false = an invite was sent instead. */
  seated?: boolean;
  /** Invite / set-password email delivery, when an invite was created. */
  inviteDelivery?: string | null;
  /** Provisioning steps whose status is not `ok` (step → status/code). */
  notOk?: Array<{ step: string; status: string; code: string | null }>;
}

export interface UnverifiedDigestNotice {
  /** Pending signups admitted through NO trusted path (anonymous, no Turnstile). */
  waiting: number;
  /** How many of those arrived since the previous digest. */
  newSinceLast: number;
}

/** The CP super_admin screen for one signup, with the decision dialog to open (approve when omitted). */
export function signupDeepLink(id: string, action?: 'approve' | 'reject'): string {
  return `${publicAppUrl()}/onboarding?signup=${encodeURIComponent(id)}${action ? `&action=${action}` : ''}`;
}

/** The CP super_admin signup queue. */
export function signupQueueLink(): string {
  return `${publicAppUrl()}/onboarding`;
}

/** Longest rendering of one single-line requester-typed field (the route caps name/company at 160). */
const FIELD_MAX = 200;

/** First `max` code points of `value` on one line, with `…` when cut. */
export function excerpt(value: string | null | undefined, max: number): string {
  const flat = Array.from(singleLine(value ?? ''));
  return flat.length > max ? `${flat.slice(0, max).join('')}…` : flat.join('');
}

/**
 * Plain text plus `code` entities around every REQUESTER-TYPED value. No parse_mode.
 *
 * ⛔ WHY ENTITIES AND NOT JUST "NO parse_mode". Plain text already stops markup injection, but
 * Telegram still auto-links anything URL-shaped (`evil.example/approve`, `t.me/…`) in plain text,
 * and `link_preview_options` only suppresses the preview card, not the link. A `code` entity cannot
 * contain other entities, so a URL inside one renders as inert monospace. Every untrusted value is
 * also forced onto ONE line (`singleLine`) — the stored value is already clean for new rows, but
 * rows written by other paths reach this renderer too, and a newline could forge a line of the
 * message (a fake "Trusted via:" line). Entity offsets are UTF-16 code units, which is exactly what
 * a JS string's `.length` counts.
 */
class Message {
  text = '';
  readonly entities: Array<{ type: 'code'; offset: number; length: number }> = [];

  plain(s: string): this {
    this.text += s;
    return this;
  }

  /** One labelled line whose value is untrusted. Empty → an em dash, outside any entity. */
  field(label: string, value: string | null | undefined, max = FIELD_MAX): this {
    const v = excerpt(value, max);
    this.text += `${label}: `;
    if (!v) return this.plain('—\n');
    this.entities.push({ type: 'code', offset: this.text.length, length: v.length });
    this.text += v;
    return this.plain('\n');
  }
}

function basePayload(cfg: ReturnType<typeof signupTelegramConfig>, m: Message): Record<string, unknown> {
  const text = m.text.replace(/\n+$/, '');
  return {
    chat_id: cfg.chatId,
    message_thread_id: Number(cfg.threadId),
    text,
    // Trailing newlines are trimmed AFTER the last entity, so no offset moves.
    entities: m.entities,
    link_preview_options: { is_disabled: true },
  };
}

/** First line of a new-signup message. */
export const NEW_SIGNUP_HEADLINE = 'New CommonPractice early-access signup';

/** The sendMessage payload for a new signup (exported for tests). No parse_mode — see `Message`. */
export function newSignupPayload(n: NewSignupNotice, cfg = signupTelegramConfig()): Record<string, unknown> {
  const m = new Message()
    .plain(`${NEW_SIGNUP_HEADLINE}\n\n`)
    .field('Name', n.name)
    .field('Email', n.email)
    .field('Company', n.company);
  if (n.matchedWorkspace) {
    m.field('Matches workspace', n.matchedWorkspace).plain(
      '  (email domain; Approve here still creates a NEW workspace — open in CommonPractice to seat them there)\n',
    );
  }
  m.plain(`Source: ${n.source ?? '—'}\n`)
    .plain(`Language: ${n.locale ?? '— (en)'}\n`)
    .plain(`Trusted via: ${TRUST_LABEL[n.trust]}\n`);
  if (n.message && singleLine(n.message)) m.field('Message', n.message, MESSAGE_EXCERPT_MAX);
  m.plain(`Pending signups: ${n.pendingTotal ?? '—'}\n`)
    .plain(`Signup id: ${n.id}\n\n`)
    .plain(
      'Approve creates the workspace now (default name, local model) and emails the set-password link. ' +
        'Open in CommonPractice to choose a name or plan first.',
    );
  return {
    ...basePayload(cfg, m),
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Approve', callback_data: signupCallbackData(n.id, 'approve') },
          { text: 'Reject', callback_data: signupCallbackData(n.id, 'reject') },
        ],
        [{ text: 'Open in CommonPractice', url: signupDeepLink(n.id) }],
      ],
    },
  };
}

/** The sendMessage payload for a decision (exported for tests). */
export function decisionPayload(d: SignupDecisionNotice, cfg = signupTelegramConfig()): Record<string, unknown> {
  const m = new Message().plain(`CommonPractice signup ${d.outcome}\n\n`);
  if (d.name !== undefined || d.email !== undefined) {
    m.field('Name', d.name).field('Email', d.email);
  }
  if (d.decidedVia) m.plain(`Decided via: ${d.decidedVia}\n`);
  if (d.outcome === 'approved') {
    if (d.tenantName !== undefined || d.tenantSlug !== undefined) {
      m.field('Workspace', d.tenantName).field('Slug', d.tenantSlug);
    }
    m.plain(`Tenant id: ${d.tenantId ?? '—'}\n`);
    if (d.seated !== undefined) {
      if (d.seated && d.inviteDelivery) {
        m.plain(
          d.inviteDelivery === 'deferred'
            ? 'Requester seated as tenant admin; the set-password email follows once their licence exists.\n'
            : `Requester seated as tenant admin; set-password email sent (${d.inviteDelivery}).\n`,
        );
      } else {
        m.plain(
          d.seated
            ? 'Requester seated as tenant admin.\n'
            : `Invite sent (email delivery: ${d.inviteDelivery ?? 'unknown'}).\n`,
        );
      }
    }
    const notOk = d.notOk ?? [];
    if (notOk.length === 0) {
      m.plain('Provisioning: all steps ok.\n');
    } else {
      m.plain('Provisioning steps NOT ok:\n');
      for (const s of notOk) m.plain(`  - ${s.step}: ${s.status}${s.code ? ` (${s.code})` : ''}\n`);
    }
  }
  m.plain(`Signup id: ${d.id}`);
  return basePayload(cfg, m);
}

/** The sendMessage payload for the unverified-signup digest (exported for tests). Counts only —
 *  nothing a requester typed appears in it. */
export function digestPayload(d: UnverifiedDigestNotice, cfg = signupTelegramConfig()): Record<string, unknown> {
  const m = new Message().plain(
    `${d.waiting} unverified CommonPractice signup${d.waiting === 1 ? '' : 's'} waiting ` +
      `(${d.newSinceLast} new since the last digest).\n\n` +
      'These came through the anonymous notify-self form without a Turnstile check, so they are not ' +
      'announced one by one. Review them in the CP signup queue.',
  );
  return {
    ...basePayload(cfg, m),
    reply_markup: { inline_keyboard: [[{ text: 'Open signup queue', url: signupQueueLink() }]] },
  };
}

/** Fire-and-forget: a new pending signup. No-op when unconfigured. */
export function notifyNewSignup(n: NewSignupNotice): void {
  const cfg = signupTelegramConfig();
  if (!cfg.enabled) return;
  detach('new_signup', cfg, () => newSignupPayload(n, cfg));
}

/** Fire-and-forget: a signup was approved / rejected. No-op when unconfigured. */
export function notifySignupDecision(d: SignupDecisionNotice): void {
  const cfg = signupTelegramConfig();
  if (!cfg.enabled) return;
  detach('decision', cfg, () => decisionPayload(d, cfg));
}

/** Fire-and-forget: the periodic unverified-signup digest (host/signup-digest-scheduler.ts). */
export function notifyUnverifiedDigest(d: UnverifiedDigestNotice): void {
  const cfg = signupTelegramConfig();
  if (!cfg.enabled) return;
  detach('digest', cfg, () => digestPayload(d, cfg));
}

function detach(
  kind: 'new_signup' | 'decision' | 'digest',
  cfg: ReturnType<typeof signupTelegramConfig>,
  build: () => Record<string, unknown>,
): void {
  const p = (async () => {
    try {
      await sendWithRetry(kind, cfg, build());
    } catch (err) {
      // sendWithRetry never throws by design; this is the belt for a bug in it.
      log.error('signup_telegram_send_crashed', { component: 'signup-telegram', kind, err: redact(err, cfg.botToken) });
    }
  })();
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

function redact(err: unknown, token: string): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return token ? text.split(token).join('<redacted>') : text;
}

async function sendWithRetry(
  kind: string,
  cfg: ReturnType<typeof signupTelegramConfig>,
  payload: Record<string, unknown>,
): Promise<void> {
  const url = `${cfg.apiBase}/bot${cfg.botToken}/sendMessage`;
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let waitMs = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1)!;
    try {
      const res = await (fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (res.ok) {
        incLabelledCounter(SIGNUP_TELEGRAM_COUNTER, `${kind}_ok`);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        description?: string;
        parameters?: { retry_after?: number };
      };
      lastError = `HTTP ${res.status}${body.description ? `: ${body.description}` : ''}`;
      // 4xx other than 429 is a configuration fault (bad chat/thread id, bot not in the chat, revoked
      // token): retrying cannot fix it.
      if (res.status !== 429 && res.status < 500) break;
      if (res.status === 429 && typeof body.parameters?.retry_after === 'number') {
        waitMs = Math.min(body.parameters.retry_after * 1000, MAX_RETRY_AFTER_MS);
      }
    } catch (err) {
      lastError = redact(err, cfg.botToken);
    }
    if (attempt < MAX_ATTEMPTS) await sleepImpl(waitMs);
  }
  incLabelledCounter(SIGNUP_TELEGRAM_COUNTER, `${kind}_failed`);
  log.warn('signup_telegram_send_failed', {
    component: 'signup-telegram',
    kind,
    error: lastError.split(cfg.botToken).join('<redacted>'),
    hint: 'the signup itself is recorded; check TELEGRAM_* config and the bot membership of the chat',
  });
}
