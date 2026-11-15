// license-blocked.outage.render.test.ts — an OUTAGE must not be reported as an EXPIRY.
//
// ⛔ THE DEFECT, OBSERVED LIVE IN PRODUCTION 2026-08-13.
// `middleware/license-gate.ts` fails closed: when the licences service is unreachable it returns
// `402 license_unavailable`. `auth-fetch` forwards any `license_*` 402 to
// `licenseGate.handleForbidden()`, which used to take NO argument — so every code collapsed into one
// terminal block and this screen rendered its EXPIRED copy:
//
//     "Licentie verlopen — Je werkruimte heeft geen actieve Common Practice-licentie.
//      Neem contact op met je beheerder."
//
// That was shown to a tenant whose licence is `status=active` with no expiry. A paid-up customer was
// told they had not paid, pointed at their administrator, and offered a Renew button that cannot fix
// an unreachable service. It then cleared itself on the next poll, which is why it read as a ghost.
//
// ⚠️ THE BLOCK ITSELF IS DELIBERATELY UNCHANGED. The backend denies during an outage by design, so
// letting the user through would only produce a page of failing requests. This pins the WORDS, and
// the fact that the action offered is one that can actually help.
//
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import LicenseBlocked from './LicenseBlocked.svelte';
import { licenseGate } from '$lib/stores/licenseGate.svelte';
import { activeTenant } from '$lib/stores/activeTenant.svelte';
import { locale } from '$lib/stores/locale.svelte';

vi.mock('$lib/api/auth-fetch', () => ({
  authFetch: vi.fn(async () => new Response('{}', { status: 500 })),
}));

let host: HTMLElement;
let app: ReturnType<typeof mount> | undefined;

beforeEach(() => {
  licenseGate.clear();
  activeTenant.current = null; // NOT clear() — that calls location.reload()
  locale.current = 'nl';
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (app) unmount(app);
  app = undefined;
  host.remove();
  vi.clearAllMocks();
});

/** Mount the block screen and return what a reader actually sees. */
function screen(): string {
  app = mount(LicenseBlocked, { target: host, props: {} });
  flushSync();
  return host.textContent ?? '';
}

describe('LicenseBlocked — an unreachable licences service is not an expiry', () => {
  it('THE DEFECT — license_unavailable must NOT claim the workspace has no active licence', async () => {
    licenseGate.handleForbidden('license_unavailable');
    const text = screen();

    // The exact false claims that were on screen in production.
    expect(text).not.toContain('Licentie verlopen');
    expect(text).not.toContain('geen actieve Common Practice-licentie');
    // …and the action that could not possibly help.
    expect(text).not.toContain('Licentie verlengen');

    // What it must say instead: not your licence, and it resumes by itself.
    expect(text).toContain('Licentiecontrole niet beschikbaar');
    expect(text).toContain('Opnieuw proberen');
  });

  it('a REAL expiry still says expired — the fix must not swallow the genuine case', () => {
    // ⛔ NON-VACUITY. Without this, making the screen *always* render outage copy would keep the
    // case above green while hiding every real expiry behind "try again", which is worse than the
    // bug being fixed.
    licenseGate.handleForbidden('license_expired');
    const text = screen();
    expect(text).toContain('Licentie verlopen');
    expect(text).toContain('Licentie verlengen');
    expect(text).not.toContain('Licentiecontrole niet beschikbaar');
  });

  it('⛔ THE BLOCK SURVIVES ITS OWN TRIGGER — an `unknown` poll must not dismiss the outage screen', async () => {
    // The nastiest hole in the first cut of this fix, found by adversarial review and then confirmed
    // in a real browser against a real dead licences service.
    // `GET /api/license/status` fails SOFT where the gate fails CLOSED: lib/license-status.ts
    // catches and answers HTTP 200 {state:'unknown'}. During the very outage that raised the block,
    // that is the ONLY answer it can give. Treating "not a blocked state" as "entitled" therefore
    // unmounted the screen one round-trip after raising it, dropping the user into a shell where
    // every gated request 402s and re-blocks — a flap loop — and turned Retry into a Dismiss button.
    licenseGate.handleForbidden('license_unavailable');
    const { authFetch } = await import('$lib/api/auth-fetch');
    (authFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ appKey: 'commonpractice', gateEnabled: true, hasLicense: false, state: 'unknown', expiresAt: null, daysRemaining: null, planCode: null }), { status: 200 }),
    );
    await licenseGate.load();

    expect(licenseGate.isBlocked).toBe(true);
    expect(licenseGate.blockedByOutage).toBe(true);
    expect(screen()).toContain('Licentiecontrole niet beschikbaar');
  });

  it('⛔ AN AUTHORITATIVE EXPIRY OUTRANKS A PRECEDING BLIP — the mirror image of this bug', async () => {
    // One timed-out introspect among a dozen parallel requests, then a healthy poll saying `expired`.
    // If the outage label stuck, a genuinely expired workspace would be told "not your licence, try
    // again" forever — hiding the renewal path from the one customer who actually needs it.
    licenseGate.handleForbidden('license_unavailable');
    const { authFetch } = await import('$lib/api/auth-fetch');
    (authFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ appKey: 'commonpractice', gateEnabled: true, hasLicense: true, state: 'expired', expiresAt: '2026-01-01T00:00:00.000Z', daysRemaining: -30, planCode: 'standard' }), { status: 200 }),
    );
    await licenseGate.load();

    expect(licenseGate.isBlocked).toBe(true);
    expect(licenseGate.blockedByOutage).toBe(false);
    const text = screen();
    expect(text).toContain('Licentie verlopen');
    expect(text).toContain('Licentie verlengen');
  });

  it('⛔ A LATER BLIP MUST NOT RELABEL A TERMINAL VERDICT as an outage', () => {
    licenseGate.handleForbidden('license_expired');
    licenseGate.handleForbidden('license_unavailable'); // a parallel request times out
    expect(licenseGate.blockedByOutage).toBe(false);
    expect(screen()).toContain('Licentie verlopen');
  });

  it('the outage flag clears when a poll reports an entitled state, so a later expiry reads correctly', async () => {
    // The self-heal is what made this bug look like a ghost; pin it, and pin that it does not leave
    // `blockedByOutage` set to mislabel a subsequent genuine expiry.
    licenseGate.handleForbidden('license_unavailable');
    expect(licenseGate.blockedByOutage).toBe(true);

    const { authFetch } = await import('$lib/api/auth-fetch');
    (authFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ appKey: 'commonpractice', gateEnabled: true, hasLicense: true, state: 'active', expiresAt: null, daysRemaining: null, planCode: null }), { status: 200 }),
    );
    await licenseGate.load();
    expect(licenseGate.blockedByOutage).toBe(false);
    expect(licenseGate.forcedBlocked).toBe(false);
  });
});
