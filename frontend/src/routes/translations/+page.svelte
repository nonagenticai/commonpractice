<script lang="ts">
	// Translation pipeline (Phase 2-G) — the platform surface over the i18n content
	// pipeline. Per-locale coverage, a Backfill trigger (enqueue existing content), a
	// Run-now drain, and an inline human override of any failed/done translation.
	// Backend: /api/admin/translations/… — platform-gated server-side.
	// (`…` and not a `*` glob on purpose: translations-page.enum-labels.test.ts strips
	//  block comments before grepping this file, so a bare slash-star here silently swallows
	//  everything up to the first star-slash in the style block — every guard in that test then
	//  passes on an empty string. It did exactly that the moment this file got its first CSS
	//  comment.)
	import { onMount } from 'svelte';
	import { translationsApi, ApiError } from '$lib/api/translations';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import type { JobsResponse, TranslationJob } from '$lib/types/translation';
	import { timeAgo, num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import * as m from '$lib/paraglide/messages';
	import { statusLabelKey, entityLabelKey } from './labels';

	// key → message. `labels.ts` is pure and returns key NAMES; the mapping lives here, next to the
	// only place that renders them. An UNKNOWN value maps to no key and renders RAW: `status` and
	// `entity_type` are bare `text()` columns with no enum and no CHECK, so a value this frontend
	// does not know must show as itself rather than as an empty cell.
	const STATUS_MESSAGE = {
		tr_filter_pending: m.tr_filter_pending,
		tr_filter_done: m.tr_filter_done,
		tr_filter_failed: m.tr_filter_failed,
		tr_status_skipped: m.tr_status_skipped
	} as const;
	const ENTITY_MESSAGE = {
		tr_entity_challenge: m.tr_entity_challenge,
		tr_entity_solution: m.tr_entity_solution,
		tr_entity_block: m.tr_entity_block
	} as const;

	function statusLabel(status: string): string {
		const key = statusLabelKey(status);
		return key ? STATUS_MESSAGE[key]() : status;
	}
	function entityLabel(entityType: string): string {
		const key = entityLabelKey(entityType);
		return key ? ENTITY_MESSAGE[key]() : entityType;
	}

	let loading = $state(true);
	let denied = $state(false);
	let loadError = $state<string | null>(null);
	let data = $state<JobsResponse | null>(null);
	let filter = $state<'' | 'pending' | 'done' | 'failed'>('');
	let busy = $state(false);
	let banner = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);

	// inline override editor: jobId → draft value
	let editing = $state<string | null>(null);
	let draft = $state('');

	const locales = $derived(data ? Object.keys(data.stats.byLocale).sort() : []);

	async function load() {
		loading = true;
		denied = false;
		loadError = null;
		try {
			data = await translationsApi.jobs(filter ? { status: filter } : {});
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else loadError = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function backfill() {
		if (busy) return;
		busy = true;
		banner = null;
		try {
			const { queued } = await translationsApi.queue({});
			banner = { kind: 'ok', text: m.tr_queued({ count: num(queued, locale.current) }) };
			await load();
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_action_failed()) };
		} finally {
			busy = false;
		}
	}

	async function run() {
		if (busy) return;
		busy = true;
		banner = null;
		try {
			const r = await translationsApi.run();
			banner = {
				kind: 'ok',
				text: m.tr_ran({
					processed: num(r.processed, locale.current),
					failed: num(r.failed, locale.current),
					deferred: num(r.deferred, locale.current)
				})
			};
			await load();
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_action_failed()) };
		} finally {
			busy = false;
		}
	}

	// ⛔ THE DRAFT STARTS AS THE EXISTING TRANSLATION, NOT AS ''. This used to be an unconditional
	// `draft = ''`, which made the editor a data-loss trap: the box opened empty next to the
	// ENGLISH source (the job row carries `source_text`, never the translation), so on a screen
	// where every job is `done` an operator saw "nothing here" and typed a replacement over a
	// perfectly good translation they were never shown. `current_value` comes from the jobs
	// route's LEFT JOIN on content_translations; `null` genuinely means nothing is stored yet,
	// and only then is an empty box the truth.
	function startEdit(j: TranslationJob) {
		editing = j.id;
		draft = j.current_value ?? '';
	}

	async function saveOverride(j: TranslationJob) {
		if (!draft.trim() || busy) return;
		busy = true;
		banner = null;
		try {
			await translationsApi.override(j.id, draft.trim());
			banner = { kind: 'ok', text: m.tr_override_saved() };
			editing = null;
			await load();
		} catch (e) {
			banner = { kind: 'error', text: writeErrorText(e, m.error_action_failed()) };
		} finally {
			busy = false;
		}
	}

	function setFilter(f: typeof filter) {
		filter = f;
		void load();
	}

	// Client-side sort of the jobs table (full list for the active status filter).
	type JobSort = 'entity' | 'field' | 'locale' | 'status' | 'attempts';
	let jobSortKey = $state<JobSort>('status');
	let jobSortDir = $state<'asc' | 'desc'>('asc');
	const sortedJobs = $derived.by(() => {
		const rows = [...(data?.jobs ?? [])];
		const dir = jobSortDir === 'asc' ? 1 : -1;
		return rows.sort((a, b) => {
			let c = 0;
			if (jobSortKey === 'entity') c = a.entity_type.localeCompare(b.entity_type);
			else if (jobSortKey === 'field') c = a.field.localeCompare(b.field);
			else if (jobSortKey === 'locale') c = a.target_locale.localeCompare(b.target_locale);
			else if (jobSortKey === 'status') c = a.status.localeCompare(b.status);
			else c = a.attempts - b.attempts;
			return c * dir;
		});
	});
	function toggleJobSort(key: JobSort) {
		if (jobSortKey === key) jobSortDir = jobSortDir === 'asc' ? 'desc' : 'asc';
		else { jobSortKey = key; jobSortDir = key === 'attempts' ? 'desc' : 'asc'; }
	}
	function jobIndicator(key: JobSort): string {
		if (jobSortKey !== key) return '';
		return jobSortDir === 'asc' ? ' ↑' : ' ↓';
	}
