<script lang="ts">
	// Solution detail (demo `solution-detail`). "Try it" runs the author's published
	// flow live in the VIEWER's own sandbox (read-only on the author's flow) via the
	// real run path + SSE trace — the same engine as Build's Test run. Side: coral vote
	// + comparison bars + "what wins". Voting toggles against the API.
	import { reloadOnLocaleChange } from '$lib/i18n/reload-on-locale.svelte';
	import { page } from '$app/state';
	import { solutionsApi } from '$lib/api/solutions';
	import { flowTemplatesApi } from '$lib/api/flow-templates';
	import { goto } from '$app/navigation';
	import { cycleApi } from '$lib/api/cycle';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { runsApi, RunApiError, runErrorDataFindings, type MySandbox } from '$lib/api/runs';
	import { dataValidationFrom } from '$lib/api/data-findings';
	import { dataFindingLabel, dataFindingRef } from '$lib/i18n/data-finding-label';
	import { deliveryErrorLabel, deliveryKindLabel } from '$lib/i18n/delivery-error-label';
	import { deliveryApi, type DeliveryTarget, type Delivery } from '$lib/api/delivery';
	import { auth } from '$lib/stores/auth.svelte';
	import { canSeeSessionCost } from '$lib/components/build/session-cost-visibility';
	import { canSeeInternalErrors } from '$lib/components/build/run-error-visibility';
	import { streamRun, type StreamControl } from '$lib/services/sse';
	import { RunTraceStore } from '$lib/stores/run-trace.svelte';
	import type { SolutionDetail } from '$lib/types/solutions';
	import type { DataValidationFinding, DataValidationMode } from '$lib/types/flows';
	import type { CycleState } from '$lib/types/cycle';
	import {
		solutionState,
		solutionStatusLabel,
		solutionVoteNote,
		solutionVoteBlockedReason
	} from '$lib/solutions/solution-state';
	import { normalizeChain } from '$lib/solutions/flow-chain';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import VoteButton from '$lib/components/marketplace/VoteButton.svelte';
	import FlowChain from '$lib/components/marketplace/FlowChain.svelte';
	import RunConsole from '$lib/components/build/RunConsole.svelte';
	import { demoDuration, timeAgo, num } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';
	import * as m from '$lib/paraglide/messages';

	const id = $derived(page.params.id ?? '');

	let data = $state<SolutionDetail | null>(null);
	// The live weekly cycle, or null when the engine has not opened the current ISO week — which is
	// what prod answers today, and the branch that must not resurrect a deadline.
	let cycle = $state<CycleState | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let voteBusy = $state(false);
	// A REFUSED vote, kept separate from `error` (the load error). `error` renders inside an
	// `{:else if}` chain, so writing a vote failure there would blank the whole board on the list
	// pages and never render at all on the detail pages (guarded by `&& !data`). This one renders
	// above the content and leaves it in place.
	let voteError = $state<string | null>(null);
	let loadGeneration = 0;

	// Live "Try it" run state (reuses the Build run pipeline: /api/runs + SSE trace).
	const runTrace = new RunTraceStore();
	let running = $state(false);
	let runError = $state<string | null>(null);
	let runCanResume = $state(false);
	// The ontology data-contract violations behind this run — the SAME three pieces of state /build
	// carries, for the same reason. "Try it" runs the author's flow against the author's test data
	// in the VIEWER's sandbox, so under the shipped `warn` policy a `pii_uncovered` finding means
	// those values land in the viewer's sandbox unredacted while the run goes green. This page
	// discarded the whole report: `startSolution` destructured `{ runId, sandboxId }` and dropped
	// `dataValidation`, and the `block` refusal rendered as one `errorText()` sentence naming no
	// column. `dataFindingsMode` says which policy produced them; the browser cannot see
	// `data.validation_mode` and must not guess.
	let dataFindings = $state<DataValidationFinding[]>([]);
	let dataFindingsMode = $state<DataValidationMode>('warn');
	let dataFindingsDismissed = $state(false);
	let runStream: StreamControl | null = null;
	let mySandbox = $state<MySandbox | null>(null);
	/**
	 * Why the sandbox line cannot be stated, or `null` when it can.
	 *
	 * ⛔ `mySandbox === null` MEANT THREE DIFFERENT THINGS AND THE PAGE PICKED THE FLATTERING ONE.
	 * `GET /api/sandboxes/me` legitimately answers `null` for a viewer who has never run anything,
	 * and the line below said so — "Je primaire sandbox wordt bij de eerste uitvoering aangemaakt."
	 * But `loadSandboxStatus`'s `catch {}` left the field at exactly that `null` when the request
	 * FAILED, so an offline viewer, an expired session or a 500 got the same confident sentence,
	 * permanently: the fetch runs once from the mount effect and is never retried except by a run
	 * event, which a reader who has not clicked Run will never produce.
	 *
	 * ⚠️ ITS OWN FIELD, NOT `error`. `error` is the LOAD error and its render site is mutually
	 * exclusive with this whole card; writing here would replace a solution that loaded fine. Same
	 * separation, and the same reason, as `voteError` and `runError` on this page.
	 */
	let sandboxError = $state<string | null>(null);
	let sandboxGeneration = 0;

	async function loadSandboxStatus() {
		const generation = ++sandboxGeneration;
		try {
			const loaded = await runsApi.getMySandbox();
			if (generation === sandboxGeneration) {
				mySandbox = loaded;
				sandboxError = null;
			}
		} catch (e) {
			// ⛔ WAS `catch {}`, REASONING "run start remains authoritative and renders a typed
			// actionable error". True only for a reader who clicks Run. For everyone else this line is
			// the ONLY sandbox information on the screen and it was unfalsifiable. `mySandbox` is left
			// as-is rather than blanked: on a failed REFRESH the status already on screen is still the
			// truest one we have, and replacing it with a failure notice would cost the reader a fact
			// they had.
			if (generation === sandboxGeneration) sandboxError = errorText(e, m.error_load_failed());
		}
	}

	function sandboxStatusLabel(status: MySandbox['status']): string {
		if (status === 'running') return m.status_running();
		if (status === 'suspended') return m.status_suspended();
		if (status === 'error') return m.status_error();
		return m.status_idle();
	}

	// This solution's vote surface, resolved against the SERVER'S OWN VOTE GATE (`cycleClosed`, on
	// both solution DTOs) and the live cycle. `data.week` is the solution's own competition week —
	// deliberately not `data.challenge.week`; see the header of $lib/solutions/solution-state.
	//
	// ⛔ `data.challenge?.status` WAS THE THIRD ARGUMENT HERE AND IT WAS THE WRONG FACT. The parent
	// challenge's lifecycle stopped deciding votability when the server gate moved onto this row's
	// own cycle — the change that ended nine consecutive winnerless weeks. `?? null` is kept so a
	// mid-roll payload that omits `cycleClosed` lands on 'unknown' (blocked, honestly labelled)
	// rather than falling through to a confidently live pill.
	const viewState = $derived(
		data ? solutionState(data.status, data.week, data.cycleClosed ?? null, cycle) : null
	);

	// ⛔ THE CHAIN, NORMALISED ONCE — and every LENGTH on this page reads it rather than
	// `data.flow.chain`. The wire array can arrive in either of two shapes during a roll, and the
	// current one has the `foreach` containers filtered out server-side, so the raw array's length is
	// no longer the number of chips the reader sees. Two places depend on that count: `RunConsole`'s
	// progress denominator and the "N blocks" caption under the card.
	const chainNodes = $derived(normalizeChain(data?.flow?.chain));

	// ⛔ NAMES IF THE SERVER SENT THEM, SLUGS IF IT DID NOT. `blocksUsedNames` is additive
	// (backend/src/routes/solutions.ts), so an API one roll behind omits it and this renders exactly
	// what it rendered before. `?? `, not `||`: an empty array is a real answer for a solution built
	// with no blocks, and falling through on it would print the slug list for a row that has none.
	const blocksUsedText = $derived((data?.blocksUsedNames ?? data?.blocksUsed ?? []).join(' · '));

	async function load() {
		const generation = ++loadGeneration;
		const loadId = id;
		loading = true;
		error = null;
		try {
			// The cycle is decoration; `.catch(() => null)` keeps a cycle outage out of `error`, whose
			// render site is mutually exclusive with the whole detail view. It rides the same
			// generation guard as the solution so a locale switch mid-flight cannot interleave them.
			const [loaded, cyc] = await Promise.all([solutionsApi.get(loadId), cycleApi.current().catch(() => null)]);
			if (generation === loadGeneration && loadId === id) {
				data = loaded;
				cycle = cyc;
			}
		} catch (e) {
			if (generation === loadGeneration && loadId === id) error = errorText(e, m.error_load_failed());
		} finally {
			if (generation === loadGeneration && loadId === id) loading = false;
		}
	}

	// "Use as starting point": a new draft flow for the reader, copied from this solution's flow.
	let startingCopy = $state(false);
	let startCopyError = $state<string | null>(null);
	async function useAsStart() {
		if (!data || startingCopy) return;
		startingCopy = true;
		startCopyError = null;
		try {
			const { flowId } = await flowTemplatesApi.useSolution(data.id);
			await goto(`/build?id=${encodeURIComponent(flowId)}`);
		} catch (e) {
			startCopyError = writeErrorText(e, m.error_load_failed());
		} finally {
			startingCopy = false;
		}
	}

	async function vote() {
		if (!data || voteBusy) return;
		voteBusy = true;
		voteError = null;
		const next = !data.hasVoted;
		const votedId = id;
		const wasVoted = data.hasVoted;
		const wasCount = data.votesCount;
		data = { ...data, hasVoted: next, votesCount: data.votesCount + (next ? 1 : -1) };
		try {
			const res = next ? await solutionsApi.vote(id) : await solutionsApi.unvote(id);
			if (data) data = { ...data, hasVoted: res.voted, votesCount: res.count };
		} catch (e) {
			// ⛔ REVERT FIRST, RECONCILE SECOND — see the long note on `vote()` in
			// routes/challenges/+page.svelte. `load()`'s own catch writes only `error`, so the
			// phantom count survived exactly the outage that fails both calls.
			//
			// ⚠️ `votedId === id`, BECAUSE THIS PAGE HAS NO GENERATION GUARD IN `vote()` the way
			// challenges/[id] does — only `load()` carries one. After a navigation `data` is truthy
			// again and holds a DIFFERENT solution, so an unguarded revert would subtract a vote
			// that was never cast from someone else's count. Comparing the captured route id is the
			// same test `load()` makes (`loadId === id`) and is enough here.
			if (data && votedId === id) data = { ...data, hasVoted: wasVoted, votesCount: wasCount };
			// See challenges/+page.svelte: a silently-reverted vote reads as a dead button, and the
			// page's `error` state is the LOAD error — reusing it blanks the content.
			voteError = errorText(e, m.error_action_failed());
			await load();
		} finally {
			voteBusy = false;
		}
	}

	async function runSample() {
		if (running || !data?.flow) return;
		running = true;
		runError = null;
		runCanResume = false;
		dataFindings = [];
		dataFindingsDismissed = false;
		runTrace.clear();
		try {
			const res = await runsApi.startSolution(id);
			const { runId, sandboxId } = res;
			// ⛔ BEFORE `runTrace.reset(runId)`, and on the SUCCESS path — the same three lines
			// /build got, for the same reason. `data.validation_mode` ships as `warn`, so a run whose
			// test data breaks the contract gets a 201 and streams green while (for `pii_uncovered`)
			// the values go into the sandbox UNREDACTED. `dataValidationFrom` re-guards the body
			// structurally; `unwrap()` casts, it does not validate.
			const report = dataValidationFrom(res);
			if (report) {
				dataFindings = report.findings;
				dataFindingsMode = report.mode;
			}
			if (sandboxId && mySandbox?.id === sandboxId) mySandbox = { ...mySandbox, status: 'running' };
			runTrace.reset(runId);
			runStream?.close();
			runStream = streamRun(runId, {
				onEvent: (ev) => {
					runTrace.ingest(ev);
					if (ev.type === 'run_complete') {
						running = false;
						void loadSandboxStatus();
					}
				},
				onError: (e) => {
					runError = errorText(e, m.error_action_failed());
					running = false;
					void loadSandboxStatus();
				},
				onEnd: () => {
					running = false;
				}
			});
		} catch (e) {
			runError = writeErrorText(e, m.error_action_failed());
			// A refusal is only ever the `block` policy — `warn` never throws. Rendered inside the
			// error paragraph, because here the findings ARE the reason the run did not happen: a
			// 422 used to reach the reader as one sentence that named no column.
			dataFindings = runErrorDataFindings(e);
			dataFindingsMode = 'block';
			runCanResume =
				e instanceof RunApiError && e.code === 'sandbox_suspended' && e.details.resumable === true;
			void loadSandboxStatus();
			running = false;
		}
	}

	async function resumeAndRetry() {
		if (running) return;
		running = true;
		runError = null;
		try {
			mySandbox = await runsApi.resumeMySandbox();
			running = false;
			await runSample();
		} catch (e) {
			runError = writeErrorText(e, m.error_action_failed());
			runCanResume = false;
			running = false;
		}
	}

	// ── Forward to delivery (Phase 5B/5C — tenant_admin only) ────────────────────────────────
	// A tenant_admin can forward this solution to a configured backlog connector. Jira + Azure DevOps
	// create a real issue / work item; fr (Target B, 5D, now live) creates a DRAFT project_request a
	// human approves in fr before fr/n8n/kanban act.
	const FORWARDABLE_KINDS = ['jira', 'azure_devops', 'fr'];
	let backlogTargets = $state<DeliveryTarget[]>([]);
	let deliveries = $state<Delivery[]>([]);
	let selectedTargetId = $state('');
	let forwardBusy = $state(false);
	let forwardError = $state<string | null>(null);
	let retryingId = $state<string | null>(null);
	// ⛔ THE CONNECTOR LIST FAILED TO LOAD — which is NOT the same fact as "you have no connectors",
	// and the empty state says the second one. See `loadDelivery`.
	let deliveryError = $state<string | null>(null);

	async function loadDelivery() {
		if (!auth.isTenantAdmin) return;
		deliveryError = null;
		try {
			const [targets, rows] = await Promise.all([
				deliveryApi.list(),
				deliveryApi.listForSolution(id)
			]);
			backlogTargets = targets.filter((t) => t.enabled && FORWARDABLE_KINDS.includes(t.kind));
			deliveries = rows;
			if (!selectedTargetId && backlogTargets[0]) selectedTargetId = backlogTargets[0].id;
		} catch (e) {
			// ⛔ THE OLD COMMENT HERE READ "A non-admin (or a transient error) simply gets no delivery
			// section." ITS OWN JUSTIFICATION WAS FALSE: the `auth.isTenantAdmin` guard one line above
			// has ALREADY returned for the non-admin, so this catch only ever sees a real failure. And
			// it did not produce "no delivery section" — it left `backlogTargets` at `[]`, which is the
			// card's EMPTY STATE, so a tenant admin whose GET /api/delivery 500'd was told "no Jira
			// connector has been configured yet" and handed a link to go and configure the connector
			// they already have. Same class as the DatasetPicker `emptyHint` defect on /submit.
			// `errorText`, not `writeErrorText`: this is a READ, and there is no 400/422/409 body to
			// prefer.
			deliveryError = errorText(e, m.delivery_forward_load_failed());
		}
	}

	/** Is there already a live (in-flight / created) delivery to the selected connector? */
	const liveForSelected = $derived(
		deliveries.some(
			(d) =>
				d.targetId === selectedTargetId &&
				['pending', 'sent', 'created', 'draft_created', 'approved', 'promoted'].includes(d.status)
		)
	);

	async function forward() {
		if (forwardBusy || !selectedTargetId) return;
		forwardBusy = true;
		forwardError = null;
		try {
			await deliveryApi.forward(id, selectedTargetId);
		} catch (e) {
			forwardError = writeErrorText(e, m.error_action_failed());
		} finally {
			forwardBusy = false;
			await loadDelivery();
		}
	}

	async function retryDelivery(deliveryId: string) {
		if (retryingId) return;
		retryingId = deliveryId;
		forwardError = null;
		try {
			await deliveryApi.retry(id, deliveryId);
		} catch (e) {
			forwardError = writeErrorText(e, m.error_action_failed());
		} finally {
			retryingId = null;
			await loadDelivery();
		}
	}

	/**
	 * ⛔ THE `return s` USED TO BE REACHABLE, AND IT RETURNED AN ENGLISH ENUM MEMBER.
	 * `DeliveryStatus` has EIGHT members (`$lib/api/delivery.ts`, mirroring
	 * `backend/src/db/delivery-types.ts` and the `delivery_status` pg enum). This mapped five. A
	 * row that arrived `approved` or `rejected` fell through to the raw wire value and a Dutch
	 * reader got a bare `approved` chip inside otherwise-Dutch copy — the exact class the delivery
	 * 409 and the `delivery-rowerr` span were both already fixed for on this same card.
	 *
	 * ⚠️ THE FALL-THROUGH IS KEPT, DELIBERATELY, AND IT IS NOW UNREACHABLE FOR THE DECLARED UNION.
	 * TypeScript narrows `s` to `never` on the last line, so a NINTH status added to the enum reds
	 * `bun run check` here rather than silently shipping an English chip. It still executes at
	 * runtime, because a rolling deploy really does let an OLD bundle be handed a NEW status by a
	 * newer pod, and the raw value is a better read than a blank chip. Same doctrine as
	 * `$lib/i18n/delivery-error-label.ts`'s `errorCode` fallback.
	 */
	function statusLabel(s: Delivery['status']): string {
		if (s === 'created') return m.delivery_forward_status_created();
		if (s === 'failed') return m.delivery_forward_status_failed();
		if (s === 'pending' || s === 'sent') return m.delivery_forward_status_pending();
		if (s === 'draft_created') return m.delivery_forward_status_draft_created();
		if (s === 'promoted') return m.delivery_forward_status_promoted();
		if (s === 'approved') return m.delivery_forward_status_approved();
		if (s === 'rejected') return m.delivery_forward_status_rejected();
		return s;
	}

	/**
	 * The connector's tool name.
	 *
	 * ⚠️ THIS USED TO BE A HAND-WRITTEN COPY of the (tenant)/delivery screen's three-branch switch,
	 * carrying a comment that said it "reuses" them while reusing nothing. Both screens now call the
	 * one definition in `$lib/i18n/delivery-error-label`, which is also where the failure sentences
	 * that interpolate this name live — so a fourth copy cannot appear beside them.
	 */
	const kindLabel = (k: DeliveryTarget['kind']): string => deliveryKindLabel(k);

	// Re-load everything whenever the solution id changes. SvelteKit reuses this component
	// across /solutions/A → /solutions/B navigations (a plain onMount runs only once), so
	// without this the page would keep showing solution A's data, its delivery targets, and a
	// stale selected forward target — silently forwarding B against A's connector.
	$effect(() => {
		void id; // track the route param
		runStream?.close();
		running = false;
		data = null;
		runError = null;
		runCanResume = false;
		// Solution B's screen must not carry solution A's findings — they name A's dataset.
		dataFindings = [];
		dataFindingsDismissed = false;
		runTrace.clear();
		// ⛔ THE TWO REFUSALS THAT USED TO SURVIVE THE NAVIGATION. Both are about an action taken on
		// the PREVIOUS solution, and neither has any other writer that clears them — `vote()` and
		// `forward()`/`retryDelivery()` only null them on their own next attempt. `voteError` renders
		// ABOVE the loading/error gates, so it sat over the incoming solution's skeleton and read as
		// a refusal about IT.
		//
		// ⚠️ `deliveryError` IS DELIBERATELY NOT HERE. `loadDelivery()` clears it on its first line
		// and this effect calls `loadDelivery()` — a reset here would be a second writer on state
		// that is already correct. Pinned by `solution-detail.refusal-reset.svelte.test.ts`.
		voteError = null;
		forwardError = null;
		selectedTargetId = '';
		deliveries = [];
		backlogTargets = [];
		void load();
		void loadDelivery();
		void loadSandboxStatus();
		return () => runStream?.close();
	});
	reloadOnLocaleChange(load);
