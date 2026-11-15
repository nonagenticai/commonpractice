// src/routes/me.ts — the current-user profile endpoints.
//   GET   /api/me           — the authenticated user, their CP membership (tenant + level, or none
//                             plus their pending invites) and their persisted UI locale
//   PATCH /api/me/locale    — persist the UI locale preference (§5B)
// Locale lives on users.locale; the frontend also mirrors it to localStorage +
// cookie via Paraglide, so this is the cross-device + server-side source of truth.
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  users,
  tenants,
  challenges,
  solutions,
  sandboxes,
  informationRequests,
  runAsSystem,
  refreshTenantGuc,
} from '../db/client';
import { authenticateWithoutLicense, validateAuth } from '../middleware/auth';
import { canonicalTenantId, isDeveloper, isSuperAdmin } from '../middleware/admin-guards';
import { pendingInvitesFor, type PendingInviteView } from '../services/invite-service';
import { HttpError, jsonResponse, readJson, route } from '../utils/http';
import { SUPPORTED_LOCALES, negotiateLocale, type Locale } from '../utils/locale';
import type { Router } from '../utils/router';
import { requestTenantId, resolveCadence } from '../host/cycle-cadence';
import { supportEmail } from '../config';
import type { TenantRole, User } from '../types';

const localePatchSchema = z.object({ locale: z.enum(SUPPORTED_LOCALES) }).strict();

export interface NavCounts {
  challenges: number;
  solutions: number;
  /** Omitted entirely for a non-super_admin — see below. */
  sandboxes?: number;
  /** W8/P5: pending information requests — present ONLY for a reviewer (tenant_admin / developer /
   *  super_admin), who is the one the /requests page serves. Counted under the caller's RLS scope,
   *  the same scope as `GET /api/information-requests`. */
  requests?: number;
}

/**
 * Live counts for the sidebar badges (these were hardcoded demo placeholders before).
 *
 * ⚠️ EACH BADGE MUST BE COUNTED IN THE SCOPE OF THE PAGE IT LINKS TO, not in the scope that
 * happens to be convenient here. Two of the three are tenant-scoped, one is not:
 *
 *  • `challenges` — `GET /api/challenges` applies NO default status filter, so this unfiltered,
 *    RLS-scoped `count(*)` matches its destination's own `total` exactly. ⛔ DO NOT "align" it to
 *    home's `ne(status,'closed')`: that would make the badge disagree with the page it opens.
 *    Pinned by backend/tests/nav-counts.test.ts.
 *  • `solutions` — `GET /api/solutions` is `validateAuth` under caller RLS. Same scope. Correct.
 *  • `sandboxes` — `GET /api/sandboxes` is `requireSuperAdmin` + `runAsSystem`, i.e. CROSS-TENANT.
 *    Counting it under RLS reported the caller's own tenant's sandboxes next to a page listing the
 *    whole fleet (prod: badge 7, page more). It is counted under `runAsSystem` here, and ONLY for a
 *    super_admin: the nav item is super_admin-gated anyway, and shipping a fleet-wide total into
 *    every member's `/api/me` would leak platform volume to people who cannot open the page. For
 *    everyone else the key is ABSENT (not 0) — Sidebar renders only positive numbers, so an absent
 *    key is already the "no badge" state and needs no component change.
 */
