<script lang="ts">
	// /invite/accept?token=… — the link in every invitation email. The root layout renders this page
	// bare for any signed-in user (it is how someone WITHOUT a workspace gets one); signing in is the
	// root Keycloak init (`login-required`), which returns here with the query intact.
	// Backend: POST /api/invites/accept {token} → {tenantId, role, setupPending?}.
	//
	// FEWEST SCREENS (George 2026-10-19). Early-access v2: an approved early-access requester was
	// already seated and licensed at approval, so the accept is an instant idempotent consume (no
	// licence call); only an ordinary invite still seats + licenses here (a few seconds, shown as
	// "Setting up your workspace…"). On success — `setupPending` included — the invitee goes STRAIGHT
	// into the app (`replaceState`, so Back does not re-run a consumed invite). There is no
	// "Access granted" screen and no button to press: the app itself shows the "access is being set
	// up" state while the licence is pending. Only a refusal stays on this page.
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { adminApi } from '$lib/api/admin';
	import { errorText } from '$lib/api/error-message';
	import { auth } from '$lib/stores/auth.svelte';
	import * as m from '$lib/paraglide/messages';

	type View =
		| { kind: 'working' }
		| { kind: 'error'; text: string; wrongAccount: boolean; invitedEmail?: string };
	let view = $state<View>({ kind: 'working' });

	/** The MASKED invited address the 403 carries (`details.invitedEmail`, masked server-side — the
	 *  full address is never sent to the wrong account). Anything not a short string is dropped. */
	function invitedEmailOf(e: unknown): string | undefined {
		const v = (e as { details?: { invitedEmail?: unknown } })?.details?.invitedEmail;
		return typeof v === 'string' && v.length > 0 && v.length <= 254 ? v : undefined;
	}

	/** The invitee's own sentence per refusal — here `email_in_other_tenant` is about THEIR account,
	 *  not about someone an admin tried to invite. */
	function refusal(e: unknown): { text: string; wrongAccount: boolean; invitedEmail?: string } {
		const code = (e as { code?: unknown })?.code;
		switch (code) {
			case 'invite_email_mismatch':
				return { text: m.invite_accept_email_mismatch(), wrongAccount: true, invitedEmail: invitedEmailOf(e) };
			case 'email_not_verified':
				return { text: m.invite_accept_email_not_verified(), wrongAccount: false };
			case 'invite_expired':
				return { text: m.invite_accept_expired(), wrongAccount: false };
			case 'invite_not_pending':
				return { text: m.invite_accept_not_pending(), wrongAccount: false };
			case 'email_in_other_tenant':
				return { text: m.invite_accept_other_tenant(), wrongAccount: true };
			case 'seats_full':
				return { text: m.invite_accept_seats_full(), wrongAccount: false };
			default:
				return { text: errorText(e, m.invite_accept_failed()), wrongAccount: false };
		}
	}

	onMount(async () => {
		const token = page.url.searchParams.get('token');
		if (!token) {
			view = { kind: 'error', text: m.invite_accept_no_token(), wrongAccount: false };
			return;
		}
		try {
			await adminApi.acceptInvite({ token });
		} catch (e) {
			view = { kind: 'error', ...refusal(e) };
			return;
		}
		// Seated now — re-read /api/me so the app opens with the new tenant and role, then go in.
		// `setupPending` needs no screen of its own here: the app shows that state itself.
		await auth.refresh().catch(() => {});
		await goto('/', { replaceState: true });
	});
</script>

<div class="ia-overlay">
	<div class="ia-card" aria-live="polite">
		{#if view.kind === 'working'}
			<div class="ia-working" role="status" data-testid="invite-accept-working">
				<span class="ia-spinner" aria-hidden="true"></span>
				<h1 class="ia-title">{m.invite_accept_setting_up()}</h1>
			</div>
		{:else}
			<h1 class="ia-title">{m.invite_accept_error_heading()}</h1>
			<p class="ia-body" role="alert" data-testid="invite-accept-error">{view.text}</p>
			{#if view.invitedEmail}
				<p class="ia-who" data-testid="invite-accept-invited-email">
					{m.invite_accept_invited_for()} <b dir="ltr">{view.invitedEmail}</b>
				</p>
			{/if}
			{#if auth.user?.email}
				<p class="ia-who">{m.no_workspace_signed_in_as()} <b dir="ltr">{auth.user.email}</b></p>
			{/if}
			{#if view.wrongAccount && view.invitedEmail}
				<p class="ia-who" data-testid="invite-accept-no-password">{m.invite_accept_no_password_hint()}</p>
			{/if}
			<div class="ia-actions">
				{#if view.wrongAccount}
					<!-- Back to THIS url after the re-login: the `?token=` is the invitation. A bare
					     logout returned to `/`, and the invitee had to dig the email out again. The URL
					     also carries `login_hint`, so the re-login form opens pre-filled (keycloak.ts). -->
					<button type="button" class="ia-btn ia-btn-primary" data-testid="invite-switch-account"
						onclick={() => auth.logout(window.location.href)}>
						{m.invite_accept_switch_account()}
					</button>
				{/if}
				<a class="ia-btn ia-btn-ghost" href="/">{m.invite_accept_open_app()}</a>
			</div>
		{/if}
	</div>
</div>

<style>
	.ia-overlay {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background: var(--c-surface);
	}
	.ia-card {
		width: 100%;
		max-width: 440px;
		text-align: center;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		box-shadow: var(--sh-lg);
		padding: 32px;
	}
	.ia-title {
		font-family: var(--font-display);
		font-size: 22px;
		font-weight: 600;
		color: var(--c-ink);
		margin: 0 0 8px;
	}
	.ia-working {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
	}
	.ia-working .ia-title {
		margin: 0;
	}
	.ia-spinner {
		width: 32px;
		height: 32px;
		border-radius: 50%;
		border: 3px solid var(--c-border);
		border-top-color: var(--c-teal);
		animation: ia-spin 0.9s linear infinite;
	}
	@keyframes ia-spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.ia-spinner {
			animation-duration: 2.4s;
		}
	}
	.ia-body {
		color: var(--c-muted);
		font-size: 14px;
		line-height: 1.5;
		margin: 0 0 16px;
	}
	.ia-who {
		font-size: 12.5px;
		color: var(--c-muted);
		margin: 0 0 18px;
	}
	.ia-who b {
		color: var(--c-ink);
	}
	.ia-actions {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.ia-btn {
		display: block;
		padding: 10px 16px;
		border-radius: var(--r);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
		text-decoration: none;
	}
	.ia-btn-primary {
		background: var(--c-teal);
		color: #fff;
	}
	.ia-btn-primary:hover {
		background: var(--c-teal-dark);
	}
	.ia-btn-ghost {
		background: var(--c-white);
		color: var(--c-ink);
		border-color: var(--c-border-strong);
	}
</style>
