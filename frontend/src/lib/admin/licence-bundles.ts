// licence-bundles — the create form's bundle-key chips (backend 0104, tenant-licence-bundles.ts).
// The licences service decides which bundle keys exist, so nothing here lists them: this only checks
// the SHAPE the backend accepts (lower-case kebab-case, unique, at most MAX_BUNDLES) so the operator
// hears about a typo before submitting.

/** Same rule as the backend's `BUNDLE_KEY`: `n8n-nodes`, `book-fulfillment`, `w2v`. */
export const BUNDLE_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const BUNDLE_KEY_MAX_LEN = 64;
export const MAX_BUNDLES = 20;

export interface BundleAddResult {
	/** The chip list after adding every valid, new key from `raw`. */
	keys: string[];
	/** The first token that is not a bundle key, if any (nothing from `raw` is added then). */
	invalid: string | null;
	/** Adding would exceed MAX_BUNDLES (nothing from `raw` is added then). */
	tooMany: boolean;
}

/** Add the keys typed in `raw` (comma / whitespace separated, case-folded) to `current`. All or
 *  nothing: one bad token leaves the list unchanged, so the operator fixes it in place. */
export function addBundleKeys(current: readonly string[], raw: string): BundleAddResult {
	const tokens = raw
		.split(/[\s,]+/)
		.map((t) => t.trim().toLowerCase())
		.filter(Boolean);
	const invalid = tokens.find((t) => t.length > BUNDLE_KEY_MAX_LEN || !BUNDLE_KEY_RE.test(t)) ?? null;
	if (invalid) return { keys: [...current], invalid, tooMany: false };
	const next = [...current];
	for (const t of tokens) if (!next.includes(t)) next.push(t);
	if (next.length > MAX_BUNDLES) return { keys: [...current], invalid: null, tooMany: true };
	return { keys: next, invalid: null, tooMany: false };
}

/** The bundles that did not land, for the "created, but …" banner. */
export function failedBundleKeys(results: readonly { bundle: string; status: string }[] | undefined): string[] {
	return (results ?? []).filter((r) => r.status === 'failed').map((r) => r.bundle);
}