async function navCounts(user: User, tenantScoped = true): Promise<NavCounts> {
  // `tenantScoped=false`: the request's RLS scope is NOT the caller's (a rejected scope-switch with
  // no home tenant to fall back to — see `authenticateForMe`), so a tenant count would be about the
  // tenant that was just refused. Report none rather than that.
  const [ch, sol] = tenantScoped
    ? await Promise.all([
        db.select({ n: sql<number>`count(*)::int` }).from(challenges),
        db.select({ n: sql<number>`count(*)::int` }).from(solutions),
      ])
    : [[], []];
  const counts: NavCounts = { challenges: ch[0]?.n ?? 0, solutions: sol[0]?.n ?? 0 };
  if (tenantScoped && isDeveloper(user)) {
    const [rq] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(informationRequests)
      .where(eq(informationRequests.status, 'pending'));
    counts.requests = rq?.n ?? 0;
  }
  if (isSuperAdmin(user)) {
    const sb = await runAsSystem('platform-admin', () =>
      db.select({ n: sql<number>`count(*)::int` }).from(sandboxes),
    );
    counts.sandboxes = sb[0]?.n ?? 0;
  }
  return counts;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE_TENANT_HEADER = 'X-Active-Tenant-Id';

/** Refusals that say nothing permanent about the tenant — they clear without anyone acting. */
const TRANSIENT_CODES = new Set(['license_unavailable', 'tenant_status_unavailable']);
export function isTransientRefusal(err: HttpError): boolean {
  return err.status === 429 || err.status >= 500 || TRANSIENT_CODES.has(err.code);
}

/**
 * Authenticate `GET /api/me` — the SPA's identity bootstrap — without letting a STALE scope-switch
 * brick it.
 *
 * ⛔ THE BUG (prod E2E 2026-10-14). A super_admin's "acting as" choice lives in the browser
 * (`cp.activeTenant`) and rides on every request as `X-Active-Tenant-Id`. `validateAuth` judges a
 * scope-switched super_admin against THAT tenant (Gate 2), so once the tenant was offboarded — its
 * licence revoked — `/api/me` answered `402`, `auth.initialize` failed, and the SPA could not start
 * at all: no shell, so no "return to my tenant" button either. The only way out was DevTools.
 *
 * So for a super_admin carrying the header, the acting tenant is judged ON ITS OWN first: malformed,
 * unprovisioned, offboarded, or refused by the gates `validateAuth` runs (licence, …) for a
 * PERMANENT reason — a transient one (`isTransientRefusal`: licences outage, 429, 5xx) is re-thrown
 * and leaves the selection alone. If it is unusable, this request falls back to exactly what a header-less request would get — `validateAuth`
 * against the home tenant, and the RLS scope moved back to it — and the refusal code is RETURNED
 * (`activeTenantRejected`) so the SPA drops the stale selection instead of sending it forever.
 *
 * What this does NOT relax: every data route still runs `validateAuth` with the header and still
 * 402s/403s an unusable acting tenant exactly as before; `/api/me` only stops ACTING AS it. A
 * non-super_admin's header is inert everywhere (probe-resistance), so for them this is plain
 * `validateAuth` — no extra query, no different answer.
 */
async function authenticateForMe(
  req: Request,
): Promise<{ user: User; activeTenantRejected: string | null; tenantScoped: boolean }> {
  const header = req.headers.get(ACTIVE_TENANT_HEADER);
  if (!header) return { user: await validateAuth(req), activeTenantRejected: null, tenantScoped: true };
  const raw = await authenticateWithoutLicense(req);
  if (!isSuperAdmin(raw)) {
    return { user: await validateAuth(req), activeTenantRejected: null, tenantScoped: true };
  }
  let reason: string | null = null;
  if (!UUID_RE.test(header)) {
    reason = 'INVALID_ACTIVE_TENANT_HEADER';
  } else {
    const [row] = await runAsSystem('non-rls-table', () =>
      db
        .select({ offboardedAt: tenants.offboarded_at })
        .from(tenants)
        .where(eq(tenants.id, canonicalTenantId(header)))
        .limit(1),
    );
    if (!row) reason = 'tenant_not_provisioned';
    else if (row.offboardedAt) reason = 'tenant_offboarded';
  }
  if (!reason) {
    try {
      return { user: await validateAuth(req), activeTenantRejected: null, tenantScoped: true };
    } catch (err) {
      // Identity already succeeded above, so an HttpError here is a verdict about the ACTING tenant
      // (a super_admin is judged against nothing else while scope-switched). Anything else is real.
      if (!(err instanceof HttpError)) throw err;
      // ⛔ A TRANSIENT refusal is NOT a verdict on the tenant, and must not cost the operator their
      // selection: the SPA drops it for good on `activeTenantRejected`. A licences outage
      // (`license_unavailable`), a 429 or any 5xx re-throws, so /api/me fails the way every other
      // route does during that outage and the selection survives it.
      if (isTransientRefusal(err)) throw err;
      reason = err.code;
    }
  }
  // Fall back to the header-less request: same identity, judged against the home tenant.
  const headers = new Headers(req.headers);
  headers.delete(ACTIVE_TENANT_HEADER);
  const user = await validateAuth(new Request(req.url, { method: req.method, headers }));
  // The server wrapper pre-set the RLS scope from the header; move it back to the home tenant.
  const home = user.tenantId ? canonicalTenantId(user.tenantId) : null;
  if (home) await refreshTenantGuc(home);
  return { user, activeTenantRejected: reason, tenantScoped: home !== null };
}

const me = route(async (req) => {
  // `validateAuth` admits a caller with no workspace: both of its gates return early when there is
  // no tenant to judge, so this answers 200 for a signed-in person who has not joined anything yet.
  const { user, activeTenantRejected, tenantScoped } = await authenticateForMe(req);
  const [row] = await db
    .select({
      locale: users.locale,
      tenantId: users.tenant_id,
      tenantRole: users.tenant_role,
      deletedAt: users.deleted_at,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  // Stored preference wins; otherwise negotiate from Accept-Language.
  const locale = negotiateLocale(req, row?.locale);
  // Membership from CP's own row — never from the token.
  const live = row && !row.deletedAt ? row : undefined;
  const tenantId = live?.tenantId ?? null;
  const tenantRole: TenantRole | null = tenantId ? (live?.tenantRole ?? 'member') : null;
  const hasWorkspace = tenantId !== null;
  const superAdmin = isSuperAdmin(user);
  // Invites are offered only to a VERIFIED address (enforced inside `pendingInvitesFor`): an
  // unverified email proves nothing about who is asking.
  const pendingInvites: PendingInviteView[] =
    !hasWorkspace ? await pendingInvitesFor(user) : [];
  // Nav badges count tenant data; with no workspace there is none (and no RLS scope to count in).
  const counts: NavCounts =
    hasWorkspace || superAdmin
      ? await navCounts(user, tenantScoped)
      : { challenges: 0, solutions: 0 };
  return jsonResponse({
    ...user,
    tenantId,
    tenantRole,
    isSuperAdmin: superAdmin,
    hasWorkspace,
    pendingInvites,
    locale,
    counts,
    // The EFFECTIVE voting-cycle cadence (off | week | month | quarter | year). The sidebar hides the
    // winner screen when it is off — every page needs it, so it rides on /api/me.
    // 0110: the tenant this response is about (the request's RLS scope, re-pointed above).
    cycleCadence: (await resolveCadence(new Date(), requestTenantId())).effective,
    // The "Feedback" link's address (SUPPORT_EMAIL, config.ts supportEmail). null = unset: the SPA
    // hides the link rather than inventing an address.
    supportEmail: supportEmail(),
    // Non-null ONLY for a super_admin whose `X-Active-Tenant-Id` was refused (the code says why);
    // this response is then about their home tenant and the SPA must drop the selection.
    activeTenantRejected,
  });
});

const patchLocale = route(async (req) => {
  const user = await validateAuth(req);
  const { locale } = localePatchSchema.parse(await readJson(req));
  await db
    .update(users)
    .set({ locale, updated_at: new Date() })
    .where(eq(users.id, user.id));
  return jsonResponse({ locale: locale as Locale });
});

export function registerMeRoutes(router: Router): void {
  router.add('GET', '/api/me', me);
  router.add('PATCH', '/api/me/locale', patchLocale);
}
