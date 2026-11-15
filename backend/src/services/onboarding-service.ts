// src/services/onboarding-service.ts — Phase 4 / C.2a controlled-onboarding helpers.
//
// Email-domain auto-routing (spec §6.3): a corporate signup is matched to its tenant by
// email domain so it reaches the right tenant without self-service tenant creation; a
// free-mail signup (the free_email_providers blocklist) is never auto-routed and is held
// for explicit super_admin assignment. Pure DB — no Keycloak — so it is unit-testable.
import { and, eq } from 'drizzle-orm';
import {
  db as defaultDb,
  emailDomainTenants,
  freeEmailProviders,
} from '../db/client';

type Db = typeof defaultDb;

/** The bare, lower-cased domain of an email (the part after the last '@'), or null. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/**
 * The tenant a signup auto-routes to by its email domain, or null when it should be held
 * for explicit assignment:
 *   - no/invalid domain → null,
 *   - a free-mail provider (blocklist) → null,
 *   - a mapped corporate domain with `auto_assign` → that tenant; otherwise null.
 */
export async function matchTenantByEmail(
  email: string,
  db: Db = defaultDb,
): Promise<string | null> {
  const domain = emailDomain(email);
  if (!domain) return null;

  const [free] = await db
    .select({ domain: freeEmailProviders.domain })
    .from(freeEmailProviders)
    .where(eq(freeEmailProviders.domain, domain))
    .limit(1);
  if (free) return null;

  const [mapped] = await db
    .select({ tenantId: emailDomainTenants.tenant_id })
    .from(emailDomainTenants)
    .where(and(eq(emailDomainTenants.domain, domain), eq(emailDomainTenants.auto_assign, true)))
    .limit(1);
  return mapped?.tenantId ?? null;
}

// ---- self-signup queue admission (pure; the counts are passed IN) ----
//
// ⛔ THE CAP THIS REPLACES COULD BE USED TO LOCK REAL CUSTOMERS OUT. `notifySelf` refused with one
// number — a hardcoded 500 pending rows — and that refusal hit EVERY caller. The route is anonymous
// by design and the limiter in front of it is per-IP AND per-pod (middleware/rate-limit.ts says so
// in its own header: 2-4 replicas ⇒ 20-40/min fleet-wide on the tight anonymous bucket), so a
// distributed spray does not need to beat the limiter to hurt: it only needs to be patient. Fill the
// queue with 500 junk rows and the NEXT genuine signup — a domain-matched employee of a paying
// customer, arriving through the login bootstrap — gets the same 503 as the sprayer. The attacker
// pays nothing for that; the customer pays for all of it.
//
// So the ceiling is split in two, and the split is what makes the difference:
//   • `maxPending`          — the absolute table ceiling. Unchanged in value (500) and unchanged in
//                             meaning: past it NOTHING is accepted, because the operator's queue is
//                             genuinely full and admitting more helps nobody.
//   • `maxAnonymousPending` — a SUB-quota counted only over pending rows that carry NEITHER a realm
//                             identity NOR a matched tenant. Past it an ANONYMOUS, unmatched signup
//                             is refused while an identified one is still admitted. The difference
//                             between the two numbers is headroom no anonymous caller can consume,
//                             which is the whole point: spray all you like, the reserve is not
//                             yours to fill.
//
// ⚠️ "IDENTIFIED" IS NOT "TRUSTED", and the sub-quota is not an authentication check. A matched
// tenant means the address's domain is in `email_domain_tenants` with `auto_assign` — an attacker
// who knows a customer's corporate domain can mint matched rows. That is deliberate and it is still
// strictly better than today: those rows land in the RESERVE, are visibly attributed to one tenant
// in the queue, and cannot exhaust the reserve of any OTHER tenant's employees, whereas today one
// sprayer exhausts everybody at once. The residual — a targeted flood against one known domain — is
// bounded by `maxPending` exactly as it is now.

/** How much of `maxPending` anonymous, unmatched rows may occupy when the sub-quota is not set
 *  explicitly. 0.8 leaves a fifth of the table as reserve; it is a default, not a constant of
 *  nature — `SIGNUP_QUEUE_MAX_ANON_PENDING` overrides it outright. */
const ANONYMOUS_PENDING_SHARE = 0.8;

