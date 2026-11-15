<!--
  NoWorkspace — shown by the root +layout in place of the app when a signed-in, non-super_admin
  person has no Common Practice workspace: GET /api/me said `hasWorkspace: false`, or a live request
  came back 403 `no_workspace`. Keycloak only authenticated them; CP decides membership.

  Lists the invitations waiting for this email (from /api/me) with an Accept button each. Accepting
  re-reads /api/me, which lowers this screen and lets the app render. No `goto`: the layout's render
  branch is the only switch, so there is nothing here that can loop.
-->
<script lang="ts">
	import { auth } from '$lib/stores/auth.svelte';
	import { adminApi } from '$lib/api/admin';
	import { writeErrorText } from '$lib/api/error-message';
	import type { PendingInviteView, TenantRole } from '$lib/types/admin';
	import { fullDate } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import * as m from '$lib/paraglide/messages';

	let busyId = $state<string | null>(null);
	let error = $state<string | null>(null);

	const roleLabel = (r: TenantRole): string =>
		r === 'tenant_admin'
			? m.admin_onboarding_role_admin()
			: r === 'developer'
				? m.admin_onboarding_role_developer()
				: m.admin_onboarding_role_member();

	async function accept(inv: PendingInviteView) {
		if (busyId) return;
		busyId = inv.id;
		error = null;
		try {
			await adminApi.acceptInvite({ inviteId: inv.id });
			await auth.refresh();
		} catch (e) {
			error = writeErrorText(e, m.no_workspace_accept_failed());
			// The list may be stale (expired/revoked meanwhile) — re-read it, best effort.
			try {
				await auth.refresh();
			} catch {
				/* keep the error above */
			}
		} finally {
			busyId = null;
		}
	}
</script>

<div class="nw-overlay">
	<div class="nw-card" role="alertdialog" aria-labelledby="nw-heading">
		<h1 id="nw-heading" class="nw-title">{m.no_workspace_heading()}</h1>
		<p class="nw-body">{m.no_workspace_body()}</p>
		{#if auth.user?.email}
			<p class="nw-who">{m.no_workspace_signed_in_as()} <b dir="ltr">{auth.user.email}</b></p>
		{/if}

		{#if auth.pendingInvites.length > 0}
			<div class="nw-label">{m.no_workspace_invites_title()}</div>
			<ul class="nw-list" data-testid="no-workspace-invites">
				{#each auth.pendingInvites as inv (inv.id)}
					<li class="nw-invite">
						<div class="nw-meta">
							<div class="nw-tenant">{inv.tenantName}</div>
							<div class="nw-sub">
								{roleLabel(inv.role)} · {m.no_workspace_invite_expires({ date: fullDate(inv.expiresAt, locale.current) })}
							</div>
						</div>
						<button
							type="button"
							class="nw-btn nw-btn-primary nw-accept"
							disabled={busyId !== null}
							onclick={() => accept(inv)}
						>
							{busyId === inv.id ? m.no_workspace_accepting() : m.no_workspace_accept()}
						</button>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="nw-none">{m.no_workspace_no_invites()}</p>
		{/if}

		{#if error}<div class="nw-error" role="alert">{error}</div>{/if}

		<div class="nw-actions">
			<button type="button" class="nw-btn nw-btn-ghost" onclick={() => auth.logout()}>
				{m.workspace_suspended_signout()}
			</button>
		</div>
	</div>
</div>

<style>
	.nw-overlay {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
		background: var(--c-surface);
	}
	.nw-card {
		width: 100%;
		max-width: 480px;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		box-shadow: var(--sh-lg);
		padding: 32px;
	}
	.nw-title {
		font-family: var(--font-display);
		font-size: 22px;
		font-weight: 600;
		color: var(--c-ink);
		margin: 0 0 8px;
	}
	.nw-body,
	.nw-none {
		color: var(--c-muted);
		font-size: 14px;
		line-height: 1.5;
		margin: 0 0 14px;
	}
	.nw-who {
		font-size: 12.5px;
		color: var(--c-muted);
		margin: 0 0 18px;
	}
	.nw-who b {
		color: var(--c-ink);
		font-weight: 600;
	}
	.nw-label {
		font-size: 10.5px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-muted);
		margin-bottom: 8px;
	}
	.nw-list {
		list-style: none;
		margin: 0 0 16px;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.nw-invite {
		display: flex;
		align-items: center;
		gap: 12px;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		padding: 10px 12px;
	}
	.nw-meta {
		flex: 1;
		min-width: 0;
	}
	.nw-tenant {
		font-weight: 600;
		font-size: 14px;
		color: var(--c-ink);
	}
	.nw-sub {
		font-size: 12px;
		color: var(--c-muted);
		margin-top: 2px;
	}
	.nw-error {
		font-size: 12.5px;
		padding: 10px 12px;
		border-radius: var(--r);
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		color: var(--c-coral-dark);
		margin-bottom: 14px;
	}
	.nw-actions {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.nw-btn {
		padding: 10px 16px;
		border-radius: var(--r);
		font-size: 13px;
		font-weight: 600;
		cursor: pointer;
		border: 1px solid transparent;
	}
	.nw-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.nw-btn-primary {
		background: var(--c-teal);
		color: #fff;
	}
	.nw-btn-primary:hover:not(:disabled) {
		background: var(--c-teal-dark);
	}
	.nw-accept {
		flex: none;
		padding: 7px 14px;
	}
	.nw-btn-ghost {
		width: 100%;
		background: var(--c-white);
		color: var(--c-ink);
		border-color: var(--c-border-strong);
	}
	.nw-btn-ghost:hover {
		background: var(--c-surface);
	}
</style>
