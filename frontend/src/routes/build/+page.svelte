<script lang="ts">
	// Build canvas — the `build` screen (demo.html:2426–2735). A SvelteFlow graph
	// composed from the published block library, autosaved to /api/flows as JSONB.
	// AI chat is the live, metered agent loop (SSE) that drives the canvas through the
	// builder store; the console streams the real per-node run trace. Keyed by ?id=.
	import '@xyflow/svelte/dist/style.css';
	import { onMount, untrack, tick } from 'svelte';
	import { reloadOnLocaleChange } from '$lib/i18n/reload-on-locale.svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { SvelteFlowProvider, type Edge } from '@xyflow/svelte';
	import { blocksApi } from '$lib/api/blocks';
	import { applyPortLabels, portLabel } from '$lib/i18n/port-label';
	import { flowsApi } from '$lib/api/flows';
	import { challengesApi } from '$lib/api/challenges';
	import { runsApi, runErrorIssues, runErrorDataFindings } from '$lib/api/runs';
	import { dataValidationFrom } from '$lib/api/data-findings';
	import { dataFindingLabel, dataFindingRef } from '$lib/i18n/data-finding-label';
	import { graphIssueLabel, bidiIsolate } from '$lib/i18n/graph-issue-label';
	import { solutionsApi, solutionErrorIssues } from '$lib/api/solutions';
	import { streamRun, type StreamControl } from '$lib/services/sse';
	import { BuilderStore, type BlockEntry, type CpNode } from '$lib/stores/builder.svelte';
	import { isBlockKind } from '$lib/stores/builder-graph';
	import { publishBlockCatalog, nodeDisplayName } from '$lib/stores/block-catalog.svelte';
	import { RunTraceStore } from '$lib/stores/run-trace.svelte';
	import { AgentDriver, cascadePosition } from '$lib/agent/driver';
	import { AgentChatStore } from '$lib/stores/agent-chat.svelte';
	import type { BlockDescriptor, BlockDetail, BlockListItem } from '$lib/types/blocks';
	import type {
		DataValidationFinding,
		DataValidationMode,
		FlowListItem,
		GraphIssue
	} from '$lib/types/flows';
	import BuildTopbar from '$lib/components/build/BuildTopbar.svelte';
	import BlockPalette from '$lib/components/build/BlockPalette.svelte';
	import FlowCanvas from '$lib/components/build/FlowCanvas.svelte';
	import NodeConfigPanel from '$lib/components/build/NodeConfigPanel.svelte';
	import ChallengeDataPanel from '$lib/components/build/ChallengeDataPanel.svelte';
	import { sampleBindingFrom, sampleRefusalView, type SampleTestView } from '$lib/components/build/sample-test';
	import ChatPanel from '$lib/components/build/ChatPanel.svelte';
	import RunConsole from '$lib/components/build/RunConsole.svelte';
	import FlowHistoryPanel from '$lib/components/build/FlowHistoryPanel.svelte';
	import FlowTemplateGallery from '$lib/components/build/FlowTemplateGallery.svelte';
	import NewFlowChoice from '$lib/components/build/NewFlowChoice.svelte';
	import SaveFlowTemplateDialog from '$lib/components/build/SaveFlowTemplateDialog.svelte';
	import type { UseFlowTemplateResult } from '$lib/types/flow-templates';
	import SyntheticCursor from '$lib/agent/SyntheticCursor.svelte';
	import { builderBootUrl, solutionSubmissionPayload } from './entry';
	import { num, timeAgo } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import * as m from '$lib/paraglide/messages';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { sidebar } from '$lib/stores/sidebar.svelte';
	import { auth } from '$lib/stores/auth.svelte';
	import { fieldTypes } from '$lib/stores/field-types.svelte';
	import { canSeeSessionCost } from '$lib/components/build/session-cost-visibility';
	import { canSeeInternalErrors } from '$lib/components/build/run-error-visibility';
	import { roleAllows } from '$lib/layout/navConfig';

	const builder = new BuilderStore();
	const runTrace = new RunTraceStore();
	const idParam = $derived(page.url.searchParams.get('id'));
	// Phase 3.4: the challenge being worked (?challenge=…), forwarded to the agent so it
	// auto-resolves the ontology cell. Populated once "open challenge in build" (3.1) lands.
	const challengeParam = $derived(page.url.searchParams.get('challenge'));
	// Is that challenge's cycle over? Off the wire (`cycleClosed`), captured by the fetch below —
	// which this page ALREADY performs for the datasets, so this costs no extra round-trip.
	//
	// ⛔ WHY THE GATE LIVES HERE AND NOT ONLY ON THE LINK. `?challenge=` is a hand-editable URL
	// parameter, and `builderBootUrl` deliberately carries it across every navigation this page
	// makes — so withdrawing the "Build a solution" CTA on the challenge page removes the INVITATION
	// without removing the ENTRANCE. A bookmark, a shared link, or a flow switch mid-session all
	// arrive here with a dead challenge in context and, before this, a fully live Submit button.
	let challengeClosed = $state(false);

	let running = $state(false);
	// True while `POST /api/runs` is resuming a test environment the idle watchdog paused (the server
	// resumes it as part of an explicit run, so the first run after a week away no longer fails).
	let startingEnv = $state(false);
	let runError = $state<string | null>(null);
	// The per-node issues behind a refused run. `POST /api/runs` answers an unrunnable graph with
	// `flow_invalid` + `details.issues` naming the offending node/edge, but `runError` is a single
	// interpolated sentence — so the tester was told the flow "is not ready to run" and never which
	// node, discarding the one thing the backend had already worked out. Rendered as a list inside
	// the same pill, so the summary and the detail stay one message.
	let runIssues = $state<GraphIssue[]>([]);
	// The ontology data-contract violations behind this run. ⛔ NOT the same axis as `runIssues`:
	// those say the GRAPH will not run, these say the DATA going into it breaks the contract — and
	// under the shipped `warn` policy the run PROCEEDS anyway, which is why these have their own
	// state and their own (non-error-toned) pill instead of riding on `runError`.
	let dataFindings = $state<DataValidationFinding[]>([]);
	// Which policy produced them: `block` ⇒ the run was refused and this renders inside the error
	// pill; `warn` ⇒ the run is running RIGHT NOW with this data and this is its own amber pill.
	// The browser cannot see `data.validation_mode`, so the backend says which it was.
	let dataFindingsMode = $state<DataValidationMode>('warn');
	// The warn pill is dismissible — it has no error to "fix" and would otherwise sit over the
	// canvas forever. Reset per run, never cleared by the run finishing (see `testRun`).
	let dataFindingsDismissed = $state(false);
	let stream: StreamControl | null = null;

	let paletteItems = $state<BlockListItem[]>([]);
	let paletteLoading = $state(true);
	/**
	 * ⛔ A FAILED LIBRARY IS NOT AN EMPTY LIBRARY. `loadPalette()` had a `finally` and no `catch`, so
	 * a failed `GET /api/blocks` left `paletteItems` at `[]` and the palette went on to render
	 * `blocks_no_match` — "No blocks match your search." — the moment the builder typed anything.
	 * An empty state standing in for a failure, the same class already fixed at
	 * `solutions/[id]/+page.svelte:509`, where the delivery load failure REPLACES the
	 * "no connector configured" line rather than sitting beside it.
	 *
	 * ⚠️ PALETTE-SCOPED, NOT PROMOTED TO `bootError`. The boot pill's sentence ("Couldn't load the
	 * builder") is about the whole screen, and the whole screen is fine — the canvas, the topbar and
	 * the flow all loaded. Only this panel is degraded, so only this panel says so, and it says it
	 * with a retry: `loadPalette` was called from `onMount` and nowhere else, so the reader's only
	 * way back used to be F5.
	 */
	let paletteError = $state<string | null>(null);
	/** One tile's failed `GET /api/blocks/:slug` — see `onDropBlock` for why it is not the palette's. */
	let addBlockError = $state<string | null>(null);
	let flowsList = $state<FlowListItem[]>([]);
	let bootError = $state<string | null>(null);
	/**
	 * The slugs whose descriptor prefetch failed on the current load — the nodes now sitting on the
	 * canvas with UNKNOWN ports (see `resolveDescriptor`). Load-scoped, cleared at the top of every
	 * `openFlow` exactly like `bootError`, and emptied slug by slug as `retryUnresolved` succeeds.
	 */
	let unresolvedSlugs = $state<string[]>([]);

	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let lastSavedAt = $state<string | null>(null);
	let submitting = $state(false);
	// Submitting is its own outcome, not a save outcome. It used to write into `saveError`, which
	// renders as "Save failed" in the topbar — the wrong sentence for "this challenge is closed".
	let submitError = $state<string | null>(null);
	// The per-node issues behind a refused publish. `POST /api/solutions` runs the SAME graph
	// validators as `POST /api/runs` and answers with the same `flow_invalid` + `details.issues`
	// body, so these render through the same list + `issueNodeLabel` mapping as `runIssues`.
	let submitIssues = $state<GraphIssue[]>([]);
	let now = $state(Date.now());
	let historyOpen = $state(false);
	// Flow templates: the gallery, the "New flow" choice, and "Save as template".
	let galleryOpen = $state(false);
	let newChoiceOpen = $state(false);
	let saveTemplateOpen = $state(false);
	// Bumped once the flow a template produced has loaded, so the canvas frames it.
	let fitNonce = $state(0);
	let fitAfterLoad = false;

	// ── Layout: three collapsible panes around the canvas ─────────────────────────────────────
	// ≥1440px: palette, canvas and side panel are all docked. 1024–1439px: the palette is a drawer
	// over the canvas. <1024px: there is no room to edit, so the canvas is view-only and says so.
	let viewportWidth = $state(1440);
	const wide = $derived(viewportWidth >= 1440);
	const narrow = $derived(viewportWidth < 1024);
	// ⛔ THE LAYOUT GATE GOES INTO THE STORE, NOT ONTO EACH PANEL. Passing `narrow` to the canvas and
	// the palette alone left the assistant, the Details panel, ⌘Z/⌘Y, the title and Submit live on a
	// canvas the note calls view-only. `builder.locked` is the one effective read-only they all read.
	$effect(() => {
		builder.viewOnly = narrow;
	});
	let paletteDocked = $state(true); // ≥1440: the reader's show/hide choice
	let paletteDrawerOpen = $state(false); // 1024–1439: the drawer, closed by default
	const paletteVisible = $derived(narrow ? false : wide ? paletteDocked : paletteDrawerOpen);
	function togglePalette() {
		if (wide) paletteDocked = !paletteDocked;
		else paletteDrawerOpen = !paletteDrawerOpen;
	}
	// null = the breakpoint's default (open, except on a narrow screen).
	let sideOpenChoice = $state<boolean | null>(null);
	const sideOpen = $derived(sideOpenChoice ?? !narrow);
	let sideTab = $state<'details' | 'data' | 'assistant'>('assistant');
	// The details and sample-data panels each load the dataset list on mount, so each is mounted
	// the first time it is SHOWN and kept from then on.
	let detailsMounted = $state(false);
	let dataMounted = $state(false);
	$effect(() => {
		if (sideOpen && sideTab === 'details') detailsMounted = true;
		if (sideOpen && sideTab === 'data') dataMounted = true;
	});
	/** Show the sample-data tab of the side pane (it used to be an overlay over the canvas). */
	function openDataTab() {
		sideOpenChoice = true;
		sideTab = 'data';
	}
	// Console: a 32px bar until the first test run opens it; after that it is the reader's call.
	let consoleOpen = $state(false);
	let consoleAutoOpened = false;
	const paletteCol = $derived(narrow ? '0px' : wide && paletteDocked ? '240px' : '32px');
	const sideCol = $derived(sideOpen ? (wide ? '320px' : '300px') : '32px');
	const consoleRow = $derived(consoleOpen ? '170px' : '32px');
	// The canvas re-fits whenever its box changes size.
	const fitKey = $derived(
		[paletteCol, sideCol, consoleRow, sidebar.collapsed, fitNonce].join('|')
	);

	// Selecting a node shows its details: the inspector is a tab of the side panel, not an overlay
	// covering the canvas. ALWAYS, from every tab: adding or clicking a step shows its details.
	// "Use" on the Sample data tab still works because the selection persists when the reader goes
	// back to that tab. ⛔ The effect must depend on the SELECTION only — reading `sideTab` here
	// would re-fire it when the reader picks Sample data with a step selected and bounce them back.
	$effect(() => {
		if (builder.selectedNodeId) {
			untrack(() => {
				sideTab = 'details';
				sideOpenChoice = true;
			});
		}
	});

	// Port type chips are a developer's switch (toolbar ⋯ menu); everyone else sees words only.
	$effect(() => {
		fieldTypes.allowed = auth.isDeveloper;
	});
	// The assistant's running LLM spend: tenant_admin and above.
	const showSessionCost = $derived(canSeeSessionCost(auth.user?.roles ?? []) || auth.isSuperAdmin);
	const showInternalErrors = $derived(canSeeInternalErrors(auth.user?.roles ?? []) || auth.isSuperAdmin);
	// Mapping dataset columns (/datasets) is developer+ (`canManageData` on the backend).
	const canMapData = $derived(roleAllows('developer', auth.user?.roles ?? []) || auth.isSuperAdmin);

	/** The Result panel names a step by its canvas block, not its identifier. */
	function stepName(nodeId: string, slug: string): string {
		const n = builder.nodes.find((x) => x.id === nodeId);
		return n && isBlockKind(n.data.kind) ? nodeDisplayName(n.data) : slug;
	}
	/** An output key in words: the block's own port label (already in the reader's locale), else humanised. */
	function outputLabel(nodeId: string, key: string): string {
		const n = builder.nodes.find((x) => x.id === nodeId);
		return portLabel(key, n?.data.descriptor?.outputs?.[key]);
	}

	// Empty canvas: three ways to start.
	let chatPanel = $state<{ focusInput: () => void } | null>(null);
	async function startWithAssistant() {
		sideOpenChoice = true;
		sideTab = 'assistant';
		await tick();
		chatPanel?.focusInput();
	}

	// The builder needs the width, so the app sidebar collapses to its icon rail while /build is on
	// screen. An OVERRIDE, not the saved preference: leaving /build restores the reader's choice.
	$effect(() => sidebar.setOverride(true));

	// Undo/redo over the canvas graph. SvelteFlow writes builder.nodes/edges directly
	// through bind:, so we snapshot the whole graph (debounced to coalesce drag ticks)
	// rather than instrument each mutation. nodes/edges are $state.raw — each change is a
	// fresh array, so storing the reference is a valid immutable snapshot, and reference
	// equality cleanly distinguishes a real edit from an undo/redo-applied state.
	type GraphSnap = { nodes: CpNode[]; edges: Edge[] };
	let undoStack = $state<GraphSnap[]>([]);
	let redoStack = $state<GraphSnap[]>([]);
	let lastGraph: GraphSnap | null = null;
	let histTimer: ReturnType<typeof setTimeout> | undefined;
	const canUndo = $derived(undoStack.length > 0);
	const canRedo = $derived(redoStack.length > 0);

	function resetHistory() {
		if (histTimer) clearTimeout(histTimer);
		undoStack = [];
		redoStack = [];
		lastGraph = { nodes: builder.nodes, edges: builder.edges };
	}

	// ⛔ BOTH APPLY THROUGH `builder.replaceGraph`, WHICH CAN REFUSE — AND NEITHER TOUCHES ITS STACKS
	// UNTIL IT HAS. These two used to assign `builder.nodes`/`builder.edges` here, which made them
	// the only writers on the page that never passed the store's read-only gate; the topbar buttons
	// are `disabled`, but `onKeydown` below hangs off `<svelte:window>` and reads no such thing, so
	// ⌘Z was a live mutator on a canvas the banner calls read-only. Testing `builder.readOnly` right
	// here would work and would be the wrong shape: the gate belongs in the store, where the
	// copilot's tool-calls and the palette's drops already meet it. Popping the stack BEFORE the
	// store answers would eat a history step on every refusal.
	function undo() {
		if (!undoStack.length) return;
		const prev = undoStack[undoStack.length - 1];
		if (!builder.replaceGraph(prev.nodes, prev.edges)) return;
		if (histTimer) clearTimeout(histTimer);
		undoStack = undoStack.slice(0, -1);
		if (lastGraph) redoStack = [...redoStack, lastGraph];
		lastGraph = prev; // ref-equal to the just-applied graph → recorder skips it
	}

	function redo() {
		if (!redoStack.length) return;
		const next = redoStack[redoStack.length - 1];
		if (!builder.replaceGraph(next.nodes, next.edges)) return;
		if (histTimer) clearTimeout(histTimer);
		redoStack = redoStack.slice(0, -1);
		if (lastGraph) undoStack = [...undoStack, lastGraph];
		lastGraph = next;
	}

	function onKeydown(e: KeyboardEvent) {
		if (!(e.ctrlKey || e.metaKey)) return;
		// Nothing to undo on a locked canvas (the store refuses anyway); leave the browser's own keys alone.
		if (builder.locked) return;
		// Don't hijack undo while typing in a field (title, config, chat, code editor).
		const el = e.target as HTMLElement | null;
		const tag = el?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
		const key = e.key.toLowerCase();
		if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
		else if ((key === 'z' && e.shiftKey) || key === 'y') { e.preventDefault(); redo(); }
	}
	// Phase 3.1: the sample-data panel is a side-pane tab (`sideTab === 'data'`); it opens itself
	// when a challenge is being worked.

	// After a restore, re-fetch + re-hydrate the canvas (resets lastSavedJson so the
	// autosave effect doesn't immediately re-write). openFlow already does all of it.
	async function onRestored() {
		if (idParam) await openFlow(idParam);
	}

	const blockCache = new Map<string, BlockDetail>();
	let loadSeq = 0;
	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	let lastSavedJson = '';

	async function ensureBlock(slug: string): Promise<BlockDetail> {
		const hit = blockCache.get(slug);
		if (hit) return hit;
		// Port labels go into THIS cache only (the canvas reads them); see applyPortLabels.
		const detail = applyPortLabels(await blocksApi.get(slug));
		blockCache.set(slug, detail);
		return detail;
	}
	function currentVersion(detail: BlockDetail) {
		return detail.versions.find((v) => v.id === detail.current_version_id) ?? detail.versions[0];
	}
	/**
	 * ⛔ `null`, NOT AN EMPTY DESCRIPTOR — THIS RETURN WAS THE DEFECT. It used to answer a cache MISS
	 * with `EMPTY_DESC`, a descriptor declaring no inputs and no outputs, which is a perfectly valid
	 * shape for a block that really has none. So any prefetch failure below — a 500, a block archived
	 * since the flow was saved, a dropped connection — loaded that node with NO PORTS, silently,
	 * while the flow reported a clean load.
	 *
	 * ⛔ AND THE CONSEQUENCE IS DATA LOSS PERFORMED BY THE READER, WHICH IS WHY IT NEVER SHOWED UP AS
	 * A BUG. `@xyflow/svelte@1.6.0` does not prune edges: `edges` is a `$bindable` pass-through
	 * (SvelteFlow.svelte:73–94), and the handle-driven filtering happens only in the `$derived`
	 * `getLayoutedEdges` (store/visibleElements.js), which omits the edge from the RENDERED map and
	 * never writes back to `signals.edges`. Its complaint is `devWarn` error 008, gated on
	 * `NODE_ENV === 'development'` — invisible in production. So the edge STILL SAVES and simply
	 * VANISHES FROM THE SCREEN, and the author, seeing a disconnected node, re-draws or deletes it.
	 * Nothing in the product ever said the descriptor was missing, so `unresolvedSlugs` does.
	 */
	function resolveDescriptor(slug: string, versionId: string): BlockDescriptor | null {
		const d = blockCache.get(slug);
		if (!d) return null;
		const v = d.versions.find((x) => x.id === versionId) ?? currentVersion(d);
		return v?.descriptor ?? null;
	}

	// The agent co-pilot: resolve a slug to a BlockEntry (same path as a palette drop),
	// drive edits through the shared builder store, and stream the chat over SSE.
	async function resolveEntry(slug: string): Promise<BlockEntry | null> {
		try {
			const detail = await ensureBlock(slug);
			const cur = currentVersion(detail);
			if (!cur) return null;
			return {
				blockId: detail.id,
				blockVersionId: cur.id,
				slug: detail.slug,
				name: detail.name,
				category: detail.category,
				descriptor: cur.descriptor
			};
		} catch {
			return null;
		}
	}
	const agentChat = new AgentChatStore({
		driver: new AgentDriver(builder, resolveEntry),
		getFlowId: () => idParam,
		getChallengeId: () => challengeParam,
	});

	async function loadPalette() {
		paletteLoading = true;
		paletteError = null;
		try {
			const res = await blocksApi.list({ sort: 'usage' });
			paletteItems = res.items;
			// ⛔ THE CANVAS NODE TITLES COME FROM THIS RESPONSE TOO, AND THIS LINE IS WHERE THEY GET IT.
			// `blocksApi.list` is locale-resolved SERVER-side off `Accept-Language` and is re-fetched by
			// `reloadOnLocaleChange` below — so it is the only source in this file that is CURRENT in the
			// reader's language. `nodeDisplayName` reads the published catalog, which is what makes a
			// language switch re-title every node already on the canvas without reloading the flow (and
			// therefore without discarding unsaved edits — see `reloadLocalizedContent`).
			//
			// ⚠️ INSIDE THE `try`, AFTER THE AWAIT, DELIBERATELY. A failed listing must NOT publish: the
			// `catch` sets `paletteItems = []` for the error pill, and publishing that empty array would
			// drop every node on the canvas back to its persisted (possibly English) label because one
			// request 500'd. `publishBlockCatalog` replaces rather than merges, so the last good catalog
			// standing is the right outcome for a failure. See its own doc comment.
			publishBlockCatalog(res.items);
		} catch (e) {
			// ⛔ SWALLOWED ON PURPOSE, AND ONLY BECAUSE IT IS RENDERED. This used to reject into
			// `onMount`'s catch, which aborts the rest of the boot — so a library outage also stopped
			// the flow from opening. Now the builder still boots and the palette alone reports itself.
			paletteItems = [];
			paletteError = errorText(e, m.palette_load_error());
		} finally {
			paletteLoading = false;
		}
	}
	async function loadFlowsList() {
		const res = await flowsApi.list();
		flowsList = res.items;
	}

	function snapshot(): string {
		return JSON.stringify({ name: builder.flow?.name ?? '', graph: builder.serialize() });
	}

	async function openFlow(id: string) {
		const seq = ++loadSeq;
		// Tear down any in-flight run when switching flows.
		stream?.close();
		stream = null;
		running = false;
		runTrace.clear();
		// Tear down any in-flight AI turn too: it was issued against the OLD graph, and
		// letting it keep streaming would land its (possibly still-queued) tool-calls on
		// the flow we're about to load here — a silent cross-flow write. stop() truly
		// aborts the request (frees the metered quota slot) rather than just going quiet
		// client-side. The store also refuses any frontend-tool-call whose flow no longer
		// matches (see AgentChatStore.turnFlowId) as a backstop for the race where an
		// event was already mid-flight when this runs.
		agentChat.stop();
		// A previous failure describes a load that is over. `bootError` had no writer that cleared
		// it, so one blip pinned a coral pill over the canvas for the rest of the session — including
		// after the reader switched back to a flow that loads perfectly — at which point it has
		// stopped being a signal and become furniture.
		bootError = null;
		// A previous load's unresolved blocks describe a load that is over, for the same reason
		// `bootError` above is cleared here: the pill must not outlive the flow it is about.
		unresolvedSlugs = [];
		try {
			const flow = await flowsApi.get(id);
			// Resolve descriptors for every block referenced by the graph.
			//
			// ⛔ `isBlockKind` — NOT every node. A foreach container carries the literal slug
			// 'foreach' and no `building_blocks` row, so it used to be prefetched like any other
			// node and answer `GET /api/blocks/foreach → 404`, once per loop per flow load, for
			// every user. The `.catch(() => null)` below meant the only place it was ever visible
			// was the network tab. Its descriptor does not come from the wire at all —
			// `flowToCanvasNodes` gives it `FOREACH_NODE_DESCRIPTOR` — so there was never anything
			// to fetch. `submitSolution` has filtered the same nodes out of `nodeSlugs` all along;
			// this line is the sibling that was missed, and both now share the one predicate.
			const slugs = [
				...new Set(flow.graph.nodes.filter((n) => isBlockKind(n.kind)).map((n) => n.slug))
			];
			// ⛔ THE `.catch` STAYS — DO NOT "FIX" THIS BY LETTING THE REJECTION THROUGH. One archived
			// block would then abort the entire load and hit the outer catch below, which deliberately
			// tears the builder down to prevent a cross-flow write. What was missing is not the
			// failure handling, it is the RECORD: the failed slugs are now collected so the canvas can
			// admit that those nodes' ports are unknown instead of drawing them empty.
			const failed: string[] = [];
			await Promise.all(
				slugs.map((s) =>
					ensureBlock(s).catch(() => {
						failed.push(s);
						return null;
					})
				)
			);
			if (seq !== loadSeq) return; // a newer load superseded us
			builder.load(flow, resolveDescriptor);
			unresolvedSlugs = failed;
			lastSavedAt = flow.last_saved_at;
			lastSavedJson = snapshot();
			resetHistory();
			builder.hydrated = true;
			if (fitAfterLoad) {
				fitAfterLoad = false;
				fitNonce++;
			}
		} catch (e) {
			if (seq !== loadSeq) return; // a newer load superseded us — its outcome is the one to show
			// ⛔ TEAR THE BUILDER DOWN, DO NOT JUST PAINT A PILL. This used to be the `bootError` line
			// alone, and that is a silent cross-flow WRITE, not a cosmetic problem. The URL has
			// already moved by the time we get here — `selectFlow` only calls `goto()` and the fetch
			// is the `?id=` effect REACTING to it — so `builder` still holds the PREVIOUS flow while
			// the picker reads the new one. `hydrated` and `flow` are exactly what the autosave
			// effect gates on, and `doSave` writes `flowsApi.save(builder.flow.id, …)`: the reader's
			// first edit, made believing they are in the flow the picker names, lands in the old one
			// 800 ms later and overwrites it. `hydrated = false` alone stops the write; the rest stops
			// the topbar vouching for a flow that is not loaded (title, node count, Submit) — the
			// same reasoning already applied to the in-flight AI turn above.
			builder.hydrated = false;
			builder.flow = null;
			builder.nodes = [];
			builder.edges = [];
			// ⛔ AND THE READ-ONLY FLAG, FOR THE SAME REASON THE THREE ABOVE ARE CLEARED. It is set
			// from the PREVIOUS flow's `readOnly`, and a failed load leaves it describing a flow that
			// is no longer on screen: switch from a stranger's published flow to your own and the
			// load fails, and your next visit to a flow that DOES load would open with a stale amber
			// banner and a dead palette. `load()` sets it on every success, so this is the only path
			// that can leave it stranded.
			builder.readOnly = false;
			resetHistory();
			bootError = errorText(e, m.error_load_failed());
		}
	}

	/**
	 * Re-fetch the descriptors that failed on load and patch them onto the nodes already on screen.
	 *
	 * ⛔ PATCH, NEVER RE-`load`. The obvious repair — call `openFlow(idParam)` again — refetches the
	 * PERSISTED flow and overwrites the canvas, discarding every edit made since the load. The whole
	 * point of the notice is that the reader's graph is intact; a retry that throws their work away
	 * to redraw two ports is a worse outcome than the missing ports.
	 *
	 * `loadSeq` is captured for the same reason `openFlow` reads it: the reader can switch flows
	 * while these requests are in flight, and writing a descriptor into a graph that has since been
	 * replaced is the cross-flow write this file guards everywhere else.
	 */
	async function retryUnresolved() {
		const seq = loadSeq;
		const pending = [...unresolvedSlugs];
		const stillFailing: string[] = [];
		await Promise.all(
			pending.map(async (slug) => {
				try {
					await ensureBlock(slug);
					if (seq !== loadSeq) return;
					builder.resolveSlug(slug, resolveDescriptor);
				} catch {
					stillFailing.push(slug);
				}
			})
		);
		if (seq !== loadSeq) return; // a flow switch superseded this retry — its load owns the list
		unresolvedSlugs = pending.filter((s) => stillFailing.includes(s));
	}

	async function doSave() {
		// ⛔ THIS RE-CHECK IS LOAD-BEARING, NOT BELT-AND-BRACES — DO NOT "SIMPLIFY" IT AWAY BECAUSE
		// THE AUTOSAVE EFFECT ALREADY GATES ON THE SAME TWO. A debounce armed BEFORE a load failed is
		// never cancelled: the effect's early return sits ahead of its own `clearTimeout`, so the
		// timer set against the OLD flow still fires 800 ms later and arrives here. `openFlow`'s
		// teardown is what makes that arrival harmless, and this line is where it is enforced.
		// ⛔ AND `readOnly`, WHICH IS THE TERM THAT CANNOT HALF-APPLY. Every affordance below is a
		// courtesy — a disabled button, a non-draggable tile — and each of them can be worked around
		// (keyboard, the agent panel, a stale timer armed before the load resolved). This is the line
		// that decides whether a visitor's edit is PUT ON THE WIRE, where the only thing waiting for
		// it is `loadOwnedFlow`'s 404 and a "Opslaan mislukt" pill that never clears.
		// `locked`, not only `readOnly`: below 1024px nothing saves either (see `BuilderStore.viewOnly`).
		if (!builder.flow || !builder.hydrated || builder.locked) return;
		const snap = snapshot();
		if (snap === lastSavedJson) return; // nothing changed
		saving = true;
		saveError = null;
		try {
			const updated = await flowsApi.save(builder.flow.id, {
				name: builder.flow.name,
				graph: builder.serialize()
			});
			lastSavedJson = snap;
			lastSavedAt = updated.last_saved_at;
			builder.flow.last_saved_at = updated.last_saved_at;
			// keep the picker label in sync
			flowsList = flowsList.map((f) =>
				f.id === updated.id ? { ...f, name: updated.name, node_count: updated.graph.nodes.length } : f
			);
		} catch (e) {
			saveError = writeErrorText(e, m.error_save_failed());
		} finally {
			saving = false;
		}
	}

	// Autosave: serialize() reads nodes/edges; reading flow.name tracks renames.
	// SvelteFlow reassigns the arrays on every change, so this re-runs and debounces.
	$effect(() => {
		void builder.serialize();
		void builder.flow?.name;
		// Tracked so an edit still pending when the window went narrow is saved once it widens again.
		void builder.locked;
		if (!builder.hydrated || !builder.flow) return;
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(doSave, 800);
	});

	// Undo/redo recorder: when nodes/edges change to a NEW graph (reference differs from
	// the last committed snapshot), push the previous snapshot onto the undo stack. Debounced
	// so a multi-tick drag collapses into one history step. Undo/redo re-applies the SAME
	// references it stored, so the ref-equality check below makes this a no-op for them.
	$effect(() => {
		const n = builder.nodes;
		const e = builder.edges;
		if (!builder.hydrated) return;
		if (histTimer) clearTimeout(histTimer);
		histTimer = setTimeout(() => {
			if (lastGraph && lastGraph.nodes === n && lastGraph.edges === e) return;
			if (lastGraph) {
				undoStack = [...undoStack, lastGraph].slice(-50);
				redoStack = [];
			}
			lastGraph = { nodes: n, edges: e };
		}, 350);
	});

	// React to ?id= changes (picker / new-flow navigation).
	$effect(() => {
		const id = idParam;
		if (id) openFlow(id);
	});

	// Phase 3.1: when a challenge is being worked (?challenge=), load its applicable
	// datasets into the builder context + auto-open the data panel. Clearing the param
	// (free-build) drops the context.
	$effect(() => {
		const cid = challengeParam;
		if (!cid) {
			builder.setChallengeContext(null);
			challengeClosed = false;
			return;
		}
		void loadChallengeContext(cid, { openPanel: true, onFailureClearContext: true });
	});

	/**
	 * Fetch the challenge behind `?challenge=` into the builder context.
	 *
	 * ⚠️ Two callers with two different failure appetites, hence the flags rather than two copies:
	 * the `$effect` above is the LOAD (a failure means we have no context, so drop it), and
	 * `reloadLocalizedContent` below is a cosmetic re-fetch of copy already on screen (a failure
	 * must change nothing — see its own comment). `openPanel` is the same split: opening the data
	 * drawer is right when the challenge ARRIVES and wrong when the reader merely switched language
	 * after having closed it.
	 */
	let challengeCtxSeq = 0;
	async function loadChallengeContext(
		cid: string,
		opts: { openPanel: boolean; onFailureClearContext: boolean }
	) {
		// A ticket, because two quick switches can land out of order and leave the panel showing the
		// language (or the challenge) the reader moved away from.
		const ticket = ++challengeCtxSeq;
		try {
			const c = await challengesApi.get(cid);
			if (ticket !== challengeCtxSeq) return;
			builder.setChallengeContext({
				id: c.id,
				title: c.title,
				datasets: c.datasets,
				involves: c.involves,
				canEditDatasets: c.canEditDatasets === true
			});
			// `=== true`, not `!!`: an older server that omits the field leaves it UNKNOWN, and
			// unknown is not closed. Same reading as `$lib/challenges/challenge-state.ts`.
			challengeClosed = c.cycleClosed === true;
			if (opts.openPanel) openDataTab();
		} catch {
			if (ticket !== challengeCtxSeq || !opts.onFailureClearContext) return;
			builder.setChallengeContext(null);
			// ⚠️ DELIBERATE ASYMMETRY WITH `$lib/solutions/solution-state.ts`, AND IT IS NOT AN
			// OVERSIGHT — DO NOT "FIX" IT TO MATCH.
			//
			// That module argues unknown ⇒ BLOCKED, and is right to: a wrongly-live vote pill costs
			// the reader one click that answers with a red banner. Here the currency is different.
			// A wrongly-DISABLED Submit costs a COMPLETED BUILD — the author has already spent the
			// whole session, and the control that would publish it is dead with no way to force it.
			// Weigh that against what leaving it enabled actually risks: `POST /api/solutions` now
			// refuses a dead challenge itself, totally, and its 422 names the finished cycle and
			// points at the current one. The worst case of staying open is one honest refusal at
			// the end; the worst case of closing is a build that can never be filed at all.
			//
			// The guard we are relaxing here is a SECOND line of defence, not the only one. It
			// exists to stop the OFFER, and it only reaches this branch when we could not even ask.
			challengeClosed = false;
		}
	}

	/**
	 * ⛔ RE-FETCH THE LOCALE-DEPENDENT READ-ONLY CONTENT ON A LANGUAGE SWITCH — AND NOTHING ELSE.
	 *
	 * What was broken: `/build` had no `reloadOnLocaleChange` at all. Two of its loads are localized
	 * SERVER-side off `Accept-Language` (`authFetch` fills it from the live locale rune):
	 * `blocksApi.list()` in `loadPalette()` — EVERY palette tile name (BlockPalette.svelte:197) —
	 * and `challengesApi.get()` — the challenge title (ChallengeDataPanel.svelte:139). Both are
	 * fetched exactly once, from `onMount` and from a `$effect` that tracks `challengeParam`, so
	 * switching language relocalized every `m.*()` label around the canvas and left the entire block
	 * palette plus the challenge context in the language the builder was opened in. PR #318 fixed
	 * the same defect on `/blocks` and `/block-edit`; this was the last screen holding it.
	 *
	 * ⚠️ WHY THE `$effect`s DO NOT ALREADY COVER IT — the obvious "surely this works" objection.
	 * `authFetch` reads `getLocale()` only AFTER `await ensureFreshToken(30)` (auth-fetch.ts:57-64),
	 * a later microtask, outside any effect's synchronous tracking window. No effect on this page
	 * ever took a dependency on the locale rune. The locale is on the wire; it was never a trigger.
	 *
	 * ⛔ AND THIS IS A NARROW FUNCTION, NOT A PAGE RELOAD, BECAUSE /build HOLDS AN EDITOR.
	 * `openFlow()` calls `builder.load()`, which REPLACES `nodes`/`edges` with the server's copy —
	 * re-running it on a language switch would silently discard every unsaved edit on the canvas,
	 * turning a cosmetic refresh into data loss. Same reasoning that made `/block-edit` write a
	 * bespoke `relocalizeDetail` instead of `reloadOnLocaleChange(load)` (see its comment). So this
	 * touches ONLY the two read-only, server-localized things, and NEVER the flow graph, the run
	 * trace, the chat, the flows list, or anything the builder has typed:
	 *   - `loadPalette()` — pure display data, owns its own error state, no editable buffer.
	 *   - the challenge context — a read-only title/dataset list, re-fetched WITHOUT re-opening the
	 *     data panel (the reader may have closed it) and swallowing failures (the copy already on
	 *     screen is better than blanking the context because a cosmetic refresh 500'd).
	 *
	 * ⛔ `() => void untrack(...)`, NOT a bare `reloadOnLocaleChange(reloadLocalizedContent)`.
	 * The helper runs the callback synchronously inside its own `$effect`, and Svelte re-collects an
	 * effect's dependencies on every run — so a bare call would subscribe that effect to everything
	 * this function reads (`challengeParam` → `page.url`, `paletteLoading`, `paletteItems`), giving
	 * the locale effect a second, unrelated trigger and a duplicate fetch per URL change. That is
	 * the measured duplicate-mount defect `/blocks` documents at its own call site
	 * (blocks/+page.svelte:100-107), arriving by a new door. The locale rune is the only trigger
	 * this may ever have.
	 */
	function reloadLocalizedContent() {
		void loadPalette();
		const cid = challengeParam;
		if (cid) void loadChallengeContext(cid, { openPanel: false, onFailureClearContext: false });
	}
	reloadOnLocaleChange(() => void untrack(reloadLocalizedContent));

	onMount(() => {
		const tick = setInterval(() => (now = Date.now()), 1000);
		(async () => {
			// ⛔ THE BOOT SEQUENCE IS THREE LOADS AND AT MOST ONE CREATE, AND ITS ONE `catch` USED TO
			// CALL ALL OF THEM "create failed". `error_create_failed` — "We konden dat niet aanmaken"
			// — is the sentence a reader got when `GET /api/blocks` or `GET /api/flows` 503'd, which
			// is the overwhelmingly common failure here: the create arm only runs for a brand-new
			// workspace with zero flows AND no `?id=`. A builder whose LIBRARY did not load was told
			// something could not be CREATED, and went looking for a name collision.
			//
			// ⚠️ ONE `catch`, NOT A WORD SWAP. Swapping the fallback to `error_load_failed` outright
			// builds the mirror-image defect: a genuinely failed `POST /api/flows` would then report
			// "We couldn't load that" — and `flowsApi.create` failing is exactly the case
			// `build-page.palette-load-failure.render.test.ts`'s over-correction guard names as
			// legitimately covered by the create copy. The stage the sequence is IN is the fact both
			// sentences depend on, so it is the thing that gets recorded.
			let bootStage: 'load' | 'create' = 'load';
			try {
				await Promise.all([loadPalette(), loadFlowsList()]);
				if (!idParam) {
					let target = flowsList[0]?.id;
					if (!target) {
						bootStage = 'create';
						const created = await flowsApi.create({ name: m.build_new_flow_default_name() });
						// Back to `load` the moment the create is behind us: the `loadFlowsList()` on the
						// next line is a LOAD, and a failure there is not a failed create.
						bootStage = 'load';
						await loadFlowsList();
						target = created.id;
					}
					// `builderBootUrl` carries `?challenge=` across — see its doc comment for why that
					// is the whole difference between an enterable and an unenterable build loop.
					goto(builderBootUrl(page.url, target), { replaceState: true });
				}
			} catch (e) {
				bootError = writeErrorText(
					e,
					bootStage === 'create' ? m.error_create_failed() : m.error_load_failed()
				);
			}
		})();
		return () => {
			clearInterval(tick);
			stream?.close();
			agentChat.stop();
		};
	});

	/**
	 * ⛔ THE LOOKUP CAN FAIL, AND IT USED TO FAIL INTO NOTHING. `ensureBlock` caches only what IT
	 * fetched, and `paletteItems` comes from `blocksApi.list` (summaries) — it never populates
	 * `blockCache`. So the FIRST interaction with any tile is a live `GET /api/blocks/:slug`, and
	 * that request can 5xx, drop, or 404 because the block was archived between the listing and the
	 * drag.
	 *
	 * ⛔ AND THE DRAG IS THE WORSE HALF, WHICH IS WHY THE HANDLING LIVES HERE. `FlowCanvas.ondrop`
	 * calls this without awaiting it, so a rejection had no `.catch()` anywhere: no node, no message,
	 * an unhandled promise rejection in the console and a builder who thinks the drag missed. The
	 * click path (`onAddBlock`) reached a `console.warn` nobody reads. Both entry points funnel
	 * through here, so this is the one place that covers both.
	 */
	async function onDropBlock(slug: string, position: { x: number; y: number } | null) {
		let detail: BlockDetail;
		try {
			detail = await ensureBlock(slug);
		} catch (e) {
			// ⚠️ The slug is wrapped in a Unicode bidi isolate before interpolation. Block slugs are
			// unconstrained text on the wire, so a mixed-direction one would otherwise reorder inside
			// an ar/he sentence. `bidiIsolate` is `graph-issue-label`'s own `iso`, exported rather
			// than copied — its doc comment carries the measurement behind those two characters.
			addBlockError = m.build_add_block_error({
				slug: bidiIsolate(slug),
				error: errorText(e, m.error_load_failed())
			});
			return;
		}
		const cur = currentVersion(detail);
		if (!cur) return;
		// The add is going through: a previous failure describes an attempt that is over.
		addBlockError = null;
		const entry: BlockEntry = {
			blockId: detail.id,
			blockVersionId: cur.id,
			slug: detail.slug,
			name: detail.name,
			category: detail.category,
			descriptor: cur.descriptor
		};
		// No drop point (a palette click): place it NOW, against the graph as it is after the await —
		// a position computed at click time is stale if another add landed while this one fetched.
		builder.addNode(entry, position ?? cascadePosition(builder.nodes));
	}

	// Phase 5: drop a bounded-loop container (no block lookup — it runs no block).
	function onDropForeach(position: { x: number; y: number }) {
		builder.addForeach(position);
	}

	// The palette's OTHER way in: clicking or keyboard-activating a tile (see the `activate` comment
	// in BlockPalette). Both funnel into the drop handlers above rather than into a second copy of
	// the add logic — the only thing an activation lacks is a drop point, and `cascadePosition` is
	// the same rule the agent's `add_node` already uses when it has no coordinates either.
	function onAddBlock(slug: string) {
		// `onDropBlock` now renders its own failure (see its doc comment), so there is nothing left
		// for this entry point to swallow — the `console.warn` it used to end in was the reason a
		// failed tile click looked like a dead control.
		void onDropBlock(slug, null);
	}
	function onAddForeach() {
		onDropForeach(cascadePosition(builder.nodes));
	}

	// Merge the live per-node run status into the canvas nodes so BlockNode shows
	// running/ok/error badges. Reassigns the array (SvelteFlow re-renders); the
	// graph shape is unchanged so this never triggers an autosave.
	function applyNodeStatuses() {
		builder.nodes = builder.nodes.map((n) => ({
			...n,
			data: { ...n.data, runtimeStatus: runTrace.byNode[n.id]?.status }
		}));
	}
	function clearNodeStatuses() {
		runTrace.reset(null);
		applyNodeStatuses();
	}

	// W8/P4: "Test with this challenge's sample data" — the panel's result area. Owned here because
	// the run itself is this page's (`testRun`); the panel only renders it.
	let sampleTest = $state<SampleTestView | null>(null);

	async function sampleTestRun() {
		if (!builder.challengeContext) return;
		await testRun({ sampleChallengeId: builder.challengeContext.id });
	}

	/** Whether the caller's test environment is paused after being idle, so the run will start it first.
	 *  Only drives the button label; best effort, so a failed read just shows the plain "Running". */
	async function testEnvironmentPaused(): Promise<boolean> {
		try {
			const sb = await runsApi.getMySandbox();
			return sb?.status === 'suspended' && sb.suspensionReason === 'idle';
		} catch {
			return false;
		}
	}

	async function testRun(opts?: { sampleChallengeId?: string }) {
		// `readOnly`: this opens with `await doSave()` — it runs the PERSISTED graph — and a visitor
		// cannot persist. Without the term the run would either execute the AUTHOR's last-saved graph
		// while showing the visitor's edited canvas, or start a metered sandbox on someone else's
		// flow. Both are worse than a disabled button beside a banner that says why.
		// ⚠️ `readOnly`, NOT `locked`, DELIBERATELY: at narrow width the run stays available. It runs
		// the SAVED graph (`doSave` below is refused while locked, and nothing can be edited while
		// locked, so there is nothing unsaved) and writes nothing to the flow — the run-status badges
		// it paints are `runtimeStatus`, which `canvasToFlowGraph` never serializes.
		if (running || !builder.flow || builder.nodes.length === 0 || builder.readOnly) return;
		running = true;
		runError = null;
		runIssues = [];
		dataFindings = [];
		dataFindingsDismissed = false;
		const sampleChallengeId = opts?.sampleChallengeId;
		sampleTest = sampleChallengeId ? { state: 'running' } : null;
		try {
			await doSave(); // run the persisted graph
			startingEnv = await testEnvironmentPaused();
			const res = sampleChallengeId
				? await runsApi.start(builder.flow.id, { sampleChallengeId })
				: await runsApi.start(builder.flow.id);
			startingEnv = false;
			if (sampleChallengeId) {
				const binding = sampleBindingFrom(res);
				// Show the binding the server used on the canvas too, so the member sees which step reads
				// the sample data (and the next plain run reads it as well). Only when the server BOUND it;
				// an input already reading the data, or a derived data block, is left exactly as it is.
				if (binding?.source === 'challenge') builder.updateConfig(binding.nodeId, binding.input, binding.slug);
				sampleTest = { state: 'done', binding, findings: dataValidationFrom(res)?.findings ?? [], runId: res.runId };
			}
			const { runId } = res;
			// ⛔ BEFORE `runTrace.reset(runId)`, and on the SUCCESS path. This is the whole defect:
			// `data.validation_mode` ships as `warn`, so a run whose test data breaks the contract
			// gets a 201 and streams green while (for `pii_uncovered`) the values go into the
			// sandbox UNREDACTED. The findings have to land while the run proceeds, not instead of
			// it. `dataValidationFrom` re-guards the body structurally — `unwrap()` casts, it does
			// not validate.
			const report = dataValidationFrom(res);
			if (report) {
				dataFindings = report.findings;
				dataFindingsMode = report.mode;
			}
			runTrace.reset(runId);
			applyNodeStatuses();
			if (!consoleAutoOpened) {
				consoleAutoOpened = true;
				consoleOpen = true;
			}
			stream?.close();
			stream = streamRun(runId, {
				onEvent: (ev) => {
					runTrace.ingest(ev);
					applyNodeStatuses();
					if (ev.type === 'run_complete') running = false;
				},
				onError: (e) => {
					runError = writeErrorText(e, m.error_action_failed());
					running = false;
				},
				onEnd: () => {
					running = false;
				}
			});
		} catch (e) {
			startingEnv = false;
			// W8/P4: "nothing to test with" / "nowhere to put it" are answers for the sample area, not run
			// failures — rendered there in plain words, with the way forward.
			const err = e as { code?: unknown; details?: Record<string, unknown> };
			const refusal =
				sampleChallengeId && typeof err?.code === 'string' ? sampleRefusalView(err.code, err.details) : null;
			if (refusal) {
				sampleTest = refusal;
				running = false;
				return;
			}
			if (sampleChallengeId) sampleTest = null;
			runError = writeErrorText(e, m.error_action_failed());
			// The SSE `onError` path above deliberately does NOT do this: the stream only opens after
			// `runsApi.start` returned 200, so it can never carry graph-validation issues.
			runIssues = runErrorIssues(e);
			// A refusal is only ever the `block` policy — `warn` never throws. Rendered inside the
			// error pill, because here the findings ARE the reason the run did not happen.
			dataFindings = runErrorDataFindings(e);
			dataFindingsMode = 'block';
			running = false;
		}
	}

	/**
	 * The canvas label for an issue's `ref`, so "missing required input" points at the node the
	 * author can actually see. Returns null when the ref names an edge (edge ids are not on
	 * `builder.nodes`) or is absent — the issue message still renders on its own.
	 *
	 * ⛔ THE CATALOG STRING FOR A LOOP, THE STORED LABEL FOR EVERYTHING ELSE — the FOURTH render
	 * site of the same field, after `ForeachNode.svelte` and the two in `NodeConfigPanel.svelte`.
	 * `newForeachNode` (stores/builder-graph.ts) stamps `label: 'For each row'` and
	 * `canvasToFlowGraph()` PERSISTS it into `flows.graph`, so the English is the wire/machine half
	 * and must stay there byte-for-byte — localizing at creation time would freeze the creator's
	 * locale into the saved flow for ever. Which is why every one of these fixes is at RENDER time.
	 * Left raw, a refused graph named the loop "For each row" in an issue line sitting inches from
	 * the canvas node that already called it "Lus (voor elke rij)".
	 *
	 * ⚠️ AND THE `kind === 'foreach'` GUARD IS LOAD-BEARING, exactly as it is at `.cfg-sub`: this
	 * resolves the name for EVERY node kind, and a block's `data.label` is that block's real
	 * author-facing name with no catalog entry. Returning the catalog string unconditionally would
	 * rename every block in every refusal. Both directions are pinned by
	 * `build-page.foreach-issue-label.i18n.render.test.ts`.
	 *
	 * ⚠️ THAT GUARD IS NOW RUNG 1 OF `nodeDisplayName` AND IS NOT SPELLED OUT HERE ANY MORE. Same
	 * output for both kinds; what the shared helper adds is the rung ABOVE `data.label` — the block's
	 * name as the CURRENT catalog spells it — so a refusal about a node whose saved label is in
	 * someone else's language names it in the reader's. `$lib/i18n/block-node-label` owns the order;
	 * this stays a lookup that answers `null` for an edge ref or an id that is not on the canvas.
	 */
	function issueNodeLabel(ref: string | undefined): string | null {
		if (!ref) return null;
		const node = builder.nodes.find((n) => n.id === ref);
		if (!node) return null;
		return nodeDisplayName(node.data);
	}

	// EVERY navigation that rewrites this page's URL must go through `builderBootUrl`, not just the
	// boot redirect. These two used to rebuild the URL from `id` alone, which dropped `?challenge=`
	// exactly like the boot redirect did — and the consequence here is worse than the original bug:
	// arriving from a challenge and then clicking "New flow" (the natural move, since boot lands you
	// on an arbitrary pre-existing flow) left the page with no challenge in context, so Submit went
	// permanently disabled with no way back except editing the address bar by hand.
	async function newFlow() {
		const created = await flowsApi.create({ name: m.build_new_flow_default_name() });
		await loadFlowsList();
		goto(builderBootUrl(page.url, created.id));
	}
	/**
	 * A template (or a solution's flow) became a draft: open it and frame it. When the template was
	 * written INTO the empty draft on screen (`intoFlowId` below) the id is unchanged, so the URL does
	 * not change and nothing would reload it — re-open it here instead.
	 */
	async function openUsedTemplate(result: UseFlowTemplateResult) {
		galleryOpen = false;
		fitAfterLoad = true;
		await loadFlowsList();
		if (result.flowId === idParam) await openFlow(result.flowId);
		else goto(builderBootUrl(page.url, result.flowId));
	}
	/** Save first, so the template is the graph on screen rather than the last autosave. */
	async function openSaveTemplate() {
		await doSave();
		saveTemplateOpen = true;
	}
	function selectFlow(id: string) {
		if (id !== idParam) goto(builderBootUrl(page.url, id));
	}
	function rename(name: string) {
		if (builder.flow && !builder.locked) builder.flow.name = name;
	}
	/**
	 * Submit the current flow as a solution to the challenge in context.
	 *
	 * This used to `PATCH /api/flows/:id { status: 'submitted' }` and stop there. Nothing in the
	 * product reads `flows.status = 'submitted'` — no leaderboard, no vote, no weekly close — so the
	 * button relabelled itself "Submitted ✓" and the marketplace stayed empty: eight consecutive
	 * cycles closed with no winner because no user-submitted solution had ever been created.
	 * `POST /api/solutions` is the real entry point, and it flips the flow to `submitted` itself, in
	 * the same transaction as the insert — which is also why the PATCH is gone rather than kept:
	 * doing it client-side first marked the flow submitted even when the POST went on to 422.
	 */
	async function submitSolution() {
		// `readOnly`: `POST /api/solutions` would publish ANOTHER AUTHOR's flow under this reader's
		// name, and `solutionsApi.create` flips `flows.status` on a row they do not own.
		if (!builder.flow || !challengeParam || submitting || builder.locked) return;
		submitting = true;
		submitError = null;
		submitIssues = [];
		saveError = null;
		try {
			// The route publishes the PERSISTED graph, so flush the canvas first — and refuse to
			// submit a graph we know did not reach the server, rather than publishing a stale one.
			await doSave();
			if (saveError) {
				submitError = saveError;
				return;
			}
			const created = await solutionsApi.create(
				solutionSubmissionPayload({
					challengeId: challengeParam!,
					title: builder.flow.name,
					flowId: builder.flow.id,
					// Library blocks only. A `foreach` loop container carries the literal slug
					// 'foreach' (builder-graph.ts), which is control flow, not a block anyone
					// published — and `blocks_used` is rendered as the solution's block chain on
					// the detail page and the leaderboard. Shares `isBlockKind` with the load-time
					// prefetch in `openFlow`: this condition used to be spelled out here and
					// nowhere else, which is exactly how the prefetch drifted into 404ing.
					nodeSlugs: builder.nodes.filter((n) => isBlockKind(n.data.kind)).map((n) => n.data.slug)
				})
			);
			// The response is the solution row, not the flow — the flow's new status is the route's
			// own transactional write (routes/solutions.ts), mirrored here so the topbar is not stale
			// for the tick before we navigate.
			builder.flow.status = 'submitted';
			await goto(`/solutions/${created.id}`);
		} catch (e) {
			submitError = writeErrorText(e, m.error_submit_failed());
			submitIssues = solutionErrorIssues(e);
		} finally {
			submitting = false;
		}
	}

	const saveLabel = $derived.by(() => {
		// ⛔ FIRST, AHEAD OF EVERY OTHER ARM. Nothing is saving, nothing failed, and there is no
		// "saved 3s ago" to report — the breadcrumb must not imply a persistence story that is not
		// happening at all. Ahead of `saveError` too: a stale error from the flow BEFORE this one
		// would otherwise render "Opslaan mislukt" over a flow nobody ever tried to save.
		if (builder.readOnly) return m.build_save_readonly();
		if (saving) return m.build_save_saving();
		if (saveError) return m.build_save_failed();
		if (!lastSavedAt) return m.build_save_unsaved();
		// `now` ticks on a timer — reference it so this re-derives; timeAgo() centralizes the
		// coarse-relative formatting (rolls s → m → h → d, matching the rest of the app).
		const secs = Math.max(0, Math.round((now - new Date(lastSavedAt).getTime()) / 1000));
		if (secs < 3) return m.build_save_just_now();
		return m.build_save_ago({ ago: timeAgo(lastSavedAt) });
	});
	const nodeCount = $derived(builder.nodes.length);
	// The start cards over an empty canvas (FlowCanvas hides its drag hint while they show).
	const showStart = $derived(!!builder.flow && nodeCount === 0 && !builder.locked);
	// Phase 5: a loop with no body node does nothing — surface it as a non-blocking authoring warning.
	const emptyLoops = $derived(
		builder.nodes.filter(
			(n) => n.data.kind === 'foreach' && !builder.nodes.some((c) => c.data.parentId === n.id)
		).length
	);
