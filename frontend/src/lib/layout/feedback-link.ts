// src/lib/layout/feedback-link.ts — the shell's "Feedback" link target.
//
// The address comes from the backend (SUPPORT_EMAIL, carried on /api/me as `supportEmail`). Unset,
// empty or not a plain address → null, and the sidebar renders NO link: an address is never guessed.
// Re-checked here because the value is concatenated into an href.
const PLAIN_ADDRESS = /^[^\s@<>()"',;:\\?#&%/]+@[^\s@<>()"',;:\\?#&%/]+\.[^\s@<>()"',;:\\?#&%/]+$/;

export function feedbackMailto(address: string | null | undefined): string | null {
	const v = (address ?? '').trim();
	return v && PLAIN_ADDRESS.test(v) ? `mailto:${v}` : null;
}
