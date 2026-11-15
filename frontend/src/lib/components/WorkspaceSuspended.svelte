<!--
  WorkspaceSuspended — full-screen hard block shown when a platform operator has suspended this
  workspace (a live 403 `tenant_suspended` from the backend tenant-lifecycle gate). Rendered by the
  root +layout in place of the app shell, so no tenant surface is reachable while suspended.
  Styling uses the Common Practice design tokens (lib/styles/tokens.css), not tailwind — same
  full-screen card idiom as LicenseBlocked.svelte.

  ⛔ EXACTLY TWO ACTIONS, AND NEITHER OF THEM NAVIGATES.
  Sign out, and Try again (a full `location.reload()`).

  There is NO "Renew licence" button and NO link to /license-upgrade, and adding one would be the
  defect rather than the fix: a suspended workspace's licence may be entirely valid and paid up, so
  a renewal CTA both states something false about why the customer is locked out and points them at
  a payment funnel that cannot possibly unlock them. Suspension is lifted by a platform operator, by
  hand, out-of-band — there is nothing on this screen the reader can press that changes their state.
  (Same reasoning as the `isUnreadable` branch in LicenseBlocked, which likewise offers no CTA.)

  ⛔ AND THERE IS NO `goto`, NO `$effect` THAT NAVIGATES, AND NO REDIRECT OF ANY KIND.
  The gate that produces this state fires on EVERY request, so any navigation from here is a redirect
  loop by construction: land on a route → its loader 403s → re-trip the gate → navigate again. This
  component is a pure render branch, and `location.reload()` is a browser reload rather than a
  client-side navigation on purpose — it is also what clears the sticky store flag (see
  workspaceGate.svelte.ts), so a reinstated workspace comes back cleanly on the next boot instead of
  being stuck behind a latch the SPA has no way to lower.
-->
<script lang="ts">
	import { auth } from '$lib/stores/auth.svelte';
	import * as m from '$lib/paraglide/messages';
</script>

<div class="ws-overlay">
	<div class="ws-card" role="alertdialog" aria-labelledby="ws-heading">
		<div class="ws-badge" aria-hidden="true">
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
				/>
			</svg>
		</div>

		<h1 id="ws-heading" class="ws-title">{m.workspace_suspended_heading()}</h1>
		<p class="ws-body">{m.workspace_suspended_body()}</p>

		<div class="ws-actions">
			<!-- A full reload, NOT goto(): it re-boots the SPA, which is the only way the sticky
			     suspension latch is lowered once an operator has reinstated the workspace. -->
			<button type="button" class="ws-btn ws-btn-primary" onclick={() => location.reload()}>
				{m.workspace_suspended_retry()}
			</button>
			<button type="button" class="ws-btn ws-btn-ghost" onclick={() => auth.logout()}>
				{m.workspace_suspended_signout()}
			</button>
		</div>
	</div>
</div>

<style>
	.ws-overlay {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background: var(--c-surface);
	}
	.ws-card {
		width: 100%;
		max-width: 420px;
		text-align: center;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		box-shadow: var(--sh-lg);
		padding: 32px;
	}
	.ws-badge {
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
	.ws-badge svg {
		width: 24px;
		height: 24px;
	}
	.ws-title {
		font-family: var(--font-display);
		font-size: 22px;
		font-weight: 600;
		color: var(--c-ink);
		margin: 0 0 8px;
	}
	.ws-body {
		color: var(--c-muted);
		font-size: 14px;
		line-height: 1.5;
		margin: 0 0 20px;
	}
	.ws-actions {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.ws-btn {
		width: 100%;
		padding: 10px 16px;
		border-radius: var(--r);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
		transition: background 0.12s ease, color 0.12s ease;
	}
	.ws-btn-primary {
		background: var(--c-teal);
		color: #fff;
	}
	.ws-btn-primary:hover {
		background: var(--c-teal-dark);
	}
	.ws-btn-ghost {
		background: var(--c-white);
		color: var(--c-ink);
		border-color: var(--c-border-strong);
	}
	.ws-btn-ghost:hover {
		background: var(--c-surface);
	}
</style>
