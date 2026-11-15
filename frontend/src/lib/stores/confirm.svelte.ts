// src/lib/stores/confirm.svelte.ts — promise-based confirmation dialog.
// Replaces native window.confirm() with an accessible, styled modal: a single
// <ConfirmDialog/> is mounted at the app root and renders the active request.
// Usage: `if (!(await confirmDialog({ message: m.x_confirm() }))) return;`
export interface ConfirmRequest {
	/** Optional heading; defaults to a generic "Please confirm". */
	title?: string;
	/** The question shown to the user (already localized at the call site). */
	message: string;
	/** Label for the confirm button; defaults to a generic "Confirm". */
	confirmLabel?: string;
	/** Label for the cancel button; defaults to a generic "Cancel". */
	cancelLabel?: string;
	/** Render the confirm button as destructive (default true — most uses are deletes). */
	danger?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
	resolve: (ok: boolean) => void;
}

let current = $state<PendingConfirm | null>(null);

export const confirmState = {
	get current(): PendingConfirm | null {
		return current;
	}
};

/** Open the confirm dialog and resolve true (confirmed) or false (cancelled/dismissed). */
export function confirmDialog(req: ConfirmRequest): Promise<boolean> {
	// Defensive: if one is somehow already open, cancel it before replacing.
	if (current) current.resolve(false);
	return new Promise<boolean>((resolve) => {
		current = { danger: true, ...req, resolve };
	});
}

/** Resolve the active request (used by the dialog component only). */
export function resolveConfirm(ok: boolean): void {
	if (!current) return;
	const c = current;
	current = null;
	c.resolve(ok);
}
