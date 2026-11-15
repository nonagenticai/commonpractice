<script lang="ts">
	// One governance rail (demo .policy-row): label + description on the left, the
	// control on the right. The control type is data-driven (toggle / number / select
	// / list). Emits the new value; the page persists it via /api/governance.
	import Toggle from './Toggle.svelte';
	import type { Policy, PolicyValue } from '$lib/types/governance';
	import {
		policyLabel,
		policyDescription,
		policyOptionLabel,
		policyUnitLabel,
		policyMapKeyLabel
	} from '$lib/i18n/policy-label';
	import * as m from '$lib/paraglide/messages';

	let {
		policy,
		busy = false,
		onchange
	}: { policy: Policy; busy?: boolean; onchange: (value: PolicyValue) => void } = $props();

	let editingList = $state(false);
	let listDraft = $state('');

	function startListEdit() {
		listDraft = Array.isArray(policy.value) ? policy.value.join(', ') : '';
		editingList = true;
	}
	/** Leave the editor without writing anything. Bound to Escape. */
	function cancelListEdit() {
		editingList = false;
	}
	function commitList() {
		// ⛔ GUARDED ON `editingList`, because both exits below CLOSE the editor and removing a focused
		// input fires `blur` — and `blur` is wired straight to this function. Without the guard,
		// Escape wrote the draft it had just discarded and Enter committed the same edit twice.
		if (!editingList) return;
		editingList = false;
		// ⛔ DEDUPED HERE TOO, because the comparison below has to be against the value that would
		// actually be STORED. `backend/src/routes/governance.ts:validateValue` dedupes the `list`
		// branch (`[...new Set(raw)]`, guarding the value-keyed badge render), so a rail holding
		// ['a','b'] and a draft of "a, b, b" produced a 3-element array here, failed the length test,
		// PATCHed — and the server wrote back ['a','b'], the value it already had. One more
		// policy_changes row for an edit that did not survive its own validation.
		const arr = [
			...new Set(
				listDraft
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
			)
		];
		// ⛔ THIS COMPARISON IS THE POINT. `onchange` fired UNCONDITIONALLY here, and it is wired to
		// `onblur`: opening the "Allowlisted models" editor and clicking away WITHOUT TYPING PATCHed
		// the value the rail already held, which minted a `policy_changes` row whose `old_value` was
		// byte-identical to its `new_value`, a `policy.change` row in `audit_log`, and a new top entry
		// in "Recent changes". /governance is a compliance surface — its trail must not record changes
		// that did not occur. `commitMapEntry` below has had the same check since it was written.
		//
		// Compared on the PARSED array, not on the draft text: "a,  b" and "a, b" produce the same
		// wire value, so a text comparison would call that a change and write the row anyway.
		const current = Array.isArray(policy.value) ? (policy.value as string[]) : [];
		if (arr.length === current.length && arr.every((v, i) => v === current[i])) return;
		onchange(arr);
	}
	function commitNumber(e: Event) {
		const el = e.target as HTMLInputElement;
		const n = Number.parseFloat(el.value);
		if (Number.isFinite(n) && n >= 0) {
			// ⛔ THE SAME CHECK AS `commitList`, AND `type=number` NEEDS IT MORE, NOT LESS. `change`
			// fires on the input's STRING: `15.0`, `015` and `1.5e1` each differ from `15` as text, so
			// the browser reports a change, each parses to the number already stored, and each PATCHed
			// a policy that did not move — another policy_changes diff and audit row for nothing.
			// Compared as NUMBERS for the same reason `commitList` compares the parsed array.
			if (n === Number(policy.value)) {
				// The box is showing a spelling the rail does not hold (`015`). Same principle as the
				// reject branch below: never leave text on screen that is not the saved value.
				el.value = String(policy.value);
				return;
			}
			onchange(n);
			return;
		}
		// Revert. Returning silently left the REJECTED text sitting in the box while the saved
		// policy still held the old value — the admin believes they changed something they didn't.
		el.value = String(policy.value);
	}

	/** `map` = a fixed-key string dictionary (e.g. models.work_tiers → small/medium/large).
	 *  One labelled field per key; the key set never changes, only the values. */
	const mapEntries = $derived(
		policy.control === 'map' && policy.value && typeof policy.value === 'object' && !Array.isArray(policy.value)
			? Object.entries(policy.value as Record<string, string>)
			: []
	);
	/** The reader's words for this rail. `policy.label` / `policy.description` are the seeder's
	 *  English and are deliberately never read — see $lib/i18n/policy-label.ts. */
	const name = $derived(policyLabel(policy.key));
	const desc = $derived(policyDescription(policy.key));

	function commitMapEntry(key: string, e: Event) {
		const el = e.target as HTMLInputElement;
		const current = { ...(policy.value as Record<string, string>) };
		const next = el.value.trim();
		if (!next) {
			// Same reason as commitNumber: never leave a rejected value on screen pretending to be saved.
			el.value = current[key] ?? '';
			return;
		}
		if (current[key] === next) return;
		onchange({ ...current, [key]: next });
	}
