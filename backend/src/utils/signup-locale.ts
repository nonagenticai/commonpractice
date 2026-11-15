// src/utils/signup-locale.ts — the languages a signup can carry (migration 0121).
//
// The eight locales CP's frontend and the nonagentic.ai site ship; the same list is the CHECK on
// `signup_approvals.locale` and the set of Keycloak email-theme locales (early-access v2, C5/C6).
// NULL / absent = not told → the approval email falls back to English.
export const SIGNUP_LOCALES = ['ar', 'de', 'en', 'es', 'fr', 'he', 'nl', 'pl'] as const;
export type SignupLocale = (typeof SIGNUP_LOCALES)[number];
export const DEFAULT_SIGNUP_LOCALE: SignupLocale = 'en';

/**
 * A caller-supplied language tag → one of SIGNUP_LOCALES, or null. Lenient on purpose: the intake is
 * a relay of a browser's `<html lang>` / cookie, so `de-DE`, `DE` and `de_AT` mean German, and an
 * unknown language (`it`, `zz`, junk) is "not told", never a refused signup.
 */
export function normaliseSignupLocale(value: unknown): SignupLocale | null {
  if (typeof value !== 'string') return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return (SIGNUP_LOCALES as readonly string[]).includes(primary) ? (primary as SignupLocale) : null;
}