</script>

<div class="page">
	<div class="page-head">
		<div class="eyebrow">{m.tr_eyebrow()}</div>
		<h1>{m.tr_title()}</h1>
		<p>{m.tr_subtitle()}</p>
	</div>

	{#if denied}
		<div class="notice error">{m.admin_denied()}</div>
	{:else if loading}
		<div class="notice">{m.admin_loading()}</div>
	{:else if loadError}
		<div class="notice error">{m.admin_load_failed({ error: loadError })}</div>
	{:else if data}
		{#if banner}<div class="banner {banner.kind}">{banner.text}</div>{/if}

		<div class="actions card">
			<div class="actions-title">{m.tr_actions_title()}</div>
			<div class="actions-row">
				<button class="btn-ghost" disabled={busy} onclick={backfill}>{m.tr_backfill()}</button>
				<button class="btn-primary" disabled={busy} onclick={run}>
					{busy ? m.tr_running() : m.tr_run()}
				</button>
			</div>
		</div>

		<div class="card cov">
			<div class="cov-title">{m.tr_coverage_title()}</div>
			<div class="thead cov-grid">
				<span>{m.tr_col_locale()}</span>
				<span class="num">{m.tr_pending()}</span>
				<span class="num">{m.tr_done()}</span>
				<span class="num">{m.tr_failed()}</span>
			</div>
			{#if locales.length === 0}
				<div class="empty">{m.tr_empty()}</div>
			{:else}
				{#each locales as loc (loc)}
					<div class="trow cov-grid">
						<span class="loc" dir="ltr">{loc}</span>
						<span class="num">{num(data.stats.byLocale[loc].pending, locale.current)}</span>
						<span class="num done">{num(data.stats.byLocale[loc].done, locale.current)}</span>
						<span class="num fail">{num(data.stats.byLocale[loc].failed, locale.current)}</span>
					</div>
				{/each}
			{/if}
		</div>

		<div class="filters">
			<button class:active={filter === ''} onclick={() => setFilter('')}>{m.tr_filter_all()}</button>
			<button class:active={filter === 'pending'} onclick={() => setFilter('pending')}>{m.tr_filter_pending()}</button>
			<button class:active={filter === 'done'} onclick={() => setFilter('done')}>{m.tr_filter_done()}</button>
			<button class:active={filter === 'failed'} onclick={() => setFilter('failed')}>{m.tr_filter_failed()}</button>
		</div>

		<div class="card table">
			<div class="cov-title">{m.tr_jobs_title()}</div>
			<div class="thead jobs-grid">
				<button class="col-sort" onclick={() => toggleJobSort('entity')}>{m.tr_col_entity()}{jobIndicator('entity')}</button>
				<button class="col-sort" onclick={() => toggleJobSort('field')}>{m.tr_col_field()}{jobIndicator('field')}</button>
				<button class="col-sort" onclick={() => toggleJobSort('locale')}>{m.tr_col_locale()}{jobIndicator('locale')}</button>
				<button class="col-sort" onclick={() => toggleJobSort('status')}>{m.tr_col_status()}{jobIndicator('status')}</button>
				<button class="col-sort num" onclick={() => toggleJobSort('attempts')}>{m.tr_col_attempts()}{jobIndicator('attempts')}</button>
				<span></span>
			</div>
			<!-- ⛔ TWO DIFFERENT EMPTIES, AND THE PAGE USED TO SAY THE WRONG ONE. `tr_empty` is "no
			     translation jobs yet" — a claim about the whole pipeline — and it was rendered whenever
			     THIS request came back with no rows, including with the Failed / Pending / Done chip
			     active. So a screen whose coverage matrix, eight lines higher on the SAME screen, was
			     counting hundreds of done jobs answered "Nog geen vertaaltaken." to a click on "Mislukt",
			     and the reader's only reading is that the page is broken. /audit already gets this right
			     (`audit_empty` says "matching this view"); this is the same distinction. -->
			{#if data.jobs.length === 0}
				<div class="empty">{filter ? m.tr_empty_filtered() : m.tr_empty()}</div>
			{:else}
				{#each sortedJobs as j (j.id)}
					<div class="trow jobs-grid">
						<span class="ent">{entityLabel(j.entity_type)}<span class="eid" dir="ltr"> · {j.entity_id.slice(0, 10)}</span></span>
						<span class="field" dir="ltr">{j.field}</span>
						<span class="loc" dir="ltr">{j.target_locale}</span>
						<!-- ⚠️ the class keeps the RAW value: `.status.pending/.done/.failed/.skipped`
						     are the colour hooks. Only the TEXT is localized. -->
						<span><span class="status {j.status}">{statusLabel(j.status)}</span></span>
						<span class="num">{j.attempts}</span>
						<span class="act">
							<button class="btn-mini" disabled={busy} onclick={() => startEdit(j)} aria-label={m.tr_override_save()}>✎</button>
						</span>
					</div>
					{#if editing === j.id}
						<!-- `?? null` folds an OLD backend's missing field into the same "nothing stored"
						     branch: frontend and backend deploy separately, so during a rollout this page
						     can be answered by a replica whose /jobs response predates the join. Without
						     the fold, `undefined` would slip past a `=== null` test and render an empty
						     box that LOOKS like a stored-but-blank translation — the exact ambiguity
						     this editor exists to remove. `startEdit` folds it the same way. -->
						{@const current = j.current_value ?? null}
						<div class="editor">
							<div class="edlabel">{m.tr_editor_source()}</div>
							<div class="src" dir="ltr" title={j.source_text}>{j.source_text.slice(0, 120)}</div>
							{#if j.error}<div class="joberr" dir="ltr">{j.error}</div>{/if}
							<!-- The BEFORE, kept on screen while the draft is edited: the draft box is
							     prefilled with this value, so once the operator starts typing this line is
							     the only remaining view of what a save will replace. `current_value === null`
							     is a genuinely different state from "a value that happens to be short" and
							     gets its own wording — an empty box is honest only in that case. -->
							{#if current === null}
								<div class="edlabel">{m.tr_editor_current({ locale: j.target_locale })}</div>
								<div class="nocur">{m.tr_editor_none()}</div>
							{:else}
								<div class="edlabel">
									{m.tr_editor_current({ locale: j.target_locale })}
									<span class="edwhen">· {timeAgo(j.current_updated_at)}</span>
								</div>
								<div class="cur">{current}</div>
							{/if}
							<div class="editrow">
								<!-- textarea, not input: `docs_md` translations are multi-line, and an
								     <input type=text> STRIPS newlines out of the value it is given — with the
								     draft now prefilled, that alone would flatten a whole document on save. -->
								<textarea bind:value={draft} rows="3" placeholder={m.tr_override_placeholder()}></textarea>
								<button class="btn-primary" disabled={!draft.trim() || busy} onclick={() => saveOverride(j)}>{m.tr_override_save()}</button>
								<button class="btn-ghost" onclick={() => (editing = null)}>✕</button>
							</div>
						</div>
					{/if}
				{/each}
			{/if}
			<!-- ⚠️ The list is TRUNCATED server-side (jobsLimit), not paged, and the sortable headers
			     above make those rows read as the whole set — while the coverage matrix on this same
			     screen counts every job. Two numbers that disagree with no explanation is the defect;
			     saying which one the table is showing is the fix. `jobsTotal` is counted with the
			     ACTIVE filter, so it is comparable to what is on screen. -->
			{#if data.jobsTotal > data.jobs.length}
				<div class="trunc">{m.tr_jobs_truncated({ shown: num(data.jobs.length, locale.current), total: num(data.jobsTotal, locale.current) })}</div>
			{/if}
		</div>
	{/if}
</div>

<style>
	.page { max-width: 1080px; }
	.page-head { margin-bottom: 18px; }
	.eyebrow { font-size: 10.5px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; color: var(--c-teal-dark); margin-bottom: 8px; }
	h1 { font-family: var(--font-display); font-size: 30px; margin: 0 0 6px; color: var(--c-midnight); }
	.page-head p { color: var(--c-muted); font-size: 13.5px; margin: 0; max-width: 660px; }
	.card { background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r-lg); margin-bottom: 14px; }
	.actions { padding: 14px 18px; }
	.actions-title, .cov-title { font-weight: 600; font-size: 13px; color: var(--c-ink); margin-bottom: 10px; }
	.actions-row { display: flex; gap: 10px; }
	.cov { padding: 14px 0 6px; }
	.cov-title { padding: 0 18px; }
	.thead, .trow { display: grid; align-items: center; gap: 10px; padding: 9px 18px; }
	.cov-grid { grid-template-columns: 1.5fr 0.8fr 0.8fr 0.8fr; }
	.jobs-grid { grid-template-columns: 1.6fr 1fr 0.7fr 0.9fr 0.6fr 0.6fr; }
	.thead { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--c-muted); font-weight: 600; border-bottom: 1px solid var(--c-border); }
	.col-sort { font: inherit; text-transform: inherit; letter-spacing: inherit; color: inherit; background: none; border: none; padding: 0; text-align: start; cursor: pointer; white-space: nowrap; }
	.col-sort:hover { color: var(--c-ink); }
	.trow { border-bottom: 1px solid var(--c-surface); font-size: 13px; }
	.trow:last-child { border-bottom: none; }
	.num { text-align: end; font-variant-numeric: tabular-nums; }
	.num.done { color: var(--c-teal-dark); }
	.num.fail { color: var(--c-coral-dark); }
	.loc { font-family: var(--font-mono); font-size: 12.5px; color: var(--c-ink); text-transform: uppercase; }
	.ent { font-weight: 600; color: var(--c-ink); }
	.eid { font-family: var(--font-mono); font-size: 11px; color: var(--c-muted); font-weight: 400; }
	.field { font-family: var(--font-mono); font-size: 12px; color: var(--c-muted); }
	.status { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; }
	.status.pending { background: var(--c-amber-pale, #fdf3e0); color: var(--c-amber-dark, #9a6b15); }
	.status.done { background: var(--c-teal-pale); color: var(--c-teal-dark); }
	.status.failed { background: var(--c-coral-pale); color: var(--c-coral-dark); }
	.status.skipped { background: var(--c-surface); color: var(--c-muted); }
	.act { text-align: end; }
	.btn-mini { font-size: 12px; background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r); padding: 4px 9px; color: var(--c-ink); }
	.editor { padding: 10px 18px 14px; border-bottom: 1px solid var(--c-surface); background: var(--c-surface); }
	.edlabel { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; color: var(--c-muted); margin-bottom: 3px; }
	.edwhen { text-transform: none; letter-spacing: 0; font-weight: 400; }
	.src { font-size: 12px; color: var(--c-muted); margin-bottom: 8px; }
	/* The current translation is the value a save destroys, so it is shown IN FULL and scrolls
	   rather than being clipped to a tooltip like the source line above it. */
	.cur { font-size: 12.5px; color: var(--c-ink); background: var(--c-white); border: 1px solid var(--c-border); border-radius: var(--r); padding: 7px 10px; margin-bottom: 8px; max-height: 7.5em; overflow: auto; white-space: pre-wrap; word-break: break-word; }
	.nocur { font-size: 12.5px; color: var(--c-amber-dark, #9a6b15); background: var(--c-amber-pale, #fdf3e0); border: 1px solid var(--c-amber-light, #f0dcb4); border-radius: var(--r); padding: 7px 10px; margin-bottom: 8px; }
	.joberr { font-size: 11.5px; color: var(--c-coral-dark); margin-bottom: 8px; font-family: var(--font-mono); }
	.editrow { display: flex; gap: 8px; align-items: flex-start; }
	.editrow textarea { flex: 1; resize: vertical; min-height: 62px; }
	textarea { font-family: var(--font-sans); font-size: 13.5px; line-height: 1.45; color: var(--c-ink); border: 1px solid var(--c-border); border-radius: var(--r); padding: 8px 12px; box-sizing: border-box; background: var(--c-white); }
	.trunc { font-size: 12px; color: var(--c-muted); padding: 10px 18px 4px; border-top: 1px solid var(--c-surface); }
	.filters { display: flex; gap: 8px; margin-bottom: 10px; }
	.filters button { font-size: 12.5px; font-weight: 500; color: var(--c-muted); background: var(--c-white); border: 1px solid var(--c-border); padding: 6px 14px; border-radius: 999px; }
	.filters button.active { color: var(--c-teal-dark); border-color: var(--c-teal-light); background: var(--c-teal-pale); }
	.btn-primary { background: var(--c-teal); color: #fff; font-weight: 600; font-size: 13px; padding: 9px 18px; border-radius: var(--r); border: none; white-space: nowrap; }
	.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
	.btn-ghost { font-size: 12.5px; font-weight: 500; color: var(--c-ink); background: var(--c-white); border: 1px solid var(--c-border); padding: 9px 16px; border-radius: var(--r); }
	.btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
	.table { padding: 14px 0 6px; }
	.table .cov-title { padding: 0 18px; }
	.empty { color: var(--c-muted); font-size: 13px; text-align: center; padding: 20px; }
	.banner { font-size: 12.5px; padding: 10px 12px; border-radius: var(--r); margin-bottom: 12px; }
	.banner.ok { background: var(--c-teal-pale); border: 1px solid var(--c-teal-light); color: var(--c-teal-dark); }
	.banner.error { background: var(--c-coral-pale); border: 1px solid var(--c-coral-light); color: var(--c-coral-dark); }
	.notice { font-size: 13.5px; padding: 28px; text-align: center; color: var(--c-muted); background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
	.notice.error { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); }
</style>
