// src/lib/agent/block-author-driver.ts — the block-authoring copilot's frontend-tool driver.
// Where the canvas AgentDriver applies edits to the flow graph, this applies the agent's
// `propose_block_draft` tool call to the block EDITOR: it hands the proposed draft to a
// callback the editor uses to pre-fill its create buffers (descriptor + source + docs +
// examples), the same way picking a starter template does. The developer reviews the filled
// buffers and clicks Create — propose_block_draft never writes to the server itself.
import { agentEditLine } from '$lib/i18n/agent-edit-label';
import type { ChatDriver } from '$lib/stores/agent-chat.svelte';
import type { ToolResultPayload } from '$lib/types/agent';
import type { BlockCategory, BlockDescriptor } from '$lib/types/blocks';

/** The draft the agent proposes (payload of the `propose_block_draft` frontend tool). */
export interface BlockDraftProposal {
	name?: string;
	slug?: string;
	category?: BlockCategory;
	description?: string;
	descriptor?: BlockDescriptor;
	source_ts?: string;
	docs_md?: string;
	examples?: unknown[];
}

export class BlockAuthorDriver implements ChatDriver {
	constructor(private readonly onProposal: (draft: BlockDraftProposal) => void) {}

	async apply(name: string, input: unknown): Promise<ToolResultPayload> {
		if (name === 'propose_block_draft') {
			this.onProposal((input ?? {}) as BlockDraftProposal);
			return { ok: true, output: { applied: true } };
		}
		return { ok: false, error: `unknown editor tool '${name}'` };
	}
}

/**
 * Human-readable label for the activity feed, in the reader's language.
 *
 * ⛔ WAS THE ENGLISH LITERAL `'draft a block'`, rendered by ChatPanel inside Dutch chrome. The
 * vocabulary is shared with driver.ts and block-fix-driver.ts via `agentEditLine`.
 */
export function describeBlockEdit(name: string): string {
	return agentEditLine(name, null);
}
