<script lang="ts">
	// Drag-drop + click file picker. Emits the chosen File; the parent uploads it.
	// RTL-safe (logical properties, centered content). Accepts CSV/Excel/JSON/text.
	import * as m from '$lib/paraglide/messages';

	// ⛔ `onreject` IS REQUIRED, NOT OPTIONAL. An optional callback would let the next consumer of
	// this component drop a refused file on the floor — the same silence this guard exists to end,
	// moved one level up. Non-optional makes "what do I show the reader?" a COMPILE error.
	let { onfile, onreject, accept = '.csv,.tsv,.xlsx,.xls,.json,.txt,.text', disabled = false }: {
		onfile: (file: File) => void;
		onreject: (message: string) => void;
		accept?: string;
		disabled?: boolean;
	} = $props();

	let dragging = $state(false);
	let inputEl: HTMLInputElement;

	/**
	 * ⛔ THE DROP HOLE. `accept=` on the hidden <input> is the ONLY thing that ever filtered an
	 * upload, and the browser applies it to the FILE PICKER ONLY — a drag-and-drop never consults
	 * it. So dragging `report.pdf` onto /datasets sent a PDF to `POST /api/datasets`, which (before
	 * `resolveUploadSourceType`, backend/src/routes/datasets.ts) closed its unknown-extension null
	 * with `?? 'csv'`, decoded the binary as UTF-8, made `%PDF-1.7` the header row and answered 201.
	 *
	 * ⛔ DERIVED FROM `accept`, NEVER A SECOND HAND-WRITTEN LIST. A copy of the extension set here
	 * would drift from the one the picker enforces, and the two would disagree about the same file.
	 * A caller that narrows `accept` narrows the drop guard with it, by construction.
	 *
	 * The backend still runs the identical check — this is a round-trip saved for the reader, not a
	 * replacement for the server-side refusal, which is the only one an API client obeys.
	 */
	const allowed = $derived(
		accept
			.split(',')
			.map((e) => e.trim().toLowerCase())
			.filter((e) => e.startsWith('.'))
	);

	/** Bidi isolation for a file name/extension the READER typed — the same U+2068 FSI … U+2069 PDI
	 *  pair `lib/api/error-message.ts` wraps every foreign value in, so an Arabic file name cannot
	 *  swap the halves of the Dutch sentence around it. Copied rather than shared for the reason
	 *  that module records: it is two characters, and `{@html}` is the only alternative.
	 *  ⚠️ `fromCharCode`, NOT the literal characters. Svelte's compiler warns
	 *  (`bidirectional_control_characters`) on an invisible direction-altering codepoint sitting in
	 *  component source, which is a good rule — this is the one legitimate use, spelled so the
	 *  source stays readable and `bun run check` stays clean. */
	const FSI = String.fromCharCode(0x2068);
	const PDI = String.fromCharCode(0x2069);
	const iso = (v: string): string => `${FSI}${v}${PDI}`;

	/** The dotted extension (`'.pdf'`), or null when there is none. A LEADING dot is a name, not an
	 *  extension — `.gitignore` has no type. Character-for-character the backend's `extensionOf`. */
	function extensionOf(name: string): string | null {
		const dot = name.lastIndexOf('.');
		return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : null;
	}

	/** The localized refusal for a file this uploader cannot read, or null when it can. THE SAME TWO
	 *  CATALOG KEYS the backend's `unsupported_file_type` renders through `writeErrorText`, so the
	 *  client-side refusal and the server's cannot say different things about one file. */
	function refusalFor(file: File): string | null {
		const ext = extensionOf(file.name);
		if (ext === null) {
			return m.error_unsupported_file_type_no_extension({ name: iso(file.name) });
		}
		return allowed.includes(ext) ? null : m.error_unsupported_file_type({ extension: iso(ext) });
	}

	// ⚠️ ON BOTH PATHS, not just the drop. `accept=` is ADVISORY even in the picker — every desktop
	// file dialog offers an "All files" escape — so the click path had the same hole, just a
	// narrower one.
	function take(file: File | undefined | null) {
		if (disabled) return;
		if (!file) return;
		const refusal = refusalFor(file);
		if (refusal !== null) {
			onreject(refusal);
			return;
		}
		onfile(file);
	}
	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		take(e.dataTransfer?.files?.[0]);
	}
</script>

<div
	class="upload"
	class:drag={dragging}
	class:disabled
	role="button"
	tabindex={disabled ? -1 : 0}
	aria-disabled={disabled}
	onclick={() => !disabled && inputEl.click()}
	onkeydown={(e) => !disabled && (e.key === 'Enter' || e.key === ' ') && inputEl.click()}
	ondragover={(e) => {
		e.preventDefault();
		if (!disabled) dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={onDrop}
>
	<input
		bind:this={inputEl}
		type="file"
		{accept}
		{disabled}
		hidden
		onchange={(e) => {
			take(e.currentTarget.files?.[0]);
			e.currentTarget.value = '';
		}}
	/>
	<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6">
		<path d="M12 16V4M7 9l5-5 5 5" />
		<path d="M5 20h14" />
	</svg>
	<span class="title">{m.datasets_upload_cta()}</span>
	<span class="hint">{m.datasets_upload_hint()}</span>
</div>

<style>
	.upload {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		border: 1.5px dashed var(--c-border-strong);
		border-radius: var(--r-lg);
		padding: 26px 18px;
		text-align: center;
		cursor: pointer;
		color: var(--c-muted);
		transition: border-color 0.15s, background 0.15s;
	}
	.upload:hover,
	.upload.drag {
		border-color: var(--c-teal);
		background: var(--c-teal-pale);
		color: var(--c-teal-dark);
	}
	.upload.disabled {
		cursor: not-allowed;
		opacity: 0.55;
		pointer-events: none;
	}
	.title {
		font-size: 13px;
		font-weight: 600;
		color: var(--c-ink);
	}
	.hint {
		font-size: 11.5px;
		color: var(--c-faint);
	}
</style>