</script>

<div class="policy-row">
	<div class="policy-main">
		<div class="policy-name">{name}</div>
		<div class="policy-desc">{desc}</div>
	</div>
	<div class="policy-control" class:busy>
		<!-- ⛔ A RETIRED RAIL RENDERS NO CONTROL AT ALL. `data.eu_only` still holds the value `true`
		     in the database, so showing its toggle — even greyed out, even under a "Retired" heading —
		     puts a switch reading ON next to the words "EU-only execution" on a compliance screen,
		     which is the assertion this whole change exists to withdraw. The backend refuses a PATCH
		     on a retired key too (routes/governance.ts): the row is read-only on both sides, not just
		     visually. The name and the honest paragraph stay, because an auditor reading an old
		     `policy_changes` entry needs to find the rail it names. -->
		{#if policy.enforcement === 'retired'}
			<span class="retired-mark">{m.governance_enforcement_retired_mark()}</span>
		{:else if policy.control === 'toggle'}
			<!-- `label` here is the switch's ACCESSIBLE NAME, not decoration: leaving it on
			     `policy.label` would localize the sighted row and read English to a screen reader. -->
			<Toggle checked={policy.value === true} disabled={busy} label={name} onchange={(v) => onchange(v)} />
		{:else if policy.control === 'number'}
			<div class="num-wrap">
				<!-- `%` is handled by the branch below (it sits AFTER the input); every other unit is a
				     prefix. `policyUnitLabel` translates the one unit that is a word and returns `€`
				     and any future symbol verbatim. -->
				{#if policy.unit && policy.unit !== '%'}<span class="unit pre">{policyUnitLabel(policy.unit)}</span>{/if}
				<input
					class="input num"
					type="number"
					min="0"
					value={String(policy.value)}
					disabled={busy}
					onchange={commitNumber}
				/>
				{#if policy.unit === '%'}<span class="unit">%</span>{/if}
			</div>
		{:else if policy.control === 'select'}
			<select
				class="select"
				value={String(policy.value)}
				disabled={busy}
				onchange={(e) => onchange((e.target as HTMLSelectElement).value)}
			>
				<!-- ⚠️ `value={opt}` IS THE WIRE VALUE and must stay the raw option: it is PATCHed back
				     to /api/governance, where `validateValue` checks it against `policies.options`.
				     Only the text node between the tags is localized. -->
				{#each policy.options ?? [] as opt (opt)}
					<option value={opt}>{policyOptionLabel(policy.key, opt)}</option>
				{/each}
			</select>
		{:else if policy.control === 'list'}
			{#if editingList}
				<!-- svelte-ignore a11y_autofocus -->
				<input
					class="input list-edit"
					bind:value={listDraft}
					disabled={busy}
					placeholder={m.ops_policy_list_placeholder()}
					onblur={commitList}
					onkeydown={(e) => {
						if (e.key === 'Enter') commitList();
						else if (e.key === 'Escape') cancelListEdit();
					}}
					autofocus
				/>
			{:else}
				<div class="badges">
					{#each [...new Set(((policy.value as string[]) ?? []))] as m (m)}
						<span class="badge teal">{m}</span>
					{/each}
					<button class="badge outline" disabled={busy} onclick={startListEdit}>{m.ops_policy_edit()}</button>
				</div>
			{/if}
		{:else if policy.control === 'map'}
			<div class="map-fields">
				<!-- Same rule as the <option> above: `key` stays the real map key (commitMapEntry sends
				     it back); only the visible word is localized, and only for the rail whose keys ARE
				     words — `models.pricing` keys are model identifiers and fall through verbatim. -->
				{#each mapEntries as [key, val] (key)}
					<label class="map-field">
						<span class="map-key">{policyMapKeyLabel(policy.key, key)}</span>
						<input
							class="input map-value"
							value={val}
							disabled={busy}
							onchange={(e) => commitMapEntry(key, e)}
						/>
					</label>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.policy-row {
		display: grid;
		grid-template-columns: 1fr auto;
		align-items: center;
		gap: 16px;
		padding: 16px 18px;
		border-bottom: 1px solid var(--c-border);
	}
	.policy-row:last-child {
		border-bottom: none;
	}
	.policy-name {
		font-weight: 500;
		color: var(--c-midnight);
		margin-bottom: 2px;
		font-size: 13.5px;
	}
	.policy-desc {
		font-size: 12.5px;
		color: var(--c-muted);
		line-height: 1.45;
	}
	.policy-control {
		display: flex;
		justify-content: flex-end;
		align-items: center;
	}
	.policy-control.busy {
		opacity: 0.6;
	}
	.retired-mark {
		font-size: 12px;
		font-weight: 500;
		color: var(--c-muted);
		border: 1px dashed var(--c-border-strong);
		border-radius: var(--r);
		padding: 5px 10px;
		white-space: nowrap;
	}
	.num-wrap {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}
	.unit {
		font-size: 12.5px;
		color: var(--c-muted);
	}
	.input {
		border: 1px solid var(--c-border-strong);
		border-radius: var(--r);
		padding: 6px 10px;
		font-size: 13px;
		font-family: inherit;
		color: var(--c-ink);
		background: var(--c-white);
	}
	.input.num {
		width: 80px;
		text-align: end;
	}
	.map-fields {
		display: grid;
		gap: 6px;
	}
	.map-field {
		display: grid;
		grid-template-columns: auto 1fr;
		align-items: center;
		gap: 8px;
	}
	.map-key {
		font-size: 12.5px;
		color: var(--c-muted);
		text-transform: capitalize;
		justify-self: end;
	}
	.input.map-value {
		width: 320px;
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 12.5px;
	}
	.input.list-edit {
		width: 320px;
	}
	.select {
		border: 1px solid var(--c-border-strong);
		border-radius: var(--r);
		padding: 6px 10px;
		font-size: 13px;
		font-family: inherit;
		color: var(--c-ink);
		background: var(--c-white);
		min-width: 110px;
	}
	.badges {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
		justify-content: flex-end;
		align-items: center;
		max-width: 360px;
	}
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		border-radius: 4px;
		font-size: 11px;
		font-weight: 500;
		border: none;
		font-family: inherit;
		cursor: default;
	}
	.badge.teal {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.badge.outline {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		color: var(--c-muted);
		cursor: pointer;
	}
	/* Phone width: the control drops under its label — an `auto` column sized to a list control
	   pushed the governance screen ~260px past a 390px viewport. */
	@media (max-width: 767.98px) {
		.policy-row { grid-template-columns: minmax(0, 1fr); }
		.policy-control { justify-content: flex-start; min-width: 0; flex-wrap: wrap; }
		.map-fields { width: 100%; min-width: 0; }
		.map-field { grid-template-columns: minmax(0, 1fr); }
		.map-key { justify-self: start; }
		.input.map-value, .input.list-edit { width: 100%; min-width: 0; }
	}
</style>