</script>

<svelte:window onkeydown={onKeydown} bind:innerWidth={viewportWidth} />

<div class="build-page">
	<!-- The per-node issue list, shared by the run pill and the submit pill: `POST /api/runs` and
	     `POST /api/solutions` run the SAME graph validators and answer with the same `GraphIssue[]`,
	     so they get the same rendering and the same node-name resolution. -->
	{#snippet issueList(issues: GraphIssue[])}
		<ul class="run-issues">
			<!-- Keyed by index on purpose: one node can raise several issues with the SAME
			     rule and ref (e.g. two missing required inputs), so a rule+ref key would be
			     a duplicate and Svelte throws on those. The list is replaced wholesale on
			     every run, so there is no identity to preserve across updates anyway. -->
			{#each issues as issue, i (i)}
				{@const label = issueNodeLabel(issue.ref)}
				<li>
					<!-- ⛔ `graphIssueLabel`, NOT `issue.message`. The backend authors that sentence in
					     English and cannot know who is reading; this list is what a Dutch author sees
					     the moment /build refuses their flow. The node name in front of it is the
					     author's own canvas label — `<bdi>` rather than `<span>` so a Hebrew or
					     Arabic label does not drag the latin sentence after it into the wrong order
					     (the identifiers INSIDE the sentence are isolated by `graphIssueLabel`). -->
					{#if label}<bdi class="run-issue-node">{label}</bdi>{/if}{graphIssueLabel(issue)}
				</li>
			{/each}
		</ul>
	{/snippet}
	<!-- The data-contract findings, shared by the refusal pill and the warn pill: the SAME
	     `DataValidationFinding[]` reaches both, only the policy that produced them differs. -->
	{#snippet findingList(findings: DataValidationFinding[])}
		<!-- ⛔ `findings-list` CAPS THIS LIST AND GIVES IT ITS OWN SCROLLBAR. The count is bounded
		     by nothing: the validator emits up to two findings PER MAPPED COLUMN, and the audit
		     cap (AUDIT_FINDING_REF_CAP, run-controller.ts) exists precisely because a 500-column
		     dataset is a real shape. This is the surface that RENDERS them, and it lives inside
		     `.build-page { overflow: hidden }` — an uncapped list simply grows past the clip and
		     takes everything below it (including the pill's own Dismiss) out of reach. -->
		<ul class="run-issues findings-list" data-testid="data-findings-list">
			<!-- Keyed by index for the reason spelled out on `issueList` above, and here it is not
			     hypothetical: ONE column can raise BOTH rules at once (a PII attribute on an
			     unflagged column whose values also mistype), so `rule + ref` collides on the very
			     first realistic case and Svelte throws `each_key_duplicate`. -->
			{#each findings as f, i (i)}
				<li>
					<span class="finding-ref">{dataFindingRef(f)}</span>{dataFindingLabel(f)}
				</li>
			{/each}
		</ul>
	{/snippet}
	<!-- One stack, so a submit failure that follows a failed test run does not land on top of it. -->
	<div class="pill-stack">
		<!-- ⛔ AMBER AND `role="status"`, NOT CORAL AND NOT `alert`: nothing failed and nothing is
		     broken. The flow loaded completely and is rendered exactly as its author saved it; the
		     only news is who owns it. Coral here would train the reader to ignore a pill that is
		     usually a lie — the same argument `descriptor-unavailable` above makes.
		     FIRST IN THE STACK because it is the fact that explains every disabled control below it. -->
		{#if builder.readOnly}
			<div class="readonly-notice" role="status" data-testid="readonly-notice">
				{m.build_readonly_notice()}
			</div>
		{/if}
		{#if bootError}
			<div class="boot-error">{m.build_boot_error({ error: bootError })}</div>
		{/if}
		<!-- One tile that would not resolve. In the same stack as the boot and run pills so a second
		     failure lands beside the first instead of on top of it. -->
		{#if addBlockError}
			<div class="boot-error" role="alert" data-testid="add-block-error">{addBlockError}</div>
		{/if}
		<!-- ⛔ AMBER, NOT CORAL, AND THAT IS THE HONEST TONE. The flow DID load: the graph, the edges
		     and every other node are exactly as saved. What failed is the descriptor lookup for the
		     slugs named here, so those nodes render with unknown ports and `@xyflow/svelte` stops
		     DRAWING the edges attached to them (it does not delete them — see `resolveDescriptor`).
		     Coral would say the load failed and train the reader to ignore a pill that is usually a
		     lie; this says the one true thing, names the blocks, and offers the only repair.
		     The retry reuses `error_load_retry` — the same key and the same affordance as the block
		     palette's own failure (BlockPalette.svelte:134), not a second word for one idea. -->
		{#if unresolvedSlugs.length}
			<div class="descriptor-warn" role="alert" data-testid="descriptor-unavailable">
				<span
					>{m.build_descriptors_unavailable({
						count: num(unresolvedSlugs.length, locale.current),
						slugs: unresolvedSlugs.map((s) => bidiIsolate(s)).join(', ')
					})}</span
				>
				<button type="button" class="findings-dismiss" onclick={retryUnresolved}>
					{m.error_load_retry()}
				</button>
			</div>
		{/if}
		{#if runError}
			<div class="boot-error">
				{m.build_run_error({ error: runError })}
				{#if runIssues.length}{@render issueList(runIssues)}{/if}
				{#if dataFindings.length && dataFindingsMode === 'block'}
					<div class="findings-title">{m.data_findings_title_block()}</div>
					{@render findingList(dataFindings)}
				{/if}
			</div>
		{/if}
		<!-- ⛔ THE WARN PILL. AMBER, NOT CORAL: the run is fine — it started, it is streaming, it
		     will go green. What is not fine is the data inside it. Using `.boot-error`'s coral would
		     say the run failed, which is a lie, and the tester would learn to ignore it.
		     ⛔ IT MUST NOT CLEAR ON `run_complete`. A run that finished green while its PII went
		     into the sandbox unredacted is EXACTLY the state that has to stay on screen; the only
		     things that remove it are the next run and the reader dismissing it. -->
		{#if dataFindings.length && dataFindingsMode === 'warn' && !dataFindingsDismissed}
			<div class="data-warn" data-testid="data-findings-warn">
				<!-- ⛔ DISMISS SITS IN THE HEADER, BEFORE THE LIST, AND THAT ORDER IS THE FIX.
				     It used to be the pill's LAST child, after a list with no `max-height` and no
				     `overflow`, inside `.pill-stack { position: absolute; top: 60px }` inside
				     `.build-page { height: calc(100vh - 56px); overflow: hidden }`. At ~16 findings
				     on a 900px viewport the button was already past the clip: permanently
				     unreachable, while the pill it was supposed to close covered the canvas.
				     Ahead of the list the button's position no longer depends on the finding count
				     at all — `findings-list` bounds the rest. -->
				<div class="findings-head">
					<div class="findings-title">{m.data_findings_title_warn()}</div>
					<button class="findings-dismiss" onclick={() => (dataFindingsDismissed = true)}>
						{m.common_dismiss()}
					</button>
				</div>
				{@render findingList(dataFindings)}
				<div class="findings-note">{m.data_findings_warn_policy_note()}</div>
			</div>
		{/if}
		{#if submitError}
			<div class="boot-error">
				{m.build_submit_error({ error: submitError })}
				{#if submitIssues.length}{@render issueList(submitIssues)}{/if}
			</div>
		{/if}
	</div>
	<SvelteFlowProvider>
		<div
			class="build-shell"
			class:wide
			class:narrow
			style:grid-template-columns="{paletteCol} minmax(0, 1fr) {sideCol}"
			style:grid-template-rows="52px minmax(0, 1fr) {consoleRow}"
		>
			<div class="area topbar-area">
				<BuildTopbar
					name={builder.flow?.name ?? '…'}
					status={builder.flow?.status ?? 'draft'}
					{nodeCount}
					{saveLabel}
					{saving}
					flows={flowsList}
					currentId={idParam}
					challengeId={challengeParam}
					{challengeClosed}
					flowLoaded={!!builder.flow}
					readOnly={builder.locked}
					runLocked={builder.readOnly}
					chatBusy={agentChat.busy}
					{submitting}
					{running}
					{startingEnv}
					{historyOpen}
					{canUndo}
					{canRedo}
					onRename={rename}
					onSelect={selectFlow}
					onNew={() => (newChoiceOpen = true)}
					onSubmit={submitSolution}
					onTestRun={testRun}
					onToggleHistory={() => (historyOpen = !historyOpen)}
					onUndo={undo}
					onRedo={redo}
					onSaveTemplate={auth.isDeveloper && !builder.readOnly ? openSaveTemplate : undefined}
				/>
			</div>

			<div class="area palette" class:rail={!(wide && paletteDocked)}>
				{#if !narrow}
					<button
						type="button"
						class="pane-toggle palette-toggle"
						aria-expanded={paletteVisible}
						aria-controls="build-palette"
						title={paletteVisible ? m.build_palette_hide() : m.build_palette_show()}
						aria-label={paletteVisible ? m.build_palette_hide() : m.build_palette_show()}
						onclick={togglePalette}
					>
						<span class="chev cp-dir-mirror" aria-hidden="true">{paletteVisible ? '‹' : '›'}</span>
					</button>
				{/if}
				<!-- Always mounted (search text and scroll survive a hide); the class decides whether it is
				     docked, a drawer over the canvas, or hidden. -->
				<div
					id="build-palette"
					class="palette-body"
					class:docked={wide && paletteDocked}
					class:drawer={!wide && !narrow && paletteDrawerOpen}
					class:hidden={!paletteVisible}
				>
					<BlockPalette
						items={paletteItems}
						loading={paletteLoading}
						error={paletteError}
						onRetry={loadPalette}
						readOnly={builder.locked}
						onAdd={(slug) => {
							onAddBlock(slug);
							if (!wide) paletteDrawerOpen = false;
						}}
						onAddForeach={() => {
							onAddForeach();
							if (!wide) paletteDrawerOpen = false;
						}}
					/>
				</div>
			</div>

			<div class="area canvas">
				<FlowCanvas {builder} {onDropBlock} {onDropForeach} {fitKey} hideEmptyHint={showStart} />
				{#if showStart}
					<div class="start" data-testid="build-start">
						<h2 class="start-title">{m.build_start_title()}</h2>
						<div class="start-options">
							{#if challengeParam}
								<button type="button" class="start-card" onclick={openDataTab}>
									<span class="start-name">{m.build_start_challenge()}</span>
									<span class="start-sub">{m.build_start_challenge_sub()}</span>
								</button>
							{:else}
								<a class="start-card" href="/challenges">
									<span class="start-name">{m.build_start_challenge()}</span>
									<span class="start-sub">{m.build_start_challenge_sub()}</span>
								</a>
							{/if}
							<button type="button" class="start-card" onclick={() => (galleryOpen = true)}>
								<span class="start-name">{m.build_start_template()}</span>
								<span class="start-sub">{m.build_start_template_sub()}</span>
							</button>
							<button type="button" class="start-card" onclick={startWithAssistant}>
								<span class="start-name">{m.build_start_assistant()}</span>
								<span class="start-sub">{m.build_start_assistant_sub()}</span>
							</button>
						</div>
					</div>
				{/if}
				{#if narrow}
					<div class="narrow-note" role="status" data-testid="narrow-note">{m.build_narrow_note()}</div>
				{/if}
				{#if emptyLoops > 0}
					<div class="loop-warn">{m.foreach_no_body_warn({ count: emptyLoops })}</div>
				{/if}
				<!-- ⛔ `intoFlowId`: /build opens a blank draft for a reader with no flows, so using a template
				     from that empty canvas used to leave two flows (the blank "Untitled flow" + the copy). The
				     server reuses the draft only while it is still empty and the reader's own. -->
				<FlowTemplateGallery
					open={galleryOpen}
					onClose={() => (galleryOpen = false)}
					onUsed={openUsedTemplate}
					intoFlowId={showStart ? (builder.flow?.id ?? null) : null}
				/>
				<NewFlowChoice
					open={newChoiceOpen}
					onClose={() => (newChoiceOpen = false)}
					onBlank={() => {
						newChoiceOpen = false;
						void newFlow();
					}}
					onTemplate={() => {
						newChoiceOpen = false;
						galleryOpen = true;
					}}
				/>
				<SaveFlowTemplateDialog
					open={saveTemplateOpen}
					flowId={builder.flow?.id ?? null}
					defaultName={builder.flow?.name ?? ''}
					onClose={() => (saveTemplateOpen = false)}
				/>
				<FlowHistoryPanel
					flowId={idParam}
					open={historyOpen}
					onClose={() => (historyOpen = false)}
					{onRestored}
					locked={builder.locked}
				/>
			</div>

			<div class="area console" class:open={consoleOpen}>
				<button
					type="button"
					class="console-bar"
					aria-expanded={consoleOpen}
					aria-controls="build-run-log"
					onclick={() => (consoleOpen = !consoleOpen)}
				>
					<span class="chev" aria-hidden="true">{consoleOpen ? '▾' : '▸'}</span>
					{m.build_result()}
					{#if running}<span class="console-live" aria-hidden="true"></span>{/if}
				</button>
				<div id="build-run-log" class="console-body" hidden={!consoleOpen}>
					<RunConsole events={runTrace.events} status={runTrace.status} {nodeCount} {stepName} {outputLabel} showCost={showSessionCost} {showInternalErrors} />
				</div>
			</div>

			<!-- ONE column, three tabs. All panels stay mounted (`hidden`), so the chat keeps its draft and
			     scroll position while the reader looks at a block's details. -->
			<div class="area side chat" class:rail={!sideOpen}>
				{#if sideOpen}
					<div class="side-tabs" role="tablist">
						<button
							type="button"
							role="tab"
							id="side-tab-details"
							aria-selected={sideTab === 'details'}
							aria-controls="side-panel-details"
							class:active={sideTab === 'details'}
							onclick={() => (sideTab = 'details')}
						>
							{m.build_tab_details()}
						</button>
						<button
							type="button"
							role="tab"
							id="side-tab-data"
							aria-selected={sideTab === 'data'}
							aria-controls="side-panel-data"
							class:active={sideTab === 'data'}
							onclick={() => (sideTab = 'data')}
						>
							{m.build_data_browse()}
						</button>
						<button
							type="button"
							role="tab"
							id="side-tab-assistant"
							aria-selected={sideTab === 'assistant'}
							aria-controls="side-panel-assistant"
							class:active={sideTab === 'assistant'}
							onclick={() => (sideTab = 'assistant')}
						>
							{m.chat_role_assistant()}
						</button>
						<button
							type="button"
							class="pane-toggle side-toggle"
							aria-expanded="true"
							title={m.build_side_hide()}
							aria-label={m.build_side_hide()}
							onclick={() => (sideOpenChoice = false)}
						>
							<span class="chev cp-dir-mirror" aria-hidden="true">›</span>
						</button>
					</div>
				{:else}
					<button
						type="button"
						class="pane-toggle side-toggle"
						aria-expanded="false"
						title={m.build_side_show()}
						aria-label={m.build_side_show()}
						onclick={() => (sideOpenChoice = true)}
					>
						<span class="chev cp-dir-mirror" aria-hidden="true">‹</span>
					</button>
				{/if}
				<div
					class="side-panel"
					id="side-panel-details"
					role="tabpanel"
					aria-labelledby="side-tab-details"
					hidden={!sideOpen || sideTab !== 'details'}
				>
					{#if detailsMounted}<NodeConfigPanel {builder} {canMapData} />{/if}
				</div>
				<div
					class="side-panel"
					id="side-panel-data"
					role="tabpanel"
					aria-labelledby="side-tab-data"
					hidden={!sideOpen || sideTab !== 'data'}
				>
					{#if dataMounted}
						<ChallengeDataPanel
							{builder}
							sample={sampleTest}
							sampleRun={{ runId: runTrace.runId, events: runTrace.events, active: running }}
							onSampleTest={sampleTestRun}
							{onAddBlock}
						/>
					{/if}
				</div>
				<div
					class="side-panel"
					id="side-panel-assistant"
					role="tabpanel"
					aria-labelledby="side-tab-assistant"
					hidden={!sideOpen || sideTab !== 'assistant'}
				>
					<!-- The copilot drives THIS store through the same mutators the gate closes, so an
					     enabled composer would spend a metered turn producing a canvas change that is
					     discarded on the next reload. -->
					<ChatPanel bind:this={chatPanel} chat={agentChat} readOnly={builder.locked} showCost={showSessionCost} />
				</div>
			</div>
		</div>
	</SvelteFlowProvider>

	<!-- The agent's synthetic cursor (cosmetic; the driver commits via the store). -->
	<SyntheticCursor />
</div>

<style>
	/* Break out of the .screens padding (app.css: 28px 32px) for a full-bleed canvas. */
	.build-page {
		margin: -28px -32px;
		height: calc(100vh - 56px);
		overflow: hidden;
		position: relative;
	}
	@media (max-width: 767.98px) {
		/* the .screens padding is 20px 16px at phone width (app.css); the full-bleed break-out follows it */
		.build-page { margin: -20px -16px; }
	}
	/* Columns and rows are set inline from the pane state (palette | canvas | side panel, and
	   topbar / canvas / console). `minmax(0, 1fr)` so a long flow name or a wide node can never
	   widen the canvas track past the viewport. */
	.build-shell {
		display: grid;
		height: 100%;
	}
	.area {
		min-height: 0;
		min-width: 0;
	}
	/* ⛔ NOT `.topbar`. That class is GLOBAL in app.css (the app shell's header: `display: flex`,
	   `height: 56px`, padding) and it landed on this wrapper too, making it a flex container. The
	   toolbar inside is `container-type: inline-size`, whose content width counts as ZERO, so as a
	   flex item it collapsed to its padding: every container query fired at 1920px, the picker was
	   moved into ⋯ and the title truncated to "Naaml…" beside a screen of empty bar. */
	.area.topbar-area {
		grid-column: 1 / -1;
		grid-row: 1;
	}
	.area.palette {
		grid-column: 1;
		grid-row: 2 / 4;
		position: relative;
		background: var(--c-white);
	}
	.area.palette.rail {
		border-inline-end: 1px solid var(--c-border);
	}
	.palette-body {
		height: 100%;
		display: flex;
		flex-direction: column;
	}
	.palette-body > :global(*) {
		flex: 1;
		min-height: 0;
	}
	.palette-body.hidden {
		display: none;
	}
	/* 1024–1439px: the palette opens OVER the canvas, from the rail's edge. */
	.palette-body.drawer {
		position: absolute;
		top: 0;
		bottom: 0;
		inset-inline-start: 100%;
		width: 260px;
		height: auto;
		z-index: 8;
		background: var(--c-white);
		border-inline-end: 1px solid var(--c-border);
		box-shadow: var(--sh-md);
	}
	.area.canvas {
		grid-column: 2;
		grid-row: 2;
		position: relative;
	}
	/* Empty canvas: centred, above the flow pane but letting drops through around the cards. */
	.start {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 16px;
		padding: 24px;
		pointer-events: none;
		z-index: 4;
	}
	.start-title {
		margin: 0;
		font-size: 16px;
		font-weight: 600;
		color: var(--c-midnight);
	}
	.start-options {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 200px));
		gap: 12px;
		pointer-events: auto;
	}
	@media (max-width: 1279.98px) {
		.start-options {
			grid-template-columns: minmax(0, 260px);
		}
	}
	.start-card {
		display: flex;
		flex-direction: column;
		gap: 4px;
		text-align: start;
		padding: 14px 16px;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		box-shadow: var(--sh);
		color: var(--c-ink);
		text-decoration: none;
		font: inherit;
		cursor: pointer;
	}
	.start-card:hover,
	.start-card:focus-visible {
		border-color: var(--c-teal);
	}
	.start-name {
		font-size: 13.5px;
		font-weight: 600;
	}
	.start-sub {
		font-size: 12px;
		color: var(--c-muted);
	}
	.area.console {
		grid-column: 2;
		grid-row: 3;
		display: flex;
		flex-direction: column;
		background: var(--c-midnight);
	}
	.console-bar {
		flex: none;
		height: 32px;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 14px;
		font-size: 12px;
		font-weight: 600;
		color: #cbd5e1;
		text-align: start;
		border-top: 1px solid #1e293b;
	}
	.console-bar:hover {
		color: #fff;
	}
	.console-live {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--c-amber);
	}
	.console-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.console-body[hidden] {
		display: none;
	}
	.console-body > :global(*) {
		flex: 1;
		min-height: 0;
	}
	.area.side {
		grid-column: 3;
		grid-row: 2 / 4;
		display: flex;
		flex-direction: column;
		background: var(--c-white);
		border-inline-start: 1px solid var(--c-border);
	}
	.side-tabs {
		flex: none;
		display: flex;
		align-items: stretch;
		gap: 2px;
		padding: 0 6px 0 10px;
		border-bottom: 1px solid var(--c-border);
	}
	.side-tabs [role='tab'] {
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-muted);
		padding: 10px 10px 9px;
		border-bottom: 2px solid transparent;
	}
	.side-tabs [role='tab'].active {
		color: var(--c-ink);
		border-bottom-color: var(--c-teal);
	}
	.side-panel {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.side-panel[hidden] {
		display: none;
	}
	.side-panel > :global(*) {
		flex: 1;
		min-height: 0;
	}
	/* The column draws its own edge; the panel's would double it. */
	.side-panel > :global(.chat) {
		border-inline-start: none;
	}
	/* The collapse handles: one per pane, at the pane's top edge; in a 32px rail it is the rail. */
	.pane-toggle {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: var(--r-sm);
		color: var(--c-muted);
		border: 1px solid transparent;
	}
	.pane-toggle:hover {
		color: var(--c-ink);
		background: var(--c-surface);
		border-color: var(--c-border);
	}
	.chev {
		font-size: 16px;
		line-height: 1;
	}
	.palette-toggle {
		position: absolute;
		top: 8px;
		inset-inline-end: 4px;
		z-index: 2;
	}
	.side-toggle {
		margin-inline-start: auto;
		align-self: center;
	}
	.area.rail .pane-toggle {
		position: static;
		margin: 8px auto 0;
	}
	.area.side.rail {
		align-items: center;
	}
	/* <1024px: the canvas is view-only; the note says why. */
	.narrow-note {
		position: absolute;
		top: 12px;
		inset-inline-end: 12px;
		z-index: 4;
		font-size: 12px;
		font-weight: 500;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: 999px;
		padding: 5px 13px;
		box-shadow: var(--sh-sm);
	}
	.loop-warn {
		position: absolute;
		top: 12px;
		inset-inline-start: 50%;
		transform: translateX(-50%);
		z-index: 4;
		font-size: 12px;
		font-weight: 500;
		color: #92400e;
		background: var(--c-amber-light);
		border: 1px solid var(--c-amber);
		border-radius: 999px;
		padding: 5px 13px;
		box-shadow: var(--sh-sm);
		pointer-events: none;
	}
	/* The stack owns the positioning; each pill is an ordinary flow child of it, so a boot, run and
	   submit failure sit under one another instead of all three at top:60px. `pointer-events: none`
	   keeps the (usually empty) full-width-free container from eating canvas clicks. */
	.pill-stack {
		position: absolute;
		top: 60px;
		inset-inline-start: 50%;
		transform: translateX(-50%);
		z-index: 20;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		pointer-events: none;
	}
	.boot-error {
		pointer-events: auto;
		background: var(--c-coral-pale);
		color: var(--c-coral-dark);
		border: 1px solid var(--c-coral-light);
		border-radius: var(--r);
		padding: 8px 14px;
		font-size: 13px;
	}
	/* The per-node run issues, nested INSIDE the .boot-error pill. Deliberately additive —
	   `.boot-error` is shared with `bootError`, which never has a list. Logical properties
	   (`padding-inline-start`) keep the bullets on the correct side under ar/he. */
	.run-issues {
		margin: 6px 0 0;
		padding-inline-start: 18px;
		font-size: 12.5px;
		line-height: 1.5;
		text-align: start;
		max-width: 420px;
	}
	.run-issue-node {
		font-weight: 600;
		margin-inline-end: 6px;
	}
	/* The warn-mode data-contract pill. Amber, deliberately NOT `.boot-error`'s coral — the run
	   succeeded, so an error-toned pill would be false. Same amber tokens as `.loop-warn`, which is
	   the other "this is not a failure, but look at it" surface on this screen. Unlike `.loop-warn`
	   it is `pointer-events: auto` (it owns a Dismiss button) and lives in `.pill-stack`, so it
	   stacks under a boot/run/submit pill instead of overlapping one. */
	.data-warn {
		pointer-events: auto;
		color: #92400e;
		background: var(--c-amber-light);
		border: 1px solid var(--c-amber);
		border-radius: var(--r);
		padding: 8px 14px;
		font-size: 13px;
		max-width: 460px;
		text-align: start;
	}
	/* The read-only pill. Same amber and the same reasoning as the two below it: the flow loaded
	   perfectly, so coral would state a failure that did not happen. `pointer-events: auto` because
	   `.pill-stack` is `pointer-events: none` and this pill's text can legitimately be selected
	   (the reader may want to quote it), even though it carries no control of its own. */
	.readonly-notice {
		pointer-events: auto;
		color: #92400e;
		background: var(--c-amber-light);
		border: 1px solid var(--c-amber);
		border-radius: var(--r);
		padding: 8px 14px;
		font-size: 13px;
		max-width: 460px;
		text-align: start;
	}

	/* The unresolved-descriptor pill. Same amber as `.data-warn` and for the same reason — this is
	   "look at this", not "it failed" — and it owns a Retry button, so `pointer-events: auto`. The
	   slug list can be long, so the text wraps and the button never does. */
	.descriptor-warn {
		pointer-events: auto;
		display: flex;
		align-items: baseline;
		gap: 12px;
		color: #92400e;
		background: var(--c-amber-light);
		border: 1px solid var(--c-amber);
		border-radius: var(--r);
		padding: 8px 14px;
		font-size: 13px;
		max-width: 460px;
		text-align: start;
	}
	/* Title and Dismiss on one row, so the control is the FIRST thing in the pill and its position
	   is independent of how many findings follow it. */
	.findings-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-top: 4px;
	}
	.findings-title {
		font-weight: 600;
		margin-top: 4px;
	}
	.findings-head .findings-title {
		margin-top: 0;
	}
	/* ⛔ THE CLIP GUARD. `.build-page` is `overflow: hidden`, so anything a pill grows past the
	   viewport edge is not scrolled to — it is GONE. The finding count is bounded by the dataset's
	   column count (two rules per mapped column), i.e. by nothing this screen controls, and the
	   measured failure was 250 findings → 250 `<li>` at `overflow-y: visible`. Capping the LIST
	   (not the pill) keeps the title, the Dismiss and the policy note outside the scroller and
	   always on screen, and every finding still reachable by scrolling inside it. `vh` rather than
	   a pixel height so a short viewport — the case that failed first — gets a proportionally
	   shorter list. `overscroll-behavior: contain` stops a flick at the end of the list from
	   scroll-chaining into the canvas behind it. */
	.findings-list {
		max-height: 30vh;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.findings-note {
		font-size: 12px;
		opacity: 0.85;
		margin-top: 4px;
	}
	.findings-dismiss {
		flex: none;
		font-size: 12px;
		font-weight: 600;
		color: inherit;
		background: transparent;
		border: 1px solid currentColor;
		border-radius: 999px;
		padding: 3px 12px;
		cursor: pointer;
	}
	/* `dataset.column → attribute` — an identifier, not prose. Monospace so a column name with an
	   underscore is readable, and `unicode-bidi: isolate` so an ASCII identifier does not get torn
	   apart by the surrounding RTL sentence under ar/he. */
	.finding-ref {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-weight: 600;
		margin-inline-end: 6px;
		unicode-bidi: isolate;
	}
</style>
