<script lang="ts">
	// Members — the tenant's roster, invitations and role management. A member is a user whose CP
	// home tenant is this one (users.tenant_id); the role is CP's `users.tenant_role`. Adding
	// someone sends an INVITE — they are seated when they accept. Backend: GET /api/tenant,
	// GET /api/tenants/:id/members, POST/PATCH/DELETE /api/tenants/:id/users[/:userId],
	// GET/DELETE /api/tenants/:id/invites[/:inviteId], POST …/invites/:inviteId/resend.
	import { onMount } from 'svelte';
	import { adminApi, ApiError } from '$lib/api/admin';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { auth } from '$lib/stores/auth.svelte';
	import type { Member, TenantRole, TenantSummary, SeatUsage, InviteView, CreatedInvite } from '$lib/types/admin';
	import { timeAgo, num, fullDate } from '$lib/utils/format';
	import * as m from '$lib/paraglide/messages';
	import { confirmDialog } from '$lib/stores/confirm.svelte';
	import { locale } from '$lib/stores/locale.svelte';

	let loading = $state(true);
	let denied = $state(false);
	let loadError = $state<string | null>(null);
	let busy = $state(false);
	let savingId = $state<string | null>(null);
	let banner = $state<{ kind: 'ok' | 'warn' | 'error'; text: string } | null>(null);

	let members = $state<Member[]>([]);
	// Pending invitations (accepted/revoked/expired rows are history, not shown).
	let invites = $state<InviteView[]>([]);
	// The last invite whose email failed — its link is the only way in, so it is shown to copy.
	let failedInvite = $state<CreatedInvite | null>(null);
	let copied = $state(false);
	let active = $state<TenantSummary | null>(null);
	// ──────────────────────────────────────────────────────────────────────────────────────────
	// ⛔ A ROLE CHANGE THAT NEVER LEFT THE BROWSER STAYED ON SCREEN LOOKING LIKE IT HAD LANDED.
	//
	// `<select value={mem.role ?? ''}>` compiles (Svelte 5.56.2) to
	//   `if (select_value !== (select_value = $.get(mem).role ?? '')) { select.value = … }`
	// — `select_value` caches the last EXPRESSION value. A change this component DISCARDS never
	// reaches the server, so `mem.role` is unchanged afterwards, the guard is false, and the DOM
	// element is never re-synced: the user's pick sits in the box until a full page reload. The
	// `catch` arm of a save that FAILED has exactly the same shape.
	//
	// So an admin could promote someone to tenant_admin, read "Admin" back out of the dropdown, and
	// walk away believing an access-control change had landed when nothing was sent.
	//
	// `rosterEpoch` is the re-render handle: bumped whenever the roster is (re)loaded and on every
	// path that ends with the element out of step with the server, it drives the `{#key}` around the
	// `<select>` so the control is rebuilt from `mem.role` instead of being skipped by the cache.
	// ──────────────────────────────────────────────────────────────────────────────────────────
	let rosterEpoch = $state(0);
	// Seat cap (0044): how many people this tenant may hold. `max: null` = unlimited. At the cap
	// the add-user form is disabled with an explanation — the backend also 409s `seat_limit_reached`
	// as the real enforcement point, this just avoids offering an action that cannot succeed.
	let seats = $state<SeatUsage | null>(null);
	const seatsFull = $derived(seats?.max !== null && seats !== null && seats.used >= seats.max!);

	// Roles come from CP's own `users.tenant_role`, so the roster always knows who the admins are.
	// The last tenant_admin's demote/remove controls are withheld here; the backend 409s
	// `last_tenant_admin` as the real enforcement point.
	let adminCount = $derived(members.filter((x) => x.role === 'tenant_admin').length);
	/** Why this member's adminship-stripping actions (demote, remove) are withheld, or `null`. */
	function guardReason(mem: Member): string | null {
		if (mem.role === 'tenant_admin' && adminCount === 1) return m.admin_members_last_admin();
		return null;
	}

	// invite form
	let addEmail = $state('');
	// First + last are both required: the portal realm requires them, and an identity minted without
	// them is stopped at Keycloak's profile form on its first sign-in.
	let addFirstName = $state('');
	let addLastName = $state('');
	const addReady = $derived(Boolean(addEmail.trim() && addFirstName.trim() && addLastName.trim()));
	// ⛔ AT THE CAP, RE-INVITING AN ADDRESS THAT ALREADY HAS A PENDING INVITE IS STILL ALLOWED. The
	// backend (invite-service `createInvite`) renews + resends that invite instead of creating one, so
	// it takes no new seat — the invite already holds it. `seats.used` counts pending invites (the
	// definition `claimSeatInTx` enforces), so gating on `seatsFull` alone refused exactly that renew.
	const addRenewsPending = $derived(
		invites.some((i) => i.email.trim().toLowerCase() === addEmail.trim().toLowerCase())
	);
	const addBlockedBySeats = $derived(seatsFull && !addRenewsPending);
	let addRole = $state<TenantRole>('member');

	async function load() {
		loading = true;
		denied = false;
		loadError = null;
		try {
			active = (await adminApi.currentTenant()).tenant;
			const roster = await adminApi.members(active.id);
			members = roster.members;
			rosterEpoch++; // the server has spoken — every role control re-renders from its answer
			// Non-fatal: a seat-usage or invite-list hiccup must not blank the roster.
			try {
				seats = (await adminApi.tenantBudget(active.id)).seats;
			} catch {
				seats = null;
			}
			try {
				invites = (await adminApi.tenantInvites(active.id)).invites.filter((i) => i.status === 'pending');
			} catch {
				invites = [];
			}
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else loadError = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function run(fn: () => Promise<{ kind: 'ok' | 'warn'; text: string } | void>, ok: string) {
		if (busy) return;
		busy = true;
		banner = null;
		try {
			const outcome = await fn();
			banner = outcome ?? { kind: 'ok', text: ok };
			await load();
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_action_failed()) };
		} finally {
			busy = false;
		}
	}

	/** Banner for a created/resent invite; a failed email keeps its link on screen to copy. */
	function inviteOutcome(inv: CreatedInvite): { kind: 'ok' | 'warn'; text: string } {
		copied = false;
		if (inv.emailDelivery === 'failed') {
			failedInvite = inv;
			return { kind: 'warn', text: m.admin_members_invite_email_failed({ email: inv.email }) };
		}
		failedInvite = null;
		// No password yet: Keycloak sent its set-password email, which continues to the invite link.
		if (inv.emailDelivery === 'keycloak_actions') {
			return { kind: 'ok', text: m.admin_members_invite_set_password({ email: inv.email }) };
		}
		return { kind: 'ok', text: m.admin_members_invited({ email: inv.email }) };
	}

	function addMember() {
		if (!addReady || !active) return;
		run(async () => {
			const { invite } = await adminApi.inviteMember(active!.id, {
				email: addEmail.trim(),
				role: addRole,
				firstName: addFirstName.trim(),
				lastName: addLastName.trim()
			});
			addEmail = '';
			addFirstName = '';
			addLastName = '';
			addRole = 'member';
			return inviteOutcome(invite);
		}, m.admin_members_invited({ email: addEmail.trim() }));
	}

	function resend(inv: InviteView) {
		if (!active) return;
		run(async () => inviteOutcome((await adminApi.resendInvite(active!.id, inv.id)).invite), m.admin_members_invite_resent());
	}

	async function revoke(inv: InviteView) {
		if (busy || !active) return;
		if (!(await confirmDialog({ message: m.admin_members_invite_revoke_confirm({ email: inv.email }) }))) return;
		run(() => adminApi.revokeInvite(active!.id, inv.id), m.admin_members_invite_revoked());
	}

	async function copyInviteUrl(url: string) {
		try {
			await navigator.clipboard.writeText(url);
			copied = true;
		} catch {
			copied = false;
		}
	}

	const roleLabel = (r: TenantRole): string =>
		r === 'tenant_admin'
			? m.admin_onboarding_role_admin()
			: r === 'developer'
				? m.admin_onboarding_role_developer()
				: m.admin_onboarding_role_member();

	async function changeRole(mem: Member, role: TenantRole) {
		// Re-picking the value the row already holds is genuinely nothing to do, and the element
		// already agrees with the server — the only early return that needs no re-render.
		if (mem.role === role) return;
		// Discarded because something else is in flight. The `<select>` is disabled on `busy` so this
		// is only reachable through a dropdown that was already open when the other operation
		// started; the pick still goes nowhere, so it must not be left on screen.
		if (busy || !active) {
			rosterEpoch++;
			return;
		}
		// Block demoting the tenant's last admin (the backend 409s `last_tenant_admin` too).
		const blocked = guardReason(mem);
		if (role === 'member' && blocked) {
			banner = { kind: 'error', text: blocked };
			rosterEpoch++;
			return;
		}
		savingId = mem.userId;
		busy = true;
		banner = null;
		try {
			await adminApi.setMemberRole(active.id, mem.userId, role);
			banner = { kind: 'ok', text: m.admin_members_role_updated() };
			await load();
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_save_failed()) };
			// The save did not happen and `load()` was never reached, so nothing else would put the
			// server's role back in the box — an error banner over the user's own pick reads as
			// "something went wrong, but look, it says Admin".
			rosterEpoch++;
		} finally {
			busy = false;
			savingId = null;
		}
	}

	// Remove a member from this workspace (tombstone + seat revoke; their Keycloak login is untouched),
	// confirm-gated. The self row hides the button; the backend also 409s a self-removal.
	async function offboard(mem: Member) {
		if (busy || !active) return;
		// Block removing the tenant's last admin (the backend 409s `last_tenant_admin` too).
		const blocked = guardReason(mem);
		if (blocked) {
			banner = { kind: 'error', text: blocked };
			return;
		}
		if (!(await confirmDialog({ message: m.admin_members_remove_confirm({ name: mem.name }) }))) return;
		run(() => adminApi.deleteTenantUser(active!.id, mem.userId).then(() => {}), m.admin_members_removed());
	}
