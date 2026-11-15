<!--
  LicenseBlocked — full-screen hard block shown when the workspace has no usable license
  (expired / none, or a live 402 license_* code). Only two actions: Renew (→ LICENSE_RENEW_URL) and
  Log out. Rendered by the root +layout in place of the app shell, so no licensed surface is
  reachable. Styling uses the Common Practice design tokens (lib/styles/tokens.css), not tailwind.
-->
<script lang="ts">
	import { auth } from '$lib/stores/auth.svelte';
	import { activeTenant } from '$lib/stores/activeTenant.svelte';
	import { licenseGate, navigateToRenew } from '$lib/stores/licenseGate.svelte';
	import * as m from '$lib/paraglide/messages';
	import { licenseCopy } from '$lib/i18n/license-copy';

	// ⛔ AN OUTAGE IS NOT AN EXPIRY, AND SAYING SO IS A FALSE CLAIM ABOUT THE CUSTOMER.
	// `license_unavailable` is emitted when the licences service is UNREACHABLE and the backend gate
	// fails closed (middleware/license-gate.ts). Before this branch existed every `license_*` 402
	// landed on the "License expired / no active license — contact your administrator" copy, so a
	// paid-up workspace was told it had not paid, and offered a Renew button that could not help.
	// Observed live in production 2026-08-13 on a tenant whose licence is `status=active`, no expiry.
	// The block itself is unchanged — the backend denies either way — only the words are honest now.
	const isOutage = $derived(licenseGate.blockedByOutage);

	// ⛔ AND AN UNREADABLE LICENCE IS NEITHER — WHICH IS WHY IT NEEDS A THIRD BRANCH, NOT A REUSED ONE.
	// `license_unreadable` means we hold a licence blob for this tenant and cannot decrypt it (a
	// rotated/wrong CP_SECRET_KEY, or a corrupt row). Rendering it as the outage above would promise
	// "access resumes automatically as soon as it succeeds" and offer Try again — but the condition
	// is STANDING: it hits every tenant at once after a key rotation and clears only when an operator
	// fixes the key. Rendering it as the expiry below would accuse a paid-up customer of not paying.
	// So: its own heading, its own body, and NO CTA — because there is honestly nothing the person
	// reading this screen can press to fix it.
	const isUnreadable = $derived(licenseGate.blockedByUnreadable);

	// ⚠️ HEADING AND BODY NOW COME FROM ONE SHARED FUNCTION, not two ternaries here.
	// `/license-upgrade` — the page the Renew button below navigates to — carried its own,
	// STALE, two-branch copy of this decision and told entitled customers they had no licence.
	// `licenseCopy` (lib/i18n/license-copy.ts) is the single definition both screens read, so a
	// fifth state changes one place and `tsc` finds every consumer.
	//
	// ⛔ IT ALSO FIXES A LATENT ASYMMETRY THAT LIVED IN THESE TWO TERNARIES. The heading branched on
	// `state === 'none'` (else → EXPIRED) while the body branched on `state === 'expired'`
	// (else → REQUIRED). For any state that is neither — `active`, `expiring_soon`, or `unknown`
	// with a `terminal` reason — this screen rendered the heading "License expired" above the body
	// "Your workspace doesn't have an active license": two different claims, stacked. `licenseCopy`
	// picks one branch for both.
	const copy = $derived(licenseCopy(licenseGate.blockReason, licenseGate.state));

	// A seat BEING SET UP finishes by itself (the backend tick runs every 5 minutes), so this screen
	// checks again on its own instead of waiting for the layout's 15-minute poll. The load lifts the
	// block only on an ENTITLED answer.
	const isSetup = $derived(licenseGate.blockReason === 'setup');
	$effect(() => {
		if (!isSetup) return;
		const timer = setInterval(() => void licenseGate.refresh(), 30_000);
		return () => clearInterval(timer);
	});
</script>

