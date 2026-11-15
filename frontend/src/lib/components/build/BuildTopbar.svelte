<script lang="ts">
	// Build topbar (demo.html:2429–2451): flow picker + inline-editable title,
	// breadcrumb with node count + autosave indicator, action buttons (Test run,
	// history, Share, Submit). Share copies a permalink to the current flow.
	import type { FlowListItem, FlowStatus } from '$lib/types/flows';
	import * as m from '$lib/paraglide/messages';
	import { locales } from '$lib/paraglide/runtime';
	import { isDefaultFlowName } from '../../../routes/build/entry';
	import { fieldTypes } from '$lib/stores/field-types.svelte';

	// ⛔ A TRI-STATE, NOT A BOOLEAN, AND THE REASON IS THE `catch { return; }` THIS REPLACES. A
	// rejected clipboard write left the label reading "Delen" and did nothing else, so the author
	// walked away believing they had a link to paste. `navigator.clipboard` is undefined outside a
	// secure context and rejects when the document is not focused — this branch really fires. Same
	// shape as /connectors' once-only webhook secret. null = not attempted.
	let shareState = $state<'copied' | 'failed' | null>(null);
	// The permalink itself, kept so a FAILED copy can put it on screen: telling the reader to copy
	// it by hand is only actionable if they can see what to copy.
	let shareLink = $state('');
	let copyTimer: ReturnType<typeof setTimeout> | null = null;

	// Share = a permalink to this flow (a solution-backed flow is viewable by anyone;
	// /build loads it read-only for non-owners). Copy it to the clipboard.
	async function shareFlow() {
		if (!currentId) return;
		const link = `${window.location.origin}/build?id=${currentId}`;
		shareLink = link;
		if (copyTimer) clearTimeout(copyTimer);
		try {
			await navigator.clipboard.writeText(link);
		} catch {
			// ⚠️ NOT auto-cleared on a timer the way the confirmation is: the failure is a piece of
			// work the reader still has to do, and it stays until the next attempt says otherwise.
			shareState = 'failed';
			return;
		}
		shareState = 'copied';
		copyTimer = setTimeout(() => (shareState = null), 2000);
	}

	let {
		name,
		status,
		nodeCount,
		saveLabel,
		saving,
		flows,
		currentId,
		challengeId,
		challengeClosed,
		flowLoaded,
		readOnly,
		runLocked,
		chatBusy,
		submitting,
		running,
		startingEnv = false,
		historyOpen,
		canUndo,
		canRedo,
		onRename,
		onSelect,
		onNew,
		onSubmit,
		onTestRun,
		onToggleHistory,
		onUndo,
		onRedo,
		onSaveTemplate
	}: {
		name: string;
		status: FlowStatus;
		nodeCount: number;
		saveLabel: string;
		saving: boolean;
		flows: FlowListItem[];
		currentId: string | null;
		/** The challenge this build answers (`?challenge=`), or null when free-building. A solution
		 *  belongs to a challenge — `POST /api/solutions` requires `challenge_id` — so with no
		 *  challenge in context there is nothing to submit TO, and the primary action says so
		 *  instead of looking available and doing nothing. */
		challengeId: string | null;
		/**
		 * True when that challenge's CYCLE is over, so `POST /api/solutions` will answer
		 * `422 challenge_closed` (backend `challengeClosedSql`). A separate prop from `challengeId`
		 * because it is a separate fact with a separate failure: `challengeId === null` means there is
		 * nothing to submit TO, this means there is something and it will refuse.
		 *
		 * ⛔ THE LINK IS NOT THE ONLY ENTRY, WHICH IS WHY THE GATE HAS TO BE HERE. Withdrawing the
		 * "Build a solution" CTA on the challenge page stops the invitation; it does not stop
		 * `?challenge=` being hand-edited, bookmarked, or carried across a flow switch by
		 * `builderBootUrl`. A build that reaches Submit and is refused has already cost the author
		 * everything they were going to spend.
		 *
		 * ⚠️ `false` ALSO MEANS "WE COULD NOT ASK" — see /build's fetch `catch`. Deliberate: an
		 * unknown here must not disable Submit. Read the comment there before tightening this.
		 */
		challengeClosed: boolean;
		/**
		 * Is there actually a flow behind `currentId`? `name`/`status`/`nodeCount` cannot answer
		 * that: /build tears the builder down when a load FAILS, and the fallbacks it then passes
		 * (`'…'`, `'draft'`, `0`) are indistinguishable from a real draft — `'…'` is not one of the
		 * default flow names, so even the name gate reads it as properly named and opens.
		 *
		 * ⛔ WITHOUT THIS, THE TEARDOWN BUYS ONE DEAD CONTROL FOR EVERY LYING ONE IT REMOVES. With
		 * `?challenge=` in the URL and the challenge open, every other term of the Submit gate is
		 * false, so the button renders LIVE over a canvas with nothing on it — and `submitSolution`
		 * opens with `if (!builder.flow) return`, so the click is simply eaten. No hint accompanies
		 * it because the reason is already on screen and larger than a hint: the boot-error pill
		 * saying the flow could not be loaded.
		 */
		flowLoaded: boolean;
		/**
		 * The loaded flow belongs to someone else (`GET /api/flows/:id` → `readOnly:true`) and every
		 * write to it is refused by `loadOwnedFlow`. The comment at the head of this file has claimed
		 * "/build loads it read-only for non-owners" since Share was written; until this prop existed
		 * it was describing the BACKEND's behaviour and nothing on this bar acted on it.
		 *
		 * ⚠️ SHARE AND "NEW FLOW" STAY LIVE, DELIBERATELY. Both are valid for a visitor: the
		 * permalink is exactly what they were given, and starting their OWN flow is the repair the
		 * banner points at. Disabling the way out would leave a reader with a fully dead topbar and
		 * no route off the page. The picker stays live for the same reason.
		 */
		readOnly: boolean;
		/**
		 * Test run's own gate, when it differs from `readOnly`. /build passes the OWNER gate here and
		 * the effective one (owner OR narrow screen) as `readOnly`: a test run executes the SAVED graph
		 * and writes nothing to the flow, so it stays available at narrow width. Omitted = `readOnly`.
		 */
		runLocked?: boolean;
		/** True while the AI copilot has a turn in flight — switching flows mid-turn can
		 *  land its tool-calls on the wrong graph (see AgentChatStore.turnFlowId), so the
		 *  picker and "New flow" are disabled as the first line of defense. */
		chatBusy: boolean;
		submitting: boolean;
		running: boolean;
		/** True while a run is starting on a test environment that was paused after being idle: the
		 *  server resumes it as part of the run, so the button says so instead of a bare "Running". */
		startingEnv?: boolean;
		historyOpen: boolean;
		canUndo: boolean;
		canRedo: boolean;
		onRename: (name: string) => void;
		onSelect: (id: string) => void;
		onNew: () => void;
		onSubmit: () => void;
		onTestRun: () => void;
		onToggleHistory: () => void;
		onUndo: () => void;
		onRedo: () => void;
		/** "Save as template" in ⋯. Omitted (no entry) unless /build decides the reader may save one. */
		onSaveTemplate?: () => void;
	} = $props();

	// ── The Submit gate on "this flow still has the name we invented for it" ────────────────────
	//
	// EVERY locale's default name, not just the current one. `m.build_new_flow_default_name()`
	// resolves against the READER's locale, but the name was baked in at CREATE time in whatever
	// locale the author had then. A flow created in English ("Untitled flow") and opened with the UI
	// in Dutch would sail straight through a current-locale-only comparison — which is the exact
	// shape of the row sitting in prod right now.
	const defaultFlowNames = locales.map((l) => m.build_new_flow_default_name({}, { locale: l }));

	// The title input commits on `onchange` (blur/Enter). Without a draft the gate would only react
	// to BLUR, so a user who types a name and clicks Submit directly loses the click to a still-
	// disabled button — mousedown on a disabled button does not focus-shift the input, so `change`
	// never fires and the first click is simply eaten. `null` = "no uncommitted edit".
	let nameDraft = $state<string | null>(null);
	let titleInput = $state<HTMLInputElement | null>(null);

	// The draft SHADOWS the `name` prop (`nameDraft ?? name`), so it must not outlive the flow it was
	// typed into. `BuildTopbar` is not remounted on a flow switch, and the switch does not have to
	// move focus: `/build`'s `?id=` effect reopens the flow on any URL change, and `selectFlow` uses
	// `goto()`, which PUSHES history — so browser Back/Forward swaps the flow under a live input with
	// no blur, hence no `change`, hence no `commitRename`. An uncommitted "Claimformulier-samenvatter"
	// then vouches for a flow actually still called "Untitled flow" and opens the gate this component
	// exists to hold shut (and, in reverse, permanently disables Submit on a properly named flow).
	//
	// Reset here rather than `{#key idParam}` in `+page.svelte`: the invariant ("an uncommitted edit
	// belongs to ONE flow") is this component's own, so it holds for every caller instead of for the
	// one that remembered to key; and a remount would also discard the picker, the Share timer and
	// focus to reset a single variable.
	$effect(() => {
		// Both, not just `name`: two auto-created flows are BOTH "Untitled flow", which is the most
		// likely pair to switch between, and `name` alone would not observe that switch at all.
		void currentId;
		void name;
		nameDraft = null;
		// ⛔ AND THE SHARE STATE, FOR THE SAME REASON AND WITH A SHARPER EDGE. `shareLink` holds the
		// permalink of the flow the copy was attempted ON. Left alone, a failed copy on flow A
		// followed by a switch to flow B rendered A's link under B's title, telling the reader to
		// hand-copy the wrong flow — measured, and a NEW instance of the false-fact class this
		// component's failure notice exists to close. Before the notice existed, `catch { return }`
		// rendered nothing and the surface could not be wrong; adding an honest message created the
		// way for it to lie. Clear the timer too, or a pending 2s reset can fire against the new flow.
		if (copyTimer) clearTimeout(copyTimer);
		copyTimer = null;
		shareState = null;
		shareLink = '';
		// `value={name}` only writes the DOM when `name` itself changes, so on that same-name switch
		// Svelte leaves the typed text sitting in a field that no longer describes this flow.
		if (titleInput && titleInput.value !== name) titleInput.value = name;
	});

	const unnamed = $derived(isDefaultFlowName(nameDraft ?? name, defaultFlowNames));

	/** The gate, as opposed to the raw fact. An already-submitted flow is PAST this gate — Submit is
	 *  permanently disabled by `status === 'submitted'` regardless — so the amber field and the
	 *  actionable "name it first" hint would sit beside a dead "Submitted ✓" button advertising a fix
	 *  that cannot do anything. That is the actual prod row: "Untitled flow", already submitted. */
	const blockedOnName = $derived(unnamed && status !== 'submitted');

	/** Same shape as `blockedOnName`, and the `status !== 'submitted'` guard is there for the same
	 *  reason: a flow that has ALREADY been submitted is past this gate, and "this challenge takes no
	 *  new solutions" beside a dead "Submitted ✓" describes a refusal that never happened to it. The
	 *  `disabled` expression below keeps the raw fact, so the button is shut either way. */
	const blockedOnClosedChallenge = $derived(!!challengeId && challengeClosed && status !== 'submitted');

	/** The disabled-reason tooltip on Submit; one reason at a time, in the gate's own order. */
	const submitReason = $derived(
		!challengeId
			? m.build_submit_needs_challenge()
			: blockedOnClosedChallenge
				? m.build_submit_challenge_closed()
				: blockedOnName
					? m.build_submit_needs_name()
					: undefined
	);

	// The ⋯ menu. Closes on Escape and on a click anywhere outside it.
	let menuOpen = $state(false);
	let moreEl = $state<HTMLDivElement | null>(null);
	function onWindowClick(e: MouseEvent) {
		if (menuOpen && moreEl && !moreEl.contains(e.target as Node)) menuOpen = false;
	}
	function onWindowKeydown(e: KeyboardEvent) {
		if (menuOpen && e.key === 'Escape') menuOpen = false;
	}

	function commitRename(value: string) {
		nameDraft = null;
		onRename(value);
	}

	/** The refusal IS the affordance: clicking the hint puts the caret in the title, text selected. */
	function focusTitle() {
		titleInput?.focus();
		titleInput?.select();
	}
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<div class="topbar">
	<div class="left">
		<a class="back cp-dir-mirror" href="/solutions" title={m.build_back_to_solutions()}>←</a>
		<select
			class="picker"
			value={currentId ?? ''}
			disabled={chatBusy}
			aria-label={m.build_flow_picker_aria()}
			title={chatBusy ? m.build_flow_switch_blocked() : undefined}
			onchange={(e) => onSelect(e.currentTarget.value)}
		>
			{#each flows as f (f.id)}<option value={f.id}>{f.name}</option>{/each}
		</select>
		<button
			class="newflow newflow-inline"
			disabled={chatBusy}
			title={chatBusy ? m.build_flow_switch_blocked() : undefined}
			onclick={onNew}
		>
			{m.build_new_flow()}
		</button>
	</div>

	<div class="mid">
		<!-- `readonly`, not `disabled`: the title is the flow's IDENTITY and a visitor still needs to
		     read it (and copy it). A disabled input is dropped from the tab order and greys its own
		     text out, which hides the one thing on this bar the reader came for. -->
		<input
			class="title"
			class:unnamed={blockedOnName}
			bind:this={titleInput}
			value={name}
			readonly={readOnly}
			oninput={(e) => (nameDraft = e.currentTarget.value)}
			onchange={(e) => commitRename(e.currentTarget.value)}
			placeholder={m.build_flow_name_aria()}
			aria-label={m.build_flow_name_aria()}
		/>
		<!-- Only the save state under the title. "Test environment · N blocks" was noise: the pill on
		     the right already says test environment, and the canvas shows the blocks. The count stays
		     on `data-node-count` for tests and tooling. -->
		<div class="path" data-node-count={nodeCount}>
			<span class="save" class:saving>{saveLabel}</span>
		</div>
	</div>

	<div class="right">
		<button
			class="btn-ghost"
			class:running
			disabled={running || nodeCount === 0 || (runLocked ?? readOnly)}
			onclick={onTestRun}
			title={nodeCount === 0 ? m.build_test_run_title_empty() : m.build_test_run_title()}
		>
			{running ? (startingEnv ? m.build_starting_env() : m.build_running()) : m.build_test_run()}
		</button>

		<!-- The secondary actions live behind ⋯ so Run and Submit can never be pushed off the bar.
		     The panel stays IN THE DOM while closed (`hidden`), so its controls keep their state and
		     the share-failure notice below has somewhere to render. -->
		<div class="more" bind:this={moreEl}>
			<button
				type="button"
				class="more-btn"
				class:active={menuOpen || historyOpen}
				aria-haspopup="true"
				aria-expanded={menuOpen}
				aria-controls="build-more-menu"
				title={m.build_more_actions()}
				aria-label={m.build_more_actions()}
				onclick={() => (menuOpen = !menuOpen)}
			>⋯</button>
			<div class="more-panel" id="build-more-menu" hidden={!menuOpen}>
				<!-- The bar's own picker and "New flow", repeated here for a narrow bar: the container
				     queries below hide the inline pair and show these instead, so Run and Submit always
				     fit (at 900px with the sidebar open, Submit used to end at 978px, past the window). -->
				<select
					class="menu-picker"
					value={currentId ?? ''}
					disabled={chatBusy}
					aria-label={m.build_flow_picker_aria()}
					title={chatBusy ? m.build_flow_switch_blocked() : undefined}
					onchange={(e) => {
						menuOpen = false;
						onSelect(e.currentTarget.value);
					}}
				>
					{#each flows as f (f.id)}<option value={f.id}>{f.name}</option>{/each}
				</select>
				<button
					type="button"
					class="btn-ghost menu-newflow"
					disabled={chatBusy}
					title={chatBusy ? m.build_flow_switch_blocked() : undefined}
					onclick={() => {
						menuOpen = false;
						onNew();
					}}
				>
					{m.build_new_flow()}
				</button>
				<span class="pill"><span class="pulse"></span>{m.build_sandbox_pill()}</span>
				<!-- ⚠️ `|| readOnly` HERE IS THE COURTESY, NOT THE GATE — AND THE COMMENT THAT USED TO SIT
				     HERE WAS WRONG TWICE. It claimed undo/redo "do not go through the store's gated
				     mutators" (they do now: /build's `undo()`/`redo()` apply via `builder.replaceGraph`,
				     which refuses read-only) and that "both stacks are empty for the whole visit" on a
				     read-only flow (they are not: `resolveSlug` is deliberately ungated, so a late
				     descriptor reassigns `builder.nodes` and the recorder snapshots it). Disabling the
				     buttons is worth doing — an enabled control that does nothing is its own defect — but
				     the keyboard path (`onKeydown` on `<svelte:window>`) never reads this. -->
				<div class="more-row">
					<button class="btn-icon" onclick={onUndo} disabled={!canUndo || readOnly} title={m.build_undo()} aria-label={m.build_undo()}>↶</button>
					<button class="btn-icon" onclick={onRedo} disabled={!canRedo || readOnly} title={m.build_redo()} aria-label={m.build_redo()}>↷</button>
				</div>
				<button
					class="btn-ghost"
					class:active={historyOpen}
					onclick={() => {
						menuOpen = false;
						onToggleHistory();
					}}
					title={m.flow_history_title()}
				>
					{m.flow_history_open()}
				</button>
				{#if onSaveTemplate}
					<button
						class="btn-ghost"
						data-testid="save-as-template"
						disabled={!flowLoaded || nodeCount === 0}
						onclick={() => {
							menuOpen = false;
							onSaveTemplate();
						}}
					>
						{m.build_save_template()}
					</button>
				{/if}
				<button class="btn-ghost" onclick={shareFlow} disabled={!currentId} title={m.build_share_title()}>
					{shareState === 'copied' ? m.build_share_copied() : m.build_share()}
				</button>
				<!-- Developer and above only (`fieldTypes.allowed`, set by /build from the role). -->
				{#if fieldTypes.allowed}
					<label class="more-check" data-testid="toggle-field-types">
						<input type="checkbox" checked={fieldTypes.preference} onchange={() => fieldTypes.toggle()} />
						{m.build_show_field_types()}
					</label>
				{/if}
				<!-- role="status" so the outcome is ANNOUNCED, not only seen — a button label that changes is
				     invisible to a screen reader that is not on the button. The link is rendered ALONGSIDE the
				     sentence because "copy it by hand" is not an instruction anyone can follow against a value
				     that is nowhere on screen. `dir="ltr"`: a URL is an opaque token and must not be reordered
				     by an RTL paragraph direction (ar/he). -->
				{#if shareState === 'failed'}
					<span class="share-failed" role="status" data-testid="share-copy-failed">
						{m.build_share_copy_failed()}
						<code dir="ltr">{shareLink}</code>
					</span>
				{/if}
			</div>
		</div>

		<!-- ⛔ THE REASON SUBMIT IS DISABLED. It used to be a visible link beside the button, and on a
		     1280px screen it pushed Submit off the bar. Now the reason is the TOOLTIP on Submit (the
		     wrapper carries `title`, because a disabled button receives no pointer events in some
		     browsers), and the text stays in the DOM visually hidden: wired via aria-describedby for a
		     screen reader, and it becomes visible when a keyboard user tabs onto it — it is still the
		     way OUT (a link to the board, or the button that focuses the title). -->
		{#if !challengeId}
			<a class="submit-hint" id="submit-needs-challenge" href="/challenges"
				>{m.build_submit_needs_challenge()}</a
			>
		{:else if blockedOnClosedChallenge}
			<!-- Same pattern again, and it OUTRANKS the name gate: renaming the flow cannot make a dead
			     challenge accept it, so offering "name it first" here would send the author to fix the
			     one thing that changes nothing. A link, not a button — the way out is a DIFFERENT
			     challenge, and the board now defaults to the ones still accepting work. -->
			<a class="submit-hint" id="submit-challenge-closed" href="/challenges"
				>{m.build_submit_challenge_closed()}</a
			>
		{:else if blockedOnName}
			<!-- Same pattern, same reason. `/build` auto-names every new flow, Submit copies that name
			     verbatim into `solutions.title`, and the backend cannot refuse it (`min(1).max(160)`
			     must stay honest). So the refusal happens here — and it is a BUTTON that focuses and
			     SELECTS the title input, so the thing that says no is also the thing that fixes it. -->
			<button class="submit-hint" id="submit-needs-name" type="button" onclick={focusTitle}
				>{m.build_submit_needs_name()}</button
			>
		{/if}
		<!-- `status === 'submitted'` is part of the GATE, not just the label. `POST /api/solutions`
		     has no uniqueness constraint and refuses only ARCHIVED flows, so a second click — easily
		     reached via "open in build" from the solution detail page — creates a second solution row
		     for the same (challenge, flow). The label already said "Submitted ✓"; it now means it. -->
		<span class="submit-wrap" title={submitReason}>
			<button
				class="btn-primary"
				disabled={submitting ||
					!flowLoaded ||
					readOnly ||
					!challengeId ||
					challengeClosed ||
					status === 'submitted' ||
					blockedOnName}
				aria-describedby={!challengeId
					? 'submit-needs-challenge'
					: blockedOnClosedChallenge
						? 'submit-challenge-closed'
						: blockedOnName
							? 'submit-needs-name'
							: undefined}
				title={submitReason}
				data-short={status !== 'submitted' && !submitting ? m.build_submit_short() : undefined}
				onclick={onSubmit}
			>
				<!-- The full label stays the button's text (its accessible name and what every test finds
				     it by). In a very narrow bar the container query below hides it visually and paints
				     `data-short` instead, with an empty alt text so the name is not read twice. -->
				<span class="submit-label"
					>{status === 'submitted' ? m.build_submitted() : submitting ? m.build_submitting() : m.build_submit_solution()}</span
				>
			</button>
		</span>
	</div>
</div>

<style>
	.topbar {
		grid-column: 1 / -1;
		/* Sized by the BAR, not the viewport: the bar's width depends on whether the app sidebar is
		   the 64px rail or the full 248px, which no media query can see. */
		container-type: inline-size;
		display: flex;
		align-items: center;
		gap: 16px;
		padding: 0 18px;
		height: 100%;
		background: var(--c-white);
		border-bottom: 1px solid var(--c-border);
	}
	.left,
	.right {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	/* ⛔ THE TITLE (`.mid`) IS THE ONLY THING ON THE BAR THAT SHRINKS. `.right` holds Run, ⋯ and
	   Submit, all `flex-shrink: 0`, so it has nothing to give: letting `.right` itself shrink
	   (`flex-shrink: 1; min-width: 0`, as it was until 2026-10-14) did not make anything smaller,
	   it only let Submit overflow `.right` and get clipped. Flex shrinks items IN PROPORTION TO
	   THEIR BASIS, so `.right` was shrunk alongside the title long before the title reached its
	   floor — measured live: nl at 900px, title still 220px wide while Submit ended at 923px.
	   With `.right` rigid, the title absorbs the whole deficit down to its floor, and the container
	   queries below shed the picker and "New flow" before even that runs out. */
	.left,
	.right {
		flex-shrink: 0;
	}
	.right > .btn-ghost,
	.submit-wrap {
		flex-shrink: 0;
	}
	.more {
		position: relative;
		flex-shrink: 0;
	}
	.more-btn {
		font-size: 16px;
		line-height: 1;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		padding: 5px 9px;
		cursor: pointer;
	}
	.more-btn:hover,
	.more-btn.active {
		border-color: var(--c-border-strong);
		background: var(--c-surface);
	}
	.more-panel {
		position: absolute;
		top: calc(100% + 6px);
		inset-inline-end: 0;
		z-index: 30;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 8px;
		min-width: 200px;
		max-width: 340px;
		padding: 10px;
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		box-shadow: var(--sh-md);
	}
	.more-panel[hidden] {
		display: none;
	}
	.more-panel .pill {
		align-self: flex-start;
	}
	.more-row {
		display: flex;
		gap: 6px;
	}
	.more-check {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
		font-size: 12.5px;
		color: var(--c-ink);
		cursor: pointer;
		white-space: nowrap;
	}
	.more-panel .btn-ghost {
		text-align: start;
	}
	.submit-wrap {
		display: inline-flex;
	}
	/* A disabled button swallows hover in some browsers; let the wrapper take it so its `title`
	   (the disabled reason) still shows as a tooltip. */
	.btn-primary:disabled {
		pointer-events: none;
	}
	.btn-icon {
		font-size: 15px;
		line-height: 1;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		padding: 6px 9px;
		cursor: pointer;
	}
	.btn-icon:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.btn-icon:not(:disabled):hover {
		border-color: var(--c-border-strong);
	}
	.mid {
		/* The title takes the bar's free space and gives it up first; `.title`'s own max-width caps
		   it on a very wide bar, and the 120px floor (80px in a narrow bar) is where `.right` starts
		   to shrink instead. */
		flex: 1 1 auto;
		min-width: 120px;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.back {
		font-size: 17px;
		color: var(--c-muted);
		padding: 0 4px;
	}
	.picker {
		font-size: 12.5px;
		max-width: 180px;
		padding: 6px 8px;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		background: var(--c-surface);
		color: var(--c-ink);
	}
	.picker:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.newflow {
		font-size: 12px;
		color: var(--c-teal-dark);
		font-weight: 600;
		white-space: nowrap;
	}
	.newflow:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.title {
		font-family: var(--font-display);
		font-size: 16px;
		font-weight: 600;
		color: var(--c-midnight);
		/* A REAL border and a REAL background. This used to be `border: 1px solid transparent;
		   background: none;` with no placeholder — the rename control existed but was invisible
		   until you happened to hover it, so every flow kept the name the product invented and the
		   first user-submitted solution in prod is titled "Untitled flow". An editable field must
		   look editable. */
		border: 1px solid var(--c-border);
		border-radius: var(--r-sm);
		padding: 2px 6px;
		margin-inline-start: -6px;
		background: var(--c-white);
		width: 100%;
		max-width: 560px;
		min-width: 0;
		text-overflow: ellipsis;
	}
	.title::placeholder {
		color: var(--c-muted);
		font-weight: 400;
	}
	.title:hover {
		border-color: var(--c-border-strong);
	}
	.title:focus {
		border-color: var(--c-teal);
		background: var(--c-white);
		outline: none;
	}
	/* Amber while the flow still carries an auto-generated name — the same colour the hint beside
	   Submit uses, so the refusal and the field that resolves it read as one thing. */
	.title.unnamed {
		border-color: var(--c-amber);
		background: var(--c-amber-pale);
	}
	/* …and it must still be possible to SEE that you have landed in it. `.title:focus` kills the UA
	   outline and repaints the border teal, but `.title.unnamed` is later at equal specificity (0,3,0)
	   and wins the border back — while `outline: none` stands, because nothing overrides it. Tabbing
	   into the title in the one state this whole feature funnels users into therefore produced NO
	   visible change at all (WCAG 2.4.7); only the hint button's `.select()` highlight masked it.
	   Amber, not teal: the field is focused AND still unnamed, so the ring must not read as resolved. */
	.title.unnamed:focus {
		border-color: var(--c-amber);
		outline: 2px solid var(--c-amber);
		outline-offset: 1px;
	}
	.path {
		font-size: 11px;
		color: var(--c-muted);
		padding-inline-start: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.save {
		color: var(--c-teal-dark);
		font-weight: 500;
	}
	.save.saving {
		color: var(--c-amber);
	}
	.pill {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 11px;
		font-weight: 500;
		color: var(--c-teal-dark);
		background: var(--c-teal-pale);
		border: 1px solid var(--c-teal-light);
		border-radius: 999px;
		padding: 4px 10px;
		white-space: nowrap;
	}
	.pulse {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--c-teal);
		animation: pulse 1.8s ease-in-out infinite;
	}
	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
	.btn-ghost {
		font-size: 12.5px;
		color: var(--c-ink);
		background: var(--c-white);
		border: 1px solid var(--c-border);
		font-weight: 500;
		padding: 7px 12px;
		border-radius: var(--r);
		white-space: nowrap;
	}
	.btn-ghost:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.btn-ghost.running {
		color: var(--c-amber);
		border-color: var(--c-amber-light);
		background: var(--c-amber-pale);
		opacity: 1;
	}
	.btn-ghost.active {
		color: var(--c-teal-dark);
		border-color: var(--c-teal-light);
		background: var(--c-teal-pale);
	}
	/* Shared by both refusals — the `<a>` to /challenges and the `<button>` that focuses the title.
	   `app.css` already strips button chrome (`background: none; border: none; font: inherit`), so
	   the two render identically; only `padding` needs neutralising. */
	.submit-hint {
		font-size: 11.5px;
		font-weight: 500;
		color: var(--c-amber);
		white-space: nowrap;
		text-decoration: underline;
		padding: 0;
	}
	/* Visually hidden until focused (the tooltip on Submit carries it for a pointer). */
	.submit-hint:not(:focus) {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		clip-path: inset(50%);
	}
	/* The failed-copy line + the link it tells the reader to copy. `max-width` + `overflow` keep a
	   long permalink from pushing the Submit button off the topbar; the value stays selectable. */
	.share-failed {
		font-size: 11.5px;
		color: var(--c-coral-dark);
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 4px;
		max-width: 320px;
	}
	.share-failed code {
		font-family: var(--font-mono);
		font-size: 11px;
		max-width: 100%;
		overflow-x: auto;
		white-space: nowrap;
	}
	.btn-primary {
		font-size: 12.5px;
		background: var(--c-teal);
		color: #fff;
		font-weight: 600;
		padding: 7px 13px;
		border-radius: var(--r);
		white-space: nowrap;
	}
	.btn-primary:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	/* The menu's copies of the picker and "New flow" exist only for a narrow bar. */
	.menu-picker,
	.menu-newflow {
		display: none;
	}
	.menu-picker {
		font-size: 12.5px;
		padding: 6px 8px;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		background: var(--c-surface);
		color: var(--c-ink);
		max-width: 100%;
	}
	/* ⛔ A NARROW BAR SHEDS THE SECONDARY ITEMS, NEVER SUBMIT. Tier 1 moves "New flow" into ⋯ and
	   narrows the picker and the title's floor; tier 2 moves the picker in as well.
	   The thresholds are set by the LONGEST locale, not by English, and they compare against the
	   bar's CONTENT box (its width minus 2×18px padding). Measured 2026-10-14 with the sidebar as
	   /build leaves it (64px rail): a 900px window gives an 800px content box, and with tier 1 at
	   760px pl ("▷ Uruchomienie testowe" + "Zgłoś jako rozwiązanie") overflowed it by 26px and fr by
	   9px, so Submit ended past the window. 880px puts that bar in tier 1; 680px puts a 768px window
	   (668px) in tier 2, and a 900px window with the full sidebar opened by hand (616px) too. */
	@container (max-width: 880px) {
		.newflow-inline {
			display: none;
		}
		.menu-newflow {
			display: block;
		}
		.picker {
			max-width: 120px;
		}
		.mid {
			min-width: 80px;
		}
		.left,
		.right {
			gap: 6px;
		}
	}
	@container (max-width: 680px) {
		.picker {
			display: none;
		}
		.menu-picker {
			display: block;
		}
	}
	/* Tier 3: Submit's short label. A 768px window with the full 248px sidebar opened by hand leaves
	   a 484px bar; fr and pl ran 2–6px past it with the full label even with the picker and
	   "New flow" in ⋯. The short label is always a word of the full one ("Indienen" of "Indienen als
	   oplossing"), so the accessible name still contains what is on screen (WCAG 2.5.3). */
	@container (max-width: 540px) {
		.btn-primary[data-short] .submit-label {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip: rect(0 0 0 0);
			clip-path: inset(50%);
			white-space: nowrap;
		}
		.btn-primary[data-short]::after {
			content: attr(data-short) / '';
		}
	}
</style>
