// Where a proxied /api/* request is actually sent.
//
// The request target is client-controlled: `req.url` is whatever the client wrote on the request
// line. Node accepts three forms — origin-form (`/api/x`, the only one a browser sends), and, far
// less obviously, absolute-form (`http://other-host/api/x`) and protocol-relative (`//other-host`).
// Feeding any of those to `new URL(req.url, BACKEND)` picks the *path* out of the first and the
// *authority* out of the others, so a client could choose the host of a request this server makes
// on its behalf. That is what `js/request-forgery` was reporting on `server.js`.
//
// The fix is structural rather than a filter: the destination is built only from the configured
// backend, and the client's string contributes nothing but a normalised path. Every form that
// would have named a different host is refused outright.

/** A throwaway origin used only to parse the client's target without letting it name a host. */
const PLACEHOLDER_ORIGIN = 'http://backend.invalid';

/**
 * Request options for proxying `req` to `backendUrl`, or `null` when the target is not a plain
 * API path. Returning `null` is a refusal, not a fallback: there is no other host to try.
 *
 * @param {{ url?: string, method?: string, headers?: Record<string, unknown> }} req
 * @param {string} backendUrl
 * @returns {null | { protocol: string, hostname: string, port: string, method: string | undefined, path: string, headers: Record<string, unknown> }}
 */
export function proxyRequestOptions(req, backendUrl) {
	const target = req?.url;
	if (typeof target !== 'string') return null;

	let parsed;
	try {
		// A relative parse against a fixed placeholder: a target that tries to name its own host
		// resolves to that host's origin and is caught by the check below.
		parsed = new URL(target, PLACEHOLDER_ORIGIN);
	} catch {
		return null;
	}
	if (parsed.origin !== PLACEHOLDER_ORIGIN) return null;

	// Re-check *after* normalisation, so `/api/../..//host` cannot smuggle a path that a backend
	// might read as authority.
	const path = parsed.pathname + parsed.search;
	if (!parsed.pathname.startsWith('/api/') || path.startsWith('//')) return null;

	let backend;
	try {
		backend = new URL(backendUrl);
	} catch {
		return null;
	}

	return {
		protocol: backend.protocol,
		hostname: backend.hostname,
		port: backend.port,
		method: req.method,
		path,
		headers: { ...req.headers, host: backend.host }
	};
}
