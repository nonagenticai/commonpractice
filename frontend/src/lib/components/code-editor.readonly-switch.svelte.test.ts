// @vitest-environment jsdom
//
// src/lib/components/code-editor.readonly-switch.svelte.test.ts — the block Implementation editor
// must follow the `readonly` prop AFTER it is mounted, not only at the moment it was created.
//
// ⛔ THE DEFECT, MEASURED IN THE LIVE APP. `/block-edit?slug=…` → Implementatie, with a PUBLISHED
// version selected, then a click on the **draft** in the version sidebar. `selectVersion()`
// (routes/block-edit/+page.svelte:303) mutates state in place: the draft's source loads into the
// textarea, "Draft opslaan" enables, `editable` flips to true, every other field on the tab
// unlocks — and CodeMirror stays locked. The author cannot type one character into the draft they
// were just handed. The reverse direction is worse: coming from the draft to a published version
// leaves the editor WRITEABLE, so edits to an immutable version are accepted on screen and then
// silently discarded.
//
// Cause: `extensions()` baked `EditorView.editable.of(!readonly)` + `EditorState.readOnly.of(...)`
// into the `EditorState.create` call inside `onMount`, which runs exactly once. There was no
// `Compartment` and no `reconfigure`; the only `$effect` in the component synced `value`.
//
// ⚠️ WHY ONLY THE SIDEBAR CLICK REACHES IT, VERIFIED IN THE PAGE. Every other route into a draft
// goes through `loadDetail()` (+page.svelte:348), which sets `loading = true`, and the whole editor
// column sits behind `{:else if slug && (loading || !(detail && selected))}` (+page.svelte:705) —
// so the component is destroyed and re-created with the new `readonly`, and a fresh mount happens
// to be correct. `newDraft()` awaits `loadDetail` for exactly that reason. `selectVersion()` is the
// one path with no remount, which is why this file drives the props of a LIVE component instead of
// asserting about two separate mounts (which would pass with the bug fully present).
//
// It is a `.svelte.test.ts` (note the infix) so vite-plugin-svelte compiles it as a rune module:
// `mount(..., { props })` only observes later mutations when `props` is a `$state` proxy.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { EditorView } from '@codemirror/view';
import { insertNewlineAndIndent } from '@codemirror/commands';
import CodeEditor from './CodeEditor.svelte';

const PUBLISHED_SRC = 'export function run() {\n  return 1;\n}';

let host: HTMLElement;
let app: Record<string, unknown> | undefined;

beforeEach(() => {
	host = document.createElement('div');
	document.body.appendChild(host);
});
afterEach(() => {
	if (app) unmount(app);
	app = undefined;
	host.remove();
});

/** Mounts with a REACTIVE props object and hands it back, so a test can flip `readonly` live. */
function render(readonly: boolean) {
	const props = $state({ value: PUBLISHED_SRC, readonly });
	app = mount(CodeEditor, { target: host, props });
	flushSync();
	return props;
}

/** The live `EditorView` behind the rendered DOM — the only place the truth about editability is. */
function editorView(): EditorView {
	const dom = host.querySelector('.cm-editor') as HTMLElement | null;
	expect(dom, 'CodeMirror did not mount — every assertion below would be vacuous').not.toBeNull();
	const view = EditorView.findFromDOM(dom!);
	expect(view, 'no EditorView bound to the mounted DOM').not.toBeNull();
	return view!;
}

/**
 * What a keystroke actually does. `Enter` is bound to `insertNewlineAndIndent` through the
 * component's own `keymap.of([...defaultKeymap, ...])`, and that command returns `false` without
 * dispatching when `state.readOnly` — so this is the real user-visible outcome of pressing a key,
 * not a re-reading of the flag under test. (jsdom has no working `contenteditable`, so a synthetic
 * `keydown` on `.cm-content` would prove nothing; driving the bound command does.)
 */
function pressEnter(view: EditorView): boolean {
	view.dispatch({ selection: { anchor: view.state.doc.length } });
	return insertNewlineAndIndent(view);
}

describe('the code editor follows `readonly` across a version switch', () => {
	it('a published version is locked: contenteditable=false and Enter does nothing', () => {
		const props = render(true);
		const view = editorView();
		expect(host.querySelector('.cm-content')!.getAttribute('contenteditable')).toBe('false');
		expect(view.state.readOnly).toBe(true);
		expect(view.state.facet(EditorView.editable)).toBe(false);
		expect(pressEnter(view)).toBe(false);
		expect(view.state.doc.toString()).toBe(PUBLISHED_SRC);
		expect(props.value).toBe(PUBLISHED_SRC);
	});

	it('⛔ clicking the DRAFT in the sidebar makes the editor editable', () => {
		const props = render(true);
		const view = editorView();

		// `selectVersion(draft)`: same component instance, new source, `editable` now true.
		props.value = 'export function run() {\n  return 2;\n}';
		props.readonly = false;
		flushSync();

		expect(host.querySelector('.cm-content')!.getAttribute('contenteditable')).toBe('true');
		expect(view.state.facet(EditorView.editable)).toBe(true);
		expect(view.state.readOnly).toBe(false);
		// And a keystroke reaches the document AND the bound `value`, which is what the author's
		// "Draft opslaan" will send.
		expect(pressEnter(view)).toBe(true);
		expect(view.state.doc.lines).toBe(4);
		expect(props.value).toBe(view.state.doc.toString());
	});

	it('⛔ going back to a PUBLISHED version locks the editor again', () => {
		const props = render(false);
		const view = editorView();
		expect(view.state.facet(EditorView.editable)).toBe(true);

		props.value = PUBLISHED_SRC;
		props.readonly = true;
		flushSync();

		expect(host.querySelector('.cm-content')!.getAttribute('contenteditable')).toBe('false');
		expect(view.state.facet(EditorView.editable)).toBe(false);
		expect(view.state.readOnly).toBe(true);
		// No silently-discarded edit: the keystroke is refused rather than accepted on screen.
		expect(pressEnter(view)).toBe(false);
		expect(view.state.doc.toString()).toBe(PUBLISHED_SRC);
		expect(props.value).toBe(PUBLISHED_SRC);
	});
});
