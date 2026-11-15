// src/lib/i18n/agent-edit-label.ts — the ONE place an agent tool call becomes a line the reader of
// the chat activity feed can read.
//
// ⛔ THE DEFECT. `driver.ts:describeEdit` composed English verbs — `add ${slug}`, `insert ${slug}`,
// `remove a node`, `connect ${sourceHandle} → ${targetHandle}`, `disconnect an edge`, `set ${key}`,
// `move a node` — and `agent-chat.svelte.ts` pushed them straight into the feed, where
// `ChatPanel.svelte` renders them verbatim inside fully-Dutch chrome. `/build` is UNGATED: a Dutch
// demo hits this on the FIRST copilot prompt, so it was the most-seen English text in the product.
// `block-author-driver.ts` ('draft a block') and `block-fix-driver.ts` ('propose a fix') were the
// same defect on the block surfaces.
//
// Same split as `ops-event-label.ts`: the wire carries the tool NAME plus machine fields, the
// browser owns the words. The three drivers now delegate here rather than each keeping their own
// English fragment to drift.
//
// ⛔ `slug`, `key`, `sourceHandle` AND `targetHandle` ARE IDENTIFIERS AND ARE INTERPOLATED
// VERBATIM. They are block slugs, config keys and port handle ids — the strings that appear in
// `flows.graph`, in the descriptor and on the canvas. Translating one would name a thing that does
// not exist, and would make the feed line unusable for the reader who wants to find that node.
//
// ⛔ THE DEFAULT ARM STAYS PROSE. A tool added backend-first reaches this function before the
// catalog knows its name; `agent_edit_unknown` states that a step ran and names it, which is
// honest, rather than degrading to a bare `configure_node` token the reader cannot parse.
import * as m from '$lib/paraglide/messages';

/** The fields the frontend edit tools carry (mirrors `AnyInput` in `driver.ts`). */
interface EditInput {
	slug?: string;
	key?: string;
	source?: string;
	sourceHandle?: string;
	target?: string;
	targetHandle?: string;
}

/**
 * One activity-feed line for one agent tool call, in the reader's language.
 *
 * `input` is `unknown` because it arrives off the SSE wire — the shape is the agent's claim, not a
 * guarantee, so every field is read defensively.
 */
export function agentEditLine(name: string, input: unknown): string {
	const i = (input ?? {}) as EditInput;
	switch (name) {
		case 'add_node':
			return m.agent_edit_add_node({ slug: i.slug ?? '' });
		case 'insert_node':
			return m.agent_edit_insert_node({ slug: i.slug ?? '' });
		case 'remove_node':
			return m.agent_edit_remove_node();
		case 'connect_nodes':
			// ⚠️ The handle ids are the honest subject of this line, but a call that omits them is a
			// real wire shape (the agent may connect by node id alone). Fall back to the node id
			// rather than printing the string "undefined", which is what the English version did.
			return m.agent_edit_connect_nodes({
				source: i.sourceHandle ?? i.source ?? '',
				target: i.targetHandle ?? i.target ?? ''
			});
		case 'disconnect_nodes':
			return m.agent_edit_disconnect_nodes();
		case 'configure_node':
			return m.agent_edit_configure_node({ key: i.key ?? '' });
		case 'move_node':
			return m.agent_edit_move_node();
		// The block surfaces' single tool each — one vocabulary, so the three drivers cannot drift.
		case 'propose_block_draft':
			return m.agent_edit_draft_block();
		case 'propose_block_patch':
			return m.agent_edit_propose_fix();
		default:
			return m.agent_edit_unknown({ name });
	}
}
