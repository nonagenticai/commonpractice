// src/host/signup-digest-scheduler.ts — the periodic "K unverified signups waiting" Telegram digest.
//
// notify-self is OPEN (anyone, any address, a 10/min/IP bucket) and Turnstile ships off, so an
// anonymous signup without a passed Turnstile check is queued but NOT announced one by one
// (routes/onboarding.ts `admitAndRecord`, `signup_approvals.trust` IS NULL — migration 0106). This
// scheduler is how George still hears about them: at most ONE message per
// SIGNUP_DIGEST_INTERVAL_HOURS, counts only (nothing a requester typed), with a link to the queue.
//
// Mechanics:
//   • every replica polls every 15 min; a cheap read first asks "is there an untrusted pending row
//     the last digest did not count?" — if not, nothing is claimed and nothing is sent;
//   • otherwise it claims `TICK_LOCK.signupDigest` with a window of the digest interval. That
//     `scheduler_ticks` row is the rate limit: one digest per window across replicas AND restarts;
//   • the winner stamps `digested_at` on the new rows and sends. The send is fire-and-forget
//     (services/signup-telegram.ts): a failed send is counted (`digest_failed`) and NOT retried by
//     the next digest — the rows stay visible in the queue, which is the source of truth.
//
// Armed only when Telegram is enabled and the interval is > 0 (config.ts `signupDigestConfig`).
import { sql } from 'drizzle-orm';
import { db, runAsSystem } from '../db/client';
import { signupDigestConfig, signupTelegramConfig } from '../config';
import { log } from './logger';
import { claimTick, TICK_LOCK } from './tick-locks';
import { notifyUnverifiedDigest } from '../services/signup-telegram';

const POLL_MS = 15 * 60 * 1000;
let timer: ReturnType<typeof setTimeout> | null = null;

export type DigestOutcome = 'disabled' | 'nothing_new' | 'claimed_elsewhere' | 'sent';

async function hasNewUntrusted(): Promise<boolean> {
  const rows = (await runAsSystem('scheduler-tick', () =>
    db.execute(
      sql`SELECT EXISTS (
            SELECT 1 FROM signup_approvals
             WHERE status = 'pending' AND trust IS NULL AND digested_at IS NULL
          ) AS fresh`,
    ),
  )) as unknown as { fresh: boolean }[];
  return rows[0]?.fresh === true;
}

/** Stamp the new untrusted rows and count both populations in ONE statement. */
async function markAndCount(): Promise<{ waiting: number; fresh: number }> {
  const rows = (await db.execute(
    sql`WITH marked AS (
          UPDATE signup_approvals SET digested_at = now()
           WHERE status = 'pending' AND trust IS NULL AND digested_at IS NULL
          RETURNING 1
        )
        SELECT (SELECT count(*) FROM marked)::int AS fresh,
               (SELECT count(*) FROM signup_approvals
                 WHERE status = 'pending' AND trust IS NULL)::int AS waiting`,
  )) as unknown as { waiting: number; fresh: number }[];
  return rows[0] ?? { waiting: 0, fresh: 0 };
}

/** One poll. Exported for tests (and callable by hand); the timer below is boot-only. */
export async function runSignupDigestOnce(): Promise<DigestOutcome> {
  const { intervalHours } = signupDigestConfig();
  if (!signupTelegramConfig().enabled || intervalHours <= 0) return 'disabled';
  if (!(await hasNewUntrusted())) return 'nothing_new';
  const result = await claimTick({
    key: TICK_LOCK.signupDigest,
    minIntervalMs: Math.round(intervalHours * 60 * 60 * 1000),
    label: '[signup-digest] poll',
    skipCounter: null,
    // While unverified signups wait inside the window, every replica's 15-min poll is refused by
    // design until the window opens — that is the rate limit working, not a fault.
    refusal: 'expected',
    run: async () => {
      const { waiting, fresh } = await markAndCount();
      // A concurrent decision can have emptied the set between the read above and the claim.
      if (fresh === 0) return 'nothing_new' as const;
      notifyUnverifiedDigest({ waiting, newSinceLast: fresh });
      log.info('signup_digest_sent', { component: 'signup-digest', waiting, fresh });
      return 'sent' as const;
    },
  });
  return result ?? 'claimed_elsewhere';
}

/** Boot-only (server.ts). A no-op unless Telegram is enabled and the interval is > 0. */
export function startSignupDigest(): void {
  const { intervalHours } = signupDigestConfig();
  if (!signupTelegramConfig().enabled || intervalHours <= 0) {
    log.info('signup_digest_disabled', {
      component: 'signup-digest',
      telegramEnabled: signupTelegramConfig().enabled,
      intervalHours,
    });
    return;
  }
  const arm = (): void => {
    timer = setTimeout(() => {
      runSignupDigestOnce()
        .catch((err) => log.error('signup_digest_failed', { component: 'signup-digest', err }))
        .finally(arm);
    }, POLL_MS);
  };
  log.info('signup_digest_armed', { component: 'signup-digest', intervalHours });
  arm();
}

/** Stop the loop (tests / graceful shutdown). */
export function stopSignupDigest(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
