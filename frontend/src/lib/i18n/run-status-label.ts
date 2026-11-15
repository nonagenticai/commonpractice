// src/lib/i18n/run-status-label.ts — the ONE place a flow-run status becomes words a reader
// can read.
//
// ⛔ THE DEFECT. The /sandboxes run-history drawer rendered the enum itself:
//   <span class="run-status {r.status}">{r.status}</span>
// so a Dutch operator opening a sandbox saw "running / ok / partial / failed" in a drawer whose
// every other field — including the sandbox status two rows above it, via <DotStatus> — was
// already localized. The wire carries the ENUM; the browser owns the words.
//
// ⚠️ THIS IS NOT <DotStatus> AND MUST NOT BE FOLDED INTO IT. `DotStatus` renders
// `SandboxStatus` = running | idle | suspended | error — the sandbox LIFECYCLE. A run carries
// `flow_run_status` = running | ok | partial | failed (backend/src/db/schema.ts:469). The two
// enums share exactly one member ('running') and mean different things by it; routing runs
// through DotStatus would need a lossy `ok → running`, `partial → idle`, `failed → error`
// remap. That remap already exists once, hand-rolled inline, in routes/governance/+page.svelte
// — and it is precisely how a `partial` run (some steps failed) would come to render under the
// same amber dot as an IDLE sandbox. A second enum gets a second vocabulary, not a coercion.
// The drawer keeps its own `.run-status` styling, which already colours all four values.
//
// Pure and structured as an exhaustive switch for the reason spelled out in `stage-label.ts`:
// paraglide compiles one function per key and tree-shakes on the import graph, so a computed
// `m[`run_status_${s}`]()` does not resolve.
import * as m from '$lib/paraglide/messages';

/**
 * The reader's word for a flow-run status.
 *
 * Takes `string` because `SandboxRun.status` is typed loosely on the wire (`status: string` in
 * `$lib/types/sandboxes`) — it mirrors a pg enum the frontend does not own. An unrecognised value
 * returns the RAW KEY, which is exactly what the screen rendered before this change: a status
 * added server-side ships an ugly word rather than a blank cell, and never an English sentence.
 */
export function runStatusLabel(status: string): string {
	switch (status) {
		case 'running':
			return m.run_status_running();
		case 'ok':
			return m.run_status_ok();
		case 'partial':
			return m.run_status_partial();
		case 'failed':
			return m.run_status_failed();
		default:
			return status;
	}
}
