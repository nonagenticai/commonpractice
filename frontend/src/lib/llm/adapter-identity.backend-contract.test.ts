// src/lib/llm/adapter-identity.backend-contract.test.ts — the browser and the server must agree
// about WHO holds a tenant's provider key.
//
// The backend decides, in `routes/llm-settings.ts`, whether a save carries the stored ciphertext
// forward or disowns it, by comparing `provider-catalog.ts adapterIdentityFor(provider, base_url)`
// before and after. `$lib/llm/adapter-identity.ts` recomputes that answer in the browser so the
// panel stops claiming "Key set ✓" the moment the form points at a different vendor.
//
// ⛔ TWO COPIES WITH NO SHARED PACKAGE. backend/ and frontend/ are separate Bun projects — no
// workspaces, no codegen — so a default base url moved on one side is invisible on the other, and
// the visible symptom would be a screen that quietly under- or over-claims a key while the API
// does the opposite. Exactly as `api/error-message.backend-contract.test.ts` and
// `types/audit-categories.backend-contract.test.ts` do, this reads BACKEND SOURCE TEXT with plain
// `fs` (no backend runtime import: this is a frontend vitest project) and diffs the constants and
// the formula.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ANTHROPIC_DEFAULT_BASE, OPENAI_DEFAULT_BASE, adapterIdentityFor } from './adapter-identity';

const backend = (rel: string) =>
	readFileSync(fileURLToPath(new URL(`../../../../backend/src/${rel}`, import.meta.url)), 'utf8');

/** The single-quoted string assigned to an exported const, e.g. `export const X = 'y';`. */
function exportedConst(src: string, name: string): string {
	const m = new RegExp(`export const ${name} = '([^']+)'`).exec(src);
	expect(m, `backend no longer exports \`${name}\` — the mirror below has nothing to track`).not.toBeNull();
	return m![1]!;
}

describe('the adapter default bases the two sides fill in', () => {
	it('ANTHROPIC_DEFAULT_BASE matches backend/src/ai/llm/adapters/anthropic.ts', () => {
		expect(ANTHROPIC_DEFAULT_BASE).toBe(exportedConst(backend('ai/llm/adapters/anthropic.ts'), 'ANTHROPIC_DEFAULT_BASE'));
	});

	it('OPENAI_DEFAULT_BASE matches backend/src/ai/llm/adapters/openai.ts', () => {
		expect(OPENAI_DEFAULT_BASE).toBe(exportedConst(backend('ai/llm/adapters/openai.ts'), 'OPENAI_DEFAULT_BASE'));
	});

	it('the backend still derives its identity from those constants, not from a third value', () => {
		// A cheap structural check: the day someone rewrites `adapterIdentityFor` to key on the
		// preset again, or on the full URL instead of the host, the assertions above keep passing
		// while the two sides diverge in behaviour.
		//
		// ⛔ AND IT IS ONLY EVER A TRIPWIRE, NEVER THE PROOF. A grep matches TEXT: dropping the
		// `${family}|` prefix — which carries an Anthropic key onto the OpenAI adapter at one host,
		// sent as `Authorization: Bearer` instead of `x-api-key` — left every assertion in this file
		// and all 21 backend route cases green, because the substring it looks for was still there.
		// The behavioural cases below (and backend/tests/adapter-identity.test.ts) are what pin the
		// formula; these lines only catch a rewrite that changes its SHAPE.
		const src = backend('ai/llm/provider-catalog.ts');
		expect(src).toContain('export function adapterIdentityFor(');
		const start = src.indexOf('export function adapterIdentityFor(');
		// ⚠️ BOUNDED TO THE FUNCTION, and that is not tidiness. Slicing to end-of-file made the
		// `${family}|` check below pass while the function had already lost its prefix — the NEXT
		// function's identical substring answered for it. A grep over the wrong span is a green
		// light for the exact mutation it was added to stop.
		const end = src.indexOf('\n}\n', start);
		expect(end).toBeGreaterThan(start);
		const body = src.slice(start, end);
		expect(body).toContain('ANTHROPIC_DEFAULT_BASE');
		expect(body).toContain('OPENAI_DEFAULT_BASE');
		expect(body).toContain('url.host.toLowerCase()');
		// The scheme is part of the identity on both sides, or an https→http downgrade keeps the key
		// on one side and disowns it on the other.
		expect(body).toContain('url.protocol');
		// BOTH returns (the parsed one and the unparseable-url fallback) carry the family, or an
		// Anthropic key crosses onto the OpenAI adapter at one host and is sent as the wrong header.
		expect(body.split('${family}|').length - 1).toBe(2);
	});
});