<div class="lb-overlay">
	<div class="lb-card" role="alertdialog" aria-labelledby="lb-heading">
		<div class="lb-badge" aria-hidden="true">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
				/>
			</svg>
		</div>

		<h1 id="lb-heading" class="lb-title">{copy.heading}</h1>
		<p class="lb-body">{copy.body}</p>

		{#if activeTenant.current}
			<!-- A super-admin acting-as another tenant with no license would otherwise be trapped here
			     (the act-as banner is replaced by this gate). Give them the way back to their own tenant. -->
			<p class="lb-acting">{m.license_blocked_acting_as({ name: activeTenant.current.name })}</p>
		{/if}

		<div class="lb-actions">
			{#if activeTenant.current}
				<button type="button" class="lb-btn lb-btn-primary" onclick={() => activeTenant.clear()}>
					{m.license_blocked_switch_back()}
				</button>
				{#if !copy.renewIsPointless}
					<!-- Renewing cannot repair a licence we cannot READ; only the way back out is real. -->
					<button type="button" class="lb-btn lb-btn-ghost" onclick={navigateToRenew}>
						{m.license_blocked_renew()}
					</button>
				{/if}
			{:else if isOutage}
				<!-- Renewing cannot fix an unreachable service; the only useful action is to retry.
				     `refresh()` re-polls /api/license/status, which lifts the block only when the
				     service answers with an ENTITLED state — `unknown` (the only answer available
				     during the outage) deliberately preserves it, so this retries rather than
				     dismisses. Disabled while in flight: each attempt can cost the full introspect
				     timeout server-side, and without this the button gave no sign it had done
				     anything at all. -->
				<button
					type="button"
					class="lb-btn lb-btn-primary"
					disabled={licenseGate.isLoading}
					onclick={() => licenseGate.refresh()}
				>
					{m.license_blocked_retry()}
				</button>
			{:else if isSetup}
				<button
					type="button"
					class="lb-btn lb-btn-primary"
					data-testid="license-blocked-setup-check"
					disabled={licenseGate.isLoading}
					onclick={() => licenseGate.refresh()}
				>
					{m.license_blocked_retry()}
				</button>
			{:else if isUnreadable}
				<!-- Deliberately NO primary action. Retry cannot help (the fault is standing) and Renew
				     cannot help (the licence exists — we just cannot decrypt it). Offering either would
				     be the same false promise in a different shape; the body names the real next step,
				     and Log out below is the only honest button. -->
			{:else if !copy.renewIsPointless}
				<!-- ⛔ WAS AN UNCONDITIONAL `{:else}`, AND THAT IS WHAT MADE IT WRONG FOR `seat`.
				     The two arms above are hand-written tests of two reasons, so every reason that is
				     not one of them fell through to Renew — including `seat`, where the workspace is
				     LICENSED AND PAYING and renewing buys the reader nothing. `copy.renewIsPointless`
				     is the flag `licenseCopy` already sets for exactly this question, and it was read
				     in only one place (the acting-as arm above, which `isBlocked` makes unreachable),
				     so the screen carried the answer and did not consult it. Now it does.
				     ⚠️ BEHAVIOUR FOR `outage` AND `unreadable` IS UNCHANGED: both match an earlier arm,
				     and both already set the flag, so neither reaches or is altered by this test. -->
				<button type="button" class="lb-btn lb-btn-primary" onclick={navigateToRenew}>
					{m.license_blocked_renew()}
				</button>
			{/if}
			<button type="button" class="lb-btn lb-btn-ghost" onclick={() => auth.logout()}>
				{m.license_blocked_sign_out()}
			</button>
		</div>
	</div>
</div>

<style>
	.lb-overlay {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background: var(--c-surface);
	}
	.lb-card {
		width: 100%;
		max-width: 420px;
		text-align: center;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		box-shadow: var(--sh-lg);
		padding: 32px;
	}
	.lb-badge {
		width: 48px;
		height: 48px;
		margin: 0 auto 16px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		background: var(--c-coral-light);
		color: var(--c-coral-dark);
	}
	.lb-badge svg {
		width: 24px;
		height: 24px;
	}
	.lb-title {
		font-family: var(--font-display);
		font-size: 22px;
		font-weight: 600;
		color: var(--c-ink);
		margin: 0 0 8px;
	}
	.lb-body {
		color: var(--c-muted);
		font-size: 14px;
		line-height: 1.5;
		margin: 0 0 16px;
	}
	.lb-acting {
		color: var(--c-ink);
		font-size: 13px;
		line-height: 1.5;
		margin: 0 0 20px;
		padding: 8px 12px;
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r);
	}
	.lb-actions {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.lb-btn {
		width: 100%;
		padding: 10px 16px;
		border-radius: var(--r);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
		transition: background 0.12s ease, color 0.12s ease;
	}
	.lb-btn-primary {
		background: var(--c-teal);
		color: #fff;
	}
	.lb-btn-primary:hover {
		background: var(--c-teal-dark);
	}
	.lb-btn-ghost {
		background: var(--c-white);
		color: var(--c-ink);
		border-color: var(--c-border-strong);
	}
	.lb-btn-ghost:hover {
		background: var(--c-surface);
	}
</style>
