// Pure predicate for the global ⌘K search "Enter jumps to the top hit" shortcut, extracted so it
// can be unit-tested without mounting the component (Topbar.svelte's onKeydown is a closure).
//
// A7 regression: when the dropdown is closed/empty, Enter should only commit the top hit if the
// search input is actually focused. Otherwise a stray Enter originating elsewhere — notably
// confirming the locale <select> right after the search blurred — would navigate to the top result.
export function shouldCommitTopHit(key: string, inputFocused: boolean, hitCount: number): boolean {
	return key === 'Enter' && inputFocused && hitCount > 0;
}
