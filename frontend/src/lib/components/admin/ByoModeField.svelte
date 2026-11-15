<script lang="ts" generics="T extends ByoMode | ''">
	// The "LLM access" (BYO mode) field, shared by the create form ((platform)/tenants) and the
	// licence editor ((platform)/tenants/[id]).
	//
	// ⛔ When the selected plan FIXES the mode (`fixed !== null`) there is NO select. It used to be a
	// disabled <select> followed by "Set by the plan: <mode>." — a dropdown that does not open and a
	// hint that repeats it. Now the mode is plain read-only text plus one hint saying the plan sets it.
	// What is SENT is unchanged and is not decided here: each page's `postureFor` effect still writes
	// the plan's mode into its bound value, and the create form still omits `byoMode` when fixed.
	import * as m from '$lib/paraglide/messages';
	import type { ByoMode } from '$lib/types/admin';
	import { BYO_MODES, BYO_MODE_LABEL, byoModeHelp } from '$lib/admin/tenant-labels';

	let {
		id,
		testid,
		value = $bindable(),
		fixed,
		allowUnknown = false,
		onchoose
	}: {
		/** id of the control; the read-only text uses it too, so the label always points at something. */
		id: string;
		/** data-testid prefix, e.g. `licence` → `licence-byo`, `licence-byo-value`, … */
		testid: string;
		value: T;
		/** The mode the plan fixes, or null when the operator chooses. */
		fixed: ByoMode | null;
		/** Offer the "unknown" option (licences could not be read; sends nothing). */
		allowUnknown?: boolean;
		/** Called with the operator's pick (only possible when not fixed). */
		onchoose: (mode: T) => void;
	} = $props();
</script>

{#if fixed}
	<span class="label" id="{id}-label">{m.admin_tenants_byo_label()}</span>
	<p class="readonly-value" {id} aria-labelledby="{id}-label" aria-describedby="{id}-fixed"
		data-testid="{testid}-byo-value">{BYO_MODE_LABEL[fixed]()}</p>
	<span class="hint" id="{id}-fixed" data-testid="{testid}-byo-fixed">{m.admin_tenants_byo_fixed_by_plan()}</span>
{:else}
	<label for={id}>{m.admin_tenants_byo_label()}</label>
	<select {id} data-testid="{testid}-byo" bind:value onchange={(e) => onchoose(e.currentTarget.value as T)}>
		{#if allowUnknown}
			<option value="">{m.admin_licence_byo_unknown()}</option>
		{/if}
		{#each BYO_MODES as mode (mode)}
			<option value={mode}>{BYO_MODE_LABEL[mode]()}</option>
		{/each}
	</select>
{/if}
<span class="hint byo-help" data-testid="{testid}-byo-help">{byoModeHelp(value)}</span>

<style>
	/* Mirrors the field styles of both tenant pages (their styles are component-scoped). */
	label, .label { font-size: 12.5px; font-weight: 600; color: var(--c-ink); margin-bottom: 6px; }
	.readonly-value { font-size: 13.5px; color: var(--c-ink); margin: 0; padding: 9px 0; }
	.hint { font-size: 11px; color: var(--c-muted); margin: 4px 0 0; line-height: 1.45; }
	.byo-help { max-width: 760px; }
	select { font-family: var(--font-sans); font-size: 13.5px; color: var(--c-ink); border: 1px solid var(--c-border); border-radius: var(--r); padding: 9px 12px; width: 100%; box-sizing: border-box; background: var(--c-white); min-width: 0; }
</style>
