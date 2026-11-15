<script lang="ts">
	// EntityDeriveBrowser — the visual "derive a DATA block from an ontology entity" experience
	// (block-edit create mode, startMode='entity'). Replaces the old three bare <select>s + button
	// with an industry×department selector, a grid of entity CARDS (attribute count, PII flags,
	// test-data readiness), and a live preview of the typed output ports the generated data block
	// will expose — mirroring the backend `compileDataBlock` derivation (one port per attribute +
	// `rows` + `count`). Self-contained: owns its own ontology browsing state (independent of the
	// editor's separate "import outputs" picker) and calls ontologyApi directly; emits `onDerived`
	// with the new block slug so the parent can navigate.
	import { ontologyApi } from '$lib/api/ontology';
	import type { MatrixData, OntologyEntity, OntologyAttribute, EntitySample } from '$lib/types/ontology';
	import Skeleton from '$lib/components/Skeleton.svelte';
	import type { FieldType } from '$lib/types/blocks';
	import * as m from '$lib/paraglide/messages';
	import { industryLabel, departmentLabel } from '$lib/i18n/ontology-axis-label';
	import { errorText, writeErrorText } from '$lib/api/error-message';
	import { num } from '$lib/utils/format';
	import { locale } from '$lib/stores/locale.svelte';
	import { fieldTypeLabel } from '$lib/i18n/field-type-label';

	let { onDerived }: { onDerived: (slug: string) => void } = $props();

	type Port = { name: string; type: FieldType; pii: boolean; aux?: boolean };

	let matrix = $state<MatrixData | null>(null);
	let industry = $state('');
	let department = $state('');
	let entities = $state<OntologyEntity[]>([]);
	let selectedId = $state('');
	/** entityId → its bound test-data samples (drives the "ready to derive" gate). */
	let samples = $state<Record<string, EntitySample[]>>({});
	/**
	 * ⛔ THE ENTITIES WHOSE SAMPLE PROBE FAILED — "we do not know", which is NOT "there are none".
	 *
	 * `GET /api/ontology/entities/:id/samples` used to be probed with a bare
	 * `.catch(() => [])` INSIDE the outer `try`, so a failing probe never reached the `error` state.
	 * It became `samples[id] = []`, which `hasPrimary()` reads as false, which made every card claim
	 * `blockedit_derive_no_sample` ("no test data — go bind some"), the preview repeat it as help
	 * text, and `canDerive` go false. The primary Derive button was then DISABLED FOREVER, with no
	 * visible reason and no retry path: a 500 on a readiness probe permanently removed the feature
	 * this whole component exists for, while telling the author a falsehood about their own data.
	 *
	 * So there are three states per entity, not two: has-primary / confirmed-none / UNKNOWN. Only
	 * the middle one may say "no test data". Unknown says so, keeps `canDerive` permissive (the
	 * backend re-checks at derive time and refuses with a real message — a client-side guess must
	 * not out-rank it), and offers a retry.
	 *
	 * A plain array, not a `Set`: `$state` deep-proxies arrays and plain objects, not `Set`, so a
	 * `$state(new Set())` here would mutate without ever re-rendering the cards.
	 */
	let sampleProbeFailed = $state<string[]>([]);
	let retryingSamples = $state(false);

	let loadingMatrix = $state(true);
	let loadingEntities = $state(false);
	let deriving = $state(false);
	let error = $state<string | null>(null);

	const selected = $derived(entities.find((e) => e.id === selectedId) ?? null);
	function hasPrimary(id: string): boolean {
		return (samples[id] ?? []).some((s) => s.isPrimary);
	}
	/** The probe for this entity failed — its readiness is UNKNOWN, not known-empty. */
	function sampleUnknown(id: string): boolean {
		return sampleProbeFailed.includes(id);
	}
	// ⚠️ `|| sampleUnknown(...)` — permissive on unknown, deliberately. See the note on
	// `sampleProbeFailed`: refusing on a state we failed to measure is what killed the feature.
	const canDerive = $derived(
		!!selected && (hasPrimary(selected.id) || sampleUnknown(selected.id)) && !deriving
	);

	/** Ontology attribute type → block FieldType (mirror of backend mapOntologyType). */
	function mapType(type: string): FieldType {
		switch (type.trim().toLowerCase()) {
			case 'string': case 'text': case 'date': case 'datetime': case 'timestamp':
			case 'enum': case 'email': case 'phone': case 'url': case 'uuid':
				return 'string';
			case 'number': case 'integer': case 'int': case 'float': case 'decimal': case 'currency':
				return 'number';
			case 'boolean': case 'bool':
				return 'boolean';
			case 'string[]': case 'text[]':
				return 'string[]';
			default:
				return 'json';
		}
	}

	/** The typed output ports the derived block will expose (one per attr + rows + count). */
	function previewPorts(e: OntologyEntity): Port[] {
		const ports: Port[] = e.attributes.map((a: OntologyAttribute) => ({ name: a.name, type: mapType(a.type), pii: a.pii }));
		const names = new Set(ports.map((p) => p.name));
		if (!names.has('rows')) ports.push({ name: 'rows', type: 'json', pii: false, aux: true });
		if (!names.has('count')) ports.push({ name: 'count', type: 'number', pii: false, aux: true });
		return ports;
	}
	function piiCount(e: OntologyEntity): number {
		return e.attributes.filter((a) => a.pii).length;
	}

	$effect(() => {
		void loadMatrix();
	});
	async function loadMatrix() {
		if (matrix) return;
		loadingMatrix = true;
		error = null;
		try {
			matrix = await ontologyApi.matrix();
		} catch (e) {
			error = errorText(e, m.error_load_failed());
		} finally {
			loadingMatrix = false;
		}
	}

	async function loadEntities() {
		selectedId = '';
		entities = [];
		samples = {};
		sampleProbeFailed = [];
		if (!industry || !department) return;
		loadingEntities = true;
		error = null;
		try {
			const g = await ontologyApi.get(industry, department);
			entities = g.entities;
			// Fetch test-data readiness for every entity in the cell (cells are small).
			// ⛔ A REJECTED PROBE IS RECORDED, NOT ERASED. The old `.catch(() => [])` threw the
			// distinction away at the only point it existed; everything downstream then had to guess,
			// and guessed "empty". See `sampleProbeFailed`.
			await probeSamples(entities.map((e) => e.id));
		} catch (e) {
			error = errorText(e, m.error_load_failed());
			entities = [];
			sampleProbeFailed = [];
		} finally {
			loadingEntities = false;
		}
	}

	/**
	 * Probe test-data readiness for `ids`, keeping "the probe failed" separate from "there are none".
	 *
	 * ⚠️ Never throws: a readiness probe is a decoration on a browsing screen, and letting one 500
	 * reject out of `loadEntities`' `Promise.all` would blank the ENTITY GRID that loaded perfectly
	 * — trading a small unknown for a large one. The per-entity outcome is recorded instead, and the
	 * UI is what reports it.
	 */
	async function probeSamples(ids: string[]): Promise<void> {
		const results = await Promise.all(
			ids.map(async (id) => {
				try {
					return { id, rows: await ontologyApi.listSamples(id), ok: true };
				} catch {
					return { id, rows: [] as EntitySample[], ok: false };
				}
			})
		);
		const next = { ...samples };
		// Rebuilt rather than filtered-in-place so a retry that succeeds DROPS the id (and one that
		// fails again keeps it) without either half needing to know about the other.
		const failed = new Set(sampleProbeFailed.filter((id) => !ids.includes(id)));
		for (const r of results) {
			if (r.ok) {
				next[r.id] = r.rows;
				failed.delete(r.id);
			} else {
				// ⛔ NOT `next[r.id] = []`. Writing an empty list here would re-manufacture the exact
				// lie this whole change removes — `hasPrimary` cannot tell it from a measured zero.
				delete next[r.id];
				failed.add(r.id);
			}
		}
		samples = next;
		sampleProbeFailed = [...failed];
	}

	/** Re-probe only the entities we failed to measure — the way back the author never had. */
	async function retrySamples() {
		if (retryingSamples || !sampleProbeFailed.length) return;
		retryingSamples = true;
		try {
			await probeSamples([...sampleProbeFailed]);
		} finally {
			retryingSamples = false;
		}
	}

	async function derive() {
		if (!selected || !canDerive) return;
		deriving = true;
		error = null;
		try {
			const res = await ontologyApi.deriveBlock(selected.id);
			onDerived(res.block.slug);
		} catch (e) {
			error = writeErrorText(e, m.error_action_failed());
		} finally {
			deriving = false;
		}
	}