describe('the identity itself', () => {
	it('a null base url resolves to the adapter’s own default, so it is not a vendor change', () => {
		expect(adapterIdentityFor('anthropic', null)).toBe(adapterIdentityFor('anthropic', ANTHROPIC_DEFAULT_BASE));
		expect(adapterIdentityFor('openai', null)).toBe(adapterIdentityFor('openai_compatible', OPENAI_DEFAULT_BASE));
	});

	it('an empty / whitespace base url resolves to the adapter default, not to its own identity', () => {
		// ⛔ `baseUrl?.trim() || DEFAULT` → `baseUrl ?? DEFAULT` survives on BOTH sides otherwise.
		// `''` is what a cleared form field round-trips as; giving it a distinct identity makes the
		// panel drop "Key set ✓" for a save that goes to exactly the host it always did.
		expect(adapterIdentityFor('openai', '')).toBe(adapterIdentityFor('openai', OPENAI_DEFAULT_BASE));
		expect(adapterIdentityFor('openai', '   ')).toBe(adapterIdentityFor('openai', OPENAI_DEFAULT_BASE));
		expect(adapterIdentityFor('anthropic', '')).toBe(adapterIdentityFor('anthropic', ANTHROPIC_DEFAULT_BASE));
		expect(adapterIdentityFor('anthropic', ' \t ')).toBe(adapterIdentityFor('anthropic', ANTHROPIC_DEFAULT_BASE));
	});

	it('trailing slashes, casing and path moves are the SAME vendor', () => {
		const openai = adapterIdentityFor('openai_compatible', 'https://api.openai.com/v1');
		expect(adapterIdentityFor('openai_compatible', 'https://API.OpenAI.com/v1/')).toBe(openai);
		expect(adapterIdentityFor('openai_compatible', 'https://api.openai.com/v2')).toBe(openai);
	});

	it('the SCHEME is a vendor change — https→http would put the key on the wire in cleartext', () => {
		// ⛔ Measured on the server before this: `https://api.openai.com/v1` → `http://…` returned
		// 200 and KEPT the key. The panel has to say so too, or it claims a key the server disowned.
		expect(adapterIdentityFor('openai_compatible', 'http://api.openai.com/v1')).not.toBe(
			adapterIdentityFor('openai_compatible', 'https://api.openai.com/v1')
		);
		// …and NOT by banning http: this deployment's own router is a plaintext in-cluster hop, so
		// an http base must still be a stable identity that round-trips to itself.
		const local = 'http://inference-router.inference-router.svc.cluster.local:8150/api';
		expect(adapterIdentityFor('openai_compatible', `${local}/`)).toBe(
			adapterIdentityFor('openai_compatible', local)
		);
	});

	it('`openai` and `openai_compatible` at one host are one vendor — one adapter serves both', () => {
		expect(adapterIdentityFor('openai', 'https://api.x.ai/v1')).toBe(
			adapterIdentityFor('openai_compatible', 'https://api.x.ai/v1')
		);
	});

	it('a different HOST is a different vendor, including two `custom` endpoints', () => {
		// ⛔ The case a preset-key comparison cannot see: both of these resolve to the `custom`
		// preset, and they are two unrelated companies.
		expect(adapterIdentityFor('openai_compatible', 'https://vendor-a.example/v1')).not.toBe(
			adapterIdentityFor('openai_compatible', 'https://vendor-b.example/v1')
		);
		// And the family alone separates two adapters pointed at one host — different auth header.
		expect(adapterIdentityFor('anthropic', 'https://proxy.example/v1')).not.toBe(
			adapterIdentityFor('openai_compatible', 'https://proxy.example/v1')
		);
	});

	it('an unparseable half-typed url does not collapse onto one identity', () => {
		expect(adapterIdentityFor('openai_compatible', 'vendor-a')).not.toBe(
			adapterIdentityFor('openai_compatible', 'vendor-b')
		);
	});
});
