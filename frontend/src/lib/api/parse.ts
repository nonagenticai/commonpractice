// src/lib/api/parse.ts — response-body helpers shared by every typed api client.
//
// Deliberately dependency-free (auth-fetch pulls in the browser-only keycloak chain, which is why
// tests mock that module wholesale). Keeping these here means the clients can use them without
// dragging the browser chain into a node-env test.

/**
 * Parse a response body that is EXPECTED to be JSON but may not be.
 *
 * Every client used to do `const body = text ? JSON.parse(text) : null` BEFORE checking `res.ok`,
 * so any non-JSON error body — a Cloudflare/ingress HTML interstitial, the frontend proxy's
 * plain-text `Bad Gateway` — threw a raw `SyntaxError: Unexpected token '<'` that REPLACED the real
 * status and message. That is why a 502 on the onboarding approve surfaced as an unreadable parse
 * error with the actual cause thrown away.
 *
 * Returns null when the body is empty or not JSON; the caller then falls back to the HTTP status
 * plus a snippet of the raw text, so the failure stays diagnosable.
 */
export function parseBody(text: string): any | null {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Is this body genuinely unparseable, as opposed to the valid JSON literal `null`?
 *
 * `parseBody` returns null for both, so a 200 whose body is literally `null` would otherwise be
 * reported as `invalid_json`. Callers use this to tell the two apart before erroring.
 */
export function isUnparseable(text: string): boolean {
	return text.trim().length > 0 && text.trim() !== 'null' && parseBody(text) === null;
}

/**
 * The `details` bag off a parsed error body, or `undefined` when the wire did not carry a usable one.
 *
 * ⛔ ONE HELPER, TWENTY CALL SITES, DELIBERATELY. Every typed client owns a near-identical private
 * `unwrap`, and this is the field they all have to lift the same way — see the ⛔ block on
 * `ApiError` (./blocks) for what it cost when they lifted none of it. Inlining the guard twenty
 * times is how nineteen of them end up correct and one of them forwards a string.
 *
 * ⚠️ THE GUARD IS THE POINT, NOT THE READ. `error-message.ts`'s `detailStr`/`detailNum` index the
 * bag by field name, so a `details` that is a STRING would answer `details['reason']` with
 * `undefined` (harmless) but `details['0']` with a character, and an ARRAY answers `length` and
 * every numeric key. Neither is a details bag; both are `undefined` here. `detailsOf` on the far
 * side re-checks `typeof === 'object'` for the errors this helper never touched (hand-built ones,
 * `RunApiError`), so the two guards are belt-and-braces rather than a duplicate.
 */
export function detailsFrom(body: unknown): Record<string, unknown> | undefined {
	if (typeof body !== 'object' || body === null) return undefined;
	const d = (body as { details?: unknown }).details;
	if (typeof d !== 'object' || d === null || Array.isArray(d)) return undefined;
	return d as Record<string, unknown>;
}

/** A readable message for a non-JSON error body: the status line + a short raw snippet. */
export function nonJsonErrorMessage(res: Response, text: string): string {
	const snippet = text.trim().slice(0, 120).replace(/\s+/g, ' ');
	const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`;
	return snippet ? `${status} (non-JSON response: ${snippet})` : status;
}
