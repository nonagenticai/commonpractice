<!--
  /license-upgrade — the in-app default target for the "Renew license" CTA (LICENSE_RENEW_URL).
  An honest "contact your administrator / sales" page — there is no self-serve purchase in CP yet.
  When the customer portal e-commerce ships, set VITE_LICENSE_RENEW_URL to the portal URL and this
  page is bypassed by a full redirect. Reachable even while the license gate is blocking (the root
  +layout excludes this route from the LicenseBlocked branch).
-->
<script lang="ts">
	import { licenseGate } from '$lib/stores/licenseGate.svelte';
	import { licenseCopy } from '$lib/i18n/license-copy';

	// ⛔ THIS PAGE USED TO READ `state` ALONE, and told an entitled customer they had never bought a
	// licence. `state` is `'unknown'` both during a licences-service OUTAGE and when we hold a blob
	// we cannot DECRYPT; the old two-branch ternary sent both — and every other non-`expired` state —
	// to "No active license". The reader arrives here by pressing Renew on the block screen, so the
	// journey was: honest "we can't complete the licence check right now" → one click → an
	// accusation of non-payment, plus a Renew CTA that cannot fix either cause.
	//
	// `blockReason` is the field that separates them, and `licenseCopy` is shared with
	// LicenseBlocked.svelte so the two screens cannot drift apart again. See lib/i18n/license-copy.ts.
	const copy = $derived(
		licenseCopy(licenseGate.blockReason, licenseGate.state, licenseGate.daysRemaining)
	);
</script>

<div class="lu">
	<h1 class="lu-title">{copy.heading}</h1>
	<p class="lu-body">{copy.body}</p>
	{#if !copy.renewIsPointless}
		<!-- Sales cannot help with an unreachable licences service or an undecryptable blob: the first
		     resolves itself, the second needs an operator to fix a key. Offering a sales contact for
		     either is the same false promise as the Renew button this page is the target of. The body
		     copy for those two states already names the real next step. -->
		<p class="lu-contact">
			<a href="mailto:sales@nonagentic.ai">sales@nonagentic.ai</a>
		</p>
	{/if}
</div>

<style>
	.lu {
		max-width: 480px;
		margin: 48px auto;
		padding: 0 24px;
		text-align: center;
	}
	.lu-title {
		font-family: var(--font-display);
		font-size: 24px;
		font-weight: 600;
		color: var(--c-ink);
		margin: 0 0 12px;
	}
	.lu-body {
		color: var(--c-muted);
		font-size: 14px;
		line-height: 1.5;
		margin: 0 0 16px;
	}
	.lu-contact a {
		color: var(--c-teal);
		font-weight: 600;
		text-decoration: underline;
	}
</style>
