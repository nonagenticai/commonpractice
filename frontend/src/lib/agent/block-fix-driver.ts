// src/lib/agent/block-fix-driver.ts — the block fix-loop copilot's frontend-tool driver.
// Where BlockAuthorDriver applies `propose_block_draft` to PRE-FILL a new block, this applies
// `propose_block_patch` to the OPEN draft: it hands the proposed corrected source to a callback
// the editor uses to show a reviewable diff. The developer reviews the diff and Applies it —
// propose_block_patch never writes to the server itself (the editor saves on Apply).
import { agentEditLine } from '$lib/i18n/agent-edit-label';
import type { ChatDriver } from '$lib/stores/agent-chat.svelte';
import type { ToolResultPayload } from '$lib/types/agent';

/** The patch the agent proposes (payload of the `propose_block_patch` frontend tool). */
export interface BlockPatchProposal {
	source_ts: string;
	summary?: string;
	rationale?: string;
}

/** The failing context an entry point ("Fix with AI" on a lint finding / failed test /
 *  simulate error) hands to the fix copilot to seed its first message. */
export interface BlockFixContext {
	origin: 'lint' | 'test' | 'simulate';
	errorKind?: string | null;
	errorMessage?: string | null;
	diffs?: { path: string; kind: string; expected?: unknown; actual?: unknown }[] | null;
	lint?: { rule: string; message: string; line?: number; source?: string }[] | null;
	testName?: string | null;
}

export class BlockFixDriver implements ChatDriver {
	constructor(private readonly onProposal: (patch: BlockPatchProposal) => void) {}

	async apply(name: string, input: unknown): Promise<ToolResultPayload> {
		if (name === 'propose_block_patch') {
			const p = (input ?? {}) as BlockPatchProposal;
			if (typeof p.source_ts !== 'string' || !p.source_ts.trim()) {
				return { ok: false, error: 'propose_block_patch requires a non-empty source_ts' };
			}
			this.onProposal(p);
			return { ok: true, output: { applied: true } };
		}
		return { ok: false, error: `unknown fix tool '${name}'` };
	}
}

/**
 * Human-readable label for the activity feed, in the reader's language.
 *
 * ⛔ WAS THE ENGLISH LITERAL `'propose a fix'`, rendered by ChatPanel inside Dutch chrome. The
 * vocabulary is shared with driver.ts and block-author-driver.ts via `agentEditLine`.
 */
export function describeBlockFix(name: string): string {
	return agentEditLine(name, null);
}