/**
 * An INTEGER from the environment, or the fallback — and a non-integer is REFUSED, not truncated.
 *
 * ⛔ `Number.parseInt` ALONE IS A TRAP HERE, AND THE TRAP HAS THE WORST POSSIBLE FAILURE. It reads
 * as much of a numeric prefix as it can and discards the rest, so `"0.8"` → `0` and
 * `SIGNUP_QUEUE_MAX_ANON_PENDING=0.8` — set by an operator who read `ANONYMOUS_PENDING_SHARE = 0.8`
 * two screens up and reasonably assumed the knob took the same units — silently becomes
 * REFUSE EVERY ANONYMOUS SIGNUP. That is a total outage of the public signup surface produced by a
 * plausible typo, announced by nothing. `"80%"` → `80` and `"1e3"` → `1` are the same defect wearing
 * other clothes. Anything that is not an integer falls back to the documented default instead, which
 * is the only answer that cannot be silently wrong.
 *
 * ⚠️ THE FALLBACK IS NOT "SAFE" BY ITSELF — it is safe because both defaults are the values this
 * function's callers document, so a rejected value leaves the deployment at its documented
 * behaviour rather than at some third state. `""` and `undefined` fail the test and take the same
 * path, which is what makes an unset variable mean "default" rather than "0".
 */
function envInt(raw: string | undefined, fallback: number): number {
  const s = (raw ?? '').trim();
  if (!/^[+-]?\d+$/.test(s)) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : fallback;
}

export interface SignupQueueLimits {
  /** Pending rows of ANY shape past which nothing is accepted. */
  readonly maxPending: number;
  /** Pending anonymous+unmatched rows past which only IDENTIFIED signups are accepted. */
  readonly maxAnonymousPending: number;
}

/**
 * The two ceilings, read from the environment ON EVERY CALL.
 *
 * ⚠️ CALL TIME, NOT MODULE LOAD, AND THAT IS THE POINT OF THE WHOLE CHANGE. The number this
 * replaces was a `const` in routes/onboarding.ts, so the only way to raise it while a queue was
 * actually full was to build, push and roll out an image — i.e. the lever was unusable at exactly
 * the moment it was needed. Reading `process.env` per request costs nothing measurable next to the
 * `COUNT(*)` this feeds, and it is also what lets a test drive the ceilings without a 500-row
 * fixture. `middleware/rate-limit.ts:ruleFor` reads its own limits the same way, for the same
 * reason; `config.ts` is deliberately NOT used here because its values are frozen at import.
 *
 * Clamps, and why each one is not padding:
 *   • `maxPending` ≥ 1 — a 0 would refuse every signup forever with `signup_queue_full`, a total
 *     outage of the surface configured by a typo. An operator who wants that closes the route.
 *   • `maxAnonymousPending` ≥ 0 — 0 IS meaningful and is the emergency lever: refuse all anonymous
 *     intake, keep serving matched/authenticated signups. It must survive the clamp.
 *   • `maxAnonymousPending` ≤ `maxPending` — above the table ceiling the sub-quota can never be
 *     reached, so it would be a knob that silently does nothing.
 */
export function signupQueueLimits(env: NodeJS.ProcessEnv = process.env): SignupQueueLimits {
  const maxPending = Math.max(1, envInt(env.SIGNUP_QUEUE_MAX_PENDING, 500));
  const derived = Math.floor(maxPending * ANONYMOUS_PENDING_SHARE);
  const maxAnonymousPending = Math.min(
    maxPending,
    Math.max(0, envInt(env.SIGNUP_QUEUE_MAX_ANON_PENDING, derived)),
  );
  return { maxPending, maxAnonymousPending };
}

export interface SignupQueueCounts {
  /** Every pending row. */
  readonly pending: number;
  /** Pending rows with no `keycloak_sub` AND no `matched_tenant_id`. */
  readonly anonymousPending: number;
}

/**
 * `commonpractice_signup_queue_refused_total{reason="…"}` — the ONLY thing a Prometheus rule can
 * see about this refusal. Both arms `log.warn`, and gitops-production's rules record that loki has
 * no `ruler` stanza, so log-based alerting cannot fire: without this counter "the queue is refusing
 * signups" is unpageable, and the two arms are indistinguishable at any distance.
 *
 * ⚠️ HAND-MIRRORED INTO `PRESEEDED_LABELLED_COUNTERS` in host/metrics.ts, which cannot import this
 * module. `incLabelledCounter` SILENTLY IGNORES an unregistered name or value, so a drift here is a
 * metric that reads 0 forever — see the drift pin in tests/signup-queue-headroom.test.ts.
 */
export const SIGNUP_QUEUE_REFUSED_COUNTER = 'signup_queue_refused_total';
export const SIGNUP_QUEUE_REFUSAL_REASONS = ['queue_full', 'anonymous_quota'] as const;
export type SignupQueueRefusalReason = (typeof SIGNUP_QUEUE_REFUSAL_REASONS)[number];

export type SignupQueueVerdict =
  | { readonly admit: true }
  | {
      readonly admit: false;
      readonly reason: SignupQueueRefusalReason;
      /** The count that hit the ceiling. */
      readonly observed: number;
      /** The ceiling it hit. */
      readonly cap: number;
    };

