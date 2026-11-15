// src/services/book-links.ts — the early-access book download link (early-access v2, contract C4).
//
// On approve, the set-password email Keycloak sends for CommonPractice also carries a download link
// for the epub book, in the requester's language. book-fulfillment mints that link:
//
//   POST {BOOK_FULFILLMENT_URL}/internal/download-links  {email, lang}  →  200 {url, lang, expiresAt}
//
// authenticated with a portal-realm client-credentials token for client `commonpractice-book-links`
// (BOOK_LINKS_CLIENT_ID / BOOK_LINKS_CLIENT_SECRET or BOOK_LINKS_SECRET_FILE). book-fulfillment sends
// NO email itself; CP hands the URL to Keycloak's email template as the user attribute
// `signup_book_url` (services/signup-email.ts) and clears it after the send.
//
// ⛔ NEVER BLOCKING. A missing config, a token failure, a non-2xx, a timeout or a malformed body all
// return `null` — the email then goes out without the book block. Each outcome is counted
// (`commonpractice_signup_book_link_total{outcome}`) and every failure is logged. The URL itself is a
// bearer link to a download, so it is never logged.
import { bookLinksConfig } from '../config';
import { log } from '../host/logger';
import { incLabelledCounter } from '../host/metrics';

export const BOOK_LINK_COUNTER = 'signup_book_link_total';

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchFn | undefined;
/** Test seam: replace the HTTP client for BOTH the token and the mint call (undefined restores fetch). */
export function __setBookLinksFetchForTests(fn: FetchFn | undefined): void {
  fetchImpl = fn;
  cached = undefined;
}

let cached: { token: string; expiresAt: number; key: string } | undefined;

async function serviceToken(cfg: ReturnType<typeof bookLinksConfig>): Promise<string> {
  const key = `${cfg.tokenUrl}|${cfg.clientId}`;
  if (cached && cached.key === key && cached.expiresAt > Date.now()) return cached.token;
  const res = await (fetchImpl ?? fetch)(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }).toString(),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) throw new Error(`book-links token request failed: HTTP ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error('book-links token response carried no access_token');
  }
  const ttlS = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 60;
  // Refresh 30 s early, and never cache for more than 5 minutes.
  cached = { token: body.access_token, key, expiresAt: Date.now() + Math.min(Math.max(ttlS - 30, 1), 300) * 1000 };
  return body.access_token;
}

export interface BookLink {
  url: string;
  /** The language book-fulfillment actually served (it falls back to `en`). */
  lang: string;
}

/** Mint the download link for `email` in `lang`. `null` when unconfigured or on ANY failure. */
export async function mintBookLink(email: string, lang: string): Promise<BookLink | null> {
  const cfg = bookLinksConfig();
  if (!cfg.enabled) {
    incLabelledCounter(BOOK_LINK_COUNTER, 'disabled');
    return null;
  }
  try {
    const token = await serviceToken(cfg);
    const res = await (fetchImpl ?? fetch)(`${cfg.baseUrl}/internal/download-links`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ email, lang }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`book-fulfillment answered HTTP ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { url?: unknown; lang?: unknown };
    if (typeof body.url !== 'string' || !/^https?:\/\//.test(body.url)) {
      throw new Error('book-fulfillment response carried no usable url');
    }
    incLabelledCounter(BOOK_LINK_COUNTER, 'ok');
    return { url: body.url, lang: typeof body.lang === 'string' ? body.lang : lang };
  } catch (err) {
    if (err instanceof Error && /token/.test(err.message)) cached = undefined;
    incLabelledCounter(BOOK_LINK_COUNTER, 'failed');
    log.warn('signup_book_link_failed', {
      component: 'book-links',
      lang,
      err,
      hint: 'the approval email goes out without the book link',
    });
    return null;
  }
}
