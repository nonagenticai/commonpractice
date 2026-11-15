<script lang="ts">
	// Platform Governance — the policy rails (demo.html `governance`). Every rail is
	// the LIVE value the runtime reads: editing one PATCHes /api/governance, which
	// records a change + audit row and changes runtime behaviour at once (broker caps,
	// model allowlist, idle sweep, the run-gate, the pipeline promotion gate).
	import { onMount } from 'svelte';
	import { governanceApi, ApiError } from '$lib/api/governance';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import type {
		Governance,
		Policy,
		PolicyEnforcement,
		PolicyGroup,
		PolicyValue
	} from '$lib/types/governance';
	import PolicyRow from '$lib/components/ops/PolicyRow.svelte';
	import { policyGroupTitle, policyLabel, policyOptionLabel } from '$lib/i18n/policy-label';
	import {
		complianceLabel,
		complianceStatusLabel,
		complianceRowKey
	} from '$lib/i18n/compliance-label';
	import { timeAgo, num, exact, boundaryDate } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import * as m from '$lib/paraglide/messages';

	let data = $state<Governance | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let denied = $state(false);
	let busyKey = $state<string | null>(null);
	let savedKey = $state<string | null>(null);
	let exporting = $state(false);

	async function load() {
		loading = true;
		error = null;
		denied = false;
		try {
			data = await governanceApi.get();
		} catch (e) {
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) denied = true;
			else error = errorText(e, m.error_load_failed());
		} finally {
			loading = false;
		}
	}
	onMount(load);

	async function update(policy: Policy, value: PolicyValue) {
		busyKey = policy.key;
		savedKey = null;
		try {
			await governanceApi.update(policy.key, value);
			savedKey = policy.key;
			await load(); // reflect the new value + the fresh "Recent changes" entry
			setTimeout(() => (savedKey = null), 1800);
		} catch (e) {
			error = writeErrorText(e, m.error_save_failed());
		} finally {
			busyKey = null;
		}
	}

	/**
	 * One side of a recorded change — in the reader's words and the reader's punctuation.
	 *
	 * ⛔ THE DEFECT. This ended in `String(v)`, so "Recente wijzigingen" CONTRADICTED the rail two
	 * panels above it, on one screen, in one language: flipping the data-validation rail in the
	 * Dutch UI recorded `warn → block` under a `<select>` that offers *waarschuwen / blokkeren*.
	 * The rail localizes through `policyOptionLabel` (PolicyRow.svelte) and this list did not,
	 * even though `c.policyKey` has always been on the DTO — the line right above renders the row's
	 * NAME from it. The localizer was reachable the whole time.
	 *
	 * ⚠️ `policyKey` IS A REQUIRED PARAMETER, NOT AN OPTIONAL ONE. Option vocabularies are
	 * PER-POLICY and the words are not globally unique — `block` here means "refuse the run", and
	 * `policyOptionLabel` therefore dispatches on the PAIR. A `policyKey = ''` default would
	 * compile at a site that forgets and return every value raw again, which is this defect
	 * exactly; `svelte-check` names the caller instead. Same reasoning as `num`'s locale parameter.
	 *
	 * ⛔ NUMBERS GO THROUGH `exact()`, NOT `num()`, AND NOT RAW. Raw is the second half of the same
	 * defect: `String(15000)` is "15000" beside a screen that writes "15.000" everywhere else in
	 * Dutch. `num()` is the wrong repair — `validateValue` (backend/src/routes/governance.ts) takes
	 * any finite `n >= 0` for a `number` rail and `commitNumber` sends `Number.parseFloat`, so a
	 * ceiling of 12.3456 is storable, and `num`'s default `maximumFractionDigits: 3` would round
	 * the very figure this audit trail exists to record. That is the /llm-settings `temperature`
	 * decision one screen over, for the same reason.
	 *
	 * ⚠️ ARRAYS AND MAPS ARE DELIBERATELY UNTOUCHED. `models.allowlist` / `data.egress_allowlist`
	 * members are MODEL IDENTIFIERS and HOSTNAMES — not words in any language, and they must render
	 * byte-for-byte or an operator cannot match a row against a vendor's list. Same call this file's
	 * `policyMapKeyLabel` sibling already makes for `models.pricing`.
	 */
	function fmtVal(v: PolicyValue | null, policyKey: string): string {
		if (v === null) return '—';
		if (Array.isArray(v)) return v.join(', ');
		if (typeof v === 'boolean') return v ? m.governance_value_on() : m.governance_value_off();
		if (typeof v === 'number') return exact(v, locale.current);
		return policyOptionLabel(policyKey, String(v));
	}

	/**
	 * The rails of one group, split by WHAT BACKS THEM, in a fixed order.
	 *
	 * ⛔ THE DEFECT THIS CLOSES. This screen was headed "Policy rails · enforced at the boundary" in
	 * all eight languages over eighteen rails, four of which no code reads at all — flipping
	 * `data.block_prod_data`, `data.cross_sandbox_isolation`, `models.code_exec_outside_blocks` or
	 * `data.eu_only` off changed nothing anywhere. Rendering them in one undifferentiated list under
	 * that heading is what made an architectural assertion indistinguishable from an enforced
	 * boundary for a compliance reader.
	 *
	 * ⛔ THE `undefined` BUCKET IS THE ROLLING-DEPLOY PATH AND IT MUST STAY FIRST AND UNHEADED. A
	 * pre-change backend sends no `enforcement`, and the browser reaches the API through the Service,
	 * which answers from old and new pods for the length of a roll. Those rails are rendered exactly
	 * as they were before this change — one flat list, no sub-heading, no claim — because bucketing
	 * an unknown rail under "Enforced at the boundary" would restore the original defect during
	 * every deploy. `Policy.enforcement` is optional in the type for this reason; see the note there.
	 *
	 * The order is deliberate and runs DOWN the strength of the claim: enforced first (what actually
	 * refuses something), then applied (a live setting that changes a run but refuses nothing), then
	 * the stated posture, then the withdrawn claim last. `applied` sits second because it is the
	 * only other band whose rails still change runtime behaviour — a reader scanning from the top
	 * for "what does editing this actually do" must reach it before the two bands where the answer
	 * is "nothing".
	 */
	const SECTIONS: PolicyEnforcement[] = ['enforced', 'applied', 'architectural', 'retired'];

	/**
	 * ⛔ THE CADENCE IS `applied` BUT DOES NOT TAKE EFFECT ON THE NEXT RUN OR CALL. The `applied` band's
	 * note says an edit "changes the next run or call"; a cadence change waits for the running period
	 * to end (backend `switchCadence`), and its own description says so — one screen made two
	 * contradictory claims about one rail. Rails listed here get their OWN band (`scheduled`), placed
	 * right after `applied`, whose note says what actually happens.
	 */
	const CADENCE_KEY = 'cycle.cadence';
	const SCHEDULED_KEYS = new Set<string>([CADENCE_KEY]);
	type SectionKind = PolicyEnforcement | 'unknown' | 'scheduled';

	function sectionsOf(
		group: PolicyGroup
	): { kind: SectionKind; policies: Policy[] }[] {
		// ⛔ THE REMAINDER, NOT `=== undefined`. Bucketing only `undefined` plus the three known kinds
		// means a value that is neither — an `enforcement` this frontend has not heard of, which is
		// exactly what an OLD frontend sees for the length of a rolling deploy after a 4th kind ships —
		// matches no bucket and the rail SILENTLY DISAPPEARS from the screen. Measured: a payload with
		// one rail at `enforcement: 'conditional'` rendered 4 of 5 rails, no error, on a compliance
		// surface. Dropping a rail is a worse failure than showing it unlabelled, so anything not
		// recognised falls into the unheaded `unknown` bucket and is still rendered.
		const known = new Set<string>(SECTIONS);
		const unknown = group.policies.filter((p) => !p.enforcement || !known.has(p.enforcement));
		const out: { kind: SectionKind; policies: Policy[] }[] = [];
		if (unknown.length) out.push({ kind: 'unknown', policies: unknown });
		for (const kind of SECTIONS) {
			const policies = group.policies.filter((p) => p.enforcement === kind && !SCHEDULED_KEYS.has(p.key));
			if (policies.length) out.push({ kind, policies });
			if (kind === 'applied') {
				const scheduled = group.policies.filter((p) => p.enforcement === kind && SCHEDULED_KEYS.has(p.key));
				if (scheduled.length) out.push({ kind: 'scheduled', policies: scheduled });
			}
		}
		return out;
	}

	/** The sub-heading over one enforcement section. `unknown` has none — see `sectionsOf`. */
	function sectionTitle(kind: SectionKind): string {
		if (kind === 'enforced') return m.governance_enforcement_enforced();
		if (kind === 'applied') return m.governance_enforcement_applied();
		if (kind === 'scheduled') return m.governance_enforcement_scheduled();
		if (kind === 'architectural') return m.governance_enforcement_architectural();
		if (kind === 'retired') return m.governance_enforcement_retired();
		return '';
	}

	/** The one line under that sub-heading that says what the reader may conclude from it. */
	function sectionNote(kind: SectionKind): string {
		if (kind === 'enforced') return m.governance_enforcement_enforced_note();
		if (kind === 'applied') return m.governance_enforcement_applied_note();
		if (kind === 'scheduled') return m.governance_enforcement_scheduled_note();
		if (kind === 'architectural') return m.governance_enforcement_architectural_note();
		if (kind === 'retired') return m.governance_enforcement_retired_note();
		return '';
	}

	function exportStatusLabel(status: string): string {
		if (status === 'success') return m.governance_export_status_success();
		if (status === 'error') return m.governance_export_status_error();
		return m.governance_export_status_running();
	}

	async function runExport() {
		exporting = true;
		error = null;
		try {
			await governanceApi.exportNow();
			await load(); // reflect the new last-export status
		} catch (e) {
			error = writeErrorText(e, m.error_action_failed());
		} finally {
			exporting = false;
		}
	}