/**
 * Admit or refuse one self-signup, given the queue as it stands.
 *
 * `identified` is TRUE when the request carries an authenticated identity (a token `validateAuth`
 * accepted, even one with no `tenant_id` yet — an SSO first login is exactly that) OR when the
 * address auto-matched a tenant by domain. Those are the two shapes the reserve exists for; an
 * anonymous address on an unmapped or free-mail domain is not one of them.
 *
 * ⛔ THE TOTAL CEILING IS CHECKED FIRST AND THAT ORDER IS LOAD-BEARING. Reversing it would let an
 * identified caller past a genuinely full table — 500 rows is 500 rows regardless of who is asking,
 * and `signup_queue_full` must keep meaning exactly what it means today or the frontend register
 * entry and every operator reading it become wrong.
 */
export function signupQueueVerdict(
  counts: SignupQueueCounts,
  identified: boolean,
  limits: SignupQueueLimits,
): SignupQueueVerdict {
  if (counts.pending >= limits.maxPending) {
    return { admit: false, reason: 'queue_full', observed: counts.pending, cap: limits.maxPending };
  }
  if (!identified && counts.anonymousPending >= limits.maxAnonymousPending) {
    return {
      admit: false,
      reason: 'anonymous_quota',
      observed: counts.anonymousPending,
      cap: limits.maxAnonymousPending,
    };
  }
  return { admit: true };
}

// ---- self-signup approval: the default workspace name ----
//
// George 2026-10-14: an early-access approval may omit `tenantName`. The default is the company the
// requester named; else their email domain — UNLESS that is a public mailbox provider, where the
// domain names Google, not the customer, and the requester's own name is used instead. createTenant
// slugifies whatever this returns.

/** Public mailbox providers that never name a customer. The `free_email_providers` table (operator-
 *  maintained, empty by default) is consulted IN ADDITION, so an operator can extend it without a
 *  deploy; this floor exists so `gmail.com` can never become a workspace called "gmail". */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.com',
  'zoho.com', 'yandex.com', 'yandex.ru', 'hey.com', 'fastmail.com', 'tutanota.com', 'tuta.io',
  'qq.com', '163.com', 'ziggo.nl', 'kpnmail.nl', 'hetnet.nl', 'planet.nl', 'telenet.be', 'orange.fr',
  'free.fr', 'laposte.net', 't-online.de',
]);

/** Every public mailbox domain: the built-in floor plus the operator's `free_email_providers`. */
export async function loadPublicEmailDomains(db: Db = defaultDb): Promise<Set<string>> {
  const rows = await db.select({ domain: freeEmailProviders.domain }).from(freeEmailProviders);
  return new Set([...PUBLIC_EMAIL_DOMAINS, ...rows.map((r) => r.domain.trim().toLowerCase())]);
}

/** Second-level labels that sit under a country TLD (`acme.co.uk`, `acme.com.au`). */
const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'ltd', 'plc']);

/** `mail.acme.co.uk` → `acme`. The registrable label, without a public-suffix list (good enough for
 *  a DEFAULT the super_admin sees before confirming). */
export function organisationLabel(domain: string): string {
  const labels = domain.trim().toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 1) return labels[0] ?? '';
  labels.pop(); // TLD
  if (labels.length > 1 && SECOND_LEVEL_LABELS.has(labels[labels.length - 1]!)) labels.pop();
  return labels[labels.length - 1] ?? '';
}

/** A usable display name: trimmed, ≤120 chars, and slugifiable to something non-empty. */
function usable(v: string | null | undefined): string | null {
  const t = (v ?? '').trim().slice(0, 120).trim();
  return t.length >= 2 && /[a-z0-9]/i.test(t) ? t : null;
}

/**
 * The default workspace name for a self-signup approval: company → email domain's organisation
 * label (not for a public mailbox provider) → the requester's name → the email local part.
 * Synchronous over a preloaded `publicDomains` set so a queue listing costs one query, not one per row.
 */
export function defaultTenantNameFrom(
  signup: { company?: string | null; email: string; name?: string | null },
  publicDomains: ReadonlySet<string>,
): string {
  const company = usable(signup.company);
  if (company) return company;
  const domain = emailDomain(signup.email);
  if (domain && !publicDomains.has(domain)) {
    const label = usable(organisationLabel(domain));
    if (label) return label;
  }
  const name = usable(signup.name);
  if (name) return name;
  const local = signup.email.slice(0, Math.max(0, signup.email.lastIndexOf('@')));
  return usable(local) ?? 'workspace';
}

/** `defaultTenantNameFrom` for one signup, loading the public-domain set. */
export async function defaultTenantName(
  signup: { company?: string | null; email: string; name?: string | null },
  db: Db = defaultDb,
): Promise<string> {
  return defaultTenantNameFrom(signup, await loadPublicEmailDomains(db));
}
