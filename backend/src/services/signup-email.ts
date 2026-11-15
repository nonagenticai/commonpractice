// src/services/signup-email.ts — the ONE email an approved early-access requester gets
// (early-access v2, contracts C4 + C5, CP side).
//
// Keycloak sends it (execute-actions-email: UPDATE_PASSWORD [+ VERIFY_EMAIL]); its `nonagentic` email
// theme picks the CommonPractice variant from user attributes CP sets right before the send:
//
//   locale           the requester's language (signup_approvals.locale, else `en`) — Keycloak renders
//                    the email and the set-password page in it;
//   signup_app       `commonpractice` — selects the app partial (subject + body) in executeActions.ftl;
//   signup_book_url  the epub download link minted by book-fulfillment (services/book-links.ts), shown
//                    as the book block. Absent when the mint failed or is unconfigured: the email
//                    still goes out, just without it.
//
// After the send returns, `signup_book_url` is REMOVED again: it is a bearer download link and has
// no business living on the identity once the email is rendered. `locale` and `signup_app` stay
// (the first is the user's language; the second keeps a resend in the same variant).
//
// Every attribute write is a read-modify-write of the whole user (`updateUserAttributes`), so no
// other attribute — `tenant_id`, fr's — is lost.
//
// Ordering contract: the caller (`invite_email` provisioning step, services/tenant-provisioning.ts)
// runs this ONLY once the member licence exists. A throw here means the email did not go out; the
// step records it `pending` and the onboarding-integrity tick sends it later.
import { keycloakAdmin } from './keycloak-admin';
import { mintBookLink } from './book-links';
import { FRONTEND_CLIENT_ID, INVITE_TTL_MS, publicAppUrl } from './invite-service';
import { DEFAULT_SIGNUP_LOCALE, normaliseSignupLocale } from '../utils/signup-locale';
import { log } from '../host/logger';

/** `signup_app` value for CommonPractice (the email theme's `apps/<app>` partial). */
export const SIGNUP_APP = 'commonpractice';

export interface SignupEmailInput {
  tenantId: string;
  inviteId: string;
  sub: string;
  email: string;
  locale: string | null;
}

export interface SignupEmailResult {
  /** Where the email returns the person after setting a password: the app root. */
  redirectUri: string;
  /** Whether the email carried the book link. */
  bookLink: boolean;
  /** The language asked for (`locale` attribute). */
  locale: string;
}

export async function sendSignupSetupEmail(input: SignupEmailInput): Promise<SignupEmailResult> {
  const kc = keycloakAdmin();
  const locale = normaliseSignupLocale(input.locale) ?? DEFAULT_SIGNUP_LOCALE;
  // ⛔ THE APP ROOT, NOT THE INVITE LINK. The person was seated (and their invite accepted) at
  // approval, so there is nothing left to accept: the link only has to land them in the app. And a
  // link that carries no per-send token can never be invalidated by a later send — a resend (the
  // tick, a super_admin Retry) leaves every earlier email working.
  const appUrl = `${publicAppUrl()}/`;

  // Book link first (never blocking — null on any failure, counted + logged in book-links.ts).
  const book = await mintBookLink(input.email, locale);

  let attributesWritten = false;
  if (kc.updateUserAttributes) {
    try {
      await kc.updateUserAttributes(input.sub, {
        locale,
        signup_app: SIGNUP_APP,
        signup_book_url: book?.url ?? null,
      });
      attributesWritten = true;
    } catch (err) {
      // Not fatal: without the attributes Keycloak sends its generic set-password email in the realm
      // default language. Still the right email, still the right link.
      log.warn('signup_email_attributes_failed', { component: 'signup-email', sub: input.sub, err });
    }
  }

  // Fatal on failure: the step records `pending` and the tick sends it again.
  await kc.executeActionsEmail(input.sub, ['UPDATE_PASSWORD', 'VERIFY_EMAIL'], {
    redirectUri: appUrl,
    clientId: FRONTEND_CLIENT_ID,
    lifespanSeconds: Math.floor(INVITE_TTL_MS / 1000),
  });

  if (attributesWritten && book && kc.updateUserAttributes) {
    try {
      await kc.updateUserAttributes(input.sub, { signup_book_url: null });
    } catch (err) {
      // The email is out; a lingering link attribute is admin-visible only (user-profile: admin
      // view/edit). Logged so it can be cleared by hand.
      log.warn('signup_email_book_url_clear_failed', { component: 'signup-email', sub: input.sub, err });
    }
  }
  return { redirectUri: appUrl, bookLink: attributesWritten && book !== null, locale };
}
