// Production server: wraps SvelteKit adapter-node and proxies /api/* (HTTP+WS)
// to the Common Practice backend. Mirrors fr/frontend/server.js.
import http from 'node:http';
import { handler } from './build/handler.js';

const PORT = Number(process.env.PORT || 3000);
const BACKEND_URL = process.env.CP_BACKEND_URL || 'http://localhost:8790';
// Parsed once and used ONLY for its hostname/port: the proxy takes the path and query from the
// request, never a URL built out of it. `new URL(req.url, BACKEND)` is the SSRF shape CodeQL
// flags (js/request-forgery) — the base pins the host today, but only by implication. Splitting
// "host from configuration" from "path from the request" makes that invariant structural.
const BACKEND = new URL(BACKEND_URL);
// Ceiling on a proxied /api/* call. Without one, a hung backend request held this socket open
// indefinitely and handed the failure decision to whatever proxy sits in front (ingress /
// Cloudflare), which answers with an HTML error page the SPA cannot parse. 60s is above every
// legitimate CP request (the longest is an SSE stream, which is excluded below).
const PROXY_TIMEOUT_MS = Number(process.env.CP_PROXY_TIMEOUT_MS || 60_000);

/** Every /api/* client parses the body as JSON, so proxy-level errors must be JSON too. */
function proxyError(res, status, code, message) {
	if (res.headersSent) {
		res.end();
		return;
	}
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify({ error: code, message }));
}

const server = http.createServer((req, res) => {
	if (req.url?.startsWith('/api/')) {
		const proxyReq = http.request(
			{
				hostname: BACKEND.hostname,
				port: BACKEND.port || 80,
				path: req.url,
				method: req.method,
				headers: { ...req.headers, host: BACKEND.host },
			},
			(proxyRes) => {
				res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
				proxyRes.pipe(res);
			}
		);
		// SSE streams are long-lived by design — never time those out.
		if (!req.headers.accept?.includes('text/event-stream')) {
			proxyReq.setTimeout(PROXY_TIMEOUT_MS, () => {
				proxyReq.destroy(new Error('proxy timeout'));
			});
		}
		proxyReq.on('error', (err) => {
			const timedOut = err?.message === 'proxy timeout';
			proxyError(
				res,
				timedOut ? 504 : 502,
				timedOut ? 'backend_timeout' : 'backend_unreachable',
				timedOut
					? `Backend did not respond within ${PROXY_TIMEOUT_MS}ms`
					: `Cannot reach the backend at ${BACKEND_URL}: ${err?.message ?? 'unknown error'}`
			);
		});
		req.pipe(proxyReq);
		return;
	}
	// Force the browser to revalidate the SvelteKit app shell / SSR pages on every
	// load. The hashed assets under /_app/immutable/* carry their own long-lived
	// `immutable` cache header (set by the adapter) and are content-addressed, so
	// they stay cached. But the entry HTML references those hashes — if the browser
	// heuristically caches the shell (the adapter sets NO cache-control on it, and
	// neither does Cloudflare: it returns DYNAMIC for text/html), users get pinned
	// to an old chunk graph and never pick up a new deploy. `no-cache` = may store,
	// MUST revalidate — so a freshly deployed shell is fetched immediately.
	if (!req.url?.startsWith('/_app/immutable/')) {
		res.setHeader('Cache-Control', 'no-cache');
	}
	handler(req, res);
});

server.listen(PORT, () => {
	console.log(`commonpractice-frontend on :${PORT} — proxying /api/* to ${BACKEND_URL}`);
});