</script>

<!-- The data-contract findings, shared by the refusal paragraph and the warn pill: the SAME
     `DataValidationFinding[]` reaches both, only the policy that produced them differs. Deliberately
     the SAME markup, classes and helpers as build/+page.svelte's snippet of the same name — the
     `dataset.column → attribute` address and the localized sentence are one rendering with two call
     sites, not two renderings. Same index key, for the same reason: one column can raise BOTH rules
     at once, so `rule + ref` collides on the first realistic case. -->
{#snippet findingList(findings: DataValidationFinding[])}
	<ul class="run-issues findings-list" data-testid="data-findings-list">
		{#each findings as f, i (i)}
			<li><span class="finding-ref">{dataFindingRef(f)}</span>{dataFindingLabel(f)}</li>
		{/each}
	</ul>
{/snippet}

<div class="page">
	<a class="back" href="/solutions">{m.solution_detail_back()}</a>

	{#if voteError}
		<div class="notice error">{voteError}</div>
	{/if}

	{#if loading && !data}
		<div class="notice">{m.solution_detail_loading()}</div>
	{:else if error && !data}
		<div class="notice error" role="alert">
			<span>{error}</span>
			<!-- ⛔ THE COPY NAMES AN ACTION; THIS IS THE CONTROL THAT PERFORMS IT. `error_load_failed`
			     reads "We couldn't load that. Please try again." and this arm replaces the whole page,
			     so a failed first load was a dead end with no exit but F5. Same sentence-plus-button
			     shape as the profile-error row in +layout.svelte, except this one re-runs the page's own
			     loader rather than reloading the app. -->
			<button class="retry" onclick={load}>{m.error_load_retry()}</button>
		</div>
	{:else if data}
		<header class="detail-head">
			<div class="badges">
<!-- ⛔ WAS `data.status === 'shipping' ? … : solution_detail_status_voting()`, whose catalog
				     entry read "Voting · closes Thu 18:00" — a per-solution deadline nailed into the
				     catalog that no field produced. The pill now comes from the helper, which reads
				     `cycleClosed` — the server's own gate on THIS solution's competing cycle — for
				     whether voting is open, and the live cycle row for any countdown. (It read the
				     PARENT's status until the votability fix; that sentence stood here after the fact
				     it described was gone.) -->
				<!-- Muted on BOTH non-votable states, driven off `votability` rather than `kind`: a closed
				     parent and an invisible one are different facts but the same affordance, and a coral
				     pill above a dead vote button reads as live either way. -->
				<span class="badge coral" class:muted={viewState ? viewState.votability !== 'open' : false}>{viewState ? solutionStatusLabel(viewState) : ''}</span>
				{#if data.challenge?.code}<span class="badge outline">{m.solution_detail_solution_to({ code: data.challenge.code })}</span>{/if}
			</div>
			<h1>{data.title}</h1>
			<div class="byline">
				<Avatar initials={data.author.initials} size={34} />
				<div>
					<div class="who">{data.author.name}</div>
					<!-- ⛔ NO BUILD TIME IN THIS BYLINE, and the `{buildTime}` argument is gone from the
					     `solution_detail_byline` message in all 8 catalogs. It rendered "Ingediend {ago} ·
					     Bouwtijd —" on every solution a real person submitted, because
					     `solutions.build_time_minutes` was NULL for all of them and the helper here
					     returned a literal em dash. The concept has no honest source — see the comment on
					     the column in backend/src/db/schema.ts — so it was removed rather than hidden. -->
					<!-- What DOES belong here is the MEASURED one. `demoMs` is the duration of this
					     solution's most recent successful run through the very "Try it" button below
					     (`flow_runs.solution_id`, migration 0065). Conditional on `!= null`, never
					     truthiness: a sub-millisecond run is a real answer; only "nobody has run it"
					     is absence, and absence is no clause rather than a dash. -->
					<!-- ⛔ TWO WHOLE SENTENCES, NEVER A TEMPLATE-GLUED SEPARATOR. The first draft was
					     `{byline}{#if …} · {solutions_live_demo}{/if}`, which rendered a DOUBLED middot —
					     `solutions_live_demo` is "Live demo · {duration}", written for the board's own
					     `<span>·</span>` layout — so the detail page read "Ingediend 3d geleden · Live
					     demo · 3.4s". Worse, gluing ` · ` in the TEMPLATE hands the separator's visual
					     placement to the bidi algorithm under `dir=rtl`, which is exactly what
					     `demoDuration`'s header says never to do. Each branch is now one catalog string
					     whose translator owns the whole order. -->
					<div class="sub">
						{#if data.demoMs != null}{m.solution_detail_byline_demo({ ago: timeAgo(data.createdAt), duration: demoDuration(data.demoMs, locale.current) })}{:else}{m.solution_detail_byline({ ago: timeAgo(data.createdAt) })}{/if}
					</div>
				</div>
			</div>
		</header>

		<div class="layout">
			<div class="main">
				<div class="card">
					<div class="card-head"><h2>{m.solution_detail_tryit_title()}</h2><span class="badge teal">{m.solution_detail_sandbox_badge()}</span></div>
					{#if data.flow}
						<p class="tryit-note">{m.solution_detail_tryit_explainer({ name: data.author.name.split(' ')[0] })}</p>
						<p class="tryit-note sample-note">{m.solution_detail_tryit_sample_data()}</p>
						<!-- ⛔ THREE STATES, NOT TWO. The middle arm is the new one and it is the honest one:
						     a failed probe is not a workspace fact. The order matters — a KNOWN sandbox wins
						     over a failed refresh, because the status on screen is still the truest thing we
						     have; only when we have never had one does the failure replace the sentence.
						     ⚠️ THE RETRY IS A CONTROL, NOT AN INSTRUCTION. The one thing a reader can do
						     about this is ask again, and `loadSandboxStatus` is idempotent and already
						     generation-guarded, so it is safe to press. `error_load_retry` is the same
						     existing key the /challenges load failure offers. -->
						{#if mySandbox}
							<p class="sandbox-status">
								{m.solution_detail_sandbox_status({ slug: mySandbox.slug, status: sandboxStatusLabel(mySandbox.status) })}
							</p>
						{:else if sandboxError}
							<p class="sandbox-status sandbox-failed" role="status" data-testid="sandbox-error">
								<span>{m.solution_detail_sandbox_unavailable()}</span>
								<button class="sandbox-retry" onclick={loadSandboxStatus}>{m.error_load_retry()}</button>
							</p>
						{:else}
							<p class="sandbox-status">{m.solution_detail_sandbox_pending()}</p>
						{/if}
						<div class="tryit-actions">
							<button class="btn-run" disabled={running} onclick={runSample}>
								{running ? m.solution_detail_tryit_running() : m.solution_detail_tryit_run()}
							</button>
						</div>
						{#if runError}
							<p class="run-error">{m.solution_detail_tryit_failed({ error: runError })}</p>
							<!-- The `block` refusal. Until now this whole branch was ONE sentence from
							     `errorText()` — "the selected test data does not satisfy the published data
							     contract" — naming no dataset, no column and no attribute, while the 422
							     body carried all three. -->
							{#if dataFindings.length && dataFindingsMode === 'block'}
								<div class="findings-title">{m.data_findings_title_block()}</div>
								{@render findingList(dataFindings)}
							{/if}
						{/if}
						<!-- ⛔ THE WARN PILL, and on THIS screen it is the viewer's OWN sandbox the data
						     goes into. Amber, not coral: the run started, it is streaming, it will go
						     green — what is not fine is the data inside it. It must NOT clear on
						     `run_complete`; only the next run or a Dismiss removes it. Dismiss sits in the
						     header ahead of the list, and the list carries its own scroll cap, for the
						     reason spelled out on build/+page.svelte: at a few dozen findings a trailing
						     button walks off the bottom of the surface that holds it. -->
						{#if dataFindings.length && dataFindingsMode === 'warn' && !dataFindingsDismissed}
							<div class="data-warn" data-testid="data-findings-warn">
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
						{#if runCanResume}
							<button class="btn-run" disabled={running} onclick={resumeAndRetry}>{m.solution_detail_tryit_resume()}</button>
						{/if}
						{#if runTrace.runId}
							<div class="run-wrap">
								<RunConsole
									events={runTrace.events}
									status={runTrace.status}
									nodeCount={chainNodes.length}
									stepName={(_nodeId: string, slug: string) => chainNodes.find((c) => c.slug === slug)?.name ?? slug}
									showCost={canSeeSessionCost(auth.user?.roles ?? []) || auth.isSuperAdmin}
									showInternalErrors={canSeeInternalErrors(auth.user?.roles ?? []) || auth.isSuperAdmin}
								/>
							</div>
						{/if}
					{:else}
						<p class="tryit-note">{m.solution_detail_tryit_no_flow()}</p>
					{/if}
				</div>

				{#if data.flow}
					<div class="card">
						<h2>{m.solution_detail_flow_built({ name: data.author.name.split(' ')[0] })}</h2>
						<FlowChain chain={data.flow.chain} />
						<!-- ⛔ THE `challenge=` PARAMETER IS DROPPED WHEN THAT CHALLENGE'S CYCLE IS OVER, and
						     the ANCHOR STAYS. `?challenge=` is what arms /build's Submit, so carrying a dead
						     challenge across hands the reader a builder whose primary action can only 422 —
						     the same "offer a link we know leads to a refusal" defect as the challenge
						     page's Build CTA, one screen further on. Landing in /build with no challenge is
						     the DESIGNED empty state, not a degradation: BuildTopbar renders
						     `build_submit_needs_challenge` as a link to the board, so the refusal names its
						     own way out. Deleting the anchor instead would take the flow itself away, which
						     is the thing the reader actually clicked for. -->
						<p class="flow-cap">{m.solution_detail_flow_cap({ count: num(chainNodes.length, locale.current) })} <a class="open-build" href={`/build?id=${data.flow.id}${data.challenge && !data.challenge.cycleClosed ? `&challenge=${data.challenge.id}` : ''}`}>{m.solution_detail_open_in_build()}</a></p>
						<!-- A COPY of this flow as the reader's own draft (any member, same organisation):
						     "Open in Build" shows the author's flow read-only; this one can be edited. -->
						<button type="button" class="use-start" data-testid="use-as-start" disabled={startingCopy} onclick={useAsStart}>
							{startingCopy ? m.solution_use_as_start_busy() : m.solution_use_as_start()}
						</button>
						{#if startCopyError}<p class="use-start-error" role="alert">{startCopyError}</p>{/if}
					</div>
				{:else}
					<div class="card">
						<h2>{m.solution_detail_flow_title()}</h2>
						<!-- The GUARD stays on `blocksUsed` — the canonical list, present on every payload —
					     while the TEXT comes from the resolved names. A mid-roll response that omits
					     `blocksUsedNames` must still render this line, not silently drop it. -->
					<p class="empty">{m.solution_detail_flow_empty()}{#if data.blocksUsed.length}{m.solution_detail_flow_empty_built()}<span class="mono-inline">{blocksUsedText}</span>{/if}.</p>
					</div>
				{/if}
			</div>

			<aside class="side">
				{#if auth.isTenantAdmin}
					<div class="card delivery-card">
						<h3>{m.delivery_forward_title()}</h3>
						<p class="delivery-intro">{m.delivery_forward_intro()}</p>

						<!-- ⛔ THE FAILURE BRANCH COMES FIRST, AND REPLACES THE EMPTY STATE RATHER THAN SITTING
						     BESIDE IT. Rendered alongside, "no connector configured yet" plus its
						     go-configure-one link would still be on screen contradicting it — the exact
						     sentence this branch exists to stop showing to an admin whose connectors merely
						     failed to load. -->
						{#if deliveryError}
							<p class="delivery-error" role="alert" data-testid="delivery-load-error">{deliveryError}</p>
						{:else if backlogTargets.length === 0}
							<p class="delivery-none">
								{m.delivery_forward_none()}
								<a class="open-build" href="/delivery">{m.delivery_forward_none_cta()}</a>
							</p>
						{:else}
							<label class="delivery-field">
								<span class="delivery-label">{m.delivery_forward_connector()}</span>
								<select bind:value={selectedTargetId} disabled={forwardBusy}>
									{#each backlogTargets as t (t.id)}
										<option value={t.id}>{t.name} · {kindLabel(t.kind)}</option>
									{/each}
								</select>
							</label>
							<button
								class="btn-forward"
								disabled={forwardBusy || !selectedTargetId || liveForSelected}
								onclick={forward}
							>
								{forwardBusy ? m.delivery_forward_submitting() : m.delivery_forward_submit()}
							</button>
							{#if liveForSelected}
								<p class="delivery-hint">{m.delivery_forward_already_live()}</p>
							{/if}
						{/if}

						{#if forwardError}<p class="delivery-error">{m.delivery_forward_error({ error: forwardError })}</p>{/if}

						{#if deliveries.length}
							<div class="delivery-history">
								<span class="delivery-history-head">{m.delivery_forward_history()}</span>
								{#each deliveries as d (d.id)}
									<div class="delivery-row">
										<span class="delivery-chip" class:created={d.status === 'created'} class:promoted={d.status === 'promoted'} class:approved={d.status === 'approved'} class:draft={d.status === 'draft_created'} class:failed={d.status === 'failed'} class:rejected={d.status === 'rejected'} class:pending={d.status === 'pending' || d.status === 'sent'}>
											{statusLabel(d.status)}
										</span>
										<!-- ⛔ `approved` BELONGS IN THIS WHITELIST AND WAS MISSING FROM IT. The three branches
										     below are a whitelist of statuses allowed to show their link, not a test of whether a
										     link exists — so an `approved` row with a perfectly good `externalUrl` fell to the
										     `{:else if}`, matched neither arm, and rendered a chip with NOTHING beside it. The
										     ticket is live at the target and the one control that reaches it disappeared. -->
										{#if (d.status === 'created' || d.status === 'draft_created' || d.status === 'promoted' || d.status === 'approved') && d.externalUrl}
											<a class="delivery-link" href={d.externalUrl} target="_blank" rel="noopener noreferrer">
												{d.externalRef ?? m.delivery_forward_open({ tool: kindLabel(d.targetKind) })}
											</a>
										<!-- ⛔ `|| rejected` — THE PAGE CONTRADICTED THE ROUTE AND ITS OWN COPY. Retry lived in a
										     `failed`-only arm, while `backend/src/routes/delivery.ts:739` gates on
										     `status !== 'failed' && status !== 'rejected'` and the refusal it throws is spelled out
										     in `messages/en.json` as "Only a failed or rejected delivery can be retried." The
										     backend has accepted a rejected retry since 0032 (`LIVE_DELIVERY_STATUSES` excludes
										     'failed'/'rejected' precisely so both are re-sendable); the button was simply not
										     rendered, so a rejected delivery was an inert row with no way forward from the UI.
										     ⚠️ `delivery_forward_ticket_exists` and the error span stay `failed`-ONLY. A rejected
										     row has no `error` (nothing failed — a human said no), and "the ticket already exists"
										     is the #174 partial-dispatch note, which is a statement about a FAILURE. Widening the
										     retry arm must not widen the sentences inside it. -->
										{:else if d.status === 'failed' || d.status === 'rejected'}
											{#if d.externalUrl}
												<a class="delivery-link" href={d.externalUrl} target="_blank" rel="noopener noreferrer">
													{d.externalRef ?? m.delivery_forward_open({ tool: kindLabel(d.targetKind) })}
												</a>
												{#if d.status === 'failed'}<span class="delivery-rowerr">{m.delivery_forward_ticket_exists()}</span>{/if}
											{:else if d.status === 'failed'}
												<!-- ⛔ THIS SPAN USED TO BE `{d.error ?? ''}` — `solution_deliveries.error`, an ENGLISH
												     SENTENCE authored in the adapter and persisted verbatim ("Azure DevOps request
												     timed out — verify in Azure DevOps before retrying"). Its two sibling branches on
												     this very block are localized, so the English sat inside otherwise-Dutch copy on the
												     demo screen. The typed failures carried a stable machine code the whole time; the
												     route now persists it (`response._cp_code` → `d.errorCode`) and the words are chosen
												     here.
												     ⚠️ `title=` DELIBERATELY KEEPS THE RAW SENTENCE. The visible text is the reader's;
												     the tooltip is the operator's, and the adapter's technical prose (a driver message, a
												     remote body fragment) is worth keeping one hover away. It is also what a row written
												     BEFORE the code existed still renders visibly — those rows are not migrated. -->
												<span class="delivery-rowerr" title={d.error ?? ''}>{deliveryErrorLabel(d)}</span>
											{/if}
											<button class="delivery-retry" disabled={retryingId === d.id} onclick={() => retryDelivery(d.id)}>
												{retryingId === d.id ? m.delivery_forward_retrying() : m.delivery_forward_retry()}
											</button>
										{/if}
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/if}

				<div class="card vote-card">
					<VoteButton variant="coral" size="md" count={data.votesCount} voted={data.hasVoted} busy={voteBusy} blockedReason={viewState ? solutionVoteBlockedReason(viewState) : null} onToggle={vote} />
					<!-- The on-screen half of the blocked state: `blockedReason` only reaches a tooltip, and a
					     disabled button is out of the tab order. It names the WEEK as what closed — "this
					     solution is closed" would be false (its own row still says `voting`), and "the
					     challenge behind this closed" is the retired rule, false in both directions. -->
					<p class="vote-note">{viewState ? solutionVoteNote(viewState) : ''}</p>
				</div>

				{#if data.comparison.length}
					<div class="card">
						<h3>{m.solution_detail_compare_title()}</h3>
						<div class="bars">
							{#each data.comparison as c (c.rank)}
								<svelte:element
									this={c.isThis ? 'div' : 'a'}
									class="bar-row"
									class:me={c.isThis}
									class:linked={!c.isThis}
									href={c.isThis ? undefined : `/solutions/${c.id}`}
								>
									<span class="bar-label">{c.isThis ? m.solution_detail_compare_this({ author: c.author }) : c.author}</span>
									<span class="bar-track"><span class="bar-fill" style="width:{c.pct}%"></span></span>
									<span class="bar-val">{num(c.votesCount, locale.current)}</span>
								</svelte:element>
							{/each}
						</div>
					</div>
				{/if}

				<div class="card">
					<h3>{m.solution_detail_wins_title()}</h3>
					<!-- ⛔ TWO FICTIONS REMOVED, AND WHY NEITHER WAS REPLACED WITH A NUMBER.
					     This card used to read "…the most votes ON THURSDAY 18:00 enters IT's production
					     pipeline. Average time from win → live: **17 days**." Nothing computed either one.
					     It is the same sentence #231 deleted from `solution_detail_vote_note_open` — one
					     card ABOVE this, where the vote button now correctly refuses to name a time.

					     THE CLOCK. A real voting deadline reaches these screens as `{time}`, computed
					     from the `marketplace_cycles` row by `solutionState`. There is no cycle row for
					     most weeks (`/api/cycle/current` answers null, which is what prod answers today),
					     which is precisely why a catalog-baked Thursday was wrong on every solution whose
					     week had already closed.

					     THE 17 DAYS. `/pipeline` really does compute this quantity — `avgTimeToLiveMs`,
					     backend/src/routes/pipeline.ts:210, averaged over cards with a `live_at`. It is
					     NOT served here, deliberately, for two independent reasons:
					       1. `GET /api/pipeline` is `requireSuperAdmin` (pipeline.ts:136). This page is
					          read by every employee, so wiring it up means a new public endpoint that
					          exposes a fleet-wide delivery statistic — a backend surface nobody asked for.
					       2. Even served truthfully it would be a PLATFORM-WIDE average rendered under a
					          heading the reader scopes to THIS solution, next to THIS solution's vote
					          count. That is the same scoping error with a true number in it, and the
					          number would be re-fabricated the moment the two disagreed.
					     So the card states what it can stand behind and stops. -->
					<p class="wins">{m.solution_detail_wins_body()}</p>
					<p class="wins muted">{m.solution_detail_wins_body_muted()}</p>
				</div>
			</aside>
		</div>
	{/if}
</div>

<style>
	.page {
		max-width: 1080px;
	}
	.back {
		display: inline-block;
		font-size: 13px;
		color: var(--c-muted);
		text-decoration: none;
		margin-bottom: 16px;
	}
	.back:hover {
		color: var(--c-coral-dark);
	}
	.detail-head {
		margin-bottom: 22px;
	}
	.badges {
		display: flex;
		gap: 8px;
		margin-bottom: 12px;
	}
	.badge {
		font-size: 11px;
		font-weight: 600;
		padding: 4px 11px;
		border-radius: 999px;
	}
	.badge.coral {
		background: var(--c-coral-light);
		color: var(--c-coral-dark);
	}
	.badge.teal {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.badge.outline {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		color: var(--c-muted);
		font-family: var(--font-mono);
	}
	/* Voting closed on the parent. Declared after `.coral` and matched on two classes so it wins:
	   colour is a claim like any other string on this page, and a coral "Voting closed" pill would
	   still read as live at a glance. */
	.badge.coral.muted {
		background: var(--c-surface);
		color: var(--c-muted);
	}
	h1 {
		font-family: var(--font-display);
		font-size: 30px;
		margin: 0 0 14px;
		color: var(--c-midnight);
	}
	.byline {
		display: flex;
		align-items: center;
		gap: 11px;
	}
	.who {
		font-weight: 600;
		font-size: 14px;
		color: var(--c-ink);
	}
	.byline .sub {
		font-size: 12.5px;
		color: var(--c-muted);
	}
	.layout {
		display: grid;
		grid-template-columns: 1fr 320px;
		gap: 22px;
		align-items: start;
	}
	.main {
		display: flex;
		flex-direction: column;
		gap: 18px;
		min-width: 0;
	}
	.side {
		display: flex;
		flex-direction: column;
		gap: 18px;
	}
	.card {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
		padding: 18px 20px;
	}
	.card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 14px;
	}
	h2 {
		font-family: var(--font-display);
		font-size: 18px;
		margin: 0 0 12px;
		color: var(--c-midnight);
	}
	h3 {
		font-size: 13px;
		font-weight: 600;
		margin: 0 0 12px;
		color: var(--c-ink);
	}
	.tryit-note {
		font-size: 13px;
		line-height: 1.55;
		color: var(--c-ink);
		margin: 0 0 14px;
	}
	.sandbox-status {
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--c-muted);
		margin: -4px 0 14px;
	}
	/* The failure arm carries the retry beside it. `display:flex` on the <p> rather than a new
	   wrapper element, so the three arms stay one paragraph in the document outline. */
	.sandbox-status.sandbox-failed {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--c-coral-dark);
	}
	.sandbox-retry {
		font-family: inherit;
		font-size: 11.5px;
		font-weight: 600;
		color: var(--c-teal-dark);
		text-decoration: underline;
	}
	.tryit-actions {
		display: flex;
		gap: 10px;
	}
	.btn-run {
		font-size: 13px;
		font-weight: 600;
		color: #fff;
		background: var(--c-teal);
		border: none;
		padding: 9px 16px;
		border-radius: var(--r);
		cursor: pointer;
	}
	.btn-run:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.run-error {
		color: var(--c-coral-dark);
		font-size: 12.5px;
		margin: 12px 0 0;
	}
	/* ── the data-contract findings ──────────────────────────────────────────────────────────────
	   Same tokens, same class names and same structure as build/+page.svelte's pill. This card is
	   not inside a clipped, absolutely-positioned stack the way /build's is, so the height cap here
	   is about not burying the run console under a 250-item list rather than about a hard clip —
	   but the reader-facing behaviour has to be identical on both screens, so the markup is. */
	.run-issues {
		margin: 6px 0 0;
		padding-inline-start: 18px;
		font-size: 12.5px;
		line-height: 1.5;
		text-align: start;
	}
	.findings-list {
		max-height: 30vh;
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	/* Amber, deliberately NOT `.run-error`'s coral — under the shipped `warn` policy the run
	   STARTED and will go green; an error tone would be a lie and the reader would learn to ignore
	   it. What is wrong is the data going into the viewer's own sandbox. */
	.data-warn {
		color: #92400e;
		background: var(--c-amber-light);
		border: 1px solid var(--c-amber);
		border-radius: var(--r);
		padding: 8px 14px;
		margin: 12px 0 0;
		font-size: 13px;
		text-align: start;
	}
	.findings-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}
	.findings-title {
		font-weight: 600;
		margin-top: 8px;
	}
	.findings-head .findings-title {
		margin-top: 0;
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
	/* `dataset.column → attribute` — an identifier, not prose. Monospace so an underscore in a
	   column name is readable, and `unicode-bidi: isolate` so an ASCII identifier is not torn apart
	   by the surrounding RTL sentence under ar/he. */
	.finding-ref {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-weight: 600;
		margin-inline-end: 6px;
		unicode-bidi: isolate;
	}
	.run-wrap {
		margin-top: 14px;
		height: 240px;
		display: grid;
		border-radius: var(--r);
		overflow: hidden;
	}
	.flow-cap {
		font-size: 12.5px;
		color: var(--c-muted);
		margin: 14px 0 0;
	}
	.use-start {
		margin-top: 10px;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--c-teal-dark);
		background: var(--c-white);
		border: 1px solid var(--c-teal-light);
		border-radius: var(--r);
		padding: 7px 14px;
		cursor: pointer;
	}
	.use-start:hover:not(:disabled) {
		background: var(--c-teal-pale);
	}
	.use-start:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
	.use-start-error {
		font-size: 12px;
		color: var(--c-coral-dark);
		margin: 6px 0 0;
	}
	.open-build {
		color: var(--c-coral-dark);
		font-weight: 600;
		text-decoration: none;
	}
	.mono-inline {
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--c-ink);
	}
	.delivery-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.delivery-intro {
		font-size: 12px;
		line-height: 1.5;
		color: var(--c-muted);
		margin: 0;
	}
	.delivery-none {
		font-size: 12.5px;
		color: var(--c-muted);
		margin: 0;
	}
	.delivery-field {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}
	.delivery-label {
		font-size: 11px;
		font-weight: 600;
		color: var(--c-ink);
	}
	.delivery-field select {
		font-size: 13px;
		padding: 8px 10px;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		background: var(--c-white);
		color: var(--c-ink);
	}
	.btn-forward {
		font-size: 13px;
		font-weight: 600;
		color: #fff;
		background: var(--c-coral);
		border: none;
		padding: 9px 16px;
		border-radius: var(--r);
		cursor: pointer;
	}
	.btn-forward:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.delivery-hint {
		font-size: 11.5px;
		color: var(--c-muted);
		margin: 0;
	}
	.delivery-error {
		font-size: 12px;
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		border-radius: var(--r);
		padding: 7px 9px;
		margin: 0;
	}
	.delivery-history {
		display: flex;
		flex-direction: column;
		gap: 7px;
		border-top: 1px solid var(--c-border);
		padding-top: 10px;
	}
	.delivery-history-head {
		font-size: 11px;
		font-weight: 600;
		color: var(--c-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.delivery-row {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 12px;
		min-width: 0;
	}
	.delivery-chip {
		font-size: 10.5px;
		font-weight: 600;
		padding: 3px 8px;
		border-radius: 999px;
		background: var(--c-surface);
		color: var(--c-muted);
		white-space: nowrap;
	}
	/* ⚠️ `approved` RIDES WITH THE SUCCESS PALETTE BUT KEEPS ITS OWN CLASS, and `rejected` likewise
	   beside `failed`. Folding them into the existing selectors as `class:failed={... || rejected}`
	   was the shorter edit and it makes the class name lie: a rejected delivery is a HUMAN DECISION,
	   not an error, and the row deliberately renders no error sentence and no "ticket exists" note
	   for it. Two extra selectors cost nothing and keep the DOM honest about which of the eight
	   statuses a chip is — which is also what makes the render test able to tell them apart. */
	.delivery-chip.created,
	.delivery-chip.approved,
	.delivery-chip.promoted {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.delivery-chip.draft {
		background: var(--c-amber-light, var(--c-surface));
		color: var(--c-amber-dark, var(--c-ink));
	}
	.delivery-chip.failed,
	.delivery-chip.rejected {
		background: var(--c-coral-light);
		color: var(--c-coral-dark);
	}
	.delivery-chip.pending {
		background: var(--c-surface);
		color: var(--c-ink);
	}
	.delivery-link {
		font-weight: 600;
		color: var(--c-coral-dark);
		text-decoration: none;
		font-family: var(--font-mono);
	}
	.delivery-link:hover {
		text-decoration: underline;
	}
	.delivery-rowerr {
		color: var(--c-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
	}
	.delivery-retry {
		font-size: 11px;
		font-weight: 600;
		color: var(--c-coral-dark);
		background: none;
		border: 1px solid var(--c-coral-light);
		padding: 3px 9px;
		border-radius: var(--r);
		cursor: pointer;
		white-space: nowrap;
	}
	.delivery-retry:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.vote-card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
	}
	.vote-note {
		font-size: 12px;
		color: var(--c-muted);
		margin: 0;
	}
	.bars {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.bar-row {
		display: grid;
		grid-template-columns: 1fr 90px auto;
		align-items: center;
		gap: 8px;
		font-size: 12px;
	}
	a.bar-row {
		text-decoration: none;
		border-radius: var(--r);
		margin: 0 -8px;
		padding: 4px 8px;
		transition: background 0.12s ease;
	}
	a.bar-row:hover {
		background: var(--c-surface);
	}
	a.bar-row:hover .bar-label {
		color: var(--c-coral-dark);
	}
	.bar-label {
		color: var(--c-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.bar-row.me .bar-label {
		color: var(--c-coral-dark);
		font-weight: 600;
	}
	.bar-track {
		height: 7px;
		background: var(--c-surface);
		border-radius: 999px;
		overflow: hidden;
	}
	.bar-fill {
		display: block;
		height: 100%;
		background: var(--c-coral-mid);
		border-radius: 999px;
	}
	.bar-val {
		font-variant-numeric: tabular-nums;
		color: var(--c-ink);
		font-weight: 600;
	}
	.wins {
		font-size: 12.5px;
		line-height: 1.55;
		color: var(--c-ink);
		margin: 0 0 8px;
	}
	.wins.muted {
		color: var(--c-muted);
		margin-bottom: 0;
	}
	.empty {
		color: var(--c-muted);
		font-size: 13px;
	}
	.notice {
		padding: 28px;
		text-align: center;
		color: var(--c-muted);
		font-size: 13.5px;
		background: var(--c-surface);
		border: 1px solid var(--c-border);
		border-radius: var(--r-lg);
	}
	.notice.error {
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border-color: var(--c-coral-light);
	}
	/* The load-failure notice's retry control — see the button in the `{:else if error}` arm above.
	   Same tones as the profile-error row in +layout.svelte, which is where this shape comes from. */
	.notice.error .retry {
		margin-inline-start: 10px;
		border: 1px solid var(--c-coral-light);
		background: var(--c-white);
		color: var(--c-coral-dark);
		border-radius: var(--r);
		padding: 5px 12px;
		font-size: 12px;
		font-weight: 600;
		font-family: inherit;
		cursor: pointer;
	}
	@media (max-width: 820px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}
</style>
