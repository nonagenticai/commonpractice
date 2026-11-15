// scripts/renotify-signup.ts — re-post the Telegram notice (with Approve/Reject buttons) for ONE
// pending early-access signup.
//
// Why: the notice is posted once, at insert. If a decision tap then fails and the message loses its
// buttons (chat-bridge before a7adec8 dropped them on ANY failure), or the message is deleted, the
// only way left to decide was a super_admin sign-in on /onboarding — the step the Telegram buttons
// exist to remove. This puts a fresh, tappable notice in the topic. It changes NOTHING in the
// database: a pending row stays pending, and the decision endpoint is idempotent, so two live
// notices for one signup cannot decide it twice.
//
//   bun run scripts/renotify-signup.ts <signupId>            # dry run: prints what it would post
//   bun run scripts/renotify-signup.ts <signupId> --apply    # posts it
//
// Exit: 0 ok · 1 usage / not found / not pending / Telegram notices disabled.
import { eq, sql } from 'drizzle-orm';
import { closeConnection, db, runAsSystem, tenants } from '../src/db/client';
import { signupApprovals } from '../src/db/schema';
import { signupTelegramConfig } from '../src/config';
import { drainSignupTelegram, notifyNewSignup, type NewSignupNotice, type SignupTrust } from '../src/services/signup-telegram';

/** Loads the notice for a PENDING signup; returns a reason string when there is nothing to post. */
export async function loadRenotice(signupId: string): Promise<NewSignupNotice | string> {
  return runAsSystem('platform-admin', async () => {
    const [row] = await db.select().from(signupApprovals).where(eq(signupApprovals.id, signupId)).limit(1);
    if (!row) return `signup ${signupId} not found`;
    if (row.status !== 'pending') return `signup ${signupId} is ${row.status}, not pending — nothing to decide`;
    if (row.trust === null) return `signup ${signupId} has no trust tier (unverified) — it was never notified`;
    const counted = (await db.execute(
      sql`SELECT COUNT(*)::int AS total FROM signup_approvals WHERE status = 'pending'`,
    )) as unknown as { total: number }[];
    const total = counted[0]?.total ?? null;
    const matchedWorkspace = row.matched_tenant_id
      ? ((await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, row.matched_tenant_id)))[0]?.name ?? null)
      : null;
    return {
      id: row.id,
      source: row.source,
      trust: row.trust as SignupTrust,
      pendingTotal: total,
      email: row.email,
      name: row.name,
      company: row.company,
      message: row.message,
      locale: row.locale,
      matchedWorkspace,
    };
  });
}

async function main(): Promise<number> {
  const [signupId] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const apply = process.argv.includes('--apply');
  if (!signupId) {
    console.error('usage: bun run scripts/renotify-signup.ts <signupId> [--apply]');
    return 1;
  }
  const notice = await loadRenotice(signupId);
  if (typeof notice === 'string') {
    console.error(`[renotify] ${notice}`);
    return 1;
  }
  console.log(`[renotify] signup ${notice.id} · ${notice.name ?? '-'} · ${notice.company ?? '-'} · locale ${notice.locale ?? '-'}`);
  if (!apply) {
    console.log('[renotify] DRY RUN — nothing posted. Re-run with --apply.');
    return 0;
  }
  if (!signupTelegramConfig().enabled) {
    console.error('[renotify] Telegram signup notices are disabled in this environment — nothing posted.');
    return 1;
  }
  notifyNewSignup(notice);
  await drainSignupTelegram();
  console.log('[renotify] posted (see the signup_telegram_send log line for the delivery result).');
  return 0;
}

if (import.meta.main) {
  let code = 1;
  try {
    code = await main();
  } finally {
    await closeConnection();
  }
  process.exit(code);
}
