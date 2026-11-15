import { describe, expect, it } from 'vitest';
import { proxyRequestOptions } from './proxy-target.js';

const BACKEND = 'http://localhost:8790';

/**
 * The options for a request that must be proxied; throws when it was refused.
 * @param {{ url?: string, method?: string, headers?: Record<string, unknown> }} req
 * @param {string} [backend]
 */
function options(req, backend = BACKEND) {
	const opts = proxyRequestOptions(req, backend);
	if (!opts) throw new Error('expected the request to be proxied');
	return opts;
}

describe('proxyRequestOptions', () => {
	it('proxies a normal API request to the configured backend', () => {
		const opts = options({ url: '/api/cycles?limit=5', method: 'GET' });
		expect(opts).toMatchObject({
			protocol: 'http:',
			hostname: 'localhost',
			port: '8790',
			method: 'GET',
			path: '/api/cycles?limit=5',
			headers: { host: 'localhost:8790' }
		});
	});

	it('drops the client-supplied host header rather than forwarding it', () => {
		const opts = options({
			url: '/api/x',
			method: 'GET',
			headers: { host: 'evil.example', cookie: 'a=1' }
		});
		expect(opts.headers.host).toBe('localhost:8790');
		expect(opts.headers.cookie).toBe('a=1');
	});

	// The three forms a client can put on the request line that name their own authority. Each
	// must be refused, not silently sent somewhere.
	it.each([
		['protocol-relative', '//evil.example/api/x'],
		['absolute-form', 'http://evil.example/api/x'],
		['absolute-form over https', 'https://evil.example/api/x']
	])('refuses %s', (_label, url) => {
		expect(proxyRequestOptions({ url, method: 'GET' }, BACKEND)).toBeNull();
	});

	it('refuses a traversal that normalises to a protocol-relative path', () => {
		expect(proxyRequestOptions({ url: '/api/../..//evil.example', method: 'GET' }, BACKEND)).toBeNull();
	});

	it('refuses anything that is not an /api/ path', () => {
		expect(proxyRequestOptions({ url: '/', method: 'GET' }, BACKEND)).toBeNull();
		expect(proxyRequestOptions({ url: '/_app/immutable/x.js', method: 'GET' }, BACKEND)).toBeNull();
	});

	it('refuses a missing or non-string target', () => {
		expect(proxyRequestOptions({}, BACKEND)).toBeNull();
		// @ts-expect-error - a request object that did not come from node's parser
		expect(proxyRequestOptions({ url: null }, BACKEND)).toBeNull();
	});

	it('follows the configured backend, including its port', () => {
		const opts = options({ url: '/api/x', method: 'POST' }, 'http://backend.internal:9000');
		expect(opts.hostname).toBe('backend.internal');
		expect(opts.port).toBe('9000');
		expect(opts.headers.host).toBe('backend.internal:9000');
	});
});
