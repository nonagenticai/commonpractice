<script lang="ts">
	// Challenge detail (demo `challenge-detail`). Frustration + business-impact metrics
	// + the challenge's solutions + side vote/lifecycle/similar + the live discussion.
	import { reloadOnLocaleChange } from '$lib/i18n/reload-on-locale.svelte';
	import { page } from '$app/state';
	import { challengesApi, ApiError } from '$lib/api/challenges';
	import { cycleApi } from '$lib/api/cycle';
	import { datasetsApi, type AllDatasets } from '$lib/api/datasets';
	import type { ChallengeDetail, ChallengeInformation, CommentItem, InformationOption } from '$lib/types/challenges';
	import InformationPicker from '$lib/components/InformationPicker.svelte';
	import InformationRequests from '$lib/components/InformationRequests.svelte';
	import type { CycleState } from '$lib/types/cycle';
	import type { DatasetRow, DatasetColumn } from '$lib/types/datasets';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import MetricTile from '$lib/components/marketplace/MetricTile.svelte';
	import VoteButton from '$lib/components/marketplace/VoteButton.svelte';
	import CommentThread from '$lib/components/marketplace/CommentThread.svelte';
	import DatasetPicker from '$lib/components/DatasetPicker.svelte';
	import DatasetPreviewTable from '$lib/components/DatasetPreviewTable.svelte';
	import { timeAgo, num, durationText } from '$lib/utils/format';
	// `locale.current` is the APP's locale, not the browser's — see format.ts for the defect
	// and for why these helpers take it as an argument instead of importing this store.
	import { locale } from '$lib/stores/locale.svelte';
	import * as m from '$lib/paraglide/messages';
	import { workAreaLabel } from '$lib/i18n/work-area-label';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import {
		buildBlockedReason,
		challengeState,
		challengeStatusLabel,
		challengeVoteNote,
		challengeWeekLabel,
		voteBlockedReason
	} from '$lib/challenges/challenge-state';
	// A SIBLING of challenge-state, not an extension of it — see that module's header. `challengeState`
	// answers "may this reader's vote land"; the timeline asks how far along the challenge is, off a
	// field (`solutions[]`) `challengeState` never sees.
	import {
		challengeLifecycle,
		hasShippingSolution,
		lifecycleStepClass,
		lifecycleStateLabel,
		lifecycleWinnerSubLabel,
		lifecycleShowsWinnerStep
	} from '$lib/challenges/challenge-lifecycle';
	import { auth } from '$lib/stores/auth.svelte';
	import { cycleOnFor } from '$lib/layout/cycle-nav';

	const id = $derived(page.params.id ?? '');

	// ⛔ HOW MANY CHALLENGES AGO WAS THIS REQUEST FIRED. Bumped by the route-param `$effect` at the
	// bottom of this block; every async handler captures it BEFORE its first `await` and refuses to
	// write when it comes back to a different challenge. Without it the reset below is only half a
	// fix: it clears A's state, and then A's still-in-flight `Promise.all`/vote/reply lands on top
	// of B's freshly loaded screen a tick later. `solutions/[id]` does NOT guard this — it resets
	// and re-fires but never invalidates, so its own late responses can still repaint the new
	// solution. A plain `let`, deliberately NOT `$state`: `navGen++` is a read as well as a write,
	// so a reactive counter would make the effect depend on itself and re-run forever.
	let navGen = 0;

	let data = $state<ChallengeDetail | null>(null);
	// The live weekly cycle, or null when the engine has not opened a row for the current ISO week —
	// which is what prod answers today, and the reason this page used to print "closes Thu 18:00"
	// over challenges whose week ended in April.
	let cycle = $state<CycleState | null>(null);
	let comments = $state<CommentItem[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let voteBusy = $state(false);
	// A REFUSED vote, kept separate from `error` (the load error). `error` renders inside an
	// `{:else if}` chain, so writing a vote failure there would blank the whole board on the list
	// pages and never render at all on the detail pages (guarded by `&& !data`). This one renders
	// above the content and leaves it in place.
	let voteError = $state<string | null>(null);
	// A failed non-vote ACTION (saving the applicable datasets, posting a reply), kept separate from
	// BOTH neighbours. Not `error`: that one is the LOAD error, and its render site is guarded by
	// `&& !data` — so on a loaded page a save failure was assigned and then never rendered at all,
	// which reads as a dead button. Not `voteError` either: `vote()` clears that on every click, so
	// an unrelated vote would silently erase a save failure the user has not read yet. Different
	// lifetimes, different state. After this, `error` is written ONLY by `load()`, which is what
	// makes the `&& !data` guard coherent.
	let actionError = $state<string | null>(null);
	let postBusy = $state(false);

	// Phase 3.0/3.1: the challenge's applicable datasets — read-only with per-dataset
	// preview toggle for everyone; an edit mode (DatasetPicker + notes) for the creator
	// or platform. Previews + edit-options are lazy-loaded.
	let previews = $state<Record<string, { columns: DatasetColumn[]; rows: Record<string, unknown>[]; maskedColumns?: string[] }>>({});
	let openPreviews = $state<Set<string>>(new Set());
	let editingData = $state(false);
	let availableDatasets = $state<DatasetRow[]>([]);
	/** The server's real dataset total, and whether the walk had to stop short of it. */
	let datasetsTotal = $state(0);
	let datasetsCapped = $state(false);
	let editSlugs = $state<string[]>([]);
	let editNotes = $state<Record<string, string>>({});
	let savingData = $state(false);

	// W8/P1 "Information involved": the types of information this challenge is about, as plain cards.
	// Loaded beside the page, NOT inside `load()`'s `Promise.all`: it is a secondary card, and its
	// failure must say so in the card instead of replacing the whole page with the load error.
	let info = $state<ChallengeInformation | null>(null);
	let infoError = $state<string | null>(null);
	async function loadInformation() {
		const gen = navGen;
		try {
			const r = await challengesApi.entities(id);
			if (gen !== navGen) return;
			info = r;
			infoError = null;
		} catch (e) {
			if (gen !== navGen) return;
			info = null;
			infoError = errorText(e, m.challenge_info_load_failed());
		}
	}

	// W8/P2: edit the challenge's DIRECT information links (creator or platform — `info.canEdit`).
	// Only the directly linked ones are editable; those reached through the sample data stay shown.
	let editingInfo = $state(false);
	let infoOptions = $state<InformationOption[]>([]);
	let infoEditIds = $state<string[]>([]);
	let savingInfo = $state(false);
	async function startEditInfo() {
		if (!data || !info) return;
		const gen = navGen;
		actionError = null;
		let options: InformationOption[];
		try {
			options = (await challengesApi.entityOptions(data.workArea)).items;
		} catch (e) {
			if (gen !== navGen) return;
			// Stay out of edit mode: a picker with nothing to offer can only remove links.
			actionError = errorText(e, m.challenge_info_options_failed());
			return;
		}
		if (gen !== navGen || !info) return;
		infoOptions = options;
		infoEditIds = info.items.filter((i) => i.linked).map((i) => i.id);
		editingInfo = true;
	}
	async function saveInfo() {
		if (savingInfo) return;
		const gen = navGen;
		actionError = null;
		savingInfo = true;
		try {
			const r = await challengesApi.updateEntities(id, infoEditIds);
			if (gen !== navGen) return;
			info = r;
			editingInfo = false;
		} catch (e) {
			if (gen !== navGen) return;
			actionError = writeErrorText(e, m.error_save_failed());
		} finally {
			if (gen === navGen) savingInfo = false;
		}
	}

	// Per-slug preview failures. ⛔ NOT a shared string: the previews are independent requests behind
	// independent toggles, and one dataset's 500 must not caption another dataset's rows.
	let previewErrors = $state<Record<string, string>>({});

	/** Returns whether the preview is now in hand. */
	async function loadPreview(slug: string): Promise<boolean> {
		if (previews[slug]) return true;
		const gen = navGen;
		try {
			const d = await datasetsApi.get(slug, { limit: 5 });
			// ⚠️ THE CACHE IS KEPT ACROSS A NAVIGATION ON PURPOSE, and it is the ONLY thing that is.
			// `previews` is keyed by dataset SLUG and holds `GET /api/datasets/:slug` — a fact about
			// the dataset, identical on whichever challenge links it. `previewErrors` below is not:
			// it is a caption on THIS challenge's row, so a late failure must not surface under the
			// next challenge's list.
			previews = { ...previews, [slug]: { columns: d.columns, rows: d.rows, maskedColumns: d.maskedColumns } };
			if (gen !== navGen) return false;
			const { [slug]: _gone, ...rest } = previewErrors;
			previewErrors = rest;
			return true;
		} catch (e) {
			if (gen !== navGen) return false;
			// ⛔ WAS `catch { /* no preview */ }`. The swallow was invisible on its own, but the toggle
			// below had ALREADY flipped this slug into `openPreviews` — so the button read "Hide"
			// (`build_data_hide`) over a row where nothing had ever been shown, and pressing it again
			// "hid" nothing and offered "Preview" once more. `errorText`, not `writeErrorText`: a GET.
			previewErrors = { ...previewErrors, [slug]: errorText(e, m.dataset_preview_load_failed()) };
			return false;
		}
	}
	async function togglePreview(slug: string) {
		const gen = navGen;
		const next = new Set(openPreviews);
		if (next.has(slug)) {
			next.delete(slug);
			openPreviews = next;
			return;
		}
		next.add(slug);
		openPreviews = next;
		// ⛔ AND IT COMES BACK OUT IF THE FETCH FAILED. A button that says "Hide" while the row holds
		// no table is the same lie one verb further on: there is nothing to hide. The failure is
		// reported by `previewErrors` instead, which renders whether or not the row is open.
		if (!(await loadPreview(slug))) {
			// The reader has moved on; `openPreviews` has already been emptied by the route effect and
			// this rollback would only re-derive it from the NEW challenge's list.
			if (gen !== navGen) return;
			const back = new Set(openPreviews);
			back.delete(slug);
			openPreviews = back;
		}
	}
	async function startEditData() {
		if (!data) return;
		const gen = navGen;
		actionError = null;
		editSlugs = data.datasets.map((d) => d.slug);
		editNotes = Object.fromEntries(data.datasets.map((d) => [d.slug, d.note]));
		let all: AllDatasets;
		try {
			// ⛔ ASSIGNED ONLY AFTER THE GENERATION CHECK BELOW. Opening the editor is a two-tick
			// operation, and the second tick must not re-open it — pre-filled with the PREVIOUS
			// challenge's slugs — over the challenge the reader has since navigated to.
			//
			// ⛔ AND IT IS `listAll`, NOT `list({ page: 1 })`. This route pages at twelve
			// (backend/src/routes/datasets.ts's `PAGE_SIZE`) and the old call took page 1 and dropped
			// `total`, so the editor could not offer the thirteenth dataset — and worse, DatasetPicker
			// renders exactly the rows it is handed, so an editor missing half the workspace looked
			// identical to a complete one. Saving from it does not unlink the datasets already attached
			// (`editSlugs` is seeded from `data.datasets`), so the damage was confined to what could be
			// ADDED — but that is the editor's whole purpose.
			all = await datasetsApi.listAll();
		} catch (e) {
			if (gen !== navGen) return;
			// ⛔ NOT `availableDatasets = []`. That swallowed the failure and then opened the editor,
			// where DatasetPicker renders its `emptyHint` — "Je hebt nog geen datasets." So a 500 on
			// GET /api/datasets was reported to the reader as a FACT ABOUT THEIR ACCOUNT, and the
			// obvious next move (go and make one) is wrong. Say the fetch failed, and stay out of edit
			// mode: an editor whose only source of options is unreachable can offer nothing but the
			// power to unlink what is already there.
			// `errorText`, not `writeErrorText`: this is a READ. `writeErrorText` prefers the backend's
			// own sentence on 400/422/409 — the codes a rejected WRITE produces — and a GET has none
			// of those to offer. A 403 here (`data_manager_required`) still resolves to its own copy.
			actionError = errorText(e, m.challenge_data_load_failed());
			return;
		}
		if (gen !== navGen) return;
		availableDatasets = all.items;
		datasetsTotal = all.total;
		datasetsCapped = all.capped;
		editingData = true;
	}
	async function saveData() {
		if (!data || savingData) return;
		const gen = navGen;
		actionError = null;
		savingData = true;
		try {
			await challengesApi.updateDatasets(id, editSlugs.map((slug) => ({ slug, note: editNotes[slug]?.trim() || undefined })));
			if (gen !== navGen) return;
			editingData = false;
			await load(); // refresh datasets + the §B6 involves chip
		} catch (e) {
			if (gen !== navGen) return;
			actionError = writeErrorText(e, m.error_save_failed());
		} finally {
			if (gen === navGen) savingData = false;
		}
	}

	// This challenge's temporal state, resolved against the live cycle. Every time claim on this
	// page now comes out of here — see the module header for the three static strings it replaces.
	const viewState = $derived(data ? challengeState(data, cycle) : null);
	const weekLabel = $derived(viewState ? challengeWeekLabel(viewState) : null);
	// The four timeline steps. `closed` is the dominant state on the live board and used to render its
	// last TWO steps in the grey that means "never happened" — the fourth `<li>` carried no class at
	// all. Both facts it needs are on the wire; nothing here invents a phase history.
	const lifecycle = $derived(
		data ? challengeLifecycle(data.status, hasShippingSolution(data.solutions)) : null
	);

	async function load() {
		const gen = navGen;
		loading = true;
		error = null;
		try {
			// The cycle is decoration: `.catch(() => null)` keeps a cycle outage out of `error`, whose
			// render site (`{:else if error && !data}`) is mutually exclusive with the whole detail
			// view. A null cycle simply drops the countdown, which is the correct degraded state.
			const [d, c, cyc] = await Promise.all([
				challengesApi.get(id),
				challengesApi.comments(id),
				cycleApi.current().catch(() => null)
			]);
			// ⛔ THE STALE-RESPONSE GUARD. This `Promise.all` was fired for the challenge that was on
			// screen when `load()` started. If the reader has moved since, THAT page's payload must
			// not repaint this one — and it would, because `data = d` cannot see the address bar.
			// `loading` is left alone in the stale branch as well: the newer `load()` owns it.
			if (gen !== navGen) return;
			data = d;
			comments = c.items;
			cycle = cyc;
			void loadInformation();
		} catch (e) {
			if (gen !== navGen) return;
			error = errorText(e, m.error_load_failed());
		} finally {
			if (gen === navGen) loading = false;
		}
	}

	async function vote() {
		if (!data || voteBusy) return;
		const gen = navGen;
		voteBusy = true;
		voteError = null;
		const next = !data.hasVoted;
		const wasVoted = data.hasVoted;
		const wasCount = data.votesCount;
		data = { ...data, hasVoted: next, votesCount: data.votesCount + (next ? 1 : -1) };
		try {
			const res = next ? await challengesApi.vote(id) : await challengesApi.unvote(id);
			// `if (data)` is not enough on its own: after a navigation `data` is TRUTHY AGAIN — it is
			// the NEXT challenge — so the server's count for the challenge just left would be written
			// straight onto the one now on screen.
			if (gen !== navGen) return;
			if (data) data = { ...data, hasVoted: res.voted, votesCount: res.count };
		} catch (e) {
			if (gen !== navGen) return;
			// ⛔ REVERT FIRST, RECONCILE SECOND — see the long note on `vote()` in
			// routes/challenges/+page.svelte. `load()`'s own catch writes only `error`, so the
			// phantom count survived exactly the outage that fails both calls.
			//
			// ⚠️ INSIDE THE `gen !== navGen` GUARD, AND FOR THE REASON THE SUCCESS PATH STATES ONE
			// BRANCH UP: after a navigation `data` is TRUTHY AGAIN — it is the NEXT challenge — so a
			// revert written here unguarded would subtract a vote that was never cast from a
			// DIFFERENT challenge's count. A reader who navigated away has nothing left to revert.
			if (data) data = { ...data, hasVoted: wasVoted, votesCount: wasCount };
			// See challenges/+page.svelte: a silently-reverted vote reads as a dead button, and the
			// page's `error` state is the LOAD error — reusing it blanks the content.
			voteError = errorText(e, m.error_action_failed());
			await load();
		} finally {
			if (gen === navGen) voteBusy = false;
		}
	}

	async function postReply(body: string): Promise<boolean> {
		const gen = navGen;
		actionError = null;
		postBusy = true;
		try {
			const created = await challengesApi.postComment(id, body);
			// The reply DID land — on the challenge the reader wrote it under. It just has no thread
			// to be appended to any more, and appending it here would file it under a stranger's
			// discussion and bump that challenge's comment count. `true` is still the honest answer;
			// the CommentThread that asked was destroyed with the challenge it belonged to.
			if (gen !== navGen) return true;
			comments = [...comments, created];
			if (data) data = { ...data, commentCount: data.commentCount + 1 };
			return true;
		} catch (e) {
			if (gen !== navGen) return false;
			actionError = writeErrorText(e, m.error_action_failed());
			return false;
		} finally {
			if (gen === navGen) postBusy = false;
		}
	}

	// ⛔ THE ROUTE PARAM MOVES WITHOUT A REMOUNT. SvelteKit reuses this component across
	// /challenges/A → /challenges/B — which is one click on any row of the "Vergelijkbare
	// uitdagingen" card in the sidebar below — so `onMount(load)` ran EXACTLY ONCE. `id` is
	// `$derived(page.params.id)` and moved to B; `data`, `comments`, the vote pill, the thread and
	// the dataset editor all stayed A's. Every write on this page then addressed B off A's screen:
	// `vote()` POSTed to B while incrementing A's counter, `postReply()` filed A's reply under B,
	// and `saveData()` PATCHed B with A's dataset slugs — a destructive overwrite, since that PATCH
	// REPLACES the link set. Same defect, same fix, as routes/solutions/[id]/+page.svelte:306-328.
	//
	// ⛔ WRITES ONLY, NO READS. The single tracked dependency is `id`. Reading `data` (or `comments`,
	// or `editSlugs`) here and then writing it would make the effect its own trigger and loop; the
	// resets below are all plain assignments, and `navGen++` is on a non-reactive `let` for exactly
	// that reason.
	//
	// WHAT IS RESET, and it is everything scoped to ONE challenge: the payload (`data`) and its
	// thread (`comments`), the load error, both write-error banners (`voteError` — which the
	// `solutions` page still leaks — and `actionError`), both in-flight flags (`voteBusy`,
	// `postBusy`), the dataset-preview display state (`openPreviews`, `previewErrors`) and the whole
	// dataset editor (`editingData`, `availableDatasets`, `editSlugs`, `editNotes`, `savingData`).
	// The reply DRAFT needs no line here: it is `CommentThread`'s own `$state`, and `data = null`
	// unmounts that component, so B gets a fresh box rather than A's half-written sentence.
	//
	// WHAT IS DELIBERATELY NOT RESET: `cycle` (the ONE live weekly cycle row — not a property of any
	// challenge, and `load()` refetches it regardless; blanking it would drop the countdown for a
	// frame for no reason), `loading` (owned by `load()`, which sets it on its first line), and
	// `previews` (a slug-keyed cache of dataset CONTENT — see `loadPreview`).
	$effect(() => {
		void id; // track the route param — the ONLY dependency this effect may have
		navGen++; // and invalidate every request still in flight for the previous challenge
		data = null;
		comments = [];
		error = null;
		voteBusy = false;
		voteError = null;
		actionError = null;
		postBusy = false;
		openPreviews = new Set();
		previewErrors = {};
		info = null;
		infoError = null;
		editingInfo = false;
		infoOptions = [];
		infoEditIds = [];
		savingInfo = false;
		editingData = false;
		availableDatasets = [];
		editSlugs = [];
		editNotes = {};
		savingData = false;
		void load();
	});
	reloadOnLocaleChange(load);
</script>

<div class="page">
	<a class="back" href="/challenges">{m.challenge_detail_back()}</a>

	{#if voteError}
		<div class="notice error">{voteError}</div>
	{/if}

	{#if actionError}
		<div class="notice error">{actionError}</div>
	{/if}

	{#if loading && !data}
		<div class="notice">{m.challenge_detail_loading()}</div>
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
	{:else if data && viewState && lifecycle}
		<header class="detail-head">
			<div class="badges">
				<!-- ⛔ ONLY `closed` IS MUTED — see LeaderboardRow for the full reasoning. A past week
				     no longer means dead: the vote control is live on these rows, so muting the pill
				     would have the colour contradict the button sitting next to it. -->
				<span class="badge {viewState.kind === 'closed' ? 'muted' : 'teal'}">{challengeStatusLabel(viewState)}</span>
				<!-- The week the challenge belongs to — on the wire since routes/challenges.ts:481,
				     typed since types/challenges.ts:85, and rendered by neither challenge screen until
				     now. It is what dates "closes Thu 18:00" as the fiction it was. -->
				{#if weekLabel}<span class="badge outline">{weekLabel}</span>{/if}
				{#if data.code}<span class="badge outline">#{data.code}</span>{/if}
				<!-- ⛔ TWO DIFFERENT THINGS, DELIBERATELY NOT THE SAME EXPRESSION. The `href` carries the
				     RAW enum because /challenges matches it with `DOMAINS.some((d) => d.v === wa)` and
				     keys `list.counts[…]` off the same literals — a localized query param deep-links to
				     a chip that does not exist. The TEXT is the reader's word. -->
				{#if data.workArea}<a class="badge work-area-link" href="/challenges?work_area={encodeURIComponent(data.workArea)}">{workAreaLabel(data.workArea)}</a>{/if}
			</div>
			<h1>{data.title}</h1>
			<div class="byline">
				<Avatar initials={data.submitter.initials} size={34} />
				<div>
					<div class="who">{data.submitter.name}</div>
					<!-- "Sales · geplaatst 3d geleden" — the only English word in an otherwise Dutch
					     sentence, because the placeholder was fed the enum. -->
					<div class="sub">{m.challenge_detail_posted({ workArea: workAreaLabel(data.workArea), ago: timeAgo(data.createdAt) })}</div>
				</div>
			</div>
		</header>

		<div class="layout">
			<div class="main">
				<div class="card">
					<h2>{m.challenge_detail_frustration()}</h2>
					<p class="prose">{data.description}</p>

					{#if data.metrics.timeSavedPerWeek || data.metrics.affectedStaff || data.metrics.backlogReduction}
						<h2>{m.challenge_detail_business_impact()}</h2>
						<div class="metrics">
							{#if data.metrics.timeSavedPerWeek}<MetricTile label={m.challenge_detail_metric_time_saved()} value={durationText(data.metrics.timeSavedPerWeek, locale.current)} sub={m.challenge_detail_metric_time_saved_sub()} />{/if}
							<!-- The sub-label under "Getroffen medewerkers" names the department the number is
							     about — a word, not the routing value. -->
							{#if data.metrics.affectedStaff}<MetricTile label={m.challenge_detail_metric_affected_staff()} value={data.metrics.affectedStaff} sub={workAreaLabel(data.workArea)} />{/if}
							{#if data.metrics.backlogReduction}<MetricTile label={m.challenge_detail_metric_backlog()} value={data.metrics.backlogReduction} sub={m.challenge_detail_metric_backlog_sub()} />{/if}
						</div>
					{/if}
					{#if data.businessImpact}<p class="prose muted">{data.businessImpact}</p>{/if}
				</div>

				<!-- W8/P1 "Information involved". Shown when there is something to show, or when the reader
				     can link something (so the creator sees where to start); nobody else gets an empty card.
				     It replaces the header's "This challenge involves" chips, which read the same source. -->
				{#if infoError}
					<div class="card">
						<h2>{m.challenge_info_title()}</h2>
						<p class="ds-preview-error" role="alert">{infoError}</p>
					</div>
				{:else if info && (info.items.length || info.canEdit)}
					<div class="card" data-testid="information-card">
						<div class="card-head">
							<h2>{m.challenge_info_title()}</h2>
							{#if info.canEdit && !editingInfo}
								<button class="more" onclick={startEditInfo} data-testid="information-edit">{m.challenge_data_edit()}</button>
							{/if}
						</div>
						{#if editingInfo}
							<div class="hint">{m.challenge_info_help()}</div>
							<InformationPicker options={infoOptions} selected={infoEditIds} known={info.items} onchange={(ids) => (infoEditIds = ids)} />
							<div class="data-actions">
								<button class="btn-ghost" onclick={() => (editingInfo = false)}>{m.challenge_data_cancel()}</button>
								<button class="btn-primary sm" onclick={saveInfo} disabled={savingInfo} data-testid="information-save">{savingInfo ? m.challenge_data_saving() : m.challenge_info_save()}</button>
							</div>
						{:else if info.items.length === 0}
							<p class="empty">{m.challenge_info_none()}</p>
						{:else}
							<ul class="info-list">
								{#each info.items as it (it.id)}
									<li class="info-item">
										<span class="info-name">{it.label}</span>
										{#if it.description}<p class="info-desc">{it.description}</p>{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}

				<!-- W8/P5: ask for missing information or add example records; an admin reviews them. -->
				{#key data.id}<InformationRequests challengeId={data.id} />{/key}

				{#if data.datasets.length || data.canEditDatasets}
					<div class="card">
						<div class="card-head">
							<h2>{m.challenge_data_title()}</h2>
							{#if data.canEditDatasets && !editingData}
								<button class="more" onclick={startEditData}>{m.challenge_data_edit()}</button>
							{/if}
						</div>

						{#if editingData}
							<div class="hint">{m.challenge_data_help()}</div>
							<DatasetPicker
								datasets={availableDatasets}
								selected={editSlugs}
								multiple
								emptyHint={m.challenge_data_empty()}
								onchange={(slugs) => (editSlugs = slugs)}
							/>
							<!-- The walk hit its ceiling, so the editor really is offering fewer datasets than
							     the workspace holds. Say so and point at the screen that lists them all — a
							     picker that is short and silent is the defect this change exists to remove. -->
							{#if datasetsCapped}
								<p class="ds-capped" role="status" data-testid="datasets-capped">
									{m.datasets_picker_capped({
										shown: num(availableDatasets.length, locale.current),
										total: num(datasetsTotal, locale.current)
									})}
									<a href="/datasets">{m.nav_datasets()}</a>
								</p>
							{/if}
							{#each editSlugs as slug (slug)}
								<input
									class="ds-note"
									value={editNotes[slug] ?? ''}
									placeholder={m.challenge_data_note_placeholder()}
									oninput={(e) => (editNotes = { ...editNotes, [slug]: e.currentTarget.value })}
								/>
							{/each}
							<div class="data-actions">
								<button class="btn-ghost" onclick={() => (editingData = false)}>{m.challenge_data_cancel()}</button>
								<button class="btn-primary sm" onclick={saveData} disabled={savingData}>{savingData ? m.challenge_data_saving() : m.challenge_data_save()}</button>
							</div>
						{:else if data.datasets.length === 0}
							<p class="empty">{m.challenge_data_none()}</p>
						{:else}
							<ul class="ds-list">
								{#each data.datasets as ds (ds.slug)}
									<!-- `data-slug`: the row's identity for tests, now that the slug is no longer shown. -->
									<li data-slug={ds.slug}>
										<div class="ds-row">
											<span class="ds-name">{ds.name}</span>
											<!-- No slug: an internal identifier means nothing to the reader (W8/P1). -->
											<span class="ds-meta">{num(ds.rowCount, locale.current)} {m.connectors_rows_word()}</span>
											<button class="ds-toggle" onclick={() => togglePreview(ds.slug)}>{openPreviews.has(ds.slug) ? m.build_data_hide() : m.build_data_preview()}</button>
										</div>
										{#if ds.note}<p class="ds-note-text">{ds.note}</p>{/if}
										<!-- Outside the `openPreviews` test on purpose: a failed fetch takes the slug
										     back OUT of that set (so the button stops claiming "Hide"), and a message
										     that rendered only while open would leave the press looking like a dead
										     control. -->
										{#if previewErrors[ds.slug]}
											<p class="ds-preview-error" role="alert" data-testid={`preview-error-${ds.slug}`}>{previewErrors[ds.slug]}</p>
										{/if}
										{#if openPreviews.has(ds.slug) && previews[ds.slug]}
											<!-- ⛔ `totalRows` — the same dead `5 > 5` notice as the other three inline previews.
											     `ds` is a `ChallengeDatasetRef`, whose `rowCount` the `.ds-meta` line above already
											     renders; and because a row count is a fact about the DATASET rather than about this
											     challenge's link to it, it stays correct under the deliberately navigation-spanning
											     `previews` cache. -->
											<DatasetPreviewTable columns={previews[ds.slug].columns} rows={previews[ds.slug].rows} maxRows={5} totalRows={ds.rowCount} maskedColumns={previews[ds.slug].maskedColumns} />
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}

				<div class="card">
					<!-- ⛔ `viewState.submittable`, NOT `data.status !== 'closed'`. That comparison is what
					     put a live "Build a solution" link in the same viewport as a "Voting week
					     finished" badge and a "…week 21 of 2026, which is already finished" note: the
					     `status` column is not maintained on stale rows, so a challenge dead since May
					     still read `voting` and the link 201'd, filing the work into the CURRENT week
					     under a May parent. Both CTA sites move together — a second gate that disagreed
					     would just move the dead link one paragraph down. -->
					<div class="card-head"><h2>{m.challenge_detail_solutions_title({ count: num(data.solutions.length, locale.current) })}</h2>{#if viewState.submittable}<div class="head-actions"><a class="build-cta" href={`/build?challenge=${data.id}`}>{m.challenge_detail_build_solution()}</a><a class="more" href={`/solutions?challenge_id=${data.id}`}>{m.challenge_detail_view_leaderboard()}</a></div>{/if}</div>
					<!-- The refusal, ONCE, for BOTH withdrawn CTAs — they sit in this one card, and two
					     copies of the same sentence a paragraph apart is the noise version of honesty.
					     It carries the way OUT as well (the BuildTopbar.svelte:206-212 pattern): the
					     board is now live-by-default, so this link lands on the challenges that ARE
					     accepting work rather than on the same dead end. -->
					{#if !viewState.submittable}
						<p class="empty build-blocked">{buildBlockedReason(viewState)} <a href="/challenges">{m.challenge_build_blocked_cta()}</a></p>
					{/if}
					{#if data.solutions.length === 0}
						<p class="empty">{m.challenge_detail_solutions_empty()} {#if viewState.submittable}<a href={`/build?challenge=${data.id}`}>{m.challenge_detail_solutions_empty_link()}</a>{m.challenge_detail_solutions_empty_after()}{/if}</p>
					{:else}
						<ul class="sol-list">
							{#each data.solutions as s (s.id)}
								<li>
									<span class="sol-rank">#{s.rank}</span>
									<a class="sol-title" href={`/solutions/${s.id}`}>{s.title}</a>
									<span class="sol-author">{s.author.name}</span>
									<span class="sol-votes">{num(s.votesCount, locale.current)} ▲</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>

				<div class="card">
					<h2>{m.challenge_detail_discussion({ count: data.commentCount })}</h2>
					<CommentThread items={comments} busy={postBusy} onPost={postReply} />
				</div>
			</div>

			<aside class="side">
				<div class="card vote-card">
					<VoteButton variant="teal" size="md" count={data.votesCount} voted={data.hasVoted} busy={voteBusy} blockedReason={voteBlockedReason(viewState)} onToggle={vote} />
					<!-- The note is the on-screen half of the blocked state: `blockedReason` only reaches
					     a tooltip, which a keyboard user never sees. It also carries the REAL voting
					     countdown when there is one — never a solution-phase boundary, see
					     `challengeVoteNote`. -->
					<p class="vote-note">{challengeVoteNote(viewState)}</p>
				</div>

				<div class="card">
					<h3>{m.challenge_detail_lifecycle()}</h3>
					<!-- `challenge_detail_lc_in_voting_sub` used to read "Tue → Thu 18:00" — a per-challenge
					     deadline nailed into the catalog, so a W23 challenge announced the same Thursday in
					     August that it did in June. It is now a description of what the step IS; the only
					     clock on this page is the countdown in the vote note, which comes off the cycle row. -->
					<!-- ⛔ FOUR LITERAL `<li>`, NEVER `{#each steps}`. Paraglide compiles one function per key
					     and tree-shakes on the IMPORT GRAPH (see challenge-state.ts:150-153): a steps array
					     holding `m.*` references either forces every label to be evaluated eagerly on each
					     render, or degrades into the dynamic `m[key]` lookup that resolves to nothing at
					     runtime. The repetition is the price of static keys.
					     Each step carries an sr-only STATE WORD as well as its dot: four states are drawn
					     with three colours plus a ring, and colour alone is not a message. -->
					<ul class="timeline">
						<li class={lifecycleStepClass(lifecycle.submitted)}><span class="dot"></span><div><b>{m.challenge_detail_lc_submitted()}</b><span>{m.challenge_detail_lc_submitted_by({ name: data.submitter.name })}</span><span class="sr-only">{lifecycleStateLabel(lifecycle.submitted)}</span></div></li>
						<li class={lifecycleStepClass(lifecycle.voting)}><span class="dot"></span><div><b>{m.challenge_detail_lc_in_voting()}</b><span>{m.challenge_detail_lc_in_voting_sub()}</span><span class="sr-only">{lifecycleStateLabel(lifecycle.voting)}</span></div></li>
						<li class={lifecycleStepClass(lifecycle.solutionPhase)}><span class="dot"></span><div><b>{m.challenge_detail_lc_solution_phase()}</b><span>{m.challenge_detail_lc_solution_phase_sub()}</span><span class="sr-only">{lifecycleStateLabel(lifecycle.solutionPhase)}</span></div></li>
						<!-- The step that had NO class in any state. Its sub-label is the one that changes with
						     the outcome — and it never says "won": `hasShippingSolution` means "reached
						     production", which is a different and weaker claim. See the module header. -->
						<!-- ⛔ CADENCE OFF: no period, no winner — "IT reviews and releases the winning solution"
						     would describe a step that cannot happen. The step stays only when a solution
						     actually reached production (`done`), which is a fact whatever the cadence. -->
						{#if lifecycleShowsWinnerStep(lifecycle.winner, cycleOnFor(auth.user?.cycleCadence))}
						<li class={lifecycleStepClass(lifecycle.winner)}><span class="dot"></span><div><b>{m.challenge_detail_lc_winner()}</b><span>{lifecycleWinnerSubLabel(lifecycle.winner)}</span><span class="sr-only">{lifecycleStateLabel(lifecycle.winner)}</span></div></li>
						{/if}
					</ul>
				</div>

				{#if data.similar.length}
					<div class="card">
						<h3>{m.challenge_detail_similar()}</h3>
						<ul class="similar">
							{#each data.similar as s (s.id)}
								<!-- "Vergelijkbare uitdagingen" reads the same enum off a DIFFERENT row shape
								     (`data.similar[]`); it needed the same treatment as the header badge. -->
								<li><a href={`/challenges/${s.id}`}>{s.title}</a><span>{workAreaLabel(s.workArea)} · {num(s.votesCount, locale.current)} ▲</span></li>
							{/each}
						</ul>
					</div>
				{/if}
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
		color: var(--c-teal-dark);
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
	.badge.teal {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	.badge.muted {
		background: var(--c-surface);
		color: var(--c-muted);
	}
	.badge.outline {
		background: var(--c-white);
		border: 1px solid var(--c-border);
		color: var(--c-muted);
		font-family: var(--font-mono);
	}
	.work-area-link {
		background: var(--c-surface);
		color: var(--c-ink);
		text-decoration: none;
		transition: background 0.12s ease, color 0.12s ease;
	}
	.work-area-link:hover {
		background: var(--c-teal-light);
		color: var(--c-teal-dark);
	}
	h1 {
		font-family: var(--font-display);
		font-size: 32px;
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
		align-items: baseline;
		justify-content: space-between;
	}
	h2 {
		font-family: var(--font-display);
		font-size: 18px;
		margin: 0 0 12px;
		color: var(--c-midnight);
	}
	h2:not(:first-child) {
		margin-top: 20px;
	}
	h3 {
		font-size: 13px;
		font-weight: 600;
		margin: 0 0 12px;
		color: var(--c-ink);
	}
	.prose {
		font-size: 14px;
		line-height: 1.65;
		color: var(--c-ink);
		margin: 0;
	}
	.prose.muted {
		color: var(--c-muted);
		font-size: 13px;
		margin-top: 12px;
	}
	.metrics {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 12px;
		margin-bottom: 4px;
	}
	.more {
		font-size: 12.5px;
		color: var(--c-teal-dark);
		text-decoration: none;
		font-weight: 500;
	}
	.sol-list,
	.similar,
	.timeline {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.sol-list li {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 0;
		border-bottom: 1px solid var(--c-border);
		font-size: 13.5px;
	}
	.sol-list li:last-child {
		border-bottom: none;
	}
	.sol-rank {
		font-family: var(--font-display);
		font-weight: 600;
		color: var(--c-coral-dark);
		width: 28px;
	}
	.sol-title {
		flex: 1;
		color: var(--c-ink);
		text-decoration: none;
		font-weight: 500;
	}
	.sol-title:hover {
		color: var(--c-coral-dark);
	}
	.sol-author {
		color: var(--c-muted);
		font-size: 12.5px;
	}
	.sol-votes {
		color: var(--c-coral-dark);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
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
	.timeline li {
		display: flex;
		gap: 10px;
		padding: 7px 0;
	}
	.timeline .dot {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		/* The base is the PENDING look, and `.pending` below restates it explicitly. Kept here so a
		   step whose class somehow fails to resolve degrades to "not yet" rather than to nothing. */
		background: var(--c-border-strong);
		margin-top: 4px;
		flex-shrink: 0;
		box-sizing: border-box;
	}
	.timeline li.done .dot,
	.timeline li.active .dot {
		background: var(--c-teal);
	}
	/* ⛔ `.pending` IS SPELLED OUT EVEN THOUGH IT MATCHES THE BASE. Before this, "no class" WAS the
	   pending state — which is exactly how the fourth step (`<li>` with no class at all, in every
	   status) came to be indistinguishable from a step still ahead of the challenge. An implicit
	   third state is not a state anyone maintains. */
	.timeline li.pending .dot {
		background: var(--c-border-strong);
	}
	/* ⛔ TERMINAL — "this step will not happen", and it must not look like EITHER neighbour. A hollow
	   ring (white fill, 2px strong border) is a different SHAPE, not just a different shade: it does
	   not read as teal-completed and it does not read as the solid grey of pending. `box-sizing` on
	   the base rule keeps the ring the same 9px as every other dot, so the column stays aligned. */
	.timeline li.terminal .dot {
		background: var(--c-white);
		border: 2px solid var(--c-border-strong);
	}
	.timeline li.terminal b {
		color: var(--c-muted);
	}
	.timeline li div {
		display: flex;
		flex-direction: column;
	}
	.timeline b {
		font-size: 13px;
		color: var(--c-ink);
	}
	.timeline span {
		font-size: 11.5px;
		color: var(--c-muted);
	}
	.timeline li.active b {
		color: var(--c-teal-dark);
	}
	/* Copied verbatim from layout/Topbar.svelte + ops/KanbanCard.svelte — the same clip-rect pattern
	   already used for the language-switch label and the reviewer list. Carries each step's state as
	   a WORD, because the state is otherwise dot colour only. */
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
	.similar li {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 8px 0;
		border-bottom: 1px solid var(--c-border);
	}
	.similar li:last-child {
		border-bottom: none;
	}
	.similar a {
		font-size: 13px;
		color: var(--c-ink);
		text-decoration: none;
		font-weight: 500;
	}
	.similar a:hover {
		color: var(--c-teal-dark);
	}
	.similar span {
		font-size: 11.5px;
		color: var(--c-muted);
	}
	.empty {
		color: var(--c-muted);
		font-size: 13px;
	}
	.empty a {
		color: var(--c-teal-dark);
	}
	/* ---- W8: "Information involved" cards; Phase 3.0/3.1: test-data card, build CTA ---- */
	.info-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 10px;
	}
	.info-item {
		border: 1px solid var(--c-teal-light);
		background: var(--c-teal-pale);
		border-radius: var(--r);
		padding: 10px 12px;
	}
	.info-name {
		font-size: 13.5px;
		font-weight: 600;
		color: var(--c-teal-dark);
	}
	.info-desc {
		font-size: 12.5px;
		color: var(--c-muted);
		margin: 4px 0 0;
		line-height: 1.5;
	}
	.head-actions {
		display: flex;
		gap: 12px;
		align-items: baseline;
	}
	.build-cta {
		font-size: 12.5px;
		font-weight: 600;
		color: #fff;
		background: var(--c-teal);
		padding: 5px 12px;
		border-radius: var(--r);
		text-decoration: none;
	}
	.ds-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.ds-list li {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.ds-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.ds-name {
		font-size: 13.5px;
		font-weight: 600;
		color: var(--c-ink);
	}
	.ds-meta {
		font-size: 11px;
		color: var(--c-faint);
	}
	.ds-toggle {
		margin-inline-start: auto;
		font-size: 12px;
		color: var(--c-teal-dark);
		font-weight: 500;
		background: none;
		border: none;
		cursor: pointer;
	}
	.ds-note-text {
		font-size: 12.5px;
		color: var(--c-muted);
		margin: 0;
		line-height: 1.5;
	}
	.ds-preview-error {
		font-size: 12px;
		color: var(--c-coral-dark);
		background: var(--c-coral-pale);
		border: 1px solid var(--c-coral-light);
		border-radius: var(--r);
		padding: 6px 9px;
		margin: 6px 0 0;
		line-height: 1.5;
	}
	/* The "this picker does not list all of them" disclosure. Muted, not coral: nothing has FAILED —
	   the editor is telling the reader the truth about its own completeness. Same tone as
	   `.ds-note-text` above, deliberately unlike the coral `.ds-preview-error`. */
	.ds-capped {
		font-size: 11.5px;
		color: var(--c-muted);
		margin: 8px 0 0;
		line-height: 1.5;
	}
	.ds-capped a {
		color: var(--c-teal-dark);
		margin-inline-start: 4px;
	}
	.ds-note {
		font-size: 12.5px;
		border: 1px solid var(--c-border);
		border-radius: var(--r);
		padding: 7px 10px;
		width: 100%;
		box-sizing: border-box;
		margin-top: 8px;
	}
	.data-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 12px;
	}
	.btn-ghost {
		font-size: 12.5px;
		color: var(--c-muted);
		background: none;
		border: none;
		cursor: pointer;
	}
	.btn-primary.sm {
		background: var(--c-teal);
		color: #fff;
		font-weight: 600;
		font-size: 12.5px;
		padding: 7px 14px;
		border-radius: var(--r);
		border: none;
		cursor: pointer;
	}
	.btn-primary.sm:disabled {
		opacity: 0.5;
		cursor: not-allowed;
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
		.metrics {
			grid-template-columns: 1fr;
		}
	}
</style>
