// src/lib/layout/typing-target.ts — is a key event aimed at something the reader is typing into?
// Global shortcuts (ShellLayout's ⌘\) must leave those keystrokes to the text.
export function isTypingTarget(target: EventTarget | null): boolean {
	if (!target || typeof (target as Element).closest !== 'function') return false;
	const el = target as HTMLElement;
	if (el.isContentEditable) return true;
	// `closest`, not only the element itself: a key raised inside a code editor's inner nodes, or
	// inside an element whose contenteditable ancestor jsdom/browsers do not reflect onto the child.
	return !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], .cm-editor');
}
