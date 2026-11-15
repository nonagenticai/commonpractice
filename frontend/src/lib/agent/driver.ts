// src/lib/agent/driver.ts — the agent co-pilot driver (SPEC §5A Layer 3). It fulfils
// the agent's frontend (edit) tool calls by operating the builder the way a user does,
// then committing through the SAME builder-store actions a user's clicks use — so human
// and AI edits share one path, one source of truth (flows.graph), one autosave + snapshot.
//
// Session 7: the headline build verbs (add_node, connect_nodes, configure_node) are
// performed as REAL synthetic DOM interactions — a synthetic cursor drags a palette tile
// onto the canvas, drags a port handle to another, types into the real config field —
// via synthetic.ts. The robustness rule is absolute: the MUTATION IS AUTHORITATIVE, the
// puppetry is cosmetic. Every action verifies the resulting store state; if the element
// can't be located or the gesture didn't land, it instantly applies the same store
// action. Correctness never depends on the animation. Structural verbs (insert/remove/
// disconnect/move) have no clean 1:1 user gesture or need exact flow coords, so they get
// a cursor flourish + a direct store apply.
import { agentEditLine } from '$lib/i18n/agent-edit-label';
import type { BuilderStore, BlockEntry, CpNode } from '$lib/stores/builder.svelte';
import { nextFreePosition } from '$lib/stores/builder-graph';
import type { ToolResultPayload } from '$lib/types/agent';
import { cursor } from './cursor.svelte';
import * as locate from './locate';
import {
	syntheticAddNode,
	syntheticConnect,
	syntheticConfigure,
	flourishTo,
} from './synthetic';

/** Resolve a block slug to the entry addNode needs (reuses the page's block cache). */
export type ResolveEntry = (slug: string) => Promise<BlockEntry | null>;

/**
 * Where the n-th node lands when nobody pointed at a spot — a cascade, so successive adds do not
 * stack on one coordinate and read as "only one was added".
 *
 * Module-level and exported because the agent is no longer the only caller: activating a palette
 * tile by click or keyboard supplies no drop point either, and /build reuses this rather than
 * inventing a second placement rule that drifts from this one.
 */
export function cascadePosition(nodes: readonly CpNode[]): { x: number; y: number } {
	return nextFreePosition(nodes);
}

interface AnyInput {
	slug?: string;
	nodeId?: string;
	edgeId?: string;
	source?: string;
	sourceHandle?: string;
	target?: string;
	targetHandle?: string;
	key?: string;
	value?: unknown;
	position?: { x: number; y: number };
}

/**
  * Human-readable one-liner for the chat activity feed, IN THE READER'S LANGUAGE.
  *
  * ⛔ THE WORDS USED TO BE COMPOSED HERE, IN ENGLISH — `add ${i.slug}`, `set ${i.key}`, `move a
  * node` — and `agent-chat.svelte.ts` pushes them into a feed that `ChatPanel.svelte` renders
  * verbatim inside fully-Dutch chrome. /build is ungated, so a Dutch demo met this on the first
  * copilot prompt. The vocabulary now lives in `$lib/i18n/agent-edit-label.ts`, shared with the two
  * block drivers so the three cannot drift apart.
  */
