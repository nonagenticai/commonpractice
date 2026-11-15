<script lang="ts">
	// CodeMirror 6 editor styled to match the demo's dark .code-area
	// (demo.html:1134–1150). Used for the block Implementation tab (TypeScript).
	import { onMount, onDestroy } from 'svelte';
	import { Compartment, EditorState, type Extension } from '@codemirror/state';
	import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
	import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
	import { javascript } from '@codemirror/lang-javascript';
	import {
		HighlightStyle,
		syntaxHighlighting,
		bracketMatching,
		indentOnInput
	} from '@codemirror/language';
	import { tags as t } from '@lezer/highlight';

	let {
		value = $bindable(''),
		readonly = false
	}: { value?: string; readonly?: boolean } = $props();

	let host: HTMLDivElement;
	let view: EditorView | undefined;

	// Demo code-area palette: keywords teal, strings orange, comments slate,
	// functions amber, variables blue — on the midnight background.
	const cpHighlight = HighlightStyle.define([
		{ tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: '#5EEAD4' },
		{ tag: [t.string, t.special(t.string)], color: '#FB923C' },
		{ tag: [t.comment, t.lineComment, t.blockComment], color: '#64748B', fontStyle: 'italic' },
		{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#FBBF24' },
		{ tag: [t.variableName, t.propertyName], color: '#93C5FD' },
		{ tag: [t.number, t.bool, t.null], color: '#F0ABFC' },
		{ tag: [t.typeName, t.className], color: '#5EEAD4' },
		{ tag: t.definitionKeyword, color: '#5EEAD4' }
	]);

	const cpTheme = EditorView.theme(
		{
			'&': {
				backgroundColor: 'var(--c-midnight)',
				color: '#E2E8F0',
				fontSize: '13px',
				borderRadius: 'var(--r-lg)',
				overflow: 'hidden'
			},
			'.cm-content': {
				fontFamily: 'var(--font-mono)',
				lineHeight: '1.6',
				padding: '12px 0'
			},
			'.cm-gutters': {
				backgroundColor: 'var(--c-midnight)',
				color: '#475569',
				border: 'none'
			},
			'.cm-activeLine': { backgroundColor: 'rgba(148,163,184,0.06)' },
			'.cm-activeLineGutter': { backgroundColor: 'transparent' },
			'.cm-cursor': { borderLeftColor: '#5EEAD4' },
			'.cm-scroller': { maxHeight: '520px' },
			'&.cm-focused': { outline: 'none' }
		},
		{ dark: true }
	);

	// ⛔ `readonly` MUST live in a Compartment. `extensions()` is evaluated once, inside `onMount`;
	// everything it returns is frozen for the life of the component. The block editor is NOT
	// remounted when the author picks another version in the sidebar — `selectVersion()`
	// (routes/block-edit/+page.svelte:303) mutates state in place, so a published→draft switch used
	// to hand the author an unlocked page with a permanently locked code editor, and the reverse
	// switch left a published version writeable so edits to an immutable version were accepted on
	// screen and then silently dropped. A Compartment is CodeMirror's mechanism for exactly this:
	// the facets it holds are swapped by dispatching `reconfigure`, from the `$effect` below.
	//
	// ⚠️ NOTHING ELSE IN HERE IS A PROP. The theme, the highlight style, the language and the
	// keymap are module-level constants with no reactive input, so they cannot drift on a state
	// change the way `readonly` did; `value` has its own sync effect. `readonly` is this
	// component's only other input, and therefore its only other reconfiguration.
	const editableConf = new Compartment();

	function editableExt(ro: boolean): Extension {
		// Both, deliberately. `EditorView.editable` is what sets `contenteditable` (so the browser
		// refuses the keystroke at all), `EditorState.readOnly` is what the bound commands consult
		// (so Enter/Tab/paste refuse rather than half-apply). Setting only one leaves a gap.
		return [EditorView.editable.of(!ro), EditorState.readOnly.of(ro)];
	}

	function extensions(): Extension[] {
		return [
			lineNumbers(),
			history(),
			indentOnInput(),
			bracketMatching(),
			highlightActiveLine(),
			javascript({ typescript: true }),
			syntaxHighlighting(cpHighlight),
			cpTheme,
			keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
			editableConf.of(editableExt(readonly)),
			EditorView.updateListener.of((u) => {
				if (u.docChanged) value = u.state.doc.toString();
			})
		];
	}

	onMount(() => {
		view = new EditorView({
			state: EditorState.create({ doc: value, extensions: extensions() }),
			parent: host
		});
	});

	onDestroy(() => view?.destroy());

	// Scroll the editor to a 1-based line and place the cursor there — used by the lint
	// findings list so clicking a finding jumps to the offending line.
	export function scrollToLine(line: number) {
		if (!view) return;
		const total = view.state.doc.lines;
		const target = view.state.doc.line(Math.min(Math.max(1, line), total));
		view.dispatch({
			selection: { anchor: target.from },
			effects: EditorView.scrollIntoView(target.from, { y: 'center' })
		});
		view.focus();
	}

	// Keep the editor in sync when `value` is replaced externally (e.g. switching
	// versions). Guard against feeding our own edits back in.
	$effect(() => {
		const next = value;
		if (view && next !== view.state.doc.toString()) {
			view.dispatch({
				changes: { from: 0, to: view.state.doc.length, insert: next }
			});
		}
	});

	// Follow `readonly` for the life of the component, not just at creation. The initial state
	// already carries the right value (`extensions()` reads the prop), so this is a no-op on mount
	// and only matters for the in-place version switch described above.
	$effect(() => {
		const ro = readonly;
		view?.dispatch({ effects: editableConf.reconfigure(editableExt(ro)) });
	});
</script>

<div class="code-editor" bind:this={host}></div>

<style>
	.code-editor {
		border-radius: var(--r-lg);
		overflow: hidden;
		border: 1px solid var(--c-midnight-2);
	}
</style>
