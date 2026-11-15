<script lang="ts">
	import type { SandboxStatus } from '$lib/types/sandboxes';
	import * as m from '$lib/paraglide/messages';
	let { status }: { status: SandboxStatus } = $props();
	// Resolved in the template so the label re-evaluates when the locale changes.
	const labelFor = (s: SandboxStatus): string =>
		({
			running: m.status_running(),
			idle: m.status_idle(),
			suspended: m.status_suspended(),
			error: m.status_error()
		})[s];
</script>

<span class="dot-status {status}"><span class="d"></span>{labelFor(status)}</span>

<style>
	.dot-status {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
		color: var(--c-ink);
	}
	.dot-status .d {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--c-muted);
	}
	.dot-status.running .d {
		background: var(--c-emerald);
	}
	.dot-status.idle .d {
		background: var(--c-amber);
	}
	.dot-status.suspended .d {
		background: var(--c-muted);
	}
	.dot-status.error .d {
		background: var(--c-rose);
	}
</style>