export function describeEdit(name: string, input: unknown): string {
	return agentEditLine(name, input);
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export class AgentDriver {
	constructor(
		private readonly builder: BuilderStore,
		private readonly resolveEntry: ResolveEntry,
	) {}

	/** Apply one frontend edit tool call; returns the result to POST back to the loop. */
	async apply(name: string, input: unknown): Promise<ToolResultPayload> {
		const i = (input ?? {}) as AnyInput;
		try {
			switch (name) {
				case 'add_node':
					return await this.addNode(i);
				case 'connect_nodes':
					return await this.connect(i);
				case 'configure_node':
					return await this.configure(i);
				case 'insert_node':
					return await this.insert(i);
				case 'remove_node':
					return await this.remove(i);
				case 'disconnect_nodes':
					this.builder.disconnectNodes(i.edgeId ?? '');
					return { ok: true };
				case 'move_node':
					return await this.move(i);
				default:
					return { ok: false, error: `unknown frontend tool '${name}'` };
			}
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	// ---- add_node: real palette→canvas drag, else instant addNode ----
	private async addNode(i: AnyInput): Promise<ToolResultPayload> {
		const entry = await this.resolveEntry(i.slug ?? '');
		if (!entry) return { ok: false, error: `unknown block '${i.slug}'` };

		const before = new Set(this.builder.nodes.map((n) => n.id));
		const tile = locate.paletteTile(entry.slug);
		const canvasEl = locate.canvas();
		if (tile && canvasEl) {
			const landed = await syntheticAddNode(this.builder, tile, canvasEl, entry.slug);
			if (landed) {
				const created = this.builder.nodes.find((n) => !before.has(n.id));
				if (created) {
					this.builder.selectedNodeId = created.id;
					return { ok: true, output: { nodeId: created.id } };
				}
			}
		}
		// fallback — instant store apply (authoritative)
		const nodeId = this.builder.addNode(entry, i.position ?? this.nextPosition());
		return { ok: true, output: { nodeId } };
	}

	// ---- connect_nodes: real handle→handle pointer drag, else instant connectNodes ----
	private async connect(i: AnyInput): Promise<ToolResultPayload> {
		const source = i.source ?? '';
		const sourceHandle = i.sourceHandle ?? '';
		const target = i.target ?? '';
		const targetHandle = i.targetHandle ?? '';
		const matches = () =>
			this.builder.edges.some(
				(e) =>
					e.source === source &&
					e.sourceHandle === sourceHandle &&
					e.target === target &&
					e.targetHandle === targetHandle,
			);

		const src = locate.handleEl(source, sourceHandle, 'source');
		const tgt = locate.handleEl(target, targetHandle, 'target');
		if (src && tgt && !matches()) {
			const wired = await syntheticConnect(this.builder, src, tgt, matches);
			if (wired) {
				const edge = this.builder.edges.find(
					(e) =>
						e.source === source &&
						e.sourceHandle === sourceHandle &&
						e.target === target &&
						e.targetHandle === targetHandle,
				);
				if (edge) return { ok: true, output: { edgeId: edge.id } };
			}
		}
		const edgeId = this.builder.connectNodes(source, sourceHandle, target, targetHandle);
		return { ok: true, output: { edgeId } };
	}

	// ---- configure_node: select node → type into the real field, else instant set ----
	private async configure(i: AnyInput): Promise<ToolResultPayload> {
		const nodeId = i.nodeId ?? '';
		const key = i.key ?? '';
		// Open the inspector the way a user click does, then let it render.
		if (this.builder.selectedNodeId !== nodeId) {
			this.builder.selectedNodeId = nodeId;
			await tick();
		}
		const field = locate.configField(key);
		if (field) {
			const applied = () => this.configHas(nodeId, key);
			const typed = await syntheticConfigure(field, i.value, applied);
			if (typed) return { ok: true };
		}
		this.builder.updateConfig(nodeId, key, i.value);
		return { ok: true };
	}

	// ---- structural verbs: cursor flourish + direct store apply ----
	private async insert(i: AnyInput): Promise<ToolResultPayload> {
		const entry = await this.resolveEntry(i.slug ?? '');
		if (!entry) return { ok: false, error: `unknown block '${i.slug}'` };
		const nodeId = this.builder.insertNode(entry, i.edgeId ?? '', i.position ?? this.nextPosition());
		if (!nodeId) return { ok: false, error: `unknown edge '${i.edgeId}'` };
		return { ok: true, output: { nodeId } };
	}

	private async remove(i: AnyInput): Promise<ToolResultPayload> {
		await flourishTo(locate.nodeEl(i.nodeId ?? ''));
		this.builder.removeNode(i.nodeId ?? '');
		return { ok: true };
	}

	private async move(i: AnyInput): Promise<ToolResultPayload> {
		await flourishTo(locate.nodeEl(i.nodeId ?? ''));
		this.builder.moveNode(i.nodeId ?? '', i.position ?? this.nextPosition());
		return { ok: true };
	}

	private configHas(nodeId: string, key: string): boolean {
		const node = this.builder.nodes.find((n) => n.id === nodeId);
		return !!node && Object.prototype.hasOwnProperty.call(node.data.config, key);
	}

	/** Cascade newly-added nodes so they don't stack on one spot. */
	private nextPosition(): { x: number; y: number } {
		return cascadePosition(this.builder.nodes);
	}
}

// Re-exported so the build page can hide the cursor when a turn ends, if desired.
export { cursor };