</script>

<div class="derive">
	<p class="hint">{m.blockedit_derive_from_entity_hint()}</p>
	{#if error}<div class="banner error">{error}</div>{/if}

	{#if loadingMatrix}
		<div class="onto-row"><Skeleton width="180px" height="32px" /><Skeleton width="180px" height="32px" /></div>
	{:else}
		<div class="onto-row">
			<select bind:value={industry} onchange={loadEntities} aria-label={m.blockedit_import_ontology_industry()}>
				<option value="">{m.blockedit_import_ontology_industry()}</option>
				{#each matrix?.industries ?? [] as ind (ind)}<option value={ind}>{industryLabel(ind)}</option>{/each}
			</select>
			<select bind:value={department} onchange={loadEntities} aria-label={m.blockedit_import_ontology_department()}>
				<option value="">{m.blockedit_import_ontology_department()}</option>
				{#each matrix?.departments ?? [] as d (d)}<option value={d}>{departmentLabel(d)}</option>{/each}
			</select>
		</div>
	{/if}

	{#if loadingEntities}
		<div class="cards">
			{#each Array(4) as _, i (i)}<Skeleton width="100%" height="92px" radius="var(--r-lg)" />{/each}
		</div>
	{:else if industry && department && !entities.length}
		<div class="io-empty">{m.blockedit_io_none()}</div>
	{:else if entities.length}
		<div class="derive-body">
			<div class="cards" role="listbox" aria-label={m.blockedit_import_ontology_entity()}>
				{#each entities as e (e.id)}
					{@const ready = hasPrimary(e.id)}
					{@const unknown = sampleUnknown(e.id)}
					<button
						type="button"
						class="ecard"
						class:selected={selectedId === e.id}
						role="option"
						aria-selected={selectedId === e.id}
						onclick={() => (selectedId = e.id)}
					>
						<div class="ec-top">
							<span class="ec-name">{e.label}</span>
							{#if e.tenantOwned}<span class="ec-tag tenant">{m.block_owner_tenant()}</span>{/if}
						</div>
						<div class="ec-meta">
							<span class="ec-chip">{m.blockedit_derive_attrs({ count: num(e.attributes.length, locale.current) })}</span>
							{#if piiCount(e) > 0}<span class="ec-chip pii">{m.blockedit_derive_pii({ count: num(piiCount(e), locale.current) })}</span>{/if}
						</div>
						<!-- Three states, three sentences. `blockedit_derive_no_sample` is a claim about the
						     author's DATA and is only allowed where we actually measured it. -->
						<div class="ec-ready" class:ok={ready} class:unknown={!ready && unknown}>
							<span class="dot"></span>
							{#if ready}{m.blockedit_derive_ready()}{:else if unknown}{m.blockedit_derive_sample_unknown()}{:else}{m.blockedit_derive_no_sample()}{/if}
						</div>
					</button>
				{/each}
			</div>

			<div class="preview">
				{#if selected}
					<div class="pv-head">{m.blockedit_derive_preview()}</div>
					<div class="pv-ports">
						{#each previewPorts(selected) as p (p.name)}
							<span class="port" class:aux={p.aux} class:pii={p.pii}>
								<span class="p-name">{p.name}</span>
								<span class="p-type">{fieldTypeLabel(p.type)}</span>
								{#if p.pii}<span class="p-pii">{m.blockedit_flag_pii()}</span>{/if}
							</span>
						{/each}
					</div>
					{#if sampleUnknown(selected.id)}
						<!-- The probe failed. Say THAT, and offer the re-check — do not narrate the author's
						     data back at them from a measurement that never landed. Derive stays enabled;
						     `POST /api/ontology/entities/:id/derive` re-checks server-side and answers with a
						     real refusal if the entity truly has no primary sample. -->
						<p class="pv-help unknown" data-testid="derive-sample-unknown">
							{m.blockedit_derive_sample_unknown_help()}
						</p>
						<button
							class="btn-retry"
							type="button"
							disabled={retryingSamples}
							onclick={retrySamples}
						>
							{m.error_load_retry()}
						</button>
					{:else if !hasPrimary(selected.id)}
						<p class="pv-help">{m.blockedit_derive_no_sample_help()}</p>
					{/if}
					<button class="btn-primary" disabled={!canDerive} onclick={derive}>
						{deriving ? m.blockedit_creating() : m.blockedit_derive_action()}
					</button>
				{:else}
					<div class="pv-empty">
						<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
							<rect x="3" y="4" width="18" height="4" rx="1" /><rect x="3" y="10" width="18" height="4" rx="1" /><rect x="3" y="16" width="11" height="4" rx="1" />
						</svg>
						<p>{m.blockedit_derive_select_prompt()}</p>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.derive { max-width: 860px; padding: 18px; border: 1px solid var(--c-border); border-radius: var(--r-lg); background: var(--c-white); }
	.hint { font-size: 12.5px; color: var(--c-muted); margin: 0 0 12px; }
	.banner.error { font-size: 12.5px; padding: 8px 11px; border-radius: var(--r-sm); background: var(--c-coral-pale); color: var(--c-coral-dark); border: 1px solid var(--c-coral-light); margin-bottom: 10px; }
	.onto-row { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
	.onto-row select { font-size: 12.5px; padding: 6px 9px; border: 1px solid var(--c-border); border-radius: var(--r-sm); background: var(--c-white); }
	.io-empty { font-size: 12px; color: var(--c-faint); }

	.derive-body { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
	@media (max-width: 720px) { .derive-body { grid-template-columns: 1fr; } }

	.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
	.ecard { display: flex; flex-direction: column; gap: 7px; text-align: start; padding: 11px 12px; border: 1px solid var(--c-border); border-radius: var(--r-lg); background: var(--c-white); transition: border-color .12s, box-shadow .12s, background .12s; }
	.ecard:hover { border-color: var(--c-teal-mid); box-shadow: var(--sh-sm); }
	.ecard.selected { border-color: var(--c-teal); background: var(--c-teal-pale); box-shadow: var(--sh-sm); }
	.ec-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
	.ec-name { font-size: 13px; font-weight: 600; color: var(--c-midnight); }
	.ec-tag.tenant { font-size: 9.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--c-teal-dark); background: var(--c-teal-light); padding: 1px 5px; border-radius: var(--r-sm); }
	.ec-meta { display: flex; flex-wrap: wrap; gap: 5px; }
	.ec-chip { font-size: 11px; color: var(--c-muted); background: var(--c-surface); border: 1px solid var(--c-border); padding: 1px 6px; border-radius: 999px; }
	.ec-chip.pii { color: var(--c-coral-dark); background: var(--c-coral-pale); border-color: var(--c-coral-light); }
	.ec-ready { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--c-faint); }
	.ec-ready.ok { color: var(--c-teal-dark); }
	.ec-ready.unknown { color: var(--c-amber-dark, #92400E); }
	.ec-ready .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c-border-strong); }
	.ec-ready.ok .dot { background: var(--c-teal); }
	.ec-ready.unknown .dot { background: var(--c-amber, #D97706); }

	.preview { padding: 13px; border: 1px solid var(--c-teal-light); border-radius: var(--r-lg); background: var(--c-teal-pale); }
	.pv-head { font-size: 12px; font-weight: 600; color: var(--c-teal-dark); margin-bottom: 9px; }
	.pv-ports { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 11px; }
	.port { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; background: var(--c-white); border: 1px solid var(--c-border); padding: 2px 7px; border-radius: var(--r-sm); }
	.port.aux { border-style: dashed; color: var(--c-muted); }
	.port.pii { border-color: var(--c-coral-light); }
	.p-name { font-family: var(--font-mono); color: var(--c-midnight); }
	.p-type { font-size: 10px; color: var(--c-faint); }
	.p-pii { font-size: 9.5px; font-weight: 700; color: var(--c-coral-dark); }
	.pv-help { font-size: 11.5px; color: var(--c-coral-dark); margin: 0 0 10px; }
	.pv-help.unknown { color: var(--c-amber-dark, #92400E); }
	.btn-retry { font-size: 11.5px; font-weight: 600; color: var(--c-midnight); background: var(--c-white); border: 1px solid var(--c-border-strong); padding: 5px 10px; border-radius: var(--r-sm); margin: 0 0 10px; }
	.btn-retry:disabled { opacity: .5; cursor: not-allowed; }
	.pv-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 18px 8px; color: var(--c-faint); text-align: center; }
	.pv-empty p { font-size: 12px; margin: 0; }
	.btn-primary { font-size: 12.5px; font-weight: 600; color: var(--c-white); background: var(--c-teal); padding: 8px 14px; border-radius: var(--r); }
	.btn-primary:disabled { opacity: .5; cursor: not-allowed; }
</style>
