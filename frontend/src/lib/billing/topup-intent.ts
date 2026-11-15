// src/lib/billing/topup-intent.ts — ONE idempotency key per top-up INTENT.
//
// ⛔ A key per CLICK buys the credit twice: a top-up whose response was lost (a timeout, a 502
// after billing already applied it, a reload, a closed tab) is retried by the reader, and a fresh
// key makes billing treat the retry as a second purchase — invoiced twice. The key therefore
// belongs to the INTENT ("buy $N for this workspace"): every retry of the same amount reuses it
// (billing replays the original, `replayed: true`), and it rotates only after a CONFIRMED success
// or when the amount changes.
//
// The pending key is kept in `sessionStorage` (per tenant + amount), so a reload or a reopened tab
// in the same browser session still reuses it. Every storage access is guarded: in a private
// window, with storage blocked, or under a quota error the intent falls back to memory — which
// still covers retries within the page.
export interface TopupIntent {
	/** The key for buying `amount` now — the pending one when this intent is being retried. */
	keyFor(amount: number): string;
	/** Billing confirmed the top-up of `amount`: the next purchase is a new intent. */
	confirmed(amount: number): void;
}

const PREFIX = 'cp.topup-intent';

function storage(): Storage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage;
	} catch {
		return null;
	}
}

export function createTopupIntent(
	tenantId: () => string | null,
	newKey: () => string = () => crypto.randomUUID()
): TopupIntent {
	const memory = new Map<string, string>();
	const slot = (amount: number) => `${PREFIX}:${tenantId() ?? 'unknown'}:${amount}`;
	return {
		keyFor(amount) {
			const k = slot(amount);
			let key: string | null = memory.get(k) ?? null;
			if (!key) {
				try {
					key = storage()?.getItem(k) ?? null;
				} catch {
					key = null;
				}
			}
			if (!key) {
				key = newKey();
				try {
					storage()?.setItem(k, key);
				} catch {
					/* memory still covers the retry */
				}
			}
			memory.set(k, key);
			return key;
		},
		confirmed(amount) {
			const k = slot(amount);
			memory.delete(k);
			try {
				storage()?.removeItem(k);
			} catch {
				/* nothing to clear */
			}
		}
	};
}