</script>

<div class="page">
	<header class="page-head">
		<div>
			<div class="eyebrow">{m.governance_eyebrow()}</div>
			<h1>{m.governance_title()}</h1>
			<p>{m.governance_subtitle()}</p>
		</div>
	</header>

	{#if denied}
		<div class="notice error">{m.governance_denied()}</div>
	{:else if loading && !data}
		<div class="notice">{m.governance_loading()}</div>
	{:else if error && !data}
		<div class="notice error">{m.governance_load_failed({ error })}</div>
	{:else if data}
		{#if error}<div class="notice error inline">{error}</div>{/if}
		<div class="layout">
			<div class="rails">
				{#each data.groups as group (group.category)}
					<section class="card">
						<!-- `group.title` is the backend's English and is never read; the heading comes
						     from `group.category`, which the DTO has always carried. -->
						<h2>{policyGroupTitle(group.category)}</h2>
						{#each sectionsOf(group) as section (section.kind)}
							{#if section.kind !== 'unknown'}
								<div class="section-head {section.kind}">
									<h3>{sectionTitle(section.kind)}</h3>
									<p>{sectionNote(section.kind)}</p>
								</div>
							{/if}
							<div class="rows">
								{#each section.policies as policy (policy.key)}
									<div class="row-wrap" class:saved={savedKey === policy.key}>
										<PolicyRow
											{policy}
											busy={busyKey === policy.key}
											onchange={(v) => update(policy, v)}
										/>
										<!-- The date the PLATFORM's pending cadence change takes over, from the rail itself
										     (`effectiveFrom`, refetched by `load()` after every save) — never GET /api/cycle/cadence,
										     which answers for the operator's own workspace. Absent when nothing is pending. -->
										{#if policy.key === CADENCE_KEY && policy.effectiveFrom}
											<p class="effective-from" data-testid="cadence-effective-from">
												{m.governance_cadence_effective_from({ date: boundaryDate(policy.effectiveFrom, locale.current) })}
											</p>
										{/if}
									</div>
								{/each}
							</div>
						{/each}
					</section>
				{/each}
			</div>

			<aside class="side">
				<section class="card">
					<div class="export-head">
						<h2>{m.governance_export_title()}</h2>
						{#if data.exportStatus.enabled}
							<button class="export-btn" onclick={runExport} disabled={exporting}>
								{exporting ? m.governance_export_running() : m.governance_export_now()}
							</button>
						{/if}
					</div>
					<p class="static-note real">{m.governance_export_real_note()}</p>
					{#if !data.exportStatus.enabled}
						<p class="empty">{m.governance_export_disabled()}</p>
					{:else if !data.exportStatus.lastRun}
						<p class="empty">{m.governance_export_none()}</p>
					{:else}
						{@const last = data.exportStatus.lastRun}
						<div class="export-last">
							<div class="export-row">
								<span class="lbl">{m.governance_export_last()}</span>
								<span class="dot-status {last.status === 'success' ? 'running' : last.status === 'error' ? 'failed' : 'idle'}">
									<span class="d"></span>{exportStatusLabel(last.status)}
								</span>
							</div>
							<div class="export-meta">
								{last.date} · {m.governance_export_rows({ count: num(last.rowCount, locale.current) })}
							</div>
							{#if last.objectKey}
								<div class="export-key" dir="ltr">{last.bucket}/{last.objectKey}</div>
							{/if}
							{#if last.sha256}
								<div class="export-sha" dir="ltr">sha256:{last.sha256.slice(0, 16)}…</div>
							{/if}
							{#if last.error}
								<div class="export-err">{last.error}</div>
							{/if}
						</div>
						{#if data.exportStatus.recent.length > 1}
							<div class="export-recent">
								<div class="lbl">{m.governance_export_recent()}</div>
								<ul>
									{#each data.exportStatus.recent.slice(1, 6) as r (r.date)}
										<li>
											<span dir="ltr">{r.date}</span>
											<span class="dot-status {r.status === 'success' ? 'running' : r.status === 'error' ? 'failed' : 'idle'}">
												<span class="d"></span>{exportStatusLabel(r.status)}
											</span>
										</li>
									{/each}
								</ul>
							</div>
						{/if}
					{/if}
				</section>
				<section class="card">
					<h2>{m.governance_compliance_status()}</h2>
					<ul class="compliance">
						<!-- ⛔ NOT `(c.key)`. A pre-change backend sends no `key`, so all four rows would
						     key on `undefined`, Svelte would throw `each_key_duplicate` (not dev-only,
						     and uncaught — there is no <svelte:boundary> in this tree) and the WHOLE
						     page would render as an empty shell mid-roll. `complianceRowKey` falls back
						     to the label, which is unique and stable on both wire versions. -->
						{#each data.compliance as c (complianceRowKey(c))}
							<li>
								<span>{complianceLabel(c.key, c.label)}</span>
								<span class="dot-status {c.tone === 'warn' ? 'idle' : 'running'}"><span class="d"></span>{complianceStatusLabel(c.statusKey, c.status)}</span>
							</li>
						{/each}
					</ul>
					<p class="static-note">{m.governance_static_note()}</p>
				</section>
				<section class="card">
					<h2>{m.governance_recent_changes()}</h2>
					{#if data.recentChanges.length === 0}
						<p class="empty">{m.governance_no_changes()}</p>
					{:else}
						<ul class="changes">
							{#each data.recentChanges as c (c.id)}
								<li>
									<!-- `c.label` is the backend's English policy name (governance.ts resolves it
									     from `labelByKey`); `c.policyKey` is on the DTO and is the same key the
									     rail above renders from, so the two lists now agree in every locale. -->
									<div class="ch-label">{policyLabel(c.policyKey)}</div>
									<div class="ch-diff">{fmtVal(c.oldValue, c.policyKey)} <span class="cp-dir-mirror" aria-hidden="true">→</span> <b>{fmtVal(c.newValue, c.policyKey)}</b></div>
									<div class="ch-meta">{c.actor?.name ?? m.governance_actor_system()} · {timeAgo(c.createdAt)}</div>
								</li>
							{/each}
						</ul>
					{/if}
				</section>
			</aside>
		</div>
	{/if}
</div>

<style>
	.page {
		max-width: 1180px;
	}
	.page-head {
		margin-bottom: 22px;
	}
	.eyebrow {
		font-size: 10.5px;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		font-weight: 600;
		color: var(--c-teal);
		margin-bottom: 6px;
	}
	h1 {
		font-family: var(--font-display);
		font-size: 30px;
		color: var(--c-midnight);
		margin: 0 0 4px;
	}
	.page-head p {
		color: var(--c-muted);
		font-size: 13.5px;
		margin: 0;
	}
	.layout {
		display: grid;
		grid-template-columns: 1.6fr 1fr;
		gap: 20px;
		align-items: start;
	}
	.rails {
		display: flex;
		flex-direction: column;
		gap: 18px;
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
	h2 {
		font-family: var(--font-display);
		font-size: 18px;
		margin: 0 0 8px;
		color: var(--c-midnight);
	}
	.rows {
		margin-top: 4px;
	}
	/* The enforcement bands. The leading rule is the only colour difference between them, so the
	   four read as one system rather than four unrelated callouts. */
	.section-head {
		margin: 14px 0 2px;
		padding: 8px 0 8px 12px;
		border-inline-start: 3px solid var(--c-border-strong);
	}
	.section-head:first-child {
		margin-top: 6px;
	}
	.section-head.enforced {
		border-inline-start-color: var(--c-teal);
	}
	/* Applied sits between enforced (teal) and architectural (amber): a real runtime effect,
	   but no boundary. `border-inline-start-color`, like its siblings — `border-left` would put
	   the rule on the wrong edge in the `ar` and `he` catalogs. */
	.section-head.applied {
		border-inline-start-color: var(--c-violet);
	}
	.section-head.scheduled {
		border-inline-start-color: var(--c-violet);
	}
	.effective-from {
		margin: -6px 18px 12px;
		font-size: 12px;
		font-weight: 600;
		color: var(--c-violet);
	}
	.section-head.architectural {
		border-inline-start-color: var(--c-amber, #d69e2e);
	}
	.section-head.retired {
		border-inline-start-color: var(--c-border-strong);
	}
	.section-head h3 {
		font-family: var(--font-display);
		font-size: 13px;
		letter-spacing: 0.02em;
		margin: 0;
		color: var(--c-midnight);
	}
	.section-head p {
		margin: 3px 0 0;
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--c-muted);
	}
	.section-head.retired h3,
	.section-head.retired p {
		color: var(--c-muted);
	}
	.row-wrap {
		border-radius: var(--r);
		transition: background 0.5s;
	}
	.row-wrap.saved {
		background: var(--c-teal-pale);
	}
	.compliance,
	.changes {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.compliance li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 9px 0;
		border-bottom: 1px solid var(--c-border);
		font-size: 13px;
		color: var(--c-ink);
	}
	.compliance li:last-child {
		border-bottom: none;
	}
	.dot-status {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12.5px;
	}
	.dot-status .d {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--c-muted);
	}
	.dot-status.running .d {
		background: var(--c-emerald);
	}
	.dot-status.idle .d {
		background: var(--c-amber);
	}
	.static-note {
		font-size: 11px;
		color: var(--c-muted);
		margin: 10px 0 0;
	}
	.static-note.real {
		margin: 0 0 12px;
		color: var(--c-ink);
	}
	.dot-status.failed .d {
		background: var(--c-coral, #e2574c);
	}
	.export-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	.export-head h2 {
		margin: 0;
	}
	.export-btn {
		font-size: 12px;
		font-weight: 600;
		padding: 6px 12px;
		border-radius: var(--r);
		border: 1px solid var(--c-teal);
		background: var(--c-teal);
		color: #fff;
		cursor: pointer;
	}
	.export-btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.export-last {
		margin-top: 4px;
	}
	.export-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 0;
	}
	.lbl {
		font-size: 12.5px;
		font-weight: 500;
		color: var(--c-ink);
	}
	.export-meta {
		font-size: 12.5px;
		color: var(--c-muted);
		margin: 2px 0;
	}
	.export-key,
	.export-sha {
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--c-muted);
		word-break: break-all;
		margin-top: 3px;
	}
	.export-err {
		font-size: 11.5px;
		color: var(--c-coral-dark);
		margin-top: 4px;
	}
	.export-recent {
		margin-top: 12px;
		border-top: 1px solid var(--c-border);
		padding-top: 10px;
	}
	.export-recent ul {
		list-style: none;
		margin: 6px 0 0;
		padding: 0;
	}
	.export-recent li {
		display: flex;
		justify-content: space-between;
		align-items: center;
		font-size: 12px;
		color: var(--c-muted);
		padding: 4px 0;
	}
	.changes li {
		padding: 10px 0;
		border-bottom: 1px solid var(--c-border);
	}
	.changes li:last-child {
		border-bottom: none;
	}
	.ch-label {
		font-size: 13px;
		font-weight: 500;
		color: var(--c-ink);
	}
	.ch-diff {
		font-size: 12.5px;
		color: var(--c-muted);
		font-family: var(--font-mono);
		margin: 2px 0;
	}
	.ch-meta {
		font-size: 11.5px;
		color: var(--c-muted);
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
	.notice.inline {
		margin-bottom: 14px;
		padding: 12px 16px;
		text-align: start;
	}
	@media (max-width: 920px) {
		.layout {
			grid-template-columns: 1fr;
		}
	}
	/* Phone width (the shell drawer breakpoint, app.css): nothing on this page may push the screen sideways. */
	.layout > * { min-width: 0; }
</style>
