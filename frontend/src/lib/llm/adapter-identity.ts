// src/lib/llm/adapter-identity.ts — WHO would receive this tenant's provider key.
//
// The browser mirror of `backend/src/ai/llm/provider-catalog.ts adapterIdentityFor`, which is the
// authority: the PUT route disowns a stored key whenever this identity changes, so the screen has
// to compute the same answer or it will keep claiming "Key set ✓" for a vendor the server has
// already refused to lend it to.
//
// ⛔ NOT `preset`, and the difference is the point. The preset key answers "which dropdown entry is
// this", and it collapses every unrecognised base_url onto the single `custom` entry — so
// `https://vendor-a.example/v1` and `https://vendor-b.example/v1`, two unrelated companies, are the
// same preset. The identity is built from what the request would look like on the wire instead: the
// adapter FAMILY (which decides the auth header — `x-api-key` vs `Authorization: Bearer`; `openai`
// and `openai_compatible` are one family because one adapter serves both), the SCHEME (which
// decides whether the key crosses the network in cleartext — editing only the `s` of `https` is a
// vendor change, so the panel must stop showing "Key set ✓"), plus the HOST, with each adapter's
// own default filled in so a null base url compares equal to the URL it resolves to.
//
// Extracted to $lib rather than living in the page so `adapter-identity.backend-contract.test.ts`
// can diff the two default bases against the backend source — the frontend and backend are separate
// Bun projects with no shared package, so drift between them is otherwise invisible.
import type { LlmProvider } from '$lib/api/llm-settings';

/** Mirrors `ANTHROPIC_DEFAULT_BASE` in backend/src/ai/llm/adapters/anthropic.ts. */
export const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';
/** Mirrors `OPENAI_DEFAULT_BASE` in backend/src/ai/llm/adapters/openai.ts. */
export const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';

/** The vendor a key saved against `(adapterKind, baseUrl)` belongs to. Opaque — compare, don't parse. */
export function adapterIdentityFor(adapterKind: LlmProvider, baseUrl: string | null): string {
	const family = adapterKind === 'anthropic' ? 'anthropic' : 'openai';
	const raw = baseUrl?.trim() || (family === 'anthropic' ? ANTHROPIC_DEFAULT_BASE : OPENAI_DEFAULT_BASE);
	try {
		const url = new URL(raw);
		return `${family}|${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
	} catch {
		// A half-typed custom URL is not yet a host. Compare it literally rather than letting every
		// unparseable value collapse onto one identity (which would read as "same vendor").
		return `${family}|${raw.replace(/\/+$/, '').toLowerCase()}`;
	}
}