</script>

<div class="page">
	<header class="page-head">
		<div class="eyebrow">{m.admin_members_eyebrow()}</div>
		<h1>{m.admin_members_title()}</h1>
		<p>{m.admin_members_lede_invite()}</p>
	</header>

	{#if denied}
		<div class="notice error">{m.admin_denied()}</div>
	{:else if loading}
		<div class="notice">{m.admin_loading()}</div>
	{:else if loadError}
		<div class="notice error">{m.admin_load_failed({ error: loadError })}</div>
	{:else}
		{#if active}<div class="active-tenant">{m.admin_members_active_tenant()}: <b>{active.name}</b></div>{/if}
		{#if banner}<div class="banner {banner.kind}">{banner.text}</div>{/if}

		<div class="card table">
			<div class="thead">
				<span>{m.admin_members_col_name()}</span>
				<span>{m.admin_members_col_email()}</span>
				<span>{m.admin_members_col_role()}</span>
				<span>{m.admin_members_col_joined()}</span>
				<span class="cactions" aria-hidden="true"></span>
			</div>
			{#if members.length === 0}
				<div class="empty">{m.admin_members_empty()}</div>
			{:else}
				{#each members as mem (mem.userId)}
					{@const blocked = guardReason(mem)}
					<div class="trow">
						<span class="cname">{mem.name}</span>
						<span class="cemail" dir="ltr">{mem.email}</span>
						<span class="crole">
							<!-- ⛔ `{#key rosterEpoch}` IS PART OF THE FIX, not decoration — see the block on
							     `rosterEpoch` in the script. Rebuilding the element is what defeats Svelte's
							     cached `select_value`, which otherwise skips the write whenever the server's
							     role is unchanged — i.e. on exactly the discarded and failed changes where
							     the box is showing something that never happened. -->
							{#key rosterEpoch}
								<select
									aria-label={m.admin_members_role_label()}
									value={mem.role ?? ''}
									class:saving={savingId === mem.userId}
									disabled={busy || blocked !== null}
									title={blocked ?? undefined}
									onchange={(e) => changeRole(mem, e.currentTarget.value as TenantRole)}
								>
									{#if mem.role === null}<option value="" disabled>{m.admin_members_role_unassigned()}</option>{/if}
									<option value="member">{m.admin_onboarding_role_member()}</option>
									<option value="developer">{m.admin_onboarding_role_developer()}</option>
									<option value="tenant_admin">{m.admin_onboarding_role_admin()}</option>
								</select>
							{/key}
						</span>
						<span class="cjoined">{timeAgo(mem.joinedAt)}</span>
						<span class="cactions">
							{#if mem.userId !== auth.user?.id}
								<button
									type="button"
									class="btn-remove"
									disabled={busy || blocked !== null}
									title={blocked ?? undefined}
									onclick={() => offboard(mem)}
								>{m.admin_members_remove()}</button>
							{/if}
						</span>
					</div>
				{/each}
			{/if}
		</div>

		<!-- pending invitations -->
		{#if invites.length > 0}
			<div class="section-label">{m.admin_members_invites_title()}</div>
			<div class="card table" data-testid="members-invites">
				{#each invites as inv (inv.id)}
					<div class="irow">
						<span class="cemail" dir="ltr">{inv.email}</span>
						<span class="irole">{roleLabel(inv.role)}</span>
						<span class="cjoined">{m.admin_members_invite_expires({ date: fullDate(inv.expiresAt, locale.current) })}</span>
						<span class="cactions">
							<button type="button" class="btn-ghost sm" disabled={busy} onclick={() => resend(inv)}>{m.admin_members_invite_resend()}</button>
							<button type="button" class="btn-remove" disabled={busy} onclick={() => revoke(inv)}>{m.admin_members_invite_revoke()}</button>
						</span>
					</div>
				{/each}
			</div>
		{/if}
		{#if failedInvite}
			<div class="card invite-link" data-testid="members-invite-link">
				<span class="hint">{m.admin_invite_link_hint()}</span>
				<input readonly value={failedInvite.inviteUrl} aria-label={m.admin_invite_link_label()}
					onfocus={(e) => e.currentTarget.select()} dir="ltr" />
				<button type="button" class="btn-ghost sm" onclick={() => copyInviteUrl(failedInvite!.inviteUrl)}>
					{copied ? m.admin_invite_link_copied() : m.admin_invite_link_copy()}
				</button>
			</div>
		{/if}

		<!-- invite someone to this tenant -->
		{#if seats && seats.max !== null}
			<div class="seats-line" class:full={seatsFull}>
				{m.admin_members_seats({ used: num(seats.used, locale.current), max: num(seats.max, locale.current) })}
				{#if seatsFull}<span class="seats-note">{m.admin_members_seats_full()}</span>{/if}
			</div>
		{/if}
		<form class="card add" onsubmit={(e) => { e.preventDefault(); addMember(); }}>
			<div class="field">
				<label for="add-email">{m.admin_members_email_label()}</label>
				<input id="add-email" type="email" bind:value={addEmail} placeholder={m.admin_members_email_placeholder()} />
			</div>
			<div class="field">
				<label for="add-first-name">{m.admin_members_first_name_label()}</label>
				<input id="add-first-name" bind:value={addFirstName} maxlength="80" required autocomplete="off" />
			</div>
			<div class="field">
				<label for="add-last-name">{m.admin_members_last_name_label()}</label>
				<input id="add-last-name" bind:value={addLastName} maxlength="80" required autocomplete="off" />
			</div>
			<div class="field narrow">
				<label for="add-role">{m.admin_members_role_label()}</label>
				<select id="add-role" bind:value={addRole}>
					<option value="member">{m.admin_onboarding_role_member()}</option>
					<option value="developer">{m.admin_onboarding_role_developer()}</option>
					<option value="tenant_admin">{m.admin_onboarding_role_admin()}</option>
				</select>
			</div>
			<button class="btn-primary" type="submit" disabled={!addReady || busy || addBlockedBySeats}
				title={addBlockedBySeats ? m.admin_members_seats_full() : undefined}>{m.admin_members_invite()}</button>
		</form>
	{/if}
</div>

<style>
	.page { max-width: 1080px; }
	.page-head { margin-bottom: 18px; }
	.eyebrow { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; color: var(--c-teal-dark); margin-bottom: 8px; }
	h1 { font-family: var(--font-display); font-size: 30px; margin: 0 0 6px; color: var(--c-midnight); }
	.page-head p { color: var(--c-muted); font-size: 13.5px; margin: 0; max-width: 640px; }
	.active-tenant { font-size: 12.5px; color: var(--c-muted); margin-bottom: 12px; }
	.seats-line { font-size: 12px; color: var(--c-muted); margin: 14px 0 6px; }
	.seats-line.full { color: var(--c-coral-dark); font-weight: 600; }
	.seats-note { margin-inline-start: 6px; font-weight: 400; }
	.active-tenant b { color: var(--c-ink); }
	.card { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.table { padding: 6px 0; }
	.thead, .trow { display: grid; grid-template-columns: 1.2fr 1.6fr 0.9fr 0.7fr 0.7fr; align-items: center; gap: 10px; padding: 10px 18px; }
	.thead { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--c-muted); font-weight: 600; border-bottom: 1px solid var(--c-border); }
	.trow { border-bottom: 1px solid var(--c-surface); font-size: 13px; }
	.trow:last-child { border-bottom: none; }
	.cname { font-weight: 600; color: var(--c-ink); }
	.cemail { font-family: var(--font-mono); font-size: 12px; color: var(--c-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.crole select { font-family: var(--font-sans); font-size: 12.5px; color: var(--c-ink); border: 1px solid var(--c-border); border-radius: var(--r); padding: 5px 8px; background: var(--c-white); width: 100%; }
	/* `cursor: progress` belongs to the row that is actually saving — `savingId`. Every other row is
	   disabled because SOMETHING ELSE is in flight (or because the last-admin guard withholds it),
	   and telling those readers "in progress" would be the same misstatement one layer down. */
	.crole select:disabled { opacity: 0.5; cursor: not-allowed; }
	.crole select.saving:disabled { cursor: progress; }
	.cjoined { color: var(--c-muted); font-size: 12px; }
	.cactions { display: flex; justify-content: flex-end; }
	.btn-remove { font-family: var(--font-sans); font-size: 12px; font-weight: 600; color: var(--c-coral-dark); background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); border-radius: var(--r); padding: 5px 12px; cursor: pointer; white-space: nowrap; }
	.btn-remove:hover:not(:disabled) { background: var(--c-coral-light); }
	.btn-remove:disabled { opacity: 0.5; cursor: not-allowed; }
	.empty { color: var(--c-muted); font-size: 13px; text-align: center; padding: 20px; }
	.add { display: flex; align-items: flex-end; gap: 12px; padding: 14px 16px; margin-top: 14px; flex-wrap: wrap; }
	.field { display: flex; flex-direction: column; flex: 1; min-width: 160px; }
	.field.narrow { flex: 0 0 150px; min-width: 150px; }
	label { font-size: 12.5px; font-weight: 600; color: var(--c-ink); margin-bottom: 6px; }
	input, .add select { font-family: var(--font-sans); font-size: 13.5px; color: var(--c-ink); border: 1px solid var(--c-border); border-radius: var(--r); padding: 9px 12px; box-sizing: border-box; background: var(--c-white); width: 100%; }
	.btn-primary { background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 10px 18px; border-radius: var(--r); border: none; white-space: nowrap; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.banner { font-size: 12.5px; padding: 10px 12px; border-radius: var(--r); margin-bottom: 14px; }
	.banner.ok { background: var(--c-teal-pale); border: 1px solid var(--c-teal-light); color: var(--c-teal-dark); }
	.banner.error { background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); color: var(--c-coral-dark); }
	/* Amber, not coral: nothing has failed for the READER — the roster loaded and is correct. What
	   is missing is one column, and the tone says "incomplete", not "broken". */
	.banner.warn { background: var(--c-amber-pale); border: 1px solid var(--c-amber-light); color: var(--c-amber-dark, #92400E); }
	.section-label { font-size: 10.5px; letter-spacing: 0.1em; text-transform: uppercase; font-weight: 600; color: var(--c-muted); margin: 18px 0 6px; }
	.irow { display: grid; grid-template-columns: 1.6fr 0.8fr 1fr auto; align-items: center; gap: 10px; padding: 10px 18px; border-bottom: 1px solid var(--c-surface); font-size: 13px; }
	.irow:last-child { border-bottom: none; }
	.irole { color: var(--c-ink); font-size: 12.5px; }
	.irow .cactions { gap: 6px; }
	.btn-ghost { font-family: var(--font-sans); font-size: 12px; font-weight: 600; color: var(--c-ink); background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r); padding: 5px 12px; cursor: pointer; white-space: nowrap; }
	.btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
	.invite-link { display: flex; align-items: center; gap: 10px; padding: 12px 16px; margin-top: 12px; flex-wrap: wrap; }
	.invite-link input { flex: 1; min-width: 240px; font-family: var(--font-mono); font-size: 11.5px; }
	.hint { font-size: 12px; color: var(--c-muted); width: 100%; }
	.notice { font-size: 13.5px; padding: 28px; text-align: center; color: var(--c-muted); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.notice.error { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); }
</style>
